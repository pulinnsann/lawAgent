import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiagnosticLog, classifyDiagnosticError, DIAGNOSTIC_LOG_MAX_FILE_BYTES, DIAGNOSTIC_LOG_MAX_QUEUE } from '../src/main/diagnostic-log';

const SECRET = 'synthetic-private-contract-API-key-LAWDEV1-hidden';
const NOW = '2026-10-27T00:00:00.000Z';
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'law-diagnostics-')));
  return { path, logs: join(path, 'diagnostics'), async close() { await rm(path, { recursive: true, force: true }); } };
}
function rows(text: string): Array<Record<string, unknown>> { return text.split('--- Validated events (JSONL) ---\n')[1]?.split('\n').filter(Boolean).map(line => JSON.parse(line)) ?? []; }

test('diagnostic events contain only allowlisted metadata and never retain arbitrary payloads or error text', async () => {
  const directory = await fixture(); let log: DiagnosticLog | undefined;
  try {
    log = await DiagnosticLog.open(directory.path, { appVersion: '0.3.0', platform: 'darwin', arch: 'arm64', nodeVersion: 'v24.22.1', runtime: 'tauri', storageBackend: 'rust' });
    assert.equal(log.status().available, true);
    log.record({ event: 'command.failed', command: 'startReview', action: 'workspace.licenseActivate', reviewMode: 'model', durationMs: 17,
      ...classifyDiagnosticError(Object.assign(new Error(SECRET), { code: 'LICENSE_READ_ONLY' })),
      token: SECRET, deviceCode: SECRET, apiKey: SECRET, payload: { title: SECRET }, message: SECRET, stack: SECRET,
      path: '/synthetic/' + SECRET, url: 'https://example.invalid/' + SECRET, taskId: SECRET, documentId: SECRET });
    const text = await log.exportText({ appVersion: '0.3.1', platform: SECRET, arch: SECRET, nodeVersion: SECRET, storageBackend: SECRET, mode: SECRET, runtime: SECRET });
    assert.ok(!text.includes(SECRET)); assert.ok(!text.includes('https://')); assert.ok(!text.includes('/synthetic/'));
    const records = rows(text); assert.equal(records.length, 1);
    assert.deepEqual(Object.keys(records[0]).sort(), ['action', 'appVersion', 'arch', 'command', 'durationMs', 'errorCode', 'event', 'nodeVersion', 'platform', 'reviewMode', 'runtime', 'storageBackend', 'time', 'v'].sort());
    assert.equal(records[0].errorCode, 'LICENSE_READ_ONLY'); assert.equal(records[0].appVersion, '0.3.0');
    assert.match(text, /appVersion: 0\.3\.1/);
    assert.ok(records[0].time); assert.equal(records[0].v, 1);
  } finally { await log?.close(); await directory.close(); }
});

test('malicious values in every recognized field are omitted and unsupported events cannot enter the log', async () => {
  const directory = await fixture(); const log = await DiagnosticLog.open(directory.path);
  try {
    const value = SECRET + '\n{"event":"fake"}';
    const metadata = { appVersion: value, nodeVersion: value, platform: value, arch: value, mode: value, runtime: value, storageBackend: value,
      command: value, action: value, stage: value, status: value, errorCode: value, reviewMode: value,
      count: value, durationMs: value, exitCode: value, httpStatus: value, time: value };
    log.record({ event: 'command.started', ...metadata }); log.record({ ...metadata, event: value });
    log.record({ event: 'command.started', command: 'library.' + SECRET, action: 'library.' + SECRET, count: Infinity, durationMs: -1, httpStatus: 900 });
    const output = await log.exportText(metadata);
    assert.ok(!output.includes(SECRET));
    const records = rows(output); assert.equal(records.length, 2);
    for (const record of records) assert.deepEqual(Object.keys(record).sort(), ['event', 'time', 'v']);
  } finally { await log.close(); await directory.close(); }
});

