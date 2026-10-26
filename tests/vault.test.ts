import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialVault, credentialEndpoint, type SecretEncryption } from '../src/main/vault';

// OS-backed provider is injected by Electron Main. The test provider exercises the same persisted envelope using AES-GCM.
function encryptionProvider(): SecretEncryption {
  const key = randomBytes(32);
  return {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    async decryptStringAsync(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0,12)); decipher.setAuthTag(value.subarray(12,28)); return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') }; },
  };
}

test('credential and canonical endpoint persist together; an interrupted configuration change cannot send a key to the old endpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-agent-vault-')); const encryption = encryptionProvider();
  try {
    const vault = new CredentialVault(dir, encryption); await vault.init();
    const a = 'https://a.example/v1'; const b = 'https://b.example/v1';
    await vault.set({ endpoint: credentialEndpoint(a), apiKey: 'key-a-test' });
    assert.equal(vault.get(`${a}/chat/completions`), 'key-a-test');
    assert.equal(vault.get(b), null);
    await vault.set({ endpoint: credentialEndpoint(b), apiKey: 'key-b-test' });
    const restored = new CredentialVault(dir, encryption); await restored.init();
    assert.equal(restored.get(a), null); assert.equal(restored.get(b), 'key-b-test');
    const bytes = await readFile(join(dir, 'model-key.bin')); assert.ok(!bytes.includes(Buffer.from('key-b-test'))); assert.ok(!bytes.includes(Buffer.from('b.example')));
    await restored.set(null); assert.equal(restored.get(b), null); await assert.rejects(readFile(join(dir, 'model-key.bin')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unavailable system encryption uses session memory without a plaintext fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-agent-session-'));
  try {
    const provider = { ...encryptionProvider(), async isAsyncEncryptionAvailable() { return false; } };
    const vault = new CredentialVault(dir, provider); await vault.init();
    await vault.set({ endpoint: credentialEndpoint('http://localhost:1234/v1'), apiKey: 'session-key' });
    assert.equal(vault.storage, 'session-only'); assert.equal(vault.get('http://localhost:1234/v1/'), 'session-key');
    await assert.rejects(readFile(join(dir, 'model-key.bin')), { code: 'ENOENT' });
    const restored = new CredentialVault(dir, provider); await restored.init(); assert.equal(restored.get('http://localhost:1234/v1'), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('retrieval keys are isolated by vault, provider and collection, and survive encrypted reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-agent-retrieval-keys-')); const encryption = encryptionProvider();
  try {
    const knowledge = new CredentialVault(join(dir, 'knowledge'), encryption, value => value);
    const web = new CredentialVault(join(dir, 'web'), encryption, value => value);
    await knowledge.init(); await web.init();
    await knowledge.set({ endpoint: 'dify:https://kb.example/v1|collection-a', apiKey: 'knowledge-key-test' });
    await web.set({ endpoint: 'brave:https://search.example/', apiKey: 'web-key-test' });
    assert.equal(knowledge.get('dify:https://kb.example/v1|collection-a'), 'knowledge-key-test');
    assert.equal(knowledge.get('dify:https://kb.example/v1|collection-b'), null);
    assert.equal(knowledge.get('standard:https://kb.example/v1|collection-a'), null);
    assert.equal(web.get('dify:https://kb.example/v1|collection-a'), null);
    const restored = new CredentialVault(join(dir, 'knowledge'), encryption, value => value); await restored.init();
    assert.equal(restored.get('dify:https://kb.example/v1|collection-a'), 'knowledge-key-test');
    const disk = await readFile(join(dir, 'knowledge/model-key.bin'));
    assert.ok(!disk.includes(Buffer.from('knowledge-key-test')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fresh startup and deferred encrypted startup never touch keychain before a credential action',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'law-vault-lazy-'));const encryption=encryptionProvider();let calls=0;
 const provider={...encryption,async isAsyncEncryptionAvailable(){calls++;return true;}};
 try{
  const fresh=new CredentialVault(dir,provider);await fresh.init();assert.equal(calls,0);
  await fresh.set({endpoint:credentialEndpoint('https://test.example/v1'),apiKey:'synthetic-saved-key'});assert.equal(calls,1);
  const deferred=new CredentialVault(dir,provider);await deferred.init({deferUnlock:true});assert.equal(calls,1);assert.equal(deferred.snapshot(),null);
  await Promise.all([deferred.unlock(),deferred.unlock()]);assert.equal(calls,2);assert.equal(deferred.get('https://test.example/v1'),'synthetic-saved-key');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('hung availability/decryption settles to session memory and never erases existing ciphertext',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'law-vault-timeout-'));const encryption=encryptionProvider();const binding=credentialEndpoint('https://test.example/v1');
 try{
  const original=new CredentialVault(dir,encryption);await original.init();await original.set({endpoint:binding,apiKey:'old-saved-key'});const bytes=await readFile(join(dir,'model-key.bin'));
  const unavailable=new CredentialVault(dir,{...encryption,isAsyncEncryptionAvailable:()=>new Promise(()=>{})},credentialEndpoint,10);await unavailable.init();assert.equal(unavailable.storage,'session-only');await unavailable.set({endpoint:binding,apiKey:'new-session-key'});assert.equal(unavailable.get(binding),'new-session-key');assert.deepEqual(await readFile(join(dir,'model-key.bin')),bytes);
  const locked=new CredentialVault(dir,{...encryption,decryptStringAsync:()=>new Promise(()=>{})},credentialEndpoint,10);await locked.init();assert.equal(locked.storage,'session-only');assert.deepEqual(await readFile(join(dir,'model-key.bin')),bytes);
  const recovered=new CredentialVault(dir,encryption);await recovered.init();assert.equal(recovered.get(binding),'old-saved-key');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('hung encryption only uses session memory, creates no plaintext and ignores late completion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'law-vault-encrypt-timeout-'));const encryption=encryptionProvider();let resolve!: (value:Buffer)=>void;
 try{
  const vault=new CredentialVault(dir,{...encryption,encryptStringAsync:()=>new Promise(r=>{resolve=r;})},credentialEndpoint,10);await vault.init();await vault.set({endpoint:credentialEndpoint('https://test.example/v1'),apiKey:'session-secret-only'});
  assert.equal(vault.storage,'session-only');assert.equal(vault.get('https://test.example/v1'),'session-secret-only');await assert.rejects(readFile(join(dir,'model-key.bin')),{code:'ENOENT'});
  resolve(Buffer.from('late-encrypted-value'));await new Promise(r=>setTimeout(r,15));await assert.rejects(readFile(join(dir,'model-key.bin')),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('credential rollback restores encrypted bytes without needing an available keychain',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'law-vault-rollback-'));const encryption=encryptionProvider();
 try{
  const vault=new CredentialVault(dir,encryption);await vault.init();const empty=await vault.checkpoint();await vault.set({endpoint:credentialEndpoint('https://a.example/v1'),apiKey:'first-test-key'});const saved=await vault.checkpoint();const bytes=await readFile(join(dir,'model-key.bin'));
  await vault.set({endpoint:credentialEndpoint('https://b.example/v1'),apiKey:'second-test-key'});await vault.restoreCheckpoint(saved);assert.deepEqual(await readFile(join(dir,'model-key.bin')),bytes);assert.equal(vault.get('https://a.example/v1'),'first-test-key');assert.equal(vault.get('https://b.example/v1'),null);
  await vault.restoreCheckpoint(empty);await assert.rejects(readFile(join(dir,'model-key.bin')),{code:'ENOENT'});assert.equal(vault.snapshot(),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Tauri credential namespace preserves legacy ciphertext across save, rollback and clear',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'law-vault-tauri-'));const encryption=encryptionProvider();
 try{
  const legacy=new CredentialVault(dir,encryption);await legacy.init();const binding=credentialEndpoint('https://api.example/v1');await legacy.set({endpoint:binding,apiKey:'legacy-synthetic-key'});const before=await readFile(join(dir,'model-key.bin'));
  const current=new CredentialVault(dir,encryption,credentialEndpoint,2000,'model-key.tauri.bin');await current.init();assert.equal(current.get(binding),null);
  const empty=await current.checkpoint();await current.set({endpoint:binding,apiKey:'tauri-synthetic-key'});assert.deepEqual(await readFile(join(dir,'model-key.bin')),before);
  const restarted=new CredentialVault(dir,encryption,credentialEndpoint,2000,'model-key.tauri.bin');await restarted.init();assert.equal(restarted.get(binding),'tauri-synthetic-key');
  await current.restoreCheckpoint(empty);await assert.rejects(readFile(join(dir,'model-key.tauri.bin')),{code:'ENOENT'});assert.deepEqual(await readFile(join(dir,'model-key.bin')),before);
  await current.set({endpoint:binding,apiKey:'second-synthetic-key'});await current.set(null);assert.deepEqual(await readFile(join(dir,'model-key.bin')),before);
  assert.throws(()=>new CredentialVault(dir,encryption,credentialEndpoint,2000,'../escape.bin'),/filename/u);
 }finally{await rm(dir,{recursive:true,force:true});}
});
