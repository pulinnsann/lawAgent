import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { defaultRetrievalConfig } from '../src/shared/contracts.ts';

// Native setup-wizard smoke. Uses synthetic local documents and keys, disables
// all API/web retrieval, and never runs shell commands through the application.
// Run after build: node --import tsx scripts/smoke-setup.mjs
const root = resolve(import.meta.dirname, '..');
const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'law-agent-setup-smoke-')));
const folder = join(dataDir, '客户业务资料');
await mkdir(join(folder, '归档'), { recursive: true });
await mkdir(join(folder, '归档补充'), { recursive: true });
await mkdir(join(root, 'output/playwright'), { recursive: true });
const sources = {
  allowed: join(folder, '当前业务.txt'),
  markdown: join(folder, '历史资料.md'),
  large: join(folder, '大文件资料.txt'),
  excluded: join(folder, '归档', '排除资料.txt'),
  boundary: join(folder, '归档补充', '仍可使用.txt'),
};
await writeFile(sources.allowed, 'setupallowedtoken：服务采购应确认验收标准和付款条件。');
await writeFile(sources.markdown, '# 历史资料\nsetupmarkdowntoken：保密条款。');
await writeFile(sources.large, `${'background '.repeat(110000)}\nsetuplargetoken：合成大文件资料。`);
await writeFile(sources.excluded, 'setupexcludedtoken：拟排除的旧资料。');
await writeFile(sources.boundary, 'setupboundarytoken：目录边界检查，排除归档不应排除此文件。');
assert.ok((await readFile(sources.large)).length > 1024 * 1024);
const syntheticKnowledgeKey = 'setup-smoke-synthetic-knowledge-key';
const syntheticWebKey = 'setup-smoke-synthetic-web-key';
const initialPreferences = { displayName: '采购法务资料库', fileTypes: ['txt', 'md'], excludeDirectories: [],
  autoSyncEnabled: true, syncIntervalMinutes: 17, maxFileSizeMb: 2 };
const tightenedPreferences = { displayName: '当前采购资料库', fileTypes: ['txt'], excludeDirectories: ['归档'],
  autoSyncEnabled: false, syncIntervalMinutes: 23, maxFileSizeMb: 1 };
const errors = [];
const rendererNetwork = [];
let app;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function launch() {
  const instance = await electron.launch({ args: [root], cwd: root,
    env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 30000 });
  const page = await instance.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) rendererNetwork.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.contractAssistant));
  await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.contractAssistant.getState())).isPreview, false);
  return { instance, page };
}

async function openWizard(page) {
  if (await page.getByRole('button', { name: '展开合同列表', exact: true }).isVisible()) await page.getByRole('button', { name: '展开合同列表', exact: true }).click();
  await page.getByRole('button', { name: '环境与知识库配置', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: '环境与知识库配置', exact: true });
  await wizard.waitFor(); return wizard;
}

async function closeWizard(wizard) {
  if (await wizard.isVisible()) await wizard.getByRole('button', { name: /关闭环境与知识库配置|关闭配置向导|关闭向导/u }).click();
}

async function fillPreferences(wizard, preferences) {
  await wizard.getByLabel('知识库名称', { exact: true }).fill(preferences.displayName);
  for (const [type, label] of [['txt', 'TXT 文本'], ['md', 'Markdown'], ['docx', 'Word 文档'], ['pdf', 'PDF 文档']]) {
    await wizard.getByRole('checkbox', { name: label, exact: true }).setChecked(preferences.fileTypes.includes(type));
  }
  await wizard.getByLabel('排除目录（相对路径，一行一项）', { exact: true }).fill(preferences.excludeDirectories.join('\n'));
  const autoSync = wizard.getByRole('checkbox', { name: '启用自动同步', exact: true });
  await autoSync.check();
  await wizard.getByLabel('同步间隔（分钟）', { exact: true }).fill(String(preferences.syncIntervalMinutes));
  await autoSync.setChecked(preferences.autoSyncEnabled);
  await wizard.getByLabel('单文件上限（MiB）', { exact: true }).fill(String(preferences.maxFileSizeMb));
}

