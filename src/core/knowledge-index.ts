import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdirSync, realpathSync } from 'node:fs';
import { lstat, realpath, open, opendir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import type { ContractBlock, Language } from '../shared/contracts';
import type { KnowledgeHit, KnowledgePort, KnowledgePreferences, KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeState, KnowledgeSyncJob, KnowledgeSyncMode } from '../shared/knowledge';
import { defaultKnowledgePreferences, normalizeKnowledgePreferences } from '../shared/knowledge-preferences';
import { detectLanguage, parseContract } from './documents';
import { KNOWLEDGE_TOKENIZER_VERSION, knowledgeQuery, tokenizeKnowledgeText } from './knowledge-tokenizer';

/** 工程暂定限额，可在大库性能/安全测试后调整；没有文件总数或目录总字节截断。 */
export const KNOWLEDGE_INDEX_LIMITS = Object.freeze({ fileBytes: 50 * 1024 * 1024, textCharacters: 2_000_000, directoryDepth: 64, chunkCharacters: 1800, chunksPerFile: 24_000, jobErrors: 50, searchLimit: 30, searchCandidates: 256, searchFiles: 32, searchBytes: 128 * 1024 * 1024, searchMilliseconds: 5000 });
const PARSER_VERSION = 'document-structure-2/text-lines-1';
const supported = new Set(['.txt', '.md', '.docx', '.pdf']);
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const now = (): string => new Date().toISOString();
const inside = (root: string, candidate: string): boolean => { const rel = relative(root, candidate); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const abortError = (): Error => new Error('知识库操作已取消');
const assertNotAborted = (signal: AbortSignal): void => { if (signal.aborted) throw abortError(); };
class SearchBudgetError extends Error {}
class KnowledgeScopeError extends Error {}

const relativeKey = (path: string, caseInsensitive = process.platform === 'win32'): string => {
  const normalized = path.replaceAll('\\', '/');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
};
/** 相对目录按组件边界匹配；Windows 忽略大小写，archive 不会排除 archive2。 */
export function matchesKnowledgeDirectory(path: string, directory: string, caseInsensitive = process.platform === 'win32'): boolean {
  const candidate = relativeKey(path, caseInsensitive); const excluded = relativeKey(directory, caseInsensitive).replace(/\/+$/, '');
  return candidate === excluded || candidate.startsWith(`${excluded}/`);
}
function preferencesSnapshot(preferences?: KnowledgePreferences): KnowledgePreferences {
  if (preferences === undefined) return defaultKnowledgePreferences();
  // 已获授权的审核快照与最新设置求交后，可能禁止所有格式；安全交集不能回退到默认范围。
  const noFileTypes = Array.isArray(preferences.fileTypes) && preferences.fileTypes.length === 0;
  const value = noFileTypes ? { ...preferences, fileTypes: ['txt'] } : preferences;
  let normalized: KnowledgePreferences;
  // 用户保存仍由共享验证限制 32 项；内部审核快照与当前设置的安全交集可有 64 项。
  // 分批完整验证并保留全部排除项，不以截断放宽旧授权范围。
  if (Array.isArray(value.excludeDirectories) && value.excludeDirectories.length > 32) {
    if (value.excludeDirectories.length > 64) throw new Error('内部知识库范围交集的排除目录不能超过64项。');
    const first = normalizeKnowledgePreferences({ ...value, excludeDirectories: value.excludeDirectories.slice(0, 32) });
    const second = normalizeKnowledgePreferences({ ...value, excludeDirectories: value.excludeDirectories.slice(32) });
    normalized = { ...first, excludeDirectories: [...new Set([...first.excludeDirectories, ...second.excludeDirectories])] };
  } else normalized = normalizeKnowledgePreferences(value);
  return noFileTypes ? { ...normalized, fileTypes: [] } : normalized;
}
const preferenceFileBytes = (preferences: KnowledgePreferences): number => preferences.maxFileSizeMb * 1024 * 1024;
function scopeKey(preferences: KnowledgePreferences): string {
  return JSON.stringify({ fileTypes: [...preferences.fileTypes].sort(), excludeDirectories: [...new Set(preferences.excludeDirectories.map(path => relativeKey(path)))].sort(), maxFileSizeMb: preferences.maxFileSizeMb });
}
function fileInScope(relativePath: string, size: string | bigint, preferences: KnowledgePreferences): boolean {
  const type = extname(relativePath).slice(1).toLowerCase();
  if (!preferences.fileTypes.some(allowed => allowed === type) || BigInt(size) > BigInt(preferenceFileBytes(preferences))) return false;
  const path = relativeKey(relativePath); const lastSlash = path.lastIndexOf('/');
  const directory = lastSlash < 0 ? '' : path.slice(0, lastSlash);
  return !preferences.excludeDirectories.some(excluded => matchesKnowledgeDirectory(directory, excluded));
}

interface RootRow { id: string; canonical_path: string; dev: string; ino: string; last_synced_at: string | null }
interface FileRow {
  id: string; root_id: string; relative_path: string; size: string; mtime_ns: string; dev: string; ino: string;
  file_sha256: string; version_id: string; parser_version: string; tokenizer_version: string; indexed_at: string;
  language: Language; warnings_json: string; stale: number; stale_reason: string | null;
}
interface ChunkRow extends FileRow { chunk_id: string; title: string; locator_label: string; location_json: string; text: string; text_sha256: string; rank: number }
interface Chunk { text: string; location: KnowledgeHit['location']; locator: string }
interface ReadSnapshot { buffer: Buffer; stat: BigIntStats; sha256: string }
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const sameStoredStat = (file: FileRow, stat: BigIntStats): boolean => file.size === String(stat.size) && file.mtime_ns === String(stat.mtimeNs) && file.dev === String(stat.dev) && file.ino === String(stat.ino);
const limitations = [
  '本地持久 FTS5 全文索引；ICU 分词和中英泰法律主题是有限术语映射，不支持任意语义跨语翻译。',
  '扫描 PDF 的 OCR 尚未实现；复杂 PDF 排版及 DOCX 特殊对象可能只提取部分文字，具体缺口随引文保留。',
  '尚未验证 1 TB 资料库的容量和性能；单文件 50 MiB、提取文字 200 万字符、目录深度 64 层是暂定工程上限。',
  '增量同步依据文件身份、大小和修改时间跳过未变化文件；校验同步强制计算哈希。命中来源会再次核验内容，异常时标记过期。',
];

/** 单个索引 Worker 独占该对象；不向旧业务 sql.js 数据库增加索引表。 */
export class LocalKnowledgeIndex implements KnowledgePort {
  private readonly db: DatabaseSync;
  private readonly indexDir: string;
  private closed = false;
  private closing = false;
  private active: Promise<KnowledgeSyncJob> | null = null;
  private activeAbort: AbortController | null = null;
  private readonly readers = new Set<Promise<unknown>>();
  private closeTask: Promise<void> | null = null;

  constructor(dataDir: string) {
    const indexDir = resolve(dataDir, 'local-knowledge');
    mkdirSync(indexDir, { recursive: true });
    this.indexDir = realpathSync(indexDir);
    this.db = new DatabaseSync(join(this.indexDir, 'index.sqlite'), { enableForeignKeyConstraints: true, allowExtension: false });
    this.db.function('knowledge_path_key', { deterministic: true }, value => typeof value === 'string' ? relativeKey(value) : '');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE;
      CREATE TABLE IF NOT EXISTS roots(id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, dev TEXT NOT NULL, ino TEXT NOT NULL, last_synced_at TEXT);
      CREATE TABLE IF NOT EXISTS source_files(
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE, relative_path TEXT NOT NULL,
        size TEXT NOT NULL, mtime_ns TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL,
        file_sha256 TEXT NOT NULL, version_id TEXT NOT NULL, parser_version TEXT NOT NULL, tokenizer_version TEXT NOT NULL,
        indexed_at TEXT NOT NULL, language TEXT NOT NULL, warnings_json TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN(0,1)),
        stale_reason TEXT, seen_job_id TEXT NOT NULL, UNIQUE(root_id,relative_path));
      CREATE INDEX IF NOT EXISTS source_files_root_stale ON source_files(root_id,stale);
      CREATE TABLE IF NOT EXISTS chunks(
        rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL, root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, title TEXT NOT NULL, locator_label TEXT NOT NULL,
        location_json TEXT NOT NULL, text TEXT NOT NULL, text_sha256 TEXT NOT NULL, search_text TEXT NOT NULL,
        UNIQUE(file_id,ordinal));
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(search_text, content='chunks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 0');
      CREATE TRIGGER IF NOT EXISTS chunks_insert AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,search_text) VALUES(new.rowid,new.search_text); END;
      CREATE TRIGGER IF NOT EXISTS chunks_delete AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text); END;
      CREATE TRIGGER IF NOT EXISTS chunks_update AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
        INSERT INTO chunks_fts(rowid,search_text) VALUES(new.rowid,new.search_text); END;
      CREATE TABLE IF NOT EXISTS sync_jobs(id TEXT PRIMARY KEY, root_id TEXT REFERENCES roots(id), folder_path TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, job_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sync_jobs_root_time ON sync_jobs(root_id,started_at DESC);
      CREATE INDEX IF NOT EXISTS sync_jobs_root_status_time ON sync_jobs(root_id,status,started_at DESC); PRAGMA user_version=1;`);
    // 首轮开发版本升级：只影响独立索引文件，不触及原业务数据库。
    if (!this.all<{ name: string }>('PRAGMA table_info(chunks)').some(column => column.name === 'root_id')) {
      this.db.exec('ALTER TABLE chunks ADD COLUMN root_id TEXT REFERENCES roots(id); UPDATE chunks SET root_id=(SELECT root_id FROM source_files WHERE id=chunks.file_id);');
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS root_totals(root_id TEXT PRIMARY KEY REFERENCES roots(id) ON DELETE CASCADE, files INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0, stale INTEGER NOT NULL DEFAULT 0);
      INSERT INTO root_totals(root_id,files,chunks,stale) SELECT r.id,(SELECT COUNT(*) FROM source_files f WHERE f.root_id=r.id),(SELECT COUNT(*) FROM chunks c WHERE c.root_id=r.id),(SELECT COUNT(*) FROM source_files f WHERE f.root_id=r.id AND f.stale=1) FROM roots r WHERE NOT EXISTS(SELECT 1 FROM root_totals t WHERE t.root_id=r.id);
      CREATE TRIGGER IF NOT EXISTS roots_totals_insert AFTER INSERT ON roots BEGIN INSERT INTO root_totals(root_id) VALUES(new.id); END;
      CREATE TRIGGER IF NOT EXISTS files_totals_insert AFTER INSERT ON source_files BEGIN UPDATE root_totals SET files=files+1,stale=stale+new.stale WHERE root_id=new.root_id; END;
      CREATE TRIGGER IF NOT EXISTS files_totals_delete AFTER DELETE ON source_files BEGIN UPDATE root_totals SET files=files-1,stale=stale-old.stale WHERE root_id=old.root_id; END;
      CREATE TRIGGER IF NOT EXISTS files_totals_stale AFTER UPDATE OF stale ON source_files BEGIN UPDATE root_totals SET stale=stale+new.stale-old.stale WHERE root_id=new.root_id; END;
      CREATE TRIGGER IF NOT EXISTS chunks_totals_insert AFTER INSERT ON chunks BEGIN UPDATE root_totals SET chunks=chunks+1 WHERE root_id=new.root_id; END;
      CREATE TRIGGER IF NOT EXISTS chunks_totals_delete AFTER DELETE ON chunks BEGIN UPDATE root_totals SET chunks=chunks-1 WHERE root_id=old.root_id; END;`);
    for (const row of this.all<{ id: string; job_json: string }>("SELECT id,job_json FROM sync_jobs WHERE status='running'")) {
      const job = JSON.parse(row.job_json) as KnowledgeSyncJob;
      job.status = 'interrupted'; job.phase = '上次进程中断；重新同步会复用已完成文件'; job.finishedAt = now(); job.fullScan = false;
      this.saveJob(job, null, false);
    }
  }

  private ensureOpen(): void { if (this.closed || this.closing) throw new Error('本地知识库已关闭'); }
  private trackedRead<T>(work: () => Promise<T>): Promise<T> {
    this.ensureOpen(); const operation = work(); this.readers.add(operation);
    void operation.finally(() => this.readers.delete(operation)).catch(() => { /* 原调用者接收错误。 */ }); return operation;
  }
  private get<T>(sql: string, ...values: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...values) as unknown as T | undefined; }
  private all<T>(sql: string, ...values: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...values) as unknown as T[]; }
  private transaction(action: () => void): void { this.db.exec('BEGIN IMMEDIATE'); try { action(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  private saveJob(job: KnowledgeSyncJob, rootId: string | null, insert = true): void {
    if (insert) this.db.prepare('INSERT INTO sync_jobs(id,root_id,folder_path,status,started_at,job_json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root_id=excluded.root_id,status=excluded.status,job_json=excluded.job_json').run(job.id, rootId, job.folderPath, job.status, job.startedAt, JSON.stringify(job));
    else this.db.prepare('UPDATE sync_jobs SET status=?,job_json=? WHERE id=?').run(job.status, JSON.stringify(job), job.id);
  }
  private async lookupRoot(folderPath: string): Promise<RootRow | undefined> {
    let path = resolve(folderPath);
    const registered = this.get<RootRow>('SELECT * FROM roots WHERE canonical_path=?', path);
    if (registered) return registered;
    try { if ((await lstat(path)).isSymbolicLink()) return undefined; path = await realpath(path); } catch { /* 离线或删除时仍能找到旧登记并标 stale。 */ }
    return this.get<RootRow>('SELECT * FROM roots WHERE canonical_path=?', path);
  }
  private async rootStat(root: RootRow): Promise<BigIntStats> {
    const stat = await lstat(root.canonical_path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== root.dev || String(stat.ino) !== root.ino || await realpath(root.canonical_path) !== root.canonical_path) throw new Error('授权目录身份已改变或变成链接；请恢复原目录，或选择新的资料路径');
    return stat;
  }
  private markStale(fileId: string, reason: string): void { this.db.prepare('UPDATE source_files SET stale=1,stale_reason=? WHERE id=?').run(reason.slice(0, 500), fileId); }
  private markRootStale(rootId: string, reason: string): void { this.db.prepare('UPDATE source_files SET stale=1,stale_reason=? WHERE root_id=?').run(reason.slice(0, 500), rootId); }

  async getState(folderPath: string | null, preferences?: KnowledgePreferences): Promise<KnowledgeState> {
    const snapshot = preferencesSnapshot(preferences);
    return this.trackedRead(() => this.stateInternal(folderPath, snapshot));
  }
  private async stateInternal(folderPath: string | null, preferences = defaultKnowledgePreferences()): Promise<KnowledgeState> {
    const root = folderPath === null ? undefined : await this.lookupRoot(folderPath);
    const totals = root ? this.get<{ files: number; stale: number; chunks: number }>('SELECT files,stale,chunks FROM root_totals WHERE root_id=?', root.id) : undefined;
    const recent = folderPath === null ? undefined : root
      ? this.get<{ job_json: string }>('SELECT job_json FROM sync_jobs WHERE root_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1', root.id)
      : this.get<{ job_json: string }>('SELECT job_json FROM sync_jobs WHERE folder_path=? ORDER BY started_at DESC,rowid DESC LIMIT 1', resolve(folderPath));
    const successful = root ? this.get<{ job_json: string }>("SELECT job_json FROM sync_jobs WHERE root_id=? AND status='completed' ORDER BY started_at DESC,rowid DESC LIMIT 1", root.id) : undefined;
    const latest = recent ? JSON.parse(recent.job_json) as KnowledgeSyncJob : null;
    const lastSuccess = successful ? JSON.parse(successful.job_json) as KnowledgeSyncJob : null;
    const changedScope = lastSuccess !== null && scopeKey(preferencesSnapshot(lastSuccess.preferences)) !== scopeKey(preferences);
    const needsSync = folderPath !== null && (!lastSuccess || changedScope || Number(totals?.stale ?? 0) > 0 || latest?.status !== 'completed');
    const notes = [...limitations];
    if (folderPath !== null) notes.push('文件及块数量统计的是已存储索引；当前格式、排除目录和大小限制立即约束检索及引文读取，旧范围索引会在完整成功同步后清理。');
    if (changedScope) notes.push('资料范围配置已改变，需要重新同步；扩大范围的资料只有在同步后才能被检索。');
    return { folderPath: root?.canonical_path ?? (folderPath === null ? null : resolve(folderPath)), engine: 'sqlite-fts5', tokenizerVersion: KNOWLEDGE_TOKENIZER_VERSION, indexedFiles: Number(totals?.files ?? 0), chunks: Number(totals?.chunks ?? 0), staleFiles: Number(totals?.stale ?? 0), lastSyncedAt: root?.last_synced_at ?? null, job: latest, limitations: notes, needsSync };
  }

  async syncFolder(input: { folderPath: string; jobId: string; mode: KnowledgeSyncMode; preferences?: KnowledgePreferences }, signal: AbortSignal, onProgress?: (job: KnowledgeSyncJob) => void): Promise<KnowledgeSyncJob> {
    this.ensureOpen();
    if (this.active) throw new Error('已有知识库同步正在进行，请先等待或取消');
    if (!input.jobId.trim()) throw new Error('知识库同步缺少任务标识');
    if (!['incremental', 'verify'].includes(input.mode)) throw new Error('不支持的知识库同步模式');
    if (this.get('SELECT id FROM sync_jobs WHERE id=?', input.jobId)) throw new Error('知识库同步任务标识已使用，请创建新任务');
    const preferences = preferencesSnapshot(input.preferences);
    const abort = new AbortController(); this.activeAbort = abort;
    const cancel = (): void => abort.abort(); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) abort.abort();
    const operation = this.runSync({ ...input, preferences }, abort.signal, onProgress); this.active = operation;
    try { return await operation; } finally { signal.removeEventListener('abort', cancel); this.active = null; this.activeAbort = null; }
  }

  private async runSync(input: { folderPath: string; jobId: string; mode: KnowledgeSyncMode; preferences: KnowledgePreferences }, signal: AbortSignal, onProgress?: (job: KnowledgeSyncJob) => void): Promise<KnowledgeSyncJob> {
    const job: KnowledgeSyncJob = { id: input.jobId, folderPath: resolve(input.folderPath), mode: input.mode, preferences: structuredClone(input.preferences), status: 'running', phase: '核验授权目录', startedAt: now(), finishedAt: null, scanned: 0, indexed: 0, unchanged: 0, deleted: 0, skipped: 0, failed: 0, fullScan: false, errors: [] };
    let root: RootRow | undefined;
    const progress = (): void => { this.saveJob(job, root?.id ?? null); try { onProgress?.(structuredClone(job)); } catch { /* UI 事件不能破坏已提交检查点。 */ } };
    const recordError = (path: string, error: unknown): void => { job.fullScan = false; job.failed++; if (job.errors.length < KNOWLEDGE_INDEX_LIMITS.jobErrors) job.errors.push({ path, message: message(error).slice(0, 600) }); };
    progress();
    try {
      assertNotAborted(signal);
      const selected = await lstat(job.folderPath, { bigint: true });
      if (!selected.isDirectory() || selected.isSymbolicLink()) throw new Error('请选择真实目录；知识库不跟随目录符号链接');
      const canonical = await realpath(job.folderPath);
      if (inside(this.indexDir, canonical)) throw new Error('不能将索引自身目录用作知识库');
      root = this.get<RootRow>('SELECT * FROM roots WHERE canonical_path=?', canonical);
      if (!root) {
        root = { id: randomUUID(), canonical_path: canonical, dev: String(selected.dev), ino: String(selected.ino), last_synced_at: null };
        this.db.prepare('INSERT INTO roots(id,canonical_path,dev,ino) VALUES(?,?,?,?)').run(root.id, canonical, root.dev, root.ino);
      }
      await this.rootStat(root); job.folderPath = canonical; progress();
      const walk = async (directory: string, depth: number): Promise<void> => {
        assertNotAborted(signal);
        if (depth > KNOWLEDGE_INDEX_LIMITS.directoryDepth) { recordError(directory, new Error('目录层级超过暂定 64 层限制；本轮不应用删除')); return; }
        let handle;
        try { handle = await opendir(directory); } catch (error) { recordError(directory, error); return; }
        try {
          for await (const entry of handle) {
            assertNotAborted(signal);
            const path = join(directory, entry.name);
            if (inside(this.indexDir, path)) continue;
            const rel = relative(canonical, path);
            if (input.preferences.excludeDirectories.some(excluded => matchesKnowledgeDirectory(rel, excluded)) && (entry.isDirectory() || entry.isSymbolicLink())) { job.skipped++; continue; }
            if (entry.isSymbolicLink()) {
              job.skipped++; job.fullScan = false;
              const rel = relative(canonical, path); const prefix = `${rel}${sep}`;
              this.db.prepare('UPDATE source_files SET stale=1,stale_reason=? WHERE root_id=? AND (relative_path=? OR substr(relative_path,1,?)=?)').run('来源已替换为符号链接', root!.id, rel, prefix.length, prefix);
              if (job.errors.length < KNOWLEDGE_INDEX_LIMITS.jobErrors) job.errors.push({ path, message: '跳过符号链接；本轮不应用删除' }); continue;
            }
            if (entry.isDirectory()) {
              // 再次核验可防止 Dirent 读取后目录被替换为链接。
              try { await this.authorizePath(root!, path, true); await walk(path, depth + 1); } catch (error) { if (signal.aborted) throw error; recordError(path, error); }
              continue;
            }
            if (!entry.isFile() || !supported.has(extname(entry.name).toLowerCase()) || !input.preferences.fileTypes.some(type => `.${type}` === extname(entry.name).toLowerCase())) { job.skipped++; continue; }
            job.scanned++; job.phase = `同步 ${relative(canonical, path)}`;
            try { await this.syncFile(root!, path, input.mode, job, signal); } catch (error) {
              const existing = this.get<FileRow>('SELECT * FROM source_files WHERE root_id=? AND relative_path=?', root!.id, relative(canonical, path));
              if (existing && !signal.aborted) this.markStale(existing.id, message(error));
              if (signal.aborted) throw error;
              recordError(path, error);
            }
            progress(); await yieldImmediate(); assertNotAborted(signal);
          }
        } catch (error) { if (signal.aborted) throw error; recordError(directory, error); }
      };
      await walk(canonical, 0); assertNotAborted(signal); await this.rootStat(root);
      job.fullScan = job.failed === 0 && job.errors.length === 0;
      if (job.fullScan) {
        job.phase = '核对已删除来源'; progress(); assertNotAborted(signal);
        this.transaction(() => { const result = this.db.prepare('DELETE FROM source_files WHERE root_id=? AND seen_job_id<>?').run(root!.id, job.id); job.deleted = Number(result.changes); });
      }
      job.status = job.fullScan ? 'completed' : 'partial'; job.phase = job.fullScan ? '同步完成' : '同步部分完成；未应用删除';
      this.db.prepare('UPDATE roots SET last_synced_at=? WHERE id=?').run(now(), root.id);
    } catch (error) {
      job.fullScan = false; job.status = signal.aborted ? 'cancelled' : 'failed'; job.phase = signal.aborted ? '同步已取消；未应用删除' : '同步失败；未应用删除';
      if (!signal.aborted) { recordError(job.folderPath, error); if (root) this.markRootStale(root.id, message(error)); }
    }
    job.finishedAt = now(); progress(); return structuredClone(job);
  }

  /** 只允许授权根内、所有相对组件都不是符号链接的普通文件/目录。 */
  private async authorizePath(root: RootRow, path: string, directory = false): Promise<BigIntStats> {
    if (!inside(root.canonical_path, path) || inside(this.indexDir, path)) throw new Error('来源超出授权目录或位于索引自身目录');
    await this.rootStat(root);
    const parts = relative(root.canonical_path, path).split(sep).filter(Boolean);
    let current = root.canonical_path; let stat: BigIntStats | undefined;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]); stat = await lstat(current, { bigint: true });
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) throw new Error('来源路径包含符号链接或无效目录');
    }
    stat ??= await lstat(path, { bigint: true });
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('来源不再是预期的普通文件或目录');
    if (await realpath(path) !== path) throw new Error('来源真实路径改变，已停止读取');
    return stat;
  }

  private async snapshot(root: RootRow, path: string, signal?: AbortSignal, maxBytes = KNOWLEDGE_INDEX_LIMITS.fileBytes, onRead?: (bytes: number) => void, fileLimitBytes = KNOWLEDGE_INDEX_LIMITS.fileBytes): Promise<ReadSnapshot> {
    if (signal) assertNotAborted(signal);
    const before = await this.authorizePath(root, path);
    if (before.size > BigInt(fileLimitBytes)) throw new KnowledgeScopeError(`单文件超过当前配置 ${fileLimitBytes / (1024 * 1024)} MiB 限制`);
    if (before.size > BigInt(maxBytes)) throw new SearchBudgetError('本次检索原件读取预算已用尽');
    const readLimit = Math.min(maxBytes, fileLimitBytes, KNOWLEDGE_INDEX_LIMITS.fileBytes);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameIdentity(before, opened)) throw new Error('读取前来源身份发生变化');
      const buffers: Buffer[] = []; let total = 0;
      while (true) {
        if (signal) assertNotAborted(signal);
        if (total >= readLimit) break;
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - total)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead; onRead?.(bytesRead); buffers.push(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat({ bigint: true }); const pathAfter = await this.authorizePath(root, path);
      if (!sameIdentity(before, after) || !sameIdentity(before, pathAfter) || BigInt(total) !== before.size) throw new Error('读取中来源发生变化，请重新同步');
      const buffer = Buffer.concat(buffers, total); return { buffer, stat: after, sha256: hash(buffer) };
    } finally { await handle.close(); }
  }

  private async syncFile(root: RootRow, path: string, mode: KnowledgeSyncMode, job: KnowledgeSyncJob, signal: AbortSignal): Promise<void> {
    const rel = relative(root.canonical_path, path);
    const existing = this.get<FileRow>('SELECT * FROM source_files WHERE root_id=? AND relative_path=?', root.id, rel);
    const stat = await this.authorizePath(root, path);
    const limitBytes = preferenceFileBytes(job.preferences!);
    if (stat.size > BigInt(limitBytes)) throw new Error(`单文件超过当前配置 ${job.preferences!.maxFileSizeMb} MiB 限制；未删除旧版本`);
    const currentParser = existing?.parser_version === PARSER_VERSION && existing.tokenizer_version === KNOWLEDGE_TOKENIZER_VERSION;
    if (mode === 'incremental' && existing && !existing.stale && currentParser && sameStoredStat(existing, stat)) {
      this.db.prepare('UPDATE source_files SET seen_job_id=? WHERE id=?').run(job.id, existing.id); job.unchanged++; return;
    }
    const snapshot = await this.snapshot(root, path, signal, limitBytes, undefined, limitBytes); assertNotAborted(signal);
    if (existing && currentParser && existing.file_sha256 === snapshot.sha256) {
      this.db.prepare('UPDATE source_files SET size=?,mtime_ns=?,dev=?,ino=?,stale=0,stale_reason=NULL,seen_job_id=? WHERE id=?').run(String(snapshot.stat.size), String(snapshot.stat.mtimeNs), String(snapshot.stat.dev), String(snapshot.stat.ino), job.id, existing.id);
      job.unchanged++; return;
    }
    let chunks: Chunk[]; let language: Language; let warnings: string[] = [];
    const extension = extname(path).toLowerCase();
    if (extension === '.txt' || extension === '.md') {
      const bytes = snapshot.buffer;
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
      let text: string;
      try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { throw new Error('文本编码无效；当前支持 UTF-8 或带 BOM 的 UTF-16'); }
      if (text.length > KNOWLEDGE_INDEX_LIMITS.textCharacters) throw new Error('提取文字超过暂定 200 万字符限制');
      if (text.includes('\u0000')) throw new Error('文本包含二进制 NUL，未作为资料索引');
      chunks = this.textChunks(text); language = detectLanguage(text);
    } else {
      const temporary = await mkdtemp(join(this.indexDir, 'parse-'));
      try {
        const copy = join(temporary, `source${extension}`); await writeFile(copy, snapshot.buffer, { flag: 'wx', mode: 0o600 });
        const parsed = await parseContract(copy); assertNotAborted(signal);
        warnings = parsed.warnings; language = parsed.language;
        chunks = parsed.blocks.flatMap(block => this.blockChunks(block));
        if (parsed.partial) { job.fullScan = false; if (job.errors.length < KNOWLEDGE_INDEX_LIMITS.jobErrors) job.errors.push({ path, message: '文档仅部分可提取，缺口随来源记录；本轮不应用删除' }); }
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    if (!chunks.length) throw new Error('未提取到可检索文字；扫描 PDF 需要 OCR，当前尚未实现');
    if (chunks.length > KNOWLEDGE_INDEX_LIMITS.chunksPerFile) throw new Error('单文件结构块超过暂定 24000 块限制');
    const after = await this.authorizePath(root, path);
    if (!sameIdentity(snapshot.stat, after)) throw new Error('解析期间来源发生变化，未发布新索引');
    assertNotAborted(signal);
    const fileId = existing?.id ?? randomUUID(); const versionId = hash(`${snapshot.sha256}:${PARSER_VERSION}:${KNOWLEDGE_TOKENIZER_VERSION}`); const indexedAt = now();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO source_files(id,root_id,relative_path,size,mtime_ns,dev,ino,file_sha256,version_id,parser_version,tokenizer_version,indexed_at,language,warnings_json,stale,stale_reason,seen_job_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?) ON CONFLICT(root_id,relative_path) DO UPDATE SET size=excluded.size,mtime_ns=excluded.mtime_ns,dev=excluded.dev,ino=excluded.ino,file_sha256=excluded.file_sha256,version_id=excluded.version_id,parser_version=excluded.parser_version,tokenizer_version=excluded.tokenizer_version,indexed_at=excluded.indexed_at,language=excluded.language,warnings_json=excluded.warnings_json,stale=0,stale_reason=NULL,seen_job_id=excluded.seen_job_id`)
        .run(fileId, root.id, rel, String(after.size), String(after.mtimeNs), String(after.dev), String(after.ino), snapshot.sha256, versionId, PARSER_VERSION, KNOWLEDGE_TOKENIZER_VERSION, indexedAt, language, JSON.stringify(warnings), job.id);
      this.db.prepare('DELETE FROM chunks WHERE file_id=?').run(fileId);
      const insert = this.db.prepare('INSERT INTO chunks(id,file_id,version_id,root_id,ordinal,title,locator_label,location_json,text,text_sha256,search_text) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      chunks.forEach((chunk, ordinal) => insert.run(randomUUID(), fileId, versionId, root.id, ordinal, basename(path), chunk.locator, JSON.stringify(chunk.location), chunk.text, hash(chunk.text), tokenizeKnowledgeText(`${basename(path)}\n${chunk.text}`)));
    });
    job.indexed++;
  }

  private textChunks(text: string): Chunk[] {
    const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(line => line.length > 0) ?? [];
    const chunks: Chunk[] = []; let pending = ''; let start = 1; let end = 1;
    const flush = (): void => { if (pending.trim()) chunks.push({ text: pending, location: { kind: 'text', lineStart: start, lineEnd: end }, locator: `第 ${start}–${end} 行` }); pending = ''; };
    lines.forEach((line, index) => {
      if (pending.length && pending.length + line.length > KNOWLEDGE_INDEX_LIMITS.chunkCharacters) flush();
      if (line.length > KNOWLEDGE_INDEX_LIMITS.chunkCharacters) {
        flush(); for (const part of splitText(line)) if (part.trim()) chunks.push({ text: part, location: { kind: 'text', lineStart: index + 1, lineEnd: index + 1 }, locator: `第 ${index + 1} 行` });
      } else { if (!pending) start = index + 1; pending += line; end = index + 1; }
    });
    flush(); return chunks;
  }
  private blockChunks(block: ContractBlock): Chunk[] {
    const locator = block.locator.kind === 'docx' ? `${block.locator.partName} ${block.locator.structuralPath}` : `PDF 第 ${block.locator.pageIndex + 1} 页`;
    return splitText(block.text).filter(text => text.trim()).map((text, index, all) => ({ text, location: block.locator, locator: all.length > 1 ? `${locator}，片段 ${index + 1}/${all.length}` : locator }));
  }

  private chunkSelect = 'SELECT f.*,c.id AS chunk_id,c.title,c.locator_label,c.location_json,c.text,c.text_sha256';
  private hit(row: ChunkRow): KnowledgeHit {
    const root = this.get<RootRow>('SELECT * FROM roots WHERE id=?', row.root_id)!;
    return { chunkId: row.chunk_id, sourceFileId: row.id, versionId: row.version_id, title: row.title, relativePath: row.relative_path, sourceUri: pathToFileURL(join(root.canonical_path, row.relative_path)).href, locator: row.locator_label, location: JSON.parse(row.location_json) as KnowledgeHit['location'], excerpt: row.text, excerptSha256: row.text_sha256, fileSha256: row.file_sha256, language: row.language, indexedAt: row.indexed_at, score: Math.max(0, -Number(row.rank ?? 0)), warnings: JSON.parse(row.warnings_json) as string[] };
  }
  private async validateSource(root: RootRow, file: FileRow, preferences: KnowledgePreferences, signal?: AbortSignal, maxBytes?: number, onRead?: (bytes: number) => void): Promise<boolean> {
    if (file.stale) return false;
    if (!fileInScope(file.relative_path, file.size, preferences)) return false;
    try {
      const snapshot = await this.snapshot(root, join(root.canonical_path, file.relative_path), signal, maxBytes, onRead, preferenceFileBytes(preferences));
      if (snapshot.sha256 !== file.file_sha256) throw new Error('来源内容已变化，请重新同步');
      if (file.parser_version !== PARSER_VERSION || file.tokenizer_version !== KNOWLEDGE_TOKENIZER_VERSION) throw new Error('索引解析/分词版本已变化，请重新同步');
      return true;
    } catch (error) { if (signal?.aborted) throw abortError(); if (error instanceof SearchBudgetError) throw error; if (error instanceof KnowledgeScopeError) return false; this.markStale(file.id, message(error)); return false; }
  }

  /** 在 LIMIT 前约束范围，使被排除的高排名资料不能耗尽候选预算。 */
  private scopeSql(preferences: KnowledgePreferences): { sql: string; values: SQLInputValue[] } {
    if (!preferences.fileTypes.length) return { sql: ' AND 0', values: [] };
    const clauses = [`(${preferences.fileTypes.map(() => 'lower(f.relative_path) GLOB ?').join(' OR ')})`, 'CAST(f.size AS INTEGER)<=?'];
    const values: SQLInputValue[] = [...preferences.fileTypes.map(type => `*.${type}`), preferenceFileBytes(preferences)];
    for (const directory of preferences.excludeDirectories) {
      const prefix = `${relativeKey(directory)}/`;
      clauses.push('substr(knowledge_path_key(f.relative_path),1,?)<>?'); values.push([...prefix].length, prefix);
    }
    return { sql: ` AND ${clauses.join(' AND ')}`, values };
  }

  async search(input: KnowledgeSearchInput & { folderPath: string }, signal?: AbortSignal): Promise<KnowledgeSearchResult> {
    return this.trackedRead(() => this.searchInternal({ ...input, preferences: preferencesSnapshot(input.preferences) }, signal));
  }
  private async searchInternal(input: KnowledgeSearchInput & { folderPath: string; preferences: KnowledgePreferences }, signal?: AbortSignal): Promise<KnowledgeSearchResult> {
    const started = performance.now();
    if (signal) assertNotAborted(signal);
    const query = knowledgeQuery(input.query, input.terms); const root = await this.lookupRoot(input.folderPath); const hits: KnowledgeHit[] = [];
    if (signal) assertNotAborted(signal);
    const limit = Math.min(KNOWLEDGE_INDEX_LIMITS.searchLimit, Math.max(1, Number.isFinite(input.limit) ? Math.floor(input.limit!) : 6));
    let budgetLimited = false;
    if (root && query.match) {
      try { await this.rootStat(root); } catch (error) { this.markRootStale(root.id, message(error)); return { query: input.query, expandedTerms: query.expandedTerms, hits, state: await this.stateInternal(input.folderPath, input.preferences), elapsedMs: performance.now() - started }; }
      const checked = new Map<string, boolean>(); let offset = 0; let bytes = 0;
      const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), KNOWLEDGE_INDEX_LIMITS.searchMilliseconds);
      const combinedSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const scope = this.scopeSql(input.preferences);
      // 固定取得最多 256 个候选，后续标 stale 不会使 OFFSET 漏掉其他候选。
      // FTS5 的 rank 默认采用 BM25，ORDER BY rank 支持 LIMIT 提前结束的优化路径。
      const candidates = this.all<ChunkRow>(`${this.chunkSelect},chunks_fts.rank AS rank FROM chunks_fts JOIN chunks c ON c.rowid=chunks_fts.rowid JOIN source_files f ON f.id=c.file_id WHERE chunks_fts MATCH ? AND f.root_id=? AND f.stale=0${scope.sql} ORDER BY chunks_fts.rank LIMIT ?`, query.match, root.id, ...scope.values, KNOWLEDGE_INDEX_LIMITS.searchCandidates);
      // 分页只触碰候选块和相应文件；不会为一次查询重新遍历资料目录。
      try {
        for (const candidate of candidates) {
          offset++;
          if (signal) assertNotAborted(signal);
          if (deadline.signal.aborted) { budgetLimited = true; break; }
          let valid = checked.get(candidate.id);
          if (valid === undefined) {
            if (checked.size >= KNOWLEDGE_INDEX_LIMITS.searchFiles || Number(candidate.size) > KNOWLEDGE_INDEX_LIMITS.searchBytes - bytes) { budgetLimited = true; break; }
            try { valid = await this.validateSource(root, candidate, input.preferences, combinedSignal, KNOWLEDGE_INDEX_LIMITS.searchBytes - bytes, read => { bytes += read; }); } catch (error) { if (signal) assertNotAborted(signal); if (error instanceof SearchBudgetError || deadline.signal.aborted) { budgetLimited = true; break; } throw error; }
            checked.set(candidate.id, valid);
          }
          if (valid) { hits.push(this.hit(candidate)); if (hits.length >= limit) break; }
        }
        if (hits.length < limit && offset >= KNOWLEDGE_INDEX_LIMITS.searchCandidates) budgetLimited = true;
      } finally { clearTimeout(timer); }
    }
    if (signal) assertNotAborted(signal);
    const state = await this.stateInternal(input.folderPath, input.preferences);
    if (budgetLimited) state.limitations.push('本次查询达到检索预算（最多 256 候选、32 个原件、128 MiB 原件读取、5 秒协作式核验），结果可能不完整；可缩小查询或同步清理过期来源。');
    return { query: input.query, expandedTerms: query.expandedTerms, hits, state, elapsedMs: performance.now() - started };
  }
  async readChunk(input: { folderPath: string; chunkId: string; preferences?: KnowledgePreferences }): Promise<KnowledgeHit> {
    return this.trackedRead(() => this.readChunkInternal({ ...input, preferences: preferencesSnapshot(input.preferences) }));
  }
  private async readChunkInternal(input: { folderPath: string; chunkId: string; preferences: KnowledgePreferences }): Promise<KnowledgeHit> {
    const root = await this.lookupRoot(input.folderPath);
    if (!root) throw new Error('该目录尚未建立本地知识库索引');
    const row = this.get<ChunkRow>(`${this.chunkSelect},0 AS rank FROM chunks c JOIN source_files f ON f.id=c.file_id WHERE c.id=? AND f.root_id=?`, input.chunkId, root.id);
    if (!row) throw new Error('引文不存在或不属于当前授权知识库');
    if (!fileInScope(row.relative_path, row.size, input.preferences)) throw new Error('该引文已被当前知识库格式、目录或大小配置排除，不能继续读取');
    if (!await this.validateSource(root, row, input.preferences)) throw new Error('来源已变化、删除、失去授权、超过当前大小配置或索引过期，请重新同步后引用');
    return this.hit(row);
  }
  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true; this.activeAbort?.abort();
    this.closeTask = (async () => { await Promise.allSettled([...(this.active ? [this.active] : []), ...this.readers]); this.db.close(); this.closed = true; })();
    return this.closeTask;
  }
}

/** 在代码点边界切块，覆盖全部提取原文，不用截取开头代替全文。 */
function splitText(text: string): string[] {
  const output: string[] = []; let start = 0;
  while (start < text.length) {
    let end = Math.min(start + KNOWLEDGE_INDEX_LIMITS.chunkCharacters, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    output.push(text.slice(start, end)); start = end;
  }
  return output;
}
