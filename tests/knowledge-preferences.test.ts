import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { LocalKnowledgeIndex, matchesKnowledgeDirectory } from '../src/core/knowledge-index';
import { defaultKnowledgePreferences, intersectKnowledgePreferences } from '../src/shared/knowledge-preferences';
import type { KnowledgePreferences } from '../src/shared/knowledge';
import { createDocx } from './fixtures-documents';

async function fixture(t: test.TestContext): Promise<{ folder: string; data: string; index: LocalKnowledgeIndex }> {
  const base = await mkdtemp(join(tmpdir(), 'law-knowledge-prefs-')); const folder = join(base, 'sources'); const data = join(base, 'app');
  await mkdir(folder); const index = new LocalKnowledgeIndex(data);
  t.after(async () => { await index.close(); await rm(base, { recursive: true, force: true }); });
  return { folder, data, index };
}
const sync = (index: LocalKnowledgeIndex, folderPath: string, preferences?: KnowledgePreferences) => index.syncFolder({ folderPath, jobId: randomUUID(), mode: 'incremental', preferences }, new AbortController().signal);
const prefs = (partial: Partial<KnowledgePreferences>): KnowledgePreferences => ({ ...defaultKnowledgePreferences(), ...partial });

test('saved directory/type restrictions immediately block search and existing chunk reads', async t => {
  const { index, folder } = await fixture(t);
  await mkdir(join(folder, 'archive')); await mkdir(join(folder, 'archive2'));
  await writeFile(join(folder, 'archive', 'private.txt'), '付款验收档案条款。');
  await writeFile(join(folder, 'archive2', 'visible.txt'), '付款验收现行条款。');
  await writeFile(join(folder, 'visible.docx'), await createDocx({ paragraphs: ['付款验收 Word 制度。'] }));
  await sync(index, folder);
  const all = await index.search({ folderPath: folder, query: '付款验收', limit: 10 }); assert.equal(all.hits.length, 3);
  const archived = all.hits.find(hit => hit.relativePath.includes('private.txt'))!;
  const document = all.hits.find(hit => hit.relativePath.endsWith('.docx'))!;
  const restrictions = prefs({ excludeDirectories: ['archive'], fileTypes: ['txt'] });
  const narrowed = await index.search({ folderPath: folder, query: '付款验收', preferences: restrictions, limit: 10 });
  assert.equal(narrowed.hits.length, 1); assert.match(narrowed.hits[0]!.relativePath, /archive2/);
  await assert.rejects(index.readChunk({ folderPath: folder, chunkId: archived.chunkId, preferences: restrictions }), /配置排除/);
  await assert.rejects(index.readChunk({ folderPath: folder, chunkId: document.chunkId, preferences: restrictions }), /配置排除/);
  assert.equal(narrowed.state.indexedFiles, 3); assert.equal(narrowed.state.staleFiles, 0); assert.equal(narrowed.state.needsSync, true);
  assert.ok(narrowed.state.limitations.some(note => note.includes('已存储索引')));
  const job = await sync(index, folder, restrictions); assert.equal(job.status, 'completed'); assert.equal(job.deleted, 2); assert.equal(job.unchanged, 1);
  assert.deepEqual(job.preferences, restrictions);
  assert.equal((await index.getState(folder, restrictions)).indexedFiles, 1); assert.equal((await index.getState(folder, restrictions)).needsSync, false);
});

test('relative directory boundaries include nested folders, normalize separators, and honor Windows case', () => {
  assert.equal(matchesKnowledgeDirectory('Archive/old/item.txt', 'archive', true), true);
  assert.equal(matchesKnowledgeDirectory('Archive\\old\\item.txt', 'archive\\old', true), true);
  assert.equal(matchesKnowledgeDirectory('archive2/item.txt', 'archive', true), false);
  assert.equal(matchesKnowledgeDirectory('other/archive/item.txt', 'archive', true), false);
  assert.equal(matchesKnowledgeDirectory('archive/older/item.txt', 'archive/old', true), false);
  assert.equal(matchesKnowledgeDirectory('Archive/item.txt', 'archive', false), false);
});

test('directory exclusions apply before candidate LIMIT, without excluding a matching file name', async t => {
  const { index, folder } = await fixture(t);
  await mkdir(join(folder, 'blocked'));
  await Promise.all(Array.from({ length: 270 }, (_, i) => writeFile(join(folder, 'blocked', `${i}.txt`), '付款')));
  await writeFile(join(folder, 'allowed.txt'), '付款仍须有经办人和法务确认才能执行。');
  // 排除项指目录，不能把根下同名普通文件误当作被排除目录。
  await writeFile(join(folder, 'blocked.txt'), '付款同名普通文件。');
  await sync(index, folder);
  const preferences = prefs({ excludeDirectories: ['blocked', 'blocked.txt'] });
  const result = await index.search({ folderPath: folder, query: '付款', limit: 10, preferences });
  assert.equal(result.hits.length, 2); assert.ok(result.hits.some(hit => hit.relativePath === 'allowed.txt')); assert.ok(result.hits.some(hit => hit.relativePath === 'blocked.txt'));
});

