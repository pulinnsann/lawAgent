import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildReportDocx, reportHtml, reportMarkdown, reportCsv } from '../src/core/reporting.ts';
import { defaultReportSettings } from '../src/shared/reporting.ts';
import { defaultEnterpriseStandard } from '../src/shared/assurance.ts';

// Entirely fictional engineering material. No customer documents, configuration,
// API key, network request, model invocation or actual workspace mutation.
const output = resolve('output/reporting'); await mkdir(output, { recursive: true });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const createdAt = '2026-10-23T01:00:00.000Z';
const standardContent = { ...defaultEnterpriseStandard(), name: '合成采购审核标准', description: '工程样本，阈值仅用于测试显示。' };
const standard = { id: 'synthetic-standard-v1', standardId: 'synthetic-standard', versionNo: 1, content: standardContent, contentSha256: digest(standardContent), publishedAt: createdAt, publishedBy: '合成法务标签' };
const document = { contractId: 'synthetic-contract', documentId: 'synthetic-document', versionNo: 1, kind: 'original', name: '合成服务合同 中 English ไทย.docx', importedAt: createdAt, sha256: 'b'.repeat(64), partial: false };
const finding = { id: 'synthetic-finding', blockIds: ['synthetic-block'], quote: '乙方应在验收后付款。 Payment follows written acceptance. ชำระเงินหลังการตรวจรับเป็นลายลักษณ์อักษร', title: '付款与验收条件待确认', category: 'commercial', severity: 'high', description: '工程样本中付款条件与书面验收标准尚需人工确认。This text is fictional engineering material. ข้อความนี้เป็นข้อมูลสมมติสำหรับทดสอบระบบ', suggestion: '请补充验收标准并确认业务授权，记录负责人判断。', legalBasis: null, basisStatus: 'unverified', citations: [{ evidenceId: 'synthetic-evidence', quote: '内部付款流程须履行授权确认。', matchStatus: 'matched' }], source: 'rule', origin: 'enterprise', checkKey: 'synthetic-standard:acceptance', locationStatus: 'matched' };
const review = { id: 'synthetic-review', documentId: document.documentId, createdAt, mode: 'local', modelId: null, summary: '当前尚有一项付款与验收条件待补充资料。领导需确认业务授权与资料补充责任；工程记录不构成签署批准。', findings: [finding], context: { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '合成工程场景' }, coverage: { reviewedBlockIds: ['synthetic-block'], totalBlockCount: 1, knowledgeStatus: 'complete', webStatus: 'user_disabled', limitations: ['材料均为虚构工程样本，法律正确性交由律师验收。'] }, elapsedMs: 12, inputTokens: null, outputTokens: null, standardSnapshot: standard,
  experienceSnapshot: [{ id: 'synthetic-experience', revision: 2, contentSha256: 'd'.repeat(64), body: { name: '合成验收偏好', kind: 'preference', content: 'English and Thai terms must be checked by counsel. ข้อมูลสมมติสำหรับทดสอบระบบ', state: 'approved', actorLabel: '合成法务', reason: '仅用于验证经验版本显示', approvedAt: createdAt } }], batchCoverage: { batchCount: 1, crossBatchSynthesis: false, limitations: ['此为分批覆盖显示工程样本，跨批关联需人工复核。'] },
  programChecks: { engineVersion: 'synthetic-probe', checks: [{ kind: 'amounts', status: 'partial', checkedCount: 0, limitations: ['未出现可明确比较的金额关系，需人工补核。'] }, { kind: 'dates', status: 'completed', checkedCount: 1, limitations: ['仅检查明确日期。'] }, { kind: 'references', status: 'disabled', checkedCount: 0, limitations: ['按本次配置停用。'] }], issues: [] },
  retrieval: { knowledgeStatus: 'complete', webStatus: 'user_disabled', configSnapshot: {}, attempts: [{ id: 'synthetic-attempt', channel: 'knowledge', provider: 'folder', query: '付款 授权', status: 'complete', startedAt: createdAt, finishedAt: createdAt, resultCount: 1, error: null, warnings: [] }], evidence: [{ id: 'synthetic-evidence', attemptId: 'synthetic-attempt', channel: 'knowledge', kind: 'company_policy', title: '合成内部付款流程', sourceUri: 'knowledge://synthetic/payment-policy.txt', locator: '第 1 段', excerpt: '内部付款流程须履行授权确认。Internal payment requires approval. การชำระเงินภายในต้องได้รับอนุมัติ', excerptSha256: 'c'.repeat(64), contentScope: 'fragment', retrievedAt: createdAt, publishedAt: null, effectiveAt: null, currentness: 'unknown', isOfficial: false, warnings: ['这是虚构公司流程，不能替代法律依据。'] }], limitations: ['仅本地合成来源，没有执行互联网检索。'] } };
const dispositions = { reviewId: review.id, revision: 2, events: [{ id: 'synthetic-event-1', reviewId: review.id, findingId: finding.id, status: 'confirmed', reason: '工程样本首次人工确认关注。', actorLabel: '合成法务', createdAt }, { id: 'synthetic-event-2', reviewId: review.id, findingId: finding.id, status: 'needs_information', reason: '请业务补充书面验收标准。Please supply acceptance criteria. โปรดระบุเกณฑ์การตรวจรับ', actorLabel: '合成业务标签', createdAt }] };
for (const style of ['risk', 'management', 'summary']) {
  const value = { schemaVersion: 1, generatedAt: createdAt, scope: 'current', style, settings: { ...defaultReportSettings(), organization: '合成单位', authorLabel: '合成法务', recipientLabel: '合成管理层' }, period: { from: null, to: null, timezone: 'Asia/Shanghai' }, metrics: { contracts: 1, documentVersions: 1, importedVersions: 1, reviewRounds: 1, riskItems: 1, latestVersionRiskItems: 1, severities: { high: 1, medium: 0, low: 0, unrated: 0 }, dispositions: { unreviewed: 0, confirmed: 0, needs_information: 1, escalated: 0, business_accepted: 0, fixed: 0, false_positive: 0 }, pendingDecisions: 1, activeManualOpinions: 0 }, documents: [document], reviews: [{ document, review, dispositions }], standardGroups: [{ key: standard.id, label: '合成采购审核标准 v1', reviewRounds: 1, contentSha256: standard.contentSha256 }], limitations: ['仅供工程排版和功能验证，全部内容虚构。', '风险数量采用本次完成审核口径，人工处置以报告生成时记录为准。业务接受不代表条款合法。', '来源文字匹配不代表法律适用、效力或时效已经核验。'] };
  const snapshot = { ...value, snapshotSha256: digest(value) };
  const stem = resolve(output, `synthetic-${style}-report`);
  await writeFile(`${stem}.docx`, await buildReportDocx(snapshot));
  await writeFile(`${stem}.html`, reportHtml(snapshot));
  await writeFile(`${stem}.md`, reportMarkdown(snapshot));
  await writeFile(`${stem}.csv`, reportCsv(snapshot));
  console.log(`${style}: ${stem}.docx`);
}
