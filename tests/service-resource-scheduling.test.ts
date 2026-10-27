import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractService } from '../src/core/service';
import { AppStore } from '../src/core/storage';
import { ResourceScheduler } from '../src/core/resource-scheduler';
import { defaultRetrievalConfig, type ReviewTask } from '../src/shared/contracts';
import { defaultKnowledgePreferences } from '../src/shared/knowledge-preferences';
import type { KnowledgePort, KnowledgeState, KnowledgeSyncJob } from '../src/shared/knowledge';
import type { GenerateContractInput } from '../src/shared/generation';
import { createDocx } from './fixtures-documents';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until<T>(read: () => T, good: (value: T) => boolean = Boolean, label = 'condition'): Promise<T> { const deadline = Date.now() + 5000; while (Date.now() < deadline) { const value = read(); if (good(value)) return value; await new Promise<void>(done => setImmediate(done)); } throw new Error(`Synthetic scheduling timeout: ${label}`); }
async function within<T>(promise: Promise<T>): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error('Synthetic scheduling operation timed out')), 5000); })]); } finally { clearTimeout(timer); } }
const context = { contractType: 'service' as const, ourPartyRole: 'service_recipient' as const, businessContext: '仅验证软件调度的合成交易资料。', strictness: 'balanced' as const };
const generation = (): GenerateContractInput => ({ requestId: randomUUID(), language: 'zh', contractType: 'service', ourPartyRole: 'service_recipient', description: '为合成测试起草技术维护服务合同，双方名称、金额及履行期限尚未确认，请保留占位。' });

class HeldKnowledge implements KnowledgePort {
  signals: AbortSignal[] = []; stopped = true;
  private finish: (() => void) | null = null;
  async getState(folderPath: string | null): Promise<KnowledgeState> { return { folderPath, engine: 'sqlite-fts5', tokenizerVersion: 'synthetic', indexedFiles: 0, chunks: 0, staleFiles: 0, lastSyncedAt: null, job: null, limitations: [] }; }
  async syncFolder(input: Parameters<KnowledgePort['syncFolder']>[0], signal: AbortSignal): Promise<KnowledgeSyncJob> {
    this.signals.push(signal); this.stopped = false;
    const finish = deferred<void>(); this.finish = () => finish.resolve(); await finish.promise; this.stopped = true;
    return { id: input.jobId, folderPath: input.folderPath, status: signal.aborted ? 'cancelled' : 'completed', phase: 'synthetic', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), scanned: 0, indexed: 0, unchanged: 0, deleted: 0, skipped: 0, failed: 0, fullScan: true, errors: [] };
  }
  release() { this.finish?.(); this.finish = null; }
  async search(input: Parameters<KnowledgePort['search']>[0]) { return { query: input.query, expandedTerms: [], hits: [], state: await this.getState(input.folderPath), elapsedMs: 0 }; }
  async readChunk(): Promise<never> { throw new Error('No synthetic knowledge chunk'); }
  async close() { this.release(); }
}

interface HeldRequest { body: any; input: any; signal: AbortSignal | null | undefined; release: () => void }
class ModelTransport {
  readonly requests: HeldRequest[] = [];
  active = 0; peak = 0;
  fetch: typeof fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body)); const input = JSON.parse(body.messages.findLast((item: any) => item.role === 'user').content);
    this.active++; this.peak = Math.max(this.peak, this.active);
    const done = deferred<void>(); const signal = options?.signal;
    const entry: HeldRequest = { body, input, signal, release: () => done.resolve() }; this.requests.push(entry);
    let onAbort!: () => void;
    try {
      await Promise.race([done.promise, new Promise<never>((_done, reject) => { onAbort = () => reject(new DOMException('Synthetic cancellation', 'AbortError')); if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true }); })]);
      const content = input.contractBlocks ? { summary: '合成审核结果，法律质量待专业验收。', reviewedBlockIds: input.contractBlocks.map((block: any) => block.id), findings: [] } : {
        title: '合成合同草稿', clauses: [{ heading: '合同主体及服务', paragraphs: ['甲方：[待确认]。乙方：[待确认]。', '服务范围、费用与期限：[待确认]。'] }], missingInformation: ['双方名称、金额和日期待确认。'], warnings: ['合成工程结果，不可签署。'],
      };
      return new Response(JSON.stringify({ model: 'synthetic-resource-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 23, completion_tokens: 17 } }), { headers: { 'content-type': 'application/json' } });
    } finally { signal?.removeEventListener('abort', onAbort); this.active--; }
  };
  releaseAll() { for (const request of this.requests) request.release(); }
}

