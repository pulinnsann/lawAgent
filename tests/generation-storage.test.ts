import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { AppStore } from '../src/core/storage';
import type { ContractDraft } from '../src/shared/generation';
import type { ParsedContract } from '../src/shared/contracts';

function draft(): ContractDraft {
  const id = randomUUID();
  return { id, title: '合成服务合同', language: 'zh', createdAt: new Date().toISOString(), modelId: 'synthetic-model',
    request: { requestId: id, description: '拟定一份服务采购合同，我方接受服务，金额、名称与期限尚待确认。', language: 'zh', contractType: 'service', ourPartyRole: 'service_recipient' },
    clauses: [{ heading: '服务范围', paragraphs: ['服务范围为[待确认]。'] }], missingInformation: ['当事人名称、金额与期限。'], warnings: ['合成工程验证内容。'], inputTokens: 10, outputTokens: 20 };
}
const parsed = (): ParsedContract => ({ format: 'docx', language: 'zh', blocks: [{ id: randomUUID(), ordinal: 0, kind: 'paragraph', text: '合成工程验证内容。', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/w:document[1]/w:body[1]/w:p[1]', paragraphId: null } }], pageCount: null, partial: false, warnings: [] });
const sha = createHash('sha256').update('synthetic').digest('hex');

test('生成草稿独立持久化、不可变且隔离工作空间，导出来源在同一事务登记', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-generation-storage-')); let store = await AppStore.open(dir);
  try {
    const value = draft(); await store.saveContractDraft(value);
    assert.deepEqual(store.getContractDraft(value.id), value); assert.equal(store.listContractDrafts().length, 1);
    assert.equal(store.listDocuments().length, 0);
    await assert.rejects(store.saveContractDraft({ ...value, title: '不可覆盖历史草稿' }));
    assert.throws(() => store.rows("UPDATE contract_drafts SET title='changed' WHERE id=?", [value.id]), /immutable/);
    assert.throws(() => store.rows('DELETE FROM contract_drafts WHERE id=?', [value.id]), /immutable/);
    const foreignWorkspace = randomUUID(); const other = draft();
    store.rows('INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,?,?,?)', [foreignWorkspace, '其他工作空间', value.createdAt, value.createdAt]);
    store.rows('INSERT INTO contract_drafts(id,workspace_id,title,language,model_id,request_json,content_json,created_at) VALUES(?,?,?,?,?,?,?,?)', [other.id, foreignWorkspace, other.title, other.language, other.modelId, JSON.stringify(other.request), JSON.stringify(other), other.createdAt]);
    assert.throws(() => store.getContractDraft(other.id), /不属于/); assert.equal(store.listContractDrafts().length, 1);
    await assert.rejects(store.addDocument(randomUUID(), '不能绑定其他空间.docx', 'documents/fake.docx', 10, sha, parsed(), other.id), /不属于/);
    assert.equal(store.listDocuments().length, 0);
    const document = await store.addDocument(randomUUID(), '生成草稿.docx', 'documents/fake.docx', 10, sha, parsed(), value.id);
    const provenance = store.rows('SELECT * FROM contract_draft_exports')[0];
    assert.equal(provenance.draft_id, value.id); assert.equal(provenance.document_version_id, document.id); assert.equal(provenance.file_sha256, sha);
    assert.throws(() => store.rows("UPDATE contract_draft_exports SET file_sha256='changed'"), /immutable/);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(store.getContractDraft(value.id), value); assert.equal(store.getDocument(document.id).id, document.id);
    assert.deepEqual(store.rows('SELECT * FROM contract_draft_exports')[0], provenance);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('v4升级为生成存储保存原字节备份，已有合同和配置不变，重启不覆盖备份', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-generation-v4-')); let store = await AppStore.open(dir);
  try {
    const original = await store.addDocument(randomUUID(), '原有合同.docx', 'documents/original.docx', 10, sha, parsed());
    await store.saveConfig({ name: '本机模型', baseUrl: 'https://example.test/v1', model: 'test', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 4096, contextWindowTokens: 64000, timeoutSeconds: 60 });
    const frozen = store.getDocument(original.id); const config = store.getConfig(); await store.close();
    const SQL = await initSqlJs(); const db = new SQL.Database(await readFile(join(dir, 'workspace.sqlite')));
    db.run('DROP INDEX idx_contracts_lifecycle');
    for(const table of ['projects','contracts'])for(const column of ['lifecycle_status','revision','previous_status','deleted_at'])db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    db.run('ALTER TABLE document_versions DROP COLUMN source_name');db.run('DELETE FROM schema_version WHERE version=7');
    db.run('DROP TABLE risk_disposition_events'); db.run('DROP TABLE risk_disposition_workspaces'); db.run('DROP TABLE enterprise_standard_versions'); db.run('DROP TABLE enterprise_standard_drafts'); db.run('DELETE FROM schema_version WHERE version=6');
    db.run('DROP TABLE contract_draft_exports'); db.run('DROP TABLE contract_drafts'); db.run('DELETE FROM schema_version WHERE version=5');
    const oldBytes = Buffer.from(db.export()); db.close(); await writeFile(join(dir, 'workspace.sqlite'), oldBytes);
    store = await AppStore.open(dir);
    assert.equal(Number(store.rows('SELECT MAX(version) AS n FROM schema_version')[0].n), 7);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite.v4-backup')), oldBytes);
    assert.deepEqual(store.getDocument(original.id), frozen); assert.deepEqual(store.getConfig(), config); assert.deepEqual(store.listContractDrafts(), []);
    await store.saveContractDraft(draft()); await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite.v4-backup')), oldBytes); assert.equal(store.listContractDrafts().length, 1);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
