const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const addonPath = process.env.LAW_AGENT_NATIVE_TEST_ADDON || path.resolve(__dirname, '../../../.local/native', `law-agent-store-${process.platform}-${process.arch}.node`);
const { NativeDatabase, WorkspaceLease } = require(addonPath);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'law-node-addon-'));
  const filename = path.join(directory, 'app.sqlite');
  const database = new NativeDatabase(filename);
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, filename, database };
}

test('actual NAPI binary preserves disk transactions, Unicode, NULL, BLOB, and SQL.js metadata shape', t => {
  const { database, filename } = fixture(t);
  database.run('CREATE TABLE records(id INTEGER PRIMARY KEY,payload,nullable);');
  database.run('INSERT INTO records VALUES(?,?,?)', JSON.stringify([1, '中文 English ไทย 😀', null]));
  database.run('INSERT INTO records VALUES(?,?,?)', JSON.stringify([2, { $blob: [0, 127, 128, 255] }, null]));
  database.run('BEGIN IMMEDIATE; UPDATE records SET payload=\'uncommitted\' WHERE id=1;');
  database.run('ROLLBACK');
  const rows = [];
  database.queryRows('SELECT id,payload,nullable FROM records ORDER BY id', '[]', row => rows.push(JSON.parse(row)));
  assert.deepEqual(rows, [{ id: 1, payload: '中文 English ไทย 😀', nullable: null }, { id: 2, payload: { $blob: [0, 127, 128, 255] }, nullable: null }]);
  assert.deepEqual(JSON.parse(database.query('SELECT COUNT(*) AS count FROM records; SELECT 0 WHERE 0;')), [{ columns: ['count'], values: [[2]] }]);
  database.flush(); database.close();
  const readonly = new NativeDatabase(filename, JSON.stringify({ readOnly: true }));
  try { assert.equal(JSON.parse(readonly.query('SELECT COUNT(*) FROM records'))[0].values[0][0], 2); }
  finally { readonly.close(); }
});

test('actual NAPI callback exceptions preserve the original JavaScript error and release the scan', t => {
  const { database } = fixture(t);
  database.run('CREATE TABLE records(id); INSERT INTO records VALUES(1),(2),(3);');
  const expected = new Error('caller stopped scanning');
  let delivered = 0;
  assert.throws(() => database.queryRows('SELECT id FROM records ORDER BY id', '[]', () => { delivered++; throw expected; }), error => error === expected);
  assert.equal(delivered, 1);
  database.run('INSERT INTO records VALUES(4)');
  assert.equal(JSON.parse(database.query('SELECT COUNT(*) FROM records'))[0].values[0][0], 4);
});

test('actual NAPI rejects reentrant mutation while a row callback borrows its connection', t => {
  const { database } = fixture(t);
  database.run('CREATE TABLE records(id); INSERT INTO records VALUES(1),(2);');
  assert.throws(() => database.queryRows('SELECT id FROM records', '[]', () => database.close()), /borrow|reference|used|mutable|lock|access/i);
  assert.equal(JSON.parse(database.query('SELECT COUNT(*) FROM records'))[0].values[0][0], 2);
  database.close(); database.close();
  assert.throws(() => database.query('SELECT 1'), /closed/);
});

test('actual NAPI bounds report explicit errors and backup cannot replace caller data', t => {
  const { directory, database } = fixture(t);
  const bounded = new NativeDatabase(path.join(directory, 'bounded.sqlite'), JSON.stringify({ maxQueryBytes: 1024, maxRowsBytes: 1024, maxRows: 2 }));
  try {
    assert.throws(() => bounded.query('SELECT hex(zeroblob(2048)) AS oversized'), /byte limit/);
    assert.throws(() => bounded.queryRows('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3', '[]', () => {}), /row limit/);
  } finally { bounded.close(); }
  const snapshot = path.join(directory, 'snapshot.sqlite');
  database.run('CREATE TABLE records(id); INSERT INTO records VALUES(5);');
  database.backup(snapshot);
  const before = fs.readFileSync(snapshot);
  assert.throws(() => database.backup(snapshot), /already exists/);
  assert.deepEqual(fs.readFileSync(snapshot), before);
});

test('native SQLite recovers a real interrupted DELETE-journal transaction on reopen', t => {
  const { filename, database } = fixture(t);
  database.run("CREATE TABLE records(id INTEGER PRIMARY KEY,payload TEXT); INSERT INTO records VALUES(1,'committed'); CREATE TABLE spill(id INTEGER PRIMARY KEY,payload BLOB); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<128) INSERT INTO spill SELECT x,zeroblob(16384) FROM n;");
  database.close();
  const child = spawnSync(process.execPath, ['-e', `
    const { NativeDatabase } = require(process.argv[1]);
    const database = new NativeDatabase(process.argv[2]);
    database.run("PRAGMA cache_size=1; BEGIN IMMEDIATE; UPDATE records SET payload='interrupted' WHERE id=1; UPDATE spill SET payload=randomblob(16384);");
    process.kill(process.pid, 'SIGKILL');
  `, addonPath, filename], { timeout: 10000, encoding: 'utf8' });
  assert.equal(child.error, undefined);
  assert.ok(child.signal === 'SIGKILL' || child.status !== 0, 'Child must terminate without committing');
  assert.equal(fs.existsSync(`${filename}-journal`), true, 'Fixture must leave a recovery journal');
  const recovered = new NativeDatabase(filename);
  try {
    assert.equal(JSON.parse(recovered.query('SELECT payload FROM records WHERE id=1'))[0].values[0][0], 'committed');
    assert.deepEqual(JSON.parse(recovered.query('PRAGMA quick_check'))[0].values, [['ok']]);
    assert.equal(fs.existsSync(`${filename}-journal`), false);
  } finally { recovered.close(); }
});

test('kernel workspace lease excludes other handles and survives process crashes without stale lock deletion', t => {
  const { directory } = fixture(t);
  const filename = path.join(directory, '.workspace-writer.lock');
  const first = new WorkspaceLease(filename);
  try { assert.throws(() => new WorkspaceLease(filename), /already open/); }
  finally { first.close(); first.close(); }
  const second = new WorkspaceLease(filename);
  try {
    const blocked = spawnSync(process.execPath, ['-e', `
      const { WorkspaceLease } = require(process.argv[1]);
      try { new WorkspaceLease(process.argv[2]); process.exit(99); }
      catch (error) { if (!/already open/.test(error.message)) throw error; }
    `, addonPath, filename], { timeout: 10000, encoding: 'utf8' });
    assert.equal(blocked.status, 0, blocked.stderr);
  } finally { second.close(); }
  const crashed = spawnSync(process.execPath, ['-e', `
    const { WorkspaceLease } = require(process.argv[1]);
    const lease = new WorkspaceLease(process.argv[2]);
    process.kill(process.pid, 'SIGKILL');
  `, addonPath, filename], { timeout: 10000, encoding: 'utf8' });
  assert.equal(crashed.error, undefined);
  assert.ok(crashed.signal === 'SIGKILL' || crashed.status !== 0);
  assert.equal(fs.existsSync(filename), true);
  const recovered = new WorkspaceLease(filename); recovered.close();
  assert.equal(fs.existsSync(filename), true);
});