async function fixture(run: (value: { service: ContractService; store: AppStore; scheduler: ResourceScheduler; knowledge: HeldKnowledge; model: ModelTransport; firstId: string; secondId: string; dataDir: string; tasks: Map<string, ReviewTask> }) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-service-resource-'));
  const originalFetch = globalThis.fetch; const scheduler = new ResourceScheduler(); const knowledge = new HeldKnowledge(); const model = new ModelTransport(); const tasks = new Map<string, ReviewTask>();
  let service: ContractService | undefined;
  try {
    const store = await AppStore.open(dataDir);
    service = new ContractService(store, dataDir, task => tasks.set(task.id, task), knowledge, undefined, { resourceScheduler: scheduler });
    const first = await service.loadSample();
    const path = join(dataDir, 'synthetic-second.docx'); await writeFile(path, await createDocx({ paragraphs: ['另一份虚构服务合同。', '服务范围、价款、验收、终止与责任需要双方确认。'] }));
    const second = await service.importFile(path);
    await service.saveConfig({ name: 'Synthetic resource test', baseUrl: 'https://model.example.invalid/v1', model: 'synthetic-resource-model', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 4096, contextWindowTokens: 100000, timeoutSeconds: 60 });
    globalThis.fetch = model.fetch;
    await run({ service, store, scheduler, knowledge, model, firstId: first.id, secondId: second.id, dataDir, tasks });
  } finally { knowledge.release(); model.releaseAll(); await service?.close(); globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); }
}
async function terminal(tasks: Map<string, ReviewTask>, taskId: string): Promise<ReviewTask> { return until(() => tasks.get(taskId), value => Boolean(value && ['completed', 'cancelled', 'failed'].includes(value.status)), 'terminal review').then(value => value!); }

test('service model reviews are exclusive and queued review source is not eagerly loaded', async () => fixture(async ({ service, store, model, firstId, secondId, tasks }) => {
  const original = store.getDocumentForReview.bind(store); const loaded: string[] = [];
  store.getDocumentForReview = id => { loaded.push(id); return original(id); };
  const first = await service.startReview({ documentId: firstId, context, mode: 'model' }, null);
  await until(() => model.requests.length, count => count === 1, 'first model request');
  const second = await service.startReview({ documentId: secondId, context, mode: 'model' }, null);
  await until(() => service.getResourceState().queued.length, count => count > 0, 'queued second review');
  assert.equal(model.requests.length, 1); assert.equal(loaded.includes(secondId), false, 'queued contracts must retain only bounded headers until admitted');
  model.requests[0].release(); assert.equal((await terminal(tasks, first.taskId)).status, 'completed');
  await until(() => model.requests.length, count => count === 2, 'second model request');
  assert.ok(loaded.includes(secondId)); assert.equal(model.peak, 1);
  model.requests[1].release(); const done = await terminal(tasks, second.taskId); assert.equal(done.status, 'completed', done.error ?? '');
  const saved = service.getReview(done.resultId!); assert.equal(saved.inputTokens, 23); assert.equal(saved.outputTokens, 17); assert.equal(saved.documentId, secondId);
}));

test('cancelling a queued review sends no model call and frees the slot for an unchanged generated draft', async () => fixture(async ({ service, model, firstId, secondId, tasks }) => {
  const first = await service.startReview({ documentId: firstId, context, mode: 'model' }, null);
  await until(() => model.requests.length, count => count === 1);
  const second = await service.startReview({ documentId: secondId, context, mode: 'model' }, null);
  await until(() => service.getResourceState().queued.length, count => count > 0);
  await service.cancelReview(second.taskId); assert.equal((await terminal(tasks, second.taskId)).status, 'cancelled');
  const input = generation(); const generated = service.generateContract(input, null);
  await until(() => service.getResourceState().queued.some(item => item.operation === 'contract_generation'));
  assert.equal(model.requests.length, 1);
  model.requests[0].release(); assert.equal((await terminal(tasks, first.taskId)).status, 'completed');
  await until(() => model.requests.length, count => count === 2);
  assert.equal(model.requests[1].input.description, input.description); assert.equal(model.requests[1].input.contractBlocks, undefined);
  model.requests[1].release(); const draft = await generated;
  assert.equal(draft.id, input.requestId); assert.equal(draft.request.description, input.description); assert.ok(draft.clauses[0].paragraphs[1].includes('[待确认]')); assert.equal(model.peak, 1);
}));

