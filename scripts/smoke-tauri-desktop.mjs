#!/usr/bin/env node
// Real native-window acceptance and whole-application RSS comparison. All input
// files, API credentials and loopback responses are synthetic. Never opens a
// customer workspace. The Tauri binary must include the desktop-smoke feature.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { defaultRetrievalConfig } from '../src/shared/contracts.ts';
import { parseContract } from '../src/core/documents.ts';
import { createPdf } from '../tests/fixtures-documents.ts';
import { openNativeDatabase } from '../src/core/storage-backend.ts';
import { desktopSmokeFlow } from './tauri-smoke-flow.mjs';

const root = resolve(import.meta.dirname, '..');
const options = { binary: join(root, '.local/rust-target/release/law-agent-desktop'), shells: ['tauri'], historyMiB: 0, documents: 3, windowMs: 3000, intervalMs: 100, output: join(root, 'output/playwright/tauri-desktop/result.json') };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]; const value = process.argv[i + 1];
  if (key === '--binary' && value) options.binary = resolve(value);
  else if (key === '--shells' && /^(?:tauri|electron|tauri,electron|electron,tauri)$/u.test(value ?? '')) options.shells = value.split(',');
  else if (key === '--history-mib' && value) options.historyMiB = Number(value);
  else if (key === '--documents' && value) options.documents = Number(value);
  else if (key === '--window-ms' && value) options.windowMs = Number(value);
  else if (key === '--interval-ms' && value) options.intervalMs = Number(value);
  else if (key === '--output' && value) options.output = resolve(value);
  else throw new Error(`Unknown or missing argument: ${key}`);
}
for (const [name, low, high] of [['historyMiB', 0, 256], ['documents', 2, 1000], ['windowMs', 1000, 60000], ['intervalMs', 50, 5000]]) assert.ok(Number.isSafeInteger(options[name]) && options[name] >= low && options[name] <= high, `Invalid ${name}`);
assert.ok(['darwin', 'linux'].includes(platform()), 'This measurement sampler currently requires macOS or Linux ps. Windows acceptance must be run separately.');
const exec = promisify(execFile); const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const parent = await realpath(await mkdtemp(join(tmpdir(), 'law-agent-tauri-acceptance-')));
await mkdir(dirname(options.output), { recursive: true });
const closedFixture = join(parent, 'closed-legacy-fixture');
const seeded = await exec(process.execPath, ['--import', 'tsx', 'scripts/seed-business-storage-fixture.mjs', '--data-dir', closedFixture, '--history-mib', String(options.historyMiB), '--documents', String(options.documents)], { cwd: root, env: { ...process.env, LAW_AGENT_STORAGE_BACKEND: 'sqljs' }, maxBuffer: 2 * 1024 ** 2 });
const fixture = JSON.parse(seeded.stdout); const originalDatabase = await readFile(join(closedFixture, 'workspace.sqlite')); const fixtureSha256 = sha(originalDatabase);
const originalBytes = await readFile(join(closedFixture, fixture.originalRelativePath));
const sourceZip = await JSZip.loadAsync(originalBytes); const sourceXml = await sourceZip.file('word/document.xml').async('string');
sourceZip.file('word/document.xml', sourceXml.replace('<w:sectPr>', '<w:p><w:r><w:t>New synthetic desktop shell review fixture.</w:t></w:r></w:p><w:sectPr>'));
const inputBytes = await sourceZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
const inputPath = join(parent, 'Synthetic native shell contract.docx'); await writeFile(inputPath, inputBytes);
const pdfPath = join(parent, 'Synthetic trilingual input.pdf'); await writeFile(pdfPath, createPdf([['合同付款需核实。', 'Payment requires confirmation.', 'ข้อความภาษาไทย']]));
const knowledgeFolder = join(parent, 'synthetic-policy'); await mkdir(knowledgeFolder);
await writeFile(join(knowledgeFolder, 'acceptance-policy.txt'), '合成验收制度：服务采购合同付款前应核对书面验收记录。\nSynthetic policy: confirm written acceptance before payment.\nข้อกำหนดตัวอย่าง: ตรวจรับก่อนชำระเงิน\n');
const apiKey = 'synthetic-desktop-smoke-key'; const modelRequests = []; const modelErrors = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); let payload;
    try { payload = JSON.parse(body.messages.findLast(item => item.role === 'user').content); } catch { payload = null; }
    const isReview = Boolean(payload?.contractBlocks); modelRequests.push({ review: isReview, sourceCount: payload?.sources?.length ?? 0, model: body.model });
    let result = { ok: true };
    if (isReview) {
      const block = payload.contractBlocks.find(item => item.text.includes('验收'));
      const evidence = payload.sources.find(item => item.channel === 'knowledge' && item.excerpt.includes('验收'));
      assert.ok(block && evidence, 'Review requires original blocks and the local policy source.');
      await sleep(750);
      result = { summary: 'Synthetic cited contract review.', reviewedBlockIds: payload.contractBlocks.map(item => item.id), findings: [{ blockIds: [block.id], quote: block.text, title: 'Synthetic written acceptance check', category: 'commercial', severity: 'medium', description: 'Engineering source persistence check.', suggestion: 'Confirm written acceptance.', legalBasis: null, citations: [{ evidenceId: evidence.id, quote: evidence.excerpt.split(/\r?\n/u).find(line => line.trim()).slice(0, 80) }] }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ model: 'synthetic-shell-review', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
  } catch (error) { modelErrors.push(error.message); response.writeHead(500); response.end('{}'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const retrieval = defaultRetrievalConfig(); retrieval.knowledge.enabled = true; retrieval.knowledge.folderPath = knowledgeFolder; retrieval.knowledge.api.enabled = false; retrieval.knowledge.preferences.autoSyncEnabled = false; retrieval.web.enabled = false; retrieval.official.enabled = false;

async function processSnapshot() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { maxBuffer: 8 * 1024 ** 2 });
  return stdout.split('\n').flatMap(line => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u); return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), rssKiB: Number(match[3]), executable: match[4] }] : []; });
}
async function buildManifest() {
  async function walk(directory) { const entries = []; for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) { const path = join(directory, item.name); if (item.isDirectory()) entries.push(...await walk(path)); else if (item.isFile()) entries.push(path); } return entries; }
  const paths = [];
  if (options.shells.includes('electron')) for (const name of ['main', 'preload', 'renderer']) paths.push(...await walk(join(root, 'out', name)));
  if (options.shells.includes('tauri')) for (const name of ['desktop', 'tauri-renderer']) paths.push(...await walk(join(root, 'out', name)));
  if (options.shells.includes('tauri')) {
    // The actual sidecar runs the staged copy, rather than out/desktop.
    paths.push(...await walk(join(root, '.local/tauri-runtime/backend')));
    paths.push(...await walk(join(root, '.local/tauri-runtime/native')));
    paths.push(join(root, '.local/tauri-runtime/bin', platform() === 'win32' ? 'node.exe' : 'node'));
    paths.push(join(root, '.local/tauri-runtime/runtime-manifest.json'));
  }
  if (options.shells.includes('tauri')) paths.push(options.binary);
  paths.push(join(root, '.local/native', `law-agent-store-${platform()}-${arch()}.node`));
  const files = []; for (const path of paths.sort()) { const bytes = await readFile(path); files.push({ path: relative(root, path), bytes: bytes.length, sha256: sha(bytes) }); }
  return { sha256: sha(JSON.stringify(files)), files };
}
const measuredBuild = await buildManifest(); const runs = []; const smokeVaultIds = [];
const percentile = (values, part) => values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * part) - 1)];

