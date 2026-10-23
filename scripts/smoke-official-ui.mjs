import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

// LIVE official-source UI acceptance. Run explicitly after a production build:
// node --import tsx scripts/smoke-official-ui.mjs
// Uses an isolated disposable profile, empty KB/search connections, and a
// loopback model sentinel that must receive zero requests. The real catalog and
// articles are read by the Electron worker; no public response is intercepted.
const root = resolve(import.meta.dirname, '..');
const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'law-agent-official-ui-')));
assert.notEqual(dataDir, resolve(root, '.local/data'));
const screenshotsDir = join(root, 'output/playwright');
const errors = [];
const rendererNetwork = [];
const modelRequests = [];
const layouts = [];
let app;
let page;
let modelBaseline;
let modelServerListening = false;
const modelServer = createServer((request, response) => {
  modelRequests.push({ method: request.method, path: request.url });
  request.resume(); response.writeHead(500, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'This UI test must not invoke a model.' }));
});
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function assertLocalBoundaries(state) {
  assert.equal(state.isPreview, false);
  assert.equal(state.documents.length, 0, 'Connection tests must not import synthetic contracts');
  assert.equal(state.tasks.length, 0, 'Connection tests must not create review tasks');
  if (modelBaseline) assert.deepEqual(state.modelConfig, modelBaseline, 'Retrieval UI must preserve the model connection');
  const config = state.retrievalConfig;
  if (config) {
    assert.equal(config.knowledge.enabled, false);
    assert.equal(config.knowledge.folderPath, null);
    assert.equal(config.knowledge.api.enabled, false);
    assert.equal(config.knowledge.api.baseUrl, '');
    assert.equal(config.knowledge.api.collectionId, '');
    assert.equal(config.knowledge.api.hasApiKey, false);
    assert.equal(config.web.enabled, false);
    assert.equal(config.web.baseUrl, '');
    assert.equal(config.web.hasApiKey, false);
  }
  assert.deepEqual(modelRequests, [], 'Official-source UI operations must not send model requests');
}

