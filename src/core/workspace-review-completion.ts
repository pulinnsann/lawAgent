import { createHash, randomUUID } from 'node:crypto';
import { clauseAlignmentSnapshot } from './workspace-clause-alignment';
import { z } from 'zod';
import type { EnterpriseStandardSnapshot } from '../shared/assurance';
import type { ReviewResult, SourceEvidence } from '../shared/contracts';
import { defaultReviewWorkflow, type ReviewCompletionReport, type ReviewCompletionSnapshot, type ReviewCompletionWorkspace, type ReviewFactsAsset, type ReviewFactsBody, type ReviewFreshness, type ReviewInformationItem, type ReviewWorkflowDefinition, type ReviewWorkflowRunAsset, type ReviewWorkflowRunBody, type SourceVerificationAsset, type SourceVerificationBody, type SourceVerificationHistory } from '../shared/review-completion';
import type { AppStore } from './storage';
import type { WorkspaceAssets } from './workspace-assets';
import { normalizeReviewWorkflow } from './review-workflow';
import { readKnowledgeSourceMetadata, type KnowledgeSourceMetadataSnapshot } from './knowledge-source-metadata';

export interface ReviewCompletionDeps { store: AppStore; assets: WorkspaceAssets; dataDir?: string }
const FACTS = 'review_information', RUN = 'review_workflow', SOURCE = 'source_verification';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
const id = z.string().uuid();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const prose = (max: number) => z.string().trim().max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(value), '文字包含无效字符。');
const line = (max: number) => prose(max).refine(value => !/[\r\n\t]/u.test(value)).refine(value => value.length > 0);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => { const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value; }, '日期无效。');
const itemSchema = z.object({ id, kind: z.enum(['fact', 'assumption', 'question']), label: line(160), detail: prose(4000), status: z.enum(['pending', 'confirmed', 'not_applicable']), required: z.boolean(), scopes: z.array(line(120)).max(12), blockIds: z.array(id).max(20), quote: prose(2000), reason: prose(2000) }).strict().refine(item => item.status === 'pending' || item.reason.length > 0, '确认或不适用时须填写理由。');
const factsSchema = z.object({ documentId: id, expectedRevision: revision, actorLabel: line(80), items: z.array(itemSchema).max(200), reason: line(1000) }).strict().refine(value => new Set(value.items.map(item => item.id)).size === value.items.length, '资料条目标识不能重复。');
const sourceSchema = z.object({ reviewId: id, evidenceId: id, expectedRevision: revision, actorLabel: line(80), status: z.enum(['not_verified', 'pending', 'verified']), authenticity: prose(2000), legalEffect: prose(2000), applicableFrom: day.nullable(), applicableTo: day.nullable(), applicableScope: prose(2000), conflictReason: prose(2000), reason: line(2000) }).strict().refine(value => !value.applicableFrom || !value.applicableTo || value.applicableFrom <= value.applicableTo, '适用日期范围倒置。').refine(value => value.status !== 'verified' || Boolean(value.authenticity && value.legalEffect && value.applicableScope), '标记人工核实须填写真实性、效力及适用范围说明。');
const queues = new WeakMap<WorkspaceAssets, Promise<unknown>>();
function serialize<T>(deps: ReviewCompletionDeps, operation: () => Promise<T>): Promise<T> { const next = (queues.get(deps.assets) ?? Promise.resolve()).then(operation, operation); queues.set(deps.assets, next.catch(() => {})); return next; }
function checked<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new Error(`审核资料输入无效：${result.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).slice(0, 4).join('；')}`); return result.data; }
function factsFor(deps: ReviewCompletionDeps, documentId: string): ReviewFactsAsset | null {
  const values = deps.assets.list(FACTS).filter(asset => asset.body.documentId === documentId) as ReviewFactsAsset[];
  if (values.length > 1) throw new Error('该文档存在多份资料集，请先核对记录，未擅自选择。');
  const value = values[0] ?? null;
  if (value && value.body.documentSha256 !== deps.store.getDocumentArtifact(documentId).sha256) throw new Error('资料集绑定的原文件哈希不一致。');
  return value;
}
function planOf(standard?: EnterpriseStandardSnapshot): ReviewWorkflowDefinition { return normalizeReviewWorkflow(structuredClone(standard?.content.workflow.plan ?? defaultReviewWorkflow())); }
function frozenOf(review: ReviewResult): ReviewCompletionSnapshot | null { return (review as ReviewResult & { completionSnapshot?: ReviewCompletionSnapshot }).completionSnapshot ?? null; }
function assertSnapshot(deps: ReviewCompletionDeps, snapshot: ReviewCompletionSnapshot, documentId: string) {
  if (snapshot.schemaVersion !== 1 || snapshot.documentId !== documentId || snapshot.documentSha256 !== deps.store.getDocumentArtifact(documentId).sha256) throw new Error('审核流程快照与原文版本不一致。');
  normalizeReviewWorkflow(snapshot.workflow);
  if (snapshot.facts) {
    const pinned = deps.assets.history(snapshot.facts.id).find(asset => asset.kind === FACTS && asset.revision === snapshot.facts!.revision);
    if (!pinned || pinned.contentSha256 !== snapshot.facts.contentSha256 || digest(pinned.body) !== digest(snapshot.facts.body) || pinned.body.documentId !== documentId) throw new Error('审核资料快照未通过历史版本核对。');
  }
  if (snapshot.standardVersionId) { const standard = deps.store.getEnterpriseStandardVersion(snapshot.standardVersionId); if (standard.contentSha256 !== snapshot.standardSha256 || digest(planOf(standard)) !== digest(snapshot.workflow)) throw new Error('流程快照不属于冻结的已发布标准。'); }
}
export interface BeforeReviewWorkflow {
  snapshot: ReviewCompletionSnapshot; run: ReviewWorkflowRunAsset; paused: boolean;
  reasons: string[]; runProgramChecks: boolean; retrieveSources: boolean;
}
function pendingItems(items: ReviewInformationItem[]) { return items.filter(item => item.status === 'pending'); }
/** Persist a new execution checkpoint before any paid request. A paused run is
 * resumed by collecting information and preparing a new pinned checkpoint. */