async function runShell(shell) {
  const smokeVaultId = randomUUID();
  if (shell === 'tauri') smokeVaultIds.push(smokeVaultId);
  const dataDir = join(parent, shell); await cp(closedFixture, dataDir, { recursive: true });
  assert.equal(sha(await readFile(join(dataDir, 'workspace.sqlite'))), fixtureSha256);
  const exports = { tracked: join(parent, `${shell}-tracked.docx`), markdown: join(parent, `${shell}-cited-report.md`), diagnostics:join(parent,`${shell}-problem.log`),restartDiagnostics:join(parent,`${shell}-restart-problem.log`), pdfs: ['zh', 'en', 'th'].map(language => join(parent, `${shell}-${language}-report.pdf`)) };
  const samples = []; const launches = [];
  async function launch(restart = false, previous) {
    const baseline = new Set((await processSnapshot()).map(item => item.pid)); const attributedWebKit = new Set();
    const reportPath = join(parent, `${shell}-${restart ? 'restart' : 'first'}-report.json`);
    const dialogPath = join(parent, `${shell}-${restart ? 'restart' : 'first'}-dialogs.json`);
    await writeFile(dialogPath, JSON.stringify({ openFiles: restart ? [] : [inputPath, pdfPath], folders: restart ? [] : [knowledgeFolder], saveFiles: restart ? [exports.restartDiagnostics] : [exports.tracked, exports.markdown, ...exports.pdfs,exports.diagnostics] }));
    const config = { fixture, restart, previous, endpoint, apiKey, knowledgeFolder, retrieval, inputName: basename(inputPath), pdfName: basename(pdfPath), windowMs: options.windowMs };
    const injection = `void (${desktopSmokeFlow.toString()})(${JSON.stringify(config)}, value => window.__TAURI__.core.invoke('desktop_smoke_report', { report: value }));`;
    const scriptPath = join(parent, `${shell}-${restart ? 'restart' : 'first'}-flow.js`); await writeFile(scriptPath, injection);
    let processId; let child; let app; let done = false; let outcome; let activePhase = 'startup'; let reportedPhase; let failure; let stdout = ''; let stderr = '';
    const started = performance.now();
    try {
      if (shell === 'tauri') {
        child = spawn(options.binary, [], { cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir, LAW_AGENT_STORAGE_BACKEND: 'rust', LAW_AGENT_SMOKE_SCRIPT: scriptPath, LAW_AGENT_SMOKE_OUTPUT: reportPath, LAW_AGENT_SMOKE_DIALOGS: dialogPath, LAW_AGENT_SMOKE_VAULT_ID: smokeVaultId }, stdio: ['ignore', 'pipe', 'pipe'] });
        processId = child.pid; child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-100000); }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-100000); });
        child.once('error', error => { failure = error; done = true; }); child.once('exit', code => { if (code !== 0) failure = new Error(`Tauri exited with status ${code}. ${stderr}`); done = true; });
      } else {
        const { _electron: electron } = await import('playwright');
        app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LAW_AGENT_DATA_DIR: dataDir, LAW_AGENT_STORAGE_BACKEND: 'rust' }, timeout: 60000 }); processId = app.process().pid;
        await app.evaluate(({ dialog }, queues) => { dialog.showOpenDialog = async (_window, input) => { const key = input.properties.includes('openDirectory') ? 'folders' : 'openFiles'; if (!queues[key].length) throw new Error(`Test dialog queue exhausted: ${key}`); return { canceled: false, filePaths: [queues[key].shift()] }; }; dialog.showSaveDialog = async () => { if (!queues.saveFiles.length) throw new Error('Test save queue exhausted.'); return { canceled: false, filePath: queues.saveFiles.shift() }; }; }, JSON.parse(await readFile(dialogPath, 'utf8')));
        const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.contractAssistant));
        await page.exposeFunction('__lawAgentSmokeReport', async report => { await writeFile(reportPath, JSON.stringify(report)); });
        void page.evaluate(`(${desktopSmokeFlow.toString()})(${JSON.stringify(config)}, value => window.__lawAgentSmokeReport(value))`).catch(error => { failure = error; done = true; });
      }
      const deadline = Date.now() + 8 * 60 * 1000;
      while (Date.now() < deadline) {
        const report = await readFile(reportPath, 'utf8').then(JSON.parse).catch(() => null);
        if (report) {
          outcome = report; activePhase = report.final ? activePhase : report.phase;
          if (report.phase !== reportedPhase) { reportedPhase = report.phase; console.log(JSON.stringify({ shell, restart, phase: report.phase, passed: report.final ? report.passed : undefined })); }
        }
        if (outcome?.final || done) break;
        if (activePhase !== 'startup') {
          const all = await processSnapshot(); const descendantIds = new Set([processId]); let changed;
          do { changed = false; for (const item of all) if (descendantIds.has(item.parentPid) && !descendantIds.has(item.pid)) { descendantIds.add(item.pid); changed = true; } } while (changed);
          if (shell === 'tauri' && platform() === 'darwin') for (const item of all) if (!baseline.has(item.pid) && /(?:WebKit\.WebContent|WebKit\.Networking|WebKit\.GPU)/u.test(item.executable)) attributedWebKit.add(item.pid);
          const processes = all.filter(item => descendantIds.has(item.pid) || attributedWebKit.has(item.pid)).map(item => ({ ...item, association: descendantIds.has(item.pid) ? 'descendant' : 'new-webkit-since-isolated-launch' }));
          samples.push({ launch: restart ? 'restart' : 'first', phase: activePhase, monotonicMs: performance.now(), rssSumKiB: processes.reduce((sum, item) => sum + item.rssKiB, 0), processes });
        }
        await sleep(options.intervalMs);
      }
      if (!outcome?.final) throw failure ?? new Error(`Native smoke did not finish. Last phase ${activePhase}. ${stderr}`);
      assert.equal(outcome.passed, true, `${shell}: ${outcome.error ?? JSON.stringify(outcome)}`);
      launches.push({ restart, elapsedMs: performance.now() - started, reportPath, scriptPath, outcome, stdout, stderr });
      return outcome;
    } finally {
      if (app) await app.close();
      let forcedTermination = false;
      if (child && !done) {
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(15000)]);
        if (!done) { forcedTermination = true; child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]); }
        if (!done) child.kill('SIGKILL');
      }
      await writeFile(join(parent, `${shell}-${restart ? 'restart' : 'first'}-process.log`), `${stdout}\n${stderr}`);
      if (outcome?.passed && forcedTermination) throw new Error('The native application did not shut down gracefully after its completed smoke report.');
      if (outcome?.passed && failure) throw failure;
    }
  }
  const first = await launch();
  const diagnosticText=await readFile(exports.diagnostics,'utf8');
  assert.match(diagnosticText,/LawAgent troubleshooting log/u);
  assert.match(diagnosticText,/command.failed/u);
  if(shell==='tauri')assert.match(diagnosticText,/native_backend_ready/u);
  for(const secret of [apiKey,endpoint,basename(inputPath),knowledgeFolder,'synthetic-private-input-never-log',first.review.id,'LAWDEV1-'])assert.ok(!diagnosticText.includes(secret),'Troubleshooting log must omit payloads, credentials, paths and identifiers.');
  const zip = await JSZip.loadAsync(await readFile(exports.tracked)); const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /<[\w-]+:ins\b/u); assert.match(xml, /<[\w-]+:del\b/u); assert.match(xml, /双方书面确认/u); assert.match(xml, /Original Author/u); assert.match(xml, /<w:b\s*\/>/u); assert.ok(!xml.includes('This rejected text must not appear.'));
  assert.equal(sha(await readFile(inputPath)), sha(inputBytes));
  const markdown = await readFile(exports.markdown, 'utf8'); const source = first.review.retrieval.evidence.find(item => item.localIndex);
  assert.ok(markdown.includes(source.id) && markdown.includes(source.localIndex.fileSha256) && markdown.includes(first.review.findings[0].citations[0].quote));
  const pdfValidation = [];
  for (const path of exports.pdfs) {
    const bytes = await readFile(path); assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    const parsed = await parseContract(path); const text = parsed.blocks.map(item => item.text).join('\n');
    assert.ok(parsed.pageCount >= 2, `Expected paginated native PDF: ${path}, pages ${parsed.pageCount}`);
    assert.match(text, /Synthetic organization/u); assert.match(text, /องค์กรตัวอย่าง/u); assert.match(text, /合成测试单位/u);
    // Native PDF text extractors may decompose Thai SARA AM and insert line
    // wraps. Compare normalized glyph text while retaining the source file hash.
    const comparable = value => value.normalize('NFKC').replace(/\s+/gu, '');
    assert.ok(comparable(text).includes(comparable('ข้อกำหนดตัวอย่าง: ตรวจรับก่อนชำระเงิน')), 'Native PDF lost the original Thai source quotation.');
    if (path === exports.pdfs[0]) assert.match(text, /Synthetic written acceptance check/u);
    assert.match(text, /服务付款应在验收后办理/u);
    pdfValidation.push({ path, bytes: bytes.length, pageCount: parsed.pageCount, trilingualText: true, originalQuote: true, syntheticApprovedTranslation: path !== exports.pdfs[0] });
  }
  await launch(true, first);
  const restartedLog=await readFile(exports.restartDiagnostics,'utf8');
  assert.match(restartedLog,/desktop.closed/u);
  assert.match(restartedLog,/command.failed/u);
  assert.ok(!restartedLog.includes(apiKey)&&!restartedLog.includes('synthetic-private-input-never-log'));
  assert.equal(sha(await readFile(join(dataDir, fixture.originalRelativePath))), fixture.originalSha256);
  assert.equal(sha(await readFile(join(dataDir, 'workspace.sqlite.pre-rust-backup'))), fixtureSha256);
  const db = openNativeDatabase(join(dataDir, 'workspace.sqlite'), true);
  try { const row = db.all("SELECT COUNT(*) AS rows,COALESCE(SUM(length(detail_json)),0) AS payloadBytes FROM audit_events WHERE entity_type='synthetic-memory-fixture'")[0]; assert.equal(Number(row.rows), fixture.historyRows); assert.equal(Number(row.payloadBytes), fixture.historyPayloadBytes); } finally { db.close(); }
  const stages = [...new Set(samples.map(item => `${item.launch}:${item.phase}`))].map(key => {
    const current = samples.filter(item => `${item.launch}:${item.phase}` === key); const values = current.map(item => item.rssSumKiB);
    return { name: key, sampleCount: current.length, rssMedianMiB: percentile(values, .5) / 1024, rssPeakMiB: Math.max(...values) / 1024, maxProcessCount: Math.max(...current.map(item => item.processes.length)), reparentedWebKitPids: [...new Set(current.flatMap(item => item.processes.filter(process => process.association !== 'descendant').map(process => process.pid)))] };
  });
  const result = { shell, dataDir, passed: true, stages, launches, exports, pdfValidation, samples };
  await writeFile(join(dirname(options.output), `${shell}-run.json`), JSON.stringify(result, null, 2));
  return result;
}

