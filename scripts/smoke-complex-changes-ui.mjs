import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { _electron as electron } from 'playwright';
import { createDocx, escapeXml } from '../tests/fixtures-documents.ts';
import { createPreviewBridge } from '../src/renderer/src/preview-bridge.ts';

// Synthetic, isolated, offline acceptance. Local rules and manual fragment edits;
// no user's DOCX/profile, real model, website or credentials are used.
const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-complex-ui-'));
const exportDir = await mkdtemp(join(tmpdir(), 'law-agent-complex-export-'));
const filename = '保留结构-片段修改联调.docx';
const inputPath = join(dataDir, filename); const exportPath = join(exportDir, '片段修改稿.docx');
const run = (text, properties = '') => `<w:r>${properties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
const source = await createDocx({ paragraphs: ['复杂段落界面联调'], rawBody: [
  `<w:p>${run('权限前文。')}<w:permStart w:id="7" w:edGrp="everyone"/>${run('权限中段。', '<w:rPr><w:b/></w:rPr>')}<w:permEnd w:id="7"/>${run('权限后文。')}</w:p>`,
  `<w:p><w:bookmarkStart w:id="3" w:name="business_clause"/>${run('书签中段。')}<w:bookmarkEnd w:id="3"/>${run('书签后文。')}</w:p>`,
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/><w:ins w:id="55" w:author="原作者" w:date="2020-01-01T00:00:00Z"/></w:numPr></w:pPr>${run('编号修订正文。')}</w:p>`,
  `<w:p>${run('分页前正文。')}<w:r><w:br w:type="page"/></w:r></w:p>`,
  `<w:p><w:ins w:id="77" w:author="原作者" w:date="2020-01-01T00:00:00Z">${run('旧插入修订文字。')}</w:ins>${run('修订后正文。')}</w:p>`,
].join('') });
await writeFile(inputPath, source); const originalHash = createHash('sha256').update(source).digest('hex');
const originalZip = await JSZip.loadAsync(source); const originalXml = await originalZip.file('word/document.xml').async('string');
const errors = []; const network = []; const layouts = []; const acceptedReplacements = [];
let app; let page; let panel; let reviewId; let workspace;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function launch() {
  app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 30000 });
  await app.evaluate(({ app, BrowserWindow }) => { const isolate = window => { window.webContents.setBackgroundThrottling(false); window.setFocusable(false); window.hide(); }; app.on('browser-window-created', (_event, window) => isolate(window)); for (const window of BrowserWindow.getAllWindows()) isolate(window); });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/u.test(request.url())) network.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.contractAssistant)); await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
}
async function waitState(predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const state = await page.evaluate(() => window.contractAssistant.getState()); if (predicate(state)) return state; await sleep(25); }
  throw new Error('App state timed out');
}
async function waitWorkspace(predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await page.evaluate(id => window.contractAssistant.getChanges(id), reviewId); if (predicate(value)) return value; await sleep(25); }
  throw new Error('Fragment change state timed out');
}
async function ready() {
  await panel.getByRole('button', { name: '刷新修改记录', exact: true }).waitFor();
  await page.waitForFunction(() => { const button = document.querySelector('.changes-list-heading button'); return button && !button.disabled; });
}
async function selectFragment(target, text) {
  await panel.getByRole('button', { name: '新建修改', exact: true }).click();
  await panel.getByLabel('修改原文段落', { exact: true }).selectOption(target.blockId);
  assert.equal(await panel.getByLabel('修改文字片段', { exact: true }).inputValue(), '', 'Each complex target requires explicit fragment selection');
  assert.equal(await panel.getByRole('button', { name: '保存修改草稿', exact: true }).isEnabled(), false);
  assert.equal(await panel.getByRole('button', { name: '生成具体改写', exact: true }).isEnabled(), false);
  assert.equal(await panel.locator('[data-testid="change-paragraph-context"]').textContent(), target.text);
  const segment = target.segments.find(item => item.editable && item.text === text); assert.ok(segment, text);
  await panel.getByLabel('修改文字片段', { exact: true }).selectOption(segment.id);
  assert.equal(await panel.locator('[data-testid="change-editor-original"]').innerText(), text);
  assert.equal(await panel.getByLabel('修改后文字', { exact: true }).inputValue(), text);
  assert.equal(await panel.getByLabel('修改后文字', { exact: true }).getAttribute('maxlength'), '30000');
  return segment;
}
async function saveAndDecide(target, segment, replacement, status) {
  const previousIds = workspace.proposals.map(item => item.id);
  await panel.getByLabel('修改后文字', { exact: true }).fill(replacement);
  assert.equal(await panel.getByLabel('修改文字片段', { exact: true }).isEnabled(), false, 'Unsaved fragment draft must keep its anchor');
  await panel.getByRole('button', { name: '保存修改草稿', exact: true }).click();
  workspace = await waitWorkspace(value => value.proposals.length === previousIds.length + 1); await ready();
  const proposal = workspace.proposals.find(item => !previousIds.includes(item.id));
  assert.equal(proposal.blockId, target.blockId); assert.equal(proposal.rangeStart, segment.rangeStart); assert.equal(proposal.rangeEnd, segment.rangeEnd); assert.equal(proposal.originalText, segment.text);
  const card = panel.locator(`[data-proposal-id="${proposal.id}"]`); assert.ok((await card.locator('.change-range-note').innerText()).includes('仅修改文字片段'));
  await card.getByRole('button', { name: status === 'accepted' ? '采纳这项修改' : '拒绝', exact: true }).click();
  workspace = await waitWorkspace(value => value.proposals.find(item => item.id === proposal.id).status === status); await ready();
  if (status === 'accepted') acceptedReplacements.push([segment.text, replacement]);
  await card.getByRole('button', { name: '编辑草稿', exact: true }).click();
  assert.equal(await panel.getByLabel('修改文字片段', { exact: true }).inputValue(), segment.id, 'Editing a persisted proposal must recover the exact fragment range');
  assert.equal(await panel.getByLabel('修改后文字', { exact: true }).inputValue(), replacement);
  return proposal;
}
try {
  await launch(); await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, inputPath);
  await page.locator('.import-button').click();
  const imported = await waitState(value => value.documents.some(item => item.name === filename)); const original = imported.documents.find(item => item.name === filename);
  await page.locator(`.document-item.active strong[title="${filename}"]`).waitFor(); await page.getByRole('button', { name: '本地规则检查', exact: true }).click();
  const reviewed = await waitState(value => value.tasks.some(item => item.documentId === original.id && ['completed', 'failed'].includes(item.status)));
  const task = reviewed.tasks.find(item => item.documentId === original.id); assert.equal(task.status, 'completed', task.error ?? ''); reviewId = task.resultId;
  panel = page.locator(`#changes-${reviewId}`); await panel.locator('summary.pane-heading').click(); await ready();
  workspace = await page.evaluate(id => window.contractAssistant.getChanges(id), reviewId);
  const permission = workspace.targets.find(item => item.text.startsWith('权限前文'));
  const bookmark = workspace.targets.find(item => item.text.startsWith('书签中段'));
  const numbering = workspace.targets.find(item => item.text.startsWith('编号修订正文'));
  const pagination = workspace.targets.find(item => item.text.startsWith('分页前正文'));
  const oldInsertion = workspace.targets.find(item => item.text.includes('旧插入修订文字'));
  for (const target of [permission, bookmark, numbering, pagination]) { assert.equal(target.editMode, 'segments'); assert.equal(target.editable, true); assert.ok(target.segments.some(item => !item.editable)); }
  assert.equal(oldInsertion.editable, false, 'Existing inserted body text is never opened for rewriting');
  for (const segmentId of [undefined, 'forged-segment', permission.segments.find(item => !item.editable).id]) {
    const error = await page.evaluate(async input => { try { await window.contractAssistant.saveChange(input); return null; } catch (error) { return error.message; } }, { reviewId, blockId: permission.blockId, findingId: null, ...(segmentId ? { segmentId } : {}), replacementText: '无效范围修改', expectedRevision: workspace.revision });
    assert.ok(error, `Segment ${segmentId} must be rejected`);
  }
  let segment = await selectFragment(permission, '权限中段。');
  const lockedOption = permission.segments.find(item => !item.editable); const lockedDOM = await panel.getByLabel('修改文字片段', { exact: true }).locator(`option[value="${lockedOption.id}"]`).evaluate(element => ({ disabled: element.disabled, html: element.outerHTML })); assert.equal(lockedDOM.disabled, true, JSON.stringify(lockedDOM));
  await saveAndDecide(permission, segment, '权限中段已明确书面确认。', 'accepted');
  segment = await selectFragment(permission, '权限后文。'); await saveAndDecide(permission, segment, '这一片段被拒绝，不应导出。', 'rejected');
  for (const [target, before, after] of [[bookmark, '书签中段。', '书签中段已明确履约要求。'], [numbering, '编号修订正文。', '编号修订正文已核对。'], [pagination, '分页前正文。', '分页前正文已核对。']]) {
    segment = await selectFragment(target, before);
    if (target === pagination) {
      const fixed = target.segments.find(item => !item.editable && item.text === '\n'); assert.ok(fixed); assert.equal(await panel.getByLabel('修改文字片段', { exact: true }).locator(`option[value="${fixed.id}"]`).evaluate(element => element.disabled), true);
      await panel.getByLabel('修改后文字', { exact: true }).fill('不得新增\n换行'); assert.equal(await panel.getByRole('button', { name: '保存修改草稿', exact: true }).isEnabled(), false);
    }
    await saveAndDecide(target, segment, after, 'accepted');
  }
  for (const [width, height] of [[1440, 900], [760, 560], [390, 844]]) {
    await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(0, 560); window.setContentSize(...size); }, [width, height]);
    await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await panel.locator('.change-segment-context').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const layout = await panel.evaluate(element => ({ doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, panel: element.scrollWidth, panelClient: element.clientWidth })); assert.ok(layout.doc <= layout.client + 1 && layout.panel <= layout.panelClient + 1, JSON.stringify(layout));
    await mkdir(join(root, 'output/playwright'), { recursive: true }); const screenshot = join(root, `output/playwright/complex-changes-${width}.png`); await page.screenshot({ path: screenshot, animations: 'disabled' }); layouts.push({ width, height, screenshot });
  }
  await panel.getByLabel('修改稿格式', { exact: true }).selectOption('clean');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, exportPath); await panel.getByRole('button', { name: '导出修改稿与清单', exact: true }).click();
  workspace = await waitWorkspace(value => value.exports.length === 1); await ready();
  const output = await JSZip.loadAsync(await readFile(exportPath)); let expectedXml = originalXml;
  for (const [before, after] of acceptedReplacements) expectedXml = expectedXml.replace(escapeXml(before), escapeXml(after));
  assert.equal(await output.file('word/document.xml').async('string'), expectedXml, 'Only accepted fragment text may change; anchors, styles, numbering revision, page break and old insertion must remain byte-for-byte');
  for (const entry of Object.values(originalZip.files).filter(item => !item.dir && item.name !== 'word/document.xml')) assert.deepEqual(await output.file(entry.name).async('nodebuffer'), await entry.async('nodebuffer'));
  assert.equal(createHash('sha256').update(await readFile(inputPath)).digest('hex'), originalHash);
  const paths = await panel.locator('.changes-export-paths dd').allTextContents(); const changeList = await readFile(paths[1], 'utf8'); assert.ok(changeList.includes('文字片段')); assert.ok(!changeList.includes('这一片段被拒绝'));
  await app.close(); app = undefined; await launch(); await page.locator('.document-item').filter({ has: page.locator(`strong[title="${filename}"]`) }).click();
  panel = page.locator(`#changes-${reviewId}`); await panel.locator('summary.pane-heading').click(); await ready(); workspace = await page.evaluate(id => window.contractAssistant.getChanges(id), reviewId);
  assert.equal(workspace.proposals.filter(item => item.status === 'accepted').length, 4); assert.equal(workspace.proposals.filter(item => item.status === 'rejected').length, 1); assert.equal(workspace.exports.length, 1);
  const restored = workspace.proposals.find(item => item.originalText === '权限中段。'); await panel.locator(`[data-proposal-id="${restored.id}"]`).getByRole('button', { name: '编辑草稿', exact: true }).click();
  assert.equal(await panel.getByLabel('修改文字片段', { exact: true }).inputValue(), permission.segments.find(item => item.text === restored.originalText).id);

  const preview = createPreviewBridge(); const sample = await preview.loadSample(); const previewTask = await preview.startReview({ documentId: sample.id, mode: 'local', context: { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '' } });
  while (['running', 'queued'].includes((await preview.getState()).tasks.find(item => item.id === previewTask.taskId).status)) await sleep(10);
  const previewReview = (await preview.getDocument(sample.id)).reviews[0]; let previewWorkspace = await preview.getChanges(previewReview.id); const previewTarget = previewWorkspace.targets.find(item => item.editMode === 'segments');
  const inputBase = { reviewId: previewReview.id, findingId: null, blockId: previewTarget.blockId, expectedRevision: previewWorkspace.revision, replacementText: '预览片段改写' };
  for (const segmentId of [undefined, 'forged-segment', previewTarget.segments.find(item => !item.editable).id]) await assert.rejects(() => preview.saveChange({ ...inputBase, ...(segmentId ? { segmentId } : {}) }), /片段/u);
  for (const part of previewTarget.segments.filter(item => item.editable).slice(0, 2)) {
    previewWorkspace = await preview.saveChange({ ...inputBase, segmentId: part.id, expectedRevision: previewWorkspace.revision, replacementText: `${part.text}（预览改写）` }); const proposal = previewWorkspace.proposals.at(-1);
    assert.equal(proposal.rangeStart, part.rangeStart); assert.equal(proposal.originalText, part.text); previewWorkspace = await preview.decideChange({ reviewId: previewReview.id, proposalId: proposal.id, expectedRevision: previewWorkspace.revision, status: 'accepted' });
  }
  assert.equal(previewWorkspace.proposals.filter(item => item.status === 'accepted').length, 2, 'Disjoint preview fragments may both be accepted');
  assert.deepEqual(errors, []); assert.deepEqual(network, []);
  console.log(JSON.stringify({ passed: true, isolatedProfile: true, localRuleAndManualOnly: true, explicitFragmentSelection: true, invalidSegmentRejected: true, lockedStructuresUnselectable: true, acceptedAndRejectedDisjointFragments: true, proposalRangeRecovered: true, originalHashUnchanged: true, exportedXmlOnlyAcceptedTextChanged: true, allOtherZipEntriesUnchanged: true, restartRestored: true, previewValidatesSegments: true, layouts, exportPath }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) { await mkdir(join(root, 'output/playwright'), { recursive: true }); await page.screenshot({ path: join(root, 'output/playwright/complex-changes-failure.png') }).catch(() => {}); console.error('UI failure state:', await page.locator('body').innerText().catch(() => 'unavailable')); }
  throw error;
} finally { await app?.close(); }
