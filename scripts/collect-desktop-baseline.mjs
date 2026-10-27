#!/usr/bin/env node
// Explicit-PID, read-only sampling. This does not launch a model, open a
// workspace, control the target process, or establish product acceptance.
import { execFile } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MAX_REPORT_BYTES = 128 * 1024 ** 2;
const fail = code => Object.assign(new Error(code), { code });
const integer = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const nameOnly = value => String(value ?? '').replaceAll('\\', '/').split('/').at(-1).replace(/[\u0000-\u001f\u007f]/gu, '_').slice(0, 160) || '(unknown)';
const memoryBytes = value => value === null || value === undefined || value === '' ? null : integer(value);

export function parseProcessSnapshot(os, stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 16 * 1024 ** 2) throw fail('INVALID_PROCESS_SNAPSHOT');
  let rows;
  if (os === 'win32') {
    let parsed; try { parsed = JSON.parse(stdout.replace(/^\uFEFF/u, '')); } catch { throw fail('INVALID_PROCESS_SNAPSHOT'); }
    rows = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).map(row => ({
      pid: integer(row.pid), parentPid: integer(row.parentPid), name: nameOnly(row.name),
      // WMI explicitly permits zero to mean unknown, so it is not a measured zero.
      workingSetBytes: memoryBytes(row.workingSetBytes) || null,
      createdAt: typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt)) ? row.createdAt.trim() : null,
    }));
  } else if (os === 'darwin' || os === 'linux') {
    rows = stdout.trim().split(/\r?\n/u).filter(Boolean).map(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+|-)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u.exec(line);
      if (!match) throw fail('INVALID_PROCESS_SNAPSHOT');
      const kib = match[3] === '-' ? null : integer(match[3]);
      return { pid: integer(match[1]), parentPid: integer(match[2]), name: nameOnly(match[5]), workingSetBytes: kib === null || !Number.isSafeInteger(kib * 1024) ? null : kib * 1024, createdAt: match[4].replace(/\s+/gu, ' ') };
    });
  } else throw fail('UNSUPPORTED_PLATFORM');
  if (!rows.length || rows.some(row => row.pid === null || row.parentPid === null)) throw fail('INVALID_PROCESS_SNAPSHOT');
  return rows;
}

/** Track process creation identity, never numeric PID alone. Previously seen
 * children may remain associated after reparenting; unseen WebViews cannot. */
export function selectOwnedProcesses(rows, root, previous = []) {
  const same = (a, b) => a.pid === b.pid && a.createdAt !== null && a.createdAt === b.createdAt;
  const currentRoot = rows.find(row => row.pid === root.pid);
  const rootAlive = Boolean(currentRoot && same(currentRoot, root));
  const owned = new Map();
  if (rootAlive) owned.set(currentRoot.pid, currentRoot);
  for (const row of rows) if (previous.some(known => same(row, known))) owned.set(row.pid, row);
  let changed;
  do {
    changed = false;
    for (const row of rows) {
      const parent = owned.get(row.parentPid);
      if (!parent || owned.has(row.pid)) continue;
      const childTime = Date.parse(row.createdAt ?? ''); const parentTime = Date.parse(parent.createdAt ?? '');
      if (Number.isFinite(childTime) && Number.isFinite(parentTime) && childTime < parentTime) continue;
      owned.set(row.pid, row); changed = true;
    }
  } while (changed);
  const all = [...owned.values()].sort((a, b) => a.pid - b.pid);
  return { rootAlive, rootIdentityChanged: Boolean(currentRoot && !same(currentRoot, root)), processes: all.slice(0, 128), processLimitReached: all.length > 128 };
}

export function normalizeBaselineOptions(input) {
  const pid = Number(input.pid); const durationSeconds = Number(input.durationSeconds ?? 30); const intervalMs = Number(input.intervalMs ?? 1000);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff || !Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 1800 || !Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 10000) throw fail('INVALID_BASELINE_OPTIONS');
  return { pid, durationSeconds, intervalMs, output: resolve(input.output ?? join(import.meta.dirname, '../output/desktop-baseline/' + new Date().toISOString().replaceAll(':', '-') + '.json')) };
}

async function processSnapshot(os) {
  try {
    if (os === 'win32') {
      // No command lines, executable paths, usernames or environment variables.
      const script = '$ErrorActionPreference="Stop";[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Get-CimInstance Win32_Process|ForEach-Object{[pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;workingSetBytes=$(if($null -eq $_.WorkingSetSize){$null}else{$_.WorkingSetSize.ToString([Globalization.CultureInfo]::InvariantCulture)});createdAt=$(if($null -eq $_.CreationDate){$null}else{$_.CreationDate.ToUniversalTime().ToString("o")})}}|ConvertTo-Json -Compress';
      const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, maxBuffer: 16 * 1024 ** 2, windowsHide: true });
      return parseProcessSnapshot(os, result.stdout);
    }
    if (os !== 'darwin' && os !== 'linux') throw fail('UNSUPPORTED_PLATFORM');
    const result = await execute('ps', ['-axo', 'pid=,ppid=,rss=,lstart=,comm='], { timeout: 5000, maxBuffer: 16 * 1024 ** 2, env: { ...process.env, LC_ALL: 'C' } });
    return parseProcessSnapshot(os, result.stdout);
  } catch (error) { if (error?.code === 'UNSUPPORTED_PLATFORM' || error?.code === 'INVALID_PROCESS_SNAPSHOT') throw error; throw fail('PROCESS_SNAPSHOT_UNAVAILABLE'); }
}