try {
  for (const shell of options.shells) runs.push(await runShell(shell));
  assert.deepEqual(modelErrors, []); assert.equal(modelRequests.filter(item => item.review).length, options.shells.length);
  assert.equal((await buildManifest()).sha256, measuredBuild.sha256, 'Built application changed during the measurement.');
  const result = { passed: true, measuredAt: new Date().toISOString(), platform: { os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, totalMemoryBytes: totalmem() }, metric: 'Summed RSS for app descendants plus newly launched macOS WebKit processes', limitations: ['RSS sums can double-count shared pages.', 'macOS WebKit XPC processes may be reparented to launchd; all newly created WebKit processes since each isolated app launch are conservatively included. Unrelated WebKit launches during the sample may inflate the total.', 'Mock loopback model; no actual local model memory is included.', 'Startup is excluded; both applications use the same closed synthetic schema-7 workspace and workflow.', 'The diagnostic script and report command exist only in a desktop-smoke feature build.'], intervalMs: options.intervalMs, fixture: { databaseBytes: originalDatabase.length, sha256: fixtureSha256, historyRows: fixture.historyRows, historyPayloadBytes: fixture.historyPayloadBytes, documents: fixture.documentCount }, isolatedRoot: parent, build: measuredBuild, modelRequests, runs: runs.map(({ samples: _samples, launches, ...run }) => ({ ...run, launches: launches.map(({ outcome, ...launch }) => ({ ...launch, stages: outcome.stages, passed: outcome.passed, errors: outcome.errors })) })) };
  await writeFile(options.output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, output: options.output, isolatedRoot: parent, runs: result.runs.map(run => ({ shell: run.shell, stages: run.stages, pdfValidation: run.pdfValidation })) }, null, 2));
} catch (error) { await writeFile(options.output, JSON.stringify({ passed: false, error: error.stack, isolatedRoot: parent, runs, modelErrors, modelRequests }, null, 2)); throw error; }
finally {
  await new Promise(resolve => server.close(resolve));
  // Also clean keys after a failed first launch, before a restart can run the
  // feature-gated native cleanup. These UUID namespaces belong only to this run.
  if (platform() === 'darwin') for (const id of smokeVaultIds) {
    try { await exec('/usr/bin/security', ['delete-generic-password', '-s', `com.lawagent.desktop.tauri.smoke.${id}`, '-a', 'credential-encryption-v1'], { timeout: 5000 }); }
    catch (error) { if (error.code !== 44) throw new Error('The UUID-isolated synthetic credential key could not be cleaned up.', { cause: error }); }
  }
}
