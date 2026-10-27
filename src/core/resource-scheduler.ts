import { randomUUID } from 'node:crypto';
import type { ResourceKind, ResourceOperation, ResourcePressure, ResourcePressureLevel, ResourceSnapshot, ResourceTask, ResourceWaitReason } from '../shared/resources';

export interface ResourceRequest {
  /** Opaque task identity only. Document names and file paths are not accepted. */
  id?: string;
  kind: ResourceKind;
  operation: ResourceOperation;
  signal?: AbortSignal;
  /** Cooperative cancellation for an active background index. Releasing its
   * lease remains the caller's responsibility after actual cleanup. */
  cancelActive?: () => void | Promise<void>;
}
export interface ResourceLease {
  readonly id: string;
  readonly kind: ResourceKind;
  release(): void;
  dispose(): void;
}
export class ResourceAdmissionError extends Error {
  constructor(public readonly code: 'RESOURCE_CLOSED' | 'RESOURCE_QUEUE_FULL' | 'RESOURCE_DUPLICATE' | 'RESOURCE_INVALID', message: string) {
    super(message); this.name = 'ResourceAdmissionError';
  }
}
interface Pending extends Required<Pick<ResourceRequest, 'id' | 'kind' | 'operation'>> {
  signal?: AbortSignal; cancelActive?: () => void | Promise<void>; sequence: number; queuedAt: string;
  resolve: (lease: ResourceLease) => void; reject: (error: Error) => void; abort: () => void;
}
interface Active { request: Pending; task: ResourceTask }
const priorities: Record<ResourceKind, number> = { model: 3, heavy: 2, index: 1 };
const operations = new Set<ResourceOperation>(['contract_review', 'local_review', 'contract_generation', 'contract_change', 'reference_translation', 'report_translation', 'clause_alignment', 'model_probe', 'connection_test', 'knowledge_index', 'knowledge_search', 'document_import', 'document_conversion', 'report_render', 'document_export', 'native_pdf', 'maintenance']);
const pressureLevels = new Set<ResourcePressureLevel>(['normal', 'warning', 'critical', 'unknown']);
const pressureSources = new Set<ResourcePressure['source']>(['macos', 'windows', 'unavailable', 'test']);
const abortError = () => new DOMException('任务已取消，未开始新的资源操作。', 'AbortError');

/** One lease spans real buffers, workers and I/O, not merely request dispatch.
 * Cancellation never fabricates resource release. Callers must release in a
 * finally block after their operation and owned cleanup actually complete. */