async function waitOfficialSaved(expected) {
  const deadline = Date.now() + 15000;
  let state;
  do {
    state = await page.evaluate(() => window.contractAssistant.getState());
    if (JSON.stringify(state.retrievalConfig?.official) === JSON.stringify(expected)) {
      assertLocalBoundaries(state); return state;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Official-source settings were not saved: ${JSON.stringify(state?.retrievalConfig?.official)}`);
}

async function waitTestEnabled(enabled, timeout = 15000) {
  await page.waitForFunction(expected => {
    const button = document.querySelector('.official-test-actions > button');
    return button instanceof HTMLButtonElement && button.disabled === !expected;
  }, enabled, { timeout });
}

async function saveUsingUi(dialog, expected) {
  await dialog.locator('.settings-footer').getByRole('button', { name: '保存配置', exact: true }).click();
  const state = await waitOfficialSaved(expected);
  await waitTestEnabled(expected.enabled);
  return state;
}

async function resizeContent(width, height) {
  await app.evaluate(({ BrowserWindow }, dimensions) => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length !== 1) throw new Error('Expected exactly one isolated test window');
    const window = windows[0];
    // 390px is a renderer stress test only; production keeps its 760px minimum.
    window.setMinimumSize(dimensions.width < 760 ? 0 : 760, 560);
    window.setContentSize(dimensions.width, dimensions.height);
  }, { width, height });
  await page.waitForFunction(dimensions => Math.abs(innerWidth - dimensions.width) <= 1 && Math.abs(innerHeight - dimensions.height) <= 1, { width, height });
}

async function checkLayoutAndCapture(dialog, result, width, height) {
  await resizeContent(width, height);
  const body = dialog.locator('.settings-body');
  const scrolling = await body.evaluate(element => {
    element.scrollTop = 0;
    const initial = element.scrollTop;
    element.scrollTop = Math.min(120, element.scrollHeight - element.clientHeight);
    return { initial, after: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
  });
  assert.ok(scrolling.clientHeight > 0 && scrolling.scrollHeight > scrolling.clientHeight, `Settings body must be independently scrollable at ${width}px`);
  assert.ok(scrolling.after > scrolling.initial, `Settings body did not scroll at ${width}px`);
  await result.locator('.official-coverage').first().scrollIntoViewIfNeeded();
  const layout = await dialog.evaluate(element => {
    const footer = element.querySelector('.settings-footer');
    const body = element.querySelector('.settings-body');
    const save = footer?.querySelector('button.primary');
    const box = target => { const r = target.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height }; };
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth, dialogWidth: element.scrollWidth, dialogClientWidth: element.clientWidth,
      bodyWidth: body.scrollWidth, bodyClientWidth: body.clientWidth, footer: box(footer), save: box(save) };
  });
  assert.ok(layout.documentWidth <= layout.clientWidth + 1, `Document overflow at ${width}px: ${JSON.stringify(layout)}`);
  assert.ok(layout.dialogWidth <= layout.dialogClientWidth + 1, `Dialog overflow at ${width}px: ${JSON.stringify(layout)}`);
  assert.ok(layout.bodyWidth <= layout.bodyClientWidth + 1, `Settings body overflow at ${width}px: ${JSON.stringify(layout)}`);
  for (const [name, box] of [['footer', layout.footer], ['save button', layout.save]]) {
    assert.ok(box.height > 0 && box.top >= -1 && box.bottom <= layout.height + 1 && box.left >= -1 && box.right <= layout.width + 1, `${name} outside viewport at ${width}px: ${JSON.stringify(layout)}`);
  }
  const screenshot = join(screenshotsDir, `official-ui-${width}.png`);
  await page.screenshot({ path: screenshot, animations: 'disabled' });
  layouts.push({ width, height, forcedBelowDesktopMinimum: width < 760, bodyScrolls: true, screenshot });
}

try {
  await mkdir(screenshotsDir, { recursive: true });
  await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', resolve); });
  modelServerListening = true;
  app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 30000 });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dataDir);
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) rendererNetwork.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.contractAssistant));
  await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  await resizeContent(1440, 900);
  const initial = await page.evaluate(() => window.contractAssistant.getState());
  assert.equal(initial.modelConfig, null); assertLocalBoundaries(initial);
  // A model endpoint is configured solely as a zero-call sentinel. No connection
  // test or review is invoked, and no contract is imported into this profile.
  modelBaseline = await page.evaluate(baseUrl => window.contractAssistant.saveModelConfig({
    name: '官方配置UI验收：禁止调用的本机模型哨兵', baseUrl, model: 'official-ui-zero-call-sentinel',
    responseFormat: 'json_object', tokenParameter: 'max_tokens', maxOutputTokens: 1024,
    contextWindowTokens: 16384, timeoutSeconds: 5,
  }), `http://127.0.0.1:${modelServer.address().port}/v1`);

  await page.getByRole('button', { name: '资料连接设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '资料连接设置', exact: true });
  await dialog.waitFor();
  const enabled = dialog.getByRole('checkbox', { name: '启用官方公开来源检索', exact: true });
  const pages = dialog.getByLabel(/^每次读取目录页数上限/u);
  const urls = dialog.getByLabel(/^指定官方原文链接（可选，一行一个）/u);
  const query = dialog.getByLabel(/^目录标题关键词（本机匹配）/u);
  const test = dialog.locator('.official-test-actions > button').first();
  assert.equal(await enabled.isChecked(), false);
  await waitTestEnabled(false);
  await enabled.check(); await pages.fill('1'); await waitTestEnabled(false);
  let saved = await saveUsingUi(dialog, { enabled: true, maxCatalogPages: 1, sourceUrls: [] });
  const baselineConnections = { knowledge: saved.retrievalConfig.knowledge, web: saved.retrievalConfig.web };
  await pages.fill('2'); await waitTestEnabled(false);
  await saveUsingUi(dialog, { enabled: true, maxCatalogPages: 2, sourceUrls: [] });
  await pages.fill('1'); await waitTestEnabled(false);
  await saveUsingUi(dialog, { enabled: true, maxCatalogPages: 1, sourceUrls: [] });
  const supplementalUrl = 'https://www.court.gov.cn/fabu/xiangqing/431662.html';
  await urls.fill(supplementalUrl); await waitTestEnabled(false);
  await saveUsingUi(dialog, { enabled: true, maxCatalogPages: 1, sourceUrls: [supplementalUrl] });
  await urls.fill(''); await waitTestEnabled(false);
  saved = await saveUsingUi(dialog, { enabled: true, maxCatalogPages: 1, sourceUrls: [] });
  assert.deepEqual({ knowledge: saved.retrievalConfig.knowledge, web: saved.retrievalConfig.web }, baselineConnections);
  console.log('Official-source enable/save and unsaved page/URL boundaries passed through real UI');

  await query.fill('市场');
  console.log('Reading the LIVE official catalog: query=市场, pages=1, sourceUrls=[]');
  await test.click();
  await waitTestEnabled(true, 130000);
  const result = dialog.locator('.official-test-result');
  await result.waitFor({ timeout: 130000 });
  const cards = result.locator('.source-evidence-card');
  const count = await cards.count();
  assert.ok(count > 0, `Live catalog returned no source cards: ${await result.innerText()}`);
  const coverage = await result.locator('.official-coverage').first().evaluate(element => Object.fromEntries(
    [...element.querySelectorAll('dl > div')].map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]),
  ));
  assert.deepEqual(coverage['目录页数']?.match(/\d+/gu)?.map(Number), [1, 1, 1], JSON.stringify(coverage));
  assert.equal(Number(coverage['读取失败']?.match(/\d+/u)?.[0]), 0, JSON.stringify(coverage));
  assert.equal(await cards.locator('.source-badges .unknown').count(), count, 'Source cards must retain unknown validity');
  const sourceDetails = [];
  for (let index = 0; index < count; index++) {
    const card = cards.nth(index);
    const url = (await card.locator('.source-uri').innerText()).trim();
    assert.match(url, /^https:\/\/xzfg\.moj\.gov\.cn\/front\/law\/detail\?LawID=\d+$/u);
    const excerpt = await card.locator('.source-excerpt').innerText();
    assert.ok(excerpt.trim().length > 80, 'A title or search snippet cannot replace the real article text');
    sourceDetails.push({ title: await card.locator('.source-evidence-heading > strong').innerText(), url, excerptCharacters: excerpt.length });
  }
  assert.equal(await dialog.locator('.settings-footer .settings-notice.error').count(), 0, 'Finite successful directory coverage must not be presented as a connection failure');
  assertLocalBoundaries(await page.evaluate(() => window.contractAssistant.getState()));
  console.log(`Live UI returned ${count} original source cards with visible coverage and unknown validity`);

  for (const [width, height] of [[1440, 900], [760, 560], [390, 844]]) await checkLayoutAndCapture(dialog, result, width, height);

  await resizeContent(1440, 900);
  const beforeCancel = await page.evaluate(() => window.contractAssistant.getState());
  await query.fill('市场'); await test.click();
  const cancel = dialog.getByRole('button', { name: '取消本次测试', exact: true });
  let cancelClicked = false;
  try { await cancel.click({ timeout: 1500 }); cancelClicked = true; }
  catch (error) {
    // A live response may finish before the cancellation click. That is valid;
    // only ignore this race if the normal test action is already enabled again.
    if (!(await test.isEnabled())) throw error;
  }
  await waitTestEnabled(true, 130000);
  const afterCancel = await page.evaluate(() => window.contractAssistant.getState());
  assert.deepEqual(afterCancel.retrievalConfig, beforeCancel.retrievalConfig, 'Cancel must not save or mutate configuration');
  assertLocalBoundaries(afterCancel);
  if (cancelClicked) assert.equal(await dialog.locator('.settings-footer .settings-notice.error').count(), 0, 'User cancellation must not be presented as a retrieval fault');
  assert.deepEqual(errors, []); assert.deepEqual(rendererNetwork, []); assert.deepEqual(modelRequests, []);
  console.log(JSON.stringify({ passed: true, isolatedProfile: true, uiConfiguredOfficialSources: true,
    dirtyPageAndUrlChangesBlockTesting: true, liveCatalogQuery: '市场', liveCatalogPages: 1,
    prefilledDetailUrls: false, coverage, sources: sourceDetails, legalValidityVerified: false,
    kbAndSearchUnconfigured: true, modelRequests: modelRequests.length, reviewTasksCreated: 0,
    cancelClicked, cancelDoesNotChangeConfiguration: true, layouts }, null, 2));
} finally {
  try { await app?.close(); }
  finally {
    modelServer.closeAllConnections();
    if (modelServerListening) await new Promise(resolve => modelServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}
