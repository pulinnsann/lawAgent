import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, posix } from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import { z } from 'zod';
import { createRetrievalHttp } from './retrieval-http';
import type { ContractDetail, ReviewContext, RetrievalAttempt, SourceEvidence, RetrievalBundle } from '../shared/contracts';
import type { WorkspaceAssets, WorkspaceAsset } from './workspace-assets';
import type { KnowledgePort } from '../shared/knowledge';

const hash = (value:string|Buffer) => createHash('sha256').update(value).digest('hex');
const http = createRetrievalHttp();
const text = (max:number) => z.string().trim().min(1).max(max);
const mapping = z.object({ name:text(160), queryArgument:text(80).default('query'), arguments:z.record(z.string(),z.unknown()).default({}), resultsPath:z.string().max(200).default(''), readonly:z.literal(true) }).strict();
const schema = z.object({ name:text(120), enabled:z.boolean(), type:z.enum(['mcp','sftp','directory','index_api']), endpoint:z.string().max(2048).default(''), host:z.string().max(253).default(''), port:z.number().int().min(1).max(65535).default(22), username:z.string().max(160).default(''), root:z.string().max(4096).default(''), fingerprint:z.string().max(128).default(''), maxFileMb:z.number().int().min(1).max(50).default(50), maxCacheGb:z.number().min(0.1).max(2048).default(20), maxFiles:z.number().int().min(1).max(1000000).default(100000), maxResults:z.number().int().min(1).max(20).default(6), timeoutSeconds:z.number().int().min(5).max(120).default(30), statutes:mapping.nullable().default(null), cases:mapping.nullable().default(null) }).strict();
export type WorkspaceConnection = z.infer<typeof schema>;
export type ConnectionSecrets = Record<string,string>;
export function normalizeConnection(value:unknown):WorkspaceConnection {
 const c=schema.parse(value);
 if(c.type==='mcp'||c.type==='index_api'){const url=new URL(c.endpoint);if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('连接需为无内嵌凭据的HTTPS地址，本机允许HTTP。');c.endpoint=url.toString();}
 if(c.type==='sftp'&&(!/^[a-zA-Z0-9._:-]+$/u.test(c.host)||!c.username||!c.root.startsWith('/')||c.root.includes('\0')||!/^SHA256:[A-Za-z0-9+/]{43}=?$/u.test(c.fingerprint)))throw new Error('SFTP需填写主机、用户名、绝对目录和服务端SHA256主机密钥指纹。');
 if(c.type==='directory'&&!isAbsolute(c.root))throw new Error('共享盘请填写已授权的本机挂载目录或Windows UNC绝对路径。');
 return c;
}
export function connectionBinding(asset:Pick<WorkspaceAsset,'id'|'body'>):string {const c=asset.body;return `${asset.id}:${hash(JSON.stringify({type:c.type,endpoint:c.endpoint,host:c.host,port:c.port,username:c.username,fingerprint:c.fingerprint}))}`;}
function at(value:any,path:string):any {for(const key of path.split('.').filter(Boolean)){if(['__proto__','constructor','prototype'].includes(key))throw new Error('字段路径无效。');value=value?.[key];}return value;}
function rpcMessage(body:Buffer,contentType:string,id:number):any {
 const raw=body.toString('utf8');
 const values=/event-stream/iu.test(contentType)?raw.split(/\r?\n\r?\n/u).flatMap(event=>{const data=event.split(/\r?\n/u).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)return[];try{return[JSON.parse(data)];}catch{throw new Error('MCP事件不是有效JSON。');}}):[JSON.parse(raw)];
 const message=values.find(value=>value?.id===id);if(!message||message.jsonrpc!=='2.0'||message.error)throw new Error('MCP未返回匹配的成功响应；请检查权限、参数及额度。');return message.result;
}
export class ReadonlyMcpClient {
 private session='';private version='2025-11-25';private id=0;private initialized=false;
 constructor(private endpoint:string,private secret:string|undefined,private timeoutSeconds:number,private signal:AbortSignal,private transport= http.raw){}
 private async request(method:string,params:any,notification=false):Promise<any>{
  const id=++this.id;const result=await this.transport(this.endpoint,{method:'POST',signal:this.signal,timeoutSeconds:this.timeoutSeconds,headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json',...(this.secret?{Authorization:`Bearer ${this.secret}`} :{}),...(this.initialized?{'MCP-Protocol-Version':this.version}:{}),...(this.session?{'Mcp-Session-Id':this.session}:{})},body:{jsonrpc:'2.0',...(notification?{}:{id}),method,...(params===undefined?{}:{params})}});
  if(notification)return null;
  const value=rpcMessage(result.body,result.contentType,id);if(result.headers?.['mcp-session-id'])this.session=result.headers['mcp-session-id'];return value;
 }
 async initialize(){const value=await this.request('initialize',{protocolVersion:this.version,capabilities:{},clientInfo:{name:'law-agent-readonly',version:'0.2.0'}});if(!['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(value?.protocolVersion))throw new Error('MCP协议版本不受支持。');this.version=value.protocolVersion;if(!value.capabilities?.tools)throw new Error('此MCP服务未声明tools能力。');this.initialized=true;await this.request('notifications/initialized',undefined,true);}
 async tools(){const tools:any[]=[];let cursor:string|undefined;for(let page=0;page<4;page++){const result=await this.request('tools/list',cursor?{cursor}:{});if(!Array.isArray(result?.tools))throw new Error('MCP工具目录无效。');tools.push(...result.tools);cursor=result.nextCursor;if(!cursor)break;}return tools.slice(0,200);}
 async search(tool:z.infer<typeof mapping>,query:string){const tools=await this.tools();const found=tools.find(item=>item.name===tool.name);if(!found)throw new Error('所配置的只读检索工具不在当前工具目录中。');if(found.annotations?.readOnlyHint!==true||found.annotations?.destructiveHint===true)throw new Error('工具声明会修改数据，不能用于本软件检索。');const result=await this.request('tools/call',{name:tool.name,arguments:{...tool.arguments,[tool.queryArgument]:query}});if(result?.isError)throw new Error('专业库检索失败，请检查工具参数、权限与额度。');return result;}
}
function safeUrl(value:unknown):string|null{if(typeof value!=='string')return null;try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||[...u.searchParams.keys()].some(k=>/token|key|secret|password/iu.test(k)))return null;return u.toString();}catch{return null;}}
function documents(value:any,resultsPath=''):any[]{if(value?.structuredContent)value=value.structuredContent;else if(Array.isArray(value?.content)){const texts=value.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text);try{value=JSON.parse(texts.join('\n'));}catch{value={text:texts.join('\n')};}}if(resultsPath)value=at(value,resultsPath);if(Array.isArray(value))return value;for(const key of ['results','documents','items','data','hits'])if(Array.isArray(value?.[key]))return value[key];return value&&typeof value==='object'?[value]:[];}
function evidence(asset:WorkspaceAsset,attempt:RetrievalAttempt,item:any,kind:SourceEvidence['kind']):SourceEvidence|null{
 const raw=typeof item==='string'?item:item.excerpt??item.text??item.content??item.page_content??item.snippet;
 if(typeof raw!=='string'||!raw.trim())return null;
 const excerpt=raw.slice(0,24000);const uri=safeUrl(item.url??item.source_url??item.sourceUri);const title=String(item.title??item.name??item.document_name??'未提供标题的检索片段').slice(0,500);
 return{id:randomUUID(),attemptId:attempt.id,channel:attempt.channel,kind,title,sourceUri:uri,locator:String(item.locator??item.article??item.document_id??item.id??'未提供稳定文档定位').slice(0,1000),excerpt,excerptSha256:hash(excerpt),contentScope:item.contentScope==='full_text'&&excerpt.length===raw.length?'full_text':'fragment',retrievedAt:new Date().toISOString(),publishedAt:typeof item.publishedAt==='string'?item.publishedAt:null,effectiveAt:typeof item.effectiveAt==='string'?item.effectiveAt:null,currentness:'unknown',isOfficial:false,warnings:[`连接：${asset.body.name}；配置版本 ${asset.revision}。资料效力和适用性需人工核查。`,...(!uri?['服务未返回可回溯文档链接，不能视为已核验来源。']:[])],connection:{id:asset.id,revision:asset.revision,provider:asset.body.type,documentId:String(item.document_id??item.id??''),version:String(item.version??''),documentNumber:String(item.documentNumber??item.document_number??''),crossCheck:'not_attempted',relatedEvidenceIds:[]}};
}
export async function retrieveConnectionEvidence(assets:WorkspaceAsset[],secrets:ConnectionSecrets,query:string,signal:AbortSignal):Promise<{attempts:RetrievalAttempt[];evidence:SourceEvidence[]}>{
 const attempts:RetrievalAttempt[]=[];const sources:SourceEvidence[]=[];
 await Promise.all(assets.filter(a=>!a.deleted&&a.body.enabled).slice(0,8).map(async asset=>{
  const c=normalizeConnection(asset.body);if(!['mcp','index_api'].includes(c.type))return;
  const kinds:Array<'statute'|'case'|'company_policy'>=c.type==='mcp'?['statute','case']:['company_policy'];
  for(const kind of kinds){if(signal.aborted)break;const tool=kind==='case'?c.cases:c.statutes;if(c.type==='mcp'&&!tool)continue;
   const attempt:RetrievalAttempt={id:randomUUID(),channel:c.type==='mcp'?'web':'knowledge',provider:c.type==='mcp'?'professional_mcp':'remote_index',query,status:'failed',startedAt:new Date().toISOString(),finishedAt:'',resultCount:0,error:null,warnings:[`连接 ${asset.id}，配置修订 ${asset.revision}`],connectionId:asset.id};attempts.push(attempt);
   const controller=new AbortController();const cancel=()=>controller.abort();signal.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,c.timeoutSeconds*1000);
   try{controller.signal.throwIfAborted();let result:any;
    if(c.type==='mcp'){const client=new ReadonlyMcpClient(c.endpoint,secrets[asset.id],c.timeoutSeconds,controller.signal);await client.initialize();result=await client.search(tool!,query);}
    else result=(await http.json(new URL('search',c.endpoint.replace(/\/?$/u,'/')).toString(),{method:'POST',headers:{'Content-Type':'application/json',...(secrets[asset.id]?{Authorization:`Bearer ${secrets[asset.id]}`}:{})},body:{query,limit:c.maxResults},signal:controller.signal,timeoutSeconds:c.timeoutSeconds})).data;
    const candidates=documents(result,tool?.resultsPath).slice(0,c.maxResults);for(const item of candidates){const source=evidence(asset,attempt,item,kind);if(source)sources.push(source);}attempt.resultCount=sources.filter(s=>s.attemptId===attempt.id).length;attempt.status=attempt.resultCount?'complete':'empty';
   }catch{attempt.status=signal.aborted?'cancelled':controller.signal.aborted?'timeout':'failed';attempt.error='连接未完成检索，请检查配置、工具参数、权限或额度。未回显服务响应及凭据。';}
   finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);attempt.finishedAt=new Date().toISOString();}
  }
 }));
 const credentials=Object.values(secrets).filter(value=>Boolean(value));const redact=(value:string)=>credentials.reduce((result,key)=>result.split(key).join('[已遮蔽凭据]'),value);
 for(const attempt of attempts){attempt.error=attempt.error?redact(attempt.error):null;attempt.warnings=attempt.warnings.map(redact);}
 for(const source of sources){source.title=redact(source.title);source.locator=redact(source.locator);const old=source.excerpt;source.excerpt=redact(source.excerpt);source.excerptSha256=hash(source.excerpt);source.warnings=source.warnings.map(redact);if(old!==source.excerpt)source.warnings.push('检索片段中的连接凭据已遮蔽，不作为未处理原文。');if(source.sourceUri&&credentials.some(key=>source.sourceUri!.includes(key)))source.sourceUri=null;if(source.connection){source.connection.documentId=redact(source.connection.documentId);source.connection.version=redact(source.connection.version);source.connection.documentNumber=redact(source.connection.documentNumber);}}
 return{attempts,evidence:sources};
}
export function crossCheckSources(sources:SourceEvidence[]):string[]{
 const notes:string[]=[];
 for(let i=0;i<sources.length;i++)for(let j=i+1;j<sources.length;j++){
  const a=sources[i],b=sources[j];const normalize=(s:string)=>s.normalize('NFC').replace(/\s+/gu,'');
  if(normalize(a.title)!==normalize(b.title))continue;
  const sameVersion=Boolean(a.connection?.version&&a.connection.version===b.connection?.version)||Boolean(a.officialMetadata?.versionLabel&&a.officialMetadata.versionLabel===b.connection?.version);
  const equal=normalize(a.excerpt)===normalize(b.excerpt);const state=equal?'consistent':sameVersion&&a.locator===b.locator?'different':'version_unknown';
  for(const [source,other]of [[a,b],[b,a]])if(source.connection){source.connection.crossCheck=state;source.connection.relatedEvidenceIds.push(other.id);}
  if(!equal)notes.push(`同名资料《${a.title}》取得内容存在差异（${state==='different'?'同版同定位文字不同':'版本或取得范围可能不同'}），保留双方原文供法务判断；未自动选取某一方。`);
 }
 return[...new Set(notes)].slice(0,50);
}
export interface SftpMirrorClient {
 connect(options:Parameters<SftpClient['connect']>[0]):Promise<unknown>;
 list(path:string):ReturnType<SftpClient['list']>;
 realPath(path:string):Promise<string>;
 lstat(path:string):ReturnType<SftpClient['stat']>;
 createReadStream(path:string):Readable;
 end():Promise<unknown>;
}
export interface ConnectionDeps{assets:WorkspaceAssets;dataDir:string;secrets:ConnectionSecrets;knowledge:KnowledgePort;signal?:AbortSignal;onProgress?:(value:unknown)=>void;/** Engineering tests only; IPC never accepts a client factory. */sftpFactory?:()=>SftpMirrorClient}
export async function runConnectionCommand(action:string,payload:any,deps:ConnectionDeps):Promise<any>{
 if(action==='connections.list')return deps.assets.list('connection');
 if(action==='connections.save'){const value=z.object({id:z.string().uuid().optional(),expectedRevision:z.number().int().min(0),body:schema,actorLabel:z.string().max(80).optional()}).strict().parse(payload);return deps.assets.save({...value,kind:'connection',body:normalizeConnection(value.body)});}
 if(action==='connections.remove'){const a=deps.assets.get(z.string().uuid().parse(payload.id));if(a.kind!=='connection')throw new Error('不是连接配置。');return deps.assets.save({id:a.id,kind:a.kind,expectedRevision:payload.expectedRevision,body:a.body,deleted:true});}
 const asset=deps.assets.get(z.string().uuid().parse(payload?.id));if(asset.kind!=='connection'||asset.deleted)throw new Error('连接不存在。');const c=normalizeConnection(asset.body);const signal=deps.signal??new AbortController().signal;
 if(action==='connections.tools'){if(c.type!=='mcp')throw new Error('仅MCP连接支持工具发现。');const client=new ReadonlyMcpClient(c.endpoint,deps.secrets[asset.id],c.timeoutSeconds,signal);await client.initialize();return client.tools();}
 if(action==='connections.test'||action==='connections.search'){const query=text(200).parse(payload.query??'合同违约责任');if(c.type==='mcp'||c.type==='index_api')return retrieveConnectionEvidence([{...asset,body:{...c,enabled:true}}],deps.secrets,query,signal);if(c.type==='directory'){const info=await stat(c.root);if(!info.isDirectory())throw new Error('共享盘目录不可读。');return{connected:true,root:c.root};}return syncSftp(asset,deps,true);}
 if(action==='connections.sync')return syncSftp(asset,deps,false);
 throw new Error('不支持的连接命令。');
}
type MirrorEntry = { size: number; modifyTime: number; sha256: string };
const mirrorEntrySchema = z.object({ size: z.number().int().min(0).max(50 * 1024 ** 2), modifyTime: z.number().finite().min(0), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const validCachePath = (key: string) => Boolean(key) && /\.(?:txt|md|docx|pdf)$/iu.test(key) && !isAbsolute(key) && !key.includes('\0') && !key.split(/[\\/]/u).some(part => !part || part === '..' || part === '.');
const pathWithin = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel); };
const portableName = (name: string) => name !== '.' && name !== '..' && !/[\\/\u0000-\u001f<>:"|?*]|[. ]$/u.test(name) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name);

async function localHash(path: string, maximum: number, signal: AbortSignal): Promise<string | null> {
 const before = await lstat(path).catch(() => null); if (!before?.isFile() || before.isSymbolicLink() || before.size > maximum) return null;
 const digest = createHash('sha256'); let size = 0;
 for await (const bytes of createReadStream(path, { signal })) { size += bytes.length; if (size > maximum) return null; digest.update(bytes); }
 const after = await lstat(path).catch(() => null);
 return after?.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs ? digest.digest('hex') : null;
}

/** No remote shell or write operation. The connection account must itself be
 * confined/read-only: SFTP cannot provide an atomic portable O_NOFOLLOW open. */
async function syncSftp(asset: WorkspaceAsset, deps: ConnectionDeps, testOnly: boolean): Promise<any> {
 const c = normalizeConnection(asset.body); if (c.type === 'directory') return { folderPath: c.root }; if (c.type !== 'sftp') throw new Error('此连接无需下载镜像。');
 const raw = deps.secrets[asset.id]; if (!raw) throw new Error('请配置SFTP密码或私钥。');
 let auth: { password?: string; privateKey?: string; passphrase?: string }; try { auth = raw.trim().startsWith('{') ? JSON.parse(raw) : { password: raw }; } catch { auth = { password: raw }; }
 auth = z.object({ password: z.string().max(8192).optional(), privateKey: z.string().max(65536).optional(), passphrase: z.string().max(8192).optional() }).strict().refine(value => Boolean(value.password || value.privateKey)).parse(auth);
 const client = deps.sftpFactory?.() ?? new SftpClient() as unknown as SftpMirrorClient; const signal = deps.signal ?? new AbortController().signal;
 const root = posix.normalize(c.root); const cache = join(deps.dataDir, 'remote-cache', asset.id); const manifestPath = join(cache, '.law-sync-manifest.json');
 await mkdir(cache, { recursive: true }); const canonicalCache = await realpath(cache);
 if (canonicalCache !== resolve(cache) || !(await lstat(cache)).isDirectory() || (await lstat(cache)).isSymbolicLink()) throw new Error('镜像目录必须是本机真实目录，不能使用符号链接。');
 const safeLocal = async (path: string) => { if (!pathWithin(canonicalCache, path)) throw new Error('镜像路径超出目录。'); let cursor = canonicalCache; for (const segment of relative(canonicalCache, path).split(/[\\/]/u).filter(Boolean)) { cursor = join(cursor, segment); const info = await lstat(cursor).catch(() => null); if (info?.isSymbolicLink()) throw new Error('镜像目录中存在符号链接，已停止同步。'); } };
 await safeLocal(manifestPath);
 const expected = c.fingerprint.replace(/^SHA256:/u, '').replace(/=+$/u, ''); const cancel = () => { void client.end().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
 const counters = { scanned: 0, downloaded: 0, unchanged: 0, deleted: 0, skipped: 0, bytes: 0, partial: false }; const seen = new Set<string>(); const folded = new Set<string>();
 let previous: Record<string, MirrorEntry> = {};
 try {
  const info = await lstat(manifestPath); if (info.size > 64 * 1024 ** 2) throw new Error('镜像记录过大。');
  const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('镜像记录无效。');
  const entries = Object.entries(value); if (entries.length > 1_000_000 || entries.some(([key]) => !validCachePath(key))) throw new Error('镜像记录路径无效。');
  for (const [key, entry] of entries) previous[key] = mirrorEntrySchema.parse(entry);
 } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { signal.removeEventListener('abort', cancel); throw new Error('镜像记录无效，已保留缓存且停止同步。'); } }
 const next = { ...previous }; const maximumBytes = c.maxCacheGb * 1024 ** 3; const maximumFile = c.maxFileMb * 1024 ** 2;
 const checkedRemote = async (path: string, directory: boolean) => {
  signal.throwIfAborted(); const actual = posix.normalize(await client.realPath(path)); const delta = posix.relative(root, actual);
  if (actual !== path || delta === '..' || delta.startsWith('../') || posix.isAbsolute(delta)) throw new Error('远端路径含链接或越出授权目录。');
  const info = await client.lstat(path); if (info.isSymbolicLink || directory && !info.isDirectory || !directory && !info.isFile) throw new Error('远端对象类型改变或变成符号链接。');
  if (!directory && (!Number.isSafeInteger(info.size) || info.size < 0 || !Number.isFinite(info.modifyTime) || info.modifyTime < 0)) throw new Error('远端文件大小或修改时间无效。');
  return info;
 };
 try {
  signal.throwIfAborted(); await client.connect({ host: c.host, port: c.port, username: c.username, ...auth, readyTimeout: c.timeoutSeconds * 1000, hostVerifier: (key: Buffer) => createHash('sha256').update(key).digest('base64').replace(/=+$/u, '') === expected }); signal.throwIfAborted();
  await checkedRemote(root, true);
  if (testOnly) { const list = await client.list(root); return { connected: true, entries: list.length, root }; }
  const walk = async (remote: string, local: string, depth: number): Promise<void> => {
   signal.throwIfAborted(); if (depth > 64) { counters.partial = true; return; }
   await checkedRemote(remote, true);
   for (const entry of await client.list(remote)) {
    if (counters.scanned >= c.maxFiles) { counters.partial = true; return; }
    signal.throwIfAborted(); if (!entry.name || !portableName(entry.name)) { counters.partial = true; counters.skipped++; continue; }
    const remotePath = posix.join(remote, entry.name); const localPath = join(local, entry.name); const key = relative(cache, localPath); await safeLocal(localPath); if (!pathWithin(cache, localPath)) throw new Error('远端路径超出镜像目录。');
    if (entry.type === 'l') { counters.skipped++; counters.partial = true; continue; }
    if (entry.type === 'd') { try { await checkedRemote(remotePath, true); await mkdir(localPath, { recursive: true }); await walk(remotePath, localPath, depth + 1); } catch { signal.throwIfAborted(); counters.partial = true; counters.skipped++; } continue; }
    if (entry.type !== '-' || !/\.(?:txt|md|docx|pdf)$/iu.test(entry.name)) continue;
    seen.add(key); counters.scanned++; const foldedKey = key.toLocaleLowerCase('en-US'); if (folded.has(foldedKey)) { counters.partial = true; counters.skipped++; continue; } folded.add(foldedKey);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isFinite(entry.modifyTime) || entry.modifyTime < 0 || counters.scanned > c.maxFiles || entry.size > maximumFile || counters.bytes + entry.size > maximumBytes) { counters.skipped++; counters.partial = true; continue; }
    const temporary = `${localPath}.${randomUUID()}.tmp`;
    try {
     const before = await checkedRemote(remotePath, false); if (before.size !== entry.size || before.modifyTime !== entry.modifyTime) throw new Error('远端文件在扫描期间变化。');
     const old = previous[key];
     if (old?.size === entry.size && old.modifyTime === entry.modifyTime && await localHash(localPath, maximumFile, signal) === old.sha256) { const after = await checkedRemote(remotePath, false); if (after.size !== before.size || after.modifyTime !== before.modifyTime) throw new Error('远端文件在增量核对期间变化。'); counters.unchanged++; counters.bytes += entry.size; continue; }
     let transferred = 0; const digest = createHash('sha256');
     const limiter = new Transform({ transform(bytes: Buffer, _encoding, callback) { transferred += bytes.length; if (transferred > entry.size || transferred > maximumFile || counters.bytes + transferred > maximumBytes) callback(new Error('远端传输超过已声明大小或缓存预算。')); else { digest.update(bytes); callback(null, bytes); } } });
     await pipeline(client.createReadStream(remotePath), limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
     signal.throwIfAborted(); const after = await checkedRemote(remotePath, false);
     if (after.size !== before.size || after.modifyTime !== before.modifyTime || transferred !== before.size) throw new Error('远端文件在传输期间变化。');
     await safeLocal(localPath); await rename(temporary, localPath); next[key] = { size: transferred, modifyTime: after.modifyTime, sha256: digest.digest('hex') }; counters.downloaded++; counters.bytes += transferred;
    } catch { signal.throwIfAborted(); counters.partial = true; counters.skipped++; }
    finally { await rm(temporary, { force: true }); }
    try { deps.onProgress?.({ ...counters, phase: '同步远端文件' }); } catch { /* A progress view must not break a committed file. */ }
   }
   await checkedRemote(remote, true);
  };
  await walk(root, cache, 0); signal.throwIfAborted();
  if (!counters.partial) for (const key of Object.keys(previous)) if (!seen.has(key)) { const path = join(cache, key); await safeLocal(path); await rm(path, { force: true }); delete next[key]; counters.deleted++; }
  const manifestTemporary = `${manifestPath}.${randomUUID()}.tmp`;
  try { await safeLocal(manifestPath); await writeFile(manifestTemporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); await rename(manifestTemporary, manifestPath); } finally { await rm(manifestTemporary, { force: true }); }
  return { ...counters, folderPath: cache, warning: counters.partial ? '同步不完整，未传播删除；预算约束本次传输，旧缓存与已完成文件保留。' : null, limitations: ['SFTP无可移植的原子禁止跟随链接打开；已在读取前后核对规范路径与对象类型，服务器账号仍须限定授权目录且只读。', '增量比较远端大小与修改时间，并复核本机镜像SHA256；无法识别远端保持相同元数据的内容改写，需重新下载或改用服务端索引节点。'] };
 } catch (error) {
  if (signal.aborted) throw new Error('远端同步已取消，已完成文件保留。');
  if (error instanceof Error && /远端根目录|规范目录|远端路径含链接|远端对象类型/u.test(error.message)) throw error;
  throw new Error('SFTP连接或同步未完成，请核对主机指纹、认证与读取权限。');
 } finally { signal.removeEventListener('abort', cancel); await client.end().catch(() => {}); }
}
