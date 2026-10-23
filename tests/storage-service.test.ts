import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { AppStore } from '../src/core/storage';
import { ContractService, renderReviewMarkdown } from '../src/core/service';
import { createSampleContract } from '../src/core/sample';
import { defaultRetrievalConfig } from '../src/shared/contracts';
import type { ModelConfigInput, RetrievalConfigInput, ReviewContext, ReviewTask } from '../src/shared/contracts';

const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', businessContext: '工程集成测试，不是真实法律意见。', strictness: 'balanced' };

test('SQLite persists imports/reviews, restores foreign keys after snapshots, and never stores API keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-agent-store-'));
  let store: AppStore | undefined;
  try {
    const samplePath = join(dir, '测试合同.docx'); await writeFile(samplePath, await createSampleContract());
    store = await AppStore.open(join(dir, 'data'));
    let finish!: (task: ReviewTask) => void;
    const completed = new Promise<ReviewTask>(resolve => { finish = resolve; });
    const service = new ContractService(store, join(dir, 'data'), task => { if (['completed','failed','cancelled'].includes(task.status)) finish(task); });
    const document = await service.importFile(samplePath);
    assert.ok(document.blocks.length > 5);
    assert.equal((await service.importFile(samplePath)).id, document.id);
    assert.equal(service.getState().documents.length, 1);
    assert.equal(store.rows('PRAGMA foreign_keys')[0].foreign_keys, 1);
    const settings: ModelConfigInput = { name: '本机测试', baseUrl: 'http://127.0.0.1:1234/v1', model: 'test-model', apiKey: 'secret-not-for-storage', responseFormat: 'json_object', tokenParameter: 'max_tokens', maxOutputTokens: 2048, contextWindowTokens: 65536, timeoutSeconds: 30 };
    await service.saveConfig(settings);
    assert.equal(store.rows('PRAGMA foreign_keys')[0].foreign_keys, 1);
    assert.ok(!JSON.stringify(store.rows('SELECT * FROM provider_profiles')).includes(settings.apiKey!));
    const start = service.startReview({ documentId: document.id, context, mode: 'local' }, null);
    await assert.rejects(service.startReview({ documentId: document.id, context, mode: 'local' }, null), /正在审核/);
    await start;
    const finished = await completed; assert.equal(finished.status, 'completed', finished.error || '');
    const result = service.getDocument(document.id).reviews[0];
    assert.equal(result.mode, 'local'); assert.equal(result.coverage.knowledgeStatus, 'not_configured');
    assert.ok(renderReviewMarkdown(result, document.name).includes('待法务复核'));
    const run = store.rows('SELECT * FROM analysis_runs')[0]; assert.equal(run.status, 'awaiting_review');
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
    await store.close(); store = undefined;
    assert.ok(!(await readFile(join(dir, 'data/workspace.sqlite'))).includes(Buffer.from(settings.apiKey!)));
    store = await AppStore.open(join(dir, 'data'));
    assert.equal(store.listDocuments().length, 1);
    assert.equal(store.getDocument(document.id).reviews[0].id, result.id);
    assert.equal(store.getConfig()?.model, 'test-model');
    assert.equal(store.listTasks()[0].status, 'completed');
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('service integrates import → saved configuration → HTTP model review → persisted report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-agent-flow-'));
  const calls: {url:string;authorization:string|undefined}[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    calls.push({ url: request.url!, authorization: request.headers.authorization });
    const body = JSON.parse(raw);
    let content: unknown = { ok: true };
    if (body.response_format?.json_schema?.name === 'contract_review') {
      const data = JSON.parse(body.messages[1].content);
      const blocks = data.contractBlocks as {id:string;text:string}[];
      content = { summary: '本机模拟模型用于验证真实请求与持久化链路。', reviewedBlockIds: blocks.map(b => b.id), findings: [{ blockIds: [blocks[4].id], quote: blocks[4].text, title: '付款前提待确认', category: 'commercial', severity: 'medium', description: '集成测试意见，不代表法律判断。', suggestion: '结合交易事实复核付款安排。', legalBasis: null }] };
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'integration-test-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let store: AppStore | undefined;
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    store = await AppStore.open(join(dir, 'data'));
    let finish!: (task:ReviewTask)=>void;
    const completed = new Promise<ReviewTask>(resolve => { finish = resolve; });
    const service = new ContractService(store, join(dir, 'data'), task => { if (['completed','failed','cancelled'].includes(task.status)) finish(task); });
    const document = await service.loadSample();
    await service.saveConfig({ name: '集成测试接口', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'integration-test-model', responseFormat: 'json_schema', tokenParameter: 'max_completion_tokens', maxOutputTokens: 4096, contextWindowTokens: 65536, timeoutSeconds: 10 });
    assert.equal((await service.testConnection('local-test-key')).model, 'integration-test-model');
    await service.startReview({ documentId: document.id, context, mode: 'model' }, 'local-test-key');
    const task = await completed; assert.equal(task.status, 'completed', task.error || '');
    const result = service.getDocument(document.id).reviews[0];
    assert.equal(result.mode, 'model'); assert.equal(result.findings.length, 1); assert.equal(result.findings[0].locationStatus, 'matched'); assert.equal(result.findings[0].basisStatus, 'unverified');
    assert.equal(result.inputTokens, 100); assert.equal(result.outputTokens, 50);
    assert.equal(calls.length, 2); assert.ok(calls.every(call => call.url === '/v1/chat/completions' && call.authorization === 'Bearer local-test-key'));
    assert.ok(!JSON.stringify(store.rows('SELECT * FROM reports')).includes('local-test-key'));
  } finally { await store?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function within<T>(promise: Promise<T>, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('integration test timed out')), milliseconds); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer!); }
}

