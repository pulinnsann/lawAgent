import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import initSqlJs from 'sql.js';
import { createPreviewBridge } from '../src/renderer/src/preview-bridge.ts';

// Offline, real-Electron UI regression. Does not click connectivity/review,
// invoke Codex, or read user profiles. Model configuration writes are confined
// to this disposable LAW_AGENT_DATA_DIR; every key below is synthetic.
const root = resolve(import.meta.dirname, '..');
const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'law-agent-codex-ui-')));
assert.notEqual(dataDir, resolve(root, '.local/data'));
const screenshotsDir = join(root, 'output/playwright');
const savedKey = 'synthetic-api-key-for-codex-ui-regression';
const draftKey = 'synthetic-unsaved-api-draft-key';
const apiBase = 'http://127.0.0.1:17771/v1';
const errors = [];
const rendererNetwork = [];
const layouts = [];
let app;
let page;

async function launch() {
  app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 30000 });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dataDir);
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) rendererNetwork.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.contractAssistant));
  await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
}

async function waitConfig(provider) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.contractAssistant.getState());
    if ((state.modelConfig?.provider ?? 'chat-completions') === provider && state.modelConfig) {
      assert.equal(state.documents.length, 0); assert.equal(state.tasks.length, 0);
      assert.equal(state.retrievalConfig, null);
      assert.ok(!JSON.stringify(state).includes(savedKey));
      assert.ok(!JSON.stringify(state).includes(draftKey));
      return state.modelConfig;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`The UI did not save provider ${provider}`);
}

async function waitReady() {
  await page.waitForFunction(() => {
    const save = document.querySelector('button[form="model-settings-form"]');
    return save instanceof HTMLButtonElement && !save.disabled;
  });
}

async function openSettings() {
  await page.locator('.topbar-settings').click();
  const dialog = page.getByRole('dialog', { name: '模型连接设置', exact: true });
  await dialog.waitFor(); return dialog;
}

async function readModelProfiles() {
  const SQL = await initSqlJs();
  const database = new SQL.Database(await readFile(join(dataDir, 'workspace.sqlite')));
  try {
    assert.deepEqual(database.exec('PRAGMA foreign_key_check'), []);
    return database.exec("SELECT adapter_id,enabled,credential_ref,settings_json FROM provider_profiles WHERE adapter_id IN ('chat-completions','codex-cli')")[0].values.map(([provider, enabled, credentialRef, settings]) => ({ provider, enabled, credentialRef, settings: JSON.parse(settings) }));
  } finally { database.close(); }
}

