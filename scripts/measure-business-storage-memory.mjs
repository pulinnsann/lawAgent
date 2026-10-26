#!/usr/bin/env node
// Full desktop comparison, using the same closed synthetic schema-7 workspace
// and the same production build. No customer workspace or external API is read.
// Run after build: node --import tsx scripts/measure-business-storage-memory.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { _electron as electron } from 'playwright';
import { defaultRetrievalConfig } from '../src/shared/contracts.ts';
import { openNativeDatabase } from '../src/core/storage-backend.ts';

const root = resolve(import.meta.dirname, '..');
const options = { historyMiB: 64, documents: 161, windowSeconds: 3, intervalMs: 100, output: join(root, 'output/playwright/native-business-storage/comparison.json'), backends: ['sqljs', 'rust'] };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]; const value = process.argv[i + 1];
  if (key === '--output' && value) options.output = resolve(value);
  else if (key === '--history-mib' && value) options.historyMiB = Number(value);
  else if (key === '--documents' && value) options.documents = Number(value);
  else if (key === '--window-seconds' && value) options.windowSeconds = Number(value);
  else if (key === '--interval-ms' && value) options.intervalMs = Number(value);
  else if (key === '--backends' && /^(?:rust,sqljs|sqljs,rust|rust|sqljs)$/u.test(value ?? '')) options.backends = value.split(',');
  else throw new Error(`Unknown or missing argument: ${key}`);
}
for (const [key, min, max] of [['historyMiB', 0, 256], ['documents', 2, 1000], ['windowSeconds', 1, 60], ['intervalMs', 50, 5000]]) assert.ok(Number.isSafeInteger(options[key]) && options[key] >= min && options[key] <= max, `Invalid ${key}`);
const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => createHash('sha256').update(value).digest('hex');
async function buildManifest() {
  async function walk(directory) {
    const files = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) files.push(...await walk(path)); else if (item.isFile()) files.push(path);
    }
    return files.sort();
  }
  const files = [];
  for (const path of await walk(join(root, 'out'))) { const bytes = await readFile(path); files.push({ path: relative(root, path), bytes: bytes.length, sha256: sha(bytes) }); }
  const path = join(root, '.local/native', `law-agent-store-${platform()}-${arch()}.node`); const bytes = await readFile(path);
  return { recordedAt: new Date().toISOString(), outTreeSha256: sha(Buffer.from(files.map(file => `${file.path}\0${file.sha256}\n`).join(''))), files, native: { path: relative(root, path), bytes: bytes.length, sha256: sha(bytes) } };
}
const measuredBuild = await buildManifest();
const parent = await realpath(await mkdtemp(join(tmpdir(), 'law-agent-business-memory-')));
const fixtureDir = join(parent, 'closed-legacy-fixture');
const { stdout } = await execute(process.execPath, ['--import', 'tsx', 'scripts/seed-business-storage-fixture.mjs', '--data-dir', fixtureDir, '--history-mib', String(options.historyMiB), '--documents', String(options.documents)], { cwd: root, env: { ...process.env, LAW_AGENT_STORAGE_BACKEND: 'sqljs' }, maxBuffer: 2 * 1024 * 1024 });
const fixture = JSON.parse(stdout);
const fixtureDatabase = await readFile(join(fixtureDir, 'workspace.sqlite'));
const fixtureSha256 = sha(fixtureDatabase); const fixtureDatabaseBytes = fixtureDatabase.length;
const inputPath = join(parent, 'Synthetic new review contract.docx');
const originalBytes = await readFile(join(fixtureDir, fixture.originalRelativePath));
// Reimporting identical bytes intentionally returns the existing document.
// Add one controlled paragraph so this phase exercises a new import while
// retaining the original formatting and prior revision for export assertions.
const inputZip = await JSZip.loadAsync(originalBytes);
const inputXml = await inputZip.file('word/document.xml').async('string');
assert.ok(inputXml.includes('<w:sectPr>'));
inputZip.file('word/document.xml', inputXml.replace('<w:sectPr>', '<w:p><w:r><w:t>New synthetic review fixture for native storage comparison.</w:t></w:r></w:p><w:sectPr>'));
const inputBytes = await inputZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
assert.notEqual(sha(inputBytes), sha(originalBytes));
await writeFile(inputPath, inputBytes);
const knowledgeFolder = join(parent, 'synthetic-policy'); await mkdir(knowledgeFolder);
await writeFile(join(knowledgeFolder, 'acceptance-policy.txt'), '合成验收制度：服务采购合同付款前应核对书面验收记录。\nSynthetic policy: confirm written acceptance before payment.\nข้อกำหนดตัวอย่าง: ตรวจรับก่อนชำระเงิน\n');
const context = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: 'Synthetic engineering comparison; no legal opinion.' };
const mockRequests = []; const modelErrors = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); const payload = JSON.parse(body.messages.findLast(item => item.role === 'user').content);
    const block = payload.contractBlocks.find(item => item.text.includes('验收'));
    const evidence = payload.sources.find(source => source.channel === 'knowledge' && source.excerpt.includes('验收'));
    assert.ok(block && evidence, 'Mock review requires contract text and locally indexed citation');
    const quote = evidence.excerpt.split(/\r?\n/u).find(line => line.trim()).slice(0, 80);
    mockRequests.push({ contractBlockCount: payload.contractBlocks.length, sourceCount: payload.sources.length, model: body.model });
    await sleep(750); // Ensures an actual in-flight model API window is sampled.
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ model: 'synthetic-memory-review', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'Synthetic cited contract review.', reviewedBlockIds: payload.contractBlocks.map(item => item.id), findings: [{ blockIds: [block.id], quote: block.text, title: 'Synthetic written acceptance check', category: 'commercial', severity: 'medium', description: 'Engineering source persistence check.', suggestion: 'Confirm written acceptance.', legalBasis: null, citations: [{ evidenceId: evidence.id, quote }] }] }) } }] }));
  } catch (error) { modelErrors.push(error.message); response.writeHead(500); response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const runs = [];
const percentile = (values, fraction) => values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];

