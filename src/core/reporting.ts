import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { z } from 'zod';
import type { AppStore } from './storage';
import type { ContractService } from './service';
import type { WorkspaceAssets } from './workspace-assets';
import { getReviewAnnotations } from './workspace-library';
import { buildReviewCompletionReport, createReviewFreshnessContext, getReviewFreshness } from './workspace-review-completion';
import type { ReviewFinding } from '../shared/contracts';
import type { RiskDispositionStatus } from '../shared/assurance';
import type { ExperienceBody } from '../shared/library';
import { defaultReportSettings, type ReportRequest, type ReportSettings, type ReportSnapshot, type ReportingDocument, type ReportingRenderResult, type ReportingReview, type SavedReportSettings } from '../shared/reporting';
import type { ReportBlock, ReportLanguage } from '../shared/report-translation';
import { reportLabel } from '../shared/report-localization';
import { applyReportTranslation, assertTranslationExport, runReportTranslationCommand } from './report-translation';

const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff\ufffe\uffff]/gu, '');
const esc = (value: string) => clean(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const textSchema = (max: number) => z.string().trim().max(max).refine(value => !/[\u0000-\u001f\u007f]/u.test(value), '报告标签不能包含控制字符');
const settingsSchema = z.object({ language: z.enum(['zh', 'en', 'th']).default('zh'), organization: textSchema(160), authorLabel: textSchema(80), recipientLabel: textSchema(160), includeContractQuotes: z.boolean(), includeDispositionHistory: z.boolean() }).strict();
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => { const stamp = Date.parse(`${value}T00:00:00Z`); return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value; }, '日期无效');
const requestSchema = z.object({ scope: z.enum(['current', 'workspace']), reviewId: z.string().uuid().optional(), from: daySchema.optional(), to: daySchema.optional(), style: z.enum(['risk', 'management', 'summary']).default('management'), settings: settingsSchema.optional(), translationId: z.string().uuid().optional() }).strict();
const saveSettingsSchema = z.object({ id: z.string().uuid().optional(), expectedRevision: z.number().int().nonnegative(), body: settingsSchema, actorLabel: textSchema(80).min(1) }).strict();
const dispositionLabels: Record<RiskDispositionStatus, string> = { unreviewed: '待处理', confirmed: '人工确认关注', needs_information: '待补资料', escalated: '升级决策', business_accepted: '业务接受', fixed: '人工标记已整改', false_positive: '人工标记误报' };
const severityLabels: Record<ReviewFinding['severity'], string> = { high: '高风险', medium: '中风险', low: '低风险', unrated: '待判断' };
const contractTypeLabels = { procurement: '采购合同', service: '服务合同', other: '其他合同' };
const roleLabels = { buyer: '买受人', seller: '出卖人', service_provider: '服务提供方', service_recipient: '服务接受方', other: '其他立场' };
const checkLabels: Record<string, string> = { amounts: '金额与付款', dates: '日期与期间', references: '条款引用', parties: '主体一致性' };
const MAX_DOCUMENTS = 5000;
const MAX_REVIEWS = 10000;
const MAX_FINDINGS = 100000;
const MAX_REPORT_TEXT = 32 * 1024 * 1024;
const settingsQueues = new WeakMap<WorkspaceAssets, Promise<unknown>>();
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const nonnegative = z.number().int().min(0).max(1_000_000);
const documentSchema = z.object({ contractId: z.string().uuid(), documentId: z.string().uuid(), versionNo: z.number().int().min(1), kind: z.string().min(1).max(80), name: z.string().min(1).max(4096), importedAt: z.string().datetime({ offset: true }), sha256: shaSchema, partial: z.boolean() }).strict();
const exportSnapshotSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.string().datetime({ offset: true }), snapshotSha256: shaSchema,
  scope: z.enum(['current', 'workspace']), style: z.enum(['risk', 'management', 'summary']), settings: settingsSchema,
  period: z.object({ from: daySchema.nullable(), to: daySchema.nullable(), timezone: z.literal('Asia/Shanghai') }).strict(),
  metrics: z.object({ contracts: nonnegative, documentVersions: nonnegative, importedVersions: nonnegative, reviewRounds: nonnegative, riskItems: nonnegative, latestVersionRiskItems: nonnegative, pendingDecisions: nonnegative, activeManualOpinions: nonnegative, severities: z.object({ high: nonnegative, medium: nonnegative, low: nonnegative, unrated: nonnegative }).strict(), dispositions: z.object({ unreviewed: nonnegative, confirmed: nonnegative, needs_information: nonnegative, escalated: nonnegative, business_accepted: nonnegative, fixed: nonnegative, false_positive: nonnegative }).strict() }).strict(),
  documents: z.array(documentSchema).max(MAX_DOCUMENTS),
  reviews: z.array(z.object({ document: documentSchema, review: z.object({ id: z.string().uuid(), documentId: z.string().uuid(), createdAt: z.string().datetime({ offset: true }), findings: z.array(z.object({ id: z.string().uuid(), severity: z.enum(['high', 'medium', 'low', 'unrated']) }).passthrough()).max(MAX_FINDINGS) }).passthrough(), dispositions: z.object({ reviewId: z.string().uuid(), revision: nonnegative, events: z.array(z.object({ id: z.string().uuid(), reviewId: z.string().uuid(), findingId: z.string().uuid(), status: z.enum(['unreviewed', 'confirmed', 'needs_information', 'escalated', 'business_accepted', 'fixed', 'false_positive']), reason: z.string().min(1).max(2000), actorLabel: z.string().min(1).max(80), createdAt: z.string().datetime({ offset: true }) }).strict()).max(1000) }).strict(), annotations: z.array(z.object({ body: z.object({ state: z.enum(['active', 'disabled']) }).passthrough() }).passthrough()).max(10000).optional(), completion: z.object({ frozen: z.unknown().nullable(), currentFacts: z.unknown().nullable(), workflowRuns: z.array(z.unknown()).max(10000), sourceVerifications: z.array(z.unknown()).max(10000) }).strict().optional(), freshness: z.object({ checkedAt: z.string().datetime({ offset: true }), status: z.enum(['updates_available', 'no_known_updates', 'unknown']), reasons: z.array(z.object({ kind: z.enum(['document', 'standard', 'source', 'information', 'verification', 'alignment']), message: z.string(), previous: z.string().nullable(), current: z.string().nullable() }).strict()).max(10000), limitations: z.array(z.string()).max(10000) }).strict().optional() }).strict()).max(MAX_REVIEWS),
  standardGroups: z.array(z.object({ key: z.string().min(1).max(200), label: z.string().min(1).max(500), reviewRounds: nonnegative, contentSha256: shaSchema.nullable() }).strict()).max(MAX_REVIEWS), limitations: z.array(z.string()).max(1000),
  translation: z.object({ assetId:z.string().uuid(),revision:z.number().int().min(1),targetLanguage:z.enum(['en','th']),dependencySha256:shaSchema,sourceSnapshotSha256:shaSchema,approvedBy:z.string(),approvedAt:z.string().datetime({offset:true}),blocks:z.array(z.union([z.object({type:z.enum(['title','heading','subheading','text']),text:z.string()}).strict(),z.object({type:z.literal('table'),rows:z.array(z.array(z.string()))}).strict()])),csvRows:z.array(z.array(z.string())) }).strict().optional(),
}).strict();
const recordExportSchema = z.object({ format: z.enum(['docx', 'pdf', 'markdown', 'html', 'csv']), sha256: shaSchema, snapshot: z.unknown() }).strict();

