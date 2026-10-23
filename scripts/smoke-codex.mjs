import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

// Explicit LIVE Codex acceptance. Only a synthetic sample contract is sent.
// The existing CLI owns authentication; no tokens are read by this script.
const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-codex-smoke-'));
const errors = []; let app;
async function launch() {
  const instance = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 30000 });
  const page = await instance.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.contractAssistant));
  await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  return { instance, page };
}
try {
  const opened = await launch(); app = opened.instance; const page = opened.page;
  await page.evaluate(() => window.contractAssistant.saveModelConfig({ provider: 'codex-cli', name: '本机Codex · 真实工程联调', baseUrl: 'codex://local', model: 'default', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 8192, contextWindowTokens: 65536, timeoutSeconds: 300 }));
  const document = await page.evaluate(() => window.contractAssistant.loadSample());
  const task = await page.evaluate(documentId => window.contractAssistant.startReview({ documentId, mode: 'model', context: { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '本次为工程联调，合同及主体均为虚构。仅依据提供文字分析，不使用工具；没有外部材料时引用保持为空。' } }), document.id);
  const deadline = Date.now() + 330000; let state;
  do {
    state = await page.evaluate(() => window.contractAssistant.getState());
    const current = state.tasks.find(item => item.id === task.taskId);
    if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) break;
    if (Date.now() > deadline) throw new Error('Live Codex review did not finish within its budget');
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (true);
  const finished = state.tasks.find(item => item.id === task.taskId);
  assert.equal(finished.status, 'completed', finished.error ?? JSON.stringify(finished));
  const detail = await page.evaluate(id => window.contractAssistant.getDocument(id), document.id);
  const review = detail.reviews.find(item => item.id === finished.resultId);
  assert.ok(review && review.mode === 'model');
  assert.equal(review.coverage.reviewedBlockIds.length, document.blockCount);
  assert.equal(review.coverage.totalBlockCount, document.blockCount);
  assert.ok(review.modelId);
  assert.equal(state.modelConfig.provider, 'codex-cli');
  assert.equal(state.modelConfig.hasApiKey, false);
  await page.reload();
  await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: '审核结果', exact: true }).waitFor();
  await mkdir(join(root, 'output/playwright'), { recursive: true });
  await page.screenshot({ path: join(root, 'output/playwright/codex-review.png'), fullPage: true });
  const reportPath = join(dataDir, 'Codex真实联调审核报告.md');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, reportPath);
  await page.getByRole('button', { name: '导出报告', exact: true }).click();
  await page.getByText(`报告已导出：${reportPath}`).waitFor();
  assert.ok((await readFile(reportPath, 'utf8')).includes(review.summary));
  await app.close(); app = undefined;
  const restored = await launch(); app = restored.instance;
  const restoredState = await restored.page.evaluate(() => window.contractAssistant.getState());
  const restoredDetail = await restored.page.evaluate(id => window.contractAssistant.getDocument(id), document.id);
  assert.equal(restoredState.modelConfig.provider, 'codex-cli');
  assert.ok(restoredDetail.reviews.some(item => item.id === review.id));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, liveCodex: true, syntheticContractOnly: true, dataDir,
    blocks: document.blockCount, reviewedBlocks: review.coverage.reviewedBlockIds.length, findings: review.findings.length,
    model: review.modelId, elapsedMs: review.elapsedMs, exportedAndRestored: true,
    legalQualityValidated: false, reportPath, screenshot: 'output/playwright/codex-review.png' }, null, 2));
} finally { await app?.close(); }
