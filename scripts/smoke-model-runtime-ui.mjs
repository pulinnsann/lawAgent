import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createDocx } from '../tests/fixtures-documents.ts';

// Real Electron/Main/Core/HTTP smoke. Everything is synthetic and the only
// model service is this process' loopback server. Do not build concurrently.
const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'law-runtime-ui-data-'));
const output = join(root, 'output/playwright/model-runtime'); await mkdir(output, { recursive: true });
const input = join(dataDir, 'synthetic-runtime-contract.docx');
await writeFile(input, await createDocx({ paragraphs: ['合成模型运行测试合同（无真实客户资料）', '服务内容为工程演示，验收后付款。 Payment after acceptance.', 'สัญญานี้ใช้ข้อมูลสมมติเพื่อทดสอบระบบเท่านั้น'] }));
const key = 'SYNTHETIC_RUNTIME_CREDENTIAL_783129_NOT_REAL';
const marker = 'ENGINEERING_SSE_VISIBLE_PREVIEW';
const requests = []; const errors = []; const screenshots = []; const layoutChecks = []; const rendererNetwork = [];
let scenario = 'success'; let pendingSuccess; let pendingCancelled; let app; let page;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, `Bearer ${key}`);
    let raw = ''; for await (const piece of request) raw += piece;
    const body = JSON.parse(raw); assert.equal(body.stream, true); assert.deepEqual(body.stream_options, { include_usage: true });
    const payload = JSON.parse(body.messages.findLast(item => item.role === 'user').content);
    assert.ok(payload.contractBlocks.length >= 3); requests.push({ scenario, stream: body.stream, authorizationMatched: true });
    if (scenario === 'failure') { response.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '1' }); response.end(`FORBIDDEN_FAILURE_BODY ${key}`); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const result = { summary: `${marker} 中英ไทย ${key}（纯工程样本，待人工复核）`, reviewedBlockIds: payload.contractBlocks.map(block => block.id), findings: [] };
    const full = JSON.stringify(result); const prefix = full.slice(0, full.indexOf(',"reviewedBlockIds"'));
    const event = text => response.write(`data: ${JSON.stringify({ model: 'synthetic-runtime-model', choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
    event(prefix);
    if (scenario === 'success') pendingSuccess = () => { event(full.slice(prefix.length)); response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`); response.write('data: {"choices":[],"usage":{"prompt_tokens":321,"completion_tokens":45}}\n\n'); response.end('data: [DONE]\n\n'); };
    else pendingCancelled = response;
  } catch (error) { errors.push(`mock:${error.message}`); if (!response.headersSent) response.writeHead(500); response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function poll(read, accept, label) { const deadline = Date.now() + 30000; while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await sleep(30); } throw new Error(`Timed out: ${label}`); }