export function getWorkflowBeforeReview(deps: ReviewCompletionDeps, documentId: string, standard?: EnterpriseStandardSnapshot, actorLabel = '法务'): Promise<BeforeReviewWorkflow> {
  return serialize(deps, async () => {
    id.parse(documentId); deps.store.getDocument(documentId);
    if (standard) { const original = deps.store.getEnterpriseStandardVersion(standard.id); if (original.contentSha256 !== standard.contentSha256 || digest(original) !== digest(standard)) throw new Error('只能采用本工作区真实已发布的标准快照。'); }
    const facts = factsFor(deps, documentId); const items = facts?.body.items ?? []; const missing = pendingItems(items); const required = missing.filter(item => item.required);
    const workflow = planOf(standard); const collect = workflow.nodes.find(node => node.kind === 'collect_information');
    const paused = Boolean(collect && collect.onMissing !== 'continue_limited' && required.length);
    const reasons = required.map(item => `必需资料待确认：${item.label}（影响 ${item.scopes.join('、') || '整体审核'}）`);
    const limitations = missing.map(item => `待确认${item.kind === 'assumption' ? '假设' : item.kind === 'question' ? '问题' : '事实'}：${item.label}；影响 ${item.scopes.join('、') || '整体审核'}。`);
    if (!facts) limitations.push('未登记结构化业务资料；没有登记不能证明资料齐全。');
    if (required.length && !paused) limitations.push('本流程允许带必需资料缺口继续，仅能在明确假设和范围限制下审核。');
    const runId = randomUUID();
    const snapshot: ReviewCompletionSnapshot = { schemaVersion: 1, capturedAt: stamp(), documentId, documentSha256: deps.store.getDocumentArtifact(documentId).sha256, facts: facts ? structuredClone(facts) : null, workflow, workflowRunId: runId, standardVersionId: standard?.id ?? null, standardSha256: standard?.contentSha256 ?? null, limitations };
    const nodes: ReviewWorkflowRunBody['nodes'] = workflow.nodes.map(node => ({ id: node.id, kind: node.kind, state: node.kind === 'collect_information' ? paused ? 'paused' : 'completed' : node.when === 'has_pending_information' && !missing.length ? 'skipped' : 'pending', reason: node.kind === 'collect_information' ? paused ? reasons.join('；') : '已记录当前资料状态；仍需结合资料局限。' : node.when === 'has_pending_information' && !missing.length ? '没有待确认资料，按条件跳过。' : '尚未执行。' }));
    const body: ReviewWorkflowRunBody = { documentId, reviewId: null, snapshot, state: paused ? 'paused_information' : 'ready', nodes, reason: paused ? '必需资料缺失，审核调用尚未开始。' : '资料检查点已冻结，可开始审核。' };
    const run = await deps.assets.save({ id: runId, kind: RUN, expectedRevision: 0, body, actorLabel }) as ReviewWorkflowRunAsset;
    const enabled = (kind: 'program_checks' | 'retrieve_sources') => !paused && nodes.some(node => node.kind === kind && node.state !== 'skipped');
    return { snapshot, run, paused, reasons, runProgramChecks: enabled('program_checks'), retrieveSources: enabled('retrieve_sources') };
  });
}
function highRiskOpen(deps: ReviewCompletionDeps, review: ReviewResult, all = false): number {
  const latest = new Map(deps.store.getRiskDispositions(review.id).events.map(event => [event.findingId, event.status]));
  return review.findings.filter(finding => (all || finding.severity === 'high') && !['business_accepted', 'fixed', 'false_positive'].includes(latest.get(finding.id) ?? 'unreviewed')).length;
}
/** Call only after saveReview succeeds, so human disposition is bound to a
 * persisted report. Failures/cancellations never become completed runs. */
