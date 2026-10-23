import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isIP } from 'node:net';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, realpath, statfs } from 'node:fs/promises';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { KnowledgeWorkerClient } from '../core/knowledge-client';
import type { KnowledgeHit, KnowledgeState, KnowledgeSyncJob, KnowledgeSyncMode } from '../shared/knowledge';

const BODY_LIMIT = 16 * 1024;
const MAX_ACTIVE_READS = 8;
const inside = (parent: string, child: string) => { const value = relative(parent, child); return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
const hash = (value: string) => createHash('sha256').update(value).digest();
const searchSchema = z.object({ query: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(30).optional() }).strict();
const syncSchema = z.object({ mode: z.enum(['incremental', 'verify']).optional() }).strict();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
class RequestError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }

export interface KnowledgeNodeOptions {
  root: string; dataDir: string; token: string; host?: string; port?: number; publicUrl?: string;
  /** Primarily useful to an administrator importing the server into a process manager. */
  autoSync?: boolean;
}
export interface KnowledgeNodeHandle { url: string; root: string; dataDir: string; close(): Promise<void> }

export function knowledgeNodeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): KnowledgeNodeOptions {
  if (!env.LAW_KB_ROOT || !env.LAW_KB_DATA || !env.LAW_KB_TOKEN) throw new Error('请配置 LAW_KB_ROOT、LAW_KB_DATA 和 LAW_KB_TOKEN。');
  const port = env.LAW_KB_PORT === undefined ? 8787 : Number(env.LAW_KB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LAW_KB_PORT 须为1–65535。');
  return { root: env.LAW_KB_ROOT, dataDir: env.LAW_KB_DATA, token: env.LAW_KB_TOKEN, host: env.LAW_KB_HOST ?? '127.0.0.1', port, ...(env.LAW_KB_PUBLIC_URL ? { publicUrl: env.LAW_KB_PUBLIC_URL } : {}) };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) throw new RequestError(415, 'JSON_REQUIRED');
  const declared = request.headers['content-length']; if (declared && (!/^\d+$/u.test(declared) || Number(declared) > BODY_LIMIT)) throw new RequestError(413, 'BODY_TOO_LARGE');
  let size = 0; const pieces: Buffer[] = [];
  for await (const piece of request) { const bytes = Buffer.isBuffer(piece) ? piece : Buffer.from(piece); size += bytes.length; if (size > BODY_LIMIT) throw new RequestError(413, 'BODY_TOO_LARGE'); pieces.push(bytes); }
  try { return JSON.parse(Buffer.concat(pieces).toString('utf8')); } catch { throw new RequestError(400, 'INVALID_JSON'); }
}

/** Read-only fixed-root retrieval. The sole write operation rebuilds the
 * administrator-owned local index; no request can choose a path or command. */