export function normalizeReportRequest(payload: unknown): ReportRequest {
  const value = requestSchema.parse(payload);
  if (value.scope === 'current' && !value.reviewId) throw new Error('单合同报告必须指定审核记录。');
  if (value.scope === 'current' && (value.from || value.to)) throw new Error('单合同报告按指定审核记录生成，不接受汇总日期范围。');
  if (value.from && value.to && value.from > value.to) throw new Error('起始日期不能晚于结束日期。');
  return value;
}
function inPeriod(stamp: string, request: ReportRequest): boolean {
  const value = Date.parse(stamp);
  if (!Number.isFinite(value)) return false;
  const start = request.from ? Date.parse(`${request.from}T00:00:00+08:00`) : -Infinity;
  const end = request.to ? Date.parse(`${request.to}T23:59:59.999+08:00`) : Infinity;
  return value >= start && value <= end;
}
function currentEvents(item: ReportingReview) { return new Map(item.dispositions.events.map(event => [event.findingId, event])); }
function statusOf(item: ReportingReview, finding: ReviewFinding): RiskDispositionStatus { return currentEvents(item).get(finding.id)?.status ?? 'unreviewed'; }
function pending(status: RiskDispositionStatus) { return ['unreviewed', 'confirmed', 'needs_information', 'escalated'].includes(status); }
function settingsAsset(assets: WorkspaceAssets) { return assets.list('reporting_settings').filter(item => !item.deleted).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0]; }
function readSettings(assets: WorkspaceAssets): SavedReportSettings {
  const asset = settingsAsset(assets);
  return asset ? { id: asset.id, revision: asset.revision, body: settingsSchema.parse(asset.body) } : { id: null, revision: 0, body: defaultReportSettings() };
}

/** The period selects saved reviews by review creation time, not by the current
 * contract filename. Real contract and version IDs are used for deduplication. */
export function buildReportSnapshot(request: ReportRequest, store: AppStore, settings: ReportSettings, generatedAt = new Date().toISOString(), assets?: WorkspaceAssets, dataDir?: string): ReportSnapshot {
  const currentReview = request.scope === 'current' ? store.getReview(request.reviewId!) : null;
  const rows = store.rows(`SELECT d.id,d.contract_id,d.version_no,d.kind,d.created_at,d.file_sha256,c.title FROM document_versions d JOIN contracts c ON c.id=d.contract_id WHERE c.workspace_id=?${currentReview ? ' AND d.id=?' : ''} ORDER BY d.created_at,d.id LIMIT ?`, currentReview ? [store.workspaceId, currentReview.documentId, MAX_DOCUMENTS + 1] : [store.workspaceId, MAX_DOCUMENTS + 1]);
  if (rows.length > MAX_DOCUMENTS) throw new Error('当前工作区超过 5000 个文档版本，请先缩小工作区后导出，未静默截断统计。');
  let reviews: ReportingReview[] = [];
  const freshnessContext = assets ? createReviewFreshnessContext({ store, assets, dataDir }) : undefined;
  const documents: ReportingDocument[] = [];
  let totalFindings = 0;
  for (const row of rows) {
    const detail = store.getDocument(String(row.id));
    const document: ReportingDocument = { contractId: String(row.contract_id), documentId: detail.id, versionNo: Number(row.version_no), kind: String(row.kind), name: detail.name, importedAt: String(row.created_at), sha256: String(row.file_sha256), partial: detail.partial };
    const selected = detail.reviews.filter(review => request.scope === 'current' ? review.id === request.reviewId : inPeriod(review.createdAt, request));
    if (selected.length || (request.scope === 'workspace' && inPeriod(document.importedAt, request))) documents.push(document);
    for (const review of selected) {
      totalFindings += review.findings.length;
      if (reviews.length >= MAX_REVIEWS || totalFindings > MAX_FINDINGS) throw new Error('报告范围超过 10000 轮审核或 100000 条意见，请缩小日期范围；未静默截断统计。');
      reviews.push({ document, review: structuredClone(review), dispositions: structuredClone(store.getRiskDispositions(review.id)), ...(assets ? { annotations: structuredClone(getReviewAnnotations({ store, assets }, review.id)), completion: structuredClone(buildReviewCompletionReport({ store, assets }, review)), freshness: getReviewFreshness({ store, assets, dataDir }, review, generatedAt, freshnessContext) } : {}) });
    }
  }
  reviews = reviews.sort((a, b) => a.review.createdAt.localeCompare(b.review.createdAt) || a.review.id.localeCompare(b.review.id));
  if (request.scope === 'current' && reviews.length !== 1) throw new Error('审核记录不存在或不属于当前工作空间。');
  const severities: ReportSnapshot['metrics']['severities'] = { high: 0, medium: 0, low: 0, unrated: 0 };
  const dispositions = Object.fromEntries(Object.keys(dispositionLabels).map(key => [key, 0])) as ReportSnapshot['metrics']['dispositions'];
  const standardMap = new Map<string, ReportSnapshot['standardGroups'][number]>();
  const latest = new Map<string, ReportingReview>();
  let pendingDecisions = 0;
  for (const item of reviews) {
    latest.set(item.document.documentId, item);
    const standard = item.review.standardSnapshot;
    const key = standard?.id ?? 'no-frozen-standard';
    const group = standardMap.get(key) ?? { key, label: standard ? `${standard.content.name} v${standard.versionNo}` : '未保存企业标准版本', reviewRounds: 0, contentSha256: standard?.contentSha256 ?? null };
    group.reviewRounds++; standardMap.set(key, group);
    const events = currentEvents(item);
    for (const finding of item.review.findings) {
      severities[finding.severity]++;
      const status = events.get(finding.id)?.status ?? 'unreviewed'; dispositions[status]++;
      if (pending(status)) pendingDecisions++;
    }
  }
  const limitations = [
    '统计时间范围按 Asia/Shanghai 自然日解释，包含起止两日；审核轮次仅统计已保存的完成报告，失败、取消或运行中的任务不计入。',
    '合同数按合同记录 ID 去重；文档版本数为期间导入或期间完成审核所涉及的版本去重数。相同文件重复独立导入会成为独立合同记录，不按文件名或内容猜测为同一合同。',
    '风险项为所选审核轮次的意见条数，同一问题在多轮出现会重复计数；另列每个文档版本在所选范围内最后一轮的风险项数，不作为全工作区当前风险存量。',
    '风险处置读取报告生成时的最新人工记录，不是期间末的历史状态。业务接受、人工标记已整改或误报，不改变原风险等级，也不代表法律有效或整改效果已经核实。',
    '意见和风险等级的统计保留原始审核口径；人工补录或修订在独立章节列示并保留记录版本，不悄悄覆盖原报告，也不将补录意见冒充为当时模型已发现的问题。',
    '来源引文匹配只说明取回文本中出现该文字，尚未自动验证法律效力、适用性、时效或案例代表性。报告依据已保存的审核记录整理，不产生新的模型分析。',
  ];
  if (standardMap.size > 1) limitations.push('本范围包含不同企业标准版本或未保存标准的审核，风险数量不能直接用于严格程度、人员表现或趋势比较。请按版本分组解释。');
  if (reviews.some(item => item.document.partial || item.review.coverage.reviewedBlockIds.length < item.review.coverage.totalBlockCount)) limitations.push('部分文档解析或审核覆盖不完整，未覆盖内容不等于无风险。');
  if (reviews.some(item => item.review.batchCoverage && !item.review.batchCoverage.crossBatchSynthesis)) limitations.push('部分长合同使用了分批审核，但跨批综合未完成；跨段落关联、重复或矛盾内容仍须人工核对。');
  if (!reviews.length) limitations.push('本范围没有已完成审核记录。已导入文档数不代表完成审核或未发现风险。');
  const value = {
    schemaVersion: 1 as const, generatedAt, scope: request.scope, style: request.style, settings: settingsSchema.parse(settings),
    period: { from: request.scope === 'workspace' ? request.from ?? null : null, to: request.scope === 'workspace' ? request.to ?? null : null, timezone: 'Asia/Shanghai' as const },
    metrics: { contracts: new Set(documents.map(item => item.contractId)).size, documentVersions: documents.length, importedVersions: documents.filter(item => inPeriod(item.importedAt, request)).length, reviewRounds: reviews.length, riskItems: totalFindings, latestVersionRiskItems: [...latest.values()].reduce((sum, item) => sum + item.review.findings.length, 0), severities, dispositions, pendingDecisions, activeManualOpinions: reviews.reduce((sum, item) => sum + (item.annotations ?? []).filter(annotation => annotation.body.state === 'active').length, 0) },
    documents, reviews, standardGroups: [...standardMap.values()], limitations,
  };
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_REPORT_TEXT) throw new Error('报告超过 32 MiB，请缩小范围。未输出不完整报告。');
  return { ...value, snapshotSha256: createHash('sha256').update(serialized).digest('hex') };
}

