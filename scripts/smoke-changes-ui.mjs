import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createDocx } from '../tests/fixtures-documents.ts';
import { parseContract } from '../src/core/documents.ts';
import { createPreviewBridge } from '../src/renderer/src/preview-bridge.ts';

// Offline acceptance: isolated Electron, synthetic DOCX, loopback mock model.
// No real Codex, business contract, cloud model or public website is used.
const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-changes-ui-'));
const exportDir = await mkdtemp(join(tmpdir(), 'law-agent-changes-export-'));
const inputPath = join(dataDir, '合同修改-工程联调.docx');
const exportPath = join(exportDir, '合同修改-工程联调-修改稿.docx');
const beforeZh = '付款条件：验收后支付全部款项。';
const generatedZh = '付款条件：双方书面确认验收结果后支付全部款项。';
const finalZh = '付款条件：双方书面确认验收结果并核对结算资料后支付全部款项。';
const beforeEn = 'Payment is due within 30 days of acceptance.';
const afterEn = 'Payment is due within 30 days after written acceptance.';
const beforeTh = 'คู่สัญญาต้องแจ้งเหตุขัดข้องภายในสามวัน';
const afterTh = 'คู่สัญญาต้องแจ้งเหตุขัดข้องเป็นลายลักษณ์อักษรภายในสามวัน';
const inputBytes = await createDocx({ paragraphs: ['工程联调：合同修改试验', beforeZh, beforeEn, beforeTh], rawBody: '<w:p><w:hyperlink w:anchor="internal"><w:r><w:t>复杂链接段落不可自动改写</w:t></w:r></w:hyperlink></w:p>' });
await writeFile(inputPath, inputBytes);
const inputHash = createHash('sha256').update(inputBytes).digest('hex');
const errors = []; const modelCalls = []; const rendererNetwork = []; const layouts = [];
let app; let page; let reviewBlocks = []; let holdDraft = false;
const heldDrafts = [];
const sendModel = (response, output) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ model: 'changes-ui-mock', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
};
function releaseDrafts() { for (const { response, output } of heldDrafts.splice(0)) if (!response.destroyed) sendModel(response, output); }
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); const name = body.response_format?.json_schema?.name;
    const payload = JSON.parse(body.messages.findLast(item => item.role === 'user').content);
    modelCalls.push(name);
    let output;
    if (name === 'contract_change_draft') {
      const block = reviewBlocks.find(item => item.text === beforeZh);
      assert.ok(block, 'Expected review source block before generating a draft');
      output = { blockId: block.id, originalText: block.text, replacementText: generatedZh, explanation: '明确书面验收节点；此响应仅供工程联调。', warnings: [] };
      if (holdDraft) { heldDrafts.push({ response, output }); return; }
    } else {
      reviewBlocks = payload.contractBlocks;
      assert.ok(Array.isArray(reviewBlocks));
      const zh = reviewBlocks.find(item => item.text === beforeZh);
      const en = reviewBlocks.find(item => item.text === beforeEn);
      const th = reviewBlocks.find(item => item.text === beforeTh);
      const finding = (title, blocks) => ({ blockIds: blocks.map(item => item.id), quote: blocks[0].text, title,
        category: 'commercial', severity: 'medium', description: '虚构模型意见，验证定点修改流程。',
        suggestion: '核对原文后明确书面确认要求。', legalBasis: null, citations: [] });
      output = { summary: '工程联调的虚构合同审核。', reviewedBlockIds: reviewBlocks.map(item => item.id), findings: [finding('核对书面验收与付款条件', [zh]), finding('核对英文与泰文通知表述', [en, th])] };
    }
    sendModel(response, output);
  } catch { response.writeHead(500); response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function launch() {
  app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 30000 });
  await app.evaluate(({ app, BrowserWindow }) => { const isolate = window => { window.webContents.setBackgroundThrottling(false); window.setFocusable(false); window.hide(); }; app.on('browser-window-created', (_event, window) => isolate(window)); for (const window of BrowserWindow.getAllWindows()) isolate(window); });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) rendererNetwork.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.contractAssistant));
  await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
}
async function waitReview(documentId, taskId = null) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.contractAssistant.getState());
    const task = state.tasks.find(item => item.documentId === documentId && (!taskId || item.id === taskId));
    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) { assert.equal(task.status, 'completed', task.error ?? ''); return task; }
    await sleep(50);
  }
  throw new Error('Synthetic review did not finish');
}
async function waitModelCalls(count) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (modelCalls.length === count) return; await sleep(20); }
  throw new Error(`Expected ${count} mock model calls, saw ${modelCalls.length}`);
}
async function waitImportedDocument(filename) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.contractAssistant.getState());
    const document = state.documents.find(item => item.name === filename);
    if (document) return document;
    await sleep(50);
  }
  throw new Error(`Synthetic document was not imported: ${filename}`);
}
async function waitWorkspace(reviewId, predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const workspace = await page.evaluate(id => window.contractAssistant.getChanges(id), reviewId);
    if (predicate(workspace)) return workspace;
    await sleep(50);
  }
  throw new Error('Change workspace did not reach expected state');
}
async function ready(panel) {
  await page.waitForFunction(() => !document.querySelector('.changes-loading'));
  await panel.getByRole('button', { name: '刷新修改记录', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('.changes-list-heading button')][0];
    return button && !button.disabled;
  });
}
function proposalCard(panel, id) { return panel.locator(`[data-proposal-id="${id}"]`); }
async function accept(panel, reviewId, id, count) {
  await proposalCard(panel, id).getByRole('button', { name: '采纳这项修改', exact: true }).click();
  await waitWorkspace(reviewId, value => value.proposals.filter(item => item.status === 'accepted').length === count);
  await ready(panel);
}
try {
  await launch();
  await page.evaluate(baseUrl => window.contractAssistant.saveModelConfig({ name: '虚构修改联调模型', baseUrl, model: 'changes-ui-mock', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 4096, contextWindowTokens: 65536, timeoutSeconds: 20 }), baseUrl);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, inputPath);
  await page.locator('.import-button').click();
  const original = await waitImportedDocument('合同修改-工程联调.docx');
  await page.locator('.document-item.active strong[title="合同修改-工程联调.docx"]').waitFor();
  await page.getByRole('button', { name: '开始模型审核', exact: true }).click();
  const task = await waitReview(original.id);
  const detail = await page.evaluate(id => window.contractAssistant.getDocument(id), original.id);
  const review = detail.reviews.find(item => item.id === task.resultId); assert.ok(review);
  await page.getByRole('button', { name: '拟定修改', exact: true }).first().click();
  const panel = page.locator(`#changes-${review.id}`); await ready(panel);
  assert.equal(await panel.getByRole('region', { name: '可编辑副本模式', exact: true }).count(), 0, 'Ordinary DOCX must not show a protection banner');
  assert.equal(await panel.getByLabel('关联审核意见', { exact: true }).inputValue(), review.findings[0].id);
  const zh = detail.blocks.find(item => item.text === beforeZh);
  const en = detail.blocks.find(item => item.text === beforeEn);
  const th = detail.blocks.find(item => item.text === beforeTh);
  const complex = detail.blocks.find(item => item.text.includes('复杂链接'));
  assert.equal(await panel.getByLabel('修改原文段落', { exact: true }).inputValue(), zh.id);
  assert.equal(await panel.locator('[data-testid="change-editor-original"]').innerText(), beforeZh);
  assert.equal(await panel.locator('.change-proposal').count(), 0, 'Opening a review must not manufacture a draft');

  const unsavedText = '人工未保存的付款条件，请保留。';
  await panel.getByLabel('修改后文字', { exact: true }).fill(unsavedText);
  assert.equal(await panel.getByRole('button', { name: '生成具体改写', exact: true }).isEnabled(), false, 'Generation must not overwrite unsaved text');
  await page.getByRole('button', { name: '拟定修改', exact: true }).nth(1).click();
  await panel.getByText('当前有未保存编辑，原文段落和草稿已保留。请先保存或撤销编辑，再选择其他审核意见。', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('关联审核意见', { exact: true }).inputValue(), review.findings[0].id);
  assert.equal(await panel.getByLabel('修改原文段落', { exact: true }).inputValue(), zh.id);
  assert.equal(await panel.getByLabel('修改后文字', { exact: true }).inputValue(), unsavedText);
  await panel.getByRole('button', { name: '撤销未保存编辑', exact: true }).click();

  holdDraft = true; const callsBeforeGeneration = modelCalls.length;
  await panel.getByRole('button', { name: '生成具体改写', exact: true }).click();
  await waitModelCalls(callsBeforeGeneration + 1);
  await page.getByRole('button', { name: '拟定修改', exact: true }).nth(1).click();
  await panel.getByText('当前操作正在进行，原文段落和草稿已保留。请先完成或取消，再选择其他审核意见。', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('关联审核意见', { exact: true }).inputValue(), review.findings[0].id);
  assert.equal(await panel.getByLabel('修改原文段落', { exact: true }).inputValue(), zh.id);
  holdDraft = false; releaseDrafts();
  let workspace = await waitWorkspace(review.id, value => value.proposals.length === 1); await ready(panel);
  const first = workspace.proposals[0]; assert.equal(first.status, 'proposed');
  assert.equal(first.replacementText, generatedZh);
  assert.equal(await panel.getByLabel('关联审核意见', { exact: true }).inputValue(), review.findings[0].id);
  assert.equal(await panel.getByLabel('修改原文段落', { exact: true }).inputValue(), zh.id);
  assert.equal(await panel.getByLabel('修改后文字', { exact: true }).inputValue(), generatedZh);
  assert.equal(await proposalCard(panel, first.id).locator('.change-original').innerText(), beforeZh);
  assert.equal(await proposalCard(panel, first.id).locator('.change-replacement').innerText(), generatedZh);
  await page.evaluate(input => window.contractAssistant.decideChange(input), { reviewId: review.id, proposalId: first.id, status: 'proposed', expectedRevision: workspace.revision });
  await proposalCard(panel, first.id).getByRole('button', { name: '采纳这项修改', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: '修改列表已更新' }).waitFor(); await ready(panel);
  assert.equal((await page.evaluate(id => window.contractAssistant.getChanges(id), review.id)).proposals[0].status, 'proposed', 'Stale UI must not overwrite newer change records');
  await panel.getByRole('button', { name: '刷新修改记录', exact: true }).click(); await ready(panel);
  await accept(panel, review.id, first.id, 1);
  await proposalCard(panel, first.id).getByRole('button', { name: '编辑草稿', exact: true }).click();
  await panel.getByLabel('修改后文字', { exact: true }).fill(finalZh);
  assert.equal(await panel.getByRole('button', { name: '导出修改稿与清单', exact: true }).isEnabled(), false, 'Unsaved edits must not be exported');
  await panel.getByRole('button', { name: '保存修改草稿', exact: true }).click();
  workspace = await waitWorkspace(review.id, value => value.proposals[0].replacementText === finalZh); await ready(panel);
  assert.equal(workspace.proposals[0].status, 'proposed', 'Editing accepted text must require renewed acceptance');
  await accept(panel, review.id, first.id, 1);

  await panel.getByRole('button', { name: '新建修改', exact: true }).click();
  await panel.getByLabel('修改后文字', { exact: true }).fill('付款条件：确认验收后支付款项。');
  await panel.getByRole('button', { name: '保存修改草稿', exact: true }).click();
  workspace = await waitWorkspace(review.id, value => value.proposals.length === 2); await ready(panel);
  const conflicting = workspace.proposals.find(item => item.id !== first.id);
  await proposalCard(panel, conflicting.id).getByRole('button', { name: '采纳这项修改', exact: true }).click();
  await panel.getByRole('alert').waitFor(); await ready(panel);
  assert.equal((await page.evaluate(id => window.contractAssistant.getChanges(id), review.id)).proposals.filter(item => item.status === 'accepted').length, 1);
  await proposalCard(panel, conflicting.id).getByRole('button', { name: '拒绝', exact: true }).click();
  await waitWorkspace(review.id, value => value.proposals.find(item => item.id === conflicting.id).status === 'rejected'); await ready(panel);

  await panel.getByRole('button', { name: '新建修改', exact: true }).click();
  await panel.getByLabel('关联审核意见', { exact: true }).selectOption(review.findings[1].id);
  assert.equal(await panel.getByLabel('修改原文段落', { exact: true }).inputValue(), '', 'Multiple anchors require explicit selection');
  for (const [block, text, count] of [[en, afterEn, 2], [th, afterTh, 3]]) {
    await panel.getByLabel('修改原文段落', { exact: true }).selectOption(block.id);
    await panel.getByLabel('修改后文字', { exact: true }).fill(text);
    const previous = workspace.proposals.map(item => item.id);
    await panel.getByRole('button', { name: '保存修改草稿', exact: true }).click();
    workspace = await waitWorkspace(review.id, value => value.proposals.length > previous.length); await ready(panel);
    const created = workspace.proposals.find(item => !previous.includes(item.id));
    await accept(panel, review.id, created.id, count);
    if (block.id === en.id) { await panel.getByRole('button', { name: '新建修改', exact: true }).click(); }
  }
  await panel.getByRole('button', { name: '新建修改', exact: true }).click();
  await panel.getByLabel('关联审核意见', { exact: true }).selectOption('');
  await panel.getByLabel('修改原文段落', { exact: true }).selectOption(complex.id);
  assert.equal(await panel.getByLabel('修改后文字', { exact: true }).isEnabled(), false, 'Complex target must remain read-only');
  assert.equal(await panel.getByRole('button', { name: '保存修改草稿', exact: true }).isEnabled(), false);
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
  await panel.getByRole('button', { name: '导出修改稿与清单', exact: true }).click();
  workspace = await waitWorkspace(review.id, value => value.exports.length === 1); await ready(panel);
  const exported = await parseContract(exportPath);
  assert.ok(exported.blocks.some(item => item.text === finalZh));
  assert.ok(exported.blocks.some(item => item.text === afterEn));
  assert.ok(exported.blocks.some(item => item.text === afterTh));
  assert.ok(exported.blocks.some(item => item.text === complex.text));
  assert.equal(createHash('sha256').update(await readFile(inputPath)).digest('hex'), inputHash);
  const pathRows = await panel.locator('.changes-export-paths dd').allTextContents();
  assert.equal(pathRows[0], await realpath(exportPath)); assert.ok(pathRows[1]);
  const changeList = await readFile(pathRows[1], 'utf8'); assert.ok(changeList.includes(finalZh)); assert.ok(changeList.includes(beforeZh));

  holdDraft = true;
  await panel.getByLabel('关联审核意见', { exact: true }).selectOption(review.findings[0].id);
  const previousDrafts = workspace.proposals.length;
  await panel.getByRole('button', { name: '生成具体改写', exact: true }).click();
  await panel.getByRole('button', { name: '取消本次改写', exact: true }).click();
  await ready(panel);
  assert.equal(await panel.getByRole('alert').count(), 0, 'Cancellation is not a fault');
  assert.equal((await page.evaluate(id => window.contractAssistant.getChanges(id), review.id)).proposals.length, previousDrafts);
  holdDraft = false;

  for (const [width, height] of [[1440, 900], [760, 560], [390, 844]]) {
    await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(size[0] < 760 ? 0 : 760, 560); window.setContentSize(size[0], size[1]); }, [width, height]);
    await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await panel.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const layout = await panel.evaluate(element => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, panelWidth: element.scrollWidth, panelClientWidth: element.clientWidth }));
    assert.ok(layout.documentWidth <= layout.clientWidth + 1 && layout.panelWidth <= layout.panelClientWidth + 1, JSON.stringify(layout));
    await mkdir(join(root, 'output/playwright'), { recursive: true });
    const screenshot = join(root, `output/playwright/changes-ui-${width}.png`); await page.screenshot({ path: screenshot, animations: 'disabled' });
    await panel.locator('.change-proposal').first().evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const proposalScreenshot = join(root, `output/playwright/changes-ui-${width}-proposal.png`); await page.screenshot({ path: proposalScreenshot, animations: 'disabled' });
    await panel.locator('.changes-export').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const exportScreenshot = join(root, `output/playwright/changes-ui-${width}-export.png`); await page.screenshot({ path: exportScreenshot, animations: 'disabled' });
    layouts.push({ width, height, screenshot, proposalScreenshot, exportScreenshot });
  }
  await app.close(); app = undefined; await launch();
  await page.locator('.document-item').filter({ has: page.locator('strong[title="合同修改-工程联调.docx"]') }).click();
  const restoredPanel = page.locator(`#changes-${review.id}`); await restoredPanel.locator('summary.pane-heading').click(); await ready(restoredPanel);
  const restored = await page.evaluate(id => window.contractAssistant.getChanges(id), review.id);
  assert.equal(restored.proposals.filter(item => item.status === 'accepted').length, 3); assert.equal(restored.exports.length, 1);
  assert.ok((await page.evaluate(() => window.contractAssistant.getState())).documents.some(item => item.id === restored.exports[0].documentId));
  await page.getByRole('button', { name: '拟定修改', exact: true }).first().click();
  await page.waitForFunction(({ panelId, findingId }) => document.getElementById(panelId)?.querySelector('select[aria-label="关联审核意见"]')?.value === findingId, { panelId: `changes-${review.id}`, findingId: review.findings[0].id });
  assert.equal(await restoredPanel.getByLabel('关联审核意见', { exact: true }).inputValue(), review.findings[0].id);

  // Real main-process IPC regression: a queued request must stay cancelled
  // when a different review is occupying the credential queue.
  const secondTask = await page.evaluate(documentId => window.contractAssistant.startReview({ documentId, mode: 'model', context: { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '' } }), original.id);
  const secondCompleted = await waitReview(original.id, secondTask.taskId);
  const secondReview = (await page.evaluate(id => window.contractAssistant.getDocument(id), original.id)).reviews.find(item => item.id === secondCompleted.resultId);
  assert.ok(secondReview);
  const secondWorkspace = await page.evaluate(id => window.contractAssistant.getChanges(id), secondReview.id);
  const secondPanel = page.locator(`#changes-${secondReview.id}`); await secondPanel.waitFor({ state: 'attached' });
  assert.equal(await secondPanel.locator('.change-proposal').count(), 0, 'A different review must not inherit proposals');
  assert.equal(await secondPanel.evaluate(element => element.open), false);
  await page.getByLabel('历史检查结果', { exact: true }).selectOption(review.id);
  await restoredPanel.waitFor({ state: 'attached' }); assert.equal(await restoredPanel.evaluate(element => element.open), false, 'Switching history must reset the prior editor state');
  await restoredPanel.locator('summary.pane-heading').click(); await ready(restoredPanel);
  assert.equal(await restoredPanel.getByLabel('关联审核意见', { exact: true }).inputValue(), '', 'Prior external finding requests must not reopen an old editor');
  const firstInput = { reviewId: review.id, findingId: review.findings[0].id, blockId: zh.id, expectedRevision: restored.revision };
  const secondInput = { reviewId: secondReview.id, findingId: secondReview.findings[0].id, blockId: zh.id, expectedRevision: secondWorkspace.revision };
  holdDraft = true; const callsBeforeQueued = modelCalls.length;
  await page.evaluate(input => { window.__changeSmokeRequests = {}; window.__changeSmokeRequests.first = window.contractAssistant.generateChangeDraft(input).then(() => ({ saved: true }), error => ({ error: error.message })); }, firstInput);
  await waitModelCalls(callsBeforeQueued + 1);
  await page.evaluate(async input => {
    window.__changeSmokeRequests.second = window.contractAssistant.generateChangeDraft(input).then(() => ({ saved: true }), error => ({ error: error.message }));
    await window.contractAssistant.cancelChangeDraft(input.reviewId);
  }, secondInput);
  await page.evaluate(id => window.contractAssistant.cancelChangeDraft(id), review.id);
  const queuedResults = await page.evaluate(() => Promise.all([window.__changeSmokeRequests.first, window.__changeSmokeRequests.second]));
  assert.ok(queuedResults.every(item => item.error?.includes('取消')), JSON.stringify(queuedResults));
  assert.equal(modelCalls.length, callsBeforeQueued + 1, 'Cancelled queued review must never call the model');
  assert.equal((await page.evaluate(id => window.contractAssistant.getChanges(id), secondReview.id)).proposals.length, 0);
  assert.equal((await page.evaluate(id => window.contractAssistant.getChanges(id), review.id)).proposals.length, restored.proposals.length);
  holdDraft = false; releaseDrafts();

  // Also cancel after entering execute(), while its credential lookup getState
  // is in flight. Intercept only this isolated app's next worker dispatch.
  await app.evaluate(() => {
    const { Worker } = process.getBuiltinModule('node:worker_threads');
    const originalPost = Worker.prototype.postMessage;
    globalThis.__changeSmokeWorkerHold = { originalPost, armed: true, held: null };
    Worker.prototype.postMessage = function(message, ...args) {
      const hold = globalThis.__changeSmokeWorkerHold;
      if (hold.armed && message.command === 'getState') { hold.armed = false; hold.held = { worker: this, message, args }; return; }
      return originalPost.call(this, message, ...args);
    };
  });
  const callsBeforeLookup = modelCalls.length;
  await page.evaluate(input => { window.__changeSmokeRequests.lookup = window.contractAssistant.generateChangeDraft(input).then(() => ({ saved: true }), error => ({ error: error.message })); }, secondInput);
  const holdDeadline = Date.now() + 20000;
  while (!await app.evaluate(() => Boolean(globalThis.__changeSmokeWorkerHold.held))) { assert.ok(Date.now() < holdDeadline, 'Credential lookup was not intercepted'); await sleep(20); }
  await page.evaluate(id => window.contractAssistant.cancelChangeDraft(id), secondReview.id);
  await app.evaluate(() => {
    const { Worker } = process.getBuiltinModule('node:worker_threads'); const hold = globalThis.__changeSmokeWorkerHold;
    Worker.prototype.postMessage = hold.originalPost;
    hold.originalPost.call(hold.held.worker, hold.held.message, ...hold.held.args); delete globalThis.__changeSmokeWorkerHold;
  });
  const lookupResult = await page.evaluate(() => window.__changeSmokeRequests.lookup);
  assert.ok(lookupResult.error?.includes('取消'), JSON.stringify(lookupResult));
  assert.equal(modelCalls.length, callsBeforeLookup, 'Cancellation during credential lookup must not call the model');
  assert.equal((await page.evaluate(id => window.contractAssistant.getChanges(id), secondReview.id)).proposals.length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(rendererNetwork, []);

  const preview = createPreviewBridge(); const sample = await preview.loadSample();
  const previewTask = await preview.startReview({ documentId: sample.id, mode: 'local', context: { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '' } });
  while ((await preview.getState()).tasks.find(item => item.id === previewTask.taskId).status === 'running') await sleep(20);
  const previewReview = (await preview.getDocument(sample.id)).reviews[0];
  let previewChanges = await preview.getChanges(previewReview.id); const previewTarget = previewChanges.targets.find(item => item.editable);
  previewChanges = await preview.saveChange({ reviewId: previewReview.id, findingId: null, blockId: previewTarget.blockId, replacementText: `${previewTarget.text}（手动预览修改）`, expectedRevision: previewChanges.revision });
  previewChanges = await preview.decideChange({ reviewId: previewReview.id, proposalId: previewChanges.proposals[0].id, status: 'accepted', expectedRevision: previewChanges.revision });
  assert.equal(previewChanges.proposals[0].status, 'accepted');
  await assert.rejects(() => preview.generateChangeDraft({ reviewId: previewReview.id, findingId: previewReview.findings[0].id, blockId: previewTarget.blockId, expectedRevision: previewChanges.revision }), /预览/);
  await assert.rejects(() => preview.exportModified({ reviewId: previewReview.id, expectedRevision: previewChanges.revision }), /预览/);
  assert.equal((await preview.getDocument(sample.id)).blocks.find(item => item.id === previewTarget.blockId).text, previewTarget.text);
  console.log(JSON.stringify({ passed: true, isolatedProfile: true, syntheticModelOnly: true, modelCalls, proposals: restored.proposals.length, accepted: 3, conflictBlocked: true,
    editingRequiresAcceptance: true, staleRevisionBlocked: true, unsavedDraftPreserved: true, draftAnchorPreservedWhileGenerating: true, historyEditorStateReset: true, originalUnchanged: true, trilingualExport: true, cancelledDraftNotSaved: true,
    cancelledQueuedDraftNeverSent: true, cancelledDuringCredentialLookupNeverSent: true,
    exportAndRestartRestored: true, previewCannotExecuteOrExport: true, layouts, exportPath }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await mkdir(join(root, 'output/playwright'), { recursive: true });
    await page.screenshot({ path: join(root, 'output/playwright/changes-ui-failure.png') }).catch(() => {});
    console.error('UI failure state:', await page.locator('body').innerText().catch(() => 'unavailable'));
  }
  throw error;
} finally { await app?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
