#!/usr/bin/env node
// Repeated native-window startup/shutdown in one isolated synthetic workspace.
// Run the controller with the bundled Node 24 runtime, not a global Node build.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { defaultRetrievalConfig } from '../src/shared/contracts.ts';

const root = resolve(import.meta.dirname, '..');
const options = { binary: join(root, '.local/rust-target/release/law-agent-desktop'), cycles: 3, output: join(root, 'output/playwright/tauri-desktop/lifecycle/result.json') };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]; const value = process.argv[i + 1];
  if (key === '--binary' && value) options.binary = resolve(value);
  else if (key === '--cycles' && value) options.cycles = Number(value);
  else if (key === '--output' && value) options.output = resolve(value);
  else throw new Error(`Unknown or missing argument: ${key}`);
}
assert.ok(Number.isSafeInteger(options.cycles) && options.cycles >= 1 && options.cycles <= 20);
assert.equal(platform(), 'darwin', 'This lifecycle process sampler currently targets macOS.');
assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Use the bundled Node 24 controller: .local/tauri-runtime/bin/node --import tsx scripts/smoke-tauri-lifecycle.mjs');
const exec = promisify(execFile); const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function buildIdentity() {
  const result = {};
  for (const [name, path] of [['native', options.binary], ['controller', process.execPath], ['backend', join(root, '.local/tauri-runtime/backend/backend.js')], ['coreWorker', join(root, '.local/tauri-runtime/backend/core-worker.js')], ['runtimeManifest', join(root, '.local/tauri-runtime/runtime-manifest.json')]]) result[name] = { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
  return result;
}
const measuredBuild = await buildIdentity();
const crashDirectory = join(homedir(), 'Library/Logs/DiagnosticReports');
const oldCrashReports = new Set(await readdir(crashDirectory).catch(() => []));
const parent = await realpath(await mkdtemp(join(tmpdir(), 'law-agent-tauri-lifecycle-')));
const dataDir = join(parent, 'workspace'); const folder = join(parent, 'synthetic-policy');
await mkdir(dataDir); await mkdir(folder); await mkdir(dirname(options.output), { recursive: true });
for (let index = 0; index < 180; index++) await writeFile(join(folder, `synthetic-${String(index).padStart(3, '0')}.txt`), ('合成验收制度：服务采购合同付款前应核对书面验收记录。\nSynthetic policy: confirm written acceptance before payment.\nข้อกำหนดตัวอย่าง: ตรวจรับก่อนชำระเงิน\n').repeat(50));
const retrieval = defaultRetrievalConfig(); retrieval.knowledge.enabled = true; retrieval.knowledge.folderPath = folder; retrieval.knowledge.api.enabled = false; retrieval.knowledge.preferences.autoSyncEnabled = false; retrieval.web.enabled = false; retrieval.official.enabled = false;
const requests = []; const heldResponses = new Set(); const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  requests.push({ receivedAt: Date.now(), body: JSON.parse(raw) });
  heldResponses.add(response); response.on('close', () => heldResponses.delete(response));
  response.writeHead(200, { 'Content-Type': 'application/json' });
  // Deliberately leave the response body open. Closing the application must
  // cancel this actual in-flight API request and join the Core worker.
  response.flushHeaders();
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
async function processes() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,comm='], { maxBuffer: 8 * 1024 ** 2 });
  return stdout.split('\n').flatMap(line => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u); return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), executable: match[3] }] : []; });
}
function descendants(all, owner) {
  const ids = new Set([owner]); let changed;
  do { changed = false; for (const item of all) if (ids.has(item.parentPid) && !ids.has(item.pid)) { ids.add(item.pid); changed = true; } } while (changed);
  return ids;
}
async function lifecycleFlow(config) {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(read, good, label) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const value = await read(); if (good(value)) return value; await delay(5); } throw new Error(`Timed out ${label}`); }
  let bridge;
  const native = await until(() => window.__TAURI__?.core, Boolean, 'native IPC');
  const report = value => native.invoke('desktop_smoke_report', { report: value });
  try {
    if (config.scenario === 'startup') { await report({ final: true, passed: true, phase: 'startup-quit', bridgeReady: Boolean(window.contractAssistant) }); return; }
    bridge = await until(() => window.contractAssistant, Boolean, 'desktop bridge');
    const state = await bridge.getState();
    if (state.isPreview || state.storageBackend !== 'rust') throw new Error('Expected the real native workspace.');
    if (state.tasks.some(task => task.status === 'running' || task.status === 'queued')) throw new Error('A previous session left a review permanently active after restart.');
    let taskId, jobId, pdfActive, documentCount = state.documentsPage?.totalCount ?? state.documents.length;
    if (config.scenario.startsWith('model')) {
      const document = await bridge.loadSample();
      const afterImport = await bridge.getState(); documentCount = afterImport.documentsPage?.totalCount ?? afterImport.documents.length;
      await bridge.saveModelConfig({ name: 'Synthetic lifecycle API', baseUrl: config.endpoint, model: config.model, responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 1024, contextWindowTokens: 32768, timeoutSeconds: 30 });
      // Retrieval is independently exercised below; model close must not wait
      // for a previously configured directory to finish indexing first.
      const retrieval = config.retrieval; retrieval.knowledge.enabled = false; retrieval.knowledge.folderPath = null;
      await bridge.saveRetrievalConfig(retrieval);
      const task = await bridge.startReview({ documentId: document.id, mode: 'model', context: { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: 'Synthetic lifecycle cancellation fixture.' } }); taskId = task.taskId;
      await delay(700);
      if (config.scenario === 'model-cancel') void bridge.cancelReview(taskId).catch(() => {});
    } else if (config.scenario === 'index') {
      if (await bridge.selectKnowledgeFolder() !== config.folder) throw new Error('Unexpected synthetic folder.');
      await bridge.saveRetrievalConfig(config.retrieval);
      const job = await bridge.startKnowledgeSync('verify'); jobId = job.jobId;
    } else if (config.scenario === 'pdf') {
      const document = await bridge.loadSample();
      const afterImport = await bridge.getState(); documentCount = afterImport.documentsPage?.totalCount ?? afterImport.documents.length;
      const task = await bridge.startReview({ documentId: document.id, mode: 'local', context: { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: 'Synthetic native PDF shutdown fixture.' } });
      const completed = await until(async () => (await bridge.getState()).tasks.find(item => item.id === task.taskId), value => value?.status === 'completed', 'local review before PDF');
      let resolveStarted; let settled = false;
      const started = new Promise(resolve => { resolveStarted = resolve; });
      const unlisten = await window.__TAURI__.event.listen('desktop-smoke-pdf-started', () => resolveStarted());
      void bridge.runWorkspaceCommand({ action: 'reporting.export', payload: { scope: 'current', reviewId: completed.resultId, style: 'management', format: 'pdf' } }).then(() => { settled = true; }, () => { settled = true; });
      await Promise.race([started, delay(15000).then(() => { throw new Error('Native PDF admission event was not received.'); })]);
      unlisten(); pdfActive = !settled;
      if (!pdfActive) throw new Error('The native PDF export completed before the close test could exercise it.');
    }
    await report({ final: true, passed: true, closeWindow: true, phase: config.scenario, bridgeReady: true, taskId, jobId, pdfActive, documents: documentCount });
  } catch (error) { await report({ final: true, passed: false, phase: config.scenario, error: `${error?.message ?? error}\n${error?.stack ?? ''}` }); }
}
const runs = []; const baselinePids = new Set((await processes()).map(item => item.pid));
async function launch(scenario, iteration) {
  const overlap = scenario === 'model-overlap';
  const reportPath = join(parent, `${iteration}-${scenario}.json`); const scriptPath = join(parent, `${iteration}-${scenario}.js`); const dialogsPath = join(parent, `${iteration}-${scenario}-dialogs.json`);
  await writeFile(scriptPath, `void (${lifecycleFlow.toString()})(${JSON.stringify({ scenario, endpoint, model: `lifecycle-${iteration}`, folder, retrieval })});`);
  await writeFile(dialogsPath, JSON.stringify({ openFiles: [], saveFiles: scenario === 'pdf' ? [join(parent, `${iteration}-interrupted-report.pdf`)] : [], folders: scenario === 'index' ? [folder] : [] }));
  const replacementPath = join(parent, `${iteration}-replacement.json`); const replacementScript = join(parent, `${iteration}-replacement.js`); const duplicateReport = join(parent, `${iteration}-duplicate.json`);
  if (overlap) await writeFile(replacementScript, `void (${lifecycleFlow.toString()})(${JSON.stringify({ scenario: 'idle', endpoint, model: `replacement-${iteration}`, folder, retrieval })});`);
  const before = new Set((await processes()).map(item => item.pid));
  const environment = { ...process.env, LAW_AGENT_DATA_DIR: dataDir, LAW_AGENT_SMOKE_SCRIPT: scriptPath, LAW_AGENT_SMOKE_OUTPUT: reportPath, LAW_AGENT_SMOKE_DIALOGS: dialogsPath, ...(scenario === 'startup-failure' ? { LAW_AGENT_SMOKE_FORCE_STARTUP_FAILURE: '1' } : {}), ...(overlap ? { LAW_AGENT_SMOKE_SHUTDOWN_DELAY_MS: '1000', LAW_AGENT_SMOKE_REOPEN_SCRIPT: replacementScript, LAW_AGENT_SMOKE_REOPEN_OUTPUT: replacementPath } : {}) };
  const child = spawn(options.binary, [], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false; let exitCode; let signal; let stderr = ''; let stdout = ''; let report; let quitObservedAt;
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-50000); }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-50000); });
  child.on('exit', (code, value) => { exitCode = code; signal = value; exited = true; }); child.on('error', error => { stderr += String(error); exited = true; });
  let duplicate; let duplicateExit; let replacementReport; let replacementDone = false;
  const observed = new Map(); const webkit = new Map(); const start = performance.now();
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && (!exited || overlap && !replacementDone)) {
      report = await readFile(reportPath, 'utf8').then(JSON.parse).catch(() => report);
      if (report?.final && quitObservedAt === undefined) quitObservedAt = performance.now();
      if (overlap && report?.final && !duplicate) {
        duplicate = spawn(options.binary, [], { cwd: root, env: { ...environment, LAW_AGENT_SMOKE_SCRIPT: replacementScript, LAW_AGENT_SMOKE_OUTPUT: duplicateReport }, stdio: 'ignore' });
        duplicate.on('exit', (code, signal) => { duplicateExit = { code, signal }; });
      }
      if (overlap) replacementReport = await readFile(replacementPath, 'utf8').then(JSON.parse).catch(() => replacementReport);
      const all = await processes(); const own = descendants(all, child.pid);
      if (overlap) for (const item of all) if (!before.has(item.pid) && item.executable === options.binary) own.add(item.pid);
      if (replacementReport?.nativePid) for (const id of descendants(all, replacementReport.nativePid)) own.add(id);
      for (const item of all) { if (own.has(item.pid)) observed.set(item.pid, item); if (!before.has(item.pid) && /WebKit\.(?:WebContent|Networking|GPU)/u.test(item.executable)) webkit.set(item.pid, item); }
      replacementDone = Boolean(replacementReport?.final && !all.some(item => item.pid === replacementReport.nativePid));
      await sleep(20);
    }
    report = await readFile(reportPath, 'utf8').then(JSON.parse).catch(() => report);
    assert.ok(exited, `${scenario}: native host did not exit within 20 seconds. ${stderr}`);
    assert.equal(exitCode, scenario === 'startup-failure' ? 1 : 0, `${scenario}: native host exit code ${exitCode}, signal ${signal}. ${stderr}`);
    assert.equal(signal, null, `${scenario}: process terminated with a signal.`);
    if (scenario === 'startup-failure') {
      assert.equal(report?.startupFailure, true, 'Expected a controlled missing-runtime startup failure.');
      assert.ok(!/panicked|assertion.*failed|SIGABRT|FATAL ERROR/iu.test(stderr), 'Startup failure raised a panic or native assertion.');
    } else assert.equal(report?.passed, true, `${scenario}: ${report?.error ?? 'No completed native report.'}`);
    if (overlap) {
      assert.equal(duplicateExit?.code, 0, 'The duplicate launch did not exit normally after forwarding its reopen request.');
      assert.equal(duplicateExit.signal, null);
      assert.equal(replacementReport?.passed, true, 'A launch during shutdown did not produce a ready replacement application.');
      assert.equal(replacementReport?.bridgeReady, true);
      assert.equal(replacementDone, true, 'The replacement application did not close cleanly.');
      assert.equal(await readFile(duplicateReport, 'utf8').then(() => true).catch(() => false), false, 'The duplicate became a fresh owner; queued reopening was not actually exercised.');
    }
    const survivors = (await processes()).filter(item => observed.has(item.pid));
    assert.deepEqual(survivors, [], `${scenario}: an owned host/Node descendant survived shutdown.`);
    if (scenario.startsWith('model')) assert.ok(requests.some(item => item.body.model === `lifecycle-${iteration}`), 'No actual in-flight model request was observed.');
    const result = { iteration, scenario, passed: true, totalMs: performance.now() - start, shutdownAfterReportMs: quitObservedAt === undefined ? null : performance.now() - quitObservedAt, report, ...(overlap ? { duplicatePid: duplicate.pid, duplicateExit, replacementReport, guardedShutdownDelayMs: 1000 } : {}), observedProcesses: [...observed.values()], webkitProcesses: [...webkit.values()], stdout, stderr };
    runs.push(result); console.log(JSON.stringify({ iteration, scenario, passed: true, totalMs: result.totalMs, shutdownAfterReportMs: result.shutdownAfterReportMs }));
  } finally {
    if (!exited) { child.kill('SIGTERM'); await sleep(1000); if (!exited) child.kill('SIGKILL'); }
    // A failed overlap assertion must not leave its replacement holding the
    // isolated workspace or the test binary's single-instance ownership.
    const remaining = (await processes()).filter(item => observed.get(item.pid)?.executable === item.executable);
    for (const item of remaining) { try { process.kill(item.pid, 'SIGTERM'); } catch {} }
    if (remaining.length) { await sleep(500); for (const item of (await processes()).filter(item => remaining.some(owned => owned.pid === item.pid && owned.executable === item.executable))) { try { process.kill(item.pid, 'SIGKILL'); } catch {} } }
  }
}

