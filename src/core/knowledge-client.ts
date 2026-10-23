import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { KnowledgeHit, KnowledgePort, KnowledgePreferences, KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeState, KnowledgeSyncJob, KnowledgeSyncMode } from '../shared/knowledge';
import type { EnvironmentReport } from '../shared/setup';

/** Keeps parsing and synchronous disk-index work outside the review worker. */
export class KnowledgeWorkerClient implements KnowledgePort {
  private worker: Worker;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; progress?: (job: KnowledgeSyncJob) => void }>();
  private failure: Error | null = null;
  constructor(dataDir: string, entry: URL) {
    this.worker = new Worker(entry, { workerData: { dataDir }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    this.worker.on('message', message => {
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
    this.worker.on('error', fail);
    this.worker.on('exit', code => { if (code !== 0 || this.pending.size) fail(); });
  }
  private request<T>(command: string, payload?: unknown, signal?: AbortSignal, progress?: (job: KnowledgeSyncJob) => void): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = randomUUID();
    const cancel = () => {
      this.worker.postMessage({ command: 'cancel', id });
      if (command === 'search') {
        this.pending.get(id)?.reject(signal?.reason instanceof Error ? signal.reason : new Error('知识库检索已取消。'));
        this.pending.delete(id);
      }
    };
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      this.worker.postMessage({ id, command, payload });
      if (signal) { signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); }
    });
    return result.finally(() => signal?.removeEventListener('abort', cancel));
  }
  checkEnvironment(): Promise<EnvironmentReport> { return this.request('checkEnvironment'); }
  getState(folderPath: string | null, preferences?: KnowledgePreferences): Promise<KnowledgeState> { return this.request('getState', { folderPath, preferences }); }
  syncFolder(input: { folderPath: string; jobId: string; mode: KnowledgeSyncMode; preferences?: KnowledgePreferences }, signal: AbortSignal, onProgress?: (job: KnowledgeSyncJob) => void): Promise<KnowledgeSyncJob> { return this.request('syncFolder', input, signal, onProgress); }
  search(input: KnowledgeSearchInput & { folderPath: string }, signal?: AbortSignal): Promise<KnowledgeSearchResult> { return this.request('search', input, signal); }
  readChunk(input: { folderPath: string; chunkId: string; preferences?: KnowledgePreferences }): Promise<KnowledgeHit> { return this.request('readChunk', input); }
  async close(): Promise<void> {
    try { if (!this.failure) await this.request('close'); }
    finally { await this.worker.terminate(); }
  }
}