function assertConnections(config, baseline, restarted = false) {
  for (const field of ['enabled', 'provider', 'baseUrl', 'collectionId']) assert.deepEqual(config.knowledge.api[field], baseline.knowledge.api[field]);
  for (const field of ['enabled', 'provider', 'baseUrl', 'allowedDomains', 'fetchPages']) assert.deepEqual(config.web[field], baseline.web[field]);
  assert.equal(config.maxResults, baseline.maxResults); assert.equal(config.timeoutSeconds, baseline.timeoutSeconds);
  if (!restarted || baseline.knowledge.api.keyStorage === 'os-encrypted') assert.equal(config.knowledge.api.hasApiKey, true);
  if (!restarted || baseline.web.keyStorage === 'os-encrypted') assert.equal(config.web.hasApiKey, true);
  assert.ok(!JSON.stringify(config).includes(syntheticKnowledgeKey));
  assert.ok(!JSON.stringify(config).includes(syntheticWebKey));
}

async function waitSaved(page, preferences) {
  const deadline = Date.now() + 15000;
  let state;
  do {
    state = await page.evaluate(() => window.contractAssistant.getState());
    if (state.retrievalConfig?.knowledge.preferences?.displayName === preferences.displayName) {
      assert.deepEqual(state.retrievalConfig.knowledge.preferences, preferences);
      return state.retrievalConfig;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Wizard preferences were not saved: ${JSON.stringify(state)}`);
}

async function waitNewJob(page, previousId = null) {
  const deadline = Date.now() + 90000;
  let state;
  do {
    state = await page.evaluate(() => window.contractAssistant.getKnowledgeState());
    if (state.job && state.job.id !== previousId && state.job.status !== 'running') {
      assert.equal(state.job.status, 'completed', JSON.stringify(state.job));
      assert.equal(state.job.failed, 0, JSON.stringify(state.job.errors));
      return state;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Wizard build did not finish: ${JSON.stringify(state)}`);
}

async function hit(page, query, expectedPath) {
  const result = await page.evaluate(query => window.contractAssistant.searchKnowledge({ query, limit: 20 }), query);
  const match = result.hits.find(item => fileURLToPath(item.sourceUri) === expectedPath);
  assert.ok(match, `Missing ${query}: ${JSON.stringify(result)}`);
  return match;
}
async function absent(page, query) {
  const result = await page.evaluate(query => window.contractAssistant.searchKnowledge({ query, limit: 20 }), query);
  assert.deepEqual(result.hits, [], `Scope tightening must immediately hide ${query}`);
}

try {
  const opened = await launch(); app = opened.instance; let page = opened.page;
  const oldConfig = defaultRetrievalConfig();
  oldConfig.knowledge.api = { ...oldConfig.knowledge.api, enabled: false, provider: 'standard',
    baseUrl: 'http://127.0.0.1:9/v1', collectionId: 'preserved-setup-collection', apiKey: syntheticKnowledgeKey };
  oldConfig.web = { ...oldConfig.web, enabled: false, provider: 'searxng', baseUrl: 'http://127.0.0.1:9/search',
    allowedDomains: ['gov.cn', 'court.gov.cn'], fetchPages: false, apiKey: syntheticWebKey };
  oldConfig.maxResults = 6; oldConfig.timeoutSeconds = 17;
  const baseline = await page.evaluate(config => window.contractAssistant.saveRetrievalConfig(config), oldConfig);
  await page.reload(); await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  let wizard = await openWizard(page);
  await wizard.getByRole('button', { name: '检查并初始化环境', exact: true }).click();
  await wizard.getByText('环境已就绪', { exact: true }).waitFor();
  // The UI must render real native report rows; separately inspect the public
  // IPC report to verify all required capabilities actually passed.
  const environment = await page.evaluate(() => window.contractAssistant.checkEnvironment());
  assert.equal(environment.isPreview, false);
  assert.equal(environment.ready, true, JSON.stringify(environment));
  for (const id of ['runtime', 'storage', 'fts5', 'languages', 'index_worker', 'credentials']) {
    const check = environment.checks.find(item => item.id === id); assert.ok(check, `Missing environment check: ${id}`);
    if (id === 'credentials') assert.ok(['passed', 'warning'].includes(check.status), JSON.stringify(check));
    else assert.equal(check.status, 'passed', JSON.stringify(check));
    const row = wizard.locator('.environment-check').filter({ hasText: check.label });
    await row.waitFor(); assert.ok((await row.getAttribute('class')).includes(check.status));
  }
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, folder);
  await wizard.getByRole('button', { name: '选择资料目录', exact: true }).click();
  await page.waitForFunction(path => document.querySelector('input[readonly]')?.value === path, folder);
  assert.equal(await wizard.getByLabel('资料目录', { exact: true }).inputValue(), folder);
  await fillPreferences(wizard, initialPreferences);
  await wizard.getByRole('button', { name: '保存并建立知识库', exact: true }).click();
  const firstConfig = await waitSaved(page, initialPreferences);
  assertConnections(firstConfig, baseline);
  assert.equal(firstConfig.knowledge.folderPath, folder); assert.equal(firstConfig.knowledge.enabled, true);
  const built = await waitNewJob(page);
  assert.equal(built.indexedFiles, 5);
  assert.deepEqual(built.job.preferences, initialPreferences);
  const before = {
    markdown: await hit(page, 'setupmarkdowntoken', sources.markdown),
    excluded: await hit(page, 'setupexcludedtoken', sources.excluded),
    large: await hit(page, 'setuplargetoken', sources.large),
  };
  await hit(page, 'setupallowedtoken', sources.allowed); await hit(page, 'setupboundarytoken', sources.boundary);
  console.log('Native environment checks and wizard save/build passed');

  if (!(await wizard.isVisible())) wizard = await openWizard(page);
  await fillPreferences(wizard, tightenedPreferences);
  await wizard.getByRole('button', { name: '仅保存配置', exact: true }).click();
  const tightened = await waitSaved(page, tightenedPreferences); assertConnections(tightened, baseline);
  const unchangedJob = await page.evaluate(() => window.contractAssistant.getKnowledgeState());
  assert.equal(unchangedJob.job.id, built.job.id, 'Save-only must not create a sync task');
  for (const [kind, query] of [['markdown', 'setupmarkdowntoken'], ['excluded', 'setupexcludedtoken'], ['large', 'setuplargetoken']]) {
    await absent(page, query);
    await assert.rejects(page.evaluate(id => window.contractAssistant.getKnowledgeChunk(id), before[kind].chunkId));
  }
  await hit(page, 'setupallowedtoken', sources.allowed); await hit(page, 'setupboundarytoken', sources.boundary);
  await closeWizard(wizard);
  wizard = await openWizard(page);
  assert.equal(await wizard.getByLabel('知识库名称', { exact: true }).inputValue(), tightenedPreferences.displayName);
  assert.equal(await wizard.getByRole('checkbox', { name: '启用自动同步', exact: true }).isChecked(), false);
  await wizard.getByLabel('知识库名称', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(root, 'output/playwright/setup-desktop.png'), animations: 'disabled' });
  await closeWizard(wizard);
  // With automatic sync off, restart must not silently index a newly added file.
  await writeFile(join(folder, '关闭自动同步后的新增.txt'), 'setupautosyncofftoken：等待手工同步。');
  await app.close(); app = undefined;
  const restarted = await launch(); app = restarted.instance; page = restarted.page;
  await sleep(500);
  const restored = await page.evaluate(() => window.contractAssistant.getState());
  assert.deepEqual(restored.retrievalConfig.knowledge.preferences, tightenedPreferences);
  assertConnections(restored.retrievalConfig, baseline, true);
  const restoredIndex = await page.evaluate(() => window.contractAssistant.getKnowledgeState());
  assert.equal(restoredIndex.job.id, built.job.id, 'Automatic sync disabled must also disable startup refresh');
  await absent(page, 'setupautosyncofftoken');
  for (const query of ['setupmarkdowntoken', 'setupexcludedtoken', 'setuplargetoken']) await absent(page, query);
  await hit(page, 'setupallowedtoken', sources.allowed); await hit(page, 'setupboundarytoken', sources.boundary);
  assert.deepEqual(errors, []); assert.deepEqual(rendererNetwork, []);
  console.log(JSON.stringify({ passed: true, environment, indexedInitially: built.indexedFiles,
    preferences: tightenedPreferences, immediateExclusionWithoutRebuild: true, oldChunkReadBlocked: true,
    directoryBoundaryPreserved: true, apiAndWebSettingsPreserved: true, automaticStartupSyncDisabled: true,
    persistedAfterRestart: true, screenshot: 'output/playwright/setup-desktop.png' }, null, 2));
} finally {
  await app?.close(); await rm(dataDir, { recursive: true, force: true });
}
