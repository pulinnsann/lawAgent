import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../src/core/storage';
import { WorkspaceAssets } from '../src/core/workspace-assets';
import { getReviewCompletionWorkspace, getReviewFreshness, getWorkflowAfterReview, getWorkflowBeforeReview, runReviewCompletionCommand, sourceIdentity } from '../src/core/workspace-review-completion';
import { normalizeEnterpriseStandardContent } from '../src/core/enterprise-standards';
import { normalizeReviewWorkflow } from '../src/core/review-workflow';
import { buildReportSnapshot, reportHtml, reportMarkdown, runReportingCommand } from '../src/core/reporting';
import { defaultEnterpriseStandard, type EnterpriseStandardSnapshot } from '../src/shared/assurance';
import { defaultRetrievalConfig, type ContractDetail, type ReviewContext, type ReviewResult, type ReviewTask, type SourceEvidence } from '../src/shared/contracts';
import { defaultReviewWorkflow, type ReviewCompletionSnapshot, type ReviewFactsAsset, type ReviewInformationItem, type SourceVerificationAsset } from '../src/shared/review-completion';
import { defaultReportSettings } from '../src/shared/reporting';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '合成工程资料，不调用模型。' };
const date = '2026-10-22T08:00:00.000Z';
const actorLabel = '合成人工标签';
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'law-completion-')); const store = await AppStore.open(dir); const assets = new WorkspaceAssets(store); return { dir, store, assets, close: async () => { await rm(dir, { recursive: true, force: true }); } }; }
async function document(store: AppStore, name = '合成服务合同.docx') { return store.addDocument(randomUUID(), name, `synthetic/${randomUUID()}.docx`, 100, sha(randomUUID()), { format: 'docx', language: 'zh', pageCount: null, partial: false, warnings: [], blocks: [{ id: randomUUID(), ordinal: 0, kind: 'paragraph', text: '甲方验收确认后支付服务价款。合同金额为人民币100元。', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/p[1]', paragraphId: null } }] }); }
function item(patch: Partial<ReviewInformationItem> = {}): ReviewInformationItem { return { id: randomUUID(), kind: 'question', label: '验收权限', detail: '请业务提供验收授权。', status: 'pending', required: true, scopes: ['付款条件'], blockIds: [], quote: '', reason: '', ...patch }; }
function facts(deps: Parameters<typeof runReviewCompletionCommand>[2], doc: ContractDetail, items: ReviewInformationItem[], expectedRevision = 0) { return runReviewCompletionCommand('reviewCompletion.facts.save', { documentId: doc.id, expectedRevision, actorLabel, items, reason: '合成资料修订说明' }, deps) as Promise<ReviewFactsAsset>; }
async function standard(store: AppStore, plan = defaultReviewWorkflow()) { let value = await store.saveEnterpriseStandard({ expectedRevision: 0, content: { ...defaultEnterpriseStandard(), name: `合成流程标准-${randomUUID().slice(0,8)}`, workflow: { runEnterpriseRules: true, highRiskHandling: 'manual_review', plan } } }); value = await store.publishEnterpriseStandard({ standardId: value.id, expectedRevision: value.revision, publishedBy: actorLabel }); return value.versions[0]; }
function source(version: string | null = '合成版本1', uri = 'https://www.court.gov.cn/synthetic-only/1.html'): SourceEvidence { const excerpt = '合成来源原文，仅用于工程验证。'; return { id: randomUUID(), attemptId: randomUUID(), channel: 'web', kind: 'judicial_interpretation', title: '合成同名材料', sourceUri: uri, locator: '第一条', excerpt, excerptSha256: sha(excerpt), contentScope: 'fragment', retrievedAt: date, publishedAt: null, effectiveAt: null, currentness: 'unknown', isOfficial: true, warnings: ['未核实效力'], officialMetadata: { publisher: '合成发布机关', documentNumber: null, versionLabel: version, discoveredVia: 'user_url', validityNote: '未知，须核实' } }; }
async function saveReview(deps: Parameters<typeof runReviewCompletionCommand>[2], doc: ContractDetail, snapshot?: ReviewCompletionSnapshot, enterprise?: EnterpriseStandardSnapshot, evidence: SourceEvidence[] = [], createdAt = date, high = true): Promise<ReviewResult> {
  const store = deps.store; const config = defaultRetrievalConfig(); config.official = { enabled: true, maxCatalogPages: 1, sourceUrls: [] };
  if (evidence.length) await store.saveConfig({ name: '合成配置，无网络调用', baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture-only', responseFormat: 'json_object', tokenParameter: 'max_tokens', maxOutputTokens: 1000, contextWindowTokens: 64000, timeoutSeconds: 5 });
  const task: ReviewTask = { id: randomUUID(), documentId: doc.id, status: 'queued', stage: 'synthetic-only', startedAt: createdAt, finishedAt: null, resultId: null, error: null };
  const runId = await store.createTask(task, context, evidence.length ? 'model' : 'local', evidence.length ? config : null, evidence.length ? store.getConfig() : null, enterprise);
  const result: ReviewResult = { id: randomUUID(), documentId: doc.id, createdAt, mode: evidence.length ? 'model' : 'local', modelId: evidence.length ? 'fixture-only' : null, summary: '合成审核，没有调用模型。', findings: [{ id: randomUUID(), blockIds: [doc.blocks[0].id], quote: doc.blocks[0].text, title: '合成关注', category: 'commercial', severity: high ? 'high' : 'low', description: '合成意见', suggestion: '人工确认', source: 'rule', basisStatus: 'unverified', legalBasis: null, locationStatus: 'matched', citations: [] }], context, coverage: { reviewedBlockIds: doc.blocks.map(block => block.id), totalBlockCount: 1, knowledgeStatus: 'user_disabled', webStatus: evidence.length ? 'complete' : 'user_disabled', limitations: [] }, inputTokens: null, outputTokens: null, elapsedMs: 1, ...(snapshot ? { completionSnapshot: snapshot } : {}), ...(enterprise ? { standardSnapshot: enterprise } : {}), ...(evidence.length ? { retrieval: { configSnapshot: config, knowledgeStatus: 'user_disabled', webStatus: 'complete', evidence, attempts: evidence.map(value => ({ id: value.attemptId, channel: 'web', provider: 'official_catalog', query: '合成查询', status: 'complete', startedAt: createdAt, finishedAt: createdAt, resultCount: 1, error: null, warnings: [] })), limitations: [] } as ReviewResult['retrieval'] } : {}) };
  await store.saveReview(result, runId); return result;
}

test('有限流程拒绝非法分支、重复、乱序及脚本，旧发布内容JSON及hash不变', async () => {
  const content = defaultEnterpriseStandard(); content.name = '旧标准'; delete content.checks.parties;
  const before = JSON.stringify(content); assert.equal(JSON.stringify(normalizeEnterpriseStandardContent(content)), before); assert.equal(sha(JSON.stringify(normalizeEnterpriseStandardContent(content))), sha(before)); assert.ok(!('plan' in normalizeEnterpriseStandardContent(content).workflow));
  const valid = defaultReviewWorkflow(); assert.deepEqual(normalizeReviewWorkflow(valid), valid);
  for (const value of [{ nodes: [] }, { nodes: [valid.nodes[3], valid.nodes[0]] }, { nodes: [valid.nodes[3], valid.nodes[3]] }, { nodes: [{ ...valid.nodes[3], when: 'has_high_risk' }] }, { nodes: [{ ...valid.nodes[1], when: 'has_high_risk' }, valid.nodes[3]] }, { ...valid, script: 'process.exit()' }]) assert.throws(() => normalizeReviewWorkflow(value), /流程/);
  const f = await fixture(); try { const published = await standard(f.store); const original = f.store.getEnterpriseStandardVersion(published.id); const profile = f.store.getEnterpriseStandard(published.standardId); await f.store.saveEnterpriseStandard({ standardId: profile.id, expectedRevision: profile.revision, content: { ...profile.draft, workflow: { ...profile.draft.workflow, plan: { nodes: [{ id: 'review', kind: 'review', when: 'always' }] } } } }); assert.deepEqual(f.store.getEnterpriseStandardVersion(published.id), original); } finally { await f.close(); }
});

test('事实清单真实持久化、CAS并发与原文绑定，确认理由和引文不可伪造', async () => {
  const f = await fixture(); try {
    const doc = await document(f.store); const value = item({ blockIds: [doc.blocks[0].id], quote: '甲方验收确认' });
    const attempts = await Promise.allSettled([facts(f, doc, [value]), facts(f, doc, [value])]); assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1); assert.equal(f.assets.list('review_information').length, 1);
    const saved = getReviewCompletionWorkspace(f, doc.id).facts!; assert.equal(saved.revision, 1);
    await assert.rejects(facts(f, doc, [{ ...value, status: 'confirmed' }], 1), /理由/);
    await assert.rejects(facts(f, doc, [{ ...value, quote: '不存在的模型引文' }], 1), /精确匹配/);
    await assert.rejects(facts(f, doc, [{ ...value, blockIds: [randomUUID()] }], 1), /不属于/);
    await facts(f, doc, [{ ...value, status: 'confirmed', reason: '业务已提供书面授权' }], 1);
    await assert.rejects(facts(f, doc, [], 1), /已更新/);
    await f.store.close();
    const reopened = await AppStore.open(f.dir);
    try { const workspace = getReviewCompletionWorkspace({ store: reopened, assets: new WorkspaceAssets(reopened) }, doc.id); assert.equal(workspace.factsHistory.length, 2); assert.equal(workspace.facts?.body.items[0].status, 'confirmed'); assert.equal(workspace.factsHistory[0].body.items[0].status, 'pending'); }
    finally { await reopened.close(); }
  } finally { await f.close(); }
});

test('必需资料暂停、补资料准备新检查点，条件分支实际改变执行开关且不补写旧快照', async () => {
  const f = await fixture(); try {
    const doc = await document(f.store); const question = item(); await facts(f, doc, [question]); const published = await standard(f.store);
    const paused = await getWorkflowBeforeReview(f, doc.id, published); assert.equal(paused.paused, true); assert.equal(paused.runProgramChecks, false); assert.equal(paused.retrieveSources, false); assert.match(paused.reasons[0], /付款条件/); assert.equal(f.store.rows('SELECT * FROM analysis_runs').length, 0);
    await facts(f, doc, [{ ...question, status: 'confirmed', reason: '附件已提供' }], 1);
    const ready = await getWorkflowBeforeReview(f, doc.id, published); assert.equal(ready.paused, false); assert.equal(ready.runProgramChecks, true); assert.equal(ready.snapshot.facts?.revision, 2); assert.equal(paused.snapshot.facts?.body.items[0].status, 'pending'); assert.equal(f.assets.history(paused.run.id).length, 1);
    const conditional = await standard(f.store, { nodes: [{ id: 'check', kind: 'program_checks', when: 'has_pending_information' }, { id: 'review', kind: 'review', when: 'always' }] });
    const skipped = await getWorkflowBeforeReview(f, doc.id, conditional); assert.equal(skipped.runProgramChecks, false); assert.equal(skipped.retrieveSources, false);
    await facts(f, doc, [{ ...question, required: false }], 2); const executes = await getWorkflowBeforeReview(f, doc.id, conditional); assert.equal(executes.runProgramChecks, true); assert.equal(executes.paused, false);
  } finally { await f.close(); }
});

test('高风险人工节点等待已保存处置，刷新后完成且模型等级、原报告与冻结事实不变', async () => {
  const f = await fixture(); try {
    const doc = await document(f.store); const fact = item({ kind: 'assumption', status: 'confirmed', reason: '业务确认作为本轮分析前提', required: false }); await facts(f, doc, [fact]); const ready = await getWorkflowBeforeReview(f, doc.id); const review = await saveReview(f, doc, ready.snapshot); const original = f.store.getReview(review.id);
    const waiting = await getWorkflowAfterReview(f, review); assert.equal(waiting?.body.state, 'awaiting_human'); assert.ok(waiting?.body.nodes.some(node => node.kind === 'human_risk_disposition' && node.state === 'paused'));
    await f.store.saveRiskDisposition({ reviewId: review.id, findingId: review.findings[0].id, expectedRevision: 0, status: 'fixed', reason: '人工核对并标记', actorLabel });
    const done = await getWorkflowAfterReview(f, review); assert.equal(done?.body.state, 'completed'); assert.equal(f.assets.history(ready.run.id).length, 3); assert.deepEqual(f.store.getReview(review.id), original);
    await facts(f, doc, [{ ...fact, detail: '后来业务改变了前提' }], 1); assert.ok(getReviewFreshness(f, review).reasons.some(reason => reason.kind === 'information')); assert.equal(f.store.getReview(review.id).completionSnapshot?.facts?.body.items[0].detail, fact.detail);
    const pausedFact = item(); await facts(f, doc, [pausedFact], 2); const paused = await getWorkflowBeforeReview(f, doc.id); const invalid = await saveReview(f, doc, paused.snapshot); await assert.rejects(getWorkflowAfterReview(f, invalid), /暂停/);
  } finally { await f.close(); }
});

test('来源人工核验保留三态及时间范围理由历史，不能替代自动效力状态或越界引用', async () => {
  const f = await fixture(); try {
    const doc = await document(f.store); const evidence = source(); const review = await saveReview(f, doc, undefined, undefined, [evidence]); const original = f.store.getReview(review.id);
    const base = { reviewId: review.id, evidenceId: evidence.id, expectedRevision: 0, actorLabel, status: 'verified', authenticity: '', legalEffect: '', applicableFrom: null, applicableTo: null, applicableScope: '', conflictReason: '', reason: '合成核验' };
    await assert.rejects(runReviewCompletionCommand('reviewCompletion.source.save', base, f), /真实性/);
    const first = await runReviewCompletionCommand('reviewCompletion.source.save', { ...base, status: 'pending' }, f) as SourceVerificationAsset;
    await assert.rejects(runReviewCompletionCommand('reviewCompletion.source.save', { ...base, expectedRevision: 1, authenticity: '已核官网', legalEffect: '律师人工核对', applicableScope: '特定合同', applicableFrom: '2026-10-23', applicableTo: '2026-10-22' }, f), /倒置/);
    await runReviewCompletionCommand('reviewCompletion.source.save', { ...base, expectedRevision: 1, authenticity: '人工核对官网原文', legalEffect: '法务核对效力说明，需结合实施日', applicableScope: '此合成合同验收事项', applicableFrom: '2026-10-01', conflictReason: '仅记录示例采信理由' }, f);
    await assert.rejects(runReviewCompletionCommand('reviewCompletion.source.save', { ...base, evidenceId: randomUUID(), status: 'not_verified' }, f), /不属于/);
    const workspace = getReviewCompletionWorkspace(f, doc.id, review.id); assert.equal(workspace.sourceVerifications[0].history.length, 2); assert.equal(workspace.sourceVerifications[0].current.id, first.id); assert.equal(workspace.sourceVerifications[0].current.body.status, 'verified'); assert.equal(workspace.sourceVerifications[0].history[0].body.status, 'pending'); assert.deepEqual(f.store.getReview(review.id), original); assert.equal(f.store.rows('SELECT verification_status,currentness FROM evidence WHERE id=?', [evidence.id])[0].verification_status, 'unverified'); assert.equal(original.retrieval?.evidence[0].currentness, 'unknown');
  } finally { await f.close(); }
});

test('过期比较只识别同合同新版本、同标准新发布和同来源显式版本，不凭标题或片段猜测', async () => {
  const f = await fixture(); try {
    const doc = await document(f.store); const published = await standard(f.store); const ready = await getWorkflowBeforeReview(f, doc.id, published); const old = source('版本1'); const review = await saveReview(f, doc, ready.snapshot, published, [old]);
    assert.equal(getReviewFreshness(f, review).status, 'no_known_updates');
    const other = await document(f.store, doc.name); await saveReview(f, other, undefined, undefined, [source('版本2', 'https://www.court.gov.cn/synthetic-only/different.html')], '2026-10-22T09:00:00.000Z');
    assert.ok(!getReviewFreshness(f, review).reasons.some(reason => reason.kind === 'source' || reason.kind === 'document'));
    await saveReview(f, other, undefined, undefined, [{ ...source('版本1'), excerpt: '另一个片段', excerptSha256: sha('另一个片段'), locator: '第二条' }], '2026-10-22T10:00:00.000Z'); assert.ok(!getReviewFreshness(f, review).reasons.some(reason => reason.kind === 'source'));
    await saveReview(f, other, undefined, undefined, [source('版本2')], '2026-10-22T11:00:00.000Z'); assert.ok(getReviewFreshness(f, review).reasons.some(reason => reason.kind === 'source'));
    const profile = f.store.getEnterpriseStandard(published.standardId); const draft = await f.store.saveEnterpriseStandard({ standardId: profile.id, expectedRevision: profile.revision, content: { ...profile.draft, description: '新标准草稿' } }); assert.ok(!getReviewFreshness(f, review).reasons.some(reason => reason.kind === 'standard')); await f.store.publishEnterpriseStandard({ standardId: draft.id, expectedRevision: draft.revision, publishedBy: actorLabel }); assert.ok(getReviewFreshness(f, review).reasons.some(reason => reason.kind === 'standard'));
    await f.store.transaction(() => { const row = f.store.rows('SELECT * FROM document_versions WHERE id=?', [doc.id])[0]; const next = { ...row, id: randomUUID(), version_no: 2, parent_version_id: doc.id, kind: 'revised' }; f.store.rows(`INSERT INTO document_versions(${Object.keys(next).join(',')}) VALUES(${Object.keys(next).map(() => '?').join(',')})`, Object.values(next)); }); assert.ok(getReviewFreshness(f, review).reasons.some(reason => reason.kind === 'document'));
    assert.notEqual(sourceIdentity(source('v1', 'https://a.example.test/one')), sourceIdentity(source('v2', 'https://a.example.test/two')));
  } finally { await f.close(); }
});

test('正式报告导出包含冻结事实、独立来源核验历史和更新理由，重读不覆盖历史审核', async () => {
  const f = await fixture(); try {
    const doc = await document(f.store); const fact = item({ status: 'confirmed', reason: '书面说明', kind: 'fact', detail: '合成授权事实', blockIds: [doc.blocks[0].id], quote: '甲方验收确认' }); await facts(f, doc, [fact]); const ready = await getWorkflowBeforeReview(f, doc.id); const evidence = source(); const review = await saveReview(f, doc, ready.snapshot, undefined, [evidence]); await getWorkflowAfterReview(f, review); const original = f.store.getReview(review.id);
    await runReviewCompletionCommand('reviewCompletion.source.save', { reviewId: review.id, evidenceId: evidence.id, expectedRevision: 0, actorLabel, status: 'not_verified', authenticity: '', legalEffect: '', applicableFrom: null, applicableTo: null, applicableScope: '', conflictReason: '需补充同层级冲突来源', reason: '暂不作采信判断' }, f);
    const snapshot = buildReportSnapshot({ scope: 'current', reviewId: review.id, style: 'management' }, f.store, defaultReportSettings(), new Date().toISOString(), f.assets); assert.equal(snapshot.reviews[0].completion?.frozen?.facts?.revision, 1); assert.equal(snapshot.reviews[0].completion?.sourceVerifications[0].history.length, 1); assert.equal(snapshot.reviews[0].freshness?.status, 'updates_available');
    const markdown = reportMarkdown(snapshot); assert.match(markdown, /合成授权事实/); assert.match(markdown, /暂不作采信判断/); assert.match(markdown, /本工作区已知版本/); assert.match(reportHtml(snapshot), /结构化事实/);
    const recorded = await runReportingCommand('reporting.recordExport', { format: 'html', sha256: sha(reportHtml(snapshot)), snapshot }, { ...f, service: null as never }) as { body: { snapshot: typeof snapshot } }; assert.deepEqual(recorded.body.snapshot, snapshot); assert.deepEqual(f.store.getReview(review.id), original);
  } finally { await f.close(); }
});