export class ResourceScheduler {
  private readonly maxQueue: number;
  private readonly pressureTtlMs: number;
  private readonly now: () => number;
  private readonly onChange?: () => void;
  private queue: Pending[] = [];
  private active: Active | null = null;
  private closed = false;
  private sequence = 0;
  private pressure: ResourcePressure;
  private pressureTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: { maxQueue?: number; pressureTtlMs?: number; now?: () => number; onChange?: () => void } = {}) {
    this.maxQueue = options.maxQueue ?? 32;
    this.pressureTtlMs = options.pressureTtlMs ?? 30_000;
    if (!Number.isSafeInteger(this.maxQueue) || this.maxQueue < 1 || this.maxQueue > 256 || !Number.isFinite(this.pressureTtlMs) || this.pressureTtlMs < 1 || this.pressureTtlMs > 300_000) throw new ResourceAdmissionError('RESOURCE_INVALID', '资源调度预算无效。');
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
    this.pressure = { level: 'unknown', source: 'unavailable', observedAt: this.stamp(), availableBytes: null, totalBytes: null };
  }
  private stamp(): string { return new Date(this.now()).toISOString(); }
  private changed(): void { try { this.onChange?.(); } catch { /* UI observers cannot break owned cleanup or admission. */ } }
  private effectivePressure(): { level: ResourcePressureLevel; stale: boolean } {
    const age = this.now() - Date.parse(this.pressure.observedAt);
    const stale = age > this.pressureTtlMs || age < -1000;
    return { level: stale ? 'unknown' : this.pressure.level, stale };
  }
  private allowed(kind: ResourceKind): boolean {
    const level = this.effectivePressure().level;
    // Keep network/model work available on small office PCs, while avoiding
    // additional document/OCR/PDF allocations when OS pressure is elevated.
    return level !== 'critical' && !(level === 'warning' && kind !== 'model');
  }
  private reason(request: Pending): ResourceWaitReason {
    const pressure = this.effectivePressure().level;
    if (pressure === 'critical') return 'memory_critical';
    if (pressure === 'warning' && request.kind !== 'model') return 'memory_warning';
    if (this.active?.task.kind === 'index' && this.active.task.cancellationRequested) return 'index_cleanup';
    return this.active ? 'active_task' : 'priority';
  }
  snapshot(): ResourceSnapshot {
    const effective = this.effectivePressure();
    return {
      policy: 'serial-model-priority', closed: this.closed,
      active: this.active ? { ...this.active.task } : null,
      queued: [...this.queue].sort((a, b) => priorities[b.kind] - priorities[a.kind] || a.sequence - b.sequence).map(request => ({ id: request.id, kind: request.kind, operation: request.operation, queuedAt: request.queuedAt, waitReason: this.reason(request) })),
      maxQueue: this.maxQueue, pressure: { ...this.pressure, effectiveLevel: effective.level, stale: effective.stale },
      limitations: ['仅串行管理已接入的应用任务，不是应用 RSS、系统内存或客户模型显存的硬性上限。', '运行中的任务只有在实际清理并释放租约后才让出资源；未知或过期的压力信息按保守串行策略继续。'],
    };
  }
  updatePressure(sample: ResourcePressure): void {
    if (!sample || !pressureLevels.has(sample.level) || !pressureSources.has(sample.source) || typeof sample.observedAt !== 'string' || !Number.isFinite(Date.parse(sample.observedAt))) throw new ResourceAdmissionError('RESOURCE_INVALID', '系统内存压力记录无效。');
    for (const value of [sample.availableBytes, sample.totalBytes]) if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new ResourceAdmissionError('RESOURCE_INVALID', '系统内存容量记录无效。');
    if (sample.availableBytes != null && sample.totalBytes != null && sample.availableBytes > sample.totalBytes) throw new ResourceAdmissionError('RESOURCE_INVALID', '系统内存容量记录无效。');
    this.pressure = { level: sample.level, observedAt: new Date(Date.parse(sample.observedAt)).toISOString(), source: sample.source, availableBytes: sample.availableBytes ?? null, totalBytes: sample.totalBytes ?? null };
    if (this.pressureTimer) clearTimeout(this.pressureTimer);
    this.pressureTimer = null;
    if (!this.closed && !this.effectivePressure().stale && ['warning', 'critical'].includes(sample.level)) {
      const remaining = Math.max(1, Date.parse(this.pressure.observedAt) + this.pressureTtlMs - this.now() + 1);
      this.pressureTimer = setTimeout(() => { this.pressureTimer = null; this.drain(); this.changed(); }, remaining);
      this.pressureTimer.unref();
    }
    this.drain(); this.changed();
  }
  acquire(input: ResourceRequest): Promise<ResourceLease> {
    if (this.closed) return Promise.reject(new ResourceAdmissionError('RESOURCE_CLOSED', '应用正在关闭，未开始新的资源任务。'));
    const id = input.id ?? randomUUID();
    if (!Object.hasOwn(priorities, input.kind) || !operations.has(input.operation) || typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/u.test(id)) return Promise.reject(new ResourceAdmissionError('RESOURCE_INVALID', '资源任务类型或标识无效。'));
    if (input.signal?.aborted) return Promise.reject(abortError());
    if (this.active?.request.id === id || this.queue.some(item => item.id === id)) return Promise.reject(new ResourceAdmissionError('RESOURCE_DUPLICATE', '该资源任务已经运行或排队。'));
    if (this.queue.length >= this.maxQueue) return Promise.reject(new ResourceAdmissionError('RESOURCE_QUEUE_FULL', '等待的资源任务过多，请取消或等待已有任务。'));
    return new Promise<ResourceLease>((resolve, reject) => {
      const request: Pending = { id, kind: input.kind, operation: input.operation, signal: input.signal, cancelActive: input.cancelActive, sequence: this.sequence++, queuedAt: this.stamp(), resolve, reject, abort: () => {
        const index = this.queue.indexOf(request);
        if (index < 0) return;
        this.queue.splice(index, 1); request.signal?.removeEventListener('abort', request.abort); reject(abortError()); this.drain(); this.changed();
      } };
      this.queue.push(request); request.signal?.addEventListener('abort', request.abort, { once: true });
      if (request.signal?.aborted) { request.abort(); return; }
      if (request.kind !== 'index' && this.active?.task.kind === 'index' && !this.active.task.cancellationRequested) {
        this.active.task.cancellationRequested = true;
        try { void Promise.resolve(this.active.request.cancelActive?.()).catch(() => {}); } catch { /* Keep the lease until actual owner cleanup. */ }
      }
      this.drain(); this.changed();
    });
  }
  async run<T>(input: ResourceRequest, operation: () => Promise<T> | T): Promise<T> {
    const lease = await this.acquire(input);
    try {
      // A cancellation can arrive after admission resolves but before the
      // awaiting caller resumes. Do not allocate new work in that interval.
      if (input.signal?.aborted) throw abortError();
      return await operation();
    } finally { lease.release(); }
  }
  private drain(): void {
    if (this.closed || this.active) return;
    this.queue.sort((a, b) => priorities[b.kind] - priorities[a.kind] || a.sequence - b.sequence);
    const index = this.queue.findIndex(request => this.allowed(request.kind));
    if (index < 0) return;
    const request = this.queue.splice(index, 1)[0];
    request.signal?.removeEventListener('abort', request.abort);
    if (request.signal?.aborted) { request.reject(abortError()); this.drain(); return; }
    const active: Active = { request, task: { id: request.id, kind: request.kind, operation: request.operation, queuedAt: request.queuedAt, startedAt: this.stamp(), cancellationRequested: false } };
    this.active = active;
    let released = false;
    const release = () => {
      if (released) return; released = true;
      if (this.active === active) this.active = null;
      this.drain(); this.changed();
    };
    request.resolve({ id: request.id, kind: request.kind, release, dispose: release });
  }
  /** Callers cancel their owned operations before closing. Active resources
   * remain visible until those operations actually run their finally cleanup. */
  close(): void {
    if (this.closed) return; this.closed = true;
    if (this.pressureTimer) clearTimeout(this.pressureTimer); this.pressureTimer = null;
    for (const request of this.queue.splice(0)) { request.signal?.removeEventListener('abort', request.abort); request.reject(new ResourceAdmissionError('RESOURCE_CLOSED', '应用正在关闭，已取消排队的资源任务。')); }
    this.changed();
  }
}
