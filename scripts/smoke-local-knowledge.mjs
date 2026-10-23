import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { defaultRetrievalConfig } from '../src/shared/contracts.ts';
import { createDocx, createPdf } from '../tests/fixtures-documents.ts';

// Native Electron IPC smoke, not @playwright/test. All sources and responses
// are synthetic; API/web retrieval is disabled and the sole model is loopback.
// Run after build: node --import tsx scripts/smoke-local-knowledge.mjs
const root = resolve(import.meta.dirname, '..');
const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'law-agent-local-knowledge-smoke-')));
const folder = join(dataDir, '本地知识资料');
const screenshot = join(root, 'output/playwright/local-knowledge-desktop.png');
await mkdir(folder); await mkdir(join(root, 'output/playwright'), { recursive: true });
const textPath = join(folder, '深处验收条款.txt');
const markdownPath = join(folder, '待删除制度.md');
const docxPath = join(folder, '三语采购制度.docx');
const pdfPath = join(folder, '三语文字资料.pdf');
const addedPath = join(folder, '新增条款.md');
const reportPath = join(dataDir, '本地索引审核报告.md');
const deepPrefix = Array.from({ length: 500 }, (_, index) => `背景资料第${index + 1}段：记录常规业务背景与工作流程。`).join('\n');
const initialText = `${deepPrefix}\n验收标准：交付后需核对深处履约凭据 zkdeeptoken，付款应附书面验收记录。\nincrementaloldtoken\nverifyoldtoken\n`;
await writeFile(textPath, initialText);
await writeFile(markdownPath, '# 可删除的合成资料\n付款审核 deletabletoken。\nผู้ซื้อจะต้องชำระเงินหลังการตรวจรับตามสัญญา');
await writeFile(docxPath, await createDocx({ paragraphs: [
  'docxmarkertoken 采购合同应明确验收标准和付款条件。',
  'Confidentiality obligations survive termination. intellectual property remains protected.',
  'ผู้ซื้อจะต้องชำระเงินหลังการตรวจรับตามสัญญา',
] }));
await writeFile(pdfPath, createPdf([[
  'pdfmarkertoken 付款前确认验收结果。', 'Payment requires acceptance.', 'ผู้ซื้อชำระเงินตามสัญญา',
]]));

const sha256 = value => createHash('sha256').update(value).digest('hex');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const runtimeErrors = [];
const modelErrors = [];
const modelCalls = [];
const rendererNetwork = [];
let app;
let serverListening = false;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, undefined);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const payload = JSON.parse(body.messages[1].content);
    assert.ok(payload.contractBlocks?.length);
    assert.ok(payload.sources?.length, 'Review must receive local indexed source excerpts');
    assert.ok(payload.sources.every(source => source.channel === 'knowledge' && source.sourceUri.startsWith('file:')));
    const block = payload.contractBlocks.find(item => item.text.includes('验收'));
    const source = payload.sources.find(item => /验收|付款/u.test(item.excerpt));
    assert.ok(block && source);
    const quote = source.excerpt.split(/\r?\n/u).find(line => line.trim()).slice(0, 80);
    modelCalls.push({ sourceId: source.id, quote, sourceCount: payload.sources.length });
    const result = {
      summary: '合成联调：已结合持久本地索引资料核对验收安排，仍需人工复核。',
      reviewedBlockIds: payload.contractBlocks.map(item => item.id),
      findings: [{ blockIds: [block.id], quote: block.text, title: '本地索引来源关联检查',
        category: 'commercial', severity: 'medium', description: '合成响应验证引用、文件版本与报告持久化。',
        suggestion: '结合业务事实确认验收和付款条件。', legalBasis: null,
        citations: [{ evidenceId: source.id, quote }] }],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'local-knowledge-smoke', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
  } catch (error) {
    modelErrors.push(error instanceof Error ? error.message : String(error));
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{}');
  }
});

async function launch() {
  const instance = await electron.launch({ args: [root], cwd: root,
    env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 30000 });
  const page = await instance.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('request', request => {
    if (/^https?:/u.test(request.url())) rendererNetwork.push(request.url());
  });
  await page.waitForFunction(() => Boolean(window.contractAssistant));
  await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.contractAssistant.getState())).isPreview, false);
  return { instance, page };
}