export function getWorkflowAfterReview(deps: ReviewCompletionDeps, review: ReviewResult, snapshot = frozenOf(review), actorLabel = '法务'): Promise<ReviewWorkflowRunAsset | null> {
  return serialize(deps, async () => {
    const stored = deps.store.getReview(review.id);
    if (stored.documentId !== review.documentId || !snapshot) return null;
    assertSnapshot(deps, snapshot, review.documentId);
    if (!snapshot.workflowRunId) return null;
    const current = deps.assets.get(snapshot.workflowRunId) as ReviewWorkflowRunAsset;
    if (current.kind !== RUN || current.deleted || current.body.documentId !== review.documentId || current.body.snapshot.workflowRunId !== current.id || digest(current.body.snapshot) !== digest(snapshot) || current.body.reviewId && current.body.reviewId !== review.id || current.body.state === 'paused_information') throw new Error('审核运行记录不匹配或尚处于补资料暂停状态。');
    let waiting = false;
    const nodes = snapshot.workflow.nodes.map(node => {
      const before = current.body.nodes.find(item => item.id === node.id)!;
      if (before.state === 'skipped') return before;
      if (node.kind === 'human_risk_disposition') {
        const applies = node.when === 'always' || review.findings.some(finding => finding.severity === 'high');
        const open = applies ? highRiskOpen(deps, stored, node.when === 'always') : 0; waiting ||= open > 0;
        return { id: node.id, kind: node.kind, state: !applies ? 'skipped' as const : open ? 'paused' as const : 'completed' as const, reason: !applies ? '没有高风险意见，按条件跳过。' : open ? `${open} 项意见尚需人工处置；本节点不构成团队审批。` : '相关意见已登记人工处置，保留原风险判断。' };
      }
      if (node.kind === 'program_checks' && (!review.programChecks || review.programChecks.checks.every(check => check.status === 'disabled'))) return { id: node.id, kind: node.kind, state: 'skipped' as const, reason: '未保存启用的程序核验结果。' };
      if (node.kind === 'retrieve_sources' && !review.retrieval?.attempts.length) return { id: node.id, kind: node.kind, state: 'skipped' as const, reason: '本次未执行资料检索；以审核覆盖局限为准。' };
      return { id: node.id, kind: node.kind, state: 'completed' as const, reason: node.kind === 'review' ? '已保存审核结果；完成表示技术流程完成，不是签署批准。' : '已保存该阶段记录；部分结果和失败以覆盖局限为准。' };
    });
    const body: ReviewWorkflowRunBody = { ...current.body, reviewId: review.id, nodes, state: waiting ? 'awaiting_human' : 'completed', reason: waiting ? '等待风险人工处置。' : '有限流程已完成；未作法律效力或签署批准。' };
    if (digest(body) === digest(current.body)) return current;
    return await deps.assets.save({ id: current.id, kind: RUN, expectedRevision: current.revision, body, actorLabel }) as ReviewWorkflowRunAsset;
  });
}
/** Deliberately excludes titles. A title alone cannot identify a legal version. */
export function sourceIdentity(source: SourceEvidence): string {
  if (source.localIndex) return `local:${source.localIndex.sourceFileId}`;
  if (source.connection?.documentId) return `connection:${source.connection.id}:${source.connection.documentId}`;
  if (source.sourceUri) { try { const url = new URL(source.sourceUri); url.hash = ''; return `uri:${url.href}`; } catch { return `uri:${source.sourceUri}`; } }
  return `evidence:${source.id}`;
}
function sourceVersion(source: SourceEvidence): string | null { const version = source.localIndex?.fileSha256 || source.connection?.version || source.officialMetadata?.versionLabel || null; return version && !/^(?:unknown|unknown_version|未知|未提供)$/iu.test(version.trim()) && !/待核验|版本未知/u.test(version) ? version : null; }
function evidenceHash(source: SourceEvidence): string { return digest({ identity: sourceIdentity(source), excerptSha256: source.excerptSha256, version: source.localIndex?.fileSha256 || source.connection?.version || source.officialMetadata?.versionLabel || null, locator: source.locator }); }
export function getSourceVerificationHistories(deps: ReviewCompletionDeps, review: ReviewResult): SourceVerificationHistory[] {
  return (deps.assets.list(SOURCE) as SourceVerificationAsset[]).filter(asset => asset.body.reviewId === review.id).map(current => {
    const evidence = review.retrieval?.evidence.find(item => item.id === current.body.evidenceId);
    if (!evidence || evidenceHash(evidence) !== current.body.evidenceSha256 || sourceIdentity(evidence) !== current.body.evidenceIdentity || current.body.documentId !== review.documentId) throw new Error('来源人工核验记录与冻结来源不一致。');
    return { evidenceId: evidence.id, current, history: deps.assets.history(current.id) as SourceVerificationAsset[] };
  });
}
export function buildReviewCompletionReport(deps: ReviewCompletionDeps, review: ReviewResult): ReviewCompletionReport {
  const frozen = frozenOf(review); if (frozen) assertSnapshot(deps, frozen, review.documentId);
  return { frozen: frozen ? structuredClone(frozen) : null, currentFacts: factsFor(deps, review.documentId), workflowRuns: (deps.assets.list(RUN) as ReviewWorkflowRunAsset[]).filter(asset => asset.body.reviewId === review.id), sourceVerifications: getSourceVerificationHistories(deps, review) };
}
export interface ReviewFreshnessContext {
  sources: Map<string, Array<{ reviewCreatedAt: string; evidence: SourceEvidence }>>;
  complete: boolean;
  local?: KnowledgeSourceMetadataSnapshot;
}
/** Reports reuse this bounded index instead of reparsing every later report
 * once per review. It contains saved observations, not a claim of current law. */
