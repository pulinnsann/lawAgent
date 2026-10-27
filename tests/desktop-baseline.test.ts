import test from 'node:test';
import assert from 'node:assert/strict';

interface ProcessRow { pid: number; parentPid: number; name: string; workingSetBytes: number | null; createdAt: string | null }
const collector = await import(new URL('../scripts/collect-desktop-baseline.mjs', import.meta.url).href) as {
  parseProcessSnapshot: (os: string, stdout: string) => ProcessRow[];
  selectOwnedProcesses: (rows: ProcessRow[], root: Pick<ProcessRow, 'pid' | 'createdAt'>, previous?: Array<Pick<ProcessRow, 'pid' | 'createdAt'>>) => { rootAlive: boolean; rootIdentityChanged: boolean; processes: ProcessRow[]; processLimitReached: boolean };
  normalizeBaselineOptions: (input: Record<string, unknown>) => { pid: number; durationSeconds: number; intervalMs: number; output: string };
};
const { parseProcessSnapshot, selectOwnedProcesses, normalizeBaselineOptions } = collector;
const at = (second: number) => new Date(Date.UTC(2026, 9, 27, 10, 0, second)).toISOString();
const row = (pid: number, parentPid: number, createdAt = at(0)): ProcessRow => ({ pid, parentPid, createdAt, name: 'synthetic', workingSetBytes: 1024 });

test('Unix process parsing converts RSS KiB once and retains creation identity without executable paths', () => {
  const values = parseProcessSnapshot('darwin', ' 10 1 123 Mon Oct 26 10:01:02 2026 /Applications/Contract Workbench.app/Contents/MacOS/law-agent-desktop\n 11 10 - Mon Oct 26 10:01:03 2026 /private/synthetic/node\n');
  assert.equal(values[0].workingSetBytes, 123 * 1024); assert.equal(values[0].name, 'law-agent-desktop'); assert.equal(values[0].createdAt, 'Mon Oct 26 10:01:02 2026'); assert.equal(values[1].workingSetBytes, null);
  assert.ok(!JSON.stringify(values).includes('/Applications')); assert.ok(!JSON.stringify(values).includes('/private'));
  assert.equal(parseProcessSnapshot('linux', '10 1 10 Mon Oct 26 10:01:02 2026 node')[0].workingSetBytes, 10240);
  assert.throws(() => parseProcessSnapshot('linux', 'pid malformed'), /INVALID_PROCESS_SNAPSHOT/);
});

test('Windows CIM bytes stay bytes and null, zero or unavailable working sets never become measured zero', () => {
  const input = [{ pid: 100, parentPid: 50, name: 'C:\\Users\\synthetic\\law-agent-desktop.exe', workingSetBytes: '123456', createdAt: at(0), CommandLine: 'private argument', UserName: 'synthetic-user' }, { pid: 101, parentPid: 100, name: 'node.exe', workingSetBytes: null, createdAt: at(1) }, { pid: 102, parentPid: 100, name: 'msedgewebview2.exe', workingSetBytes: '0', createdAt: at(2) }];
  const values = parseProcessSnapshot('win32', '\uFEFF' + JSON.stringify(input));
  assert.equal(values[0].workingSetBytes, 123456); assert.equal(values[0].name, 'law-agent-desktop.exe'); assert.equal(values[1].workingSetBytes, null); assert.equal(values[2].workingSetBytes, null);
  assert.doesNotMatch(JSON.stringify(values), /private argument|synthetic-user|Users/);
  assert.equal(parseProcessSnapshot('win32', JSON.stringify(input[0])).length, 1, 'single-process PowerShell JSON objects are supported');
  assert.throws(() => parseProcessSnapshot('win32', 'not-json'), /INVALID_PROCESS_SNAPSHOT/);
  assert.throws(() => parseProcessSnapshot('win32', '[]'), /INVALID_PROCESS_SNAPSHOT/);
});

test('process-tree attribution excludes unrelated WebViews and tracks observed children after reparenting', () => {
  const root = row(10, 1, at(0)); const child = row(11, 10, at(1)); const grandchild = row(12, 11, at(2)); const unrelated = { ...row(99, 1, at(3)), name: 'msedgewebview2.exe' };
  const first = selectOwnedProcesses([root, child, grandchild, unrelated], root);
  assert.equal(first.rootAlive, true); assert.deepEqual(first.processes.map(value => value.pid), [10, 11, 12]);
  const next = selectOwnedProcesses([root, { ...child, parentPid: 1 }, grandchild, unrelated], root, first.processes);
  assert.deepEqual(next.processes.map(value => value.pid), [10, 11, 12]);
});

test('PID reuse and impossible parent creation order cannot attach an unrelated process', () => {
  const root = row(10, 1, at(5)); const oldChild = row(11, 10, at(6));
  const reused = selectOwnedProcesses([root, row(11, 1, at(9)), row(12, 10, at(1))], root, [root, oldChild]);
  assert.deepEqual(reused.processes.map(value => value.pid), [10]);
  const replaced = selectOwnedProcesses([row(10, 1, at(10))], root, [root, oldChild]);
  assert.equal(replaced.rootAlive, false); assert.equal(replaced.rootIdentityChanged, true); assert.deepEqual(replaced.processes, []);
  const exited = selectOwnedProcesses([row(99, 1)], root); assert.equal(exited.rootAlive, false); assert.equal(exited.rootIdentityChanged, false);
});

test('process output and collection duration have explicit bounds rather than unlimited sampling', () => {
  const root = row(1, 0); const selected = selectOwnedProcesses([root, ...Array.from({ length: 150 }, (_, index) => row(index + 2, 1, at(1)))], root);
  assert.equal(selected.processLimitReached, true); assert.equal(selected.processes.length, 128);
  assert.equal(normalizeBaselineOptions({ pid: '123', durationSeconds: '1800', intervalMs: '250' }).durationSeconds, 1800);
  for (const patch of [{ pid: 0 }, { pid: -1 }, { pid: 'arbitrary' }, { durationSeconds: 1801 }, { durationSeconds: 0 }, { intervalMs: 249 }, { intervalMs: 10001 }]) assert.throws(() => normalizeBaselineOptions({ pid: 123, ...patch }), /INVALID_BASELINE_OPTIONS/);
});