test('file-size tightening is immediate, preserves stored versions on sync failure, and validates actual source size', async t => {
  const { index, folder } = await fixture(t);
  await writeFile(join(folder, 'large.txt'), `付款合同条款\n${'x'.repeat(1024 * 1024)}`);
  await writeFile(join(folder, 'small.txt'), '付款小型有效制度。');
  await sync(index, folder);
  const largeHit = (await index.search({ folderPath: folder, query: '付款', limit: 10 })).hits.find(hit => hit.relativePath === 'large.txt')!;
  assert.ok(largeHit);
  const restricted = prefs({ maxFileSizeMb: 1 });
  const result = await index.search({ folderPath: folder, query: '付款', limit: 10, preferences: restricted });
  assert.deepEqual(result.hits.map(hit => hit.relativePath), ['small.txt']); assert.equal(result.state.staleFiles, 0);
  await assert.rejects(index.readChunk({ folderPath: folder, chunkId: largeHit.chunkId, preferences: restricted }), /配置排除/);
  const job = await sync(index, folder, restricted); assert.equal(job.status, 'partial'); assert.equal(job.deleted, 0); assert.equal(job.failed, 1); assert.match(job.errors[0]!.message, /1 MiB/);
  const state = await index.getState(folder, restricted); assert.equal(state.indexedFiles, 2); assert.equal(state.needsSync, true);
  await sync(index, folder); // 放宽范围可复用原来的内容相同版本。
  assert.equal((await index.readChunk({ folderPath: folder, chunkId: largeHit.chunkId })).versionId, largeHit.versionId);
  const smallHit = (await index.search({ folderPath: folder, query: '付款', preferences: restricted })).hits[0]!;
  await writeFile(join(folder, 'small.txt'), `付款已增长\n${'y'.repeat(1024 * 1024)}`);
  assert.equal((await index.search({ folderPath: folder, query: '付款', preferences: restricted })).hits.length, 0);
  await assert.rejects(index.readChunk({ folderPath: folder, chunkId: smallHit.chunkId, preferences: restricted }), /大小配置/);
});

test('scope expansion requests sync, while cosmetic and scheduling changes do not', async t => {
  const { index, folder } = await fixture(t);
  await mkdir(join(folder, 'later')); await writeFile(join(folder, 'later', 'hidden.txt'), '付款范围扩张后的资料。'); await writeFile(join(folder, 'root.txt'), '付款原有资料。');
  const original = prefs({ fileTypes: ['txt'], excludeDirectories: ['later'] });
  await sync(index, folder, original);
  assert.equal((await index.getState(folder, original)).needsSync, false);
  const renamed = { ...original, displayName: '公司制度', autoSyncEnabled: false, syncIntervalMinutes: 30 };
  assert.equal((await index.getState(folder, renamed)).needsSync, false);
  const expanded = prefs({ fileTypes: ['txt'] });
  const before = await index.getState(folder, expanded); assert.equal(before.needsSync, true); assert.ok(before.limitations.some(note => note.includes('扩大范围')));
  assert.equal((await index.search({ folderPath: folder, query: '付款', preferences: expanded, limit: 10 })).hits.length, 1);
  const job = await sync(index, folder, expanded); assert.equal(job.indexed, 1); assert.equal(job.unchanged, 1);
  assert.equal((await index.getState(folder, expanded)).needsSync, false); assert.equal((await index.search({ folderPath: folder, query: '付款', preferences: expanded, limit: 10 })).hits.length, 2);
});

test('sync snapshots preferences and legacy jobs without preferences compare against defaults', async t => {
  const { index, folder, data } = await fixture(t);
  await writeFile(join(folder, 'terms.txt'), '付款合同制度。');
  const original = defaultKnowledgePreferences();
  const job = await index.syncFolder({ folderPath: folder, jobId: randomUUID(), mode: 'incremental', preferences: original }, new AbortController().signal, update => {
    if (update.scanned === 0) { original.fileTypes.splice(0); original.excludeDirectories.push('new'); if (update.preferences) update.preferences.fileTypes.splice(0); }
  });
  assert.equal(job.indexed, 1); assert.deepEqual(job.preferences, defaultKnowledgePreferences());
  const db = new DatabaseSync(join(data, 'local-knowledge', 'index.sqlite'));
  try {
    const legacy = { ...job }; delete legacy.preferences; db.prepare('UPDATE sync_jobs SET job_json=? WHERE id=?').run(JSON.stringify(legacy), job.id);
  } finally { db.close(); }
  assert.equal((await index.getState(folder)).needsSync, false); assert.equal((await index.search({ folderPath: folder, query: '付款' })).hits.length, 1);
  const disjoint = intersectKnowledgePreferences(prefs({ fileTypes: ['txt'] }), prefs({ fileTypes: ['pdf'] }));
  assert.equal((await index.search({ folderPath: folder, query: '付款', preferences: disjoint })).hits.length, 0);
});

test('internal intersection keeps all 32+32 exclusion directories while allowing eligible sources', async t => {
  const { index, folder } = await fixture(t);
  await mkdir(join(folder, 'a0')); await mkdir(join(folder, 'b31'));
  await writeFile(join(folder, 'a0', 'old.txt'), '付款旧快照排除资料。');
  await writeFile(join(folder, 'b31', 'new.txt'), '付款当前配置末项排除资料。');
  await writeFile(join(folder, 'allowed.txt'), '付款始终允许资料。');
  await sync(index, folder);
  const intersection = intersectKnowledgePreferences(
    prefs({ excludeDirectories: Array.from({ length: 32 }, (_, i) => `a${i}`) }),
    prefs({ excludeDirectories: Array.from({ length: 32 }, (_, i) => `b${i}`) }),
  );
  assert.equal(intersection.excludeDirectories.length, 64);
  const result = await index.search({ folderPath: folder, query: '付款', preferences: intersection, limit: 10 });
  assert.deepEqual(result.hits.map(hit => hit.relativePath), ['allowed.txt']);
  const job = await sync(index, folder, intersection); assert.equal(job.status, 'completed'); assert.equal(job.deleted, 2); assert.equal(job.preferences?.excludeDirectories.length, 64);
  assert.equal((await index.getState(folder, intersection)).needsSync, false);
  assert.equal((await index.readChunk({ folderPath: folder, chunkId: result.hits[0]!.chunkId, preferences: intersection })).relativePath, 'allowed.txt');
});
