import { createHash } from 'node:crypto';
import { createDocxEditableCopy, inspectDocxEditState, inspectDocxTargets, type DocxEditableTarget, type DocxEditProtection } from './docx-patcher';
import { readManagedDocumentSource, verifyManagedDocumentSource, type ManagedDocumentArtifact } from './managed-document-source';

type Segment = NonNullable<DocxEditableTarget['segments']>[number];
export type CompactDocxTarget = Omit<DocxEditableTarget, 'text' | 'segments'> & {
  textSha256: string;
  segments?: Array<Omit<Segment, 'text'> & { textSha256: string }>;
};
export interface DocxChangeInspection {
  protection: DocxEditProtection;
  targets: CompactDocxTarget[];
  warnings: string[];
}
interface Source { documentId: string; artifact: ManagedDocumentArtifact; editableCopy: boolean }
export const changeTextSha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function inspectBytes(bytes: Buffer, editableCopy: boolean): Promise<DocxChangeInspection> {
  const original = await inspectDocxEditState(bytes);
  const working = editableCopy ? await createDocxEditableCopy(bytes) : null;
  const targets = working ? await inspectDocxTargets(working.bytes) : original.targets;
  return {
    protection: original.protection, warnings: working?.warnings ?? [],
    targets: targets.map(({ text, segments, ...target }) => ({ ...target, textSha256: changeTextSha256(text),
      ...(segments ? { segments: segments.map(({ text: segmentText, ...segment }) => ({ ...segment, textSha256: changeTextSha256(segmentText) })) } : {}),
    })),
  };
}

/** One short-lived metadata entry, never a source Buffer, XML tree or ZIP.
 * Every hit still hashes the actual managed file through bounded reads. */
export class DocxChangeInspector {
  private cached: { key: string; value: DocxChangeInspection; bytes: number; expiresAt: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lane: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private builds = 0;
  private reads = 0;
  private verifications = 0;
  private readonly maxMetadataBytes: number;
  private readonly idleMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly build: typeof inspectBytes;
  constructor(private readonly dataDir: string, options: { maxMetadataBytes?: number; idleMs?: number; maxPending?: number; now?: () => number; inspectBytes?: typeof inspectBytes } = {}) {
    this.maxMetadataBytes = options.maxMetadataBytes ?? 1024 * 1024;
    this.idleMs = options.idleMs ?? 30_000;
    this.maxPending = options.maxPending ?? 32;
    if (!Number.isSafeInteger(this.maxMetadataBytes) || this.maxMetadataBytes < 0 || this.maxMetadataBytes > 4 * 1024 * 1024 || !Number.isSafeInteger(this.idleMs) || this.idleMs < 1 || this.idleMs > 300_000 || !Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 256) throw new Error('修改原文检查的资源配置无效。');
    this.now = options.now ?? Date.now; this.build = options.inspectBytes ?? inspectBytes;
  }
  stats() { return { cachedEntries: this.cached ? 1 : 0, metadataBytes: this.cached?.bytes ?? 0, maxMetadataBytes: this.maxMetadataBytes, pending: this.pending, builds: this.builds, sourceReads: this.reads, sourceVerifications: this.verifications, closed: this.closed }; }
  private clear(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; this.cached = null; }
  private touch(): void {
    if (!this.cached) return;
    if (this.timer) clearTimeout(this.timer);
    this.cached.expiresAt = this.now() + this.idleMs;
    this.timer = setTimeout(() => this.clear(), this.idleMs); this.timer.unref();
  }
  inspect(input: Source): Promise<DocxChangeInspection> {
    if (this.closed) return Promise.reject(new Error('应用正在关闭，无法检查修改原文。'));
    if (this.pending >= this.maxPending) return Promise.reject(new Error('修改原文检查队列已满，请稍后重试。'));
    const source = structuredClone(input);
    const key = JSON.stringify(['docx-change-inspection-1', source.documentId, source.artifact.artifactUri, source.artifact.sha256, source.artifact.byteSize, source.editableCopy]);
    this.pending++;
    const done = this.lane.then(async () => {
      if (this.closed) throw new Error('应用正在关闭，无法检查修改原文。');
      if (this.cached && this.cached.expiresAt <= this.now()) this.clear();
      if (this.cached?.key === key) {
        const value = this.cached.value;
        try { this.verifications++; await verifyManagedDocumentSource(this.dataDir, source.artifact); }
        catch (error) { this.clear(); throw error; }
        if (this.closed) throw new Error('应用正在关闭，无法检查修改原文。');
        this.touch(); return structuredClone(value);
      }
      // Replace, rather than accumulate, inspection metadata across documents
      // and protected/unprotected modes. A rejected load retains no old entry.
      this.clear(); this.reads++;
      const bytes = await readManagedDocumentSource(this.dataDir, source.artifact);
      if (this.closed) throw new Error('应用正在关闭，无法检查修改原文。');
      this.builds++; const value = await this.build(bytes, source.editableCopy);
      if (this.closed) throw new Error('应用正在关闭，无法检查修改原文。');
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size <= this.maxMetadataBytes) { this.cached = { key, value, bytes: size, expiresAt: this.now() + this.idleMs }; this.touch(); }
      return structuredClone(value);
    });
    const cleanup = () => { this.pending--; };
    this.lane = done.then(cleanup, cleanup);
    return done;
  }
  /** Already-running reads/parses finish before the store is closed. Queued
   * inspections reject; neither branch publishes a result after close. */
  async close(): Promise<void> { this.closed = true; this.clear(); await this.lane; }
}
