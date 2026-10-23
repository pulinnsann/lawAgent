import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createSampleContract } from '../src/core/sample.ts';
import { createPdf } from '../tests/fixtures-documents.ts';

// Native Electron integration smoke. Uses a synthetic DOCX and a loopback-only
// model stub; never needs a real API key or sends a contract to a cloud service.
const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-desktop-smoke-'));
const inputPath = join(dataDir, '桌面流程样例.docx');
const reportPath = join(dataDir, '审核报告.md');
const pdfPath = join(dataDir, '三语文字样例.pdf');
await writeFile(inputPath, await createSampleContract());
await writeFile(pdfPath, createPdf([['合同付款需核实。', 'Payment requires confirmation.', 'ข้อความภาษาไทย']]));
await mkdir(join(root, 'output/playwright'), { recursive: true });
let modelRequests = 0;
let reviewRequests = 0;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, undefined);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    modelRequests++;
    let data;
    try { data = JSON.parse(body.messages[1].content); } catch { data = null; }
    let result = { ok: true };
    if (data?.contractBlocks) {
      reviewRequests++;
      const block = data.contractBlocks.find(item => item.text.includes('验收：'));
      assert.ok(block);
      result = {
        summary: '桌面流程联调：需人工明确验收标准、程序与异议期限。',
        reviewedBlockIds: data.contractBlocks.map(item => item.id),
        findings: [{ blockIds: [block.id], quote: block.text, title: '验收安排需要进一步明确', category: 'commercial', severity: 'medium', description: '当前约定以完成服务直接视为验收，需结合履约事实复核。', suggestion: '由双方确认可操作的验收标准、验收程序和异议期限。', legalBasis: null }],
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'desktop-smoke-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }));
  } catch (error) {
    res.writeHead(500); res.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
let app;
const errors = [];
async function launch() {
  const instance = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 30000 });
  const page = await instance.firstWindow();
  page.setDefaultTimeout(15000);
  console.log('Desktop window opened');
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForFunction(() => Boolean(window.contractAssistant));
  await page.getByText('正在读取工作空间').waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.contractAssistant.getState())).isPreview, false);
  return { instance, page };
}
try {
  ({ instance: app } = await launch());
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.input] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.report });
  }, { input: inputPath, report: reportPath });
  await page.getByRole('button', { name: /导入合同/ }).click();
  await page.getByText('合同已导入，请确认审核背景后开始。').waitFor();
  console.log('Native file import passed');
  const imported = await page.evaluate(() => window.contractAssistant.getState());
  assert.equal(imported.documents.length, 1);
  assert.equal(imported.documents[0].format, 'docx');
  assert.ok(imported.documents[0].blockCount >= 10);
  await page.getByRole('button', { name: '本地规则检查', exact: true }).click();
  await page.getByText('检查结果已保存', { exact: true }).waitFor();
  console.log('Local rule check passed');
  await page.locator('.topbar-settings').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('连接名称', { exact: true }).fill('桌面联调模型');
  await dialog.getByLabel(/^API 地址/).fill(endpoint);
  await dialog.getByLabel('模型名称', { exact: true }).fill('desktop-smoke-model');
  assert.equal(await dialog.getByLabel('模型名称', { exact: true }).inputValue(), 'desktop-smoke-model');
  await dialog.getByRole('button', { name: '保存并测试连接', exact: true }).click();
  await dialog.getByText(/API 调用成功/).waitFor({ timeout: 15000 });
  console.log('Model connection passed');
  await dialog.getByRole('button', { name: '关闭模型设置' }).click();
  await page.getByRole('button', { name: '开始模型审核', exact: true }).click();
  await page.getByRole('heading', { name: '验收安排需要进一步明确' }).waitFor({ timeout: 15000 });
  console.log('Model review passed');
  await page.getByRole('button', { name: '定位原文', exact: true }).click();
  await page.locator('.contract-block.highlighted').waitFor();
  await page.getByRole('button', { name: '导出报告', exact: true }).click();
  await page.getByText(`报告已导出：${reportPath}`).waitFor();
  assert.match(await readFile(reportPath, 'utf8'), /验收安排需要进一步明确/);
  await page.screenshot({ path: join(root, 'output/playwright/desktop-review.png'), fullPage: true });
  const state = await page.evaluate(() => window.contractAssistant.getState());
  assert.equal(state.tasks.filter(task => task.status === 'completed').length, 2);
  assert.equal(state.modelConfig.model, 'desktop-smoke-model');
  assert.equal(state.modelConfig.hasApiKey, false);
  const documentId = state.documents[0].id;
  assert.equal((await page.evaluate(id => window.contractAssistant.getDocument(id), documentId)).reviews.length, 2);
  await app.close(); app = undefined;
  const restarted = await launch(); app = restarted.instance;
  const restored = await restarted.page.evaluate(() => window.contractAssistant.getState());
  assert.equal(restored.documents[0].id, documentId);
  assert.equal(restored.modelConfig.baseUrl, endpoint);
  assert.equal((await restarted.page.evaluate(id => window.contractAssistant.getDocument(id), documentId)).reviews.length, 2);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, pdfPath);
  await restarted.page.getByRole('button', { name: /导入合同/ }).click();
  await restarted.page.getByText('合同已导入，请确认审核背景后开始。').waitFor();
  const pdf = (await restarted.page.evaluate(() => window.contractAssistant.getState())).documents.find(item => item.format === 'pdf');
  assert.ok(pdf && pdf.blockCount === 3);
  const pdfDetail = await restarted.page.evaluate(id => window.contractAssistant.getDocument(id), pdf.id);
  assert.match(pdfDetail.blocks.map(block => block.text).join('\n'), /合同付款需核实。/);
  assert.match(pdfDetail.blocks.map(block => block.text).join('\n'), /ข้อความภาษาไทย/);
  assert.equal(modelRequests, 2);
  assert.equal(reviewRequests, 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, importedBlocks: imported.documents[0].blockCount, pdfBlocks: pdf.blockCount, modelRequests, reviews: 2, persistenceAfterRestart: true, screenshot: 'output/playwright/desktop-review.png' }, null, 2));
} finally {
  await app?.close();
  await new Promise(resolve => server.close(resolve));
}