export async function collectDesktopBaseline(input) {
  const options = normalizeBaselineOptions(input); const os = platform(); const initial = await processSnapshot(os);
  const root = initial.find(row => row.pid === options.pid); if (!root) throw fail('TARGET_PROCESS_NOT_FOUND'); if (!root.createdAt) throw fail('TARGET_IDENTITY_UNAVAILABLE');
  await mkdir(dirname(options.output), { recursive: true });
  const file = await open(options.output, 'wx', 0o600);
  const started = performance.now(); const known = new Map(); let bytesWritten = 0; let sampleCount = 0; let completeSamples = 0; let unavailableSamples = 0; let peakBytes = null; let sumBytes = 0; let interrupted = false; let reason = 'duration'; let pendingSnapshot = initial;
  const stop = () => { interrupted = true; }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const write = async value => { bytesWritten += Buffer.byteLength(value); await file.writeFile(value); };
  try {
    const header = {
      schema: 'law-desktop-baseline-v1', startedAt: new Date().toISOString(), root: { pid: root.pid, name: root.name, createdAt: root.createdAt },
      system: { platform: os, release: release(), arch: arch(), cpuModel: cpus()[0]?.model ?? null, logicalCpuCount: cpus().length, totalMemoryBytes: totalmem() },
      metric: os === 'win32' ? 'summed-process-working-set-bytes' : 'summed-process-rss-bytes',
      requested: { durationSeconds: options.durationSeconds, intervalMs: options.intervalMs },
      attributionIncomplete: true,
      limitations: [
        'Includes descendants and previously observed owned children with matching process creation identity. Unseen reparented WebKit/WebView2 processes cannot be reliably attributed; this is not complete whole-application memory.',
        'Windows CIM WorkingSetSize is working set, not private working set. macOS/Linux ps RSS has different accounting. Shared pages can be counted more than once in both sums.',
        'No task correctness, local-model performance, pressure adaptation or target-device acceptance is inferred from sampling.',
        'Sampler subprocesses and disk writes can affect host resources. Actual sample times are recorded; the requested interval is not guaranteed.',
        'Only selected process names, numeric metrics and creation identities are saved. Command lines, executable paths, user names and contract contents are excluded.',
      ],
    };
    await write(JSON.stringify(header).slice(0, -1) + ',"samples":[');
    while (true) {
      const began = performance.now(); let sample; let stopAfter = false;
      try {
        const rows = pendingSnapshot ?? await processSnapshot(os); pendingSnapshot = null;
        const selected = selectOwnedProcesses(rows, root, [...known.values()]);
        known.clear(); for (const item of selected.processes) if (item.createdAt) known.set(item.pid + '|' + item.createdAt, { pid: item.pid, createdAt: item.createdAt });
        const complete = selected.rootAlive && !selected.processLimitReached && selected.processes.every(item => item.workingSetBytes !== null);
        const totalBytes = complete ? selected.processes.reduce((sum, item) => sum + item.workingSetBytes, 0) : null;
        sample = { at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), durationMs: Math.round(performance.now() - began), ...selected, totalBytes, completeMetric: complete };
        if (!selected.rootAlive) { reason = selected.rootIdentityChanged ? 'root_identity_changed' : 'root_exit'; stopAfter = true; }
      } catch (error) { sample = { at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), durationMs: Math.round(performance.now() - began), errorCode: error?.code === 'INVALID_PROCESS_SNAPSHOT' ? 'INVALID_PROCESS_SNAPSHOT' : 'PROCESS_SNAPSHOT_UNAVAILABLE', totalBytes: null, completeMetric: false }; }
      const encoded = (sampleCount ? ',' : '') + JSON.stringify(sample);
      if (bytesWritten + Buffer.byteLength(encoded) > MAX_REPORT_BYTES - 16384) { reason = 'report_size_limit'; break; }
      await write(encoded); sampleCount++;
      if (sample.completeMetric) { completeSamples++; sumBytes += sample.totalBytes; peakBytes = Math.max(peakBytes ?? 0, sample.totalBytes); } else unavailableSamples++;
      if (stopAfter) break;
      if (interrupted) { reason = 'interrupted'; break; }
      if (performance.now() - started >= options.durationSeconds * 1000) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, Math.min(Math.max(0, options.intervalMs - (performance.now() - began)), Math.max(0, options.durationSeconds * 1000 - (performance.now() - started)))));
    }
    const summary = { stoppedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), stopReason: reason, completedRequestedWindow: reason === 'duration', sampleCount, completeMetricSamples: completeSamples, unavailableSamples, peakBytes, meanBytes: completeSamples ? Math.round(sumBytes / completeSamples) : null };
    await write('],"summary":' + JSON.stringify(summary) + '}\n'); await file.sync(); return { output: options.output, summary };
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await file.close(); }
}

async function main() {
  const input = {}; const names = { '--pid': 'pid', '--duration-seconds': 'durationSeconds', '--interval-ms': 'intervalMs', '--output': 'output' };
  for (let index = 2; index < process.argv.length; index += 2) { const key = names[process.argv[index]]; const value = process.argv[index + 1]; if (!key || !value || key in input) throw fail('INVALID_BASELINE_OPTIONS'); input[key] = value; }
  const result = await collectDesktopBaseline(input); process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(error => { process.stderr.write(JSON.stringify({ error: typeof error?.code === 'string' && /^[A-Z_]+$/u.test(error.code) ? error.code : 'BASELINE_COLLECTION_FAILED' }) + '\n'); process.exitCode = 1; });