test('error classification keeps only safe error codes and HTTP status, never a raw message or stack', () => {
  assert.deepEqual(classifyDiagnosticError(Object.assign(new Error(SECRET), { code: 'ENOSPC', status: 503 })), { errorCode: 'ENOSPC', httpStatus: 503 });
  assert.deepEqual(classifyDiagnosticError({ code: SECRET, name: SECRET, message: SECRET, stack: SECRET, status: 999 }), { errorCode: 'UNEXPECTED_ERROR' });
  assert.deepEqual(classifyDiagnosticError({ name: 'AbortError', statusCode: 429 }), { errorCode: 'CANCELLED', httpStatus: 429 });
  assert.deepEqual(classifyDiagnosticError(new SyntaxError(SECRET)), { errorCode: 'INVALID_RESPONSE' });
  assert.deepEqual(classifyDiagnosticError({ name: 'TimeoutError' }), { errorCode: 'TIMEOUT' });
  assert.deepEqual(classifyDiagnosticError(SECRET), { errorCode: 'UNEXPECTED_ERROR' });
  assert.deepEqual(classifyDiagnosticError(new Proxy({}, { getPrototypeOf() { throw new Error(SECRET); } })), { errorCode: 'UNEXPECTED_ERROR' });
});

test('bounded Core error messages yield fixed useful categories without retaining their private text', async () => {
  const directory = await fixture(); const log = await DiagnosticLog.open(directory.path);
  try {
    const cases = [
      ['模型响应超时：' + SECRET, 'TIMEOUT', undefined],
      ['任务已取消：' + SECRET, 'CANCELLED', undefined],
      ['请先配置模型连接：' + SECRET, 'CONFIGURATION_REQUIRED', undefined],
      ['File permission denied: ' + SECRET, 'PERMISSION_DENIED', undefined],
      ['Remote response HTTP 401: ' + SECRET, 'AUTH_REJECTED', 401],
      ['Remote response status code: 429 ' + SECRET, 'RATE_LIMIT', 429],
      ['Remote response HTTP/2 503: ' + SECRET, 'SERVICE_UNAVAILABLE', 503],
      ['Unknown failure: ' + SECRET, 'UNEXPECTED_ERROR', undefined],
      [SECRET + 'x'.repeat(2049) + ' HTTP 401', 'UNEXPECTED_ERROR', undefined],
    ] as const;
    for (const [message, errorCode, status] of cases) {
      const result = classifyDiagnosticError(new Error(message));
      assert.equal(result.errorCode, errorCode); assert.equal(result.httpStatus, status);
      log.record({ event: 'command.failed', command: 'startReview', ...result });
    }
    const exported = await log.exportText(); assert.ok(!exported.includes(SECRET));
    assert.deepEqual(rows(exported).map(row => row.errorCode), cases.map(item => item[1]));
    assert.deepEqual(classifyDiagnosticError({ message: 'Case number 429 ' + SECRET }), { errorCode: 'UNEXPECTED_ERROR' });
    assert.deepEqual(classifyDiagnosticError({ code: 'ENOSPC', message: 'HTTP 503 ' + SECRET }), { errorCode: 'ENOSPC', httpStatus: 503 });
  } finally { await log.close(); await directory.close(); }
});

test('logging ignores getters and hostile proxies without evaluating application data', async () => {
  const directory = await fixture(); const log = await DiagnosticLog.open(directory.path); let getterCalls = 0;
  try {
    const value = { event: 'app_ready', get command() { getterCalls++; throw new Error(SECRET); }, get payload() { getterCalls++; throw new Error(SECRET); } };
    log.record(value);
    log.record(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(SECRET); } }));
    assert.doesNotThrow(() => classifyDiagnosticError({ get code() { getterCalls++; throw new Error(SECRET); } }));
    assert.equal(getterCalls, 0); assert.equal(rows(await log.exportText()).length, 1);
  } finally { await log.close(); await directory.close(); }
});