function retrievalSettings(baseUrl: string, folderPath: string | null = null): RetrievalConfigInput {
  const defaults = defaultRetrievalConfig();
  return { ...defaults,
    knowledge: { enabled: true, folderPath, api: { enabled: true, provider: 'dify', baseUrl: `${baseUrl}/dify`, collectionId: 'dataset-one' } },
    web: { ...defaults.web, enabled: true, provider: 'searxng', baseUrl: `${baseUrl}/web`, fetchPages: false },
  };
}

function modelSettings(baseUrl: string): ModelConfigInput {
  return { name: '集成测试模型', baseUrl: `${baseUrl}/model/v1`, model: 'retrieval-model', responseFormat: 'json_schema', tokenParameter: 'max_completion_tokens', maxOutputTokens: 4096, contextWindowTokens: 65536, timeoutSeconds: 10 };
}

test('folder + Dify + web retrieval is persisted relationally with frozen config, citations and no credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-retrieval-persist-'));
  const secrets = { model: 'model-secret-only-in-request', knowledge: 'knowledge-secret-only-in-request', web: 'web-secret-only-in-request' };
  const requests: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    requests.push({ path: request.url!, auth: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/dify/v1/datasets/')) {
      response.end(JSON.stringify({ records: [{ segment: { id: 'segment-one', position: 1, content: `服务采购的验收标准、交付记录和付款前提应结合业务复核。${secrets.knowledge}`, document: { id: 'document-one', name: '企业内部验收规范（测试）' } } }] }));
    } else if (request.url?.startsWith('/web/search?')) {
      response.end(JSON.stringify({ results: [{ title: '官方域名检索线索（测试）', url: 'https://www.court.gov.cn/test-source', content: '合同付款和验收争议的检索摘要；这不是已核验的裁判结论。' }] }));
    } else if (request.url === '/model/v1/chat/completions') {
      const data = JSON.parse(String((body.messages as Array<{content:string}>)[1].content));
      const blocks = data.contractBlocks as Array<{id:string;text:string}>;
      const sources = data.sources as Array<{id:string;excerpt:string;contentScope:string}>;
      const cited = sources.find(source => source.contentScope !== 'search_snippet')!;
      assert.ok(cited);
      response.end(JSON.stringify({ model: 'retrieval-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        summary: `检索集成测试报告，连接凭据不应保存：${secrets.model}`,
        reviewedBlockIds: blocks.map(block => block.id), findings: [{ blockIds: [blocks[0].id], quote: blocks[0].text, title: '验收与付款前提待复核', category: 'commercial', severity: 'medium', description: '测试分析，不是法律意见。', suggestion: '结合实际业务检查验收依据。', legalBasis: null, citations: [{ evidenceId: cited.id, quote: cited.excerpt }] }],
      }) } }], usage: { prompt_tokens: 120, completion_tokens: 60 } }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  const baseUrl = await listen(server);
  let store: AppStore | undefined; let service: ContractService | undefined;
  try {
    const folder = join(dir, 'knowledge'); await mkdir(folder); await writeFile(join(folder, '内部验收规则.md'), '服务采购合同的验收标准、交付记录及付款条件需要业务确认。');
    store = await AppStore.open(join(dir, 'data'));
    assert.equal(store.getRetrievalConfig(), null);
    let finish!: (task:ReviewTask)=>void;
    const completed = new Promise<ReviewTask>(resolve => { finish = resolve; });
    service = new ContractService(store, join(dir, 'data'), task => { if (['completed','failed','cancelled'].includes(task.status)) finish(task); });
    const document = await service.loadSample();
    await service.saveConfig({ ...modelSettings(baseUrl), apiKey: secrets.model });
    const settings = retrievalSettings(baseUrl, folder);
    settings.knowledge.api.apiKey = secrets.knowledge; settings.web.apiKey = secrets.web;
    const publicSettings = await service.saveRetrievalConfig(settings);
    const knowledgeJob = await service.startKnowledgeSync();
    const knowledgeDeadline = Date.now() + 10000;
    for (;;) {
      const state = await service.getKnowledgeState();
      if (state.job?.id === knowledgeJob.jobId && state.job.status !== 'running') { assert.equal(state.job.status, 'completed'); break; }
      if (Date.now() > knowledgeDeadline) throw new Error('Local indexing timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal('apiKey' in publicSettings.knowledge.api, false); assert.equal('apiKey' in publicSettings.web, false);
    assert.ok(service.getState().retrievalConfig);
    await service.startReview({ documentId: document.id, context, mode: 'model' }, secrets.model, { knowledgeApiKey: secrets.knowledge, webApiKey: secrets.web });
    // Editing settings while a run is active must not redirect its calls or rewrite its snapshot.
    await service.saveRetrievalConfig({ ...settings, knowledge: { ...settings.knowledge, api: { ...settings.knowledge.api, collectionId: 'dataset-two' } } });
    const task = await within(completed); assert.equal(task.status, 'completed', task.error || '');
    const result = service.getReview(task.resultId!);
    assert.equal(result.retrieval?.attempts.length, 4);
    assert.equal(result.retrieval?.evidence.length, 4);
    const localEvidence = result.retrieval?.evidence.find(source => source.localIndex);
    assert.ok(localEvidence?.localIndex?.fileSha256);
    assert.ok(localEvidence?.locator.includes('版本'));
    assert.equal(result.findings[0].basisStatus, 'source_matched');
    assert.equal(result.findings[0].citations?.[0].matchStatus, 'matched');
    assert.ok(!result.summary.includes(secrets.model));
    const run = store.rows('SELECT * FROM analysis_runs')[0];
    const snapshot = JSON.parse(String(run.retrieval_policy_snapshot_json));
    assert.equal(snapshot.config.knowledge.api.collectionId, 'dataset-one');
    assert.equal(store.getRetrievalConfig()?.knowledge.api.collectionId, 'dataset-two');
    const attempts = store.rows('SELECT a.*,p.kind,p.adapter_id,p.settings_json FROM retrieval_attempts a JOIN provider_profiles p ON p.id=a.provider_profile_id');
    assert.equal(attempts.length, 4);
    assert.deepEqual(attempts.map(row => row.adapter_id).sort(), ['dify','folder','searxng','searxng']);
    assert.ok(attempts.every(row => row.kind === row.channel));
    assert.equal(JSON.parse(String(attempts.find(row => row.adapter_id === 'dify')!.settings_json)).collectionId, 'dataset-one');
    assert.ok(requests.some(request => request.path === '/dify/v1/datasets/dataset-one/retrieve' && request.auth === `Bearer ${secrets.knowledge}`));
    assert.ok(!requests.some(request => request.path.includes('dataset-two')));
    assert.ok(requests.filter(request => request.path.startsWith('/web/')).every(request => request.auth === `Bearer ${secrets.web}`));
    assert.equal(store.rows('SELECT * FROM evidence').length, 4);
    assert.equal(store.rows('SELECT * FROM finding_evidence').length, 1);
    assert.equal(store.rows('SELECT * FROM report_sources WHERE evidence_id IS NOT NULL').length, 4);
    assert.ok(store.rows('SELECT * FROM evidence').every(source => source.verification_status === 'unverified' && source.currentness === 'unknown'));
    const report = store.rows('SELECT * FROM reports')[0]; const manifest = JSON.parse(String(report.input_manifest_json));
    assert.equal(manifest.evidenceIds.length, 4); assert.equal(manifest.modelEvidenceIds.length, 4);
    assert.equal(manifest.evidenceVerificationSnapshots.length, 4);
    const markdown = renderReviewMarkdown(result, document.name);
    assert.ok(markdown.includes('[^source-1]')); assert.ok(markdown.includes('搜索摘要，未取得正文'));
    assert.ok(markdown.includes('未核验')); assert.ok(markdown.includes(String(attempts[0].query)));
    assert.ok(markdown.includes(localEvidence!.localIndex!.fileSha256));
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
    await service.close(); service = undefined; store = undefined;
    const databaseBytes = await readFile(join(dir, 'data/workspace.sqlite'));
    for (const secret of Object.values(secrets)) assert.equal(databaseBytes.includes(Buffer.from(secret)), false);
    store = await AppStore.open(join(dir, 'data'));
    assert.equal(store.getReview(result.id).retrieval?.evidence.length, 4);
    assert.equal(store.getReview(result.id).retrieval?.attempts.length, 4);
    assert.deepEqual(store.getReview(result.id).retrieval?.evidence.find(source => source.id === localEvidence!.id)?.localIndex, localEvidence!.localIndex);
  } finally { await service?.close(); await store?.close(); await closeServer(server); await rm(dir, { recursive: true, force: true }); }
});

