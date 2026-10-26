import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppStore } from '../src/core/storage';
import { openNativeDatabase } from '../src/core/storage-backend';

const nativeOnly = { skip: process.env.LAW_AGENT_STORAGE_BACKEND === 'sqljs' };

test('native startup rolls back every seed mutation when its rule version fails, then remains recoverable', nativeOnly, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-native-seed-failure-'));
  let store: AppStore | undefined;
  try {
    store = await AppStore.open(directory); const workspaceId = store.workspaceId; await store.close(); store = undefined;
    let database = openNativeDatabase(join(directory, 'workspace.sqlite'));
    try { database.run("DELETE FROM rule_set_versions;DELETE FROM rule_sets;DELETE FROM provider_profiles;CREATE TRIGGER synthetic_seed_fault BEFORE INSERT ON rule_set_versions BEGIN SELECT RAISE(ABORT,'synthetic seed fault'); END;"); }
    finally { database.close(); }
    await assert.rejects(AppStore.open(directory), /synthetic seed fault/);
    database = openNativeDatabase(join(directory, 'workspace.sqlite'));
    try {
      assert.equal(database.all('SELECT COUNT(*) AS n FROM rule_sets')[0].n, 0);
      assert.equal(database.all('SELECT COUNT(*) AS n FROM rule_set_versions')[0].n, 0);
      assert.equal(database.all('SELECT id FROM workspaces')[0].id, workspaceId);
      database.run('DROP TRIGGER synthetic_seed_fault');
    } finally { database.close(); }
    store = await AppStore.open(directory);
    assert.equal(store.workspaceId, workspaceId);
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM rule_sets')[0].n, 1);
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM rule_set_versions')[0].n, 1);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('concurrent native transactions keep independent writes and close waits for queued commits', nativeOnly, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-native-transaction-queue-'));
  let store: AppStore | undefined;
  try {
    store = await AppStore.open(directory); const owner = store; const ids = [randomUUID(), randomUUID()];
    const stamp = new Date().toISOString();
    const writes = ids.map((id, index) => owner.transaction(() => owner.rows('INSERT INTO projects(id,workspace_id,name,created_at,updated_at) VALUES(?,?,?,?,?)', [id, owner.workspaceId, `Synthetic queued project ${index}`, stamp, stamp])));
    const close = owner.close();
    await Promise.all(writes); await close; store = undefined;
    store = await AppStore.open(directory);
    assert.deepEqual(store.rows('SELECT id FROM projects WHERE id IN (?,?) ORDER BY id', ids).map(row => row.id), [...ids].sort());
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
});