async function waitKnowledge(page, jobId = null) {
  const deadline = Date.now() + 90000;
  let latest;
  while (Date.now() < deadline) {
    latest = await page.evaluate(() => window.contractAssistant.getKnowledgeState());
    if (jobId ? latest.job?.id === jobId && latest.job.status !== 'running' : latest.job?.status !== 'running') return latest;
    await sleep(100);
  }
  throw new Error(`Knowledge job did not settle: ${JSON.stringify(latest)}`);
}

async function sync(page, mode) {
  await waitKnowledge(page); // Startup may already have started an incremental refresh.
  const { jobId } = await page.evaluate(mode => window.contractAssistant.startKnowledgeSync(mode), mode);
  const state = await waitKnowledge(page, jobId);
  assert.equal(state.job.status, 'completed', JSON.stringify(state.job));
  assert.equal(state.job.failed, 0, JSON.stringify(state.job.errors));
  assert.equal(state.job.mode, mode);
  assert.equal(state.job.fullScan, true, 'A completed directory traversal permits stale-source deletion');
  return state;
}

async function search(page, query, filePath = null) {
  const result = await page.evaluate(query => window.contractAssistant.searchKnowledge({ query, limit: 20 }), query);
  assert.ok(result.hits.length, `No knowledge hit for ${query}`);
  const hit = filePath ? result.hits.find(item => fileURLToPath(item.sourceUri) === filePath) : result.hits[0];
  assert.ok(hit, `No expected source for ${query}: ${JSON.stringify(result.hits)}`);
  assert.ok(hit.chunkId && hit.sourceFileId && hit.versionId && hit.indexedAt && hit.locator);
  assert.equal(hit.excerptSha256, sha256(hit.excerpt));
  if (filePath) assert.equal(hit.fileSha256, sha256(await readFile(filePath)));
  const read = await page.evaluate(id => window.contractAssistant.getKnowledgeChunk(id), hit.chunkId);
  assert.equal(read.chunkId, hit.chunkId);
  assert.equal(read.excerpt, hit.excerpt);
  assert.equal(read.versionId, hit.versionId);
  assert.equal(read.fileSha256, hit.fileSha256);
  assert.deepEqual(read.location, hit.location);
  return hit;
}

async function assertAbsent(page, query) {
  const result = await page.evaluate(query => window.contractAssistant.searchKnowledge({ query, limit: 20 }), query);
  assert.deepEqual(result.hits, [], `Stale knowledge hit for ${query}`);
}

