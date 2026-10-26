#!/usr/bin/env node
// Run with: node --import tsx scripts/measure-runtime-memory.mjs
// Uses a new synthetic-only temporary workspace and closes only its own app.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { _electron as electron } from 'playwright';
import { defaultRetrievalConfig } from '../src/shared/contracts.ts';

const root = resolve(import.meta.dirname, '..');
const options = { output: join(root, 'output/playwright/memory-baseline/result.json'), windowSeconds: 20, intervalMs: 500, indexFiles: 100, fileBytes: 16384 };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]; const value = process.argv[i + 1];
  if (key === '--executable' && value) options.executable = resolve(value);
  else if (key === '--output' && value) options.output = resolve(value);
  else if (key === '--window-seconds' && value) options.windowSeconds = Number(value);
  else if (key === '--interval-ms' && value) options.intervalMs = Number(value);
  else if (key === '--index-files' && value) options.indexFiles = Number(value);
  else if (key === '--file-bytes' && value) options.fileBytes = Number(value);
  else throw new Error(`Unknown or missing argument: ${key}`);
}
for (const [key, min, max] of [['windowSeconds', 1, 300], ['intervalMs', 100, 10000], ['indexFiles', 1, 100000], ['fileBytes', 512, 1048576]]) {
  assert.ok(Number.isSafeInteger(options[key]) && options[key] >= min && options[key] <= max, `Invalid ${key}`);
}
const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'law-agent-memory-baseline-')));
const folder = join(dataDir, 'synthetic-knowledge');
await mkdir(folder);
const paragraph = 'Synthetic acceptance policy: confirm payment after signed acceptance. 合成制度：付款前确认验收记录。 ข้อกำหนดตัวอย่างเพื่อทดสอบระบบเท่านั้น\n';
let text = '';
while (Buffer.byteLength(text) < options.fileBytes) text += paragraph;
let fixtureBytes = 0;
for (let i = 0; i < options.indexFiles; i += 1) {
  const content = `Synthetic document ${i}. marker${String(i).padStart(6, '0')}\n${text}`;
  fixtureBytes += Buffer.byteLength(content);
  await writeFile(join(folder, `synthetic-${String(i).padStart(6, '0')}.txt`), content);
}
const execute = promisify(execFile);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const stages = [];
const pageErrors = [];
const remoteRequests = [];
let app;
let page;
let mainPid;

async function processTree() {
  if (!['darwin', 'linux'].includes(platform())) return null;
  const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { maxBuffer: 8 * 1024 * 1024 });
  const all = stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), rssKiB: Number(match[3]), executable: match[4] }] : [];
  });
  const pids = new Set([mainPid]);
  let added;
  do { added = false; for (const item of all) if (pids.has(item.parentPid) && !pids.has(item.pid)) { pids.add(item.pid); added = true; } } while (added);
  const processes = all.filter(item => pids.has(item.pid));
  return { rssSumKiB: processes.reduce((total, item) => total + item.rssKiB, 0), processes };
}
async function sample() {
  const [electronMetrics, tree] = await Promise.all([
    app.evaluate(({ app }) => ({ processes: app.getAppMetrics(), mainNodeMemoryUsageBytes: process.memoryUsage() })),
    processTree(),
  ]);
  return {
    at: new Date().toISOString(),
    monotonicMs: performance.now(),
    electronWorkingSetSumKiB: electronMetrics.processes.reduce((total, metric) => total + metric.memory.workingSetSize, 0),
    electronPrivateSumKiB: electronMetrics.processes.every(metric => Number.isFinite(metric.memory.privateBytes)) ? electronMetrics.processes.reduce((total, metric) => total + metric.memory.privateBytes, 0) : null,
    electronMetrics,
    processTree: tree,
  };
}
const percentile = (numbers, fraction) => { const sorted = numbers.toSorted((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; };
async function stage(name, action = async () => null) {
  const samples = [];
  const started = performance.now();
  let stop = false;
  let samplerError;
  const sampler = (async () => {
    try { while (!stop) { samples.push(await sample()); await sleep(options.intervalMs); } }
    catch (error) { samplerError = error; }
  })();
  let value;
  let operationMs;
  try {
    value = await action(); operationMs = performance.now() - started;
    await sleep(Math.max(0, options.windowSeconds * 1000 - (performance.now() - started)));
  } finally { stop = true; await sampler; }
  if (samplerError) throw samplerError;
  samples.push(await sample());
  const workingSets = samples.map(value => value.electronWorkingSetSumKiB);
  const treeRss = samples.map(value => value.processTree?.rssSumKiB).filter(value => value !== undefined);
  stages.push({ name, operationMs, observedWindowMs: performance.now() - started, result: value, summary: {
    samples: samples.length,
    electronWorkingSetMedianKiB: percentile(workingSets, 0.5), electronWorkingSetPeakKiB: Math.max(...workingSets),
    processTreeRssMedianKiB: treeRss.length ? percentile(treeRss, 0.5) : null, processTreeRssPeakKiB: treeRss.length ? Math.max(...treeRss) : null,
    maxProcessCount: Math.max(...samples.map(value => value.processTree?.processes.length ?? value.electronMetrics.processes.length)),
  }, samples });
  console.log(JSON.stringify({ stage: name, operationMs, ...stages.at(-1).summary }));
  return value;
}
async function waitTask(taskId) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const state = await page.evaluate(() => window.contractAssistant.getState());
    const task = state.tasks.find(task => task.id === taskId);
    if (task?.status === 'failed') throw new Error(task.error);
    if (task?.status === 'completed') return { status: task.status, reviewId: task.resultId };
    await sleep(50);
  }
  throw new Error('Synthetic local review timed out');
}
async function waitKnowledge(jobId) {
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const state = await page.evaluate(() => window.contractAssistant.getKnowledgeState());
    if ((!jobId || state.job?.id === jobId) && state.job?.status !== 'running') {
      if (state.job?.status === 'failed' || state.job?.failed) throw new Error(JSON.stringify(state.job));
      return { indexedFiles: state.indexedFiles, chunks: state.chunks, job: state.job };
    }
    await sleep(100);
  }
  throw new Error('Synthetic knowledge indexing timed out');
}

