import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { createDesktopRuntime } from '../src/desktop/runtime';
import type { DesktopHost, DesktopResult } from '../src/desktop/types';

interface RecordedCall { command: string; action?: string; payload?: unknown }
function data<T>(result: DesktopResult): T { if (!result.ok) assert.fail(result.error); return result.data as T; }
function denied(result: DesktopResult) { assert.equal(result.ok, false); if (!result.ok) assert.match(result.error, /SYNTHETIC_LICENSE_READ_ONLY/u); }

/** Parent/Core messaging is real. The worker deliberately denies admission;
 * it has no model, native keychain, customer documents or real license token. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'law-license-desktop-'));
  const entry = join(directory, 'synthetic-core.mjs'); const hostCalls: string[] = [];
  await writeFile(entry, `import {parentPort} from 'node:worker_threads';
const calls=[];
const state={documents:[],tasks:[],modelConfig:{provider:'chat-completions',baseUrl:'http://127.0.0.1:12345/v1',model:'synthetic'},retrievalConfig:null};
parentPort.on('message',m=>{
 const reply=data=>parentPort.postMessage({type:'response',id:m.id,data});
 calls.push({command:m.command,...(m.command==='runWorkspaceCommand'?{action:m.payload.action,payload:m.payload.payload}:{})});
 if(m.command==='assertLicenseWritable'){parentPort.postMessage({type:'response',id:m.id,error:'SYNTHETIC_LICENSE_READ_ONLY'});return;}
 if(m.command==='getState'){reply(state);return;}
 if(m.command==='runWorkspaceCommand'){
  if(m.payload.action==='workspace.progress'){reply(calls);return;}
  if(m.payload.action==='workspace.licenseState'){reply({mode:'required',status:'missing',canCreate:false,canViewExport:true});return;}
  if(m.payload.action==='workspace.licenseActivate'){reply({received:true});return;}
 }
 reply(null);
});parentPort.postMessage({type:'ready'});`);
  // An encrypted record ensures a misplaced preflight unlock would have a
  // native side effect; the stub cannot touch any real system keychain.
  await mkdir(join(directory, 'credentials'));
  await writeFile(join(directory, 'credentials', 'model-key.tauri.bin'), 'synthetic encrypted fixture');
  const host: DesktopHost = { emitTask: () => {}, call: async <T>(operation: string) => {
    hostCalls.push(operation);
    if (operation === 'credentialAvailable') return true as T;
    if (operation === 'credentialDecrypt') return { result: JSON.stringify({ version: 1, endpoint: 'http://127.0.0.1:12345/v1/chat/completions', apiKey: 'synthetic-only' }) } as T;
    return false as T;
  } };
  const runtime = await createDesktopRuntime(host, { dataDir: directory, coreEntry: pathToFileURL(entry), enforceLicensing: true, pressurePollMs: 0, shutdownTimeoutMs: 250 });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const calls = async () => data<RecordedCall[]>(await runtime.invoke({ name: 'runWorkspaceCommand', payload: { action: 'workspace.progress', payload: {} } }));
  return { runtime, hostCalls, calls };
}

test('expired/missing license denies import before showing a native file dialog or dispatching import', async t => {
  const { runtime, calls, hostCalls } = await fixture(t);
  denied(await runtime.invoke({ name: 'importContract' }));
  assert.deepEqual(hostCalls, []);
  const recorded = await calls(); assert.equal(recorded.filter(call => call.command === 'assertLicenseWritable').length, 1);
  assert.equal(recorded.some(call => call.command === 'importFile'), false);
});

test('review and each model workspace operation deny before configuration reads, credential unlock or model dispatch', async t => {
  const { runtime, calls, hostCalls } = await fixture(t);
  denied(await runtime.invoke({ name: 'startReview', payload: { documentId: randomUUID(), mode: 'model', context: {} } }));
  for (const action of ['translations.generate', 'modelRuntime.probe', 'alignment.compare', 'reporting.translation.generate']) {
    denied(await runtime.invoke({ name: 'runWorkspaceCommand', payload: { action, requestId: randomUUID(), payload: { confirmed: true } } }));
  }
  denied(await runtime.invoke({ name: 'testModelConnection' }));
  assert.deepEqual(hostCalls, []);
  const recorded = await calls(); assert.equal(recorded.filter(call => call.command === 'assertLicenseWritable').length, 6);
  assert.equal(recorded.some(call => ['getState', 'startReview', 'testModelConnection'].includes(call.command)), false);
  assert.deepEqual(recorded.filter(call => call.command === 'runWorkspaceCommand').map(call => call.action), ['workspace.progress']);
});

test('read state, licensing refresh and activation remain reachable without writable admission or keychain access', async t => {
  const { runtime, calls, hostCalls } = await fixture(t);
  assert.deepEqual(data<{ documents: unknown[] }>(await runtime.invoke({ name: 'getState' })).documents, []);
  assert.equal(data<{ canCreate: boolean }>(await runtime.invoke({ name: 'runWorkspaceCommand', payload: { action: 'workspace.licenseState', payload: {} } })).canCreate, false);
  const supplied = { token: 'synthetic-invalid-token-for-forwarding-test' };
  assert.equal(data<{ received: boolean }>(await runtime.invoke({ name: 'runWorkspaceCommand', payload: { action: 'workspace.licenseActivate', payload: supplied } })).received, true);
  const recorded = await calls();
  assert.equal(recorded.some(call => call.command === 'assertLicenseWritable'), false);
  assert.deepEqual(recorded.find(call => call.action === 'workspace.licenseActivate')?.payload, supplied);
  assert.deepEqual(hostCalls, []);
});

test('parent-only maintenance mutations are denied before file selection, worker shutdown or data changes', async t => {
  const { runtime, calls, hostCalls } = await fixture(t);
  for (const action of ['maintenance.restore', 'maintenance.clearKnowledge', 'maintenance.undoClear']) {
    denied(await runtime.invoke({ name: 'runWorkspaceCommand', payload: { action, payload: { confirmed: true } } }));
  }
  assert.deepEqual(hostCalls, []);
  const recorded = await calls(); assert.equal(recorded.filter(call => call.command === 'assertLicenseWritable').length, 3);
  assert.equal(recorded.some(call => call.command === 'close' || call.action?.startsWith('maintenance.')), false);
});

test('renderer cannot select a license build mode or invoke private worker resource controls', async t => {
  const { runtime, calls, hostCalls } = await fixture(t);
  for (const name of ['licenseBuildMode', 'deviceIdentity', 'updateResourcePressure', 'acquireResource', 'releaseResource', 'close']) {
    denied(await runtime.invoke({ name, payload: { mode: 'development', id: randomUUID() } }));
  }
  const extra = await runtime.invoke({ name: 'runWorkspaceCommand', payload: { action: 'workspace.licenseState', payload: {}, mode: 'development' } });
  assert.equal(extra.ok, false);
  const recorded = await calls();
  assert.equal(recorded.some(call => ['licenseBuildMode', 'deviceIdentity', 'updateResourcePressure', 'acquireResource', 'releaseResource', 'close'].includes(call.command)), false);
  assert.equal(recorded.some(call => call.action === 'workspace.licenseState'), false);
  assert.deepEqual(hostCalls, []);
});