test('standard knowledge connection test reads source text but creates no synthetic contract, review or audit run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-retrieval-test-'));
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(request.url!);
    assert.equal(request.headers.authorization, 'Bearer standard-private-key');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/search') {
      assert.ok(String(body.query).includes('服务合同')); assert.equal(body.queryLanguage, 'zh');
      response.end(JSON.stringify({ status: 'complete', candidates: [{ externalSourceId: 'source-one', fragmentId: 'fragment-one', title: '验收规范', snippet: '检索摘要', sourceUri: 'https://example.com/policy', locator: { section: '2' }, sourceVersion: 'v1' }] }));
    } else response.end(JSON.stringify({ externalSourceId: 'source-one', content: '服务合同验收标准与付款前提需要结合具体业务明确。', contentScope: 'fragment', sourceUri: 'https://example.com/policy', locator: { section: '2' } }));
  });
  const baseUrl = await listen(server);
  let store: AppStore | undefined;
  try {
    store = await AppStore.open(join(dir, 'data')); const service = new ContractService(store, join(dir, 'data'));
    const defaults = defaultRetrievalConfig();
    await service.saveRetrievalConfig({ ...defaults, knowledge: { enabled: true, folderPath: null, api: { enabled: true, provider: 'standard', baseUrl, collectionId: 'policies', apiKey: 'standard-private-key' } } });
    const bundle = await service.testRetrieval({ knowledgeApiKey: 'standard-private-key', webApiKey: null });
    assert.equal(bundle.evidence[0].contentScope, 'fragment'); assert.equal(bundle.evidence[0].excerpt.includes('验收标准'), true);
    assert.deepEqual(requests, ['/v1/search', '/v1/sources/read']);
    assert.equal(service.getState().documents.length, 0);
    assert.equal(store.rows('SELECT * FROM analysis_runs').length, 0); assert.equal(store.rows('SELECT * FROM reports').length, 0);
    assert.equal(store.rows('SELECT * FROM retrieval_attempts').length, 0);
    assert.equal(JSON.stringify(store.rows('SELECT * FROM provider_profiles')).includes('standard-private-key'), false);
  } finally { await store?.close(); await closeServer(server); await rm(dir, { recursive: true, force: true }); }
});

