import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import initSqlJs from 'sql.js';
import { defaultRetrievalConfig } from '../src/shared/contracts.ts';

// LIVE official-site smoke; run explicitly after build:
// node --import tsx scripts/smoke-official.mjs 市场
// Only the model endpoint is a local synthetic responder. The official catalog
// and article HTML must be fetched by the real Electron Core worker. No detail
// URL is prefilled: the first test starts with sourceUrls=[] and discovers URLs
// from the live catalog. The review then explicitly reuses those discovered URLs
// to keep its citation plumbing independent of contract-topic matching quality.
// This verifies retrieval/citation wiring, not model reasoning or legal validity.
const root = resolve(import.meta.dirname, '..');
const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'law-agent-official-smoke-')));
assert.notEqual(dataDir, resolve(root, '.local/data'));
const query = process.argv[2] || '市场';
assert.ok(query.trim().length >= 2 && query.length <= 120 && !/[\u0000-\u001f]/u.test(query));
const errors = [];
const rendererNetwork = [];
const modelCalls = [];
let app;

const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  try {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, undefined);
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.tools, undefined);
    const payload = JSON.parse(body.messages[1].content);
    const originals = payload.sources.filter(source => source.isOfficial && source.contentScope !== 'search_snippet');
    assert.ok(originals.length, 'The model must receive real official-page text');
    modelCalls.push({ sourceIds: payload.sources.map(source => source.id), blocks: payload.contractBlocks.length });
    const content = { summary: '本机模拟模型仅验证官方资料读取与引用回溯；不构成法律分析验收。',
      reviewedBlockIds: payload.contractBlocks.map(block => block.id), findings: [{
        blockIds: [payload.contractBlocks[0].id], quote: payload.contractBlocks[0].text,
        title: '官方来源引用回溯联调', category: 'operational', severity: 'unrated',
        description: '工程联调返回；本次不判断所引资料与示例合同的法律适用关系。', suggestion: '由法务核验资料时效及适用性。', legalBasis: null,
        citations: originals.slice(0, 2).map(source => ({ evidenceId: source.id, quote: source.excerpt.slice(0, 160) })),
      }] };
    response.end(JSON.stringify({ model: 'local-official-smoke-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  } catch (error) {
    errors.push(error.message); response.statusCode = 500; response.end(JSON.stringify({ error: 'Local smoke fixture failed' }));
  }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const modelBase = `http://127.0.0.1:${server.address().port}/v1`;

async function launch() {
  const instance = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 30000 });
  app = instance;
  assert.equal(await instance.evaluate(({ app }) => app.getPath('userData')), dataDir);
  const page = await instance.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) rendererNetwork.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.contractAssistant));
  await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.contractAssistant.getState())).isPreview, false);
  return { instance, page };
}