const launchStarted = performance.now();
try {
  app = await electron.launch({
    ...(options.executable ? { executablePath: options.executable, args: [] } : { args: [root], cwd: root }),
    env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir }, timeout: 60000,
  });
  mainPid = app.process().pid;
  await app.evaluate(({ app, BrowserWindow }) => {
    const isolate = window => { window.webContents.setBackgroundThrottling(false); window.setFocusable(false); window.hide(); };
    app.on('browser-window-created', (_event, window) => isolate(window)); BrowserWindow.getAllWindows().forEach(isolate);
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) remoteRequests.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.contractAssistant));
  const initial = await page.evaluate(() => window.contractAssistant.getState());
  const readyMs = performance.now() - launchStarted;
  assert.equal(initial.documents.length, 0); assert.equal(initial.tasks.length, 0);
  await stage('idle-empty');
  const document = await stage('import-built-in-docx', () => page.evaluate(() => window.contractAssistant.loadSample()));
  await stage('local-review', async () => {
    const task = await page.evaluate(documentId => window.contractAssistant.startReview({ documentId, mode: 'local', context: { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: 'Synthetic engineering memory baseline' } }), document.id);
    return waitTask(task.taskId);
  });
  await stage('function-menu-open', async () => { await page.getByRole('button', { name: '功能中心', exact: true }).click(); return { opened: true }; });
  await stage('function-menu-closed', async () => { await page.getByRole('button', { name: '关闭功能中心', exact: true }).click(); return { closed: true }; });
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, folder);
  const chosen = await page.evaluate(() => window.contractAssistant.selectKnowledgeFolder());
  assert.equal(chosen, folder);
  const config = defaultRetrievalConfig();
  config.knowledge.enabled = true; config.knowledge.folderPath = folder; config.knowledge.api.enabled = false;
  config.knowledge.preferences.autoSyncEnabled = false;
  config.web.enabled = false; config.official.enabled = false;
  await page.evaluate(config => window.contractAssistant.saveRetrievalConfig(config), config);
  await waitKnowledge();
  await stage('knowledge-initial-build', async () => {
    const { jobId } = await page.evaluate(() => window.contractAssistant.startKnowledgeSync('incremental'));
    const result = await waitKnowledge(jobId); assert.equal(result.indexedFiles, options.indexFiles); return result;
  });
  await writeFile(join(folder, 'synthetic-000000.txt'), `Incremental changed marker000000\n${text}`);
  await stage('knowledge-incremental-one-file', async () => {
    const { jobId } = await page.evaluate(() => window.contractAssistant.startKnowledgeSync('incremental'));
    return waitKnowledge(jobId);
  });
  await stage('idle-after-index');
  assert.deepEqual(pageErrors, []); assert.deepEqual(remoteRequests, []);
  const report = {
    format: 'law-agent-runtime-memory-v1', passed: true, measuredAt: new Date().toISOString(),
    version: initial.appVersion, readyMs, executable: options.executable ?? 'development Electron with current production out/',
    host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, totalMemoryBytes: totalmem() },
    fixture: { document: 'built-in synthetic multilingual DOCX', knowledgeFiles: options.indexFiles, knowledgeBytes: fixtureBytes, requestedMinimumFileBytes: options.fileBytes, changedFiles: 1 },
    protocol: { windowSeconds: options.windowSeconds, intervalMs: options.intervalMs, hiddenWindow: true, backgroundThrottling: false, forceGc: false, mainPid, dataDir },
    noRealModelCalls: true, customerDataRead: false, pageErrors, remoteRequests, stages,
    limits: [
      'Electron app.getAppMetrics memory fields and ps RSS are KiB; process.memoryUsage fields are bytes.',
      'Summed working set/RSS double-count shared pages; these sums are not unique physical footprint and not directly comparable to Windows private bytes or macOS footprint.',
      'Worker threads share their owning process RSS and must not be counted again as separate processes.',
      'Playwright driver memory is outside the app process tree; instrumentation, IPC sampling, hidden window and host contention can affect results.',
      'Ready time includes Playwright attach/bridge discovery, not an instrumented cold-start or first-paint metric.',
      'Short operations can peak between samples; sampled maxima are lower bounds, not guaranteed peak resident memory.',
      'Small synthetic text corpus does not certify 1 TB performance, PDF/OCR peaks or target Windows hardware.',
    ],
  };
  await mkdir(dirname(options.output), { recursive: true }); await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, output: options.output, version: initial.appVersion, readyMs }));
} finally { await app?.close(); }
