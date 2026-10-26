import { createRequire } from 'node:module';
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { readFile, mkdir, lstat, copyFile, chmod, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { SqlValue, Database, QueryExecResult } from 'sql.js';

export type StorageRow = Record<string, SqlValue>;
export type StorageBackend = 'rust' | 'sqljs';
export interface StorageDatabase {
  readonly backend: StorageBackend;
  run(sql: string, values?: SqlValue[]): void;
  exec(sql: string): QueryExecResult[];
  all(sql: string, values?: SqlValue[]): StorageRow[];
  close(): void;
  export(): Uint8Array;
  backup(path: string): void;
}

type BindingDatabase = {
  run(sql: string, parameters?: string): number;
  query(sql: string, parameters?: string): string;
  queryRows(sql: string, parameters: string, callback: (row: string) => void): void;
  close(): void;
  backup(path: string): void;
};
type Binding = { NativeDatabase: new (path: string, options?: string) => BindingDatabase; WorkspaceLease: new (path: string) => { close(): void } };
let binding: Binding | undefined;

function loadBinding(): Binding {
  if (binding) return binding;
  const name = `law-agent-store-${process.platform}-${process.arch}.node`;
  const resources = process.env.LAW_AGENT_RESOURCES_DIR ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  // Production code is loaded only from application-owned resources. Development
  // paths are derived from this module's parents, never from an arbitrary CWD.
  let selected = resources ? join(resources, 'native', name) : null;
  if (!selected || !existsSync(selected)) {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 6; depth++) {
      try {
        const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        if (metadata.name === 'law-agent-desktop') {
          const candidate = join(directory, '.local', 'native', name);
          if (existsSync(candidate)) selected = candidate;
          break;
        }
      } catch { /* This source/chunk directory need not contain package metadata. */ }
      const parent = dirname(directory); if (parent === directory) break; directory = parent;
    }
  }
  if (!selected || !existsSync(selected)) throw new Error('Rust 原生存储组件缺失，请重新安装相应系统版本；开发环境请运行 npm run native:binding。');
  try { binding = createRequire(import.meta.url)(selected) as Binding; }
  catch (cause) { throw new Error('Rust 原生存储组件无法加载，请重新安装相应系统版本。', { cause }); }
  return binding;
}

function encode(values: SqlValue[]): string {
  return JSON.stringify(values.map(value => {
    if (value instanceof Uint8Array) return { $blob: Array.from(value) };
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('数据库参数不是有限数值。');
    return value;
  }));
}
function cell(value: unknown): SqlValue {
  if (value && typeof value === 'object' && '$blob' in value) return Uint8Array.from((value as { $blob: number[] }).$blob);
  return value as SqlValue;
}

export function openNativeDatabase(path: string, readOnly = false): StorageDatabase {
  const db = new (loadBinding().NativeDatabase)(path, JSON.stringify({ readOnly, cacheKiB: 8192, maxQueryBytes: 64 * 1024 ** 2, maxRowsBytes: 256 * 1024 ** 2 }));
  return {
    backend: 'rust',
    run(sql, values) { db.run(sql, values === undefined ? undefined : encode(values)); },
    exec(sql) { return (JSON.parse(db.query(sql)) as QueryExecResult[]).map(result => ({ ...result, values: result.values.map(row => row.map(cell)) })); },
    all(sql, values = []) {
      const result: StorageRow[] = [];
      db.queryRows(sql, encode(values), raw => { const row = JSON.parse(raw) as Record<string, unknown>; for (const key of Object.keys(row)) row[key] = cell(row[key]); result.push(row as StorageRow); });
      return result;
    },
    close() { db.close(); },
    export() { throw new Error('Rust 磁盘存储不支持整库导出到内存；请使用在线备份。'); },
    backup(destination) { db.backup(destination); },
  };
}

export async function openLegacyDatabase(bytes?: Uint8Array): Promise<StorageDatabase> {
  // Only the explicitly selected reference backend initializes WASM.
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs({ wasmBinary: new Uint8Array(await readFile(createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm'))).buffer });
  const db: Database = new SQL.Database(bytes);
  return {
    backend: 'sqljs', run(sql, values) { db.run(sql, values); }, exec(sql) { return db.exec(sql); },
    all(sql, values = []) { const statement = db.prepare(sql); try { statement.bind(values); const result: StorageRow[] = []; while (statement.step()) result.push(statement.getAsObject() as StorageRow); return result; } finally { statement.free(); } },
    export() { return db.export(); }, close() { db.close(); },
    backup() { throw new Error('Legacy snapshots must be persisted by their owning AppStore.'); },
  };
}

export function selectedStorageBackend(): StorageBackend {
  const selected = process.env.LAW_AGENT_STORAGE_BACKEND;
  if (selected === undefined || selected === 'rust') return 'rust';
  if (selected === 'sqljs') return 'sqljs';
  throw new Error('未知的业务库引擎配置。');
}

/** Keep a byte-identical, closed-file preimage without a whole-file RAM buffer. */
async function fileHash(path: string): Promise<string> { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }

export async function syncFile(path: string): Promise<void> { const handle = await open(path, 'r+'); try { await handle.sync(); } finally { await handle.close(); } }
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } catch (error) { if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  finally { await handle.close(); }
}

export async function retainClosedSnapshot(source: string, destination: string, requireSourceMatch = false): Promise<void> {
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); await chmod(destination, 0o600); await syncFile(destination); await syncDirectory(dirname(destination)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('保留的业务库备份不是普通文件，原数据库未改写。');
    let backup: StorageDatabase | undefined;
    try { backup = openNativeDatabase(destination, true); if (backup.exec('PRAGMA quick_check')[0]?.values[0]?.[0] !== 'ok' || Number(backup.exec('SELECT MAX(version) FROM schema_version')[0]?.values[0]?.[0] ?? 0) < 1) throw new Error('Invalid backup'); }
    catch (cause) { throw new Error('保留的业务库备份校验失败，原数据库未改写。', { cause }); }
    finally { backup?.close(); }
  }
  if (requireSourceMatch && await fileHash(source) !== await fileHash(destination)) throw new Error('首次启用原生存储时已有备份与当前业务库不一致，原数据库与备份均未改写。');
}

/** A process lease also covers the explicit legacy reference backend. SQLite
 * protects native transactions; this prevents current-version whole-file writers
 * from sharing a root. Older apps/tools must be closed before using this root. */
export async function acquireWorkspaceLease(dataDir: string): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true });
  dataDir = await realpath(dataDir);
  try {
    const lease = new (loadBinding().WorkspaceLease)(join(dataDir, '.workspace-writer.lock'));
    return async () => { lease.close(); };
  } catch (cause) { throw new Error('工作空间写入锁无法取得，可能已由另一个实例打开。请关闭其他实例后重试。', { cause }); }
}