test('queued records stay bounded and rapid progress updates are coalesced rather than retaining every update', async () => {
  const directory = await fixture(); const log = await DiagnosticLog.open(directory.path);
  try {
    for (let index = 0; index < 1000; index++) log.record({ event: 'command.started', command: 'getState', count: index });
    assert.equal(log.status().queued, DIAGNOSTIC_LOG_MAX_QUEUE); assert.equal(log.status().dropped, 1000 - DIAGNOSTIC_LOG_MAX_QUEUE);
    await log.flush();
    for (let index = 0; index < 1000; index++) log.record({ event: 'task.progress', stage: 'analyzing', count: index });
    assert.equal(log.status().queued, 1);
    const records = rows(await log.exportText()); assert.equal(records.length, DIAGNOSTIC_LOG_MAX_QUEUE + 1);
    assert.equal(records[0].count, 1000 - DIAGNOSTIC_LOG_MAX_QUEUE); assert.equal(records.at(-1)?.count, 999);
    assert.equal(log.status().queued, 0);
    for (const stage of ['queued', 'preparing', 'analyzing', 'validating', 'saving']) log.record({ event: 'task.progress', stage });
    assert.equal(log.status().queued, 5, 'Distinct progress stages must remain useful in diagnostics.');
  } finally { await log.close(); await directory.close(); }
});

test('rotation keeps four bounded files and removes only the oldest known log', async () => {
  const directory = await fixture(); await mkdir(directory.logs, { mode: 0o700 });
  const fileNames = ['app.jsonl', 'app.1.jsonl', 'app.2.jsonl', 'app.3.jsonl'];
  try {
    for (let index = 0; index < 4; index++) {
      const line = JSON.stringify({ v: 1, time: NOW, event: 'app_ready', count: index }) + '\n';
      const repeated = line.repeat(Math.floor(DIAGNOSTIC_LOG_MAX_FILE_BYTES / Buffer.byteLength(line)));
      await writeFile(join(directory.logs, fileNames[index]), repeated + '\n'.repeat(DIAGNOSTIC_LOG_MAX_FILE_BYTES - Buffer.byteLength(repeated)), { mode: 0o600 });
    }
    await writeFile(join(directory.logs, 'unrelated.txt'), 'operator file');
    const log = await DiagnosticLog.open(directory.path);
    log.record({ event: 'app_ready', count: 99 }); await log.flush();
    assert.equal(log.status().available, true); assert.equal(log.status().retainedFiles, 4);
    assert.ok(log.status().retainedBytes <= 4 * DIAGNOSTIC_LOG_MAX_FILE_BYTES);
    assert.equal(await readFile(join(directory.logs, 'unrelated.txt'), 'utf8'), 'operator file');
    for (const name of fileNames) assert.ok((await lstat(join(directory.logs, name))).size <= DIAGNOSTIC_LOG_MAX_FILE_BYTES);
    const records = rows(await log.exportText()); assert.equal(records.at(-1)?.count, 99);
    assert.ok(!records.some(row => row.count === 3)); assert.ok(records.some(row => row.count === 2));
    await log.close();
  } finally { await directory.close(); }
});

test('exports validate each complete stored row, dropping corrupt or truncated rows and stripping unknown fields', async () => {
  const directory = await fixture(); await mkdir(directory.logs, { mode: 0o700 });
  try {
    const line = (value: unknown) => JSON.stringify(value) + '\n';
    const good = { v: 1, time: NOW, event: 'command.failed', command: 'startReview', errorCode: 'TIMEOUT', payload: SECRET, stack: SECRET, url: SECRET };
    await writeFile(join(directory.logs, 'app.jsonl'), [line(good), '{not-json}\n', line({ ...good, event: SECRET }), line({ ...good, v: 2 }), line({ ...good, time: SECRET }), '{"v":1,"time":"' + NOW + '","event":"app_ready"'].join(''), { mode: 0o600 });
    const log = await DiagnosticLog.open(directory.path);
    const exported = await log.exportText(); assert.ok(!exported.includes(SECRET)); assert.equal(rows(exported).length, 1);
    assert.deepEqual(Object.keys(rows(exported)[0]).sort(), ['command', 'errorCode', 'event', 'time', 'v']);
    await log.close();
  } finally { await directory.close(); }
});

test('restart exports retained events and closing prevents late writes without throwing', async () => {
  const directory = await fixture();
  try {
    const first = await DiagnosticLog.open(directory.path); first.record({ event: 'app_start', count: 1 }); await first.close();
    first.record({ event: 'app_ready', count: 2 }); await first.flush();
    const second = await DiagnosticLog.open(directory.path); second.record({ event: 'app_start', count: 3 });
    assert.deepEqual(rows(await second.exportText()).map(row => row.count), [1, 3]);
    await second.close(); await second.close(); assert.equal(second.status().available, false);
  } finally { await directory.close(); }
});

