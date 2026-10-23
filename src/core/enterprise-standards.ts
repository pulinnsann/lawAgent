import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { reviewWorkflowSchema } from './review-workflow';
import type { ContractDetail, ReviewContext, ReviewFinding } from '../shared/contracts';
import type { EnterpriseStandardContent, EnterpriseStandardSnapshot, PublishEnterpriseStandardInput, SaveEnterpriseStandardInput, SaveRiskDispositionInput } from '../shared/assurance';

const line = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum).refine(value => !/[\u0000-\u001f\u007f]/u.test(value), '文字不能包含控制字符。').transform(value => value.normalize('NFC'));
const prose = (maximum: number) => z.string().trim().max(maximum).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), '文字不能包含控制字符。').transform(value => value.normalize('NFC'));
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const contractTypes = ['procurement', 'service', 'other'] as const;
const partyRoles = ['buyer', 'seller', 'service_provider', 'service_recipient', 'other'] as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => { const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value; }, '日期须为有效的 YYYY-MM-DD 公历日期。');
const literalTerms = z.array(line(1, 120)).max(20).transform(values => [...new Set(values)]);
const contentSchema = z.object({
  name: line(1, 120), description: prose(2000),
  contractTypes: z.array(z.enum(contractTypes)).min(1).max(contractTypes.length).transform(values => contractTypes.filter(value => values.includes(value))),
  partyRoles: z.array(z.enum(partyRoles)).min(1).max(partyRoles.length).transform(values => partyRoles.filter(value => values.includes(value))),
  rules: z.array(z.object({
    key: line(1, 80).refine(value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value), '规则标识仅允许字母、数字、点、下划线和连字符。'),
    name: line(1, 120), enabled: z.boolean(), kind: z.enum(['required_topic', 'flag_phrase']),
    terms: z.array(line(1, 120)).min(1).max(20).transform(values => [...new Set(values)]),
    category: z.enum(['legal', 'commercial', 'operational']), severity: z.enum(['high', 'medium', 'low', 'unrated']), guidance: prose(2000),
    conditions: z.object({
      contractTypes: z.array(z.enum(contractTypes)).min(1).max(3).optional(),
      partyRoles: z.array(z.enum(partyRoles)).min(1).max(5).optional(),
      triggerMode: z.enum(['any', 'all']).optional(), triggerTerms: literalTerms.optional(), excludeTerms: literalTerms.optional(),
      validFrom: isoDate.optional(), validTo: isoDate.optional(),
    }).strict().refine(value => !value.validFrom || !value.validTo || value.validFrom <= value.validTo, '适用开始日须不晚于结束日。').optional(),
    basis: z.object({ title: line(1, 200), source: prose(1000), description: prose(2000) }).strict().optional(),
  }).strict()).max(50).refine(values => new Set(values.map(value => value.key)).size === values.length, '企业规则标识不可重复。'),
  checks: z.object({ amounts: z.boolean(), dates: z.boolean(), references: z.boolean(), parties: z.boolean().optional() }).strict(),
  thresholds: z.object({ maxPrepaymentPercent: z.number().finite().min(0).max(100).refine(value => /^\d+(?:\.\d{1,2})?$/u.test(String(value)), '预付款比例最多保留两位小数。').nullable(), maxPaymentDays: z.number().int().min(1).max(3650).nullable() }).strict(),
  workflow: z.object({ runEnterpriseRules: z.boolean(), highRiskHandling: z.enum(['manual_review', 'escalate']), plan: reviewWorkflowSchema.optional() }).strict(),
  calendar: z.object({ name: line(1, 120), validFrom: isoDate, validTo: isoDate,
    weekendDays: z.array(z.number().int().min(0).max(6)).max(7), holidays: z.array(isoDate).max(5000), workingDays: z.array(isoDate).max(5000),
  }).strict().refine(value => value.validFrom <= value.validTo, '工作日历适用日期倒置。').refine(value => !value.holidays.some(day => value.workingDays.includes(day)), '同一天不能既为休息日又为补班日。').refine(value => [...value.holidays, ...value.workingDays].every(day => day >= value.validFrom && day <= value.validTo), '休息日或补班日超出日历适用范围。').optional(),
}).strict();

function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`企业审核标准输入无效：${result.error.issues.map(issue => `${issue.path.join('.') || '标准'} ${issue.message}`).slice(0, 5).join('；')}`);
  return result.data;
}

export function normalizeEnterpriseStandardContent(input: unknown): EnterpriseStandardContent { return validated(contentSchema, input); }
export function normalizeSaveEnterpriseStandardInput(input: unknown): SaveEnterpriseStandardInput {
  return validated(z.object({ standardId: z.string().uuid().optional(), expectedRevision: revision, content: contentSchema }).strict(), input);
}
export function normalizePublishEnterpriseStandardInput(input: unknown): PublishEnterpriseStandardInput {
  return validated(z.object({ standardId: z.string().uuid(), expectedRevision: revision, publishedBy: line(1, 80) }).strict(), input);
}
export function normalizeSaveRiskDispositionInput(input: unknown): SaveRiskDispositionInput {
  return validated(z.object({ reviewId: z.string().uuid(), findingId: z.string().uuid(), expectedRevision: revision,
    status: z.enum(['unreviewed', 'confirmed', 'needs_information', 'escalated', 'business_accepted', 'fixed', 'false_positive']),
    reason: prose(2000).refine(value => value.length > 0, '请填写处置原因。'), actorLabel: line(1, 80),
  }).strict(), input);
}

const escapeLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) { const error = new Error('企业规则检查已取消。'); error.name = 'AbortError'; throw error; } }
function exactQuote(text: string, index: number, length: number): string {
  let start = Math.max(0, index - 80); let end = Math.min(text.length, index + length + 80);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]) && /[\uD800-\uDBFF]/u.test(text[start - 1])) start--;
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) end++;
  return text.slice(start, end);
}

/** Literal terms are enterprise attention checks, not determinations of law.
 * The caller checks the selected version's contract type/party applicability. */
export function evaluateEnterpriseRules(document: Pick<ContractDetail, 'blocks'>, snapshot: EnterpriseStandardSnapshot, signal?: AbortSignal, evaluation?: { context?: ReviewContext; evaluatedOn?: string }): ReviewFinding[] {
  cancelled(signal);
  const content = normalizeEnterpriseStandardContent(snapshot.content);
  if (!content.workflow.runEnterpriseRules) return [];
  const findings: ReviewFinding[] = [];
  for (const rule of content.rules) {
    cancelled(signal); if (!rule.enabled) continue;
    const conditions = rule.conditions;
    const basis = rule.basis ? `企业配置依据：${rule.basis.title}；来源：${rule.basis.source || '未填写'}；说明：${rule.basis.description || '未填写'}。该来源未经自动核验，不作为已验证法律依据。` : '';
    if (conditions) {
      const context = evaluation?.context; const day = evaluation?.evaluatedOn;
      const unknown = (conditions.contractTypes?.length || conditions.partyRoles?.length) && !context || (conditions.validFrom || conditions.validTo) && (!day || !isoDate.safeParse(day).success);
      if (unknown) {
        findings.push({ id: randomUUID(), blockIds: [], quote: '', title: `企业规则适用条件待确认：${rule.name}`, category: rule.category, severity: 'unrated', description: `规则配置了合同范围或适用日期，但本次未提供足够的审核上下文；未擅自执行。${basis}`, suggestion: '补充合同类型、我方立场及审核日期后重审。', legalBasis: null, basisStatus: 'unverified', citations: [], source: 'rule', origin: 'enterprise', checkKey: `enterprise:${snapshot.id}:${rule.key}`, locationStatus: 'unmatched' });
        continue;
      }
      if (conditions.contractTypes?.length && !conditions.contractTypes.includes(context!.contractType) || conditions.partyRoles?.length && !conditions.partyRoles.includes(context!.ourPartyRole) || conditions.validFrom && day! < conditions.validFrom || conditions.validTo && day! > conditions.validTo) continue;
      const includes = (term: string) => document.blocks.some(block => block.text.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
      if (conditions.excludeTerms?.some(includes)) continue;
      if (conditions.triggerTerms?.length && !(conditions.triggerMode === 'all' ? conditions.triggerTerms.every(includes) : conditions.triggerTerms.some(includes))) continue;
    }
    // Every alternative is an escaped, bounded literal. User expressions are
    // never compiled as regex syntax and no fuzzy/semantic match is implied.
    const expression = new RegExp(rule.terms.map(escapeLiteral).join('|'), 'iu');
    let hit: { blockId: string; quote: string } | undefined;
    for (const block of document.blocks) {
      cancelled(signal); const match = expression.exec(block.text);
      if (match) { hit = { blockId: block.id, quote: exactQuote(block.text, match.index, match[0].length) }; break; }
    }
    if (rule.kind === 'required_topic' && !hit) findings.push({
      id: randomUUID(), blockIds: [], quote: '', title: `企业关注待确认：${rule.name}`, category: rule.category, severity: 'unrated',
      description: `按企业标准“${content.name}”v${snapshot.versionNo}，未在已解析文字中匹配所配置的主题词，需人工确认相关安排。仅有限字面匹配，不能据此认定缺少条款。企业配置的关注优先级为${rule.severity}，不等于法律风险定级或法律强制要求。${basis}`,
      suggestion: rule.guidance || '结合全文、附件及业务安排人工确认本企业关注事项。', legalBasis: null, basisStatus: 'unverified', citations: [], source: 'rule', origin: 'enterprise', checkKey: `enterprise:${snapshot.id}:${rule.key}`, locationStatus: 'unmatched',
    });
    if (rule.kind === 'flag_phrase' && hit) findings.push({
      id: randomUUID(), blockIds: [hit.blockId], quote: hit.quote, title: `企业标准关注：${rule.name}`, category: rule.category, severity: rule.severity,
      description: `原文命中企业标准“${content.name}”v${snapshot.versionNo}配置的关注词。等级采用企业配置，仅表示企业审核关注，不是违法、合同效力或法律强制义务的判定。${basis}`,
      suggestion: rule.guidance || '按企业内部要求核对业务事实并人工判断是否调整。', legalBasis: null, basisStatus: 'unverified', citations: [], source: 'rule', origin: 'enterprise', checkKey: `enterprise:${snapshot.id}:${rule.key}`, locationStatus: 'matched',
    });
  }
  return findings;
}
