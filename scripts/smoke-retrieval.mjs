import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import initSqlJs from 'sql.js';
import { defaultRetrievalConfig } from '../src/shared/contracts.ts';

// All API responses and local documents are synthetic. No real search/model key
// is required and no public website is requested by this desktop smoke.
const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-retrieval-smoke-'));
const folder = join(dataDir, '客户制度'); await mkdir(folder);
await writeFile(join(folder, '服务采购制度.md'), '# 服务采购制度（虚构联调材料）\n服务采购付款前，业务部门必须书面确认验收结果。\n付款申请应附验收记录。');
const apiExcerpt = '外部知识库联调制度：服务验收应留存书面确认记录，付款前应核对验收结果。';
const fakeKey = 'synthetic-knowledge-key-for-desktop-smoke';
const calls = [];
let holdSearch = false;
let app;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let raw = ''; for await (const part of req) raw += part;
  const body = raw ? JSON.parse(raw) : null;
  calls.push({ path: url.pathname, query: url.searchParams.get('q') ?? body?.query ?? '', authorization: req.headers.authorization });
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname.endsWith('/datasets/smoke-dataset/retrieve')) {
    if (req.headers.authorization !== `Bearer ${fakeKey}`) { res.writeHead(401); res.end('{}'); return; }
    res.end(JSON.stringify({ records: [{ score: 0.9, segment: { id: 'segment-smoke', content: apiExcerpt, document: { id: 'doc-smoke', name: '外部知识库制度（虚构联调）' } } }] })); return;
  }
  if (url.pathname === '/search') {
    assert.equal(req.headers.authorization, undefined);
    if (holdSearch) return; // Abort by quitting the app; no completion is fabricated.
    res.end(JSON.stringify({ query: url.searchParams.get('q'), results: [
      { title: '法律法规来源（虚构搜索响应）', url: 'https://www.gov.cn/test-only/legal-source', content: '虚构搜索摘要：服务合同履约及验收相关法律资料线索，需读取原文核实。' },
      { title: '案例来源（虚构搜索响应）', url: 'https://www.court.gov.cn/test-only/case-source', content: '虚构搜索摘要：服务验收争议案例线索，需确认事实与法律适用。' },
    ] })); return;
  }
  if (url.pathname === '/v1/chat/completions') {
    const payload = JSON.parse(body.messages[1].content);
    const block = payload.contractBlocks.find(item => item.text.includes('验收：'));
    const sources = payload.sources;
    const finding = { blockIds: [block.id], quote: block.text, title: '依据来源核对验收安排', category: 'commercial', severity: 'medium', description: '虚构模型响应，用于验证来源关联，不代表法律结论。', suggestion: '结合来源原文和业务事实复核验收程序。', legalBasis: '引用来源的效力及适用范围仍待人工复核。', citations: sources.map(source => ({ evidenceId: source.id, quote: source.excerpt.slice(0, Math.min(50, source.excerpt.length)) })) };
    res.end(JSON.stringify({ model: 'retrieval-smoke-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '并行取得本地制度、外部知识库和搜索线索。', reviewedBlockIds: payload.contractBlocks.map(item => item.id), findings: [finding] }) } }] })); return;
  }
  res.writeHead(404); res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const errors = [];
async function launch() {
  const instance = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 30000 });
  const page = await instance.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.contractAssistant));
  await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  return { instance, page };
}
try {
  const opened = await launch(); app = opened.instance; const page = opened.page;
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, folder);
  const chosen = await page.evaluate(() => window.contractAssistant.selectKnowledgeFolder());
  const config = defaultRetrievalConfig();
  config.knowledge.enabled = true; config.knowledge.folderPath = chosen;
  config.knowledge.api = { ...config.knowledge.api, enabled: true, provider: 'dify', baseUrl: `${base}/v1`, collectionId: 'smoke-dataset', apiKey: fakeKey };
  config.web = { ...config.web, enabled: true, provider: 'searxng', baseUrl: `${base}/search`, fetchPages: false };
  await page.evaluate(config => window.contractAssistant.saveRetrievalConfig(config), config);
  const knowledgeJob = await page.evaluate(() => window.contractAssistant.startKnowledgeSync('incremental'));
  await page.waitForFunction(async jobId => {
    const state = await window.contractAssistant.getKnowledgeState();
    if (state.job?.id !== jobId || state.job.status === 'running') return false;
    if (state.job.status !== 'completed') throw new Error(JSON.stringify(state.job));
    return state.indexedFiles === 1;
  }, knowledgeJob.jobId);
  await page.evaluate(base => window.contractAssistant.saveModelConfig({ name: '本机检索联调模型', baseUrl: `${base}/v1`, model: 'retrieval-smoke-model', responseFormat: 'json_object', tokenParameter: 'max_tokens', maxOutputTokens: 4096, contextWindowTokens: 65536, timeoutSeconds: 30 }), base);
  const document = await page.evaluate(() => window.contractAssistant.loadSample());
  await page.evaluate(id => window.contractAssistant.startReview({ documentId: id, mode: 'model', context: { contractType: 'service', ourPartyRole: 'buyer', strictness: 'balanced', businessContext: '私密企业名称和金额不应发送给搜索服务。' } }), document.id);
  await page.evaluate(() => new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const poll = async () => {
      try {
        const state = await window.contractAssistant.getState();
        if (state.tasks.some(task => ['completed', 'failed'].includes(task.status))) return resolve(null);
        if (Date.now() > deadline) return reject(new Error('Desktop retrieval task timed out'));
        setTimeout(poll, 50);
      } catch (error) { reject(error); }
    };
    void poll();
  }));
  const state = await page.evaluate(() => window.contractAssistant.getState());
  assert.equal(state.tasks[0].status, 'completed', state.tasks[0].error || '');
  const review = (await page.evaluate(id => window.contractAssistant.getDocument(id), document.id)).reviews[0];
  assert.ok(review.retrieval.evidence.some(item => item.channel === 'knowledge' && item.sourceUri?.startsWith('file:')));
  assert.ok(review.retrieval.evidence.some(item => item.localIndex?.fileSha256 && item.localIndex?.versionId));
  assert.ok(review.retrieval.evidence.some(item => item.excerpt.includes('外部知识库联调制度')));
  assert.ok(review.retrieval.evidence.some(item => item.channel === 'web' && item.contentScope === 'search_snippet'));
  assert.ok(review.retrieval.attempts.some(item => item.provider === 'folder'));
  assert.ok(review.retrieval.attempts.some(item => item.provider === 'dify'));
  assert.ok(review.retrieval.attempts.some(item => item.provider === 'searxng'));
  assert.equal(review.findings[0].basisStatus, 'source_matched');
  assert.ok(review.findings[0].citations.length >= 3);
  assert.ok(review.findings[0].citations.every(item => item.matchStatus === 'matched'));
  assert.ok(state.retrievalConfig.knowledge.api.hasApiKey);
  assert.ok(!JSON.stringify(state).includes(fakeKey));
  assert.ok(!JSON.stringify(review).includes(fakeKey));
  const searchCalls = calls.filter(item => item.path === '/search');
  assert.ok(searchCalls.length >= 2);
  assert.ok(searchCalls.every(item => !item.query.includes('示例制造') && !item.query.includes('100,000') && !item.query.includes('私密企业名称')));
  await page.reload();
  await page.getByRole('heading', { name: '依据来源核对验收安排' }).waitFor();
  await mkdir(join(root, 'output/playwright'), { recursive: true });
  await page.screenshot({ path: join(root, 'output/playwright/desktop-retrieval.png'), fullPage: true });
  const reportPath = join(dataDir, '带来源审核报告.md');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, reportPath);
  await page.getByRole('button', { name: '导出报告', exact: true }).click();
  await page.getByText(`报告已导出：${reportPath}`).waitFor();
  const report = await readFile(reportPath, 'utf8');
  assert.ok(report.includes('外部知识库联调制度'));
  assert.ok(report.includes('www.court.gov.cn'));
  await app.close(); app = undefined;
  const restarted = await launch(); app = restarted.instance;
  const restored = await restarted.page.evaluate(id => window.contractAssistant.getDocument(id), document.id);
  assert.equal(restored.reviews[0].retrieval.evidence.length, review.retrieval.evidence.length);
  assert.equal(restored.reviews[0].findings[0].citations.length, review.findings[0].citations.length);
  assert.ok(!(await readFile(join(dataDir, 'workspace.sqlite'))).includes(Buffer.from(fakeKey)));
  const layouts = [];
  for (const [width, height] of [[1440, 900], [1024, 700], [800, 560], [760, 560]]) {
    await app.evaluate(({ BrowserWindow }, size) => { BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]); }, [width, height]);
    await restarted.page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]);
    const layout = await restarted.page.evaluate(() => {
      const bar = document.querySelector('.topbar').getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, barTop: bar.top, barBottom: bar.bottom };
    });
    assert.equal(layout.scrollWidth, layout.clientWidth);
    assert.ok(layout.barTop >= 0 && layout.barBottom <= height);
    if (await restarted.page.getByRole('button', { name: '展开合同列表' }).isVisible()) await restarted.page.getByRole('button', { name: '展开合同列表' }).click();
    await restarted.page.getByRole('button', { name: '资料连接设置', exact: true }).click();
    const settings = restarted.page.getByRole('dialog');
    await settings.getByRole('heading', { name: '资料连接设置', exact: true }).waitFor();
    const footer = await settings.locator('.settings-footer').boundingBox();
    assert.ok(footer && footer.y >= 0 && footer.y + footer.height <= height + 1);
    assert.equal(await settings.getByLabel(/^知识库 API 密钥/).inputValue(), '');
    await settings.getByRole('button', { name: '关闭资料连接设置' }).click();
    if (await restarted.page.getByRole('button', { name: '收起合同列表', exact: true }).isVisible()) await restarted.page.getByRole('button', { name: '收起合同列表', exact: true }).click();
    await restarted.page.screenshot({ path: join(root, `output/playwright/desktop-responsive-${width}x${height}.png`) });
    layouts.push(`${width}x${height}`);
  }
  holdSearch = true;
  const previousSearches = calls.filter(item => item.path === '/search').length;
  const pending = await restarted.page.evaluate(id => window.contractAssistant.startReview({ documentId: id, mode: 'model', context: { contractType: 'service', ourPartyRole: 'buyer', strictness: 'balanced', businessContext: '正常退出时取消未完成查询，保留已返回资料。' } }), document.id);
  const waitingDeadline = Date.now() + 5000;
  while (calls.filter(item => item.path === '/search').length < previousSearches + 2) {
    if (Date.now() > waitingDeadline) throw new Error('Pending search requests did not start');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  await app.close(); app = undefined;
  const SQL = await initSqlJs(); const database = new SQL.Database(await readFile(join(dataDir, 'workspace.sqlite')));
  const checkpoint = database.exec(`SELECT status FROM tasks WHERE id='${pending.taskId}'`)[0].values[0][0];
  assert.equal(checkpoint, 'cancelled');
  const retained = database.exec(`SELECT COUNT(*) FROM evidence e JOIN tasks t ON t.analysis_run_id=e.analysis_run_id WHERE t.id='${pending.taskId}'`)[0].values[0][0];
  assert.ok(retained >= 1, 'Graceful quit must save completed knowledge sources');
  assert.deepEqual(database.exec('PRAGMA foreign_key_check'), []); database.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, providers: [...new Set(review.retrieval.attempts.map(item => item.provider))], evidence: review.retrieval.evidence.length, citations: review.findings[0].citations.length, queriesExcludePrivateFacts: true, exportedAndRestoredSources: true, gracefulQuitRetainsEvidence: true, layouts, screenshot: 'output/playwright/desktop-retrieval.png' }, null, 2));
} finally {
  await app?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
