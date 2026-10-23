import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runEnvironmentProbe } from '../src/core/setup-environment';

test('environment probe exercises writable disk, FTS5 and ICU without modifying saved data', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-setup-environment-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const indexDir = join(dataDir, 'local-knowledge'); await mkdir(indexDir);
  const indexPath = join(indexDir, 'index.sqlite');
  const database = new DatabaseSync(indexPath);
  database.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('existing index must remain unchanged')");
  database.close();
  const indexBefore = await readFile(indexPath);
  const workspacePath = join(dataDir, 'workspace.sqlite');
  const workspaceBefore = Buffer.from('synthetic saved workspace marker');
  await writeFile(workspacePath, workspaceBefore);
  const entriesBefore = (await readdir(dataDir)).sort();

  const report = await runEnvironmentProbe(dataDir);
  assert.equal(report.isPreview, false);
  assert.equal(report.ready, true, JSON.stringify(report));
  assert.ok(Number.isFinite(Date.parse(report.checkedAt)));
  for (const id of ['runtime', 'storage', 'fts5', 'languages'] as const) {
    const check = report.checks.find(item => item.id === id);
    assert.equal(check?.status, 'passed', JSON.stringify(report));
    assert.ok(check?.label && check.message);
  }
  assert.equal(new Set(report.checks.map(item => item.id)).size, report.checks.length);
  assert.deepEqual(await readFile(indexPath), indexBefore);
  assert.deepEqual(await readFile(workspacePath), workspaceBefore);
  assert.deepEqual((await readdir(dataDir)).sort(), [...new Set([...entriesBefore, 'documents', 'exports'])].sort(), 'Only application directories may remain after the probe');
  assert.deepEqual(await readdir(join(dataDir, 'documents')), []);
  assert.deepEqual(await readdir(join(dataDir, 'exports')), []);
  assert.deepEqual(await readdir(indexDir), ['index.sqlite'], 'Temporary SQLite/WAL files must be cleaned up');
});

test('unwritable storage target reports failure instead of a successful environment', async t => {
  const base = await mkdtemp(join(tmpdir(), 'law-setup-invalid-storage-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  // A regular file used as the data directory fails portably, unlike chmod
  // permissions which behave differently for elevated processes and Windows.
  const notDirectory = join(base, 'ordinary-file');
  const marker = Buffer.from('synthetic source that must not be overwritten');
  await writeFile(notDirectory, marker);
  const report = await runEnvironmentProbe(notDirectory);
  assert.equal(report.isPreview, false);
  assert.equal(report.ready, false);
  assert.equal(report.checks.find(item => item.id === 'storage')?.status, 'failed', JSON.stringify(report));
  assert.ok(report.checks.some(item => item.status === 'failed'));
  assert.deepEqual(await readFile(notDirectory), marker);
  assert.deepEqual(await readdir(base), ['ordinary-file']);
});
