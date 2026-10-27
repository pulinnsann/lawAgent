import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { defaultRetrievalConfig } from '../src/shared/contracts';
import { defaultKnowledgePreferences } from '../src/shared/knowledge-preferences';
import type { ReviewTask } from '../src/shared/contracts';
import type { KnowledgePort, KnowledgeState, KnowledgeSyncJob } from '../src/shared/knowledge';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic priority test timed out')), 3000); })]); } finally { clearTimeout(timer); } }
const until = (read:()=>boolean) => within((async()=>{while(!read())await new Promise<void>(resolve=>setImmediate(resolve));})());
class ControlledKnowledge implements KnowledgePort {
  signals: AbortSignal[] = []; stopped = true; private finish: (() => void) | null = null;
  async getState(folderPath: string | null): Promise<KnowledgeState> { return { folderPath, engine: 'sqlite-fts5', tokenizerVersion: 'synthetic', indexedFiles: 0, chunks: 0, staleFiles: 0, lastSyncedAt: null, job: null, limitations: [] }; }
  async syncFolder(input: Parameters<KnowledgePort['syncFolder']>[0], signal: AbortSignal): Promise<KnowledgeSyncJob> {
    this.signals.push(signal); this.stopped = false;
    const done = deferred<void>(); this.finish = () => done.resolve(); await done.promise; this.stopped = true;
    return { id: input.jobId, folderPath: input.folderPath, status: signal.aborted ? 'cancelled' : 'completed', phase: 'synthetic', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), scanned: 0, indexed: 0, unchanged: 0, deleted: 0, skipped: 0, failed: 0, fullScan: true, errors: [] };
  }
  release() { this.finish?.(); this.finish = null; }
  async search(input: Parameters<KnowledgePort['search']>[0]) { return { query: input.query, expandedTerms: [], hits: [], state: await this.getState(input.folderPath), elapsedMs: 0 }; }
  async readChunk(): Promise<never> { throw new Error('No synthetic chunks'); }
  async close() { this.release(); }
}
const context = { contractType: 'service' as const, ourPartyRole: 'service_recipient' as const, businessContext: 'Synthetic scheduling test', strictness: 'balanced' as const };
async function fixture(run: (deps: { service: ContractService; store: AppStore; knowledge: ControlledKnowledge; documentId: string; terminal: ReturnType<typeof deferred<ReviewTask>> }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'law-model-index-priority-')); let service: ContractService | undefined; const originalFetch = globalThis.fetch;
  const knowledge = new ControlledKnowledge();
  try {
    const store = await AppStore.open(dir); const terminal = deferred<ReviewTask>();
    service = new ContractService(store, dir, task => { if (['completed', 'cancelled', 'failed'].includes(task.status)) terminal.resolve(task); }, knowledge);
    const document = await service.loadSample();
    await service.saveConfig({ name: 'Synthetic model', baseUrl: 'https://model.example.invalid/v1', model: 'synthetic', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 2048, contextWindowTokens: 65536, timeoutSeconds: 2 });
    const config = defaultRetrievalConfig(); config.knowledge = { ...config.knowledge, enabled: true, folderPath: join(dir, 'synthetic-folder'), preferences: { ...defaultKnowledgePreferences(), autoSyncEnabled: false } }; await service.saveRetrievalConfig(config);
    await run({ service, store, knowledge, documentId: document.id, terminal });
  } finally { knowledge.release(); await service?.close(); globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); }
}
const response = (init: RequestInit | undefined) => {
  const request = JSON.parse(String(init?.body)); const data = JSON.parse(request.messages[1].content);
  return new Response(JSON.stringify({ model: 'synthetic', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'Synthetic response', findings: [], reviewedBlockIds: data.contractBlocks.map((block: { id: string }) => block.id) }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
};

test('model review cancels indexing and awaits actual worker cleanup before any model request', async () => fixture(async ({ service, knowledge, documentId, terminal }) => {
  let calls = 0; globalThis.fetch = async (_url, init) => { calls++; assert.equal(knowledge.stopped, true); return response(init); };
  await service.startKnowledgeSync(); await until(()=>knowledge.signals.length===1); const starting = service.startReview({ documentId, context, mode: 'model' }, null);
  await until(()=>knowledge.signals[0].aborted);
  assert.equal(knowledge.signals[0].aborted, true); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(calls, 0); assert.equal(knowledge.stopped, false);
  await assert.rejects(service.startKnowledgeSync(), /模型审核.*暂缓/);
  knowledge.release(); await within(starting); const completed = await within(terminal.promise); assert.equal(completed.status, 'completed', completed.error ?? ''); assert.equal(calls, 1);
}));

test('manual indexing is deferred throughout an active model request and available again after cancellation', async () => fixture(async ({ service, knowledge, documentId, terminal }) => {
  const requested = deferred<void>(); globalThis.fetch = async (_url, init) => { requested.resolve(); return new Promise<Response>((_resolve, reject) => { const signal = init?.signal; if (signal?.aborted) reject(new DOMException('Cancelled', 'AbortError')); else signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }); }); };
  const { taskId } = await service.startReview({ documentId, context, mode: 'model' }, null); await within(requested.promise);
  await assert.rejects(service.startKnowledgeSync(), /模型审核.*暂缓/); assert.equal(knowledge.signals.length, 0);
  await service.cancelReview(taskId); assert.equal((await within(terminal.promise)).status, 'cancelled');
  await service.startKnowledgeSync();
  // Admission is asynchronous: terminal publication may precede the actual
  // worker-drain barrier. The index queues, then starts after that barrier.
  for(let n=0;n<200&&knowledge.signals.length===0;n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(knowledge.signals.length, 1); knowledge.release();
}));

test('knowledge scope changes while a model waits for cleanup cancel the pending run before a model call', async () => fixture(async ({ service, knowledge, documentId, terminal }) => {
  let calls = 0; globalThis.fetch = async (_url, init) => { calls++; return response(init); };
  await service.startKnowledgeSync(); await until(()=>knowledge.signals.length===1); const starting = service.startReview({ documentId, context, mode: 'model' }, null);
  const config = service.getState().retrievalConfig!; await service.saveRetrievalConfig({ ...config, knowledge: { ...config.knowledge, enabled: false } });
  knowledge.release(); await within(starting); assert.equal((await within(terminal.promise)).status, 'cancelled'); assert.equal(calls, 0);
}));

test('closing a model start waits for index cleanup and cancels the persisted run without a model call', async () => fixture(async ({ service, knowledge, documentId, terminal }) => {
  let calls = 0; globalThis.fetch = async (_url, init) => { calls++; return response(init); };
  const indexClose = deferred<void>();
  // The production client now requests worker cleanup before awaiting the sync.
  // Keep both completion boundaries controlled instead of letting the default
  // double's close() release the sync automatically.
  knowledge.close = async () => { await indexClose.promise; };
  try {
    await service.startKnowledgeSync(); await until(()=>knowledge.signals.length===1); const starting = service.startReview({ documentId, context, mode: 'model' }, null);
    const closing = service.close(); let closed = false; void closing.then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(knowledge.signals[0].aborted, true);
    knowledge.release(); await within(starting); assert.equal((await within(terminal.promise)).status, 'cancelled');
    assert.equal(calls, 0); assert.equal(closed, false, 'Database must remain open until the index client has finished closing.');
    indexClose.resolve(); await within(closing); assert.equal(closed, true);
  } finally { knowledge.release(); indexClose.resolve(); }
}));
