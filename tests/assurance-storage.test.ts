import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { AppStore } from '../src/core/storage';
import { evaluateEnterpriseRules, normalizeEnterpriseStandardContent, normalizePublishEnterpriseStandardInput, normalizeSaveEnterpriseStandardInput } from '../src/core/enterprise-standards';
import { defaultEnterpriseStandard } from '../src/shared/assurance';
import type { EnterpriseStandardContent, EnterpriseStandardSnapshot, ProgramCheckReport } from '../src/shared/assurance';
import type { ParsedContract, ReviewContext, ReviewResult, ReviewTask } from '../src/shared/contracts';

const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '企业关注与风险处置工程样本。' };
const content = (name = '业务标准'): EnterpriseStandardContent => ({ ...defaultEnterpriseStandard(), name, description: '工程样本，不作为法律强制要求。', rules: [
  { key: 'acceptance', name: '验收主题', enabled: true, kind: 'required_topic', terms: ['书面验收', 'written acceptance'], category: 'operational', severity: 'high', guidance: '确认验收依据。' },
  { key: 'advance', name: '企业预付关注', enabled: true, kind: 'flag_phrase', terms: ['全额预付'], category: 'commercial', severity: 'high', guidance: '人工确认业务授权。' },
] });

async function fixture(store: AppStore, standard?: EnterpriseStandardSnapshot) {
  const parsed: ParsedContract = { format: 'docx', language: 'zh', pageCount: null, partial: false, warnings: [], blocks: [{ id: randomUUID(), ordinal: 0, kind: 'paragraph', text: '甲方应全额预付服务费用。', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/w:document[1]/w:body[1]/w:p[1]', paragraphId: null } }] };
  const document = await store.addDocument(randomUUID(), '审核工程样本.docx', `documents/${randomUUID()}/original.docx`, 100, sha(parsed.blocks[0].text), parsed);
  const task: ReviewTask = { id: randomUUID(), documentId: document.id, status: 'queued', stage: '合成审核', startedAt: new Date().toISOString(), finishedAt: null, error: null, resultId: null };
  const runId = await store.createTask(task, context, 'local', null, null, standard);
  const findings = standard ? evaluateEnterpriseRules(document, standard) : [{ id: randomUUID(), blockIds: [parsed.blocks[0].id], quote: parsed.blocks[0].text, title: '人工确认付款条件', category: 'commercial' as const, severity: 'unrated' as const, description: '合成关注。', suggestion: '人工确认。', legalBasis: null, basisStatus: 'unverified' as const, source: 'rule' as const, locationStatus: 'matched' as const }];
  const review: ReviewResult = { id: randomUUID(), documentId: document.id, createdAt: new Date().toISOString(), mode: 'local', modelId: null, summary: '工程样本。', context, findings,
    coverage: { reviewedBlockIds: parsed.blocks.map(block => block.id), totalBlockCount: 1, knowledgeStatus: 'user_disabled', webStatus: 'user_disabled', limitations: [] }, inputTokens: null, outputTokens: null, elapsedMs: 1, ...(standard ? { standardSnapshot: standard } : {}) };
  return { parsed, document, task, runId, review };
}

async function published(store: AppStore, value = content()) {
  let profile = await store.saveEnterpriseStandard({ expectedRevision: 0, content: value });
  profile = await store.publishEnterpriseStandard({ standardId: profile.id, expectedRevision: profile.revision, publishedBy: '测试法务' });
  return { profile, version: profile.versions[0] };
}

async function legacyImage(store: AppStore, version: 1 | 5) {
  const SQL = await initSqlJs(); const db = new SQL.Database();
  const names = ['001-initial.sql', '002-official-sources.sql', '003-document-changes.sql', '004-editable-copy.sql', '005-contract-generation.sql'];
  for (let index = 0; index < version; index++) {
    db.run(await readFile(new URL(`../src/core/migrations/${names[index]}`, import.meta.url), 'utf8'));
    db.run('PRAGMA foreign_keys=OFF');
    if (index) db.run('INSERT INTO schema_version(version,applied_at) VALUES(?,?)', [index + 1, `fixture-v${index + 1}`]);
  }
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name<>'schema_version'")[0].values.map(row => String(row[0]));
  for (const table of tables) {
    const columns = new Set(db.exec(`PRAGMA table_info("${table}")`)[0].values.map(row => String(row[1])));
    for (const row of store.rows(`SELECT * FROM "${table}"`)) {
      const fields = Object.keys(row).filter(key => columns.has(key));
      db.run(`INSERT INTO "${table}" (${fields.map(field => `"${field}"`).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(field => row[field]));
    }
  }
  return db;
}

test('企业标准规范化严格有界，不接受空适用范围、未知字段、重复规则或非法阈值', () => {
  const value = normalizeEnterpriseStandardContent({ ...content(' 标准 A '), contractTypes: ['other', 'service'], partyRoles: ['other', 'buyer'] });
  assert.equal(value.name, '标准 A'); assert.deepEqual(value.contractTypes, ['service', 'other']); assert.deepEqual(value.partyRoles, ['buyer', 'other']);
  for (const invalid of [
    { ...content(), name: ' ' }, { ...content(), description: 'x'.repeat(2001) }, { ...content(), contractTypes: [] }, { ...content(), partyRoles: [] },
    { ...content(), apiKey: 'never' }, { ...content(), rules: Array.from({ length: 51 }, (_, index) => ({ ...content().rules[0], key: `r${index}` })) },
    { ...content(), rules: [{ ...content().rules[0], terms: Array.from({ length: 21 }, (_, index) => `t${index}`) }] },
    { ...content(), rules: [{ ...content().rules[0], terms: ['x'.repeat(121)] }] }, { ...content(), rules: [content().rules[0], content().rules[0]] },
    { ...content(), rules: [{ ...content().rules[0], kind: 'javascript', guidance: 'x'.repeat(2001) }] },
    { ...content(), thresholds: { maxPrepaymentPercent: 101, maxPaymentDays: 1 } }, { ...content(), thresholds: { maxPrepaymentPercent: 0, maxPaymentDays: 0 } },
    { ...content(), thresholds: { maxPrepaymentPercent: 100, maxPaymentDays: 3651 } },
  ]) assert.throws(() => normalizeEnterpriseStandardContent(invalid), /无效/);
  assert.equal(normalizeEnterpriseStandardContent({ ...content(), thresholds: { maxPrepaymentPercent: 0, maxPaymentDays: 3650 } }).thresholds.maxPrepaymentPercent, 0);
  assert.throws(() => normalizeSaveEnterpriseStandardInput({ expectedRevision: -1, content: content() }), /无效/);
  assert.throws(() => normalizePublishEnterpriseStandardInput({ standardId: randomUUID(), expectedRevision: 1, publishedBy: ' ' }), /无效/);
});

test('企业规则仅有限字面匹配，未匹配主题不定级不伪造位置，禁用与取消均有效', () => {
  const rules = [...content().rules, { ...content().rules[1], key: 'literal', terms: ['a+b'], name: '字面词' }, { ...content().rules[1], key: 'thai', terms: ['ชำระ'], name: '泰文词' }];
  const value = { ...content(), rules };
  const snapshot: EnterpriseStandardSnapshot = { id: randomUUID(), standardId: randomUUID(), versionNo: 1, content: value, contentSha256: sha(value), publishedBy: '测试', publishedAt: new Date().toISOString() };
  const block = { id: randomUUID(), ordinal: 0, kind: 'paragraph' as const, text: '全额预付 a+b / ชำระ', locator: { kind: 'docx' as const, partName: 'word/document.xml', structuralPath: '/w:p[1]', paragraphId: null } };
  const findings = evaluateEnterpriseRules({ blocks: [block] }, snapshot);
  assert.equal(findings.length, 4); const missing = findings.find(item => item.locationStatus === 'unmatched')!;
  assert.equal(missing.severity, 'unrated'); assert.deepEqual(missing.blockIds, []); assert.equal(missing.quote, ''); assert.match(missing.description, /不能据此认定/);
  for (const finding of findings.filter(item => item.locationStatus === 'matched')) { assert.equal(finding.severity, 'high'); assert.ok(block.text.includes(finding.quote)); assert.deepEqual(finding.blockIds, [block.id]); assert.equal(finding.origin, 'enterprise'); assert.match(finding.description, /不是违法/); }
  assert.deepEqual(evaluateEnterpriseRules({ blocks: [block] }, { ...snapshot, content: { ...value, workflow: { ...value.workflow, runEnterpriseRules: false } } }), []);
  assert.deepEqual(evaluateEnterpriseRules({ blocks: [block] }, { ...snapshot, content: { ...value, rules: value.rules.map(rule => ({ ...rule, enabled: false })) } }), []);
  assert.equal(evaluateEnterpriseRules({ blocks: [{ ...block, text: 'aaab' }] }, { ...snapshot, content: { ...value, rules: [rules[2]] } }).length, 0);
  const controller = new AbortController(); controller.abort(); assert.throws(() => evaluateEnterpriseRules({ blocks: [block] }, snapshot, controller.signal), /取消/);
});

test('持久化预付款阈值拒绝三位小数，不用浮点取模误拒绝0.29', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-enterprise-decimal-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir);
    await assert.rejects(store.saveEnterpriseStandard({ expectedRevision: 0, content: { ...content(), thresholds: { maxPrepaymentPercent: 0.001, maxPaymentDays: null } } }), /两位小数/);
    assert.deepEqual(store.listEnterpriseStandards(), []);
    const profile = await store.saveEnterpriseStandard({ expectedRevision: 0, content: { ...content(), thresholds: { maxPrepaymentPercent: 0.29, maxPaymentDays: null } } });
    assert.equal(profile.draft.thresholds.maxPrepaymentPercent, 0.29);
    await store.close(); store = await AppStore.open(dir);
    assert.equal(store.getEnterpriseStandard(profile.id).draft.thresholds.maxPrepaymentPercent, 0.29);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('企业标准草稿CAS、唯一名称、发布版本与从旧版本重放均不覆盖历史，重启保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-enterprise-versions-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); assert.deepEqual(store.listEnterpriseStandards(), []);
    await assert.rejects(store.saveEnterpriseStandard({ expectedRevision: 1, content: content() }), /发生变化/);
    let profile = await store.saveEnterpriseStandard({ expectedRevision: 0, content: content(' 标准 A ') });
    assert.match(profile.id, /^[a-f0-9-]{36}$/); assert.equal(profile.revision, 1); assert.deepEqual(profile.versions, []);
    await assert.rejects(store.saveEnterpriseStandard({ expectedRevision: 0, content: content('标准 A') }), /名称已存在/);
    profile = await store.publishEnterpriseStandard({ standardId: profile.id, expectedRevision: 1, publishedBy: '法务 A' });
    const first = structuredClone(profile.versions[0]); assert.equal(profile.revision, 2);
    assert.equal(store.rows('SELECT rule_set_id FROM rule_set_versions WHERE id=?', [first.id])[0].rule_set_id, profile.id);
    await assert.rejects(store.publishEnterpriseStandard({ standardId: profile.id, expectedRevision: 1, publishedBy: '法务 A' }), /发生变化/);
    profile = await store.saveEnterpriseStandard({ standardId: profile.id, expectedRevision: 2, content: { ...profile.draft, name: '标准 B', description: '第二版' } });
    assert.deepEqual(store.getEnterpriseStandardVersion(first.id), first);
    profile = await store.publishEnterpriseStandard({ standardId: profile.id, expectedRevision: 3, publishedBy: '法务 B' });
    assert.equal(profile.versions[1].versionNo, 2);
    profile = await store.saveEnterpriseStandard({ standardId: profile.id, expectedRevision: 4, content: first.content });
    profile = await store.publishEnterpriseStandard({ standardId: profile.id, expectedRevision: 5, publishedBy: '回退复核人' });
    assert.equal(profile.revision, 6); assert.equal(profile.versions[2].versionNo, 3); assert.equal(profile.versions[2].contentSha256, first.contentSha256); assert.notEqual(profile.versions[2].id, first.id);
    assert.throws(() => store!.rows("UPDATE enterprise_standard_versions SET content_json='{}' WHERE version_id=?", [first.id]), /immutable/);
    assert.throws(() => store!.rows('DELETE FROM enterprise_standard_versions WHERE version_id=?', [first.id]), /immutable/);
    assert.throws(() => store!.rows("UPDATE rule_set_versions SET approved_by_label='changed' WHERE id=?", [first.id]), /immutable/);
    assert.throws(() => store!.getEnterpriseStandardVersion(randomUUID()), /不存在/);
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(store.getEnterpriseStandard(profile.id), profile);
    assert.equal(store.listEnterpriseStandards()[0].versions.length, 3);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('审核冻结准确已发布版本和hash，后续发布不改run，报告保留程序计算与企业来源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-enterprise-run-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const { profile: firstProfile, version } = await published(store);
    const saved = await fixture(store, version);
    const originalRun = store.rows('SELECT * FROM analysis_runs WHERE id=?', [saved.runId])[0];
    assert.equal(originalRun.rule_set_version_id, version.id);
    assert.deepEqual(JSON.parse(String(originalRun.input_snapshot_json)).standardSnapshot, version);
    assert.deepEqual(JSON.parse(String(originalRun.prompt_snapshot_json)).standardSnapshot, version);
    let profile = await store.saveEnterpriseStandard({ standardId: firstProfile.id, expectedRevision: 2, content: { ...firstProfile.draft, description: '发布新标准' } });
    profile = await store.publishEnterpriseStandard({ standardId: profile.id, expectedRevision: 3, publishedBy: '第二发布人' });
    const second = profile.versions[1];
    const secondTask = { ...saved.task, id: randomUUID() };
    const secondRunId = await store.createTask(secondTask, context, 'local', null, null, second);
    assert.notEqual(store.rows('SELECT input_fingerprint FROM analysis_runs WHERE id=?', [secondRunId])[0].input_fingerprint, originalRun.input_fingerprint);
    await assert.rejects(store.createTask({ ...saved.task, id: randomUUID() }, context, 'local', null, null, { ...version, content: { ...version.content, name: '伪造同ID内容' } }), /快照.*不匹配/);
    await assert.rejects(store.saveReview({ ...saved.review, standardSnapshot: second }, saved.runId), /冻结版本不匹配/);
    const { standardSnapshot: _snapshot, ...missing } = saved.review;
    await assert.rejects(store.saveReview(missing, saved.runId), /冻结版本不匹配/);
    const report: ProgramCheckReport = { engineVersion: 'fixture-1', checks: [{ kind: 'amounts', status: 'completed', checkedCount: 1, limitations: ['仅工程样本。'] }], issues: [] };
    const result: ReviewResult = { ...saved.review, programChecks: report, findings: [...saved.review.findings, { ...saved.review.findings[1], id: randomUUID(), origin: 'program', checkKey: 'program:amounts:sample', calculation: '1 + 1 = 2' }] };
    await store.saveReview(result, saved.runId);
    assert.deepEqual(store.getReview(result.id), result);
    assert.equal(store.rows('SELECT rule_key FROM findings WHERE id=?', [result.findings[2].id])[0].rule_key, 'program:amounts:sample');
    const manifest = JSON.parse(String(store.rows('SELECT input_manifest_json FROM reports WHERE id=?', [result.id])[0].input_manifest_json));
    assert.deepEqual(manifest.standardSnapshot, version); assert.deepEqual(manifest.programChecks, report);
    assert.deepEqual(store.rows('SELECT * FROM analysis_runs WHERE id=?', [saved.runId])[0], originalRun);
    assert.throws(() => store!.rows("UPDATE analysis_runs SET input_snapshot_json='{}' WHERE id=?", [saved.runId]), /immutable/);
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(store.getReview(result.id).standardSnapshot, version); assert.deepEqual(store.getReview(result.id).programChecks, report);
    assert.equal(store.getReview(result.id).findings[2].calculation, '1 + 1 = 2');
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('风险处置使用全审核CAS、原因和操作者必填，历史只追加且不改风险等级或因采纳自动fixed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-risk-dispositions-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const { version } = await published(store); const saved = await fixture(store, version); await store.saveReview(saved.review, saved.runId);
    const original = structuredClone(store.getReview(saved.review.id));
    const reportsBefore = store.rows('SELECT content_json,input_manifest_json FROM reports WHERE id=?', [saved.review.id])[0];
    assert.deepEqual(store.getRiskDispositions(saved.review.id), { reviewId: saved.review.id, revision: 0, events: [] });
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM risk_disposition_workspaces')[0].n, 0);
    const input = { reviewId: saved.review.id, findingId: saved.review.findings[0].id, expectedRevision: 0, status: 'confirmed' as const, reason: '人工核对后记录关注。', actorLabel: '法务' };
    await assert.rejects(store.saveRiskDisposition({ ...input, reason: ' ' }), /无效/);
    await assert.rejects(store.saveRiskDisposition({ ...input, actorLabel: ' ' }), /无效/);
    await assert.rejects(store.saveRiskDisposition({ ...input, reason: 'x'.repeat(2001) }), /无效/);
    const first = await store.saveRiskDisposition(input); assert.equal(first.revision, 1);
    await assert.rejects(store.saveRiskDisposition({ ...input, findingId: saved.review.findings[1].id }), /发生变化/);
    const second = await store.saveRiskDisposition({ ...input, findingId: saved.review.findings[1].id, expectedRevision: 1, status: 'business_accepted', reason: '业务负责人决定承担该企业关注；并非法律确认。' });
    assert.equal(second.revision, 2); assert.deepEqual(second.events.slice(0, 1), first.events);
    const stamp = new Date().toISOString(); const text = saved.parsed.blocks[0].text;
    const proposal = { id: randomUUID(), reviewId: saved.review.id, documentId: saved.document.id, findingId: saved.review.findings[1].id, blockId: saved.parsed.blocks[0].id, rangeStart: 0, rangeEnd: text.length, originalText: text, replacementText: '按书面确认的进度付款。', sourceFileSha256: sha(text), originalTextSha256: sha(text), status: 'proposed' as const, explanation: '人工拟定。', warnings: [], modelId: null, createdAt: stamp, updatedAt: stamp };
    await store.saveChangeProposal(proposal, 0); await store.decideChangeProposal(saved.review.id, proposal.id, 'accepted', 1);
    assert.deepEqual(store.getRiskDispositions(saved.review.id), second);
    const third = await store.saveRiskDisposition({ ...input, expectedRevision: 2, status: 'fixed', reason: '人工声明已处理，保留审核原意见。' });
    assert.equal(third.revision, 3); assert.deepEqual(third.events.slice(0, 2), second.events);
    assert.deepEqual(store.getReview(saved.review.id), original);
    assert.deepEqual(store.rows('SELECT content_json,input_manifest_json FROM reports WHERE id=?', [saved.review.id])[0], reportsBefore);
    assert.ok(store.rows('SELECT legal_review_status FROM findings WHERE analysis_run_id=?', [saved.runId]).every(row => row.legal_review_status === 'unreviewed'));
    assert.throws(() => store!.rows("UPDATE risk_disposition_events SET reason='覆盖历史'"), /immutable/);
    assert.throws(() => store!.rows('DELETE FROM risk_disposition_events'), /immutable/);
    assert.deepEqual(store.rows('SELECT revision FROM risk_disposition_events WHERE review_id=? ORDER BY revision', [saved.review.id]).map(row => row.revision), [1, 2, 3]);
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(store.getRiskDispositions(saved.review.id), third); assert.deepEqual(store.getReview(saved.review.id), original);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('风险历史完整保留最多1000条，按revision排序而不是同毫秒时间或UUID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-risk-history-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); await store.saveReview(saved.review, saved.runId);
    await store.transaction(() => {
      const stamp = '2026-01-01T00:00:00.000Z';
      store!.rows('INSERT INTO risk_disposition_workspaces(review_id,revision,created_at,updated_at) VALUES(?,?,?,?)', [saved.review.id, 0, stamp, stamp]);
      for (let index = 0; index < 1000; index++) {
        const id = `00000000-0000-4000-8000-${String(1000 - index).padStart(12, '0')}`;
        store!.rows('INSERT INTO risk_disposition_events(id,review_id,finding_id,revision,status,reason,actor_label,created_at) VALUES(?,?,?,?,?,?,?,?)', [id, saved.review.id, saved.review.findings[0].id, index + 1, index % 2 ? 'needs_information' : 'confirmed', `历史${index + 1}`, '测试', stamp]);
        store!.rows('UPDATE risk_disposition_workspaces SET revision=revision+1 WHERE review_id=?', [saved.review.id]);
      }
    });
    const before = store.getRiskDispositions(saved.review.id); assert.equal(before.events.length, 1000); assert.equal(before.events[0].reason, '历史1'); assert.equal(before.events[999].reason, '历史1000');
    await assert.rejects(store.saveRiskDisposition({ reviewId: saved.review.id, findingId: saved.review.findings[0].id, expectedRevision: 1000, status: 'escalated', reason: '达到上限后不截断历史。', actorLabel: '法务' }), /1000条/);
    assert.deepEqual(store.getRiskDispositions(saved.review.id), before);
    await store.close(); store = await AppStore.open(dir); assert.deepEqual(store.getRiskDispositions(saved.review.id), before);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('标准/已发布版本/风险处置严格工作空间及意见归属，异作用域ID不可读取或提交', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-assurance-scope-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const { profile, version } = await published(store); const saved = await fixture(store); const other = await fixture(store);
    await store.saveReview(saved.review, saved.runId); await store.saveReview(other.review, other.runId);
    await assert.rejects(store.saveRiskDisposition({ reviewId: saved.review.id, findingId: other.review.findings[0].id, expectedRevision: 0, status: 'confirmed', reason: '错误关联', actorLabel: '法务' }), /不属于/);
    const foreignWorkspace = randomUUID(); const stamp = new Date().toISOString();
    store.rows('INSERT INTO workspaces(id,name,company_name,created_at,updated_at) VALUES(?,?,?,?,?)', [foreignWorkspace, '另一工作空间', null, stamp, stamp]);
    store.rows('UPDATE rule_sets SET workspace_id=? WHERE id=?', [foreignWorkspace, profile.id]);
    assert.deepEqual(store.listEnterpriseStandards(), []); assert.throws(() => store!.getEnterpriseStandard(profile.id), /不属于/); assert.throws(() => store!.getEnterpriseStandardVersion(version.id), /不属于/);
    await assert.rejects(store.saveEnterpriseStandard({ standardId: profile.id, expectedRevision: 2, content: content() }), /不属于/);
    await assert.rejects(store.publishEnterpriseStandard({ standardId: profile.id, expectedRevision: 2, publishedBy: '他人' }), /不属于/);
    await assert.rejects(store.createTask({ ...saved.task, id: randomUUID() }, context, 'local', null, null, version), /不属于/);
    store.rows('UPDATE contracts SET workspace_id=? WHERE id=(SELECT contract_id FROM document_versions WHERE id=?)', [foreignWorkspace, saved.document.id]);
    assert.throws(() => store!.getRiskDispositions(saved.review.id), /不属于/);
    await assert.rejects(store.saveRiskDisposition({ reviewId: saved.review.id, findingId: saved.review.findings[0].id, expectedRevision: 0, status: 'confirmed', reason: '越界提交', actorLabel: '法务' }), /不属于/);
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM risk_disposition_workspaces')[0].n, 0);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('企业标准最多100个，达到上限仍可编辑已有草稿且不插入第101个', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-enterprise-bound-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const first = await store.saveEnterpriseStandard({ expectedRevision: 0, content: content('标准0') });
    await store.transaction(() => {
      for (let index = 1; index < 100; index++) {
        const id = randomUUID(); const value = normalizeEnterpriseStandardContent(content(`标准${index}`)); const stamp = new Date().toISOString();
        store!.rows('INSERT INTO rule_sets(id,workspace_id,name,archived_at,created_at) VALUES(?,?,?,?,?)', [id, store!.workspaceId, value.name, null, stamp]);
        store!.rows('INSERT INTO enterprise_standard_drafts(standard_id,workspace_id,name,revision,content_json,content_sha256,updated_at) VALUES(?,?,?,?,?,?,?)', [id, store!.workspaceId, value.name, 1, JSON.stringify(value), sha(value), stamp]);
      }
    });
    await assert.rejects(store.saveEnterpriseStandard({ expectedRevision: 0, content: content('第101个') }), /最多保存100个/);
    const edited = await store.saveEnterpriseStandard({ standardId: first.id, expectedRevision: 1, content: { ...first.draft, description: '达到上限仍允许编辑。' } });
    assert.equal(edited.revision, 2); assert.equal(store.listEnterpriseStandards().length, 100);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('真实v5库升级保留原字节备份与旧审核/规则ID，v6新表和外键重启可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-assurance-v5-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); await store.saveReview(saved.review, saved.runId);
    const existingRules = store.rows('SELECT * FROM rule_set_versions'); const legacy = await legacyImage(store, 5);
    assert.deepEqual(legacy.exec('PRAGMA foreign_key_check'), []); const bytes = Buffer.from(legacy.export()); legacy.close();
    await store.close(); store = undefined; await writeFile(join(dir, 'workspace.sqlite'), bytes);
    store = await AppStore.open(dir); assert.equal(store.rows('SELECT MAX(version) AS n FROM schema_version')[0].n, 7);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite.v5-backup')), bytes);
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'workspace.sqlite.v5-backup'))).mode & 0o777, 0o600);
    assert.deepEqual(store.rows('SELECT * FROM rule_set_versions'), existingRules);
    assert.deepEqual(store.getReview(saved.review.id), saved.review); assert.deepEqual(store.listEnterpriseStandards(), []);
    assert.deepEqual(store.getRiskDispositions(saved.review.id), { reviewId: saved.review.id, revision: 0, events: [] });
    const { profile } = await published(store); await store.saveRiskDisposition({ reviewId: saved.review.id, findingId: saved.review.findings[0].id, expectedRevision: 0, status: 'needs_information', reason: '迁移后补充资料', actorLabel: '测试法务' });
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(store.getEnterpriseStandard(profile.id), profile); assert.equal(store.getRiskDispositions(saved.review.id).revision, 1);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite.v5-backup')), bytes);
    assert.equal(store.rows('PRAGMA foreign_keys')[0].foreign_keys, 1); assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('v1直升v6保留每个顺序中间版本备份，旧报告和原始规则不变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-assurance-v1-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); await store.saveReview(saved.review, saved.runId);
    const legacy = await legacyImage(store, 1); const bytes = Buffer.from(legacy.export()); legacy.close();
    await store.close(); store = undefined; await writeFile(join(dir, 'workspace.sqlite'), bytes); store = await AppStore.open(dir);
    const SQL = await initSqlJs();
    for (let version = 1; version <= 5; version++) {
      const backup = await readFile(join(dir, `workspace.sqlite.v${version}-backup`)); if (version === 1) assert.deepEqual(backup, bytes);
      const db = new SQL.Database(backup); assert.equal(Number(db.exec('SELECT MAX(version) FROM schema_version')[0].values[0][0]), version); assert.deepEqual(db.exec('PRAGMA foreign_key_check'), []); db.close();
    }
    assert.deepEqual(store.getReview(saved.review.id), saved.review); assert.deepEqual(store.getRiskDispositions(saved.review.id).events, []);
    assert.equal(store.rows('SELECT MAX(version) AS n FROM schema_version')[0].n, 7);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('v5外键损坏拒绝v6迁移，原数据库与原字节备份均不改写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-assurance-v5-failed-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store); await store.saveReview(saved.review, saved.runId);
    const legacy = await legacyImage(store, 5); legacy.run("UPDATE report_sources SET document_version_id='missing-document' WHERE document_version_id IS NOT NULL");
    const bytes = Buffer.from(legacy.export()); legacy.close(); await store.close(); store = undefined; await writeFile(join(dir, 'workspace.sqlite'), bytes);
    await assert.rejects(AppStore.open(dir), /关系校验失败/);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite')), bytes); assert.deepEqual(await readFile(join(dir, 'workspace.sqlite.v5-backup')), bytes);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});
