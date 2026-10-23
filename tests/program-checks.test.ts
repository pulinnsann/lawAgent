import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runProgramChecks } from '../src/core/program-checks';
import type { ContractDetail } from '../src/shared/contracts';
import type { ProgramCheckInput, ProgramCheckKind } from '../src/shared/assurance';

const defaults: ProgramCheckInput = { checks: { amounts: true, dates: true, references: true }, thresholds: { maxPrepaymentPercent: null, maxPaymentDays: null } };
function document(texts: string[], partial = false): Pick<ContractDetail, 'blocks' | 'partial'> {
  return { partial, blocks: texts.map((text, ordinal) => ({ id: randomUUID(), ordinal, kind: 'paragraph', text, locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: `/w:document[1]/w:body[1]/w:p[${ordinal + 1}]`, paragraphId: null } })) };
}
function check(texts: string[], extra: Partial<ProgramCheckInput> = {}, partial = false) { return runProgramChecks(document(texts, partial), { ...defaults, ...extra }); }
const coverage = (report: ReturnType<typeof check>, kind: ProgramCheckKind) => report.checks.find(item => item.kind === kind)!;

test('金额按最小货币单位精确相加，0.1+0.2与大数不发生浮点误差', () => {
  const report = check(['分项金额：0.10元、0.20元；合计：0.30元。', '分项金额：人民币999,999,999,999.99元、人民币0.01元；合计：人民币1,000,000,000,000.00元。']);
  assert.equal(coverage(report, 'amounts').checkedCount, 2); assert.equal(coverage(report, 'amounts').status, 'completed');
  assert.equal(report.issues.length, 0);
});

test('明确分项合计、单价乘整数数量和分期比例的不一致保留算式与原文', () => {
  const source = document(['分项金额：人民币100元、人民币200元；合计：人民币350元。', '单价：人民币19.99元；数量：3件；总价：人民币60.00元。', '分期付款比例：30%、40%、20%；合计：100%。']);
  const report = runProgramChecks(source, defaults);
  assert.deepEqual(report.issues.map(item => item.key), ['amounts.line_total_mismatch', 'amounts.unit_total_mismatch', 'amounts.payment_percentage_mismatch']);
  assert.match(report.issues[0].calculation!, /100\.00 \+ 200\.00 = 300\.00 CNY/); assert.match(report.issues[1].calculation!, /19\.99 × 3 = 59\.97/);
  for (const item of report.issues) { assert.ok(item.id); assert.equal(item.kind, 'amounts'); assert.ok(source.blocks.some(block => item.blockIds.includes(block.id) && block.text.includes(item.quote))); }
});

test('英文和泰文明确金额保持币种与原文，支持泰文数字', () => {
  const source = document(['Line amounts: USD 0.10, USD 0.20; Total: USD 0.40.', 'ยอดรายการ: ๑๐๐ บาท, ๒๐๐ บาท; ยอดรวม: ๓๐๑ บาท', 'Unit price: EUR 12.50; Quantity: 4; Total: EUR 50.00.']);
  const report = runProgramChecks(source, defaults);
  assert.equal(coverage(report, 'amounts').checkedCount, 3); assert.equal(report.issues.length, 2);
  assert.ok(report.issues[0].calculation!.includes('USD')); assert.ok(report.issues[1].quote.includes('๑๐๐')); assert.ok(report.issues[1].calculation!.includes('THB'));
});

test('币种、税务、额外费用、大写或未知占位不被强行计算', () => {
  for (const text of ['分项金额：人民币100元、USD200；合计：人民币300元。', '分项金额：100元、200元；含税合计：330元。', '单价：100元；数量：2；运费50元；合计：250元。', '分项金额：$100、$200；合计：$300。', '单价：100元；数量：2.5；总价：250元。', '分项金额：[待填写]、200元；合计：300元。', '单价：1.234元；数量：2；合计：2.47元。', '单价：人民币100万元；数量：2；合计：人民币200万元。', '人民币大写金额：壹佰元整。', '单价：100元/月；数量：2台；合计：2400元。', '单价：CNY100USD；数量：2；合计：CNY300USD。']) {
    const report = check([text]); assert.equal(report.issues.length, 0, text); assert.equal(coverage(report, 'amounts').status, 'partial', text);
  }
});