try {
  let opened = await launch(); app = opened.instance; let page = opened.page;
  const config = defaultRetrievalConfig();
  config.official = { enabled: true, maxCatalogPages: 1, sourceUrls: [] };
  config.knowledge.enabled = false; config.web.enabled = false; config.maxResults = 2; config.timeoutSeconds = 20;
  await page.evaluate(input => window.contractAssistant.saveRetrievalConfig(input), config);
  const before = await page.evaluate(() => window.contractAssistant.getState());
  const discovery = await page.evaluate(query => window.contractAssistant.testOfficialRetrieval({ query }), query);
  assert.equal(modelCalls.length, 0, 'Official connection test must not invoke a model');
  const after = await page.evaluate(() => window.contractAssistant.getState());
  assert.equal(after.documents.length, before.documents.length);
  assert.equal(after.tasks.length, before.tasks.length);
  const attempt = discovery.attempts.find(item => item.provider === 'official_catalog');
  assert.ok(attempt?.coverage?.catalogPagesRead >= 1, JSON.stringify(discovery.limitations));
  assert.ok(discovery.evidence.length > 0, `No readable official source for ${query}: ${JSON.stringify(discovery.attempts)}`);
  assert.equal(attempt.coverage.userUrlsRequested, 0);
  assert.ok(discovery.evidence.every(source => source.officialMetadata?.discoveredVia === 'catalog'));
  assert.ok(discovery.evidence.every(source => source.sourceUri?.startsWith('https://xzfg.moj.gov.cn/front/law/detail?LawID=')));
  assert.ok(discovery.evidence.every(source => source.currentness === 'unknown' && source.contentScope !== 'search_snippet'));
  for (const source of discovery.evidence) assert.equal(createHash('sha256').update(source.excerpt).digest('hex'), source.excerptSha256);

  const discoveredUrls = [...new Set(discovery.evidence.map(source => source.sourceUri))];
  config.official.sourceUrls = discoveredUrls;
  await page.evaluate(input => window.contractAssistant.saveRetrievalConfig(input), config);
  await page.evaluate(baseUrl => window.contractAssistant.saveModelConfig({ name: '仅用于工程联调的本机模拟模型', baseUrl, model: 'local-official-smoke-model',
    responseFormat: 'json_object', tokenParameter: 'max_tokens', maxOutputTokens: 4096, contextWindowTokens: 65536, timeoutSeconds: 30 }), modelBase);
  const document = await page.evaluate(() => window.contractAssistant.loadSample());
  const pending = await page.evaluate(documentId => window.contractAssistant.startReview({ documentId, mode: 'model', context: {
    contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '明确虚构样例；仅做来源引用回溯联调，不做法律判断。',
  } }), document.id);
  let state;
  const deadline = Date.now() + 120000;
  do {
    state = await page.evaluate(() => window.contractAssistant.getState());
    if (state.tasks.some(task => task.id === pending.taskId && ['completed', 'failed', 'cancelled'].includes(task.status))) break;
    if (Date.now() >= deadline) throw new Error(`Review exceeded the smoke budget: ${JSON.stringify(state.tasks)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (true);
  const task = state.tasks.find(item => item.id === pending.taskId);
  assert.equal(task?.status, 'completed', task?.error || 'Review did not complete');
  const review = (await page.evaluate(id => window.contractAssistant.getDocument(id), document.id)).reviews.find(item => item.id === task.resultId);
  assert.ok(review?.retrieval?.evidence.length);
  assert.equal(modelCalls.length, 1);
  assert.deepEqual(review.retrieval.modelEvidenceIds, modelCalls[0].sourceIds);
  assert.equal(review.findings[0].basisStatus, 'source_matched');
  assert.ok(review.findings[0].citations.length > 0);
  assert.ok(review.findings[0].citations.every(citation => citation.matchStatus === 'matched'));
  assert.ok(review.retrieval.evidence.every(source => source.currentness === 'unknown'));
  assert.ok(review.coverage.limitations.some(note => /效力|时效/u.test(note) && /未|待|未知/u.test(note)));
  const reportPath = join(dataDir, '官方来源回溯联调报告.md');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, reportPath);
  const exported = await page.evaluate(id => window.contractAssistant.exportReview(id), review.id);
  assert.equal(exported?.path, reportPath);
  const markdown = await readFile(reportPath, 'utf8');
  assert.ok(markdown.includes('本机模拟模型'));
  assert.ok(markdown.includes('xzfg.moj.gov.cn'));
  assert.ok(markdown.includes('[^source-'));
  await app.close(); app = undefined;

  opened = await launch(); app = opened.instance; page = opened.page;
  const restored = (await page.evaluate(id => window.contractAssistant.getDocument(id), document.id)).reviews.find(item => item.id === review.id);
  assert.deepEqual(restored.findings[0].citations, review.findings[0].citations);
  assert.deepEqual(restored.retrieval.modelEvidenceIds, review.retrieval.modelEvidenceIds);
  assert.deepEqual(restored.retrieval.attempts, review.retrieval.attempts);
  for (const source of review.retrieval.evidence) assert.deepEqual(restored.retrieval.evidence.find(item => item.id === source.id)?.officialMetadata, source.officialMetadata);
  await page.screenshot({ path: join(dataDir, 'official-smoke.png'), fullPage: true });
  await app.close(); app = undefined;
  const SQL = await initSqlJs(); const db = new SQL.Database(await readFile(join(dataDir, 'workspace.sqlite')));
  assert.deepEqual(db.exec('PRAGMA foreign_key_check'), []); db.close();
  assert.deepEqual(errors, []); assert.deepEqual(rendererNetwork, []);
  console.log(JSON.stringify({ passed: true, liveOfficialDiscovery: true, prefilledDetailUrls: false, reviewReusesDiscoveredUrls: true,
    syntheticLocalModelOnly: true, legalValidityVerified: false, query, dataDir, reportPath, screenshot: join(dataDir, 'official-smoke.png'),
    discoveryCoverage: attempt.coverage, sources: discovery.evidence.map(source => ({ title: source.title, url: source.sourceUri, publishedAt: source.publishedAt, effectiveAt: source.effectiveAt, currentness: source.currentness })),
    reviewEvidence: review.retrieval.evidence.length, matchedCitations: review.findings[0].citations.length, restored: true }, null, 2));
} finally {
  await app?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