type Block = ReportBlock;
const origin = (finding: ReviewFinding) => finding.origin === 'program' ? '程序核验' : finding.origin === 'enterprise' ? '企业规则' : finding.source === 'model' ? '模型分析' : '本地关键词';
export function sourceReportBlocks(snapshot: ReportSnapshot): Block[] {
  const m = snapshot.metrics;
  const blocks: Block[] = [];
  const add = (text: string, type: 'title' | 'heading' | 'subheading' | 'text' = 'text') => blocks.push({ type, text });
  add(snapshot.scope === 'workspace' ? '合同审核工作汇总' : snapshot.style === 'risk' ? '合同风险审核报告' : snapshot.style === 'summary' ? '合同审核领导摘要' : '合同审核管理报告', 'title');
  if (snapshot.settings.organization) add(snapshot.settings.organization);
  add(`编制人 ${snapshot.settings.authorLabel || '未填写'}    接收人 ${snapshot.settings.recipientLabel || '未填写'}`);
  add(`生成时间 ${snapshot.generatedAt}    报告快照 ${snapshot.snapshotSha256}`);
  add(snapshot.scope === 'workspace' ? `统计范围 ${snapshot.period.from ?? '不限开始日期'} 至 ${snapshot.period.to ?? '不限结束日期'}    Asia/Shanghai` : `合同 ${snapshot.reviews[0]?.document.name ?? '未指定'}    审核记录 ${snapshot.reviews[0]?.review.id ?? '无'}`);
  add(`本次整理 ${m.contracts} 份合同记录、${m.documentVersions} 个文档版本、${m.reviewRounds} 轮完成审核，共 ${m.riskItems} 条审核意见，其中 ${m.severities.high} 条高风险、${m.severities.unrated} 条待判断。当前 ${m.pendingDecisions} 条意见尚待处理、补充资料或决策。风险数量与待处理数量采用所选审核轮次口径，不能据此认定合同可以签署。`);
  const fullMetrics: Block = { type: 'table', rows: [['指标', '数量'], ['合同记录', String(m.contracts)], ['涉及文档版本', String(m.documentVersions)], ['期间导入版本', String(m.importedVersions)], ['完成审核轮次', String(m.reviewRounds)], ['全部轮次原始意见条数', String(m.riskItems)], ['各版本范围内最后一轮原始意见条数', String(m.latestVersionRiskItems)], ['有效人工补录及修订意见', String(m.activeManualOpinions)], ...Object.entries(dispositionLabels).map(([key, label]) => [label, String(m.dispositions[key as RiskDispositionStatus])])] };
  add(snapshot.style === 'summary' ? '核心审核指标' : '审核工作与处置概览', 'heading');
  blocks.push(snapshot.style === 'summary' ? { type: 'table', rows: [['指标', '数量'], ['合同记录', String(m.contracts)], ['完成审核轮次', String(m.reviewRounds)], ['原始高风险意见', String(m.severities.high)], ['待跟进或待决策意见', String(m.pendingDecisions)], ['有效人工补录及修订意见', String(m.activeManualOpinions)]] } : fullMetrics);
  add('需要跟进的事项', 'heading');
  let decisions = 0;
  const decisionLimit = snapshot.style === 'summary' ? 10 : snapshot.style === 'management' ? 20 : Infinity;
  for (const item of snapshot.reviews) {
    for (const finding of item.review.findings) {
      const event = currentEvents(item).get(finding.id);
      const status = event?.status ?? 'unreviewed';
      if (!pending(status)) continue;
      if (decisions >= decisionLimit) continue;
      add(`${++decisions} ${item.document.name}  ${finding.title}`, 'subheading');
      add(`原风险等级 ${severityLabels[finding.severity]}    当前处置 ${dispositionLabels[status]}    来源 ${origin(finding)}    审核 ${item.review.id}    意见 ${finding.id}`);
      add(`建议事项 ${finding.suggestion || '请人工明确后续行动。'}`);
      if (event) add(`最近人工说明 ${event.reason}    ${event.actorLabel}    ${event.createdAt}`);
    }
  }
  if (!decisions) add('所选意见没有处于待处理、待补资料、升级决策或人工确认关注状态的记录；这不构成签署批准。');
  if (m.pendingDecisions > decisions) add(`此处按已保存记录顺序列示前 ${decisions} 条，剩余 ${m.pendingDecisions - decisions} 条请查阅后续审核意见与人工处置明细；没有遗漏到风险统计之外。`);
  if (m.activeManualOpinions) {
    add('人工补录及修订的关注事项', 'heading');
    add('以下为报告生成时有效的人工意见。关联原意见的修订供决策时一并考虑；原报告及统计保留原始口径，人工关注等级独立展示。补录风险尚无原风险处置记录，需跟进。');
    for (const item of snapshot.reviews) for (const annotation of item.annotations ?? []) {
      if (annotation.body.state !== 'active') continue;
      add(`${item.document.name}  ${annotation.body.title}`, 'subheading');
      add(`人工关注等级 ${severityLabels[annotation.body.severity]}    ${annotation.body.findingId ? `修订原意见 ${annotation.body.findingId}` : '人工补录'}    人工意见 ${annotation.id} v${annotation.revision}`);
      add(`${annotation.body.description}    建议 ${annotation.body.suggestion}    理由 ${annotation.body.reason}    ${annotation.body.actorLabel}`);
    }
  }
  add('统计口径与使用局限', 'heading');
  snapshot.limitations.forEach(value => add(value));
  if (snapshot.standardGroups.length) {
    add('企业标准分组', 'heading');
    blocks.push({ type: 'table', rows: [['标准版本', '审核轮次', '版本标识'], ...snapshot.standardGroups.map(group => [group.label, String(group.reviewRounds), group.key])] });
  }
  if (snapshot.style === 'summary') { add('完整统计附录', 'heading'); blocks.push(fullMetrics); }
  add('文档与审核明细', 'heading');
  for (const document of snapshot.documents) {
    add(document.name, 'subheading');
    add(`合同记录 ${document.contractId}    文档版本 ${document.documentId}    v${document.versionNo}    ${document.kind}    导入 ${document.importedAt}`);
    add(`原文件 SHA256 ${document.sha256}    解析 ${document.partial ? '部分完成' : '已保存解析结果'}`);
    if (!snapshot.reviews.some(item => item.document.documentId === document.documentId)) add('所选期间没有该版本的完成审核记录。');
  }
  for (const item of snapshot.reviews) {
    const review = item.review;
    const events = currentEvents(item);
    add(`${item.document.name} 审核记录`, 'heading');
    add(`审核 ID ${review.id}    文档版本 ${review.documentId}    创建 ${review.createdAt}    ${review.mode === 'model' ? `模型 ${review.modelId ?? '未记录'}` : '本地规则与程序'}`);
    add(`已保存摘要 ${review.summary}`);
    if (item.freshness) {
      add('报告依赖更新比较', 'subheading');
      add(`比较 ${item.freshness.checkedAt}    ${{ updates_available: '已发现依赖更新，建议核对并重审', no_known_updates: '本工作区暂未发现依赖更新', unknown: '部分依赖版本未知，不能确认仍适用' }[item.freshness.status]}`);
      item.freshness.reasons.forEach(reason => add(`${reason.message}    原 ${reason.previous ?? '未保存'}    当前 ${reason.current ?? '未知'}`));
      item.freshness.limitations.forEach(reason => add(reason));
    }
    if(review.alignmentSnapshot) {
      const alignment=review.alignmentSnapshot;
      add('多语条款对应与优先语言记录','subheading');
      add(`审核时冻结的对齐摘要 ${alignment.contentSha256}    对应组 ${alignment.totalGroups}    未对应片段 ${alignment.totalUnmatched}    ${alignment.truncated?'仅保存限定范围，须回到对齐工作区核对':'已保存本次对齐快照'}。对应、人工确认与模型差异均不构成法律正确性认证。`);
      alignment.limitations.forEach(value=>add(`对齐局限 ${value}`));
      for(const group of alignment.groups) {
        add(`${group.body.label}    对应记录 ${group.id} r${group.revision}    状态 ${group.body.state}    ${group.stale?'源版本已变化':'本次源版本记录'}    人工理由 ${group.body.reason}`);
        add(`优先语言 ${group.body.priority.language??'未约定'}    约定确认 ${group.body.priority.state}    约定依据 ${group.body.priority.basis||'未填写'}`);
        for(const source of group.body.prioritySources)add(`优先语言约定原文 ${source.text}    文档 ${source.documentId}    段落 ${source.blockId}`);
        for(const segment of group.body.segments)for(const block of segment.blocks)add(`对应原文 ${segment.language}    文档 ${segment.documentId}    段落 ${block.blockId}    片段 ${block.range.start} 至 ${block.range.end}    ${block.text}`);
        for(const flag of group.body.programFlags)add(`程序差异提示 ${flag.kind}    ${flag.detail}    ${JSON.stringify(flag.values)}。仅为有限文本比较，需人工判断。`);
        if(group.body.comparison){add(`模型差异候选 ${group.body.comparison.summary}    模型 ${group.body.comparison.modelId}    人工复核 ${group.body.comparisonReview.state}    说明 ${group.body.comparisonReview.reason}`);for(const difference of group.body.comparison.differences)add(`${difference.category}    ${difference.description}    ${JSON.stringify(difference.blockRefs)}`);group.body.comparison.warnings.forEach(value=>add(value));}
      }
      for(const block of alignment.unmatched)add(`未对应原文 ${block.documentId}    段落 ${block.blockId}    ${block.text}    原因 ${block.reason}`);
    }
    if (item.completion) {
      add('结构化事实、假设与资料缺口', 'subheading');
      const pinned = item.completion.frozen;
      add(pinned ? `审核时冻结资料 r${pinned.facts?.revision ?? 0}    ${pinned.capturedAt}    原文件 ${pinned.documentSha256}` : '历史审核未保存结构化资料快照；当前资料不能补写为当时已知事实。');
      for (const information of pinned?.facts?.body.items ?? []) add(`${{ fact: '关键事实', assumption: '审核假设', question: '待确认问题' }[information.kind]}    ${information.label}    ${{ pending: '待确认', confirmed: '人工确认', not_applicable: '人工标记不适用' }[information.status]}    ${information.required ? '本轮必需' : '补充信息'}    ${information.detail}    影响范围 ${information.scopes.join('、') || '整体审核'}    理由 ${information.reason || '未说明'}    引文 ${snapshot.settings.includeContractQuotes ? information.quote : '按报告配置省略'}    段落 ${information.blockIds.join('、')}`);
      pinned?.limitations.forEach(value => add(`资料局限 ${value}`));
      const current = item.completion.currentFacts;
      if (current && current.revision !== pinned?.facts?.revision) add(`当前资料另有 r${current.revision}（${current.updatedAt}），不改变本次冻结资料；请回到审核资料面板核对并重审。`);
      for (const run of item.completion.workflowRuns) { add(`有限流程 ${run.id}    r${run.revision}    ${run.body.state}    ${run.body.reason}`); for (const node of run.body.nodes) add(`节点 ${node.kind}    ${node.state}    ${node.reason}`); }
      add('人工来源核验与采信记录', 'subheading');
      if (!item.completion.sourceVerifications.length) add('没有人工来源核验记录；来源文字匹配不等于法律效力、真实性或适用性已确认。');
      for (const verification of item.completion.sourceVerifications) for (const event of verification.history) { const body = event.body; add(`来源 ${verification.evidenceId}    核验 r${event.revision}    ${{ not_verified: '未核实', pending: '待核实', verified: '已人工核实（仅限记录范围）' }[body.status]}    ${event.actorLabel}    ${event.updatedAt}`); add(`真实性说明 ${body.authenticity || '未说明'}    效力说明 ${body.legalEffect || '未说明'}    适用 ${body.applicableFrom ?? '未知'} 至 ${body.applicableTo ?? '未知'}    范围 ${body.applicableScope || '未说明'}    冲突与采信 ${body.conflictReason || '未说明'}    记录理由 ${body.reason}    冻结来源摘要 ${body.evidenceSha256}`); }
    }
    add(`审核范围 ${contractTypeLabels[review.context.contractType]}    我方立场 ${roleLabels[review.context.ourPartyRole]}    审核尺度 ${{ cautious: '谨慎', balanced: '均衡', pragmatic: '务实' }[review.context.strictness]}    业务背景 ${review.context.businessContext || '未填写'}`);
    add(`段落覆盖 ${review.coverage.reviewedBlockIds.length}/${review.coverage.totalBlockCount}    知识库 ${review.coverage.knowledgeStatus}    互联网 ${review.coverage.webStatus}`);
    const hasRetrievalRecords = Boolean(review.retrieval && (review.retrieval.attempts.length || review.retrieval.evidence.length));
    if (!hasRetrievalRecords) add(`检索依据 本次没有保存检索记录或来源原文。${review.retrieval?.limitations.length ? ` ${review.retrieval.limitations.join('；')}` : ''}`);
    review.coverage.limitations.forEach(value => add(`审核局限 ${value}`));
    if (review.batchCoverage) {
      add('长合同分批覆盖记录', 'subheading');
      add(`审核批次数 ${review.batchCoverage.batchCount}    跨批综合 ${review.batchCoverage.crossBatchSynthesis ? '已保存综合结果' : '未完成综合，须人工核对跨批关联'}。批次数或段落覆盖不能证明已识别所有关联风险。`);
      review.batchCoverage.limitations.forEach(value => add(`分批局限 ${value}`));
    }
    if (review.experienceSnapshot?.length) {
      add('本次采用的本地经验版本', 'subheading');
      add('以下为审核时冻结的经验条目，后续调整、停用或回退不改变本次记录。经验表达个人或企业偏好，不替代法律依据。');
      for (const experience of review.experienceSnapshot) {
        add(`经验记录 ${experience.id}    修订 ${experience.revision}    SHA256 ${experience.contentSha256}`);
        const body = experience.body && typeof experience.body === 'object' ? experience.body as Partial<ExperienceBody> : null;
        if (body && typeof body.content === 'string') {
          add(`经验名称 ${body.name ?? '未提供'}    类别 ${body.kind === 'rule' ? '审核关注规则' : body.kind === 'clause' ? '条款案例' : '偏好'}    状态 ${body.state ?? '未提供'}    记录人 ${body.actorLabel ?? '未提供'}    确认时间 ${body.approvedAt ?? '未提供'}`);
          add(`采用的经验内容 ${body.content}`); add(`确认理由 ${body.reason ?? '未提供'}    适用范围 ${JSON.stringify(body.scope ?? null)}    经验来源 ${JSON.stringify(body.source ?? null)}`);
        } else add(`兼容历史经验数据 ${JSON.stringify(experience.body)}`);
      }
    }
    const standard = review.standardSnapshot;
    add(standard ? `冻结企业标准 ${standard.content.name} v${standard.versionNo}    版本 ${standard.id}    SHA256 ${standard.contentSha256}    发布 ${standard.publishedAt}    ${standard.publishedBy}` : '本次没有冻结的企业标准快照，不能用当前配置补写历史审核。');
    if (standard) {
      const content = standard.content;
      add(`标准说明 ${content.description || '未填写'}    适用合同 ${content.contractTypes.map(type => contractTypeLabels[type]).join('、')}    适用立场 ${content.partyRoles.map(role => roleLabels[role]).join('、')}`);
      add(`程序检查 ${Object.entries(content.checks).map(([key, enabled]) => `${checkLabels[key] ?? key} ${enabled ? '启用' : '停用'}`).join('；')}    预付款比例关注阈值 ${content.thresholds.maxPrepaymentPercent === null ? '未配置' : `${content.thresholds.maxPrepaymentPercent}%`}    付款期限关注阈值 ${content.thresholds.maxPaymentDays === null ? '未配置' : `${content.thresholds.maxPaymentDays} 天`}`);
      add(`企业规则 ${content.workflow.runEnterpriseRules ? '启用' : '停用'}    高风险处理建议 ${content.workflow.highRiskHandling === 'escalate' ? '升级决策' : '人工复核'}。这些配置表达内部关注与商业阈值，不等同于法律强制义务。`);
      for (const rule of content.rules) add(`企业规则 ${rule.key}    ${rule.name}    ${rule.enabled ? '启用' : '停用'}    ${rule.kind === 'required_topic' ? '必备主题关注' : '特定措辞关注'}    配置关注等级 ${severityLabels[rule.severity]}    匹配词 ${rule.terms.join('、')}    处理指引 ${rule.guidance || '未填写'}`);
    }
    add('程序核验记录', 'subheading');
    if (review.programChecks) {
      add(`引擎 ${review.programChecks.engineVersion}`);
      for (const check of review.programChecks.checks) add(`${checkLabels[check.kind] ?? check.kind}    ${{ completed: '有限语法核验完成', partial: '部分核验需人工补核', disabled: '按本次标准停用' }[check.status]}    明确可识别核验 ${check.checkedCount} 次    ${check.limitations.join('；')}`);
      for (const issue of review.programChecks.issues) add(`${issue.key}    ${issue.title}    原文 ${issue.quote}    ${issue.description}    算式 ${issue.calculation ?? '不适用'}    位置 ${issue.blockIds.join('、')}`);
    } else add('历史记录未保存程序核验结果。');
    add('审核意见与人工处置', 'subheading');
    if (!review.findings.length) add('该轮没有已保存的审核意见，不代表不存在风险。');
    for (const [index, finding] of review.findings.entries()) {
      const event = events.get(finding.id);
      add(`${index + 1} ${finding.title}`, 'subheading');
      add(`意见 ${finding.id}    原等级 ${severityLabels[finding.severity]}    类别 ${finding.category}    来源 ${origin(finding)}    处置 ${dispositionLabels[event?.status ?? 'unreviewed']}`);
      add(`原文定位 ${finding.locationStatus}    段落 ${finding.blockIds.join('、') || '无'}`);
      if (snapshot.settings.includeContractQuotes) add(`合同引文 ${finding.quote || '未提供直接引文，需人工核对。'}`);
      if (snapshot.style !== 'summary') { add(finding.description); add(`修改或处理建议 ${finding.suggestion}`); }
      add(`待核实法律依据 ${finding.legalBasis ?? '未提供'}    依据状态 ${finding.basisStatus === 'source_matched' ? '来源文字匹配，效力和适用未核验' : '未核验'}`);
      if (finding.checkKey || finding.calculation) add(`检查项 ${finding.checkKey ?? '无'}    计算或校验 ${finding.calculation ?? '不适用'}`);
      for (const citation of finding.citations ?? []) add(`引用来源 ${citation.evidenceId}    ${citation.matchStatus === 'matched' ? '文字匹配' : '文字未匹配'}    引文 ${citation.quote}`);
      if (event) add(`最近人工记录 ${event.actorLabel}    ${event.createdAt}    ${event.reason}`);
    }
    add(`处置快照修订号 ${item.dispositions.revision}    读取时间 ${snapshot.generatedAt}。处置状态独立于原风险等级及合同修改的采纳状态。`);
    if (snapshot.settings.includeDispositionHistory) for (const event of item.dispositions.events) add(`处置历史 ${event.createdAt}    意见 ${event.findingId}    ${dispositionLabels[event.status]}    ${event.actorLabel}    ${event.reason}`);
    if (item.annotations?.length) { add('独立人工补充意见', 'subheading'); for (const annotation of item.annotations) add(`记录 ${annotation.id}    修订 ${annotation.revision}    ${JSON.stringify(annotation.body)}`); }
    if (hasRetrievalRecords && review.retrieval) {
      add('来源与检索依据', 'subheading');
      review.retrieval.limitations.forEach(value => add(`检索局限 ${value}`));
      for (const attempt of review.retrieval.attempts) add(`检索记录 ${attempt.id}    ${attempt.channel}/${attempt.provider}    查询 ${attempt.query}    状态 ${attempt.status}    ${attempt.resultCount} 条    ${attempt.startedAt} 至 ${attempt.finishedAt}    ${attempt.error ?? ''}    ${attempt.warnings.join('；')}${attempt.coverage ? `    覆盖 ${JSON.stringify(attempt.coverage)}` : ''}`);
      for (const source of review.retrieval.evidence) {
        add(`${source.title}`, 'subheading');
        add(`来源 ${source.id}    检索 ${source.attemptId}    类型 ${source.kind}    ${source.channel}    ${source.isOfficial ? '官方来源标记' : '非官方来源标记'}    范围 ${source.contentScope}`);
        add(`地址 ${source.sourceUri ?? '未提供'}    定位 ${source.locator}    获取 ${source.retrievedAt}    发布 ${source.publishedAt ?? '未知'}    生效 ${source.effectiveAt ?? '未知'}    时效 ${source.currentness}`);
        add(`引文 SHA256 ${source.excerptSha256}    ${source.warnings.join('；')}`);
        add(`保存的来源原文 ${source.excerpt}`);
        if (source.officialMetadata) add(`官方来源元信息 ${JSON.stringify(source.officialMetadata)}`);
        if (source.localIndex) add(`知识库版本定位 ${JSON.stringify(source.localIndex)}`);
      }
    }
  }
  return blocks;
}