test('预付款和付款期限只比较明确数值，企业阈值提醒与法律判断分开', () => {
  const report = check(['预付款占合同总价的60%。付款期限：90天。', 'Advance payment: 20%; Payment term: 30 calendar days.', 'ชำระล่วงหน้า: ๖๐%; กำหนดชำระเงิน: ๙๐ วัน'], { thresholds: { maxPrepaymentPercent: 50, maxPaymentDays: 60 } });
  assert.equal(report.issues.filter(item => item.key === 'amounts.prepayment_threshold').length, 2);
  assert.equal(report.issues.filter(item => item.key === 'dates.payment_term_threshold').length, 2);
  assert.ok(report.issues.every(item => item.key.includes('threshold'))); assert.ok(report.issues[0].description.includes('不是法律禁止'));
  assert.equal(check(['预付款：0.30%。'], { thresholds: { maxPrepaymentPercent: 0.29, maxPaymentDays: null } }).issues.length, 1);
});

test('否定、例子、区间和工作日期限不被当成确定交易阈值', () => {
  for (const text of ['不得支付预付款80%。', '例如预付款：80%。', '预付款：20%至80%。', '不得约定付款期限：90天。', '付款期限：90日（工作日）。', 'Payment term: 90 business days.', 'ตัวอย่าง ชำระล่วงหน้า: 80%']) {
    const report = check([text], { thresholds: { maxPrepaymentPercent: 10, maxPaymentDays: 10 } }); assert.equal(report.issues.length, 0, text);
  }
});

test('公历日期严格核验闰年、世纪规则和月日范围，绝不让Date自动进位', () => {
  const report = check(['2024年2月29日、2025年2月29日、1900-02-29、2000-02-29、2026/04/31、2026-13-01。']);
  assert.equal(coverage(report, 'dates').checkedCount, 6);
  assert.equal(report.issues.filter(item => item.key === 'dates.invalid_calendar_date').length, 4);
  assert.equal(report.issues.filter(item => item.key === 'dates.reversed_period').length, 0);
});

test('英文月名和泰文公历日期可核验，佛历与日月歧义保留partial', () => {
  const report = check(['February 30, 2025; 29 February 2024.', 'วันที่ ๒๙ กุมภาพันธ์ ค.ศ. ๒๐๒๕', 'วันที่ 29 กุมภาพันธ์ พ.ศ. 2569', 'Date: 01/02/2025; 202X年 月 日。']);
  assert.equal(report.issues.filter(item => item.key === 'dates.invalid_calendar_date').length, 2);
  assert.equal(coverage(report, 'dates').status, 'partial'); assert.ok(coverage(report, 'dates').limitations.some(value => value.includes('佛历')));
  assert.ok(!report.issues.some(item => item.quote.includes('2569')));
});

test('仅比较同段明确自至或开始结束标签，不凭任意两日期推断倒序', () => {
  const report = check(['租赁期限自2026年12月1日至2026年1月1日止。', 'Term from 2026-12-01 to 2026-01-01.', '开始日期：2026-12-01；结束日期：2026-01-01', '签订日2026-12-01。历史订单日2026-01-01。', '开始日期：2026-02-30；结束日期：2026-01-01']);
  assert.equal(report.issues.filter(item => item.key === 'dates.reversed_period').length, 3);
  assert.equal(report.issues.filter(item => item.key === 'dates.invalid_calendar_date').length, 1);
});

