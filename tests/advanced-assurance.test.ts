import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { runProgramChecks } from '../src/core/program-checks';
import { evaluateEnterpriseRules, normalizeEnterpriseStandardContent } from '../src/core/enterprise-standards';
import type { ContractBlock, ReviewContext } from '../src/shared/contracts';
import type { BusinessCalendar, EnterpriseStandardContent, EnterpriseStandardSnapshot, ProgramCheckInput } from '../src/shared/assurance';

const input: ProgramCheckInput = { checks: { amounts: true, dates: true, references: true, parties: true }, thresholds: { maxPrepaymentPercent: null, maxPaymentDays: null } };
const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '' };
function block(text: string, ordinal = 0): ContractBlock { return { id: randomUUID(), ordinal, kind: 'paragraph', text, locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: `/w:document[1]/w:body[1]/w:p[${ordinal + 1}]`, paragraphId: null } }; }
const check = (texts: string[], extra: Partial<ProgramCheckInput> = {}) => runProgramChecks({ partial: false, blocks: texts.map(block) }, { ...input, ...extra });
const content = (): EnterpriseStandardContent => ({ name: '测试标准', description: '', contractTypes: ['service'], partyRoles: ['service_recipient'], rules: [{ key: 'adjust', name: '单方调价', enabled: true, kind: 'flag_phrase', terms: ['自行调整价格'], severity: 'medium', category: 'commercial', guidance: '确认价格安排' }], checks: { amounts: true, dates: true, references: true }, thresholds: { maxPrepaymentPercent: null, maxPaymentDays: null }, workflow: { runEnterpriseRules: true, highRiskHandling: 'manual_review' } });
const snapshot = (value: EnterpriseStandardContent): EnterpriseStandardSnapshot => ({ id: randomUUID(), standardId: randomUUID(), versionNo: 1, content: value, contentSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'), publishedAt: '2026-01-01T00:00:00Z', publishedBy: '测试' });

test('旧企业标准JSON不补新字段，不改变发布内容摘要', () => {
  // Published content was already normalized by the original v6 schema.
  const old = normalizeEnterpriseStandardContent(content()); const serialized = JSON.stringify(old); const frozen = snapshot(old);
  assert.equal(JSON.stringify(normalizeEnterpriseStandardContent(old)), serialized);
  evaluateEnterpriseRules({ blocks: [block('供应商可自行调整价格。')] }, frozen);
  assert.equal(JSON.stringify(frozen.content), serialized); assert.equal(createHash('sha256').update(serialized).digest('hex'), frozen.contentSha256);
  assert.ok(!Object.hasOwn(normalizeEnterpriseStandardContent(old).checks, 'parties'));
});

test('企业规则合同范围、审核日期、all/any触发词与排除词有限执行并携带未核验企业依据', () => {
  const current = content(); current.rules[0].conditions = { contractTypes: ['service'], partyRoles: ['service_recipient'], triggerMode: 'all', triggerTerms: ['年度服务', '续期'], excludeTerms: ['企业特批'], validFrom: '2026-01-01', validTo: '2026-12-31' };
  current.rules[0].basis = { title: '采购制度第3条', source: '内部制度-2026-03', description: '价格调整需审批' };
  const frozen = snapshot(current); const evaluation = { context, evaluatedOn: '2026-10-23' };
  const evaluate = (text: string, options = evaluation) => evaluateEnterpriseRules({ blocks: [block(text)] }, frozen, undefined, options);
  assert.equal(evaluate('年度服务续期供应商可自行调整价格。').length, 1);
  assert.match(evaluate('年度服务续期供应商可自行调整价格。')[0].description, /内部制度-2026-03.*未经自动核验/u);
  assert.equal(evaluate('年度服务供应商可自行调整价格。').length, 0);
  assert.equal(evaluate('年度服务续期供应商可自行调整价格。企业特批').length, 0);
  assert.equal(evaluate('年度服务续期供应商可自行调整价格。', { ...evaluation, evaluatedOn: '2027-01-01' }).length, 0);
  assert.equal(evaluate('年度服务续期供应商可自行调整价格。', { ...evaluation, context: { ...context, contractType: 'other' } }).length, 0);
  const unknown = evaluateEnterpriseRules({ blocks: [block('自行调整价格')] }, frozen);
  assert.equal(unknown[0].severity, 'unrated'); assert.match(unknown[0].title, /适用条件待确认/u);
  current.rules[0].conditions.triggerMode = 'any'; assert.equal(evaluate('续期自行调整价格。').length, 1);
  assert.throws(() => normalizeEnterpriseStandardContent({ ...current, rules: [{ ...current.rules[0], conditions: { validFrom: '2026-02-30' } }] }), /日期/u);
});

test('大写人民币与唯一数字金额精确对照，未知或多组对应不猜', () => {
  assert.equal(check(['金额：人民币12345.67元（大写：壹万贰仟叁佰肆拾伍元陆角柒分）。']).issues.length, 0);
  const mismatch = check(['小写金额：人民币100.01元；大写金额：壹佰元整。']);
  assert.equal(mismatch.issues.filter(issue => issue.key === 'amounts.uppercase_mismatch').length, 1);
  assert.match(mismatch.issues[0].calculation!, /100\.01.*100\.00/u);
  for (const text of ['金额：100元；金额：200元；大写：壹佰元整。', '金额：USD100；大写：壹佰元整。', '金额：100元；大写：壹壹元整。']) {
    const report = check([text]); assert.ok(!report.issues.some(issue => issue.key === 'amounts.uppercase_mismatch')); assert.equal(report.checks.find(item => item.kind === 'amounts')!.status, 'partial');
  }
});

test('明确税前金额、税额、含税金额与单一税率按分四舍五入，混合税务不强算', () => {
  const report = check(['税前金额：100元；税率：13%；税额：13元；含税金额：114元。', '税前金额：0.05元；税率：13%；税额：0.01元；含税金额：0.06元。']);
  assert.equal(report.issues.filter(issue => issue.key === 'amounts.tax_total_mismatch').length, 1);
  assert.equal(report.issues.filter(issue => issue.key === 'amounts.tax_rate_mismatch').length, 0);
  const rate = check(['税前金额：100元；税率：13%；税额：12元；含税金额：112元。']);
  assert.equal(rate.issues.filter(issue => issue.key === 'amounts.tax_rate_mismatch').length, 1);
  assert.ok(!check(['税前金额：USD100；税额：13元；含税金额：113元。']).issues.length);
  assert.ok(!check(['税前金额：100元；税额：13元；含税金额：118元；运费：5元。']).issues.length);
});

test('同一DOCX表格唯一金额列逐行合计，原文定位包含参与行且不混合不同表格', () => {
  const cells = [['项目', '金额（元）'], ['服务A', '0.10'], ['服务B', '0.20'], ['合计', '0.40']];
  const blocks = cells.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({ ...block(text), kind: 'table_cell' as const, locator: { kind: 'docx' as const, partName: 'word/document.xml', structuralPath: `/w:document[1]/w:body[1]/w:tbl[1]/w:tr[${rowIndex + 1}]/w:tc[${columnIndex + 1}]/w:p[1]`, paragraphId: null } })));
  const report = runProgramChecks({ blocks, partial: false }, input); const issue = report.issues.find(item => item.key === 'amounts.table_total_mismatch')!;
  assert.ok(issue); assert.equal(issue.blockIds.length, 3); assert.match(issue.calculation!, /0\.10 \+ 0\.20 = 0\.30 CNY/u);
  blocks[3].text = '[待填写]'; assert.ok(!runProgramChecks({ blocks, partial: false }, input).issues.some(item => item.key === 'amounts.table_total_mismatch'));
});

