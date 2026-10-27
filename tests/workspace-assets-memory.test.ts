import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AppStore } from '../src/core/storage';
import { WorkspaceAssets, type WorkspaceAsset } from '../src/core/workspace-assets';

const stamp = '2026-10-26T00:00:00.000Z';
const kind = 'memory_fixture';

function version(id: string, revision: number, body: Record<string, unknown> = { name: 'Synthetic fixture' }, deleted = false): WorkspaceAsset {
  return { id, kind, revision, body, deleted, createdAt: stamp, updatedAt: stamp, actorLabel: 'Synthetic test',
    contentSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

function append(store: AppStore, asset: unknown, id: string, entityType = `workspace_asset.${kind}`, workspaceId = store.workspaceId): void {
  store.rows('INSERT INTO audit_events(id,workspace_id,entity_type,entity_id,action,actor_kind,actor_label,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [randomUUID(), workspaceId, entityType, id, 'saved', 'user', 'Synthetic test', JSON.stringify(asset), stamp]);
}

async function fixture(run: (store: AppStore, assets: WorkspaceAssets) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'law-assets-memory-'));
  const store = await AppStore.open(directory);
  try { await run(store, new WorkspaceAssets(store)); }
  finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}

/** Measure the actual row payload crossing the backend boundary. A small heap
 * reading is not evidence that an obsolete document body was never selected. */
function observeReads(store: AppStore): { sizes: number[]; restore: () => void } {
  const original = store.rows.bind(store); const sizes: number[] = [];
  store.rows = ((...args: Parameters<AppStore['rows']>) => {
    const result = original(...args);
    if (/^\s*SELECT\b/iu.test(args[0])) sizes.push(Buffer.byteLength(JSON.stringify(result)));
    return result;
  }) as AppStore['rows'];
  return { sizes, restore: () => { store.rows = original; } };
}

test('current asset lists preserve reverse first-insertion order, row-order ties and tombstones without reviving history', async () => {
  await fixture(async (store, assets) => {
    const first = randomUUID(), second = randomUUID(), third = randomUUID();
    await store.transaction(() => {
      append(store, version(first, 1), first);
      append(store, version(second, 1), second);
      append(store, version(first, 2, { name: 'Older asset, newer edit' }), first);
      append(store, version(third, 1), third);
      append(store, version(second, 2, { name: 'Deleted latest row' }, true), second);
      // Row order is authoritative even if an imported revision number ties.
      append(store, version(first, 2, { name: 'Last row wins' }), first);
    });
    assert.deepEqual(assets.list(kind).map(asset => asset.id), [third, first]);
    assert.deepEqual(assets.list(kind, true).map(asset => asset.id), [third, second, first]);
    assert.equal(assets.get(first).body.name, 'Last row wins');
    assert.equal(assets.get(second).deleted, true);
    assert.deepEqual(assets.history(first).map(asset => asset.body.name), ['Synthetic fixture', 'Older asset, newer edit', 'Last row wins']);
    const restored = await assets.save({ id: second, kind, expectedRevision: 2, body: { name: 'Restored' }, deleted: false });
    assert.equal(restored.revision, 3);
    assert.equal(restored.createdAt, stamp);
    assert.deepEqual(assets.list(kind).map(asset => asset.id), [third, second, first]);
  });
});

test('current list/get/save transfer only latest bodies while explicit history still returns every large obsolete revision', async () => {
  await fixture(async (store, assets) => {
    const id = randomUUID(); const obsolete = 'Synthetic obsolete text '.repeat(6000);
    await store.transaction(() => {
      for (let revision = 1; revision <= 40; revision++) append(store, version(id, revision, { obsolete, revision }), id);
      append(store, version(id, 41, { name: 'Small current body' }), id);
    });
    const reads = observeReads(store);
    try {
      assert.equal(assets.list(kind)[0].body.name, 'Small current body');
      assert.equal(assets.get(id).revision, 41);
      const saved = await assets.save({ id, kind, expectedRevision: 41, body: { name: 'Small next body' } });
      assert.equal(saved.revision, 42);
      const created = await assets.save({ kind, expectedRevision: 0, body: { name: 'Independent new asset' } });
      assert.equal(created.revision, 1);
      assert.ok(reads.sizes.length >= 5);
      assert.ok(reads.sizes.every(size => size < 4096), `Obsolete bodies crossed the backend boundary: ${reads.sizes}`);
    } finally { reads.restore(); }
    const history = assets.history(id);
    assert.equal(history.length, 42);
    assert.equal(history[0].body.obsolete, obsolete);
    assert.equal(history[39].body.revision, 40);
    assert.equal(history[41].body.name, 'Small next body');
  });
});

test('CAS checks stay on the shared write queue and append only one winner without reading full history', async () => {
  await fixture(async (_store, assets) => {
    const original = await assets.save({ kind, expectedRevision: 0, body: { name: 'Original' } });
    let checks = 0;
    const results = await Promise.allSettled([
      assets.save({ id: original.id, kind, expectedRevision: 1, body: { name: 'First writer' } }, () => { checks++; }),
      assets.save({ id: original.id, kind, expectedRevision: 1, body: { name: 'Stale writer' } }, () => { checks++; }),
    ]);
    assert.equal(checks, 2);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(assets.get(original.id).body.name, 'First writer');
    assert.deepEqual(assets.history(original.id).map(asset => asset.revision), [1, 2]);
  });
});

test('latest lookups and explicit history enforce workspace and literal asset-type boundaries', async () => {
  await fixture(async (store, assets) => {
    const id = randomUUID(), foreignId = randomUUID(), unrelatedId = randomUUID(), foreignWorkspace = randomUUID();
    await store.transaction(() => {
      store.rows('INSERT INTO workspaces(id,name,company_name,created_at,updated_at) VALUES(?,?,?,?,?)', [foreignWorkspace, 'Synthetic other workspace', null, stamp, stamp]);
      append(store, version(id, 1, { name: 'Authorized' }), id);
      append(store, version(id, 100, { name: 'Other workspace' }), id, undefined, foreignWorkspace);
      append(store, version(id, 101, { name: 'Underscore wildcard impostor' }), id, `workspaceXasset.${kind}`);
      append(store, version(foreignId, 1), foreignId, undefined, foreignWorkspace);
      append(store, version(unrelatedId, 1), unrelatedId, `workspaceXasset.${kind}`);
    });
    assert.equal(assets.get(id).body.name, 'Authorized');
    assert.equal(assets.history(id).length, 1);
    assert.deepEqual(assets.list(kind).map(asset => asset.id), [id]);
    assert.throws(() => assets.get(foreignId), /不存在/);
    assert.throws(() => assets.get(unrelatedId), /不存在/);
    assert.throws(() => assets.get("' OR 1=1 --"));
    assert.throws(() => assets.list("memory_fixture' OR 1=1 --"));
    await assert.rejects(assets.save({ id, kind: 'other_kind', expectedRevision: 1, body: {} }), /不能改变资源类型/);
    assert.equal(assets.history(id).length, 1);
  });
});

test('corrupt current envelopes fail explicitly instead of exposing or overwriting an older valid revision', async () => {
  await fixture(async (store, assets) => {
    const corruptions = [
      (_id: string) => [],
      (id: string) => ({ ...version(id, 2), id: randomUUID() }),
      (id: string) => ({ ...version(id, 2), kind: 'other_kind' }),
      (id: string) => ({ ...version(id, 2), revision: '2' }),
      (id: string) => ({ ...version(id, 2), deleted: 0 }),
      (id: string) => ({ ...version(id, 2), body: null }),
    ];
    for (const corruption of corruptions) {
      const id = randomUUID();
      await store.transaction(() => { append(store, version(id, 1), id); append(store, corruption(id), id); });
      assert.throws(() => assets.get(id), /记录损坏/);
      assert.throws(() => assets.list(kind), /记录损坏/);
      await assert.rejects(assets.save({ id, kind, expectedRevision: 1, body: { name: 'Must not overwrite' } }), /记录损坏/);
      assert.equal(Number(store.rows('SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id=? AND entity_id=?', [store.workspaceId, id])[0].count), 2);
    }
  });
});

test('history and active-resource limits count SQL rows and latest tombstones while retaining existing validation', async () => {
  await fixture(async (store, assets) => {
    const cappedId = randomUUID();
    await store.transaction(() => {
      for (let revision = 1; revision <= 1000; revision++) append(store, version(cappedId, revision), cappedId);
    });
    await assert.rejects(assets.save({ id: cappedId, kind, expectedRevision: 1000, body: {} }), /1000版上限/);
    const removedId = randomUUID(); const capacityKind = 'capacity_fixture';
    await store.transaction(() => {
      for (let index = 0; index < 10000; index++) {
        const id = index ? randomUUID() : removedId;
        append(store, { ...version(id, 1), kind: capacityKind }, id, `workspace_asset.${capacityKind}`);
      }
    });
    const reads = observeReads(store);
    try {
      await assert.rejects(assets.save({ kind: capacityKind, expectedRevision: 0, body: {} }), /工作空间上限/);
      await assets.save({ id: removedId, kind: capacityKind, expectedRevision: 1, body: {}, deleted: true });
      const created = await assets.save({ kind: capacityKind, expectedRevision: 0, body: {} });
      assert.equal(created.revision, 1);
      assert.ok(reads.sizes.every(size => size < 4096), 'Capacity checks must not transfer all asset bodies.');
    } finally { reads.restore(); }
    await assert.rejects(assets.save({ kind, expectedRevision: 0, body: {}, actorLabel: 'bad\nlabel' }), /记录人标签/);
    await assert.rejects(assets.save({ kind, expectedRevision: 0, body: { value: 'x'.repeat(2 * 1024 ** 2) } }), /2 MiB/);
    const report = await assets.save({ kind: 'report_export', expectedRevision: 0, body: { name: 'Frozen report' } });
    await assert.rejects(assets.save({ id: report.id, kind: 'report_export', expectedRevision: 1, body: {} }), /只能新增/);
  });
});