function reportBlocks(snapshot: ReportSnapshot): Block[] {
  if ((snapshot.settings.language ?? 'zh') === 'zh') return sourceReportBlocks(snapshot);
  if (!snapshot.translation || snapshot.translation.targetLanguage !== snapshot.settings.language) throw new Error('目标语言报告尚未完成译文人工确认，未用中文内容替代。');
  return snapshot.translation.blocks;
}

const mdInline = (value: string) => clean(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\\`*_\[\]#|]/gu, '\\$&').replace(/[\r\n]+/gu, ' ');
export function reportMarkdown(snapshot: ReportSnapshot): string {
  return reportBlocks(snapshot).map(block => block.type === 'table' ? [block.rows[0].map(mdInline).join(' | '), block.rows[0].map(() => '---').join(' | '), ...block.rows.slice(1).map(row => row.map(mdInline).join(' | '))].join('\n') : `${block.type === 'title' ? '# ' : block.type === 'heading' ? '## ' : block.type === 'subheading' ? '### ' : ''}${mdInline(block.text)}`).join('\n\n') + '\n';
}
export function reportHtml(snapshot: ReportSnapshot): string {
  const content = reportBlocks(snapshot).map(block => block.type === 'table' ? `<table><thead><tr>${block.rows[0].map(cell => `<th>${esc(cell)}</th>`).join('')}</tr></thead><tbody>${block.rows.slice(1).map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : `<${block.type === 'title' ? 'h1' : block.type === 'heading' ? 'h2' : block.type === 'subheading' ? 'h3' : 'p'}>${esc(block.text)}</${block.type === 'title' ? 'h1' : block.type === 'heading' ? 'h2' : block.type === 'subheading' ? 'h3' : 'p'}>`).join('\n');
  const language = snapshot.settings.language ?? 'zh'; const lang = {zh:'zh-CN',en:'en',th:'th'}[language];
  const font = language === 'th' ? "'Noto Sans Thai',Tahoma,'Leelawadee UI','Microsoft YaHei',Arial,sans-serif" : "'Noto Sans CJK SC','Microsoft YaHei','Noto Sans Thai',Tahoma,Arial,sans-serif";
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(reportLabel('合同审核报告',language))}</title><style>@page{size:A4;margin:22mm 20mm}*{box-sizing:border-box}body{font:11pt/1.75 ${font};color:#000;margin:0;overflow-wrap:anywhere;word-break:normal;line-break:auto}h1{font-size:21pt;line-height:1.4;margin:0 0 20pt;text-align:center}h2{font-size:15pt;margin:22pt 0 10pt}h3{font-size:12pt;margin:16pt 0 7pt}h1,h2,h3{color:#000;break-after:avoid}p{margin:0 0 9pt;white-space:pre-wrap;orphans:2;widows:2}table{width:100%;border-collapse:collapse;margin:10pt 0 16pt;font-size:10pt;table-layout:fixed}th,td{border:1px solid #d9d9d9;padding:7pt 9pt;vertical-align:middle;text-align:left;overflow-wrap:anywhere}thead{display:table-header-group}th{background:#e5eaf0;color:#000}tr{break-inside:avoid}@media screen{body{max-width:850px;margin:32px auto;padding:24px}}</style></head><body>${content}</body></html>`;
}