test('model failure retains completed retrieval attempts and sources without manufacturing a report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-retrieval-failed-'));
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/dify/')) response.end(JSON.stringify({ records: [{ segment: { id: 's', content: '合同服务验收与付款条件需要业务确认。', document: { id: 'd', name: '测试制度' } } }] }));
    else { response.statusCode = 503; response.end('{}'); }
  });
  const baseUrl = await listen(server);
  let store: AppStore | undefined; let service: ContractService | undefined;
  try {
    store = await AppStore.open(join(dir, 'data'));
    let finish!: (task:ReviewTask)=>void; const completed = new Promise<ReviewTask>(resolve => { finish = resolve; });
    service = new ContractService(store, join(dir, 'data'), task => { if (['completed','failed','cancelled'].includes(task.status)) finish(task); });
    const document = await service.loadSample(); await service.saveConfig(modelSettings(baseUrl));
    const settings = retrievalSettings(baseUrl); settings.web.enabled = false; await service.saveRetrievalConfig(settings);
    await service.startReview({ documentId: document.id, context, mode: 'model' }, null, { knowledgeApiKey: 'knowledge-failure-test-key', webApiKey: null });
    assert.equal((await within(completed)).status, 'failed');
    assert.equal(store.rows('SELECT * FROM retrieval_attempts')[0].status, 'complete');
    assert.equal(store.rows('SELECT * FROM evidence').length, 1); assert.equal(store.rows('SELECT * FROM reports').length, 0);
    const checkpoint = JSON.parse(String(store.rows('SELECT checkpoint_json FROM tasks')[0].checkpoint_json));
    assert.equal(checkpoint.retrievalAudit.knowledgeStatus, 'complete');
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await service?.close(); await store?.close(); await closeServer(server); await rm(dir, { recursive: true, force: true }); }
});

