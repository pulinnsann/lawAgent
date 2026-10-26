#!/usr/bin/env node
// Actual UI regression for cross-page annotation source selection. Synthetic
// documents and an isolated native workspace only; no model or web requests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createDocx } from '../tests/fixtures-documents.ts';

const root = resolve(import.meta.dirname, '..');
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'law-agent-annotation-pages-')));
const dataDir = join(temporary, 'data'); const inputPath = join(temporary, 'Synthetic paginated annotation.docx');
const artifacts = join(root, 'output/playwright/native-business-storage/library-source-pages'); await mkdir(artifacts, { recursive: true });
const paragraphs = Array.from({ length: 125 }, (_, i) => i === 0 ? `Synthetic long source 001: ${'😀'.repeat(17000)} 原文保留 ไทย` : `Synthetic clause ${String(i + 1).padStart(3, '0')}: 双方按书面记录办理服务验收。 Original source preserved. ข้อกำหนดตัวอย่าง ${i + 1}`);
const input = await createDocx({ paragraphs }); await writeFile(inputPath, input);
const sha = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pageErrors = []; const requests = []; const screenshots = []; let app; let page; let reviewId; let documentId;

async function manifest() {
  const files = [];
  async function walk(directory) { for (const item of await readdir(directory, { withFileTypes: true })) { const path = join(directory, item.name); if (item.isDirectory()) await walk(path); else if (item.isFile()) files.push({ path: relative(root, path), sha256: sha(await readFile(path)) }); } }
  await walk(join(root, 'out')); files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, sha256: sha(Buffer.from(files.map(file => `${file.path}\0${file.sha256}\n`).join(''))) };
}
const measuredBuild = await manifest();
async function poll(read, valid, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await read(); if (valid(value)) return value; await sleep(30); }
  throw new Error(`Timed out: ${label}`);
}
const command = (action, payload = {}) => page.evaluate(input => window.contractAssistant.runWorkspaceCommand(input), { action, payload });
async function launch() {
  app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir, LAW_AGENT_STORAGE_BACKEND: 'rust' }, timeout: 30000 });
  await app.evaluate(({ app, BrowserWindow }) => { const isolate = window => { window.webContents.setBackgroundThrottling(false); window.setFocusable(false); window.hide(); }; app.on('browser-window-created', (_event, window) => isolate(window)); BrowserWindow.getAllWindows().forEach(isolate); });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push(error.message)); page.on('request', request => { if (/^https?:/u.test(request.url())) requests.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.contractAssistant)); await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.contractAssistant.getState())).storageBackend, 'rust');
}
async function openAnnotations() {
  await page.getByRole('button', { name: '功能中心', exact: true }).click();
  await page.getByRole('dialog', { name: '功能中心', exact: true }).getByRole('button').filter({ hasText: '经验、模板与人工意见' }).click();
  const library = page.getByRole('dialog', { name: '经验、模板与人工意见', exact: true });
  await library.getByRole('button', { name: '人工审核意见', exact: true }).click();
  const picker = library.locator('.source-block-multiselect'); const select = picker.getByLabel('关联原文段落（可多选）', { exact: true });
  await poll(() => select.isEnabled(), Boolean, 'source selector ready');
  return { library, picker, select };
}
async function optionIds(select) { return select.locator('option').evaluateAll(options => options.map(option => option.value)); }
async function visibleSelection(select) { return select.evaluate(element => [...element.selectedOptions].map(option => option.value)); }
async function selectedCount(picker, count) { await picker.getByText(`已选 ${count} 个原文段落；翻页不会清除已有选择。`, { exact: true }).waitFor(); }
async function sourcePage(picker, select, direction, expectedId) {
  await picker.getByRole('button', { name: direction === 'next' ? '下一页原文' : '上一页原文', exact: true }).click();
  await poll(() => optionIds(select), ids => ids.includes(expectedId), `annotation source page ${direction}`);
}
async function screenshot(name, picker) {
  await picker.scrollIntoViewIfNeeded(); const path = join(artifacts, `${name}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path);
}

try {
  await launch();
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, inputPath);
  await page.locator('.import-button').click();
  const imported = await poll(() => page.evaluate(() => window.contractAssistant.getState()), state => state.documents.length === 1, 'synthetic import'); documentId = imported.documents[0].id;
  await page.locator('.document-meta strong[title="Synthetic paginated annotation.docx"]').waitFor();
  const detail = await page.evaluate(id => window.contractAssistant.getDocument(id), documentId);
  assert.equal(detail.blocks.length, 125);
  const first = detail.blocks[0]; const second = detail.blocks[110];
  const firstPage = await page.evaluate(documentId => window.contractAssistant.getDocumentBlocks({ documentId, limit: 100 }), documentId);
  assert.ok(firstPage.items.filter(block => block.id === first.id).length > 1, 'The Unicode fixture must contain multiple display fragments of one original block');
  assert.ok(firstPage.hasMore); assert.ok(!firstPage.items.some(block => block.id === second.id));
  const { taskId } = await page.evaluate(documentId => window.contractAssistant.startReview({ documentId, mode: 'local', context: { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: 'Synthetic annotation page selection validation.' } }), documentId);
  const complete = await poll(() => page.evaluate(() => window.contractAssistant.getState()), state => state.tasks.some(task => task.id === taskId && ['completed', 'failed'].includes(task.status)), 'local review');
  const task = complete.tasks.find(task => task.id === taskId); assert.equal(task.status, 'completed', task.error ?? ''); reviewId = task.resultId;
  const originalReview = await page.evaluate(id => window.contractAssistant.getReview(id), reviewId);
  await page.locator('.review-summary').waitFor();
  const originalPane = page.locator('.document-pane');
  await originalPane.getByRole('button', { name: '下一页原文', exact: true }).click();
  await poll(() => originalPane.locator('.contract-block').first().getAttribute('id'), value => value !== `block-${first.id}`, 'main original page changes');

  let { library, picker, select } = await openAnnotations();
  const initialOptions = await optionIds(select);
  assert.equal(new Set(initialOptions).size, initialOptions.length, 'Unicode fragments must not create duplicate option IDs');
  assert.equal(initialOptions.filter(id => id === first.id).length, 1);
  assert.ok(initialOptions.includes(first.id)); assert.ok(!initialOptions.includes(second.id));
  await select.selectOption([first.id]); await selectedCount(picker, 1);
  await sourcePage(picker, select, 'next', second.id);
  await select.selectOption([second.id]); await selectedCount(picker, 2);
  assert.deepEqual(await visibleSelection(select), [second.id]);
  await sourcePage(picker, select, 'previous', first.id);
  assert.deepEqual(await visibleSelection(select), [first.id]); await selectedCount(picker, 2);
  await screenshot('cross-page-selected-first', picker);
  await library.getByLabel('人工意见标题', { exact: true }).fill('Synthetic cross-page source association');
  await library.getByLabel('人工问题分析', { exact: true }).fill('Synthetic source selection regression, not legal advice.');
  await library.getByLabel('人工处理建议', { exact: true }).fill('Keep both original source references across display pages.');
  await library.getByLabel('人工意见原因', { exact: true }).fill('Initial cross-page selection acceptance.');
  await library.getByLabel('原文摘录（原样填写）', { exact: true }).fill(second.text);
  await library.getByRole('button', { name: '保存人工意见版本', exact: true }).click();
  let saved = (await poll(() => command('library.annotation.list', { reviewId }), rows => rows.length === 1, 'annotation first save'))[0];
  assert.deepEqual(saved.body.blockIds, [first.id, second.id]); assert.equal(saved.body.quote, second.text);
  await library.getByRole('button', { name: '关闭资料库', exact: true }).click();

  // The application's display moves again; the editor must continue reading
  // independent source pages instead of the main pane's current 50 fragments.
  await originalPane.getByRole('button', { name: '下一页原文', exact: true }).click();
  ({ library, picker, select } = await openAnnotations());
  await library.locator('.library-record').filter({ hasText: 'Synthetic cross-page source association' }).click();
  await selectedCount(picker, 2); assert.deepEqual(await visibleSelection(select), [first.id]);
  await sourcePage(picker, select, 'next', second.id);
  assert.deepEqual(await visibleSelection(select), [second.id]); await selectedCount(picker, 2);
  await screenshot('reopened-selected-second', picker);
  await library.getByLabel('人工意见原因', { exact: true }).fill('Reopened while the other selected source is outside the visible page.');
  await library.getByRole('button', { name: '保存人工意见版本', exact: true }).click();
  saved = (await poll(() => command('library.annotation.list', { reviewId }), rows => rows[0]?.revision === 2, 'annotation resave'))[0];
  assert.deepEqual(saved.body.blockIds, [first.id, second.id]);
  const effective = await command('library.annotation.effective', { reviewId });
  const linked = effective.find(item => item.annotation?.id === saved.id);
  assert.equal(linked.finding.locationStatus, 'matched'); assert.equal(linked.finding.quote, second.text);
  assert.deepEqual(await page.evaluate(id => window.contractAssistant.getReview(id), reviewId), originalReview);
  await app.close(); app = undefined;

  await launch();
  ({ library, picker, select } = await openAnnotations());
  await library.locator('.library-record').filter({ hasText: 'Synthetic cross-page source association' }).click();
  await selectedCount(picker, 2); assert.deepEqual(await visibleSelection(select), [first.id]);
  await sourcePage(picker, select, 'next', second.id); assert.deepEqual(await visibleSelection(select), [second.id]);
  const restored = (await command('library.annotation.list', { reviewId }))[0]; assert.deepEqual(restored.body.blockIds, [first.id, second.id]); assert.equal(restored.revision, 2);
  assert.equal(sha(await readFile(inputPath)), sha(input));
  assert.deepEqual(pageErrors, []); assert.deepEqual(requests, []);
  const finalBuild = await manifest(); assert.equal(finalBuild.sha256, measuredBuild.sha256, 'Application output must remain unchanged during the UI smoke');
  const result = { format: 'law-agent-library-source-pages-v1', passed: true, testedAt: new Date().toISOString(), dataDir, inputPath, documentId, reviewId,
    sourceBlocks: 125, longUnicodeSourceCodePoints: [...first.text].length, firstSourcePageFragments: firstPage.items.length, firstSourcePageUniqueIds: initialOptions.length,
    selectedOriginalBlockIds: [first.id, second.id], actualUiMultiSelect: true, crossPageSelectionPreserved: true, mainDisplayPageIndependent: true, originalQuoteMatched: true,
    reopeningAndRestartPreserved: true, originalFileAndReviewPreserved: true, noRealModelCalls: true, customerDataRead: false, pageErrors, requests, screenshots,
    measuredBuild: { ...measuredBuild, verifiedUnchangedAtEnd: true }, performanceMeasurement: false };
  await writeFile(join(artifacts, 'result.json'), `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify({ ...result, measuredBuild: { sha256: measuredBuild.sha256 } }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {}); console.error(JSON.stringify({ pageErrors, body: await page.locator('body').innerText().catch(() => '') })); }
  throw error;
} finally { await app?.close(); }