async function compareBackend(backend) {
  const dataDir = join(parent, backend); await cp(fixtureDir, dataDir, { recursive: true });
  assert.equal(sha(await readFile(join(dataDir, 'workspace.sqlite'))), fixtureSha256);
  const stages = []; const pageErrors = []; const rendererRequests = []; const artifactNotes = []; let app; let page; let mainPid;
  async function tree() {
    if (!['darwin', 'linux'].includes(platform())) return null;
    const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { maxBuffer: 8 * 1024 * 1024 });
    const all = stdout.split('\n').flatMap(line => { const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u); return m ? [{ pid: Number(m[1]), parentPid: Number(m[2]), rssKiB: Number(m[3]), executable: m[4] }] : []; });
    const pids = new Set([mainPid]); let changed;
    do { changed = false; for (const item of all) if (pids.has(item.parentPid) && !pids.has(item.pid)) { pids.add(item.pid); changed = true; } } while (changed);
    const processes = all.filter(item => pids.has(item.pid));
    return { rssSumKiB: processes.reduce((sum, item) => sum + item.rssKiB, 0), processes };
  }
  async function sample() {
    const [metrics, processTree] = await Promise.all([app.evaluate(({ app }) => ({ processes: app.getAppMetrics(), mainNodeMemoryUsageBytes: process.memoryUsage() })), tree()]);
    return { monotonicMs: performance.now(), processTree, electronWorkingSetSumKiB: metrics.processes.reduce((sum, item) => sum + item.memory.workingSetSize, 0), metrics };
  }
  async function stage(name, action = async () => null) {
    const started = performance.now(); const samples = []; let stop = false; let samplerError;
    const sampling = (async () => { try { while (!stop) { samples.push(await sample()); await sleep(options.intervalMs); } } catch (error) { samplerError = error; } })();
    let result; let operationMs;
    try { result = await action(); operationMs = performance.now() - started; await sleep(Math.max(0, options.windowSeconds * 1000 - (performance.now() - started))); }
    finally { stop = true; await sampling; }
    if (samplerError) throw samplerError;
    samples.push(await sample());
    const rss = samples.map(item => item.processTree?.rssSumKiB).filter(value => value !== undefined);
    const summary = { samples: samples.length, processTreeRssMedianKiB: rss.length ? percentile(rss, 0.5) : null, processTreeRssPeakKiB: rss.length ? Math.max(...rss) : null,
      electronWorkingSetMedianKiB: percentile(samples.map(item => item.electronWorkingSetSumKiB), 0.5), electronWorkingSetPeakKiB: Math.max(...samples.map(item => item.electronWorkingSetSumKiB)), maxProcessCount: Math.max(...samples.map(item => item.processTree?.processes.length ?? item.metrics.processes.length)) };
    stages.push({ name, operationMs, observedWindowMs: performance.now() - started, result, summary, samples });
    console.log(JSON.stringify({ backend, stage: name, operationMs, ...summary })); return result;
  }
  async function launch() {
    const started = performance.now();
    app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir, LAW_AGENT_STORAGE_BACKEND: backend }, timeout: 60000 });
    mainPid = app.process().pid;
    await app.evaluate(({ app, BrowserWindow }) => { const isolate = window => { window.webContents.setBackgroundThrottling(false); window.setFocusable(false); window.hide(); }; app.on('browser-window-created', (_event, window) => isolate(window)); BrowserWindow.getAllWindows().forEach(isolate); });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => pageErrors.push(error.message)); page.on('request', request => { if (/^https?:/u.test(request.url())) rendererRequests.push(request.url()); });
    await page.waitForFunction(() => Boolean(window.contractAssistant));
    const state = await page.evaluate(() => window.contractAssistant.getState());
    assert.equal(state.storageBackend, backend, 'The running Core worker must confirm its actual storage backend');
    return performance.now() - started;
  }
  async function waitReview(taskId) {
    const end = Date.now() + 60000;
    while (Date.now() < end) { const state = await page.evaluate(() => window.contractAssistant.getState()); const task = state.tasks.find(item => item.id === taskId); if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) { assert.equal(task.status, 'completed', task.error ?? ''); return task; } await sleep(50); }
    throw new Error('Synthetic review timed out');
  }
  async function waitKnowledge(jobId) {
    const end = Date.now() + 60000;
    while (Date.now() < end) { const state = await page.evaluate(() => window.contractAssistant.getKnowledgeState()); if (state.job?.id === jobId && state.job.status !== 'running') { assert.equal(state.job.status, 'completed', JSON.stringify(state.job)); assert.equal(state.job.failed, 0); return state; } await sleep(50); }
    throw new Error('Synthetic knowledge job timed out');
  }
  try {
    const readyMs = await launch();
    await stage('idle-existing-history');
    await stage('paged-contracts-and-original', async () => {
      const ids = []; let cursor;
      do { const result = await page.evaluate(input => window.contractAssistant.listDocumentsPage(input), { limit: 37, ...(cursor ? { cursor } : {}) }); ids.push(...result.items.map(item => item.id)); assert.equal(result.totalCount, options.documents); cursor = result.nextCursor; } while (cursor);
      assert.equal(ids.length, options.documents); assert.equal(new Set(ids).size, options.documents);
      const blocks = []; cursor = null;
      do { const result = await page.evaluate(input => window.contractAssistant.getDocumentBlocks(input), { documentId: fixture.documentId, limit: 2, ...(cursor ? { cursor } : {}) }); blocks.push(...result.items); cursor = result.nextCursor; } while (cursor);
      assert.deepEqual(blocks.map(({ textWindow: _window, ...block }) => block), fixture.document.blocks);
      const reviews = await page.evaluate(documentId => window.contractAssistant.getDocumentReviews({ documentId, limit: 1 }), fixture.documentId);
      assert.equal(reviews.items[0].id, fixture.reviewId);
      const original = await page.evaluate(id => window.contractAssistant.getReview(id), fixture.reviewId); assert.deepEqual(original, fixture.review);
      return { traversedDocuments: ids.length, traversedBlocks: blocks.length, historicalReviewPreserved: true };
    });
    const document = await stage('import-new-docx', async () => {
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, inputPath);
      await page.locator('.import-button').click();
      await page.locator('.document-meta strong[title="Synthetic new review contract.docx"]').waitFor();
      const state = await page.evaluate(() => window.contractAssistant.getState());
      const doc = state.documents.find(item => item.name === 'Synthetic new review contract.docx'); assert.ok(doc);
      return { id: doc.id, blockCount: doc.blockCount, selectedAndRendered: true };
    });
    await stage('local-review', async () => { const { taskId } = await page.evaluate(input => window.contractAssistant.startReview(input), { documentId: document.id, mode: 'local', context }); const task = await waitReview(taskId); return { reviewId: task.resultId, status: task.status }; });
    await stage('configure-model-and-local-index', async () => {
      await page.evaluate(baseUrl => window.contractAssistant.saveModelConfig({ name: 'Synthetic memory API', baseUrl, model: 'synthetic-memory-review', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 4096, contextWindowTokens: 65536, timeoutSeconds: 30 }), baseUrl);
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, knowledgeFolder);
      assert.equal(await page.evaluate(() => window.contractAssistant.selectKnowledgeFolder()), knowledgeFolder);
      const config = defaultRetrievalConfig(); config.knowledge.enabled = true; config.knowledge.folderPath = knowledgeFolder; config.knowledge.api.enabled = false; config.knowledge.preferences.autoSyncEnabled = false; config.web.enabled = false; config.official.enabled = false;
      await page.evaluate(config => window.contractAssistant.saveRetrievalConfig(config), config);
      const { jobId } = await page.evaluate(() => window.contractAssistant.startKnowledgeSync('incremental')); const state = await waitKnowledge(jobId);
      assert.equal(state.indexedFiles, 1); return { indexedFiles: state.indexedFiles };
    });
    let review;
    await stage('mock-model-review-with-local-citation', async () => {
      const { taskId } = await page.evaluate(input => window.contractAssistant.startReview(input), { documentId: document.id, mode: 'model', context });
      const task = await waitReview(taskId); review = await page.evaluate(id => window.contractAssistant.getReview(id), task.resultId);
      assert.equal(review.findings[0].citations[0].matchStatus, 'matched'); assert.equal(review.findings[0].basisStatus, 'source_matched');
      assert.ok(review.retrieval.evidence.some(item => item.localIndex?.fileSha256 && item.sourceUri.startsWith('file:')));
      await page.locator('.review-summary').filter({ hasText: 'Synthetic cited contract review.' }).waitFor();
      return { reviewId: review.id, citations: review.findings[0].citations.length, matchStatus: review.findings[0].citations[0].matchStatus };
    });
    const proposalIds = [];
    await stage('propose-and-adopt-one-item', async () => {
      await page.getByRole('button', { name: '拟定修改', exact: true }).first().click();
      const panel = page.locator(`#changes-${review.id}`);
      await panel.getByRole('button', { name: '刷新修改记录', exact: true }).waitFor();
      const detail = await page.evaluate(id => window.contractAssistant.getDocument(id), document.id); let workspace = await page.evaluate(id => window.contractAssistant.getChanges(id), review.id);
      for (const [index, replacementText, status] of [[0, '服务付款应在双方书面确认后办理。', 'accepted'], [1, 'This rejected text must not appear.', 'rejected']]) {
        const block = detail.blocks[index]; workspace = await page.evaluate(input => window.contractAssistant.saveChange(input), { reviewId: review.id, findingId: null, blockId: block.id, expectedRevision: workspace.revision, replacementText });
        const proposal = workspace.proposals.find(item => item.blockId === block.id); proposalIds.push(proposal.id);
        workspace = await page.evaluate(input => window.contractAssistant.decideChange(input), { reviewId: review.id, proposalId: proposal.id, expectedRevision: workspace.revision, status });
      }
      await panel.getByRole('button', { name: '刷新修改记录', exact: true }).click();
      await page.waitForFunction(id => document.querySelectorAll(`#changes-${id} .change-proposal`).length === 2, review.id);
      return { accepted: workspace.proposals.filter(item => item.status === 'accepted').length, rejected: workspace.proposals.filter(item => item.status === 'rejected').length };
    });
    let exported;
    await stage('tracked-docx-and-cited-report-export', async () => {
      const exportPath = join(parent, `${backend}-tracked.docx`); const workspace = await page.evaluate(id => window.contractAssistant.getChanges(id), review.id);
      await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
      exported = await page.evaluate(input => window.contractAssistant.exportModified(input), { reviewId: review.id, expectedRevision: workspace.revision, format: 'tracked', revisionAuthor: 'Native memory QA' });
      const zip = await JSZip.loadAsync(await readFile(exported.documentPath)); const xml = await zip.file('word/document.xml').async('string');
      assert.match(xml, /<[\w-]+:del\b/); assert.match(xml, /<[\w-]+:ins\b/); assert.match(xml, /双方书面确认/); assert.match(xml, /Original Author/); assert.match(xml, /<w:b\s*\/>/); assert.ok(!xml.includes('This rejected text must not appear.'));
      assert.equal(sha(await readFile(inputPath)), sha(inputBytes));
      const reportPath = join(parent, `${backend}-cited-report.md`); await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, reportPath);
      await page.evaluate(id => window.contractAssistant.exportReview(id), review.id); const markdown = await readFile(reportPath, 'utf8');
      const cited = review.retrieval.evidence.find(item => item.localIndex);
      assert.ok(markdown.includes(cited.id), 'Exported report must identify the saved source');
      assert.ok(markdown.includes(review.findings[0].citations[0].quote), 'Exported report must retain the matched original quote');
      assert.ok(markdown.includes(cited.localIndex.fileSha256), 'Exported report must retain the original file hash');
      await page.locator(`#changes-${review.id}`).getByRole('button', { name: '刷新修改记录', exact: true }).click();
      return { format: exported.export.format, docxBytes: (await stat(exported.documentPath)).size, citedReportExported: true, originalPreserved: true, oldRevisionAndBoldPreserved: true };
    });
    await stage('idle-after-full-review');
    await mkdir(dirname(options.output), { recursive: true });
    const capture = async (name, prepare = async () => {}) => {
      try { await prepare(); await page.screenshot({ path: join(dirname(options.output), `${backend}-${name}.png`), fullPage: true, timeout: 5000 }); }
      catch (error) {
        artifactNotes.push({ name, note: error.message });
        await page.screenshot({ path: join(dirname(options.output), `${backend}-${name}-fallback.png`), fullPage: true, timeout: 5000 }).catch(fallback => artifactNotes.push({ name: `${name}-fallback`, note: fallback.message }));
      }
    };
    await capture('completed-review');
    await capture('proposal-decisions', () => page.locator(`#changes-${review.id} .change-proposal`).first().scrollIntoViewIfNeeded({ timeout: 2000 }));
    await capture('export-history', async () => { const history = page.locator(`#changes-${review.id} details.changes-history`); await history.locator('summary').click({ timeout: 2000 }); await history.scrollIntoViewIfNeeded({ timeout: 2000 }); });
    await capture('cited-review', () => page.locator('.review-summary').scrollIntoViewIfNeeded({ timeout: 2000 }));
    await app.close(); app = undefined;
    const restartReadyMs = await launch();
    await stage('restart-data-preservation', async () => {
      const restored = await page.evaluate(id => window.contractAssistant.getReview(id), review.id); assert.deepEqual(restored, review);
      const changes = await page.evaluate(id => window.contractAssistant.getChanges(id), review.id);
      assert.equal(changes.proposals.find(item => item.id === proposalIds[0]).status, 'accepted'); assert.equal(changes.proposals.find(item => item.id === proposalIds[1]).status, 'rejected');
      assert.equal(changes.exports[0].documentId, exported.export.documentId); assert.equal(changes.exports[0].format, 'tracked');
      assert.deepEqual(await page.evaluate(id => window.contractAssistant.getReview(id), fixture.reviewId), fixture.review);
      assert.equal(sha(await readFile(join(dataDir, fixture.originalRelativePath))), fixture.originalSha256);
      if (backend === 'rust') assert.equal(sha(await readFile(join(dataDir, 'workspace.sqlite.pre-rust-backup'))), fixtureSha256);
      return { originalAndNewReviewsPreserved: true, approvalsAndExportPreserved: true, originalFilePreserved: true };
    });
    assert.deepEqual(pageErrors, []); assert.deepEqual(rendererRequests, []);
    await app.close(); app = undefined;
    // Aggregate historical payloads only after the measured application exits.
    // This read-only disk check never enters either application's sampled RSS.
    const disk = openNativeDatabase(join(dataDir, 'workspace.sqlite'), true);
    let postRunDataCheck;
    try {
      const row = disk.all("SELECT COUNT(*) AS rows,COALESCE(SUM(length(detail_json)),0) AS payloadBytes FROM audit_events WHERE entity_type='synthetic-memory-fixture'")[0];
      assert.equal(Number(row.rows), fixture.historyRows); assert.equal(Number(row.payloadBytes), fixture.historyPayloadBytes);
      postRunDataCheck = { historicalAuditRows: Number(row.rows), historicalPayloadBytes: Number(row.payloadBytes), retained: true, performedOutsideSampledApplication: true };
    } finally { disk.close(); }
    return { backend, readyMs, restartReadyMs, dataDir, passed: true, fixtureSha256, databaseBytesAfter: (await stat(join(dataDir, 'workspace.sqlite'))).size, pageErrors, rendererRequests, artifactNotes, postRunDataCheck, stages };
  } catch (error) {
    const diagnostic = await page?.evaluate(() => ({ body: document.body.innerText.slice(-8000), titles: [...document.querySelectorAll('.document-meta strong')].map(item => item.getAttribute('title')) })).catch(() => null);
    console.error(JSON.stringify({ backend, failed: true, dataDir, pageErrors, diagnostic }));
    if (page) { await mkdir(dirname(options.output), { recursive: true }); await page.screenshot({ path: join(dirname(options.output), `${backend}-failed.png`), fullPage: true }).catch(() => {}); }
    throw error;
  } finally { await app?.close(); }
}

