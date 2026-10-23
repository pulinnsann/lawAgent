import { lstatSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface KnowledgeSourceMetadata {
  sourceFileId: string;
  status: 'available' | 'missing' | 'stale' | 'unavailable';
  fileSha256: string | null; versionId: string | null;
  reason: string;
}
export interface KnowledgeSourceMetadataSnapshot {
  observedAt: string; complete: boolean; sources: Map<string, KnowledgeSourceMetadata>; limitations: string[];
}
const LIMIT = 10000;
/** Read only the existing local index's published metadata. Never create an
 * index, follow an external index symlink, read a source file or start a sync. */
export function readKnowledgeSourceMetadata(dataDir: string | undefined, sourceFileIds: string[]): KnowledgeSourceMetadataSnapshot {
  const identifiers = [...new Set(sourceFileIds)];
  const result: KnowledgeSourceMetadataSnapshot = { observedAt: new Date().toISOString(), complete: identifiers.length <= LIMIT, sources: new Map(), limitations: ['本地来源仅比较已发布索引的文件哈希和解析版本；未读取外部原件、扫描目录或自动更新索引。'] };
  if (!identifiers.length) return result;
  const unavailable = (reason: string) => {
    result.complete = false;
    result.limitations.push(reason);
    for (const sourceFileId of identifiers.slice(0, LIMIT)) result.sources.set(sourceFileId, { sourceFileId, status: 'unavailable', fileSha256: null, versionId: null, reason });
    return result;
  };
  if (!dataDir) return unavailable('本次未提供受管本地索引位置，当前知识来源版本未知。');
  if (identifiers.length > LIMIT) result.limitations.push('本次来源元数据比较超过10000项，剩余来源版本未知。');
  let database: DatabaseSync | null = null;
  try {
    const root = realpathSync(dataDir); const directory = join(root, 'local-knowledge'); const file = join(directory, 'index.sqlite');
    const folderStat = lstatSync(directory); const fileStat = lstatSync(file);
    if (folderStat.isSymbolicLink() || !folderStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile()) return unavailable('本地索引路径不是普通受管文件，当前来源版本未知。');
    const canonical = realpathSync(file); const delta = relative(root, canonical);
    if (!delta || isAbsolute(delta) || delta === '..' || delta.startsWith(`..${sep}`)) return unavailable('本地索引位于受管工作区外，当前来源版本未知。');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { const sidecar = lstatSync(`${file}${suffix}`); if (sidecar.isSymbolicLink() || !sidecar.isFile()) return unavailable('本地索引附属文件不是普通受管文件，当前来源版本未知。'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    database = new DatabaseSync(canonical, { readOnly: true, allowExtension: false });
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=100; BEGIN');
    const query = database.prepare('SELECT id,file_sha256,version_id,stale,stale_reason FROM source_files WHERE id=?');
    for (const sourceFileId of identifiers.slice(0, LIMIT)) {
      const row = query.get(sourceFileId);
      if (!row) result.sources.set(sourceFileId, { sourceFileId, status: 'missing', fileSha256: null, versionId: null, reason: '当前索引中没有此来源记录，可能已删除、清理或未索引；不能认定来源仍有效或已经无更新。' });
      else if (Number(row.stale) !== 0) result.sources.set(sourceFileId, { sourceFileId, status: 'stale', fileSha256: null, versionId: null, reason: '当前索引将来源标记为过期或不可用，须人工核对后同步；未把旧哈希当作当前版本。' });
      else if (!/^[a-f0-9]{64}$/u.test(String(row.file_sha256)) || !/^[a-f0-9]{64}$/u.test(String(row.version_id))) result.sources.set(sourceFileId, { sourceFileId, status: 'unavailable', fileSha256: null, versionId: null, reason: '当前索引来源版本元数据无效，不能完成比较。' });
      else result.sources.set(sourceFileId, { sourceFileId, status: 'available', fileSha256: String(row.file_sha256), versionId: String(row.version_id), reason: '已读取当前发布的本地索引元数据。' });
    }
    database.exec('COMMIT');
    return result;
  } catch { return unavailable('本地索引不存在、不可读取或暂时忙碌，当前来源版本未知；未新建或修改索引。'); }
  finally { try { database?.close(); } catch { /* An unreadable/closed index stays explicitly unknown. */ } }
}