test('显式本合同内部条款引用按明确标题匹配，中英泰保留连续原文', () => {
  const source = document(['第一条 服务内容', '第二条 付款约定，按本合同第一条履行；争议见本合同第九条。', 'Article 1. Scope', 'Article 2 Payment under Article 1 of this Agreement; see Article 8 of this Agreement.', 'ข้อ ๑ ขอบเขต', 'ข้อ ๒ การชำระเงิน ตามข้อ ๑ ของสัญญานี้ และข้อ ๘ ของสัญญานี้']);
  const report = runProgramChecks(source, defaults);
  assert.equal(coverage(report, 'references').checkedCount, 6); assert.equal(report.issues.length, 3);
  assert.ok(report.issues.every(item => item.kind === 'references' && item.severity === 'unrated'));
  assert.ok(report.issues.every(item => source.blocks.some(block => item.blockIds.includes(block.id) && block.text.includes(item.quote))));
});

test('外部法律和其他协议引用不误判；无条号或隐式Word编号不判成功', () => {
  const report = check(['第一条 服务内容。', '依据《民法典》第九百条；另按采购协议第十条办理。See Section 99 of the Civil Code and Article 8 of the other Agreement.']);
  assert.equal(report.issues.length, 0); assert.equal(coverage(report, 'references').status, 'partial'); assert.equal(coverage(report, 'references').checkedCount, 0);
  const implicit = check(['服务内容', '付款根据本合同第九条执行。']);
  assert.equal(implicit.issues.length, 0); assert.equal(coverage(implicit, 'references').status, 'partial');
  assert.ok(coverage(implicit, 'references').limitations.some(value => value.includes('自动编号')));
});

test('解析partial、重复条号和无候选保留覆盖限制，检查开关真正生效', () => {
  const partial = check(['第一条 范围', '第一条 重复', '本合同第一条；2024-02-29。分项金额：100元、200元；合计：300元。'], {}, true);
  assert.ok(partial.checks.every(item => item.status === 'partial')); assert.ok(coverage(partial, 'references').limitations.some(value => value.includes('重复条号')));
  const none = check(['No applicable syntax.']); assert.ok(none.checks.every(item => item.status === 'partial' && item.checkedCount === 0));
  const disabled = check(['2025-02-30。预付款90%。'], { checks: { amounts: false, dates: false, references: false }, thresholds: { maxPrepaymentPercent: 10, maxPaymentDays: 1 } });
  assert.deepEqual(disabled.issues, []); assert.ok(disabled.checks.every(item => item.status === 'disabled' && item.checkedCount === 0));
});

test('提示和文字预算有界，过长块不切断数字产生伪计算', () => {
  const many = check(Array.from({ length: 130 }, () => '2025-02-30。'));
  assert.equal(many.issues.length, 100); assert.equal(coverage(many, 'dates').status, 'partial'); assert.ok(coverage(many, 'dates').limitations.some(value => value.includes('100项')));
  const bounded = check(['2025-02-30。' + 'a'.repeat(100000), '2024-02-29。']); assert.equal(bounded.issues.length, 0); assert.equal(coverage(bounded, 'dates').checkedCount, 1); assert.ok(coverage(bounded, 'dates').limitations.some(value => value.includes('预算')));
});

test('取消、失效定位和无效阈值明确拒绝，不读取文件或发送请求', () => {
  const controller = new AbortController(); controller.abort(); assert.throws(() => runProgramChecks(document(['2025-02-30']), defaults, controller.signal));
  assert.throws(() => check(['预付款50%'], { thresholds: { maxPrepaymentPercent: 100.1, maxPaymentDays: null } }), /配置无效/);
  assert.throws(() => check(['付款期限30天'], { thresholds: { maxPrepaymentPercent: null, maxPaymentDays: NaN } }), /配置无效/);
  const duplicate = document(['a', 'b']); duplicate.blocks[1].id = duplicate.blocks[0].id; assert.throws(() => runProgramChecks(duplicate, defaults), /定位无效/);
});