test('native PDF resource ownership blocks model review until the actual release, then waits behind the running model', async () => fixture(async ({ service, model, firstId, tasks }) => {
  const pdfId = randomUUID(); await service.acquireExternalResource(pdfId);
  const review = await service.startReview({ documentId: firstId, context, mode: 'model' }, null);
  await until(() => service.getResourceState().queued.some(item => item.operation === 'contract_review'));
  assert.equal(model.requests.length, 0); assert.equal(service.getResourceState().active?.operation, 'native_pdf');
  service.releaseExternalResource(pdfId); await until(() => model.requests.length, count => count === 1);
  let acquired = false; const nextId = randomUUID(); const secondPdf = service.acquireExternalResource(nextId).then(() => { acquired = true; });
  await until(() => service.getResourceState().queued.some(item => item.operation === 'native_pdf'));
  assert.equal(acquired, false); model.requests[0].release(); assert.equal((await terminal(tasks, review.taskId)).status, 'completed');
  await within(secondPdf); assert.equal(acquired, true); service.releaseExternalResource(nextId); service.releaseExternalResource(nextId);
}));

test('foreground native work requests index cancellation but waits until the index worker acknowledges actual cleanup', async () => fixture(async ({ service, knowledge, dataDir }) => {
  const folder = join(dataDir, 'synthetic-knowledge'); await mkdir(folder);
  const config = defaultRetrievalConfig(); config.knowledge = { ...config.knowledge, enabled: true, folderPath: folder, preferences: { ...defaultKnowledgePreferences(), autoSyncEnabled: false } };
  await service.saveRetrievalConfig(config); await service.startKnowledgeSync();
  await until(() => knowledge.signals.length, count => count === 1);
  let acquired = false; const id = randomUUID(); const native = service.acquireExternalResource(id).then(() => { acquired = true; });
  await until(() => knowledge.signals[0].aborted);
  assert.equal(knowledge.stopped, false); assert.equal(acquired, false); assert.equal(service.getResourceState().active?.kind, 'index');
  knowledge.release(); await within(native); assert.equal(knowledge.stopped, true); service.releaseExternalResource(id);
}));

test('model review queued during index cleanup takes priority over an already waiting PDF without resource overlap', async () => fixture(async ({ service, knowledge, model, firstId, dataDir, tasks }) => {
  const folder = join(dataDir, 'synthetic-priority-knowledge'); await mkdir(folder);
  const config = defaultRetrievalConfig(); config.knowledge = { ...config.knowledge, enabled: true, folderPath: folder, preferences: { ...defaultKnowledgePreferences(), autoSyncEnabled: false } };
  await service.saveRetrievalConfig(config); await service.startKnowledgeSync();
  await until(() => knowledge.signals.length, count => count === 1);
  const pdfId = randomUUID(); let pdfAdmitted = false; const pdf = service.acquireExternalResource(pdfId).then(() => { pdfAdmitted = true; });
  await until(() => service.getResourceState().queued.some(item => item.operation === 'native_pdf'));
  const review = await within(service.startReview({ documentId: firstId, context, mode: 'model' }, null));
  assert.equal(knowledge.signals[0].aborted, true); assert.equal(knowledge.stopped, false);
  assert.ok(service.getResourceState().queued.some(item => item.id === review.taskId && item.operation === 'contract_review'));
  assert.equal(model.requests.length, 0); assert.equal(pdfAdmitted, false);
  knowledge.release(); await until(() => model.requests.length, count => count === 1);
  assert.equal(knowledge.stopped, true); assert.equal(pdfAdmitted, false); assert.equal(service.getResourceState().active?.operation, 'contract_review');
  model.requests[0].release(); assert.equal((await terminal(tasks, review.taskId)).status, 'completed');
  await within(pdf); assert.equal(pdfAdmitted, true); service.releaseExternalResource(pdfId);
}));