try {
  let iteration = 0;
  for (let cycle = 0; cycle < options.cycles; cycle++) for (const scenario of ['startup', 'idle', 'model', 'model-cancel', 'index', 'pdf']) await launch(scenario, iteration++);
  const documentsBeforeFailure = runs.at(-1).report.documents;
  await launch('startup-failure', iteration++);
  await launch('idle', iteration++);
  assert.equal(runs.at(-1).report.documents, documentsBeforeFailure, 'A controlled startup failure changed the retained workspace documents.');
  await launch('model-overlap', iteration++);
  await sleep(4000);
  const tracked = new Set(runs.flatMap(run => run.observedProcesses.map(item => item.pid)));
  const remaining = (await processes()).filter(item => tracked.has(item.pid));
  assert.deepEqual(remaining, [], 'An owned native/Node process survived the lifecycle loop.');
  const remainingNewWebKit = (await processes()).filter(item => !baselinePids.has(item.pid) && /WebKit\.(?:WebContent|Networking|GPU)/u.test(item.executable));
  const ownedPids = new Set([...tracked, ...runs.flatMap(run => run.webkitProcesses.map(item => item.pid))]);
  const ownedCrashReports = [];
  for (const name of (await readdir(crashDirectory).catch(() => [])).filter(name => name.endsWith('.ips') && !oldCrashReports.has(name))) {
    try {
      const raw = await readFile(join(crashDirectory, name), 'utf8');
      const report = JSON.parse(raw.slice(raw.indexOf('\n') + 1));
      if (ownedPids.has(report.pid)) ownedCrashReports.push({ name, pid: report.pid, processName: report.procName, signal: report.exception?.signal });
    } catch { /* A partially written or unrelated diagnostic is not test evidence. */ }
  }
  assert.deepEqual(ownedCrashReports, [], 'An owned native/Node/WebKit process produced a new macOS crash report.');
  assert.deepEqual(await buildIdentity(), measuredBuild, 'The native/backend build changed during lifecycle validation.');
  const result = { passed: true, measuredAt: new Date().toISOString(), controllerNode: process.versions.node, build: measuredBuild, binary: options.binary, isolatedWorkspace: dataDir, syntheticFolder: folder, launches: runs.length, cycles: options.cycles, remainingOwnedProcesses: remaining, remainingNewWebKit, ownedCrashReports, crashObservationAfterExitMs: 4000, modelRequests: requests.length, runs, caveat: 'macOS reparented WebKit XPC lifetime is recorded separately; an owned Rust host or Node descendant surviving exit fails the run.' };
  await writeFile(options.output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, output: options.output, launches: runs.length, remainingOwnedProcesses: remaining.length, remainingNewWebKit: remainingNewWebKit.length }));
} catch (error) { await writeFile(options.output, JSON.stringify({ passed: false, error: error.stack, isolatedWorkspace: dataDir, runs }, null, 2)); throw error; }
finally { for (const response of heldResponses) response.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