export async function startKnowledgeNode(options: KnowledgeNodeOptions): Promise<KnowledgeNodeHandle> {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('远端索引节点需要 Node.js 24 或更高版本。');
  if (!options || typeof options.token !== 'string' || options.token.length < 24 || options.token.length > 4096 || /\s/u.test(options.token)) throw new Error('索引节点令牌须为24–4096字符，不能含空白。');
  const host = options.host ?? '127.0.0.1'; const port = options.port ?? 8787;
  if (host !== 'localhost' && !isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('索引节点监听地址或端口无效。');
  if (!isAbsolute(options.root) || !isAbsolute(options.dataDir) || /^(?:\\\\|\/\/)/u.test(options.dataDir)) throw new Error('索引节点目录必须使用绝对路径；数据目录不能为UNC网络路径。');
  const selected = await lstat(options.root); if (!selected.isDirectory() || selected.isSymbolicLink()) throw new Error('LAW_KB_ROOT 必须为明确授权的真实目录，不能为目录符号链接。');
  const root = await realpath(options.root); if (root === parse(root).root && !root.startsWith('\\\\')) throw new Error('请授权专用资料目录，不能直接授权整个系统盘根目录。');
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 }); const selectedData = await lstat(options.dataDir); if (!selectedData.isDirectory() || selectedData.isSymbolicLink()) throw new Error('索引数据目录必须为本机真实目录。'); const dataDir = await realpath(options.dataDir);
  if (inside(root, dataDir) || inside(dataDir, root)) throw new Error('索引数据目录与授权资料目录必须彼此独立，不能互相包含。');
  // Known Linux network filesystem types. Mapped drives and less common
  // platforms additionally require the administrator's local-disk assurance.
  const filesystem = await statfs(dataDir, { bigint: true }); if ([0x6969n, 0x517bn, 0xff534d42n].includes(filesystem.type)) throw new Error('SQLite索引数据不能存放在NFS/SMB/CIFS网络文件系统。');
  let publicUrl: URL | null = null;
  if (options.publicUrl) { publicUrl = new URL(options.publicUrl); if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || !['https:', 'http:'].includes(publicUrl.protocol) || publicUrl.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname)) throw new Error('LAW_KB_PUBLIC_URL 须为无凭据的HTTPS地址；仅回环地址允许HTTP。'); publicUrl.pathname = `${publicUrl.pathname.replace(/\/+$/u, '')}/`; }
  const worker = new URL('./knowledge-worker.js', import.meta.url); const workerEntry = existsSync(fileURLToPath(worker)) ? worker : new URL('./knowledge-worker.ts', import.meta.url);
  const index = new KnowledgeWorkerClient(dataDir, workerEntry);
  let state: KnowledgeState;
  try { state = await index.getState(root); } catch (error) { await index.close(); throw error; }
  let active: Promise<KnowledgeSyncJob> | null = null; let activeAbort: AbortController | null = null; let currentJob: KnowledgeSyncJob | null = state.job; let pendingJobId: string | null = null; let closing = false; let activeReads = 0; let syncError = false; const controllers = new Set<AbortController>(); const inFlight = new Set<Promise<void>>();
  const beginSync = (mode: KnowledgeSyncMode) => {
    if (active || closing) throw new RequestError(409, closing ? 'SHUTTING_DOWN' : 'SYNC_IN_PROGRESS');
    const controller = new AbortController(); const jobId = randomUUID(); activeAbort = controller; pendingJobId = jobId; syncError = false;
    const operation = index.syncFolder({ folderPath: root, jobId, mode }, controller.signal, job => { currentJob = job; });
    active = operation;
    void operation.then(job => { currentJob = job; }, () => { syncError = true; }).then(async () => { try { state = await index.getState(root); } catch { syncError = true; } }).finally(() => { if (active === operation) { active = null; activeAbort = null; pendingJobId = null; } });
    return jobId;
  };
  const expected = hash(options.token);
  const authorized = (request: IncomingMessage) => { const header = request.headers.authorization; const supplied = typeof header === 'string' ? /^Bearer ([^\s]+)$/iu.exec(header)?.[1] ?? '' : ''; return timingSafeEqual(expected, hash(supplied)); };
  let nodeUrl = '';
  const hit = (value: KnowledgeHit) => ({ id: value.chunkId, document_id: value.sourceFileId, title: value.title, text: value.excerpt, sourceUri: new URL(`chunks/${encodeURIComponent(value.chunkId)}`, publicUrl ?? `${nodeUrl}/v1/`).toString(), locator: `${value.relativePath} · ${value.locator}`, fileSha256: value.fileSha256, excerptSha256: value.excerptSha256, version: value.versionId, indexedAt: value.indexedAt, contentScope: 'fragment', location: value.location, warnings: value.warnings });
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (!authorized(request)) { request.resume(); json(response, 401, { error: 'UNAUTHORIZED' }); return; }
      if (closing) throw new RequestError(503, 'SHUTTING_DOWN');
      if (request.headers.origin) throw new RequestError(403, 'BROWSER_ORIGIN_NOT_ALLOWED');
      const url = new URL(request.url ?? '/', 'http://fixed.invalid'); if (url.search || url.hash) throw new RequestError(400, 'QUERY_PARAMETERS_NOT_SUPPORTED');
      if (request.method === 'GET' && url.pathname === '/v1/status') { json(response, 200, { version: 'law-knowledge-node-1', syncing: !!active, pendingJobId, syncError, state: { ...state, job: currentJob, ...(active ? { needsSync: true } : {}) } }); return; }
      if (request.method === 'POST' && url.pathname === '/v1/sync') { const parsed = syncSchema.safeParse(await readJson(request)); if (!parsed.success) throw new RequestError(400, 'INVALID_SYNC_INPUT'); json(response, 202, { jobId: beginSync(parsed.data.mode ?? 'incremental'), status: 'running' }); return; }
      if (request.method === 'POST' && url.pathname === '/v1/cancel') { const parsed = z.object({}).strict().safeParse(await readJson(request)); if (!parsed.success) throw new RequestError(400, 'INVALID_CANCEL_INPUT'); activeAbort?.abort(); json(response, 202, { cancelled: !!active, jobId: pendingJobId }); return; }
      const chunk = request.method === 'GET' ? /^\/v1\/chunks\/([^/]+)$/u.exec(url.pathname) : null;
      if (request.method === 'POST' && url.pathname === '/v1/search' || chunk) {
        if (activeReads >= MAX_ACTIVE_READS) throw new RequestError(429, 'READ_LIMIT_REACHED'); activeReads++;
        const controller = new AbortController(); controllers.add(controller); const aborted = () => controller.abort(); request.once('aborted', aborted);
        try {
          if (chunk) { if (!uuid.test(chunk[1])) throw new RequestError(400, 'INVALID_CHUNK_ID'); try { json(response, 200, { result: hit(await index.readChunk({ folderPath: root, chunkId: chunk[1] })) }); } catch (error) { if (error instanceof RequestError) throw error; throw new RequestError(404, 'CHUNK_UNAVAILABLE_OR_STALE'); } }
          else { const parsed = searchSchema.safeParse(await readJson(request)); if (!parsed.success) throw new RequestError(400, 'INVALID_SEARCH_INPUT'); const result = await index.search({ folderPath: root, ...parsed.data }, controller.signal); state = result.state; json(response, 200, { results: result.hits.map(hit), query: result.query, expandedTerms: result.expandedTerms, elapsedMs: result.elapsedMs, limitations: result.state.limitations, needsSync: result.state.needsSync }); }
        } finally { activeReads--; controllers.delete(controller); request.removeListener('aborted', aborted); }
        return;
      }
      throw new RequestError(404, 'NOT_FOUND');
    } catch (error) { request.resume(); json(response, error instanceof RequestError ? error.status : 503, { error: error instanceof RequestError ? error.code : 'INDEX_OPERATION_UNAVAILABLE' }); }
  };
  const server = createServer({ maxHeaderSize: BODY_LIMIT, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 1000 }, (request, response) => { const operation = handle(request, response); inFlight.add(operation); void operation.finally(() => inFlight.delete(operation)); });
  server.maxConnections = 64;
  try { await new Promise<void>((resolveListening, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolveListening(); }); }); } catch (error) { await index.close(); throw error; }
  const address = server.address() as AddressInfo; nodeUrl = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
  if (options.autoSync !== false) beginSync('incremental');
  let closeTask: Promise<void> | null = null;
  const close = () => closeTask ??= (async () => { closing = true; activeAbort?.abort(); for (const controller of controllers) controller.abort(); const stopped = new Promise<void>(resolveClosed => server.close(() => resolveClosed())); server.closeIdleConnections(); await Promise.allSettled([...inFlight, ...(active ? [active] : [])]); await index.close(); server.closeAllConnections(); await stopped; })();
  return { url: nodeUrl, root, dataDir, close };
}

async function main(): Promise<void> {
  const node = await startKnowledgeNode(knowledgeNodeOptionsFromEnv());
  process.stdout.write(`Knowledge index node listening at ${node.url}; fixed root configured.\n`);
  const stop = () => { void node.close().then(() => process.exit(0), () => process.exit(1)); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(() => { process.stderr.write('Knowledge index node failed to start. Check Node.js version, fixed directories, token and bind settings.\n'); process.exitCode = 1; });