test('oversized or non-regular existing logs disable logging without changing them', async () => {
  const directory = await fixture(); await mkdir(directory.logs, { mode: 0o700 });
  try {
    await writeFile(join(directory.logs, 'app.jsonl'), Buffer.alloc(DIAGNOSTIC_LOG_MAX_FILE_BYTES + 1), { mode: 0o600 });
    const log = await DiagnosticLog.open(directory.path); assert.equal(log.status().available, false);
    log.record({ event: 'app_ready' }); await log.flush(); assert.equal((await lstat(join(directory.logs, 'app.jsonl'))).size, DIAGNOSTIC_LOG_MAX_FILE_BYTES + 1);
    assert.equal(rows(await log.exportText()).length, 0); await log.close();
    await rm(join(directory.logs, 'app.jsonl')); await mkdir(join(directory.logs, 'app.jsonl'));
    assert.equal((await DiagnosticLog.open(directory.path)).status().available, false);
  } finally { await directory.close(); }
});

test('a write failure disables only diagnostics and exports a safe unavailable status', async () => {
  const directory = await fixture(); const log = await DiagnosticLog.open(directory.path);
  try {
    // A replaced directory is deterministic even under privileged test users.
    await rename(directory.logs, directory.logs + '-preserved'); await writeFile(directory.logs, SECRET, { mode: 0o600 });
    assert.doesNotThrow(() => log.record({ event: 'command.failed', errorCode: 'UNEXPECTED_ERROR' }));
    await assert.doesNotReject(log.flush()); assert.equal(log.status().available, false);
    const exported = await log.exportText(); assert.match(exported, /Diagnostics available: no/); assert.ok(!exported.includes(SECRET));
    await assert.doesNotReject(log.close()); assert.equal(await readFile(directory.logs, 'utf8'), SECRET);
  } finally { await directory.close(); }
});

test('diagnostic directories and files use private POSIX modes and refuse symlinks, hardlinks and broad permissions', { skip: process.platform === 'win32' }, async () => {
  const directory = await fixture(); let log: DiagnosticLog | undefined;
  try {
    log = await DiagnosticLog.open(directory.path); log.record({ event: 'app_ready' }); await log.close();
    assert.equal((await lstat(directory.logs)).mode & 0o777, 0o700);
    const file = join(directory.logs, 'app.jsonl'); assert.equal((await lstat(file)).mode & 0o777, 0o600);
    await chmod(file, 0o644); assert.equal((await DiagnosticLog.open(directory.path)).status().available, false); await chmod(file, 0o600);
    const target = join(directory.path, 'external'); await writeFile(target, SECRET, { mode: 0o600 });
    await rm(file); await symlink(target, file); assert.equal((await DiagnosticLog.open(directory.path)).status().available, false);
    await rm(file); await link(target, file); assert.equal((await DiagnosticLog.open(directory.path)).status().available, false);
    await rm(file); await chmod(directory.logs, 0o750); assert.equal((await DiagnosticLog.open(directory.path)).status().available, false);
    assert.equal(await readFile(target, 'utf8'), SECRET);
    await chmod(directory.logs, 0o700); await rm(directory.logs, { recursive: true }); await symlink(directory.path, directory.logs);
    assert.equal((await DiagnosticLog.open(directory.path)).status().available, false);
  } finally { await log?.close(); await directory.close(); }
});

test('linked or replaced log files introduced after startup are refused before append or export', { skip: process.platform === 'win32' }, async () => {
  const directory = await fixture(); const log = await DiagnosticLog.open(directory.path);
  try {
    log.record({ event: 'app_start' }); await log.flush();
    const file = join(directory.logs, 'app.jsonl'), external = join(directory.path, 'external');
    await writeFile(external, SECRET, { mode: 0o600 }); await rename(file, file + '.retained'); await symlink(external, file);
    log.record({ event: 'app_ready' }); await log.flush();
    assert.equal(log.status().available, false); assert.equal(await readFile(external, 'utf8'), SECRET); assert.ok(!(await log.exportText()).includes(SECRET));
    await log.close();
    assert.ok((await readdir(directory.logs)).includes('app.jsonl.retained'));
  } finally { await directory.close(); }
});
