#!/usr/bin/env node
// Synthetic-only reproduction of AppStore's full-file rollback image and flush.
// Called by measure-storage-memory.mjs, not a production workspace migration.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import initSqlJs from 'sql.js';

const args = process.argv.slice(2);
assert.ok(args.length >= 1 && args.length <= 4, 'Expected <synthetic-sqljs.sqlite> [iterations=4] [page-limit=64] [hold-ms=250]');
const path = resolve(args[0]);
const iterations = Number(args[1] ?? 4);
const pageLimit = Number(args[2] ?? 64);
const holdMs = Number(args[3] ?? 250);
for (const [name, value, min, max] of [['iterations', iterations, 1, 128], ['pageLimit', pageLimit, 1, 1000], ['holdMs', holdMs, 0, 1000]]) {
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${name}`);
}
assert.equal(basename(path), 'sqljs.sqlite', 'Only the parent benchmark sqljs.sqlite target is accepted');
const directory = dirname(path);
assert.equal(await realpath(directory), directory, 'The benchmark directory must be canonical');
const markerPath = join(directory, '.storage-memory-synthetic-only.json');
const markerStat = await lstat(markerPath);
assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink(), 'Missing regular synthetic benchmark authorization');
const marker = JSON.parse(await readFile(markerPath, 'utf8'));
assert.equal(marker.format, 'law-agent-synthetic-storage-memory-v1');
assert.equal(marker.sqljsDatabase, 'sqljs.sqlite');
const inputStat = await lstat(path);
assert.ok(inputStat.isFile() && !inputStat.isSymbolicLink(), 'The synthetic database must be a regular file');
for (const suffix of ['-wal', '-shm', '-journal']) {
  const sidecar = await lstat(`${path}${suffix}`).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  assert.equal(sidecar, null, 'Only a closed, single-file synthetic database is accepted');
}

const started = performance.now();
const require = createRequire(import.meta.url);
const wasmBinary = new Uint8Array(await readFile(require.resolve('sql.js/dist/sql-wasm.wasm'))).buffer;
const SQL = await initSqlJs({ wasmBinary });
let database;
{
  const input = await readFile(path);
  database = new SQL.Database(input);
}
const scalar = (sql, params = []) => {
  const statement = database.prepare(sql);
  try { statement.bind(params); assert.ok(statement.step(), 'Expected a scalar row'); return statement.get()[0]; }
  finally { statement.free(); }
};
assert.equal(scalar('SELECT marker FROM lawcore_experiment_meta'), 'law-core-synthetic-storage-v1');
database.run('PRAGMA foreign_keys=ON');

async function flush() {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const bytes = database.export();
    database.run('PRAGMA foreign_keys=ON');
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
async function transaction(fn) {
  // This intentionally follows src/core/storage.ts, rather than optimizing away
  // the existing full-database preimage and second export during flush.
  const before = database.export();
  database.run('PRAGMA foreign_keys=ON');
  database.run('BEGIN');
  try {
    const result = fn();
    database.run('COMMIT');
    await flush();
    return result;
  } catch (error) {
    try { database.run('ROLLBACK'); } catch { /* COMMIT may already have finished. */ }
    database.close();
    const recoveredSQL = await initSqlJs({ wasmBinary: new Uint8Array(await readFile(require.resolve('sql.js/dist/sql-wasm.wasm'))).buffer });
    database = new recoveredSQL.Database(before);
    database.run('PRAGMA foreign_keys=ON');
    throw error;
  }
}
function page(afterId, limit) {
  const statement = database.prepare('SELECT id,length(CAST(payload AS BLOB)),revision,payload FROM lawcore_synthetic_rows WHERE id>? ORDER BY id LIMIT ?');
  const rows = [];
  let payloadBytes = 0;
  try {
    statement.bind([afterId, limit]);
    while (statement.step()) {
      const [id, size, revision, payload] = statement.get();
      assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 2 * 1024 * 1024, 'Stored payload exceeds native page limit');
      if (payloadBytes + size > 2 * 1024 * 1024) break;
      rows.push({ id, revision, payload });
      payloadBytes += size;
    }
  } finally { statement.free(); }
  return rows;
}
const replacement = 'Synthetic deterministic update';
let after = 0;
let rowsRead = 0;
let totalPayloadBytes = 0;
let updateRevision = 0;
try {
  for (let i = 0; i < iterations; i += 1) {
    {
      const rows = page(after, pageLimit);
      rowsRead += rows.length;
      totalPayloadBytes += rows.reduce((total, row) => total + Buffer.byteLength(row.payload, 'utf8'), 0);
      after = rows.at(-1)?.id ?? 0;
    }
    updateRevision = await transaction(() => {
      database.run('UPDATE lawcore_synthetic_rows SET payload=?,revision=revision+1 WHERE id=?', [replacement, 1]);
      assert.equal(database.getRowsModified(), 1);
      return scalar('SELECT revision FROM lawcore_synthetic_rows WHERE id=?', [1]);
    });
    await new Promise(resolve => setTimeout(resolve, holdMs));
  }
  const store = {
    synthetic: true,
    rows: scalar('SELECT COUNT(*) FROM lawcore_synthetic_rows'),
    page_size: scalar('PRAGMA page_size'), page_count: scalar('PRAGMA page_count'),
    freelist_count: scalar('PRAGMA freelist_count'),
    database_bytes: (await stat(path)).size,
    query_plan: database.exec('EXPLAIN QUERY PLAN SELECT id,payload,revision FROM lawcore_synthetic_rows WHERE id>0 ORDER BY id LIMIT 64')[0]?.values.map(row => row.at(-1)) ?? [],
  };
  // AppStore.close() also exports and flushes its current in-memory image.
  await flush();
  database.close(); database = null;
  console.log(JSON.stringify({ backend: 'sql.js-appstore-copy-pattern', experimental: true, iterations, pageLimit, rowsRead, totalPayloadBytes, updateRevision, replacementPayloadBytes: Buffer.byteLength(replacement), elapsedMs: performance.now() - started, store }));
} finally { database?.close(); }
