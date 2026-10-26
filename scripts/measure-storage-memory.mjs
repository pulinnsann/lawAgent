#!/usr/bin/env node
// Same synthetic SQLite input; child-process peak RSS, not full desktop memory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dirname, '..');
const options = { rows: 4096, payloadBytes: 16384, iterations: 4, pageLimit: 64, holdMs: 250, noTime: false, order: 'native-first' };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--no-time') { options.noTime = true; continue; }
  const value = process.argv[++i];
  if (arg === '--native' && value) options.native = resolve(value);
  else if (arg === '--output' && value) options.output = resolve(value);
  else if (arg === '--order' && ['native-first', 'sqljs-first'].includes(value)) options.order = value;
  else if (['--rows', '--payload-bytes', '--iterations', '--page-limit', '--hold-ms'].includes(arg) && value) {
    const key = { '--rows': 'rows', '--payload-bytes': 'payloadBytes', '--iterations': 'iterations', '--page-limit': 'pageLimit', '--hold-ms': 'holdMs' }[arg]; options[key] = Number(value);
  } else throw new Error(`Invalid argument: ${arg}`);
}
for (const [key, min, max] of [['rows', 1, 1000000], ['payloadBytes', 1, 2097152], ['iterations', 1, 128], ['pageLimit', 1, 1000], ['holdMs', 0, 1000]]) {
  assert.ok(Number.isSafeInteger(options[key]) && options[key] >= min && options[key] <= max, `Invalid ${key}`);
}
assert.ok(options.rows * options.payloadBytes <= 256 * 1024 * 1024, 'The synthetic input is limited to 256 MiB');
const target = resolve(process.env.LAW_AGENT_CARGO_TARGET ?? join(root, '.local', 'rust-target'));
options.native ??= join(target, 'release', platform() === 'win32' ? 'law-agent-core.exe' : 'law-agent-core');
await access(options.native).catch(() => { throw new Error('Native release executable is missing. Run npm run native:build first, or pass --native. This benchmark does not compile a candidate during measurement.'); });
const nativeStat = await lstat(options.native);
assert.ok(nativeStat.isFile() && !nativeStat.isSymbolicLink(), 'The native executable must be a regular file');
const outputRoot = join(root, 'output', 'storage-memory');
await mkdir(outputRoot, { recursive: true });
const directory = await realpath(await mkdtemp(join(outputRoot, 'run-')));
const seed = join(directory, 'seed.sqlite');
const nativePath = join(directory, 'native.sqlite');
const sqljsPath = join(directory, 'sqljs.sqlite');
await writeFile(join(directory, '.storage-memory-synthetic-only.json'), `${JSON.stringify({ format: 'law-agent-synthetic-storage-memory-v1', sqljsDatabase: 'sqljs.sqlite', createdAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });

async function run(executable, args) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 1024 * 1024) child.kill(); });
    child.stderr.on('data', data => { stderr += data; if (stderr.length > 1024 * 1024) child.kill(); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, wallMs: performance.now() - started }));
  });
}
const parseSummary = result => {
  if (result.code !== 0) throw new Error(`Benchmark child failed (${result.code ?? result.signal}): ${result.stderr.slice(-4000)}`);
  return JSON.parse(result.stdout.trim());
};
const sha256 = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const seedResult = parseSummary(await run(options.native, ['seed', seed, String(options.rows), String(options.payloadBytes)]));
assert.equal(seedResult.seed.rows_written, options.rows);
assert.equal(seedResult.seed.total_payload_bytes, options.rows * options.payloadBytes);
for (const suffix of ['-wal', '-shm', '-journal']) {
  const sidecar = await lstat(`${seed}${suffix}`).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  assert.equal(sidecar, null, 'Seed process must exit and checkpoint before any plain-file copies are made');
}
await copyFile(seed, nativePath); await copyFile(seed, sqljsPath);
const initialHashes = { seed: await sha256(seed), native: await sha256(nativePath), sqljs: await sha256(sqljsPath) };
assert.equal(initialHashes.seed, initialHashes.native); assert.equal(initialHashes.seed, initialHashes.sqljs);

let timeMode = null;
if (!options.noTime && ['darwin', 'linux'].includes(platform())) {
  try { await access('/usr/bin/time'); timeMode = platform() === 'darwin' ? 'darwin-time-l' : 'linux-time-v'; } catch { /* A missing peak metric is reported, never fabricated. */ }
}
async function measured(name, executable, args) {
  const command = timeMode ? '/usr/bin/time' : executable;
  const commandArgs = timeMode ? [timeMode === 'darwin-time-l' ? '-l' : '-v', executable, ...args] : args;
  const result = await run(command, commandArgs);
  await writeFile(join(directory, `${name}.stdout.json`), result.stdout);
  await writeFile(join(directory, `${name}.time.txt`), result.stderr);
  const summary = parseSummary(result);
  let peakRssBytes = null;
  if (timeMode === 'darwin-time-l') {
    const match = result.stderr.match(/^\s*(\d+)\s+maximum resident set size\s*$/mu);
    if (match) peakRssBytes = Number(match[1]);
  } else if (timeMode === 'linux-time-v') {
    const match = result.stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/u);
    if (match) peakRssBytes = Number(match[1]) * 1024;
  }
  return { backend: name, peakRssBytes, peakRssMiB: peakRssBytes === null ? null : peakRssBytes / 1048576, peakRssSource: peakRssBytes === null ? null : timeMode, peakRssUnavailableReason: peakRssBytes !== null ? null : timeMode ? 'time output did not include a recognized maximum-RSS value' : options.noTime ? 'Explicit --no-time run' : 'Supported /usr/bin/time is unavailable on this platform', wallMs: result.wallMs, summary };
}
const parameters = [String(options.iterations), String(options.pageLimit), String(options.holdMs)];
const operations = {
  native: () => measured('native', options.native, ['exercise', nativePath, ...parameters]),
  sqljs: () => measured('sqljs', process.execPath, [join(root, 'scripts', 'storage-memory-sqljs.mjs'), sqljsPath, ...parameters]),
};
const measurements = {};
const order = options.order === 'native-first' ? ['native', 'sqljs'] : ['sqljs', 'native'];
for (const backend of order) {
  measurements[backend] = await operations[backend]();
  console.log(JSON.stringify({ backend, peakRssMiB: measurements[backend].peakRssMiB, wallMs: measurements[backend].wallMs }));
}
for (const key of ['iterations', 'pageLimit', 'rowsRead', 'totalPayloadBytes', 'updateRevision']) assert.equal(measurements.native.summary[key], measurements.sqljs.summary[key], `Backend mismatch: ${key}`);
assert.equal(measurements.native.summary.store.rows, options.rows); assert.equal(measurements.sqljs.summary.store.rows, options.rows);
assert.equal(measurements.native.summary.updateRevision, options.iterations + 1);
const fullPageRows = Math.min(options.pageLimit, Math.floor(2097152 / options.payloadBytes));
if (options.rows >= fullPageRows * options.iterations) {
  assert.equal(measurements.native.summary.rowsRead, fullPageRows * options.iterations);
  assert.equal(measurements.native.summary.totalPayloadBytes, fullPageRows * options.iterations * options.payloadBytes);
}
const report = {
  format: 'law-agent-storage-memory-v1', passed: true, measuredAt: new Date().toISOString(),
  host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, totalMemoryBytes: totalmem(), node: process.version },
  buildIdentity: { nativeExecutableBytes: nativeStat.size, nativeExecutableSha256: await sha256(options.native), sqljsScriptSha256: await sha256(join(root, 'scripts', 'storage-memory-sqljs.mjs')), cargoLockSha256: await sha256(join(root, 'Cargo.lock')) },
  fixture: { rows: options.rows, payloadBytesPerRow: options.payloadBytes, totalSeedPayloadBytes: options.rows * options.payloadBytes, databaseFileBytes: (await stat(seed)).size, initialHashes, replacementPayloadBytes: Buffer.byteLength('Synthetic deterministic update'), syntheticOnly: true },
  protocol: { iterations: options.iterations, pageLimit: options.pageLimit, maxPagePayloadBytes: 2097152, holdMs: options.holdMs, afterIdStartsAt: 0, afterIdAdvancesPerIteration: true, updateIdPerIteration: 1, order, timeMode, forceGc: false, compiledBeforeMeasurement: true, directory },
  measurements,
  limits: [
    'A backend storage proof, not a complete Rust desktop application or a measurement of Tauri/WebView memory.',
    'Both children start from byte-identical closed single-file SQLite copies; seed/build/parent hashing and copy allocations are outside measured child processes.',
    'Rust uses bounded disk SQLite with an 8 MiB cache and WAL; SQL.js follows the current AppStore in-memory database, full-file rollback preimage and atomic full-file flush pattern.',
    'This compares application storage strategies and runtime costs, not only Rust versus JavaScript language performance.',
    'Peak RSS is per exercised child process, not a process-tree or unique physical-footprint metric; this workload spawns no child workers.',
    'Darwin time -l maximum RSS is bytes; Linux time -v kbytes is multiplied by 1024; absent metrics remain null.',
    'No forced garbage collection; allocator and cache retention form part of observed process peak.',
    'Execution order and warm filesystem caches can affect durations. Repeat with --order sqljs-first and use multiple independent runs for acceptance.',
    'No production DB, customer files, credentials, model requests or legal correctness are involved.',
  ],
};
const output = options.output ?? join(directory, 'result.json');
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, output, identicalInput: true, matchingLogicalResults: true, peakRssAvailable: Boolean(measurements.native.peakRssBytes && measurements.sqljs.peakRssBytes) }));
