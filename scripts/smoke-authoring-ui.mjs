import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { _electron as electron } from 'playwright';
import { createDocx } from '../tests/fixtures-documents.ts';
import { parseContract } from '../src/core/documents.ts';
import { createPreviewBridge } from '../src/renderer/src/preview-bridge.ts';

// Isolated UI acceptance. The only model endpoint is a loopback mock; all DOCX
// files and application data are synthetic temporary artifacts.
const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-authoring-ui-'));
const exportDir = await mkdtemp(join(tmpdir(), 'law-agent-authoring-export-'));
const inputPath = join(dataDir, '原合同-起草联调.docx');
const originalText = '付款条件：验收后支付全部款项。';
const replacementText = '付款条件：双方书面确认验收结果后支付全部款项。';
const oldInsertion = '<w:ins w:id="81" w:author="原修订作者" w:date="2020-01-01T00:00:00Z"><w:r><w:t xml:space="preserve">原有插入修订保留。</w:t></w:r></w:ins>';
const bytes = await createDocx({ paragraphs: ['起草与修订工程联调', originalText], rawBody: `<w:p>${oldInsertion}</w:p>` });
await writeFile(inputPath, bytes); const originalHash = createHash('sha256').update(bytes).digest('hex');
const languages = {
  zh: { title: '技术服务合同草稿（联调）', heading: '第一条 服务与验收', paragraph: '甲方：[待填写]；乙方：[待填写]。服务范围及验收标准由双方书面确认。', missing: '双方名称及付款金额待填写。', warning: '请由法务核对交易事实和法律适用。' },
  en: { title: 'Service Agreement Draft', heading: 'Services and acceptance', paragraph: 'Client: [to complete]. Provider: [to complete]. The parties shall confirm the scope and acceptance criteria in writing.', missing: 'Complete the party names and payment amount.', warning: 'Legal counsel must review the facts and applicable law.' },
  th: { title: 'ร่างสัญญาบริการ', heading: 'ขอบเขตบริการและการตรวจรับ', paragraph: 'ผู้ว่าจ้าง: [ต้องกรอก] ผู้ให้บริการ: [ต้องกรอก] คู่สัญญาจะยืนยันขอบเขตบริการและหลักเกณฑ์การตรวจรับเป็นลายลักษณ์อักษร', missing: 'ต้องกรอกชื่อคู่สัญญาและจำนวนเงิน', warning: 'ที่ปรึกษากฎหมายต้องตรวจสอบข้อเท็จจริงและกฎหมายที่ใช้บังคับ' },
};
let hold = false; let failNext = false; const held = []; const calls = [];
const send = (response, output) => { if (response.destroyed) return; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ model: 'authoring-loopback-mock', usage: { prompt_tokens: 123, completion_tokens: 234 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] })); };
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); assert.equal(body.response_format.json_schema.name, 'contract_generation_draft'); const payload = JSON.parse(body.messages.findLast(item => item.role === 'user').content); calls.push(payload);
    if (failNext) { failNext = false; send(response, { invalid: true }); return; }
    const words = languages[payload.language]; assert.ok(words);
    const output = { title: words.title, clauses: [{ heading: words.heading, paragraphs: [words.paragraph] }], missingInformation: [words.missing], warnings: [words.warning] };
    if (hold) { held.push({ response, output }); return; } send(response, output);
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ message: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = []; const rendererNetwork = []; const layouts = [];
let app; let page;
async function launch() {
  app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 30000 });
  await app.evaluate(({ app, BrowserWindow }) => { const isolate = window => { window.webContents.setBackgroundThrottling(false); window.setFocusable(false); window.hide(); }; app.on('browser-window-created', (_event, window) => isolate(window)); for (const window of BrowserWindow.getAllWindows()) isolate(window); });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/u.test(request.url())) rendererNetwork.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.contractAssistant)); await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
}
async function poll(read, predicate, label) { const deadline = Date.now() + 20000; while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await sleep(25); } throw new Error(`Timed out: ${label}`); }
const getDrafts = () => page.evaluate(() => window.contractAssistant.listContractDrafts());
const getState = () => page.evaluate(() => window.contractAssistant.getState());
const dialog = () => page.getByRole('dialog', { name: '描述生成合同', exact: true });
async function openGeneration() {
  const opener = page.getByRole('button', { name: '展开合同列表', exact: true });
  if (await opener.isVisible() && !await page.locator('.app-shell').evaluate(element => element.classList.contains('sidebar-is-open'))) await opener.click();
  await page.locator('.generation-launch-button').click(); await dialog().waitFor();
  await poll(() => dialog().getByRole('button', { name: '刷新合同草稿', exact: true }).isEnabled(), Boolean, 'draft history ready');
}
async function setSavePath(path) { await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path); }
async function screenshotDialog(width, height, suffix) {
  await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(0, 560); window.setContentSize(...size); }, [width, height]); await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]);
  const layout = await dialog().evaluate(element => ({ doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, width: element.scrollWidth, clientWidth: element.clientWidth })); assert.ok(layout.doc <= layout.client + 1 && layout.width <= layout.clientWidth + 1, JSON.stringify(layout));
  await mkdir(join(root, 'output/playwright'), { recursive: true }); const path = join(root, `output/playwright/authoring-${suffix}-${width}.png`); await page.screenshot({ path, animations: 'disabled' }); layouts.push({ width, height, path });
  if (width <= 900) { await dialog().locator('.generation-draft').scrollIntoViewIfNeeded(); const previewPath = join(root, `output/playwright/authoring-preview-${width}.png`); await page.screenshot({ path: previewPath, animations: 'disabled' }); layouts.push({ width, height, path: previewPath }); }
}
try {
  await launch();
  await page.evaluate(baseUrl => window.contractAssistant.saveModelConfig({ name: '本机起草假模型', baseUrl, model: 'authoring-loopback-mock', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 4096, contextWindowTokens: 65536, timeoutSeconds: 20 }), baseUrl);
  await page.reload(); await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, inputPath); await page.locator('.import-button').click();
  const imported = await poll(getState, state => state.documents.some(item => item.name === '原合同-起草联调.docx'), 'original imported'); const original = imported.documents.find(item => item.name === '原合同-起草联调.docx');
  await page.locator('.document-item.active strong[title="原合同-起草联调.docx"]').waitFor();
  await openGeneration(); const description = '我方委托服务商提供系统维护服务，需要明确服务范围、验收、付款和保密安排，未知事实保留待填写。';
  await dialog().getByLabel('合同需求描述', { exact: true }).fill(description);
  failNext = true; await dialog().getByRole('button', { name: '生成合同草稿', exact: true }).click(); await dialog().getByRole('alert').waitFor(); assert.equal(await dialog().getByLabel('合同需求描述', { exact: true }).inputValue(), description); assert.equal((await getDrafts()).length, 0);
  for (const [language, count] of [['zh', 1], ['en', 2], ['th', 3]]) {
    await dialog().getByLabel('合同语言', { exact: true }).selectOption(language); await dialog().getByRole('button', { name: '生成合同草稿', exact: true }).click();
    await poll(getDrafts, values => values.length === count, `${language} generated`); await dialog().getByRole('heading', { name: languages[language].title, exact: true }).waitFor();
    assert.ok((await dialog().locator('.generation-clauses').innerText()).includes(languages[language].paragraph));
    assert.equal((await getState()).documents.length, 1, 'Generation must not change the active contract or add a DOCX until export');
    assert.equal(await page.locator('.document-item.active strong').getAttribute('title'), original.name);
  }
  for (const [width, height] of [[1440, 900], [760, 560], [390, 844]]) await screenshotDialog(width, height, 'generation');
  hold = true; const priorCalls = calls.length; await dialog().getByRole('button', { name: '生成合同草稿', exact: true }).click(); await poll(async () => calls.length, value => value === priorCalls + 1, 'held generation reached mock');
  await dialog().getByRole('button', { name: '取消本次生成', exact: true }).click(); await poll(() => dialog().getByRole('button', { name: '刷新合同草稿', exact: true }).isEnabled(), Boolean, 'cancellation settled');
  assert.equal(await dialog().getByLabel('合同需求描述', { exact: true }).inputValue(), description); for (const item of held.splice(0)) send(item.response, item.output); assert.equal((await getDrafts()).length, 3);
  const beforeCloseCalls = calls.length; await dialog().getByRole('button', { name: '生成合同草稿', exact: true }).click(); await poll(async () => calls.length, value => value === beforeCloseCalls + 1, 'close-cancel reached mock'); await dialog().getByRole('button', { name: '关闭生成合同', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
  for (const item of held.splice(0)) send(item.response, item.output); hold = false;
  await openGeneration(); assert.equal(await dialog().getByLabel('合同需求描述', { exact: true }).inputValue(), description); assert.equal((await getDrafts()).length, 3, 'Closing must cancel generation and exclude late results');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)); await page.waitForFunction(() => innerWidth === 1440);
  const draftExportPath = join(exportDir, '生成泰文合同.docx'); await setSavePath(draftExportPath); await dialog().getByRole('button', { name: '导出并加入工作台', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
  const added = await poll(getState, state => state.documents.length === 2, 'generated DOCX imported'); const generatedDocument = added.documents.find(item => item.id !== original.id); assert.ok(generatedDocument); await page.locator(`.document-item.active strong[title="${generatedDocument.name}"]`).waitFor();
  const parsedDraft = await parseContract(draftExportPath); assert.ok(parsedDraft.blocks.some(item => item.text === languages.th.paragraph)); assert.ok(!parsedDraft.blocks.some(item => item.text.includes(description)), 'Input description must not be inserted into DOCX');
  await page.locator('.document-item').filter({ has: page.locator('strong[title="原合同-起草联调.docx"]') }).click(); await page.getByRole('button', { name: '本地规则检查', exact: true }).click();
  const reviewed = await poll(getState, state => state.tasks.some(item => item.documentId === original.id && item.status === 'completed'), 'local review complete'); const task = reviewed.tasks.find(item => item.documentId === original.id); const reviewId = task.resultId;
  const panel = page.locator(`#changes-${reviewId}`); await panel.locator('summary.pane-heading').click(); await panel.getByRole('button', { name: '刷新修改记录', exact: true }).waitFor();
  let workspace = await page.evaluate(id => window.contractAssistant.getChanges(id), reviewId); const target = workspace.targets.find(item => item.text === originalText); await panel.getByLabel('修改原文段落', { exact: true }).selectOption(target.blockId); await panel.getByLabel('修改后文字', { exact: true }).fill(replacementText); await panel.getByRole('button', { name: '保存修改草稿', exact: true }).click();
  workspace = await poll(() => page.evaluate(id => window.contractAssistant.getChanges(id), reviewId), value => value.proposals.length === 1, 'manual proposal saved'); await panel.getByRole('button', { name: '采纳这项修改', exact: true }).click(); await poll(() => page.evaluate(id => window.contractAssistant.getChanges(id), reviewId), value => value.proposals[0].status === 'accepted', 'proposal accepted');
  assert.equal(await panel.getByLabel('修改稿格式', { exact: true }).inputValue(), 'tracked'); await panel.getByLabel('修订作者', { exact: true }).fill('   '); assert.equal(await panel.getByRole('button', { name: '导出修改稿与清单', exact: true }).isEnabled(), false); await panel.getByLabel('修订作者', { exact: true }).fill('  联调法务  ');
  for (const [width, height] of [[1440, 900], [760, 560], [390, 844]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]); await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]);
    await panel.locator('.changes-export-options').evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const layout = await panel.evaluate(element => ({ doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, panel: element.scrollWidth, panelClient: element.clientWidth })); assert.ok(layout.doc <= layout.client + 1 && layout.panel <= layout.panelClient + 1, JSON.stringify(layout));
    const path = join(root, `output/playwright/authoring-export-${width}.png`); await page.screenshot({ path, animations: 'disabled' }); layouts.push({ width, height, path });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)); await page.waitForFunction(() => innerWidth === 1440);
  const trackedPath = join(exportDir, '带痕迹修订稿.docx'); await setSavePath(trackedPath); await panel.getByRole('button', { name: '导出修改稿与清单', exact: true }).click(); workspace = await poll(() => page.evaluate(id => window.contractAssistant.getChanges(id), reviewId), value => value.exports.length === 1, 'tracked export complete');
  assert.equal(workspace.exports[0].format, 'tracked'); assert.equal(workspace.exports[0].revisionAuthor, '联调法务'); const trackedZip = await JSZip.loadAsync(await readFile(trackedPath)); const trackedXml = await trackedZip.file('word/document.xml').async('string'); assert.ok(trackedXml.includes(oldInsertion)); assert.match(trackedXml, /<(?:[\w.-]+:)?ins\b[^>]*\b(?:[\w.-]+:)?author="联调法务"/u); assert.match(trackedXml, /<(?:[\w.-]+:)?del\b[^>]*\b(?:[\w.-]+:)?author="联调法务"/u); assert.match(trackedXml, /<(?:[\w.-]+:)?delText\b/u); assert.ok((await parseContract(trackedPath)).blocks.some(item => item.text === replacementText));
  await panel.getByLabel('修改稿格式', { exact: true }).selectOption('clean'); const cleanPath = join(exportDir, '普通修改稿.docx'); await setSavePath(cleanPath); await panel.getByRole('button', { name: '导出修改稿与清单', exact: true }).click(); workspace = await poll(() => page.evaluate(id => window.contractAssistant.getChanges(id), reviewId), value => value.exports.length === 2, 'ordinary export complete');
  const cleanXml = await (await JSZip.loadAsync(await readFile(cleanPath))).file('word/document.xml').async('string'); assert.ok(cleanXml.includes(oldInsertion)); assert.ok(!cleanXml.includes('w:author="联调法务"')); assert.ok((await parseContract(cleanPath)).blocks.some(item => item.text === replacementText)); assert.equal(createHash('sha256').update(await readFile(inputPath)).digest('hex'), originalHash);
  await app.close(); app = undefined; await launch(); await openGeneration(); assert.equal((await getDrafts()).length, 3); await dialog().getByRole('heading', { name: languages.th.title, exact: true }).waitFor(); await dialog().getByRole('button', { name: '关闭生成合同', exact: true }).click();
  await page.locator('.document-item').filter({ has: page.locator('strong[title="原合同-起草联调.docx"]') }).click(); const history = page.locator(`#changes-${reviewId}`); await history.locator('summary.pane-heading').click(); await history.locator('.changes-history > summary').click(); assert.ok((await history.locator('.changes-history').innerText()).includes('带修订痕迹')); assert.ok((await history.locator('.changes-history').innerText()).includes('联调法务')); assert.ok((await history.locator('.changes-history').innerText()).includes('普通修改稿'));
  const preview = createPreviewBridge(); const demo = (await preview.listContractDrafts())[0]; assert.ok((await preview.getContractDraft(demo.id)).title.includes('固定界面演示')); await assert.rejects(() => preview.generateContract({ requestId: crypto.randomUUID(), description, language: 'zh', contractType: 'service', ourPartyRole: 'service_recipient' }), /预览/u); await assert.rejects(() => preview.exportContractDraft({ draftId: demo.id }), /预览/u);
  assert.deepEqual(errors, []); assert.deepEqual(rendererNetwork, []);
  console.log(JSON.stringify({ passed: true, isolatedProfile: true, loopbackMockOnly: true, threeLanguagesGenerated: true, invalidOutputKeptInput: true, cancelAndCloseDiscardLateResults: true, independentDraftsPreservedOriginalSelection: true, generatedDocxImportedAndRestored: true, inputNotInDocx: true, trackedDefaultAndAuthorTrimmed: true, trueInsertAndDeleteRevisions: true, oldRevisionsPreservedInBothFormats: true, ordinaryExportHasNoNewRevision: true, exportHistoryRestored: true, previewHasNoRealGenerationOrExport: true, layouts, dataDir, exportDir }, null, 2));
} catch (error) { if (page && !page.isClosed()) { await mkdir(join(root, 'output/playwright'), { recursive: true }); await page.screenshot({ path: join(root, 'output/playwright/authoring-failure.png') }).catch(() => {}); console.error('UI failure state:', await page.locator('body').innerText().catch(() => 'unavailable')); } throw error;
} finally { await app?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