const command = (action, payload = {}) => page.evaluate(value => window.contractAssistant.runWorkspaceCommand(value), { action, payload });
const state = () => page.evaluate(() => window.contractAssistant.getState());
async function openRuntime() { await page.getByRole('button', { name: '功能中心', exact: true }).click(); await page.getByRole('dialog', { name: '功能中心', exact: true }).getByRole('button').filter({ hasText: '模型运行与用量' }).click(); const panel = page.getByRole('region', { name: '模型运行与用量', exact: true }); await panel.getByLabel('streaming能力', { exact: true }).waitFor(); return panel; }
async function resize(width, height) { await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(0, 500); window.setContentSize(...size); }, [width, height]); await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]); }
async function shot(target, label, width, height) {
  await resize(width, height); await target.evaluate(element => { element.scrollTop = 0; element.scrollIntoView({ block: 'start', behavior: 'instant' }); });
  const size = await target.evaluate(element => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, panel: element.scrollWidth, client: element.clientWidth }));
  assert.ok(size.document <= size.viewport + 1 && size.panel <= size.client + 1, `${label}: ${JSON.stringify(size)}`);
  const path = join(output, `${label}-${width}.png`); await page.screenshot({ path, animations: 'disabled' }); screenshots.push(path); layoutChecks.push({ label, width, height, ...size });
}
async function startReview() { const before = new Set((await state()).tasks.map(task => task.id)); await page.getByRole('button', { name: '开始模型审核', exact: true }).click(); return poll(state, value => value.tasks.some(task => !before.has(task.id)), 'new review task').then(value => value.tasks.find(task => !before.has(task.id)).id); }
async function terminal(taskId, status) { return poll(state, value => value.tasks.some(task => task.id === taskId && task.status === status), `task ${status}`); }
try {
  app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '' }, timeout: 30000 });
  await app.evaluate(({ app, BrowserWindow }) => { const isolate = window => { window.webContents.setBackgroundThrottling(false); window.setFocusable(false); window.hide(); }; app.on('browser-window-created', (_event, window) => isolate(window)); for (const window of BrowserWindow.getAllWindows()) isolate(window); });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dataDir);
  page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/u.test(request.url())) rendererNetwork.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.contractAssistant)); await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  await page.evaluate(input => window.contractAssistant.saveModelConfig(input), { name: '本机SSE合成服务', baseUrl, model: 'synthetic-runtime-model', apiKey: key, responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 4096, contextWindowTokens: 65536, timeoutSeconds: 60 });
  await page.reload(); await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, input); await page.locator('.import-button').click();
  const imported = await poll(state, value => value.documents.length === 1, 'contract import'); const documentId = imported.documents[0].id;
  let panel = await openRuntime();
  await panel.getByLabel('streaming能力', { exact: true }).selectOption('supported'); await panel.getByLabel('jsonSchema能力', { exact: true }).selectOption('supported'); await panel.getByLabel('usage能力', { exact: true }).selectOption('supported');
  await panel.getByRole('checkbox', { name: /^使用已确认的HTTP流式/u }).check(); await panel.getByLabel('最多请求次数（包括重试）', { exact: true }).fill('4'); await panel.getByLabel('Token上限（留空不限）', { exact: true }).fill('200000');
  await panel.getByRole('button', { name: '保存运行配置', exact: true }).click(); await panel.getByRole('status').filter({ hasText: '配置已保存' }).waitFor();
  const settings = await command('modelRuntime.settings.get'); assert.equal(settings.body.streaming, true); assert.equal(settings.body.budget.maxCalls, 4); assert.equal(settings.body.budget.maxTokens, 200000); assert.equal(settings.body.retry.enabled, false);
  for (const [width, height] of [[1440, 900], [760, 560], [390, 844]]) await shot(panel, 'settings', width, height);
  await resize(1440, 900); await page.locator('.model-runtime-panel').evaluate(element => { element.scrollTop = 0; }); await page.locator('.model-runtime-panel>header button').click();
  await page.evaluate(() => { globalThis.__runtimeUiEvents = []; window.contractAssistant.onTaskUpdate(task => { globalThis.__runtimeUiEvents.push({ id: task.id, stage: task.stage, status: task.status, characters: task.runtimeProgress?.characters ?? null }); }); });
  const successId = await startReview(); await poll(() => pendingSuccess, Boolean, 'success stream open');
  await poll(() => command('workspace.progress', { requestId: successId }), value => value.modelRuntime?.characters > 0, 'core stream characters');
  const preview = page.locator('.model-stream-preview'); await preview.locator('summary').filter({ hasText: /已收到 [1-9]\d* 字符/u }).waitFor(); await preview.locator('summary').click(); await preview.getByText(new RegExp(marker, 'u')).waitFor();
  assert(!(await preview.innerText()).includes(key)); assert((await preview.innerText()).includes('已隐藏凭据'));
  for (const [width, height] of [[1440, 900], [760, 560], [390, 844]]) await shot(preview, 'stream-preview', width, height);
  await resize(1440, 900); pendingSuccess(); await terminal(successId, 'completed');
  const successLedger = await poll(() => command('modelRuntime.ledger.list', { taskId: successId }), rows => rows[0]?.body.status === 'completed', 'completed ledger');
  assert.equal(successLedger[0].body.calls.length, 1); assert.equal(successLedger[0].body.calls[0].inputTokens, 321); assert.equal(successLedger[0].body.totals.cost, null);
  const detail = await page.evaluate(id => window.contractAssistant.getDocument(id), documentId); assert(!JSON.stringify(detail).includes(key));
  scenario = 'cancelled'; const cancelledId = await startReview(); await poll(() => pendingCancelled, Boolean, 'cancel stream open'); await page.locator('.model-stream-preview summary').filter({ hasText: /已收到 [1-9]\d* 字符/u }).waitFor(); await page.getByRole('button', { name: '取消任务', exact: true }).click(); await terminal(cancelledId, 'cancelled');
  const cancelledLedger = await poll(() => command('modelRuntime.ledger.list', { taskId: cancelledId }), rows => rows[0]?.body.status === 'cancelled', 'cancelled ledger'); assert.equal(cancelledLedger[0].body.calls.length, 1); assert.equal(cancelledLedger[0].body.calls[0].status, 'cancelled'); assert.equal(cancelledLedger[0].body.totals.cost, null);
  scenario = 'failure'; const failedId = await startReview(); await terminal(failedId, 'failed');
  const failedLedger = await poll(() => command('modelRuntime.ledger.list', { taskId: failedId }), rows => rows[0]?.body.status === 'failed', 'failed ledger'); assert.equal(failedLedger[0].body.calls.length, 1); assert.equal(failedLedger[0].body.calls[0].httpStatus, 503);
  panel = await openRuntime(); await panel.getByRole('button', { name: '刷新台账', exact: true }).click(); await panel.getByText('费用未知', { exact: false }).first().waitFor();
  for (const [width, height] of [[1440, 900], [760, 560], [390, 844]]) await shot(panel.locator('aside'), 'ledger', width, height);
  assert.deepEqual(errors, []); assert.deepEqual(rendererNetwork, []); assert.equal(requests.length, 3);
  await app.close(); app = undefined;
  const bytes = await readFile(join(dataDir, 'workspace.sqlite')); assert(!bytes.includes(Buffer.from(key))); assert(!bytes.includes(Buffer.from('FORBIDDEN_FAILURE_BODY')));
  const manifest = { passed: true, syntheticOnly: true, noCustomerData: true, loopbackOnly: true, runtimeSettingsSavedThroughUI: true, actualMainCoreHttpSseReview: true, previewVisibleAndRedacted: true, successCancelledFailedLedgers: true, unknownPricesRemainUnknown: true, defaultNoRetriesVerified: true, noPlaintextCredentialInBusinessDatabase: true, tasks: { successId, cancelledId, failedId }, requests, layoutChecks, screenshots: await Promise.all(screenshots.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }))), dataDir, databaseSha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2)); console.log(JSON.stringify(manifest, null, 2));
} catch (error) { if (page && !page.isClosed()) { await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => 'no UI')); console.error('TASK_EVENTS', await page.evaluate(() => globalThis.__runtimeUiEvents ?? []).catch(() => [])); } throw error; }
finally { await app?.close(); pendingCancelled?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