export function createReviewFreshnessContext(deps: ReviewCompletionDeps, after = ''): ReviewFreshnessContext {
  const rows = deps.store.rows("SELECT content_json FROM reports WHERE workspace_id=? AND kind='risk' AND created_at>? ORDER BY created_at DESC LIMIT 10001", [deps.store.workspaceId, after]);
  const sources: ReviewFreshnessContext['sources'] = new Map();
  for (const row of rows.slice(0, 10000)) {
    const review = JSON.parse(String(row.content_json)).review as ReviewResult | undefined;
    if (!review) continue;
    for (const evidence of review.retrieval?.evidence ?? []) { const identity = sourceIdentity(evidence); const entries = sources.get(identity) ?? []; entries.push({ reviewCreatedAt: review.createdAt, evidence }); sources.set(identity, entries); }
  }
  const sourceFileIds = [...sources.values()].flatMap(items => items.flatMap(item => item.evidence.localIndex?.sourceFileId ?? []));
  return { sources, complete: rows.length <= 10000, local: readKnowledgeSourceMetadata(deps.dataDir, sourceFileIds) };
}
/** Compare known local records, never claim that an online law is currently
 * valid. Only same-contract successors and same-source explicit versions count. */
export function getReviewFreshness(deps: ReviewCompletionDeps, review: ReviewResult, checkedAt = stamp(), comparison?: ReviewFreshnessContext): ReviewFreshness {
  const reasons: ReviewFreshness['reasons'] = [];
  const limitations = ['仅比较本工作区已知版本；未联网探测法规效力、最新案例或外部知识库更新。新版本提示需要人工核对后重审，不自动替换历史报告。'];
  const currentDocument = deps.store.rows('SELECT d.contract_id,d.version_no FROM document_versions d JOIN contracts c ON c.id=d.contract_id WHERE d.id=? AND c.workspace_id=?', [review.documentId, deps.store.workspaceId])[0];
  if (!currentDocument) throw new Error('审核原文不属于当前工作区。');
  const latest = deps.store.rows('SELECT id,version_no FROM document_versions WHERE contract_id=? ORDER BY version_no DESC LIMIT 1', [currentDocument.contract_id])[0];
  if (latest && Number(latest.version_no) > Number(currentDocument.version_no)) reasons.push({ kind: 'document', message: `同一合同已有文档 v${latest.version_no}；本报告仍分析 v${currentDocument.version_no}。`, previous: review.documentId, current: String(latest.id) });
  if (review.standardSnapshot) {
    const versions = deps.store.getEnterpriseStandard(review.standardSnapshot.standardId).versions;
    const newest = versions.at(-1);
    if (newest && newest.versionNo > review.standardSnapshot.versionNo) reasons.push({ kind: 'standard', message: `同一企业标准已发布 v${newest.versionNo}，本报告采用 v${review.standardSnapshot.versionNo}。${newest.contentSha256 === review.standardSnapshot.contentSha256 ? '内容摘要相同，可先核对版本记录。' : ''}`, previous: review.standardSnapshot.id, current: newest.id });
  }
  const frozen = frozenOf(review); const currentFacts = factsFor(deps, review.documentId);
  if (currentFacts && (!frozen?.facts || frozen.facts.id !== currentFacts.id || frozen.facts.revision !== currentFacts.revision)) reasons.push({ kind: 'information', message: '业务事实、假设或待确认信息在本报告冻结快照后有更新。', previous: frozen?.facts ? `${frozen.facts.id}:r${frozen.facts.revision}` : null, current: `${currentFacts.id}:r${currentFacts.revision}` });
  if (!frozen) limitations.push('历史报告没有结构化资料与流程快照，不能补认其当时已确认的事实。');
  const contractId=String(currentDocument.contract_id);
  const hasAlignment=deps.assets.list('clause_alignment').some(asset=>asset.body.contractId===contractId&&asset.body.state!=='disabled');
  if(review.alignmentSnapshot||hasAlignment){
    const alignment=clauseAlignmentSnapshot(deps,contractId,review.documentId);
    if(review.alignmentSnapshot?.contentSha256!==alignment.contentSha256)reasons.push({kind:'alignment',message:'多语条款对应、差异复核或优先文本约定有更新；历史审核仍采用原快照。',previous:review.alignmentSnapshot?.contentSha256??null,current:alignment.contentSha256});
  }
  const evidence = review.retrieval?.evidence ?? [];
  let localUnknown = false;
  if (evidence.length) {
    comparison ??= createReviewFreshnessContext(deps, review.createdAt);
    if (!comparison.complete) limitations.push('来源版本比较范围超过10000轮，比较尚未完成；未静默认定来源最新。');
    for (const source of evidence) {
      const previous = sourceVersion(source);
      const newer = comparison.sources.get(sourceIdentity(source))?.find(candidate => Date.parse(candidate.reviewCreatedAt) > Date.parse(review.createdAt) && previous && sourceVersion(candidate.evidence) && previous !== sourceVersion(candidate.evidence));
      if (newer) reasons.push({ kind: 'source', message: `来源“${source.title}”在后续检索中出现不同版本标识；须核对适用时间和内容。`, previous, current: sourceVersion(newer.evidence) });
      if (!previous) limitations.push(`来源“${source.title}”没有可比较的完整版本标识；不同检索片段不能当作版本变更。`);
    }
    const localSources = evidence.filter(source => source.localIndex);
    if (localSources.length) {
      // A per-report observation can predate the shared comparison query's
      // lower bound. Ensure all cited local IDs are included in this read.
      const local = comparison.local && localSources.every(source => comparison!.local!.sources.has(source.localIndex!.sourceFileId)) ? comparison.local : readKnowledgeSourceMetadata(deps.dataDir, localSources.map(source => source.localIndex!.sourceFileId));
      limitations.push(...local.limitations);
      for (const source of localSources) {
        const original = source.localIndex!; const current = local.sources.get(original.sourceFileId);
        if (!current || current.status !== 'available') { localUnknown = true; limitations.push(`来源“${source.title}”：${current?.reason ?? '当前索引元数据比较未覆盖此来源，版本未知。'}`); continue; }
        if (current.fileSha256 !== original.fileSha256 || current.versionId !== original.versionId) reasons.push({ kind: 'source', message: `本地知识来源“${source.title}”已有不同文件或解析版本，旧报告仍引用原索引快照。`, previous: `${original.fileSha256}/${original.versionId}`, current: `${current.fileSha256}/${current.versionId}` });
      }
    }
  }
  for (const verification of getSourceVerificationHistories(deps, review)) if (Date.parse(verification.current.updatedAt) > Date.parse(review.createdAt)) reasons.push({ kind: 'verification', message: `来源“${evidence.find(item => item.id === verification.evidenceId)?.title ?? verification.evidenceId}”新增或更新了人工核验说明。`, previous: null, current: `${verification.current.id}:r${verification.current.revision}` });
  return { checkedAt, status: reasons.length ? 'updates_available' : !frozen || localUnknown || comparison?.complete === false || evidence.some(source => !sourceVersion(source)) ? 'unknown' : 'no_known_updates', reasons, limitations: [...new Set(limitations)] };
}
export function getReviewCompletionWorkspace(deps: ReviewCompletionDeps, documentId: string, reviewId?: string, standardVersionId?: string): ReviewCompletionWorkspace {
  deps.store.getDocument(id.parse(documentId));
  const review = reviewId ? deps.store.getReview(id.parse(reviewId)) : null;
  if (review && review.documentId !== documentId) throw new Error('审核不属于所选文档版本。');
  const standard = standardVersionId ? deps.store.getEnterpriseStandardVersion(id.parse(standardVersionId)) : review?.standardSnapshot;
  const facts = factsFor(deps, documentId);
  return { facts, factsHistory: facts ? deps.assets.history(facts.id) as ReviewFactsAsset[] : [], workflow: planOf(standard), runs: (deps.assets.list(RUN) as ReviewWorkflowRunAsset[]).filter(asset => asset.body.documentId === documentId), sourceVerifications: review ? getSourceVerificationHistories(deps, review) : [], freshness: review ? getReviewFreshness(deps, review) : null };
}
export async function runReviewCompletionCommand(action: string, payload: unknown, deps: ReviewCompletionDeps): Promise<unknown> {
  if (action === 'reviewCompletion.get') { const value = checked(z.object({ documentId: id, reviewId: id.optional(), standardVersionId: id.optional() }).strict(), payload); return getReviewCompletionWorkspace(deps, value.documentId, value.reviewId, value.standardVersionId); }
  if (action === 'reviewCompletion.workflow.prepare') { const value = checked(z.object({ documentId: id, standardVersionId: id.optional(), actorLabel: line(80) }).strict(), payload); return getWorkflowBeforeReview(deps, value.documentId, value.standardVersionId ? deps.store.getEnterpriseStandardVersion(value.standardVersionId) : undefined, value.actorLabel); }
  if (action === 'reviewCompletion.workflow.refresh') { const value = checked(z.object({ reviewId: id, actorLabel: line(80) }).strict(), payload); return getWorkflowAfterReview(deps, deps.store.getReview(value.reviewId), undefined, value.actorLabel); }
  if (action === 'reviewCompletion.freshness') { const value = checked(z.object({ reviewId: id }).strict(), payload); return getReviewFreshness(deps, deps.store.getReview(value.reviewId)); }
  if (action === 'reviewCompletion.facts.save') return serialize(deps, async () => {
    const value = checked(factsSchema, payload); const document = deps.store.getDocument(value.documentId); const current = factsFor(deps, document.id);
    for (const item of value.items) { if (item.blockIds.some(blockId => !document.blocks.some(block => block.id === blockId))) throw new Error('资料关联的段落不属于所选合同。'); if (item.quote && !item.blockIds.some(blockId => document.blocks.find(block => block.id === blockId)?.text.includes(item.quote))) throw new Error('资料引文未在关联的原文段落中精确匹配。'); }
    const body: ReviewFactsBody = { documentId: document.id, documentSha256: deps.store.getDocumentArtifact(document.id).sha256, items: value.items, reason: value.reason };
    return deps.assets.save({ ...(current ? { id: current.id } : {}), kind: FACTS, expectedRevision: value.expectedRevision, body, actorLabel: value.actorLabel });
  });
  if (action === 'reviewCompletion.source.save') return serialize(deps, async () => {
    const value = checked(sourceSchema, payload); const review = deps.store.getReview(value.reviewId); const source = review.retrieval?.evidence.find(evidence => evidence.id === value.evidenceId);
    if (!source) throw new Error('来源不属于所选审核的冻结依据。');
    const values = (deps.assets.list(SOURCE) as SourceVerificationAsset[]).filter(asset => asset.body.reviewId === review.id && asset.body.evidenceId === source.id);
    if (values.length > 1) throw new Error('来源存在多份核验记录，请先核对。');
    const current = values[0]; const { expectedRevision, actorLabel, ...bodyInput } = value;
    const body: SourceVerificationBody = { ...bodyInput, documentId: review.documentId, evidenceSha256: evidenceHash(source), evidenceIdentity: sourceIdentity(source) };
    return deps.assets.save({ ...(current ? { id: current.id } : {}), kind: SOURCE, expectedRevision, body, actorLabel });
  });
  throw new Error('未知的审核补全命令。');
}
