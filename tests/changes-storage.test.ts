import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { AppStore } from '../src/core/storage';
import type { ChangeProposal } from '../src/shared/changes';
import type { ParsedContract, ReviewContext, ReviewResult, ReviewTask } from '../src/shared/contracts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '改稿持久化工程样本。' };

async function fixture(store: AppStore, text = '服务完成后付款。 Payment follows acceptance. ชำระเงินภายหลังตรวจรับ') {
  const parsed: ParsedContract = { format: 'docx', language: 'mixed', pageCount: null, partial: false, warnings: [], blocks: [{ id: randomUUID(), ordinal: 0, kind: 'paragraph', text, locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/w:document[1]/w:body[1]/w:p[1]', paragraphId: null } }] };
  const document = await store.addDocument(randomUUID(), '三语工程合同.docx', `documents/${randomUUID()}/original.docx`, 100, sha(text), parsed);
  const task: ReviewTask = { id: randomUUID(), documentId: document.id, status: 'queued', stage: '合成检查', startedAt: new Date().toISOString(), finishedAt: null, error: null, resultId: null };
  const runId = await store.createTask(task, context, 'local');
  const review: ReviewResult = { id: randomUUID(), documentId: document.id, createdAt: new Date().toISOString(), mode: 'local', modelId: null, summary: '合成检查。', context,
    findings: [{ id: randomUUID(), blockIds: [parsed.blocks[0].id], quote: text, title: '完善验收条件', category: 'commercial', severity: 'unrated', description: '合成意见。', suggestion: '按确认的验收条件付款。', legalBasis: null, basisStatus: 'unverified', source: 'rule', locationStatus: 'matched' }],
    coverage: { reviewedBlockIds: [parsed.blocks[0].id], totalBlockCount: 1, knowledgeStatus: 'user_disabled', webStatus: 'user_disabled', limitations: [] }, inputTokens: null, outputTokens: null, elapsedMs: 1 };
  await store.saveReview(review, runId);
  await store.updateTask({ ...task, status: 'completed', stage: '完成', finishedAt: new Date().toISOString(), resultId: review.id }, runId);
  return { parsed, document, review, runId };
}

function proposal(saved: Awaited<ReturnType<typeof fixture>>, replacementText = '书面验收确认后付款。'): ChangeProposal {
  const text = saved.parsed.blocks[0].text;
  return { id: randomUUID(), reviewId: saved.review.id, documentId: saved.document.id, findingId: saved.review.findings[0].id, blockId: saved.parsed.blocks[0].id,
    rangeStart: 0, rangeEnd: text.length, originalText: text, replacementText, sourceFileSha256: sha(text), originalTextSha256: sha(text), status: 'proposed',
    explanation: '人工起草并待确认。', warnings: ['工程样本。'], modelId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

async function legacyImage(store: AppStore, version: 1 | 2 | 3 = 2) {
  const SQL = await initSqlJs(); const db = new SQL.Database();
  db.run(await readFile(new URL('../src/core/migrations/001-initial.sql', import.meta.url), 'utf8'));
  db.run('PRAGMA foreign_keys=OFF');
  if (version >= 2) {
    db.run('BEGIN');
    db.run(await readFile(new URL('../src/core/migrations/002-official-sources.sql', import.meta.url), 'utf8'));
    db.run("INSERT INTO schema_version(version,applied_at) VALUES(2,'fixture-v2')"); db.run('COMMIT');
  }
  if (version >= 3) {
    db.run(await readFile(new URL('../src/core/migrations/003-document-changes.sql', import.meta.url), 'utf8'));
    db.run("INSERT INTO schema_version(version,applied_at) VALUES(3,'fixture-v3')");
  }
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name<>'schema_version'")[0].values.map(row => String(row[0]));
  for (const table of tables) for (const row of store.rows(`SELECT * FROM "${table}"`)) {
    const columns = new Set(db.exec(`PRAGMA table_info("${table}")`)[0].values.map(column => String(column[1])));
    const fields = Object.keys(row).filter(field => columns.has(field));
    db.run(`INSERT INTO "${table}" (${fields.map(field => `"${field}"`).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(field => row[field]));
  }
  return db;
}

test('启用可编辑副本严格CAS且幂等，记录不可变来源与时间并在重启后保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-editable-copy-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store);
    const originalReview = structuredClone(store.getReview(saved.review.id));
    const originalVersion = store.rows('SELECT * FROM document_versions WHERE id=?', [saved.document.id])[0];
    assert.deepEqual(store.getEditableCopyAuthorization(saved.review.id), { enabled: false, enabledAt: null });
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM change_workspaces')[0].n, 0);
    await assert.rejects(store.enableEditableCopy(saved.review.id, 1), /发生变化/);
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM change_workspaces')[0].n, 0);
    await store.enableEditableCopy(saved.review.id, 0);
    const authorization = store.getEditableCopyAuthorization(saved.review.id);
    assert.equal(authorization.enabled, true); assert.ok(authorization.enabledAt && Number.isFinite(Date.parse(authorization.enabledAt)));
    assert.equal(store.getChangeRevision(saved.review.id), 1);
    const event = store.rows('SELECT * FROM change_editable_copy_events')[0];
    assert.equal(event.review_id, saved.review.id); assert.equal(event.source_document_version_id, saved.document.id);
    assert.equal(event.source_file_sha256, originalVersion.file_sha256); assert.equal(event.enabled_at, authorization.enabledAt);
    await assert.rejects(store.enableEditableCopy(saved.review.id, 0), /发生变化/);
    await store.enableEditableCopy(saved.review.id, 1);
    assert.equal(store.getChangeRevision(saved.review.id), 1);
    assert.deepEqual(store.getEditableCopyAuthorization(saved.review.id), authorization);
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM change_editable_copy_events')[0].n, 1);
    await assert.rejects(store.saveChangeProposal(proposal(saved), 0), /发生变化/);
    await store.saveChangeProposal(proposal(saved), 1);
    assert.throws(() => store!.rows("UPDATE change_editable_copy_events SET enabled_at='changed'"), /immutable/);
    assert.throws(() => store!.rows('DELETE FROM change_editable_copy_events'), /immutable/);
    assert.throws(() => store!.rows('UPDATE change_workspaces SET editable_copy_enabled=0,editable_copy_enabled_at=NULL'), /immutable/);
    assert.throws(() => store!.rows("UPDATE change_workspaces SET source_file_sha256=?", [sha('changed')]), /immutable/);
    assert.throws(() => store!.getEditableCopyAuthorization(randomUUID()), /不存在/);
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(store.getEditableCopyAuthorization(saved.review.id), authorization);
    assert.equal(store.getChangeRevision(saved.review.id), 2);
    assert.deepEqual(store.rows('SELECT * FROM document_versions WHERE id=?', [saved.document.id])[0], originalVersion);
    assert.deepEqual(store.getReview(saved.review.id), originalReview);
    assert.deepEqual(store.rows('SELECT * FROM change_editable_copy_events')[0], event);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('可编辑副本授权拒绝失效来源和非DOCX，失败不创建授权或递增修订', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-editable-copy-source-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); const other = await fixture(store, '其他合同。');
    const stamp = new Date().toISOString();
    store.rows('INSERT INTO change_workspaces(review_id,source_document_version_id,source_file_sha256,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)', [saved.review.id, other.document.id, sha('other'), 0, stamp, stamp]);
    assert.throws(() => store!.getEditableCopyAuthorization(saved.review.id), /来源版本已失效/);
    await assert.rejects(store.enableEditableCopy(saved.review.id, 0), /来源版本已失效/);
    assert.equal(store.rows('SELECT editable_copy_enabled,revision FROM change_workspaces WHERE review_id=?', [saved.review.id])[0].editable_copy_enabled, 0);
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM change_editable_copy_events')[0].n, 0);
    const pdf = await fixture(store, 'PDF审核样本。');
    // The source format is immutable in production; this fixture changes it only
    // after dropping that guard to exercise the independent authorization check.
    store.rows('DROP TRIGGER document_source_immutable');
    store.rows("UPDATE document_versions SET source_format='pdf' WHERE id=?", [pdf.document.id]);
    await assert.rejects(store.enableEditableCopy(pdf.review.id, 0), /仅DOCX/);
    assert.equal(store.getChangeRevision(pdf.review.id), 0);
    assert.deepEqual(store.getEditableCopyAuthorization(pdf.review.id), { enabled: false, enabledAt: null });
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('改稿建议持久化、采纳和编辑需再次确认，历史报告及原文在重启后保持不变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-change-store-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); const next = proposal(saved);
    const original = structuredClone(store.getReview(saved.review.id));
    assert.equal(store.getChangeRevision(saved.review.id), 0);
    assert.deepEqual(store.getChangeProposals(saved.review.id), []);
    assert.deepEqual(store.getDocumentArtifact(saved.document.id), { artifactUri: store.rows('SELECT artifact_uri FROM document_versions WHERE id=?', [saved.document.id])[0].artifact_uri, sha256: sha(saved.parsed.blocks[0].text), byteSize: 100, format: 'docx' });
    await store.saveChangeProposal(next, 0);
    assert.equal(store.getChangeRevision(saved.review.id), 1);
    await store.decideChangeProposal(saved.review.id, next.id, 'accepted', 1);
    assert.equal(store.getChangeRevision(saved.review.id), 2);
    assert.equal(store.getChangeProposals(saved.review.id)[0].status, 'accepted');
    await store.saveChangeProposal({ ...next, replacementText: '书面验收后十日内付款。', status: 'accepted' }, 2);
    assert.equal(store.getChangeProposals(saved.review.id)[0].status, 'proposed');
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM change_proposal_events')[0].n, 3);
    assert.throws(() => store!.rows("UPDATE change_proposal_events SET kind='decision'"), /immutable/);
    const persisted = store.getChangeProposals(saved.review.id);
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(store.getChangeProposals(saved.review.id), persisted);
    assert.equal(store.getChangeRevision(saved.review.id), 3);
    assert.deepEqual(store.getReview(saved.review.id), original);
    assert.equal(store.getDocument(saved.document.id).blocks[0].text, saved.parsed.blocks[0].text);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('CAS拒绝过时保存与决定，同一原文重叠只能采纳一项且失败不增加revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-change-conflict-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); const first = proposal(saved); const second = proposal(saved, '验收并核对发票后付款。');
    await store.saveChangeProposal(first, 0);
    await assert.rejects(store.saveChangeProposal(second, 0), /发生变化/);
    await store.saveChangeProposal(second, 1);
    await store.decideChangeProposal(saved.review.id, first.id, 'accepted', 2);
    await assert.rejects(store.decideChangeProposal(saved.review.id, second.id, 'accepted', 2), /发生变化/);
    await assert.rejects(store.decideChangeProposal(saved.review.id, second.id, 'accepted', 3), /冲突/);
    assert.equal(store.getChangeRevision(saved.review.id), 3);
    await store.decideChangeProposal(saved.review.id, first.id, 'rejected', 3);
    await store.decideChangeProposal(saved.review.id, second.id, 'accepted', 4);
    assert.deepEqual(store.getChangeProposals(saved.review.id).filter(item => item.status === 'accepted').map(item => item.id), [second.id]);
    assert.equal(store.getChangeRevision(saved.review.id), 5);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('建议校验源文件hash、文本hash、精确范围、所属意见与版本，锚点不可改', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-change-anchor-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store, '😀付款条款。'); const other = await fixture(store, '另一份合同。'); const next = proposal(saved);
    for (const invalid of [
      { ...next, documentId: other.document.id }, { ...next, blockId: other.parsed.blocks[0].id },
      { ...next, findingId: other.review.findings[0].id }, { ...next, sourceFileSha256: sha('changed') },
      { ...next, originalTextSha256: sha('changed') }, { ...next, originalText: 'changed' },
      { ...next, rangeStart: 1, originalText: next.originalText.slice(1), originalTextSha256: sha(next.originalText.slice(1)) },
    ]) await assert.rejects(store.saveChangeProposal(invalid, 0), /不匹配|不属于/);
    assert.equal(store.getChangeRevision(saved.review.id), 0);
    await store.saveChangeProposal(next, 0);
    const text = next.originalText.slice(2);
    await assert.rejects(store.saveChangeProposal({ ...next, rangeStart: 2, originalText: text, originalTextSha256: sha(text) }, 1), /锚点不可更改/);
    assert.throws(() => store!.rows('UPDATE change_proposals SET range_start=1 WHERE id=?', [next.id]), /immutable/);
    assert.throws(() => store!.getDocumentArtifact(randomUUID()), /不存在/);
    assert.throws(() => store!.getChangeRevision(randomUUID()), /不存在/);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('导出生成同合同派生版本和不可变快照，后续草稿变化不覆盖历史导出', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-change-export-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); const next = proposal(saved);
    await store.saveChangeProposal(next, 0); await store.decideChangeProposal(saved.review.id, next.id, 'accepted', 1);
    const exportInput = (expectedRevision: number, text: string) => ({ id: randomUUID(), reviewId: saved.review.id, expectedRevision, documentId: randomUUID(), artifactUri: `documents/${randomUUID()}/revised.docx`, sha256: sha(`bytes:${text}`), byteSize: 120,
      parsed: { ...saved.parsed, blocks: saved.parsed.blocks.map(block => ({ ...block, id: randomUUID(), text })) }, proposals: store!.getChangeProposals(saved.review.id).filter(item => item.status === 'accepted'), changeList: `原文→${text}` });
    const input = exportInput(2, next.replacementText);
    await assert.rejects(store.addChangeExport({ ...input, proposals: [] }), /不一致/);
    const exported = await store.addChangeExport(input);
    assert.equal(exported.versionNo, 2); assert.equal(exported.sourceDocumentId, saved.document.id); assert.equal(exported.documentId, input.documentId);
    assert.equal(store.getChangeRevision(saved.review.id), 3);
    await assert.rejects(store.addChangeExport({ ...input, id: randomUUID(), documentId: randomUUID() }), /发生变化/);
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM change_exports')[0].n, 1);
    assert.equal(store.getChangeProposals(saved.review.id)[0].status, 'accepted');
    const docRow = store.rows('SELECT * FROM document_versions WHERE id=?', [input.documentId])[0];
    assert.equal(docRow.parent_version_id, saved.document.id); assert.equal(docRow.kind, 'revised');
    assert.equal(docRow.contract_id, store.rows('SELECT contract_id FROM document_versions WHERE id=?', [saved.document.id])[0].contract_id);
    assert.equal(store.getDocument(input.documentId).name, '三语工程合同 · 修改稿 v2.docx');
    assert.equal(store.getDocument(input.documentId).blocks[0].text, next.replacementText);
    assert.equal(store.getDocument(input.documentId).reviews.length, 0);
    assert.equal(store.getDocument(input.documentId).latestReviewId, null);
    const before = store.rows('SELECT * FROM change_exports WHERE id=?', [input.id])[0];
    assert.deepEqual(JSON.parse(String(before.snapshot_json)).editableCopyAuthorization, { enabled: false, enabledAt: null });
    assert.throws(() => store!.rows("UPDATE change_exports SET change_list='changed' WHERE id=?", [input.id]), /immutable/);
    await store.enableEditableCopy(saved.review.id, 3);
    const authorization = store.getEditableCopyAuthorization(saved.review.id);
    await store.saveChangeProposal({ ...next, replacementText: '重新确认的修改稿。' }, 4);
    await store.decideChangeProposal(saved.review.id, next.id, 'accepted', 5);
    const second = await store.addChangeExport(exportInput(6, '重新确认的修改稿。'));
    assert.equal(second.versionNo, 3);
    assert.deepEqual(store.rows('SELECT * FROM change_exports WHERE id=?', [input.id])[0], before);
    assert.equal(JSON.parse(String(before.snapshot_json)).proposals[0].replacementText, next.replacementText);
    assert.deepEqual(JSON.parse(String(store.rows('SELECT snapshot_json FROM change_exports WHERE id=?', [second.id])[0].snapshot_json)).editableCopyAuthorization, authorization);
    const snapshots = store.getChangeExports(saved.review.id);
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(store.getChangeExports(saved.review.id), snapshots);
    assert.equal(store.getChangeRevision(saved.review.id), 7);
    assert.deepEqual(store.getEditableCopyAuthorization(saved.review.id), authorization);
    assert.equal(store.getReview(saved.review.id).id, saved.review.id);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('源文件和改稿读写均按工作空间隔离，不能用另一工作空间的ID越界', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-change-scope-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); const next = proposal(saved);
    const foreignWorkspace = randomUUID(); const stamp = new Date().toISOString();
    store.rows('INSERT INTO workspaces(id,name,company_name,created_at,updated_at) VALUES(?,?,?,?,?)', [foreignWorkspace, '另一个工作空间', null, stamp, stamp]);
    store.rows('UPDATE contracts SET workspace_id=? WHERE id=(SELECT contract_id FROM document_versions WHERE id=?)', [foreignWorkspace, saved.document.id]);
    assert.throws(() => store!.getDocumentArtifact(saved.document.id), /不属于/);
    assert.throws(() => store!.getChangeRevision(saved.review.id), /不属于/);
    assert.throws(() => store!.getChangeProposals(saved.review.id), /不属于/);
    assert.throws(() => store!.getChangeExports(saved.review.id), /不属于/);
    assert.throws(() => store!.getEditableCopyAuthorization(saved.review.id), /不属于/);
    await assert.rejects(store.saveChangeProposal(next, 0), /不属于/);
    await assert.rejects(store.enableEditableCopy(saved.review.id, 0), /不属于/);
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM change_workspaces')[0].n, 0);
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM change_editable_copy_events')[0].n, 0);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('v2升级保留完整原字节备份及历史数据，当前结构和外键在重启后可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-change-v2-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); const legacy = await legacyImage(store);
    assert.deepEqual(legacy.exec('PRAGMA foreign_key_check'), []);
    const bytes = Buffer.from(legacy.export()); legacy.close(); await store.close(); store = undefined;
    await writeFile(join(dir, 'workspace.sqlite'), bytes);
    store = await AppStore.open(dir);
    assert.equal(Number(store.rows('SELECT MAX(version) AS n FROM schema_version')[0].n), 7);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite.v2-backup')), bytes);
    const SQL = await initSqlJs(); const intermediate = new SQL.Database(await readFile(join(dir, 'workspace.sqlite.v3-backup')));
    assert.equal(Number(intermediate.exec('SELECT MAX(version) FROM schema_version')[0].values[0][0]), 3); intermediate.close();
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'workspace.sqlite.v2-backup'))).mode & 0o777, 0o600);
    assert.equal(store.getReview(saved.review.id).summary, saved.review.summary);
    assert.equal(store.getChangeRevision(saved.review.id), 0);
    await store.saveChangeProposal(proposal(saved), 0);
    await store.close(); store = await AppStore.open(dir);
    assert.equal(store.getChangeProposals(saved.review.id).length, 1);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite.v2-backup')), bytes);
    assert.equal(store.rows('PRAGMA foreign_keys')[0].foreign_keys, 1);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('v2存在损坏外键时拒绝升级并保留原库及备份，失败不会写入v3', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-change-v2-failed-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); await fixture(store); const legacy = await legacyImage(store);
    legacy.run("UPDATE report_sources SET document_version_id='missing-document' WHERE document_version_id IS NOT NULL");
    const bytes = Buffer.from(legacy.export()); legacy.close(); await store.close(); store = undefined;
    await writeFile(join(dir, 'workspace.sqlite'), bytes);
    await assert.rejects(AppStore.open(dir), /关系校验失败/);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite')), bytes);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite.v2-backup')), bytes);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('v3升级以原字节备份保存旧草稿并默认不授权，启用后重启保留且不覆盖备份', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-editable-copy-v3-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); const next = proposal(saved);
    await store.saveChangeProposal(next, 0); await store.decideChangeProposal(saved.review.id, next.id, 'accepted', 1);
    const legacy = await legacyImage(store, 3); const bytes = Buffer.from(legacy.export()); legacy.close();
    await store.close(); store = undefined; await writeFile(join(dir, 'workspace.sqlite'), bytes);
    store = await AppStore.open(dir);
    const backupPath = join(dir, 'workspace.sqlite.v3-backup');
    assert.equal(Number(store.rows('SELECT MAX(version) AS n FROM schema_version')[0].n), 7);
    assert.deepEqual(await readFile(backupPath), bytes);
    if (process.platform !== 'win32') assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    assert.equal(store.getChangeProposals(saved.review.id)[0].status, 'accepted');
    assert.equal(store.getChangeRevision(saved.review.id), 2);
    assert.deepEqual(store.getEditableCopyAuthorization(saved.review.id), { enabled: false, enabledAt: null });
    await store.enableEditableCopy(saved.review.id, 2); const authorization = store.getEditableCopyAuthorization(saved.review.id);
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(store.getEditableCopyAuthorization(saved.review.id), authorization);
    assert.equal(store.getChangeRevision(saved.review.id), 3);
    assert.deepEqual(await readFile(backupPath), bytes);
    assert.equal(store.rows('PRAGMA foreign_keys')[0].foreign_keys, 1);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('v1直升v6按顺序保留v1/v2/v3/v4/v5备份，各中间库外键完整', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-editable-copy-v1-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); const legacy = await legacyImage(store, 1);
    const bytes = Buffer.from(legacy.export()); legacy.close(); await store.close(); store = undefined;
    await writeFile(join(dir, 'workspace.sqlite'), bytes); store = await AppStore.open(dir);
    const SQL = await initSqlJs();
    for (const version of [1, 2, 3, 4, 5]) {
      const backup = await readFile(join(dir, `workspace.sqlite.v${version}-backup`));
      if (version === 1) assert.deepEqual(backup, bytes);
      const db = new SQL.Database(backup);
      assert.equal(Number(db.exec('SELECT MAX(version) FROM schema_version')[0].values[0][0]), version);
      assert.deepEqual(db.exec('PRAGMA foreign_key_check'), []); db.close();
    }
    assert.equal(Number(store.rows('SELECT MAX(version) AS n FROM schema_version')[0].n), 7);
    assert.equal(store.getReview(saved.review.id).summary, saved.review.summary);
    assert.deepEqual(store.getEditableCopyAuthorization(saved.review.id), { enabled: false, enabledAt: null });
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('v3关系损坏时拒绝v4升级，原库和v3原字节备份保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-editable-copy-v3-failed-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); await store.saveChangeProposal(proposal(saved), 0);
    const legacy = await legacyImage(store, 3);
    legacy.run('DROP TRIGGER change_workspace_source_immutable');
    legacy.run("UPDATE change_workspaces SET source_document_version_id='missing-document' WHERE review_id=?", [saved.review.id]);
    const bytes = Buffer.from(legacy.export()); legacy.close(); await store.close(); store = undefined;
    await writeFile(join(dir, 'workspace.sqlite'), bytes);
    await assert.rejects(AppStore.open(dir), /关系校验失败/);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite')), bytes);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite.v3-backup')), bytes);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});
