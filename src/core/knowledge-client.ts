import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { KnowledgeHit, KnowledgePort, KnowledgePreferences, KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeState, KnowledgeSyncJob, KnowledgeSyncMode } from '../shared/knowledge';
import type { EnvironmentReport } from '../shared/setup';

/** Keeps parsing and synchronous disk-index work outside the review worker. */
export class KnowledgeWorkerClient implements KnowledgePort {
  private worker: Worker | null = null;
  private closing = false;
  private closed: Promise<void> | null = null;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; progress?: (job: KnowledgeSyncJob) => void }>();
  private failure: Error | null = null;
  constructor(private dataDir: string, private entry: URL, private shutdownTimeoutMs = 10_000) {}
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.entry, { workerData: { dataDir: this.dataDir }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    this.worker = worker;
    worker.on('message', message => {
      const request = this.pending.get(message.id);
      if (!request) return;
      if (message.type === 'progress') { request.progress?.(message.job); return; }
      this.pending.delete(message.id);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.data);
    });
    const fail = () => {
      this.failure = new Error('本地知识库进程已停止，请重启应用后恢复索引任务。');
      for (const request of this.pending.values()) request.reject(this.failure);
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', () => { if (!this.closing || this.pending.size) fail(); });
    return worker;
  }
  private request<T>(command: string, payload?: unknown, signal?: AbortSignal, progress?: (job: KnowledgeSyncJob) => void): Promise<T> {
    if (this.closing && command !== 'close') return Promise.reject(new Error('知识库正在关闭。'));
    if (this.failure) return Promise.reject(this.failure);
    let worker: Worker;
    try { worker = this.ensureWorker(); } catch (error) { return Promise.reject(error); }
    const id = randomUUID();
    const cancel = () => {
      worker.postMessage({ command: 'cancel', id });
      if (command === 'search') {
        this.pending.get(id)?.reject(signal?.reason instanceof Error ? signal.reason : new Error('知识库检索已取消。'));
        this.pending.delete(id);
      }
    };
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      worker.postMessage({ id, command, payload });
      if (signal) { signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); }
    });
    return result.finally(() => signal?.removeEventListener('abort', cancel));
  }
  checkEnvironment(): Promise<EnvironmentReport> { return this.request('checkEnvironment'); }
  getState(folderPath: string | null, preferences?: KnowledgePreferences): Promise<KnowledgeState> { return this.request('getState', { folderPath, preferences }); }
  syncFolder(input: { folderPath: string; jobId: string; mode: KnowledgeSyncMode; preferences?: KnowledgePreferences }, signal: AbortSignal, onProgress?: (job: KnowledgeSyncJob) => void): Promise<KnowledgeSyncJob> { return this.request('syncFolder', input, signal, onProgress); }
  search(input: KnowledgeSearchInput & { folderPath: string }, signal?: AbortSignal): Promise<KnowledgeSearchResult> { return this.request('search', input, signal); }
  readChunk(input: { folderPath: string; chunkId: string; preferences?: KnowledgePreferences }): Promise<KnowledgeHit> { return this.request('readChunk', input); }
  close(): Promise<void> {
    return this.closed ??= (async () => {
      this.closing = true;
      // An unused index never needs a worker merely to shut the app down.
      if (!this.worker) return;
      const worker = this.worker;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!this.failure) await Promise.race([this.request('close'),new Promise<void>(resolve=>{timer=setTimeout(resolve,this.shutdownTimeoutMs);})]);
      } finally {
        if(timer)clearTimeout(timer);
        // The index is rebuildable and source files are read-only. A parser
        // which cannot cooperate must not keep the application alive forever.
        // SQLite recovers unfinished index transactions on the next opening.
        const error=new Error('知识库正在关闭，未完成的索引任务将在重新启动后恢复。');
        for(const request of this.pending.values())request.reject(error);this.pending.clear();
        await worker.terminate(); this.worker = null;
      }
    })();
  }
}
