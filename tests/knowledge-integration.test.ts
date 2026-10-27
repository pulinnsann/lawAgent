import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { retrieveContext } from '../src/core/retrieval';
import { ContractService } from '../src/core/service';
import type { AppStore } from '../src/core/storage';
import { defaultRetrievalConfig } from '../src/shared/contracts';
import type { ContractDetail, ModelConfigInput, PublicRetrievalConfig, ReviewContext } from '../src/shared/contracts';
import type { KnowledgeHit, KnowledgePort, KnowledgeSearchResult, KnowledgeState, KnowledgeSyncJob } from '../src/shared/knowledge';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function within<T>(operation: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('knowledge integration operation did not settle in time')), milliseconds); });
  try { return await Promise.race([operation, timeout]); }
  finally { clearTimeout(timer); }
}

const folderA = join(tmpdir(), 'law-agent-authorized-a');
const folderB = join(tmpdir(), 'law-agent-authorized-b');
const stamp = '2026-10-22T00:00:00Z';

function configuration(folderPath: string): PublicRetrievalConfig {
  const config = defaultRetrievalConfig();
  config.knowledge = { ...config.knowledge, enabled: true, folderPath };
  return config;
}

function indexState(folderPath: string | null, synced = false): KnowledgeState {
  return { folderPath, engine: 'sqlite-fts5', tokenizerVersion: 'test-tokenizer', indexedFiles: synced ? 1 : 0,
    chunks: synced ? 1 : 0, staleFiles: 0, lastSyncedAt: synced ? stamp : null, job: null, limitations: [] };
}

type SyncInput = Parameters<KnowledgePort['syncFolder']>[0];
function syncJob(input: SyncInput, status: KnowledgeSyncJob['status'] = 'completed'): KnowledgeSyncJob {
  return { id: input.jobId, folderPath: input.folderPath, mode: input.mode, status, phase: status,
    startedAt: stamp, finishedAt: status === 'running' ? null : stamp, scanned: 0, indexed: 0, unchanged: 0,
    deleted: 0, skipped: 0, failed: 0, fullScan: status === 'completed', errors: [] };
}

function knowledgeDouble(overrides: Partial<KnowledgePort> = {}): KnowledgePort {
  return {
    async getState(folderPath) { return indexState(folderPath); },
    async syncFolder(input) { return syncJob(input); },
    async search(input) { return { query: input.query, expandedTerms: [], hits: [], state: indexState(input.folderPath), elapsedMs: 0 }; },
    async readChunk() { throw new Error('This test does not read source chunks.'); },
    async close() {},
    ...overrides,
  };
}

function storeDouble(initial: PublicRetrievalConfig, beforeModelSave: () => Promise<void> = async () => {}) {
  let config = structuredClone(initial);
  const savedFolders: Array<string | null> = [];
  const seam: Pick<AppStore, 'getRetrievalConfig' | 'saveRetrievalConfig' | 'saveConfig' | 'close'> = {
    getRetrievalConfig: () => structuredClone(config),
    async saveRetrievalConfig(next) { config = structuredClone(next); savedFolders.push(config.knowledge.folderPath); return structuredClone(config); },
    async saveConfig(input) {
      await beforeModelSave();
      const { apiKey: _key, clearApiKey: _clear, ...safe } = input;
      return { ...safe, hasApiKey: false, keyStorage: 'session-only' };
    },
    async close() {},
  };
  // ContractService currently takes the concrete store; this narrow double implements
  // every store operation exercised here without opening or changing user databases.
  return { store: seam as unknown as AppStore, savedFolders, getConfig: () => structuredClone(config) };
}

for (const change of ['directory', 'disabled'] as const) {
  test(`automatic sync ignores an old directory result after ${change === 'directory' ? 'switching A to unbuilt B' : 'disabling knowledge retrieval'}`, async () => {
    const oldState = deferred<KnowledgeState>();
    const requested = deferred<string | null>();
    const syncCalls: SyncInput[] = [];
    const fakeStore = storeDouble(configuration(folderA));
    const knowledge = knowledgeDouble({
      getState(folderPath) { requested.resolve(folderPath); return oldState.promise; },
      async syncFolder(input) { syncCalls.push(input); return syncJob(input); },
    });
    const service = new ContractService(fakeStore.store, '/unused-test-data', () => {}, knowledge);
    try {
      assert.equal(await requested.promise, folderA);
      const next = configuration(change === 'directory' ? folderB : folderA);
      if (change === 'disabled') next.knowledge.enabled = false;
      await service.saveRetrievalConfig(next);
      oldState.resolve(indexState(folderA, true));
      await nextTurn();
      assert.deepEqual(syncCalls, [], 'A previous directory snapshot must not start a task for the new or disabled configuration.');
      assert.equal(fakeStore.getConfig().knowledge.folderPath, next.knowledge.folderPath);
      assert.equal(fakeStore.getConfig().knowledge.enabled, next.knowledge.enabled);
    } finally { oldState.resolve(indexState(folderA, true)); await service.close(); }
  });
}