test('closing an active review cancels pending web queries and persists already completed knowledge sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-retrieval-cancel-'));
  let knowledgeReady!: () => void; const knowledgeResponse = new Promise<void>(resolve => { knowledgeReady = resolve; });
  let webReady!: () => void; const webRequest = new Promise<void>(resolve => { webReady = resolve; });
  let modelCalls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    if (request.url?.startsWith('/web/')) { webReady(); return; } // intentionally pending until cancellation
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/dify/')) {
      response.end(JSON.stringify({ records: [{ segment: { id: 's', content: '服务合同验收和付款条件的测试资料。', document: { id: 'd', name: '已取得的内部资料' } } }] }));
      knowledgeReady();
    } else { modelCalls++; response.end('{}'); }
  });
  const baseUrl = await listen(server);
  let store: AppStore | undefined; let service: ContractService | undefined;
  try {
    store = await AppStore.open(join(dir, 'data')); service = new ContractService(store, join(dir, 'data'));
    const document = await service.loadSample(); await service.saveConfig(modelSettings(baseUrl)); await service.saveRetrievalConfig(retrievalSettings(baseUrl));
    await service.startReview({ documentId: document.id, context, mode: 'model' }, null, { knowledgeApiKey: 'cancel-knowledge-key', webApiKey: null });
    await within(Promise.all([knowledgeResponse, webRequest]));
    await new Promise(resolve => setTimeout(resolve, 30));
    await service.close(); service = undefined; store = undefined;
    store = await AppStore.open(join(dir, 'data'));
    assert.equal(store.listTasks()[0].status, 'cancelled');
    const attempts = store.rows('SELECT * FROM retrieval_attempts');
    assert.equal(attempts.length, 3); assert.ok(attempts.some(attempt => attempt.status === 'complete')); assert.ok(attempts.some(attempt => attempt.status === 'cancelled'));
    assert.equal(store.rows('SELECT * FROM evidence').length, 1); assert.equal(store.rows('SELECT * FROM reports').length, 0);
    assert.equal(modelCalls, 0); assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await service?.close(); await store?.close(); await closeServer(server); await rm(dir, { recursive: true, force: true }); }
});

test('close waits for a concurrently starting task before shutting down its SQLite owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-start-close-'));
  let store: AppStore | undefined; let service: ContractService | undefined;
  try {
    store = await AppStore.open(join(dir, 'data')); service = new ContractService(store, join(dir, 'data'));
    const document = await service.loadSample();
    const starting = service.startReview({ documentId: document.id, context, mode: 'local' }, null);
    await Promise.all([starting, service.close()]); service = undefined; store = undefined;
    store = await AppStore.open(join(dir, 'data'));
    assert.equal(store.listTasks()[0].status, 'cancelled');
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await service?.close(); await store?.close(); await rm(dir, { recursive: true, force: true }); }
});