try {
  for (const backend of options.backends) runs.push(await compareBackend(backend));
  assert.deepEqual(modelErrors, []); assert.equal(mockRequests.length, options.backends.length);
  const finalBuild = await buildManifest();
  assert.equal(finalBuild.outTreeSha256, measuredBuild.outTreeSha256, 'Application output changed during the comparison');
  assert.equal(finalBuild.native.sha256, measuredBuild.native.sha256, 'Native binding changed during the comparison');
  const legacy = runs.find(run => run.backend === 'sqljs'); const native = runs.find(run => run.backend === 'rust');
  const comparisons = native && legacy ? native.stages.map(stage => {
    const reference = legacy.stages.find(item => item.name === stage.name);
    const rssAvailable = stage.summary.processTreeRssPeakKiB !== null && reference.summary.processTreeRssPeakKiB !== null;
    const nativeKiB = rssAvailable ? stage.summary.processTreeRssPeakKiB : stage.summary.electronWorkingSetPeakKiB;
    const legacyKiB = rssAvailable ? reference.summary.processTreeRssPeakKiB : reference.summary.electronWorkingSetPeakKiB;
    return { stage: stage.name, metric: rssAvailable ? 'process-tree-rss-sum' : 'electron-working-set-sum', nativePeakMiB: nativeKiB / 1024, legacyPeakMiB: legacyKiB / 1024, savedMiB: (legacyKiB - nativeKiB) / 1024, reductionPercent: (legacyKiB - nativeKiB) / legacyKiB * 100 };
  }) : [];
  const report = { format: 'law-agent-native-business-desktop-memory-v1', passed: true, measuredAt: new Date().toISOString(),
    host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, totalMemoryBytes: totalmem() },
    executable: 'Development Electron with the same current production out/ for both backends',
    fixture: { schemaVersion: fixture.schemaVersion, databaseBytes: fixtureDatabaseBytes, databaseSha256: fixtureSha256, historyRows: fixture.historyRows, historyPayloadBytes: fixture.historyPayloadBytes, documentCount: fixture.documentCount, trilingualDocxWithExistingRevisionAndBold: true },
    protocol: { windowSeconds: options.windowSeconds, intervalMs: options.intervalMs, hiddenWindow: true, backgroundThrottling: false, forceGc: false, backendOrder: options.backends, startupExcludedFromSampling: true },
    measuredBuild: { ...measuredBuild, verifiedUnchangedAtEnd: true }, noRealModelCalls: true, mockRequests, customerDataRead: false, runs, comparisons,
    limits: ['Summed process-tree RSS double-counts shared pages and is not exclusive physical footprint.', 'Only the storage backend differs; Electron, Node, React and the knowledge worker remain in both runs.', 'Sampling starts after readiness, so startup peaks are excluded; short peaks can occur between samples.', 'Synthetic audit history shows database-size sensitivity; it does not establish 1 TB indexing performance or performance on ordinary Windows hardware.', 'The loopback API does not simulate local-model RAM, GPU memory or inference compute.', 'Results are single sequential runs on this host, not statistical or cross-platform acceptance.', 'All fixture files and exports are synthetic and retained under a new temporary directory for inspection.'] };
  await mkdir(dirname(options.output), { recursive: true }); await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, output: options.output, comparisons }, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
