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
    const rows = this.store.rows('SELECT detail_json FROM audit_events WHERE workspace_id=? AND entity_type=? ORDER BY rowid', [this.store.workspaceId, `workspace_asset.${kind}`]);
    const latest = new Map<string, WorkspaceAsset>();
    for (const row of rows) { const asset = JSON.parse(String(row.detail_json)) as WorkspaceAsset; latest.set(asset.id, asset); }
    return [...latest.values()].filter(asset => includeDeleted || !asset.deleted).reverse();
  }
  history(id: string): WorkspaceAsset[] {
    identity.parse(id);
    return this.store.rows("SELECT detail_json FROM audit_events WHERE workspace_id=? AND entity_id=? AND entity_type LIKE 'workspace_asset.%' ORDER BY rowid", [this.store.workspaceId, id]).map(row => JSON.parse(String(row.detail_json)) as WorkspaceAsset);
  }
  get(id: string): WorkspaceAsset {
    const current = this.history(id).at(-1);
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
      const history = input.id ? this.history(id) : [];
      const current = history.at(-1);
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new Error('资源记录已更新或不存在，请刷新后核对，未覆盖新记录。');
      if (current && current.kind !== kind) throw new Error('不能改变资源类型。');
      if (history.length >= 1000) throw new Error('该资源历史已达到1000版上限，请新建资源。');
      if (!current && this.list(kind).length >= 10000) throw new Error('此类资源已达到当前工作空间上限。');
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
