import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { KnowledgeHit, KnowledgePort, KnowledgePreferences, KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeState, KnowledgeSyncJob, KnowledgeSyncMode } from '../shared/knowledge';
import type { EnvironmentReport } from '../shared/setup';

export interface KnowledgeWorkerClientOptions {
  /** Zero disables idle recycling; this is not an operation timeout. */
  idleTimeoutMs?: number;
}
interface PendingKnowledgeRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  progress?: (job: KnowledgeSyncJob) => void;
  done: Promise<void>;
  finish: () => void;
}
interface KnowledgeWorkerSession {
  worker: Worker;
  pending: Map<string, PendingKnowledgeRequest>;
  stopping: boolean;
  exited: Promise<void>;
  closeReply?: { id: string; resolve: () => void };
}

/** Keeps parsing and synchronous disk-index work outside the review worker. */
export class KnowledgeWorkerClient implements KnowledgePort {
  private session: KnowledgeWorkerSession | null = null;
  private closing = false;
  private closed: Promise<void> | null = null;
  private retiring: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutMs: number;
  private failure: Error | null = null;
  constructor(private dataDir: string, private entry: URL, private shutdownTimeoutMs = 10_000, options: KnowledgeWorkerClientOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs < 0 || this.idleTimeoutMs > 2_147_483_647) throw new Error('Knowledge idle timeout must be between 0 and 2147483647 milliseconds.');
  }
  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
  private scheduleIdle(session: KnowledgeWorkerSession): void {
    this.clearIdleTimer();
    if (!this.idleTimeoutMs || this.closing || this.failure || this.retiring || this.session !== session || session.pending.size) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.closing || this.failure || this.session !== session || session.pending.size) return;
      // Only an idle worker is recycled. Its close acknowledgement and actual
      // termination both finish before a later request can open the index again.
      void this.retire(session).catch(() => { this.failure ??= new Error('本地知识库进程未能关闭，请重启应用后恢复索引任务。'); });
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }
  private ensureWorker(): KnowledgeWorkerSession {
    if (this.session) return this.session;
    const worker = new Worker(this.entry, { workerData: { dataDir: this.dataDir }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    let finishExit!: () => void;
    const session: KnowledgeWorkerSession = { worker, pending: new Map(), stopping: false, exited: new Promise<void>(resolve => { finishExit = resolve; }) };
    this.session = session;
    worker.on('message', message => {
      if (this.session !== session || !message || typeof message !== 'object') return;
      const closeReply = session.closeReply;
      if (closeReply && closeReply.id === message.id) { closeReply.resolve(); return; }
      const request = session.pending.get(message.id);
      if (!request) return;
      if (message.type === 'progress') { request.progress?.(message.job); return; }
      session.pending.delete(message.id);
      request.finish();
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.data);
      this.scheduleIdle(session);
    });
    const fail = (exited: boolean) => {
      if (this.session !== session || session.stopping) return;
      this.clearIdleTimer();
      this.failure = new Error('本地知识库进程已停止，请重启应用后恢复索引任务。');
      for (const request of session.pending.values()) {
        request.reject(this.failure);
        if (exited) request.finish();
      }
      // An error event rejects callers immediately; the subsequent real exit
      // is the cleanup barrier for resource leases and cancelled search drains.
      if (exited) session.pending.clear();
    };
    worker.on('error', () => fail(false));
    worker.on('exit', () => { finishExit(); fail(true); });
    return session;
  }
  private async waitForRetirement(retiring: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return retiring;
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('知识库操作已取消。');
    let cancel!: () => void;
    try {
      await Promise.race([retiring, new Promise<never>((_resolve, reject) => {
        cancel = () => reject(signal.reason instanceof Error ? signal.reason : new Error('知识库操作已取消。'));
        signal.addEventListener('abort', cancel, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', cancel); }
  }
  private async request<T>(command: string, payload?: unknown, signal?: AbortSignal, progress?: (job: KnowledgeSyncJob) => void): Promise<T> {
    if (this.closing) throw new Error('知识库正在关闭。');
    if (this.failure) throw this.failure;
    this.clearIdleTimer();
    while (this.retiring) await this.waitForRetirement(this.retiring, signal);
    if (this.closing) throw new Error('知识库正在关闭。');
    if (this.failure) throw this.failure;
    if (signal?.aborted && command === 'search') throw signal.reason instanceof Error ? signal.reason : new Error('知识库检索已取消。');
    const session = this.ensureWorker();
    const worker = session.worker;
    const id = randomUUID();
    const cancel = () => {
      worker.postMessage({ command: 'cancel', id });
      if (command === 'search') {
        session.pending.get(id)?.reject(signal?.reason instanceof Error ? signal.reason : new Error('知识库检索已取消。'));
        // Caller cancellation is not a worker-cleanup acknowledgement. Keep
        // the drain entry until the final response, exit or termination barrier.
      }
    };
    const result = new Promise<T>((resolve, reject) => {
      let finish!: () => void;
      const done = new Promise<void>(complete => { finish = complete; });
      session.pending.set(id, { resolve, reject, progress, done, finish });
      try { worker.postMessage({ id, command, payload }); }
      catch (error) { session.pending.delete(id); finish(); this.scheduleIdle(session); reject(error); return; }
      if (signal) { signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); }
    });
    return result.finally(() => signal?.removeEventListener('abort', cancel));
  }
  checkEnvironment(): Promise<EnvironmentReport> { return this.request('checkEnvironment'); }
  getState(folderPath: string | null, preferences?: KnowledgePreferences): Promise<KnowledgeState> { return this.request('getState', { folderPath, preferences }); }
  syncFolder(input: { folderPath: string; jobId: string; mode: KnowledgeSyncMode; preferences?: KnowledgePreferences }, signal: AbortSignal, onProgress?: (job: KnowledgeSyncJob) => void): Promise<KnowledgeSyncJob> { return this.request('syncFolder', input, signal, onProgress); }
  search(input: KnowledgeSearchInput & { folderPath: string }, signal?: AbortSignal): Promise<KnowledgeSearchResult> { return this.request('search', input, signal); }
  readChunk(input: { folderPath: string; chunkId: string; preferences?: KnowledgePreferences }): Promise<KnowledgeHit> { return this.request('readChunk', input); }
  waitForIdle(): Promise<void> {
    // Snapshot only the work admitted before this call. Periodic state reads
    // arriving later must not keep a completed resource lease alive forever.
    const pending = this.session ? [...this.session.pending.values()].map(request => request.done) : [];
    if (this.retiring) pending.push(this.retiring);
    return Promise.all(pending).then(() => {});
  }
  private retire(session: KnowledgeWorkerSession): Promise<void> {
    if (this.retiring) return this.retiring;
    this.clearIdleTimer();
    session.stopping = true;
    const retiring = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!this.failure) {
          const acknowledgement = new Promise<void>(resolve => { session.closeReply = { id: randomUUID(), resolve }; });
          session.worker.postMessage({ id: session.closeReply!.id, command: 'close' });
          await Promise.race([acknowledgement, session.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, this.shutdownTimeoutMs); })]);
        }
      } finally {
        if (timer) clearTimeout(timer);
        // The bounded grace first asks the worker to close its persisted index.
        // Always await actual thread termination before exposing a new worker;
        // a timed-out parser must not overlap another owner of the same index.
        await session.worker.terminate();
        const error = new Error('知识库正在关闭，未完成的索引任务将在重新启动后恢复。');
        for (const request of session.pending.values()) { request.reject(error); request.finish(); }
        session.pending.clear();
        session.closeReply = undefined;
        if (this.session === session) this.session = null;
      }
    })().finally(() => { if (this.retiring === retiring) this.retiring = null; });
    this.retiring = retiring;
    return retiring;
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.clearIdleTimer();
    // An unused client never opens a worker merely to close itself. A recycle
    // already in progress is the same real cleanup barrier as permanent close.
    return this.closed = this.retiring ?? (this.session ? this.retire(this.session) : Promise.resolve());
  }
}