try {
  await mkdir(screenshotsDir, { recursive: true });
  await launch();
  let dialog = await openSettings();
  const provider = dialog.getByLabel('模型连接方式', { exact: true });
  assert.equal(await provider.inputValue(), 'chat-completions');
  await dialog.getByLabel('连接名称', { exact: true }).fill('保留的 API 连接');
  await dialog.getByLabel(/^API 地址/u).fill(apiBase);
  await dialog.getByLabel('模型名称', { exact: true }).fill('synthetic-http-model');
  await dialog.getByLabel(/^API 密钥/u).fill(savedKey);
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  const originalApi = await waitConfig('chat-completions'); await waitReady();
  assert.equal(originalApi.hasApiKey, true);

  await dialog.getByLabel('连接名称', { exact: true }).fill('未保存的 API 草稿');
  await dialog.getByLabel('模型名称', { exact: true }).fill('unsaved-model-draft');
  await dialog.getByLabel(/^API 密钥/u).fill(draftKey);
  await dialog.getByRole('button', { name: '使用本机 Codex', exact: true }).click();
  assert.equal(await provider.inputValue(), 'codex-cli');
  assert.equal(await dialog.getByLabel(/^API 地址/u).count(), 0);
  assert.equal(await dialog.getByLabel(/^API 密钥/u).count(), 0);
  assert.equal(await dialog.getByLabel(/^响应格式/u).count(), 0);
  assert.equal(await dialog.getByLabel(/^输出 Token 参数/u).count(), 0);
  assert.equal(await dialog.getByLabel(/^模型名称/u).inputValue(), 'default');
  await provider.selectOption('chat-completions');
  assert.equal(await dialog.getByLabel('连接名称', { exact: true }).inputValue(), '未保存的 API 草稿');
  assert.equal(await dialog.getByLabel('模型名称', { exact: true }).inputValue(), 'unsaved-model-draft');
  assert.equal(await dialog.getByLabel(/^API 地址/u).inputValue(), apiBase);
  assert.equal(await dialog.getByLabel(/^API 密钥/u).inputValue(), draftKey);
  await provider.selectOption('codex-cli');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  const codex = await waitConfig('codex-cli'); await waitReady();
  assert.equal(codex.baseUrl, 'codex://local'); assert.equal(codex.model, 'default');
  assert.equal(codex.responseFormat, 'json_schema'); assert.equal(codex.tokenParameter, 'max_tokens');
  assert.equal(codex.hasApiKey, false); assert.equal(codex.timeoutSeconds, 300);
  const profiles = await readModelProfiles();
  const apiProfile = profiles.find(item => item.provider === 'chat-completions');
  const codexProfile = profiles.find(item => item.provider === 'codex-cli');
  assert.ok(apiProfile); assert.ok(codexProfile);
  assert.equal(apiProfile.settings.name, originalApi.name);
  assert.equal(apiProfile.settings.model, originalApi.model);
  assert.equal(apiProfile.settings.baseUrl, originalApi.baseUrl);
  assert.equal(apiProfile.enabled, 0); assert.equal(codexProfile.enabled, 1);
  assert.equal(codexProfile.credentialRef, null);
  assert.ok(!JSON.stringify(profiles).includes(savedKey));
  assert.ok(!JSON.stringify(profiles).includes(draftKey));
  assert.equal('apiKey' in codexProfile.settings, false);
  assert.equal('clearApiKey' in codexProfile.settings, false);

  for (const [width, height] of [[1440, 900], [760, 560], [390, 844]]) {
    await app.evaluate(({ BrowserWindow }, dimensions) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(dimensions.width < 760 ? 0 : 760, 560);
      window.setContentSize(dimensions.width, dimensions.height);
    }, { width, height });
    await page.waitForFunction(dimensions => innerWidth === dimensions.width && innerHeight === dimensions.height, { width, height });
    const layout = await dialog.evaluate(element => {
      const body = element.querySelector('.settings-body'); const footer = element.querySelector('.settings-footer');
      const save = footer.querySelector('button.primary');
      const bounds = target => { const box = target.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; };
      const before = body.scrollTop; body.scrollTop = Math.min(120, body.scrollHeight - body.clientHeight);
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
        bodyWidth: body.scrollWidth, bodyClientWidth: body.clientWidth, canScroll: body.scrollHeight > body.clientHeight, scrollMoved: before !== body.scrollTop,
        footer: bounds(footer), save: bounds(save) };
    });
    assert.ok(layout.documentWidth <= layout.clientWidth + 1, JSON.stringify(layout));
    assert.ok(layout.bodyWidth <= layout.bodyClientWidth + 1, JSON.stringify(layout));
    for (const box of [layout.footer, layout.save]) assert.ok(box.left >= -1 && box.right <= width + 1 && box.top >= -1 && box.bottom <= height + 1, JSON.stringify(layout));
    if (width <= 760) assert.ok(layout.canScroll, JSON.stringify(layout));
    const screenshot = join(screenshotsDir, `codex-settings-${width}.png`);
    await page.screenshot({ path: screenshot, animations: 'disabled' });
    layouts.push({ width, height, forcedBelowDesktopMinimum: width < 760, screenshot });
  }

  await app.close(); app = undefined;
  await launch();
  const restored = await waitConfig('codex-cli');
  assert.equal(restored.model, codex.model);
  dialog = await openSettings();
  assert.equal(await dialog.getByLabel('模型连接方式', { exact: true }).inputValue(), 'codex-cli');
  await dialog.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  const reusableApi = await page.evaluate(input => window.contractAssistant.saveModelConfig(input), {
    provider: 'chat-completions', name: originalApi.name, baseUrl: originalApi.baseUrl, model: originalApi.model,
    responseFormat: originalApi.responseFormat, tokenParameter: originalApi.tokenParameter, maxOutputTokens: originalApi.maxOutputTokens,
    contextWindowTokens: originalApi.contextWindowTokens, timeoutSeconds: originalApi.timeoutSeconds,
  });
  if (originalApi.keyStorage === 'os-encrypted') assert.equal(reusableApi.hasApiKey, true, 'Returning to the same API must reuse its encrypted key');
  assert.ok(!JSON.stringify(reusableApi).includes(savedKey));
  const preview = createPreviewBridge();
  await preview.saveModelConfig({ provider: 'codex-cli', name: codex.name, baseUrl: codex.baseUrl, model: codex.model, responseFormat: codex.responseFormat, tokenParameter: codex.tokenParameter, maxOutputTokens: codex.maxOutputTokens, contextWindowTokens: codex.contextWindowTokens, timeoutSeconds: codex.timeoutSeconds });
  assert.equal((await preview.getState()).modelConfig.provider, 'codex-cli');
  assert.equal((await preview.getState()).modelConfig.hasApiKey, false);
  await assert.rejects(preview.testModelConnection(), /没有执行 Codex/u);
  assert.deepEqual(rendererNetwork, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, isolatedProfile: true, codexExecuted: false, modelRequests: 0,
    apiDraftPreserved: true, apiProfileAndCredentialRetained: true, codexConfigRestored: true,
    previewDoesNotExecuteCodex: true, layouts }, null, 2));
} finally {
  try { await app?.close(); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}