/** Quote all cells and neutralize spreadsheet formula prefixes, including after
 * whitespace. CSV is an index, the full HTML/DOCX contains evidence and history. */
export function sourceReportCsvRows(snapshot: ReportSnapshot): string[][] {
  const header = ['记录类型', '合同记录ID', '文档版本ID', '文档名', '版本号', '文件SHA256', '审核ID', '审核时间', '标准版本ID', '意见ID', '标题', '原风险等级', '处置状态', '记录人', '处置理由', '处置时间', '意见来源', '来源ID', '报告快照SHA256'];
  const rows: unknown[][] = [header];
  for (const document of snapshot.documents) {
    const reviews = snapshot.reviews.filter(item => item.document.documentId === document.documentId);
    const base = [document.contractId, document.documentId, document.name, document.versionNo, document.sha256];
    if (!reviews.length) rows.push(['文档无期间审核', ...base, '', '', '', '', '', '', '', '', '', '', '', '', snapshot.snapshotSha256]);
    for (const item of reviews) {
      const prefix = [...base, item.review.id, item.review.createdAt, item.review.standardSnapshot?.id ?? ''];
      if (!item.review.findings.length) rows.push(['审核无已保存意见', ...prefix, '', '', '', '', '', '', '', '', '', snapshot.snapshotSha256]);
      const events = currentEvents(item);
      for (const finding of item.review.findings) { const event = events.get(finding.id); rows.push(['审核意见', ...prefix, finding.id, finding.title, severityLabels[finding.severity], dispositionLabels[event?.status ?? 'unreviewed'], event?.actorLabel ?? '', event?.reason ?? '', event?.createdAt ?? '', origin(finding), (finding.citations ?? []).map(c => c.evidenceId).join(';'), snapshot.snapshotSha256]); }
    }
  }
  return rows.map(row=>row.map(value=>String(value??'')));
}
export function reportCsv(snapshot: ReportSnapshot): string {
  const cell = (value: unknown) => { let text = clean(String(value ?? '')); if (/^[\s]*[=+\-@]/u.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  const language = snapshot.settings.language ?? 'zh';
  if(language!=='zh'&&!snapshot.translation)throw new Error('目标语言报告尚未完成译文人工确认。');
  const rows=language==='zh'?sourceReportCsvRows(snapshot):snapshot.translation!.csvRows;
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Ordinary OOXML without active content, external relationships or model XML. */
export async function buildReportDocx(snapshot: ReportSnapshot): Promise<Buffer> {
  const language = snapshot.settings.language ?? 'zh'; const lang={zh:'zh-CN',en:'en-US',th:'th-TH'}[language];
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const xml = (text: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${text}`;
  const run = (text: string) => `<w:r><w:rPr><w:lang w:val="${lang}" w:eastAsia="zh-CN" w:bidi="th-TH"/>${language==='th'?'<w:rFonts w:ascii="Tahoma" w:hAnsi="Tahoma" w:cs="Tahoma"/>':''}</w:rPr>${text.split(/\r?\n/u).map(line => `<w:t xml:space="preserve">${esc(line)}</w:t>`).join('<w:br/>')}</w:r>`;
  const paragraph = (text: string, style = 'Normal', center = false) => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${center ? '<w:jc w:val="center"/>' : ''}</w:pPr>${run(text)}</w:p>`;
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="D9D9D9"/>`).join('');
  const table = (rows: string[][]) => {
    const widths = rows[0].length === 2 ? [6000, 3000] : [2900, 1300, 4800];
    return `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="140" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${rows.map((row, index) => `<w:tr><w:trPr>${index === 0 ? '<w:tblHeader/>' : ''}<w:cantSplit/></w:trPr>${row.map((cell, i) => `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/><w:vAlign w:val="center"/>${index === 0 ? '<w:shd w:fill="E5EAF0"/>' : ''}</w:tcPr>${paragraph(cell, index === 0 ? 'TableHeader' : 'TableBody', i === 1)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>${paragraph('')}`;
  };
  const blocks = reportBlocks(snapshot).map(block => block.type === 'table' ? table(block.rows) : paragraph(block.text, block.type === 'title' ? 'Title' : block.type === 'heading' ? 'Heading1' : block.type === 'subheading' ? 'Heading2' : 'Normal')).join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>'));
  zip.file('_rels/.rels', xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.file('word/_rels/document.xml.rels', xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>'));
  zip.file('word/document.xml', xml(`<w:document xmlns:w="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${blocks}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1247" w:right="1134" w:bottom="1247" w:left="1134" w:header="567" w:footer="567"/></w:sectPr></w:body></w:document>`));
  const style = (id: string, size: number, bold = false, extra = '') => `<w:style w:type="paragraph" ${id === 'Normal' ? 'w:default="1"' : ''} w:styleId="${id}"><w:name w:val="${id}"/>${id !== 'Normal' ? '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' : ''}<w:pPr><w:widowControl/><w:spacing w:before="${id.startsWith('Heading') ? 280 : 0}" w:after="${id === 'Title' ? 280 : id.startsWith('Table') ? 20 : 130}" w:line="${id.startsWith('Table') ? 260 : 320}" w:lineRule="atLeast"/>${id.startsWith('Heading') || id === 'Title' ? '<w:keepNext/><w:keepLines/>' : ''}${extra}</w:pPr><w:rPr>${bold ? '<w:b/><w:bCs/>' : ''}<w:color w:val="000000"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  zip.file('word/styles.xml', xml(`<w:styles xmlns:w="${ns}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${language==='th'?'Tahoma':'Arial'}" w:hAnsi="${language==='th'?'Tahoma':'Arial'}" w:eastAsia="SimSun" w:cs="Tahoma"/><w:color w:val="000000"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="${lang}" w:eastAsia="zh-CN" w:bidi="th-TH"/></w:rPr></w:rPrDefault></w:docDefaults>${style('Normal', 22)}${style('Title', 38, true, '<w:jc w:val="center"/>')}${style('Heading1', 28, true, '<w:outlineLvl w:val="0"/>')}${style('Heading2', 24, true, '<w:outlineLvl w:val="1"/>')}${style('TableHeader', 20, true)}${style('TableBody', 20)}</w:styles>`));
  zip.file('word/footer1.xml', xml(`<w:ftr xmlns:w="${ns}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run(reportLabel('内部审核资料    第 ',language))}<w:fldSimple w:instr="PAGE"/>${run(reportLabel(' 页',language))}</w:p></w:ftr>`));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

export async function runReportingCommand(action: string, payload: unknown, deps: { store: AppStore; service: ContractService; assets: WorkspaceAssets; dataDir?: string }): Promise<unknown> {
  if(action.startsWith('reporting.translation.'))return runReportTranslationCommand(action,payload,deps);
  if (action === 'reporting.recordExport') {
    const envelope = recordExportSchema.parse(payload);
    if (Buffer.byteLength(JSON.stringify(envelope.snapshot)) > MAX_REPORT_TEXT) throw new Error('报告快照超过 32 MiB，未登记导出。');
    const snapshot = exportSnapshotSchema.parse(envelope.snapshot);
    if((snapshot.settings.language??'zh')!=='zh') assertTranslationExport(envelope.snapshot as ReportSnapshot,deps);
    const { snapshotSha256, ...content } = envelope.snapshot as ReportSnapshot;
    if (createHash('sha256').update(JSON.stringify(content)).digest('hex') !== snapshotSha256) throw new Error('报告快照 SHA256 不一致，未登记导出。');
    const m = snapshot.metrics; const documents = new Map(snapshot.documents.map(document => [document.documentId, document]));
    const severities = { high: 0, medium: 0, low: 0, unrated: 0 }; const statuses = Object.fromEntries(Object.keys(dispositionLabels).map(key => [key, 0])) as Record<RiskDispositionStatus, number>;
    let riskItems = 0, pendingDecisions = 0, manualOpinions = 0;
    const latestReviews = new Map<string, typeof snapshot.reviews[number]>();
    for (const item of snapshot.reviews) {
      if (!documents.has(item.document.documentId) || item.review.documentId !== item.document.documentId || item.dispositions.reviewId !== item.review.id) throw new Error('报告的文档、审核与处置来源不一致。');
      const findings = new Set(item.review.findings.map(finding => finding.id));
      if (item.dispositions.events.some(event => event.reviewId !== item.review.id || !findings.has(event.findingId))) throw new Error('处置记录不属于报告中的审核意见。');
      const events = new Map(item.dispositions.events.map(event => [event.findingId, event]));
      for (const finding of item.review.findings) { riskItems++; severities[finding.severity]++; const status = events.get(finding.id)?.status ?? 'unreviewed'; statuses[status]++; if (pending(status)) pendingDecisions++; }
      manualOpinions += item.annotations?.filter(annotation => annotation.body.state === 'active').length ?? 0;
      const previous = latestReviews.get(item.document.documentId);
      if (!previous || `${item.review.createdAt}:${item.review.id}` > `${previous.review.createdAt}:${previous.review.id}`) latestReviews.set(item.document.documentId, item);
    }
    if (documents.size !== snapshot.documents.length || m.contracts !== new Set(snapshot.documents.map(document => document.contractId)).size || m.documentVersions !== snapshot.documents.length || m.reviewRounds !== snapshot.reviews.length || m.riskItems !== riskItems || m.latestVersionRiskItems !== [...latestReviews.values()].reduce((sum, item) => sum + item.review.findings.length, 0) || m.pendingDecisions !== pendingDecisions || m.activeManualOpinions !== manualOpinions || Object.entries(severities).some(([key, count]) => m.severities[key as keyof typeof severities] !== count) || Object.entries(statuses).some(([key, count]) => m.dispositions[key as RiskDispositionStatus] !== count)) throw new Error('报告快照的统计口径与明细不一致，未登记导出。');
    return deps.assets.save({ kind: 'report_export', expectedRevision: 0, body: { format: envelope.format, sha256: envelope.sha256, snapshot: envelope.snapshot } });
  }
  if (action === 'reporting.settings.get') return readSettings(deps.assets);
  if (action === 'reporting.settings.save') {
    const input = saveSettingsSchema.parse(payload);
    const operation = (settingsQueues.get(deps.assets) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const existing = readSettings(deps.assets);
      if (existing.id !== (input.id ?? null) || existing.revision !== input.expectedRevision) throw new Error('报告配置已变化，请刷新后重试。');
      const asset = await deps.assets.save({ id: input.id, kind: 'reporting_settings', expectedRevision: input.expectedRevision, body: input.body, actorLabel: input.actorLabel });
      return { id: asset.id, revision: asset.revision, body: asset.body };
    });
    settingsQueues.set(deps.assets, operation.catch(() => {}));
    return operation;
  }
  if (action !== 'reporting.query' && action !== 'reporting.render') throw new Error('未知报告操作。');
  const request = normalizeReportRequest(payload);
  let snapshot = buildReportSnapshot(request, deps.store, request.settings ?? readSettings(deps.assets).body, new Date().toISOString(), deps.assets, deps.dataDir);
  if (action === 'reporting.query') return snapshot;
  if((snapshot.settings.language??'zh')!=='zh')snapshot=applyReportTranslation(snapshot,request.translationId,deps);
  const result: ReportingRenderResult = { filename: reportLabel(snapshot.scope === 'workspace' ? '合同审核工作汇总' : snapshot.style === 'summary' ? '合同审核领导摘要' : '合同审核报告',snapshot.settings.language??'zh'), html: reportHtml(snapshot), markdown: reportMarkdown(snapshot), csv: reportCsv(snapshot), docxBase64: (await buildReportDocx(snapshot)).toString('base64'), snapshot };
  return result;
}
