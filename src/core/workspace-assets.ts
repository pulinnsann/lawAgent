import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppStore } from './storage';

export interface WorkspaceAsset<T = any> {
  id: string; kind: string; revision: number; body: T; deleted: boolean;
  createdAt: string; updatedAt: string; actorLabel: string; contentSha256: string;
}
export interface SaveWorkspaceAsset {
  id?: string; kind: string; expectedRevision: number; body: any; actorLabel?: string; deleted?: boolean;
}
type Enqueue = <T>(operation: () => Promise<T>) => Promise<T>;
const identity = z.string().uuid();
const kindSchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u);
const assetPrefix = 'workspace_asset.';
type AssetRow = { entity_id: unknown; entity_type: unknown; detail_json: unknown };

function readAsset(row: AssetRow): WorkspaceAsset {
  const asset = JSON.parse(String(row.detail_json)) as WorkspaceAsset | null;
  if (!asset || typeof asset !== 'object' || Array.isArray(asset) || asset.id !== row.entity_id ||
      `${assetPrefix}${asset.kind}` !== row.entity_type || !Number.isSafeInteger(asset.revision) || asset.revision < 1 ||
      typeof asset.deleted !== 'boolean' || !asset.body || typeof asset.body !== 'object' || Array.isArray(asset.body)) {
    throw new Error('资源记录损坏，未使用旧版本替代；请恢复经过核验的备份。');
  }
  return asset;
}

// Choose row identities before fetching bodies. Old revisions remain in the
// append-only journal, but current reads never deserialize their content.
const latestRows = `SELECT entity_id,MIN(rowid) AS first_rowid,MAX(rowid) AS latest_rowid
  FROM audit_events WHERE workspace_id=? AND entity_type=? GROUP BY entity_id`;

/** Versioned workspace resources share the existing append-only audit journal.
 * All writes use the same commit queue as reviews, not a second file writer. */
export class WorkspaceAssets {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly enqueue: Enqueue;
  constructor(private readonly store: AppStore, enqueue?: Enqueue) {
    this.enqueue = enqueue ?? (operation => { const next = this.queue.then(operation, operation); this.queue = next.catch(() => {}); return next; });
  }
  list(kind: string, includeDeleted = false): WorkspaceAsset[] {
    kind = kindSchema.parse(kind);
    const rows = this.store.rows(`SELECT a.entity_id,a.entity_type,a.detail_json FROM (${latestRows}) current
      JOIN audit_events a ON a.rowid=current.latest_rowid ORDER BY current.first_rowid DESC`, [this.store.workspaceId, `${assetPrefix}${kind}`]);
    // Legacy Map order was reverse creation order, not most-recent-edit order.
    // Filter tombstones only after selecting the newest row to avoid revival.
    return rows.map(row => readAsset(row as AssetRow)).filter(asset => includeDeleted || !asset.deleted);
  }
  history(id: string): WorkspaceAsset[] {
    identity.parse(id);
    return this.store.rows("SELECT entity_id,entity_type,detail_json FROM audit_events WHERE workspace_id=? AND entity_id=? AND entity_type GLOB 'workspace_asset.*' ORDER BY rowid", [this.store.workspaceId, id]).map(row => readAsset(row as AssetRow));
  }
  private current(id: string): WorkspaceAsset | undefined {
    const row = this.store.rows("SELECT entity_id,entity_type,detail_json FROM audit_events WHERE workspace_id=? AND entity_id=? AND entity_type GLOB 'workspace_asset.*' ORDER BY rowid DESC LIMIT 1", [this.store.workspaceId, id])[0];
    return row ? readAsset(row as AssetRow) : undefined;
  }
  get(id: string): WorkspaceAsset {
    identity.parse(id);
    const current = this.current(id);
    if (!current) throw new Error('本工作空间中不存在该资源。');
    return current;
  }
  save(input: SaveWorkspaceAsset, beforeSave?: () => void): Promise<WorkspaceAsset> {
    input = structuredClone(input);
    return this.enqueue(async () => {
      // Run cross-resource identity/lifecycle checks on the same queue as
      // the actual commit, with no await between validation and the write.
      beforeSave?.();
      const kind = kindSchema.parse(input.kind);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('资源修订号无效。');
      const actorLabel = (input.actorLabel ?? '法务').trim();
      if (!actorLabel || actorLabel.length > 80 || /[\u0000-\u001f\u007f]/u.test(actorLabel)) throw new Error('记录人标签应为1–80字且不含控制字符。');
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) throw new Error('资源内容应为结构化对象。');
      const serialized = JSON.stringify(input.body);
      const limit = kind === 'report_export' ? 33 * 1024 * 1024 : 2 * 1024 * 1024;
      if (Buffer.byteLength(serialized) > limit) throw new Error(`单份资源内容超过${kind === 'report_export' ? 33 : 2} MiB，请缩小范围或拆分保存。`);
      if (kind === 'report_export' && (input.id || input.expectedRevision !== 0 || input.deleted)) throw new Error('报告导出快照只能新增，不能修改或移除。');
      const id = input.id ? identity.parse(input.id) : randomUUID();
      const current = input.id ? this.current(id) : undefined;
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new Error('资源记录已更新或不存在，请刷新后核对，未覆盖新记录。');
      if (current && current.kind !== kind) throw new Error('不能改变资源类型。');
      const versions = input.id ? Number(this.store.rows("SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id=? AND entity_id=? AND entity_type GLOB 'workspace_asset.*'", [this.store.workspaceId, id])[0].count) : 0;
      if (versions >= 1000) throw new Error('该资源历史已达到1000版上限，请新建资源。');
      if (!current) {
        const counts = this.store.rows(`SELECT SUM(CASE WHEN json_type(a.detail_json,'$.deleted')='false' THEN 1 ELSE 0 END) AS count,
          SUM(CASE WHEN json_type(a.detail_json,'$.deleted') IN ('true','false') THEN 0 ELSE 1 END) AS invalid
          FROM (${latestRows}) current JOIN audit_events a ON a.rowid=current.latest_rowid`, [this.store.workspaceId, `${assetPrefix}${kind}`])[0];
        if (Number(counts.invalid)) throw new Error('资源记录损坏，无法确认当前工作空间数量；请恢复经过核验的备份。');
        if (Number(counts.count) >= 10000) throw new Error('此类资源已达到当前工作空间上限。');
      }
      const stamp = new Date().toISOString();
      const asset: WorkspaceAsset = { id, kind, revision: input.expectedRevision + 1,
        body: JSON.parse(serialized), deleted: input.deleted ?? false, createdAt: current?.createdAt ?? stamp,
        updatedAt: stamp, actorLabel, contentSha256: createHash('sha256').update(serialized).digest('hex') };
      await this.store.transaction(() => {
        this.store.rows('INSERT INTO audit_events(id,workspace_id,entity_type,entity_id,action,actor_kind,actor_label,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          [randomUUID(), this.store.workspaceId, `workspace_asset.${kind}`, id, asset.deleted ? 'removed' : 'saved', 'user', actorLabel, JSON.stringify(asset), stamp]);
      });
      return asset;
    });
  }
}
