import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocxChangeInspector, type DocxChangeInspection } from '../src/core/docx-change-inspector';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { createDocx } from './fixtures-documents';

async function fixture(run: (root: string, input: { documentId: string; artifact: { artifactUri: string; sha256: string; byteSize: number }; editableCopy: boolean }, bytes: Buffer) => Promise<void>, protectedCopy = false) {
  const root = await mkdtemp(join(tmpdir(), 'law-change-inspection-'));
  try {
    await mkdir(join(root, 'documents'));
    const bytes = await createDocx({ paragraphs: ['双方应先完成书面验收，再按照合同约定付款。'], ...(protectedCopy ? { extraFiles: { 'word/settings.xml': '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:documentProtection w:edit="readOnly" w:enforcement="1"/></w:settings>' } } : {}) });
    const input = { documentId: 'synthetic-version-1', artifact: { artifactUri: 'documents/source.docx', sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length }, editableCopy: false };
    await writeFile(join(root, input.artifact.artifactUri), bytes);
    await run(root, input, bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const metadata = (): DocxChangeInspection => ({ protection: { kind: 'none', canCreateEditableCopy: false, reason: null }, targets: [], warnings: [] });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('repeated source inspection reuses compact metadata and hashes the actual file on every hit', () => fixture(async (root, input) => {
  const inspector = new DocxChangeInspector(root);
  try {
    const first = await inspector.inspect(input); const second = await inspector.inspect(input);
    assert.deepEqual(second, first); assert.equal(first.targets[0].editable, true);
    assert.equal('text' in first.targets[0], false, 'paragraph text is reconstructed from the current stored block, not retained in cache');
    assert.match(first.targets[0].textSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual({ builds: inspector.stats().builds, reads: inspector.stats().sourceReads, verifies: inspector.stats().sourceVerifications }, { builds: 1, reads: 1, verifies: 1 });
    assert.ok(inspector.stats().metadataBytes > 0 && inspector.stats().metadataBytes <= 1024 * 1024);
    first.targets[0].editable = false; first.warnings.push('Caller mutation');
    const third = await inspector.inspect(input); assert.equal(third.targets[0].editable, true); assert.deepEqual(third.warnings, []);
  } finally { await inspector.close(); assert.equal(inspector.stats().cachedEntries, 0); }
}));

test('a warm cache never trusts restored timestamps or serves stale metadata after source tampering', () => fixture(async (root, input, bytes) => {
  const inspector = new DocxChangeInspector(root); const path = join(root, input.artifact.artifactUri);
  try {
    await inspector.inspect(input); const before = await stat(path); const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    await writeFile(path, changed); await utimes(path, before.atime, before.mtime);
    await assert.rejects(inspector.inspect(input), /原件.*不一致|原件.*变化/u); assert.equal(inspector.stats().cachedEntries, 0);
    await writeFile(path, bytes); await inspector.inspect(input); assert.equal(inspector.stats().builds, 2);
  } finally { await inspector.close(); }
}));

test('version identity and explicit editable-copy mode replace the single entry and preserve original bytes', () => fixture(async (root, input, bytes) => {
  const inspector = new DocxChangeInspector(root);
  try {
    const locked = await inspector.inspect(input); assert.equal(locked.protection.canCreateEditableCopy, true); assert.equal(locked.targets[0].editable, false);
    const editable = await inspector.inspect({ ...input, editableCopy: true }); assert.equal(editable.targets[0].editable, true); assert.ok(editable.warnings.length);
    await inspector.inspect({ ...input, documentId: 'synthetic-version-2', editableCopy: true });
    assert.equal(inspector.stats().cachedEntries, 1); assert.equal(inspector.stats().builds, 3);
    assert.deepEqual(await readFile(join(root, input.artifact.artifactUri)), bytes);
  } finally { await inspector.close(); }
}, true));

test('oversized metadata is returned for the current operation without being retained', () => fixture(async (root, input) => {
  const inspector = new DocxChangeInspector(root, { maxMetadataBytes: 1 });
  try { assert.ok((await inspector.inspect(input)).targets.length); await inspector.inspect(input); assert.equal(inspector.stats().cachedEntries, 0); assert.equal(inspector.stats().metadataBytes, 0); assert.equal(inspector.stats().builds, 2); }
  finally { await inspector.close(); }
}));

test('idle expiry evicts metadata and the next operation rebuilds from a verified source', () => fixture(async (root, input) => {
  const inspector = new DocxChangeInspector(root, { idleMs: 20 });
  try { await inspector.inspect(input); for (let i = 0; i < 100 && inspector.stats().cachedEntries; i++) await delay(5); assert.equal(inspector.stats().cachedEntries, 0); await inspector.inspect(input); assert.equal(inspector.stats().builds, 2); }
  finally { await inspector.close(); }
}));

test('concurrent cold inspections share serialized work and subsequent calls freshly verify the source', () => fixture(async (root, input) => {
  let active = 0; let peak = 0;
  const inspector = new DocxChangeInspector(root, { inspectBytes: async () => { active++; peak = Math.max(peak, active); await delay(10); active--; return metadata(); } });
  try { await Promise.all(Array.from({ length: 4 }, () => inspector.inspect(input))); assert.equal(peak, 1); assert.equal(inspector.stats().builds, 1); assert.equal(inspector.stats().sourceVerifications, 3); assert.equal(inspector.stats().pending, 0); }
  finally { await inspector.close(); }
}));

test('the inspection queue is bounded and close waits for actual parsing then rejects late publication', () => fixture(async (root, input) => {
  let finish!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }); const held = new Promise<void>(resolve => { finish = resolve; });
  const inspector = new DocxChangeInspector(root, { maxPending: 2, inspectBytes: async () => { started(); await held; return metadata(); } });
  const first = inspector.inspect(input); await entered; const second = inspector.inspect(input);
  const settled = Promise.allSettled([first, second]);
  await assert.rejects(inspector.inspect(input), /队列已满/u);
  let closed = false; const closing = inspector.close().then(() => { closed = true; });
  await delay(5); assert.equal(closed, false); finish(); await closing;
  assert.ok((await settled).every(result => result.status === 'rejected')); assert.equal(inspector.stats().cachedEntries, 0);
  await assert.rejects(inspector.inspect(input), /关闭/u); await inspector.close();
}));

test('human change decisions reuse only inspection metadata and read fresh revisions and export history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'law-change-workspace-memory-')); const output = await mkdtemp(join(tmpdir(), 'law-change-workspace-export-')); const store = await AppStore.open(root); const inspector = new DocxChangeInspector(root);
  const service = new ContractService(store, root, undefined, undefined, undefined, { docxInspector: inspector });
  try {
    const document = await service.loadSample(); const task = await service.startReview({ documentId: document.id, mode: 'local', context: { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: 'Synthetic engineering fixture.' } }, null);
    let reviewId: string | null = null;
    for (let i = 0; i < 200; i++) { const state = service.getState(); const found = state.tasks.find(item => item.id === task.taskId); if (found?.status === 'failed') assert.fail(found.error ?? 'Review failed'); if (found?.resultId) { reviewId = found.resultId; break; } await delay(5); }
    assert.ok(reviewId);
    const initial = await service.getChanges(reviewId); const target = initial.targets.find(item => item.editable && item.editMode !== 'segments')!; assert.ok(target);
    initial.targets[0].text = 'Caller mutation must not poison a later workspace';
    let workspace = await service.saveChange({ reviewId, findingId: null, blockId: target.blockId, expectedRevision: initial.revision, replacementText: `${target.text}（合成测试）` });
    assert.equal(workspace.revision, initial.revision + 1); assert.equal(workspace.proposals.length, 1);
    workspace = await service.decideChange({ reviewId, proposalId: workspace.proposals[0].id, expectedRevision: workspace.revision, status: 'accepted' });
    assert.equal(workspace.proposals[0].status, 'accepted'); assert.equal(workspace.revision, initial.revision + 2);
    assert.equal(workspace.targets.find(item => item.blockId === target.blockId)?.text, document.blocks.find(item => item.id === target.blockId)?.text);
    assert.equal(inspector.stats().builds, 1, 'metadata reads around save/decision must not repeatedly unzip the same original'); assert.ok(inspector.stats().sourceVerifications >= 4);
    await assert.rejects(service.decideChange({ reviewId, proposalId: workspace.proposals[0].id, expectedRevision: initial.revision, status: 'rejected' }), /更新/u);
    const exported = await service.exportModified({ reviewId, expectedRevision: workspace.revision, filePath: join(output, 'synthetic-tracked.docx'), format: 'tracked' });
    const refreshed = await service.getChanges(reviewId); assert.ok(refreshed.exports.some(item => item.id === exported.export.id)); assert.equal(inspector.stats().builds, 1);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});