test('cancelling a queued PDF lease and immediately retrying the same ID preserves the replacement owner', async () => fixture(async ({ service }) => {
  const anchorId = randomUUID(); await service.acquireExternalResource(anchorId);
  const retryId = randomUUID(); const cancelled = assert.rejects(service.acquireExternalResource(retryId), /取消/);
  await until(() => service.getResourceState().queued.some(item => item.id === retryId));
  service.releaseExternalResource(retryId); const retry = service.acquireExternalResource(retryId);
  await cancelled; service.releaseExternalResource(anchorId); await within(retry);
  assert.equal(service.getResourceState().active?.id, retryId);
  service.releaseExternalResource(retryId); assert.equal(service.getResourceState().active, null, 'old cancellation cleanup must not erase the new lease owner');
  const nextId = randomUUID(); await within(service.acquireExternalResource(nextId)); service.releaseExternalResource(nextId);
}));

test('critical pressure defers model admission and queued cancellation prevents a late paid request after recovery', async () => fixture(async ({ service, scheduler, model, firstId, tasks }) => {
  scheduler.updatePressure({ level: 'critical', observedAt: new Date().toISOString(), source: 'test', availableBytes: 1, totalBytes: 1000 });
  const review = await service.startReview({ documentId: firstId, context, mode: 'model' }, null);
  await until(() => service.getResourceState().queued.some(item => item.waitReason === 'memory_critical'));
  assert.equal(model.requests.length, 0);
  await service.cancelReview(review.taskId); assert.equal((await terminal(tasks, review.taskId)).status, 'cancelled');
  scheduler.updatePressure({ level: 'normal', observedAt: new Date().toISOString(), source: 'test', availableBytes: 800, totalBytes: 1000 });
  await new Promise<void>(done => setImmediate(done)); assert.equal(model.requests.length, 0); assert.equal(service.getResourceState().queued.length, 0);
}));

test('closing aborts active model transport and rejects queued native work without admitting a replacement task', async () => fixture(async ({ service, model, firstId, tasks }) => {
  const review = await service.startReview({ documentId: firstId, context, mode: 'model' }, null); await until(() => model.requests.length, count => count === 1);
  const native = assert.rejects(service.acquireExternalResource(randomUUID()), /关闭|取消/);
  await until(() => service.getResourceState().queued.length, count => count === 1);
  await within(service.close()); await native;
  assert.equal(model.requests[0].signal?.aborted, true); assert.equal((await terminal(tasks, review.taskId)).status, 'cancelled');
  assert.equal(model.requests.length, 1); assert.equal(service.getResourceState().closed, true); assert.equal(service.getResourceState().queued.length, 0);
}));

test('report rendering waits behind model review, cancels without publication, and later retains the saved review result', async () => fixture(async ({ service, model, firstId, tasks, store }) => {
  const review = await service.startReview({ documentId: firstId, context, mode: 'model' }, null); await until(() => model.requests.length, count => count === 1);
  const id = randomUUID(); let rendered = false;
  const report = service.runWorkspaceCommand({ action: 'reporting.render', payload: { scope: 'workspace', style: 'management' }, requestId: id }).then(value => { rendered = true; return value; });
  const rejected = assert.rejects(report, /取消/);
  await until(() => service.getResourceState().queued.some(item => item.operation === 'report_render'));
  assert.equal(rendered, false); await service.runWorkspaceCommand({ action: 'workspace.cancel', payload: { requestId: id } }); await rejected;
  assert.equal(store.rows("SELECT id FROM audit_events WHERE entity_type='workspace_asset.report_export'").length, 0);
  model.requests[0].release(); const done = await terminal(tasks, review.taskId); assert.equal(done.status, 'completed');
  const result = await service.runWorkspaceCommand({ action: 'reporting.render', payload: { scope: 'workspace', style: 'management' } });
  assert.equal(result.snapshot.metrics.reviewRounds, 1); assert.equal(result.snapshot.reviews[0].review.id, done.resultId); assert.equal(typeof result.markdown, 'string'); assert.ok(result.markdown.includes('合成审核结果'));
}));