test('a queued directory save is rejected if a sync starts before that write commits', async () => {
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  const runningSync = deferred<KnowledgeSyncJob>();
  const syncCalls: SyncInput[] = [];
  let activeInput: SyncInput | null = null;
  const fakeStore = storeDouble(configuration(folderA), async () => { writeStarted.resolve(); await releaseWrite.promise; });
  const knowledge = knowledgeDouble({
    syncFolder(input, signal) {
      syncCalls.push(input); activeInput = input;
      const cancel = () => runningSync.resolve(syncJob(input, 'cancelled'));
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      return runningSync.promise.finally(() => signal.removeEventListener('abort', cancel));
    },
  });
  const service = new ContractService(fakeStore.store, '/unused-test-data', () => {}, knowledge);
  const modelConfig: ModelConfigInput = { name: 'queue-only test', baseUrl: 'https://model.example.invalid/v1', model: 'test',
    responseFormat: 'json_object', tokenParameter: 'max_tokens', maxOutputTokens: 1024, contextWindowTokens: 8192, timeoutSeconds: 10 };
  let blockingSave: Promise<unknown> | undefined;
  let savingB: Promise<unknown> | undefined;
  try {
    blockingSave = service.saveConfig(modelConfig);
    await writeStarted.promise;
    savingB = service.saveRetrievalConfig(configuration(folderB));
    const rejectedSave = assert.rejects(savingB, /建库任务.*知识库目录|更换知识库目录/);
    await service.startKnowledgeSync();
    await within((async()=>{while(!syncCalls.length)await nextTurn();})());
    assert.deepEqual(syncCalls.map(input => input.folderPath), [folderA]);
    releaseWrite.resolve();
    await blockingSave;
    await rejectedSave;
    assert.equal(fakeStore.getConfig().knowledge.folderPath, folderA);
    assert.deepEqual(fakeStore.savedFolders, [], 'The rejected queued save must never reach the store.');
  } finally {
    releaseWrite.resolve();
    if (activeInput) runningSync.resolve(syncJob(activeInput, 'cancelled'));
    await Promise.allSettled([blockingSave, savingB].filter((value): value is Promise<unknown> => Boolean(value)));
    await service.close();
  }
});

test('cancelling a hung index query settles promptly and retains another branch’s returned source', async () => {
  const sourceReadStarted = deferred<void>();
  const indexStarted = deferred<AbortSignal>();
  const indexReply = deferred<KnowledgeSearchResult>();
  const controller = new AbortController();
  const snippet = '外部知识库已返回的验收与付款制度候选。';
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the test request before replying */ }
    if (request.url === '/v1/search') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'complete', candidates: [{ externalSourceId: 'retained-policy', fragmentId: 'part-1',
        title: '已返回的制度候选', sourceUri: 'https://policies.example.invalid/retained', snippet, locator: { paragraph: 1 } }] }));
    } else if (request.url === '/v1/sources/read') {
      // Reaching source read proves the other branch already published its search
      // candidate; leave this read pending so cancellation timing is deterministic.
      sourceReadStarted.resolve();
    } else { response.writeHead(404); response.end(); }
  });
  let retrieval: Promise<Awaited<ReturnType<typeof retrieveContext>>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const config = configuration(folderA);
    config.knowledge.api = { ...config.knowledge.api, enabled: true, provider: 'standard', baseUrl: `http://127.0.0.1:${address.port}/v1`, collectionId: 'test-policies' };
    const document: ContractDetail = { id: 'integration-document', name: 'synthetic.docx', format: 'docx', language: 'zh', byteSize: 0,
      blockCount: 1, importedAt: stamp, warnings: [], partial: false, latestReviewId: null, reviews: [],
      blocks: [{ id: 'block-1', ordinal: 0, kind: 'paragraph', text: '本合成测试关注付款和验收。', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/p[1]', paragraphId: null } }] };
    const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '' };
    retrieval = retrieveContext(document, context, config, { knowledgeApiKey: null, webApiKey: null }, controller.signal, () => {}, (_input, signal) => {
      indexStarted.resolve(signal);
      // This port intentionally ignores abort and never returns until the test
      // releases it, exercising the integration's cancellation boundary itself.
      return indexReply.promise;
    });
    const [indexSignal] = await within(Promise.all([indexStarted.promise, sourceReadStarted.promise]));
    controller.abort();
    const bundle = await within(retrieval);
    assert.equal(indexSignal.aborted, true, 'The index adapter receives the branch cancellation signal.');
    const folder = bundle.attempts.find(attempt => attempt.provider === 'folder');
    const external = bundle.attempts.find(attempt => attempt.provider === 'standard');
    assert.equal(folder?.status, 'cancelled'); assert.equal(folder.resultCount, 0);
    assert.equal(external?.status, 'cancelled'); assert.equal(external.resultCount, 1);
    assert.equal(bundle.knowledgeStatus, 'partial');
    assert.equal(bundle.evidence.length, 1); assert.equal(bundle.evidence[0].attemptId, external.id);
    assert.equal(bundle.evidence[0].excerpt, snippet); assert.equal(bundle.evidence[0].contentScope, 'search_snippet');
    const snapshot = JSON.stringify(bundle);
    const lateHit: KnowledgeHit = { chunkId: 'late-chunk', sourceFileId: 'late-file', versionId: 'late-version', title: '迟到索引片段',
      relativePath: 'late.txt', sourceUri: 'file:///late.txt', locator: '第1行', location: { kind: 'text', lineStart: 1, lineEnd: 1 },
      excerpt: '取消后不应再加入的片段', excerptSha256: '0'.repeat(64), fileSha256: '1'.repeat(64), language: 'zh', indexedAt: stamp, score: 1, warnings: [] };
    indexReply.resolve({ query: '付款', expandedTerms: [], hits: [lateHit], state: indexState(folderA, true), elapsedMs: 1 });
    await nextTurn();
    assert.equal(JSON.stringify(bundle), snapshot, 'A late index reply must not mutate the completed cancellation audit.');
  } finally {
    controller.abort();
    indexReply.resolve({ query: '', expandedTerms: [], hits: [], state: indexState(folderA), elapsedMs: 0 });
    if (retrieval) await retrieval.catch(() => {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
