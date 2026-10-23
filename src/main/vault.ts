import { readFile, writeFile, mkdir, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface BoundCredential { endpoint: string; apiKey: string }
export interface CredentialCheckpoint { credential:BoundCredential|null; encryptedBytes:Buffer|null; storage:'os-encrypted'|'session-only'; encryptionChecked:boolean }
export interface SecretEncryption {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{result:string}>;
}
export function credentialEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl); const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  url.hash = ''; url.search = ''; return url.toString();
}

/** Renderer receives only key presence. Plaintext is never sent to Core except for a model request. */
export class CredentialVault {
  private credential: BoundCredential | null = null;
  private encryptionChecked = false;
  private deferred = false;
  private unlocking: Promise<void> | null = null;
  storage: 'os-encrypted' | 'session-only' = 'session-only';
  constructor(private directory: string, private encryption: SecretEncryption, private normalizeEndpoint: (value: string) => string = credentialEndpoint, private timeoutMs = 2000) {}
  private async bounded<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(operation),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('SYSTEM_CREDENTIAL_TIMEOUT')),this.timeoutMs);})]); }
    finally { if(timer)clearTimeout(timer); }
  }
  private async checkEncryption(): Promise<boolean> {
    this.encryptionChecked = true;
    try { this.storage = await this.bounded(()=>this.encryption.isAsyncEncryptionAvailable()) ? 'os-encrypted' : 'session-only'; }
    catch { this.storage='session-only'; }
    return this.storage==='os-encrypted';
  }
  async init(options: { deferUnlock?: boolean } = {}): Promise<void> {
    if(options.deferUnlock){this.deferred=true;return;}
    // Fresh installations have nothing to decrypt. Do not touch the macOS
    // keychain before a window exists just to discover an empty vault.
    let bytes: Buffer;
    try {
      const path=join(this.directory,'model-key.bin');const file=await lstat(path);
      if(!file.isFile()||file.isSymbolicLink()||file.size>128*1024)return;
      bytes=await readFile(path);
    } catch { return; }
    if(!await this.checkEncryption())return;
    try {
      const decoded = JSON.parse((await this.bounded(()=>this.encryption.decryptStringAsync(bytes))).result);
      if (decoded.version === 1 && typeof decoded.endpoint === 'string' && typeof decoded.apiKey === 'string') this.credential = { endpoint: decoded.endpoint, apiKey: decoded.apiKey };
    } catch { this.credential=null;this.storage='session-only'; }
  }
  async unlock(): Promise<void> {
    if(this.unlocking)return this.unlocking;
    if(!this.deferred)return;
    this.deferred=false;
    this.unlocking=this.init().finally(()=>{this.unlocking=null;});
    return this.unlocking;
  }
  get encryptionWasChecked(): boolean { return this.encryptionChecked; }
  snapshot(): BoundCredential | null { return this.credential ? { ...this.credential } : null; }
  async checkpoint():Promise<CredentialCheckpoint> {
    const path=join(this.directory,'model-key.bin');let encryptedBytes:Buffer|null=null;
    try{const file=await lstat(path);if(!file.isFile()||file.isSymbolicLink()||file.size>128*1024)throw new Error('系统密钥文件不是受管普通文件。');encryptedBytes=await readFile(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    return{credential:this.snapshot(),encryptedBytes,storage:this.storage,encryptionChecked:this.encryptionChecked};
  }
  async restoreCheckpoint(checkpoint:CredentialCheckpoint):Promise<void> {
    const path=join(this.directory,'model-key.bin');
    if(checkpoint.encryptedBytes){await mkdir(this.directory,{recursive:true});const temporary=`${path}.${randomUUID()}.tmp`;try{await writeFile(temporary,checkpoint.encryptedBytes,{mode:0o600,flag:'wx'});await rename(temporary,path);}finally{await rm(temporary,{force:true});}}
    else await rm(path,{force:true});
    this.credential=checkpoint.credential?{...checkpoint.credential}:null;this.storage=checkpoint.storage;this.encryptionChecked=checkpoint.encryptionChecked;
  }
  get(baseUrl: string): string | null { return this.credential?.endpoint === this.normalizeEndpoint(baseUrl) ? this.credential.apiKey : null; }
  async set(value: BoundCredential | null): Promise<void> {
    const path = join(this.directory, 'model-key.bin');
    if (!value) { await rm(path, { force: true }); this.credential = null; this.deferred=false; return; }
    await this.unlock();
    if(!this.encryptionChecked)await this.checkEncryption();
    if (this.storage === 'os-encrypted') {
      let encrypted:Buffer|undefined;
      try{encrypted=await this.bounded(()=>this.encryption.encryptStringAsync(JSON.stringify({version:1,...value})));}
      catch{this.storage='session-only';}
      if(encrypted){
        await mkdir(this.directory, { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, encrypted, { mode: 0o600 }); await rename(temporary, path); }
        catch { await rm(temporary, { force: true }); throw new Error('无法安全保存 API 密钥，请检查系统凭据服务和目录权限。'); }
      }
    }
    // An unavailable keychain must never erase the last successfully encrypted
    // credential. Only an explicit clear operation removes that file.
    this.credential = { ...value };
  }
}