test('OCR model installation waits for native work and a queued cancellation prevents all download calls', async () => fixture(async ({ service, model }) => {
  const nativeId = randomUUID(); await service.acquireExternalResource(nativeId);
  const requestId = randomUUID();
  const rejected = assert.rejects(service.runWorkspaceCommand({ action: 'conversion.download', payload: { languages: ['chi_sim'] }, requestId }), /取消/);
  await until(() => service.getResourceState().queued.some(item => item.operation === 'document_conversion'));
  assert.equal(model.requests.length, 0);
  await service.runWorkspaceCommand({ action: 'workspace.cancel', payload: { requestId } }); await rejected;
  service.releaseExternalResource(nativeId); assert.equal(model.requests.length, 0); assert.equal(service.getResourceState().queued.length, 0);
}));

test('warning pressure defers OCR downloads while the configured model API stays available without model-setting changes', async () => fixture(async ({ service, scheduler, model, firstId, tasks }) => {
  const config = structuredClone(service.getState().modelConfig);
  scheduler.updatePressure({ level: 'warning', observedAt: new Date().toISOString(), source: 'test', availableBytes: 600_000_000, totalBytes: 8 * 1024 ** 3 });
  const requestId = randomUUID();
  const rejected = assert.rejects(service.runWorkspaceCommand({ action: 'conversion.download', payload: { languages: ['chi_sim'] }, requestId }), /取消/);
  await until(() => service.getResourceState().queued.some(item => item.operation === 'document_conversion' && item.waitReason === 'memory_warning'));
  const review = await service.startReview({ documentId: firstId, context, mode: 'model' }, null);
  await until(() => model.requests.length, count => count === 1);
  assert.ok(model.requests[0].input.contractBlocks, 'the allowed request is model review rather than an OCR download');
  assert.equal(service.getResourceState().active?.operation, 'contract_review');
  assert.ok(service.getResourceState().queued.some(item => item.operation === 'document_conversion' && item.waitReason === 'memory_warning'));
  await service.runWorkspaceCommand({ action: 'workspace.cancel', payload: { requestId } }); await rejected;
  model.requests[0].release(); assert.equal((await terminal(tasks, review.taskId)).status, 'completed');
  assert.equal(model.requests.length, 1); assert.deepEqual(service.getState().modelConfig, config);
  assert.equal(service.getResourceState().queued.length, 0);
}));

test('terminal publication does not release model resources until the index worker drain actually finishes',async()=>fixture(async({service,knowledge,model,firstId,tasks})=>{
 const drain=deferred<void>();const originalClose=knowledge.close.bind(knowledge);
 Object.assign(knowledge,{waitForIdle:()=>drain.promise,close:async()=>{drain.resolve();await originalClose();}});
 const review=await service.startReview({documentId:firstId,context,mode:'model'},null);await until(()=>model.requests.length,n=>n===1);
 model.requests[0].release();assert.equal((await terminal(tasks,review.taskId)).status,'completed');
 const pdfId=randomUUID();let admitted=false;const pdf=service.acquireExternalResource(pdfId).then(()=>{admitted=true;});
 await until(()=>service.getResourceState().queued.some(item=>item.id===pdfId));
 await new Promise<void>(done=>setImmediate(done));assert.equal(admitted,false);assert.equal(service.getResourceState().active?.operation,'contract_review');
 drain.resolve();await within(pdf);assert.equal(admitted,true);service.releaseExternalResource(pdfId);
}));

test('closing starts worker cleanup before awaiting a completed review resource-drain barrier',async()=>fixture(async({service,knowledge,model,firstId,tasks})=>{
 const drain=deferred<void>();let workerCloseStarted=false;const originalClose=knowledge.close.bind(knowledge);
 Object.assign(knowledge,{waitForIdle:()=>drain.promise,close:async()=>{workerCloseStarted=true;drain.resolve();await originalClose();}});
 const review=await service.startReview({documentId:firstId,context,mode:'model'},null);await until(()=>model.requests.length,n=>n===1);model.requests[0].release();await terminal(tasks,review.taskId);
 assert.equal(service.getResourceState().active?.kind,'model');await within(service.close());assert.equal(workerCloseStarted,true);assert.equal(service.getResourceState().active,null);
}));