test('主体名称与同类编号按同角色重复声明比较，不把甲乙方不同编号误判', () => {
  const report = check(['甲方：示例采购有限公司；统一社会信用代码：91310000AAAAAAAAAA', '乙方：示例服务有限公司；统一社会信用代码：91310000BBBBBBBBBB', '甲方：示例采购股份有限公司；统一社会信用代码：91310000CCCCCCCCCC']);
  assert.equal(report.issues.filter(issue => issue.kind === 'parties').length, 2); assert.ok(report.issues.every(issue => issue.severity === 'unrated'));
  assert.ok(!check(['甲方：示例采购有限公司；统一社会信用代码：91310000AAAAAAAAAA', '乙方：示例服务有限公司；统一社会信用代码：91310000BBBBBBBBBB']).issues.length);
  const disabled = check(['甲方：示例有限公司', '甲方：另一示例有限公司'], { checks: { ...input.checks, parties: false } }); assert.equal(disabled.issues.length, 0);
});

test('附件及可靠提取Word自动编号参与显式交叉引用，旧未提取编号仍partial', () => {
  const blocks = [block('附件一：费用清单'), { ...block('付款条款'), numberingLabel: '3.' }, block('按本合同附件一和本合同第三条履行；详见本合同附件二。')];
  const report = runProgramChecks({ blocks, partial: false }, input);
  assert.equal(report.issues.filter(issue => issue.kind === 'references').length, 1); assert.match(report.issues[0].quote, /附件二/u);
  assert.equal(report.checks.find(item => item.kind === 'references')!.checkedCount, 3);
  assert.equal(check(['未编号段落。', '按本合同第三条履行。']).issues.length, 0);
});

test('用户工作日历含休息与补班，超范围或缺起算口径不猜截止日期', () => {
  const calendar: BusinessCalendar = { name: '测试企业日历', validFrom: '2026-01-01', validTo: '2026-12-31', weekendDays: [0, 6], holidays: ['2026-01-05'], workingDays: ['2026-01-03'] };
  const source = '付款起算日：2026-01-02；付款期限：2工作日；付款截止日：2026-01-06；不含起算日。';
  assert.ok(!check([source], { calendar }).issues.length);
  const bad = check([source.replace('2026-01-06', '2026-01-05')], { calendar });
  assert.equal(bad.issues.filter(issue => issue.key === 'dates.business_due_mismatch').length, 1); assert.match(bad.issues[0].calculation!, /2026-01-06.*测试企业日历/u);
  assert.ok(!check([source.replace('；不含起算日', '')], { calendar }).issues.length);
  assert.ok(!check([source], { calendar: { ...calendar, validTo: '2026-01-05' } }).issues.length);
  assert.throws(() => check([source], { calendar: { ...calendar, holidays: ['2026-01-03'] } }), /日历/u);
});
