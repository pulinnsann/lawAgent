import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { _electron as electron } from 'playwright';
import { createDocx } from '../tests/fixtures-documents.ts';
import { parseContract } from '../src/core/documents.ts';
import { createPreviewBridge } from '../src/renderer/src/preview-bridge.ts';

// Offline real-IPC acceptance: synthetic password-verifier Word readOnly DOCX,
// local-rule review and manual edits. No user data, cloud model or search.
const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-editable-copy-ui-'));
const exportDir = await mkdtemp(join(tmpdir(), 'law-agent-editable-copy-export-'));
const filename = '只读保护-界面联调.docx';
const inputPath = join(dataDir, filename);
const exportPath = join(exportDir, '只读保护-修改稿.docx');
const before = '付款条件：验收后支付全部款项。';
const after = '付款条件：双方书面确认验收结果后支付全部款项。';
const settings = '<?xml version="1.0"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:documentProtection w:edit="readOnly" w:enforcement="1" w:cryptProviderType="rsaAES" w:cryptAlgorithmClass="hash" w:cryptAlgorithmType="typeAny" w:cryptAlgorithmSid="14" w:cryptSpinCount="100000" w:hash="c3ludGhldGljLXZlcmlmaWVy" w:salt="c3ludGhldGljLXNhbHQ="/></w:settings>';
const input = await createDocx({ paragraphs: ['受保护合同工程联调', before], rawBody: '<w:p><w:hyperlink w:anchor="internal"><w:r><w:t>复杂链接段落仍保持只读</w:t></w:r></w:hyperlink></w:p>', extraFiles: { 'word/settings.xml': settings, 'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>' } });
await writeFile(inputPath, input);
const originalHash = createHash('sha256').update(input).digest('hex');
const errors = []; const rendererNetwork = []; const layouts = [];
let app; let page;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function launch() {
  app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 30000 });
  await app.evaluate(({ app, BrowserWindow }) => { const isolate = window => { window.webContents.setBackgroundThrottling(false); window.setFocusable(false); window.hide(); }; app.on('browser-window-created', (_event, window) => isolate(window)); for (const window of BrowserWindow.getAllWindows()) isolate(window); });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) rendererNetwork.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.contractAssistant));
  await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
}
async function waitState(predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const state = await page.evaluate(() => window.contractAssistant.getState()); if (predicate(state)) return state; await sleep(30); }
  throw new Error('Isolated app state did not reach the expected state');
}
async function waitWorkspace(reviewId, predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const workspace = await page.evaluate(id => window.contractAssistant.getChanges(id), reviewId); if (predicate(workspace)) return workspace; await sleep(30); }
  throw new Error('Editable copy workspace did not reach the expected state');
}
async function ready(panel) {
  await panel.getByRole('button', { name: '刷新修改记录', exact: true }).waitFor();
  await page.waitForFunction(() => { const button = document.querySelector('.changes-list-heading button'); return button && !button.disabled; });
}
async function snapshots(panel, mode) {
  for (const [width, height] of [[1440, 900], [760, 560], [390, 844]]) {
    await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(0, 560); window.setContentSize(size[0], size[1]); }, [width, height]);
    await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await panel.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const layout = await panel.evaluate(element => ({ documentWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, panelWidth: element.scrollWidth, panelClientWidth: element.clientWidth }));
    assert.ok(layout.documentWidth <= layout.clientWidth + 1 && layout.panelWidth <= layout.panelClientWidth + 1, JSON.stringify(layout));
    await mkdir(join(root, 'output/playwright'), { recursive: true });
    const path = join(root, `output/playwright/editable-copy-${mode}-${width}.png`); await page.screenshot({ path, animations: 'disabled' }); layouts.push({ mode, width, height, path });
  }
}
try {
  await launch();
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, inputPath);
  await page.locator('.import-button').click();
  const state = await waitState(value => value.documents.some(item => item.name === filename));
  const original = state.documents.find(item => item.name === filename);
  await page.locator(`.document-item.active strong[title="${filename}"]`).waitFor();
  await page.getByRole('button', { name: '本地规则检查', exact: true }).click();
  const completed = await waitState(value => value.tasks.some(item => item.documentId === original.id && ['completed', 'failed'].includes(item.status)));
  const task = completed.tasks.find(item => item.documentId === original.id); assert.equal(task.status, 'completed', task.error ?? '');
  const reviewId = task.resultId;
  let panel = page.locator(`#changes-${reviewId}`); await panel.locator('summary.pane-heading').click(); await ready(panel);
  let workspace = await page.evaluate(id => window.contractAssistant.getChanges(id), reviewId);
  assert.equal(workspace.supported, false); assert.equal(workspace.editableCopy.available, true); assert.equal(workspace.editableCopy.enabled, false);
  assert.ok(workspace.targets.every(item => !item.editable));
  const banner = panel.getByRole('region', { name: '可编辑副本模式', exact: true });
  await banner.getByRole('button', { name: '启用可编辑副本', exact: true }).waitFor();
  assert.ok((await banner.innerText()).includes('密码校验')); assert.ok((await banner.innerText()).includes('不破解或恢复密码'));
  assert.equal((await panel.locator('.changes-scope-note').allTextContents()).some(value => value.includes('PDF')), false, 'Protected DOCX must show its actual limitation');
  await snapshots(panel, 'locked');
  const staleError = await page.evaluate(async input => { try { await window.contractAssistant.enableEditableCopy(input); return null; } catch (error) { return error.message; } }, { reviewId, expectedRevision: workspace.revision + 1 });
  assert.match(staleError, /已更新|变化/u);
  assert.equal((await page.evaluate(id => window.contractAssistant.getChanges(id), reviewId)).editableCopy.enabled, false);
  await banner.getByRole('button', { name: '启用可编辑副本', exact: true }).click();
  workspace = await waitWorkspace(reviewId, value => value.editableCopy?.enabled); await ready(panel);
  assert.equal(workspace.supported, true); assert.ok(workspace.editableCopy.enabledAt);
  assert.equal(workspace.targets.filter(item => item.editable).length, 2);
  assert.equal(workspace.targets.find(item => item.text.includes('复杂链接')).editable, false);
  assert.equal(await banner.getByRole('button', { name: '启用可编辑副本', exact: true }).count(), 0);
  await banner.getByRole('heading', { name: '已启用可编辑副本', exact: true }).waitFor();
  await snapshots(panel, 'enabled');
  const target = workspace.targets.find(item => item.text === before); assert.ok(target);
  await panel.getByLabel('修改原文段落', { exact: true }).selectOption(target.blockId);
  await panel.getByLabel('修改后文字', { exact: true }).fill(after);
  await panel.getByRole('button', { name: '保存修改草稿', exact: true }).click();
  workspace = await waitWorkspace(reviewId, value => value.proposals.length === 1); await ready(panel);
  assert.equal(workspace.proposals[0].status, 'proposed');
  await panel.getByRole('button', { name: '采纳这项修改', exact: true }).click();
  workspace = await waitWorkspace(reviewId, value => value.proposals[0].status === 'accepted'); await ready(panel);
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, exportPath);
  await panel.getByRole('button', { name: '导出修改稿与清单', exact: true }).click();
  workspace = await waitWorkspace(reviewId, value => value.exports.length === 1); await ready(panel);
  assert.ok((await parseContract(exportPath)).blocks.some(item => item.text === after));
  const exportedZip = await JSZip.loadAsync(await readFile(exportPath));
  const exportedSettings = await exportedZip.file('word/settings.xml').async('string');
  assert.ok(!/<w:documentProtection\b/u.test(exportedSettings)); assert.ok(exportedSettings.includes('<w:zoom w:percent="100"/>'));
  assert.equal(createHash('sha256').update(await readFile(inputPath)).digest('hex'), originalHash);
  const managed = await page.evaluate(id => window.contractAssistant.getDocument(id), original.id); assert.ok(managed.blocks.some(item => item.text === before));
  const paths = await panel.locator('.changes-export-paths dd').allTextContents(); assert.equal(paths[0], await realpath(exportPath));
  const changeList = await readFile(paths[1], 'utf8'); assert.ok(changeList.includes('可编辑副本')); assert.ok(changeList.includes('只读')); assert.ok(changeList.includes('启用时间')); assert.ok(changeList.includes(after));
  const enabledAt = workspace.editableCopy.enabledAt;
  await app.close(); app = undefined; await launch();
  await page.locator('.document-item').filter({ has: page.locator(`strong[title="${filename}"]`) }).click();
  panel = page.locator(`#changes-${reviewId}`); await panel.locator('summary.pane-heading').click(); await ready(panel);
  const restored = await page.evaluate(id => window.contractAssistant.getChanges(id), reviewId);
  assert.equal(restored.editableCopy.enabled, true); assert.equal(restored.editableCopy.enabledAt, enabledAt); assert.equal(restored.exports.length, 1); assert.equal(restored.proposals[0].status, 'accepted');
  assert.equal(await panel.getByRole('button', { name: '启用可编辑副本', exact: true }).count(), 0);
  const preview = createPreviewBridge(); await assert.rejects(() => preview.enableEditableCopy({ reviewId, expectedRevision: 0 }), /预览/u);
  assert.deepEqual(errors, []); assert.deepEqual(rendererNetwork, []);
  console.log(JSON.stringify({ passed: true, isolatedProfile: true, localRuleAndManualOnly: true, passwordVerifierReadOnlyRecognized: true, staleRevisionBlocked: true, enabledByExplicitButton: true, complexTargetStillReadOnly: true, originalUnchanged: true, exportedCopyProtectionRemoved: true, changeListRecordsCopyMode: true, enabledAndHistoryRestoredAfterRestart: true, previewCannotEnableRealCopy: true, layouts, exportPath }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) { await mkdir(join(root, 'output/playwright'), { recursive: true }); await page.screenshot({ path: join(root, 'output/playwright/editable-copy-failure.png') }).catch(() => {}); console.error('UI failure state:', await page.locator('body').innerText().catch(() => 'unavailable')); }
  throw error;
} finally { await app?.close(); }
