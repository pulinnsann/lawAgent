import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ContractService } from '../src/core/service';
import { AppStore } from '../src/core/storage';
import { defaultRetrievalConfig } from '../src/shared/contracts';
import type { ReviewContext, ReviewTask } from '../src/shared/contracts';
import type { KnowledgeHit, KnowledgePort, KnowledgePreferences, KnowledgeSearchResult, KnowledgeState } from '../src/shared/knowledge';
import { defaultKnowledgePreferences } from '../src/shared/knowledge-preferences';

const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '仅为范围撤销回归测试。' };
const excerpt = '合成旧制度：服务采购付款前应保留书面验收记录。';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stamp = '2026-10-22T00:00:00.000Z';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function within<T>(operation: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Scope regression test did not settle')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
function indexState(folderPath: string | null): KnowledgeState {
  return { folderPath, engine: 'sqlite-fts5', tokenizerVersion: 'scope-test', indexedFiles: 1,
    chunks: 1, staleFiles: 0, lastSyncedAt: stamp, job: null, limitations: [] };
}
function sourceHit(folderPath: string): KnowledgeHit {
  return { chunkId: 'old-scope-chunk', sourceFileId: 'old-scope-file', versionId: 'old-scope-version',
    title: '旧采购制度.txt', relativePath: join('blocked', '旧采购制度.txt'),
    sourceUri: pathToFileURL(join(folderPath, 'blocked', '旧采购制度.txt')).href,
    locator: '第1行', location: { kind: 'text', lineStart: 1, lineEnd: 1 }, excerpt,
    excerptSha256: hash(excerpt), fileSha256: hash(excerpt), language: 'zh', indexedAt: stamp, score: 1, warnings: [] };
}
function reply(folderPath: string, hits: KnowledgeHit[] = []): KnowledgeSearchResult {
  return { query: '付款验收', expandedTerms: [], hits, state: indexState(folderPath), elapsedMs: 1 };
}

type Search = KnowledgePort['search'];
interface ModelPayload { contractBlocks: Array<{ id: string; text: string }>; sources: Array<{ id: string; excerpt: string }> }

async function fixture(t: test.TestContext, search: Search, releaseSearch: () => void, hangWeb = false) {
  const base = await mkdtemp(join(tmpdir(), 'law-setup-scope-'));
  const dataDir = join(base, 'data'); const folderPath = join(base, 'sources');
  await mkdir(join(folderPath, 'blocked'), { recursive: true });
  await writeFile(join(folderPath, 'blocked', '旧采购制度.txt'), excerpt);
  const modelCalls: ModelPayload[] = []; const serverErrors: string[] = [];
  const webStarted = deferred<void>(); let webCalls = 0;
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url!, 'http://127.0.0.1').pathname;
      if (path === '/search' && hangWeb) {
        assert.equal(request.method, 'GET');
        assert.equal(request.headers.authorization, undefined);
        webCalls++; if (webCalls >= 2) webStarted.resolve();
        return; // Leave both synthetic search requests pending until cancellation.
      }
      assert.equal(path, '/v1/chat/completions');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, undefined);
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const payload = JSON.parse(body.messages[1].content) as ModelPayload;
      assert.ok(payload.contractBlocks.length);
      modelCalls.push(payload);
      const content = { summary: '合成模型协议响应：范围未改变时可正常完成审核。',
        reviewedBlockIds: payload.contractBlocks.map(block => block.id), findings: [] };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ model: 'scope-regression-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }));
    } catch (error) {
      serverErrors.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500); response.end('{}');
    }
  });
  let service: ContractService | undefined; let store: AppStore | undefined; let listening = false;
  t.after(async () => {
    releaseSearch();
    try { if (service) await service.close(); else await store?.close(); }
    finally {
      server.closeAllConnections();
      if (listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(base, { recursive: true, force: true });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); listening = true;
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const knowledge: KnowledgePort = {
    async getState(folder, _preferences) { return indexState(folder); },
    async syncFolder() { throw new Error('These tests must not start automatic indexing'); },
    search,
    async readChunk() { throw new Error('These tests must not reread source chunks'); },
    async close() {},
  };
  store = await AppStore.open(dataDir);
  const finished = deferred<ReviewTask>();
  service = new ContractService(store, dataDir, task => { if (['completed', 'failed', 'cancelled'].includes(task.status)) finished.resolve(task); }, knowledge);
  const document = await service.loadSample();
  await service.saveConfig({ name: '范围回归本机模型', baseUrl: `${endpoint}/v1`, model: 'scope-regression-model',
    responseFormat: 'json_object', tokenParameter: 'max_tokens', maxOutputTokens: 4096, contextWindowTokens: 65536, timeoutSeconds: 10 });
  const config = defaultRetrievalConfig();
  config.knowledge = { ...config.knowledge, enabled: true, folderPath, preferences: defaultKnowledgePreferences() };
  config.web = { ...config.web, enabled: hangWeb, baseUrl: hangWeb ? `${endpoint}/search` : '', fetchPages: false };
  await service.saveRetrievalConfig(config);
  return { service, store, folderPath, document, finished, modelCalls, serverErrors, webStarted, config };
}

test('tightening scope cancels a pending index reply and a late source never reaches the model or audit', async t => {
  const searchStarted = deferred<{ folderPath: string; signal: AbortSignal }>();
  const indexReply = deferred<KnowledgeSearchResult>();
  const f = await fixture(t, (input, signal) => {
    assert.ok(signal); searchStarted.resolve({ folderPath: input.folderPath, signal });
    // Intentionally ignore abort to test the integration boundary, not a cooperative fake.
    return indexReply.promise;
  }, () => indexReply.resolve(reply('')));
  const { taskId } = await f.service.startReview({ documentId: f.document.id, mode: 'model', context }, null);
  const started = await within(searchStarted.promise);
  const preferences = { ...defaultKnowledgePreferences(), excludeDirectories: ['blocked'] };
  const saved = await f.service.configureLocalKnowledge({ folderPath: f.folderPath, preferences, buildNow: false });
  assert.equal(saved.jobId, null); assert.equal(saved.buildError, null);
  const terminal = await within(f.finished.promise);
  assert.equal(terminal.id, taskId); assert.equal(terminal.status, 'cancelled', terminal.error ?? '');
  assert.match(terminal.error ?? '', /知识库资料范围已更改/u);
  assert.equal(started.signal.aborted, true);
  assert.equal(f.modelCalls.length, 0);
  assert.deepEqual(f.service.getDocument(f.document.id).reviews, []);
  const runId = String(f.store.rows('SELECT analysis_run_id FROM tasks WHERE id=?', [taskId])[0].analysis_run_id);
  const audit = f.store.getRetrievalBundle(runId); assert.ok(audit);
  assert.equal(audit.attempts.find(attempt => attempt.provider === 'folder')?.status, 'cancelled');
  assert.deepEqual(audit.evidence, []);
  const auditBeforeLateReply = JSON.stringify(audit);
  indexReply.resolve(reply(started.folderPath, [sourceHit(started.folderPath)]));
  await nextTurn(); await nextTurn();
  assert.equal(f.modelCalls.length, 0, 'A noncooperative late index reply cannot trigger a model request');
  assert.equal(JSON.stringify(f.store.getRetrievalBundle(runId)), auditBeforeLateReply);
  assert.equal(f.service.getState().tasks.find(task => task.id === taskId)?.status, 'cancelled');
  assert.deepEqual(f.serverErrors, []);
});

test('scope change after a local hit while web is pending cancels before any model request', async t => {
  const localReturned = deferred<void>();
  const f = await fixture(t, async input => {
    localReturned.resolve(); return reply(input.folderPath, [sourceHit(input.folderPath)]);
  }, () => {}, true);
  const { taskId } = await f.service.startReview({ documentId: f.document.id, mode: 'model', context }, null);
  await within(Promise.all([localReturned.promise, f.webStarted.promise]));
  await f.service.saveRetrievalConfig({ ...f.config, knowledge: { ...f.config.knowledge,
    preferences: { ...defaultKnowledgePreferences(), maxFileSizeMb: 1 } } });
  const terminal = await within(f.finished.promise);
  assert.equal(terminal.status, 'cancelled', terminal.error ?? '');
  assert.match(terminal.error ?? '', /知识库资料范围已更改/u);
  assert.equal(f.modelCalls.length, 0);
  assert.deepEqual(f.service.getDocument(f.document.id).reviews, []);
  const runId = String(f.store.rows('SELECT analysis_run_id FROM tasks WHERE id=?', [taskId])[0].analysis_run_id);
  const audit = f.store.getRetrievalBundle(runId); assert.ok(audit);
  assert.ok(audit.evidence.some(source => source.excerpt === excerpt), 'Already acquired source remains in the cancelled audit');
  assert.equal(audit.attempts.find(attempt => attempt.provider === 'folder')?.status, 'complete');
  assert.ok(audit.attempts.filter(attempt => attempt.provider === 'searxng').every(attempt => attempt.status === 'cancelled'));
  assert.deepEqual(f.serverErrors, []);
});

test('changing only the display name and auto-sync settings keeps a pending review alive', async t => {
  const searchStarted = deferred<{ folderPath: string; signal: AbortSignal }>();
  const indexReply = deferred<KnowledgeSearchResult>();
  const f = await fixture(t, (input, signal) => {
    assert.ok(signal); searchStarted.resolve({ folderPath: input.folderPath, signal }); return indexReply.promise;
  }, () => indexReply.resolve(reply('')));
  await f.service.startReview({ documentId: f.document.id, mode: 'model', context }, null);
  const started = await within(searchStarted.promise);
  const preferences: KnowledgePreferences = { ...defaultKnowledgePreferences(), displayName: '更名后的知识库', autoSyncEnabled: false, syncIntervalMinutes: 19 };
  await f.service.configureLocalKnowledge({ folderPath: f.folderPath, preferences, buildNow: false });
  assert.equal(started.signal.aborted, false, 'Display and scheduling changes must not revoke the local source scope');
  indexReply.resolve(reply(started.folderPath));
  const terminal = await within(f.finished.promise);
  assert.equal(terminal.status, 'completed', terminal.error ?? '');
  assert.equal(f.modelCalls.length, 1); assert.deepEqual(f.modelCalls[0].sources, []);
  assert.equal(f.service.getDocument(f.document.id).reviews.length, 1);
  assert.equal(f.service.getState().retrievalConfig?.knowledge.preferences?.displayName, preferences.displayName);
  assert.deepEqual(f.serverErrors, []);
});