async function openSettings(page) {
  if (await page.getByRole('button', { name: '展开合同列表', exact: true }).isVisible()) await page.getByRole('button', { name: '展开合同列表', exact: true }).click();
  await page.getByRole('button', { name: '资料连接设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: '资料连接设置', exact: true }).waitFor();
  return dialog;
}

try {
  const opened = await launch(); app = opened.instance; let page = opened.page;
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, folder);
  const chosen = await page.evaluate(() => window.contractAssistant.selectKnowledgeFolder());
  assert.equal(chosen, folder, 'Folder must be authorized through the native dialog IPC');
  const config = defaultRetrievalConfig();
  config.knowledge.enabled = true; config.knowledge.folderPath = chosen;
  config.knowledge.api.enabled = false; config.web.enabled = false; config.maxResults = 8;
  await page.evaluate(config => window.contractAssistant.saveRetrievalConfig(config), config);
  const initialState = await sync(page, 'incremental');
  assert.equal(initialState.engine, 'sqlite-fts5');
  assert.equal(initialState.indexedFiles, 4);
  assert.ok(initialState.chunks > 4 && initialState.lastSyncedAt);

  const deep = await search(page, 'zkdeeptoken', textPath);
  assert.match(deep.excerpt, /深处履约凭据/u);
  assert.equal(deep.location.kind, 'text');
  assert.ok(deep.location.lineStart > 300, JSON.stringify(deep.location));
  await search(page, '验收标准', textPath);
  await search(page, 'confidentiality', docxPath);
  await search(page, 'ชำระเงิน', docxPath);
  await search(page, 'docxmarkertoken', docxPath);
  const pdf = await search(page, 'pdfmarkertoken', pdfPath);
  assert.equal(pdf.location.kind, 'pdf');
  await search(page, 'deletabletoken', markdownPath);
  console.log('Native local index: TXT/MD/DOCX/PDF and deep/trilingual retrieval passed');

  const changedText = initialText.replace('incrementaloldtoken', 'incrementalnewtoken');
  await writeFile(textPath, changedText);
  await writeFile(addedPath, '# 新增资料\ninsertedtoken：服务采购付款需附验收记录。');
  await rm(markdownPath);
  const incremental = await sync(page, 'incremental');
  assert.equal(incremental.indexedFiles, 4);
  assert.ok(incremental.job.indexed >= 2 && incremental.job.deleted >= 1, JSON.stringify(incremental.job));
  const updated = await search(page, 'incrementalnewtoken', textPath);
  assert.notEqual(updated.fileSha256, deep.fileSha256);
  assert.notEqual(updated.versionId, deep.versionId);
  await search(page, 'insertedtoken', addedPath);
  await assertAbsent(page, 'incrementaloldtoken'); await assertAbsent(page, 'deletabletoken');

  // Same-size content replacement with restored timestamps must be caught by verify.
  const priorStat = await stat(textPath);
  const verifiedText = changedText.replace('verifyoldtoken', 'verifynewtoken');
  assert.equal(Buffer.byteLength(changedText), Buffer.byteLength(verifiedText));
  await writeFile(textPath, verifiedText); await utimes(textPath, priorStat.atime, priorStat.mtime);
  const verified = await sync(page, 'verify');
  await search(page, 'verifynewtoken', textPath); await assertAbsent(page, 'verifyoldtoken');
  const stableDeep = await search(page, 'zkdeeptoken', textPath);
  console.log('Incremental add/update/delete and full content verification passed');

  await app.close(); app = undefined;
  const restarted = await launch(); app = restarted.instance; page = restarted.page;
  const persistent = await waitKnowledge(page);
  assert.equal(persistent.folderPath, folder);
  assert.equal(persistent.indexedFiles, 4);
  const restoredDeep = await search(page, 'zkdeeptoken', textPath);
  assert.equal(restoredDeep.chunkId, stableDeep.chunkId);
  assert.equal(restoredDeep.versionId, stableDeep.versionId);
  assert.equal(restoredDeep.fileSha256, stableDeep.fileSha256);
  await search(page, 'verifynewtoken', textPath); await assertAbsent(page, 'deletabletoken');
  console.log('Persistent index reopened after Electron restart');

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); serverListening = true;
  const modelBase = `http://127.0.0.1:${server.address().port}/v1`;
  await page.evaluate(baseUrl => window.contractAssistant.saveModelConfig({ name: '本地知识索引联调', baseUrl,
    model: 'local-knowledge-smoke', responseFormat: 'json_object', tokenParameter: 'max_tokens',
    maxOutputTokens: 4096, contextWindowTokens: 65536, timeoutSeconds: 20 }), modelBase);
  const contract = await page.evaluate(() => window.contractAssistant.loadSample());
  const { taskId } = await page.evaluate(id => window.contractAssistant.startReview({ documentId: id, mode: 'model',
    context: { contractType: 'service', ourPartyRole: 'buyer', strictness: 'balanced', businessContext: '合成索引联调，不使用云端服务。' } }), contract.id);
  const reviewDeadline = Date.now() + 60000;
  let task;
  do {
    task = (await page.evaluate(() => window.contractAssistant.getState())).tasks.find(item => item.id === taskId);
    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) break;
    await sleep(100);
  } while (Date.now() < reviewDeadline);
  assert.equal(task?.status, 'completed', JSON.stringify(task));
  const detail = await page.evaluate(id => window.contractAssistant.getDocument(id), contract.id);
  const review = detail.reviews.find(item => item.mode === 'model');
  assert.ok(review?.retrieval?.evidence.length);
  const localSources = review.retrieval.evidence.filter(item => item.localIndex);
  assert.ok(localSources.length);
  assert.ok(review.retrieval.evidence.every(item => item.localIndex && item.sourceUri.startsWith('file:')));
  for (const source of localSources) {
    assert.equal(source.localIndex.fileSha256, sha256(await readFile(fileURLToPath(source.sourceUri))));
    assert.equal(source.excerptSha256, sha256(source.excerpt));
    assert.ok(source.localIndex.versionId && source.localIndex.chunkId && source.localIndex.indexedAt);
  }
  assert.equal(review.findings[0].basisStatus, 'source_matched');
  assert.equal(review.findings[0].citations[0].matchStatus, 'matched');
  assert.equal(review.findings[0].citations[0].quote, modelCalls[0].quote);
  await page.reload();
  await page.getByRole('heading', { name: '本地索引来源关联检查', exact: true }).waitFor();
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, reportPath);
  await page.getByRole('button', { name: '导出报告', exact: true }).click();
  await page.getByText(`报告已导出：${reportPath}`).waitFor();
  const report = await readFile(reportPath, 'utf8');
  assert.ok(report.includes(localSources[0].localIndex.fileSha256));
  assert.ok(report.includes(localSources[0].localIndex.versionId));
  assert.ok(report.includes(modelCalls[0].quote));

  const layouts = [];
  for (const [width, height] of [[1440, 900], [1024, 700], [760, 560]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]);
    const dialog = await openSettings(page);
    const query = dialog.getByLabel(/^测试本地资料检索/u);
    await query.fill('zkdeeptoken');
    await dialog.getByRole('button', { name: '检索', exact: true }).click();
    await dialog.locator('.knowledge-hit').filter({ hasText: '深处履约凭据' }).waitFor();
    // Capture a compact real hit so the screenshot includes readable results,
    // rather than leaving the deep TXT chunk below the scrolling panel fold.
    await query.fill('docxmarkertoken');
    await dialog.getByRole('button', { name: '检索', exact: true }).click();
    const visibleHit = dialog.locator('.knowledge-hit').filter({ hasText: '三语采购制度' });
    await visibleHit.waitFor();
    const layout = await dialog.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const body = element.querySelector('.settings-body');
      const footer = element.querySelector('.settings-footer')?.getBoundingClientRect();
      const panel = element.querySelector('.local-knowledge-panel');
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
        dialogLeft: bounds.left, dialogRight: bounds.right, dialogWidth: element.clientWidth, dialogScrollWidth: element.scrollWidth,
        bodyWidth: body?.clientWidth, bodyScrollWidth: body?.scrollWidth,
        panelWidth: panel?.clientWidth, panelScrollWidth: panel?.scrollWidth,
        footerBottom: footer?.bottom };
    });
    assert.ok(layout.documentWidth <= width + 1, JSON.stringify(layout));
    assert.ok(layout.dialogLeft >= -1 && layout.dialogRight <= width + 1, JSON.stringify(layout));
    assert.ok(layout.dialogScrollWidth <= layout.dialogWidth + 1, JSON.stringify(layout));
    assert.ok(layout.bodyScrollWidth <= layout.bodyWidth + 1 && layout.panelScrollWidth <= layout.panelWidth + 1, JSON.stringify(layout));
    assert.ok(layout.footerBottom <= height + 1, JSON.stringify(layout));
    await visibleHit.scrollIntoViewIfNeeded();
    await page.screenshot({ path: width === 1440 ? screenshot : join(root, `output/playwright/local-knowledge-${width}x${height}.png`) });
    layouts.push(layout);
    await dialog.getByRole('button', { name: '关闭资料连接设置', exact: true }).click();
  }
  assert.equal(modelCalls.length, 1);
  assert.deepEqual(modelErrors, []); assert.deepEqual(runtimeErrors, []);
  assert.deepEqual(rendererNetwork, [], 'Packaged renderer must not request public resources');
  console.log(JSON.stringify({ passed: true, sources: ['txt', 'md', 'docx', 'pdf'], languages: ['zh', 'en', 'th'],
    initialFiles: initialState.indexedFiles, deepLine: deep.location.lineStart, incrementalJob: incremental.job,
    verifyJob: verified.job, persistentChunkId: stableDeep.chunkId, sourceVersionAndHashPersisted: true,
    quotedReportExported: true, loopbackModelRequests: modelCalls.length, cloudRequestsConfigured: false,
    layouts, screenshot, temporaryDataDir: dataDir }, null, 2));
} finally {
  await app?.close(); server.closeAllConnections();
  if (serverListening) await new Promise(resolve => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
