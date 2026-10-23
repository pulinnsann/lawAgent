import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../src/core/storage';
import { reviewContract } from '../src/core/review';
import { createWorkspaceBackup, inspectWorkspaceBackup, restoreWorkspaceBackup, clearKnowledgeIndex, undoKnowledgeClear } from '../src/core/workspace-maintenance';
import type { ReviewContext, ReviewTask } from '../src/shared/contracts';

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '合成工程资料' };
async function addDocument(store: AppStore, dataDir: string, name: string) {
  const id = randomUUID(); const relativePath = `documents/${id}/original.docx`; const bytes = Buffer.from(`synthetic-original-${name}`); await mkdir(join(dataDir, 'documents', id), { recursive: true }); await writeFile(join(dataDir, relativePath), bytes);
  const document = await store.addDocument(id, name, relativePath, bytes.length, digest(bytes), { format: 'docx', language: 'zh', pageCount: null, partial: false, warnings: [], blocks: [{ id: randomUUID(), ordinal: 0, kind: 'paragraph', text: '甲方委托乙方提供测试服务。价款为100元。', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/w:document[1]/w:body[1]/w:p[1]', paragraphId: null } }] });
  return { document, relativePath, bytes };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'law-maintenance-')); const dataDir = join(root, 'data'); let store = await AppStore.open(dataDir); const first = await addDocument(store, dataDir, '测试原件A');
  const task: ReviewTask = { id: randomUUID(), documentId: first.document.id, status: 'queued', stage: '合成测试', startedAt: new Date().toISOString(), finishedAt: null, resultId: null, error: null };
  const runId = await store.createTask(task, context, 'local'); const result = await reviewContract(first.document, context, null, null, 'local', new AbortController().signal, () => {}); await store.saveReview(result, runId); await store.close();
  await mkdir(join(dataDir, 'local-knowledge'), { recursive: true }); await mkdir(join(dataDir, 'remote-cache'), { recursive: true }); await writeFile(join(dataDir, 'local-knowledge', 'fixture.index'), 'old-local-index'); await writeFile(join(dataDir, 'remote-cache', 'fixture.cache'), 'old-remote-cache');
  return { root, dataDir, first, reportId: result.id, close: () => rm(root, { recursive: true, force: true }) };
}

test('备份清单逐文件SHA256与业务原件一致，关闭后检查报告和合同数量，可选排除索引', async () => {
  const f = await fixture();
  try {
    const backup = await createWorkspaceBackup(f.dataDir, f.root, true); const inspected = await inspectWorkspaceBackup(backup.path);
    assert.equal(inspected.documents, 1); assert.equal(inspected.reports, 1); assert.equal(inspected.manifest.includeKnowledge, true);
    assert.ok(backup.manifest.files.some(file => file.path === 'local-knowledge/fixture.index')); assert.ok(backup.manifest.files.some(file => file.path === 'remote-cache/fixture.cache'));
    for (const file of backup.manifest.files) { const bytes = await readFile(join(backup.path, file.path)); assert.equal(bytes.length, file.size); assert.equal(digest(bytes), file.sha256); }
    const noIndex = await createWorkspaceBackup(f.dataDir, f.root, false); assert.ok(!noIndex.manifest.files.some(file => /^(?:local-knowledge|remote-cache)\//u.test(file.path))); assert.equal((await inspectWorkspaceBackup(noIndex.path)).documents, 1);
  } finally { await f.close(); }
});

test('恢复先保留完整业务前像，恢复原报告和原件后仍能通过前像备份回退', async () => {
  const f = await fixture();
  try {
    const backup = await createWorkspaceBackup(f.dataDir, f.root, true); const store = await AppStore.open(f.dataDir); const second = await addDocument(store, f.dataDir, '测试原件B'); await store.close();
    await writeFile(join(f.dataDir, 'local-knowledge', 'fixture.index'), 'rebuilt-local-index');
    const beforeDb = await readFile(join(f.dataDir, 'workspace.sqlite')); const restore = await restoreWorkspaceBackup(f.dataDir, backup.path);
    assert.deepEqual(await readFile(join(restore.recoveryPath, 'workspace.sqlite')), beforeDb); assert.deepEqual(await readFile(join(restore.recoveryPath, second.relativePath)), second.bytes);
    assert.deepEqual(await readFile(join(f.dataDir, f.first.relativePath)), f.first.bytes); assert.equal(await readFile(join(f.dataDir, 'local-knowledge', 'fixture.index'), 'utf8'), 'old-local-index');
    let restored = await AppStore.open(f.dataDir); assert.equal(restored.listDocuments().length, 1); assert.equal(restored.getReview(f.reportId).id, f.reportId); await restored.close();
    const undoBackup = await createWorkspaceBackup(restore.recoveryPath, f.root, true); assert.equal((await inspectWorkspaceBackup(undoBackup.path)).documents, 2);
    await restoreWorkspaceBackup(f.dataDir, undoBackup.path); restored = await AppStore.open(f.dataDir); assert.equal(restored.listDocuments().length, 2); await restored.close();
    assert.deepEqual(await readFile(join(f.dataDir, second.relativePath)), second.bytes);
  } finally { await f.close(); }
});

test('文件损坏、原件哈希、清单越界或重复、符号链接全部在移动当前数据前拒绝', async () => {
  const f = await fixture();
  try {
    const originalDb = await readFile(join(f.dataDir, 'workspace.sqlite'));
    const corrupted = await createWorkspaceBackup(f.dataDir, f.root, false); await writeFile(join(corrupted.path, f.first.relativePath), 'damaged'); await assert.rejects(restoreWorkspaceBackup(f.dataDir, corrupted.path), /校验失败/u);
    const wrongHash = await createWorkspaceBackup(f.dataDir, f.root, false); const manifest = JSON.parse(await readFile(join(wrongHash.path, 'manifest.json'), 'utf8')); const file = manifest.files.find((item: any) => item.path === f.first.relativePath); const replacement = Buffer.from('other-doc'); await writeFile(join(wrongHash.path, file.path), replacement); file.size = replacement.length; file.sha256 = digest(replacement); await writeFile(join(wrongHash.path, 'manifest.json'), JSON.stringify(manifest)); await assert.rejects(inspectWorkspaceBackup(wrongHash.path), /原件.*哈希/u);
    for (const badPath of ['documents/../../outside.txt', 'documents/../escape.docx', '/tmp/outside', 'documents\\escape.docx']) { const bad = await createWorkspaceBackup(f.dataDir, f.root, false); bad.manifest.files.push({ ...bad.manifest.files[0], path: badPath }); await writeFile(join(bad.path, 'manifest.json'), JSON.stringify(bad.manifest)); await assert.rejects(inspectWorkspaceBackup(bad.path), /越界|重复/u); }
    const duplicate = await createWorkspaceBackup(f.dataDir, f.root, false); duplicate.manifest.files.push({ ...duplicate.manifest.files[0] }); await writeFile(join(duplicate.path, 'manifest.json'), JSON.stringify(duplicate.manifest)); await assert.rejects(inspectWorkspaceBackup(duplicate.path), /重复/u);
    const link = await createWorkspaceBackup(f.dataDir, f.root, false); await rm(join(link.path, f.first.relativePath)); await symlink(join(f.dataDir, f.first.relativePath), join(link.path, f.first.relativePath)); await assert.rejects(inspectWorkspaceBackup(link.path), /符号链接/u);
    assert.deepEqual(await readFile(join(f.dataDir, 'workspace.sqlite')), originalDb); assert.deepEqual(await readFile(join(f.dataDir, f.first.relativePath)), f.first.bytes);
  } finally { await f.close(); }
});

test('备份目标与恢复来源不得位于当前数据目录内，点点前缀文件夹也不例外', async () => {
  const f = await fixture();
  try {
    const inside = join(f.dataDir, '..cache'); await mkdir(inside); await assert.rejects(createWorkspaceBackup(f.dataDir, inside, false), /之外/u);
    const backup = await createWorkspaceBackup(f.dataDir, f.root, false);
    // A backup directory inside the live workspace is never an external recovery source.
    const internal = join(f.dataDir, '..backup'); const { cp } = await import('node:fs/promises'); await cp(backup.path, internal, { recursive: true }); await assert.rejects(restoreWorkspaceBackup(f.dataDir, internal), /内部/u);
  } finally { await f.close(); }
});

test('清理索引保留业务库和原件，撤销恢复旧索引与配置并留存新建索引', async () => {
  const f = await fixture();
  try {
    const beforeDb = await readFile(join(f.dataDir, 'workspace.sqlite')); const previousConfig = { knowledge: { enabled: true, folderPath: 'synthetic-policy-root' } };
    const cleared = await clearKnowledgeIndex(f.dataDir, previousConfig); assert.equal(await readFile(join(cleared.recoveryPath, 'local-knowledge', 'fixture.index'), 'utf8'), 'old-local-index'); assert.ok(!(await readdir(f.dataDir)).includes('local-knowledge'));
    await mkdir(join(f.dataDir, 'local-knowledge')); await writeFile(join(f.dataDir, 'local-knowledge', 'new.index'), 'new-index-after-clear');
    const undo = await undoKnowledgeClear(f.dataDir); assert.deepEqual(undo.previousConfig, previousConfig); assert.equal(await readFile(join(f.dataDir, 'local-knowledge', 'fixture.index'), 'utf8'), 'old-local-index'); assert.equal(await readFile(join(undo.recoveryPath, 'local-knowledge', 'new.index'), 'utf8'), 'new-index-after-clear');
    assert.deepEqual(await readFile(join(f.dataDir, 'workspace.sqlite')), beforeDb); assert.deepEqual(await readFile(join(f.dataDir, f.first.relativePath)), f.first.bytes); await assert.rejects(undoKnowledgeClear(f.dataDir));
  } finally { await f.close(); }
});

test('篡改索引恢复记录不能把受管目录外资料搬入工作空间', async () => {
  const f = await fixture();
  try {
    await clearKnowledgeIndex(f.dataDir, {}); const external = join(f.root, 'external'); await mkdir(join(external, 'local-knowledge'), { recursive: true }); await writeFile(join(external, 'local-knowledge', 'outside.txt'), 'outside');
    await writeFile(join(f.dataDir, 'recovery', 'latest-knowledge.json'), JSON.stringify({ recoveryPath: external, previousConfig: {} })); await assert.rejects(undoKnowledgeClear(f.dataDir), /无效/u); assert.equal(await readFile(join(external, 'local-knowledge', 'outside.txt'), 'utf8'), 'outside');
  } finally { await f.close(); }
});
