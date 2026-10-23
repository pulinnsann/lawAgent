import { randomUUID } from 'node:crypto';
import type { ContractBlock } from '../shared/contracts';
import type { ProgramCheckInput, ProgramCheckIssue, ProgramCheckKind, ProgramCheckReport, ProgramCheckRunner } from '../shared/assurance';

const VERSION = 'program-checks-0.2.0';
const MAX_BLOCKS = 10_000;
const MAX_CHARACTERS = 2_000_000;
const MAX_BLOCK_CHARACTERS = 100_000;
const MAX_ISSUES = 100;
const kinds: ProgramCheckKind[] = ['amounts', 'dates', 'references', 'parties'];
const requiredKinds = ['amounts', 'dates', 'references'] as const;
type Coverage = ProgramCheckReport['checks'][number];
type Block = Pick<ContractBlock, 'id' | 'text'> & Partial<Pick<ContractBlock, 'kind' | 'locator'>> & { numberingLabel?: string };
type Money = { minor: bigint; currency: string; raw: string; end: number };
type DateToken = { start: number; end: number; year: number; month: number; day: number; valid: boolean; uncertain: boolean };

const thaiDigits = '๐๑๒๓๔๕๖๗๘๙';
const normalizedDigits = (text: string) => text.replace(/[๐-๙]/gu, value => String(thaiDigits.indexOf(value)));
const cancel = (signal?: AbortSignal) => signal?.throwIfAborted();
const addLimit = (coverage: Coverage, message: string, partial = true) => { if (!coverage.limitations.includes(message)) coverage.limitations.push(message); if (partial && coverage.status !== 'disabled') coverage.status = 'partial'; };
const moneyPrefix = '(?:人民币|CNY|RMB|美元|USD|欧元|EUR|泰铢|THB|บาท|英镑|GBP|\\$|¥|￥|€|฿|£)';
const moneySuffix = '(?:美元|欧元|泰铢|英镑|人民币|บาท|元)';
const decimalNumber = '[+-]?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,15})(?:\\.[0-9]{1,2})?';
const moneyLex = new RegExp(`\\s*(${moneyPrefix})?\\s*(${decimalNumber})\\s*(${moneySuffix})?`, 'iyu');
const currencyOf = (token: string | undefined): string | null => {
  if (!token) return null;
  if (/^(?:人民币|CNY|RMB|元|￥)$/iu.test(token)) return 'CNY';
  if (/^(?:美元|USD)$/iu.test(token)) return 'USD';
  if (/^(?:欧元|EUR|€)$/iu.test(token)) return 'EUR';
  if (/^(?:泰铢|THB|บาท|฿)$/iu.test(token)) return 'THB';
  if (/^(?:英镑|GBP|£)$/iu.test(token)) return 'GBP';
  return null;
};
function fixedDecimal(value: string, digits = 2): bigint | null {
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d{1,15})(?:\.\d{1,2})?$/u.test(value)) return null;
  const clean = value.replaceAll(',', ''); const negative = clean.startsWith('-');
  const [whole, fraction = ''] = clean.replace(/^[+-]/u, '').split('.');
  if (whole.length > 15 || fraction.length > digits) return null;
  return (negative ? -1n : 1n) * (BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0'));
}
function displayMinor(minor: bigint): string {
  const negative = minor < 0n; const value = negative ? -minor : minor;
  return `${negative ? '-' : ''}${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
function readMoney(text: string, start = 0): Money | null {
  moneyLex.lastIndex = start; const matched = moneyLex.exec(text);
  if (!matched) return null;
  const prefix = currencyOf(matched[1]); const suffix = currencyOf(matched[3]);
  // $ and ¥ alone are ambiguous. A named currency in the same token is needed.
  if (matched[1] && !prefix && !suffix || prefix && suffix && prefix !== suffix) return null;
  const currency = prefix ?? suffix; const minor = fixedDecimal(matched[2]);
  if (!currency || minor === null) return null;
  // Do not silently shorten 100万元, 1.234元, 100k, malformed grouping, etc.
  if (/^(?:\d|[.,]\d|[万亿萬億kKmM])/u.test(text.slice(moneyLex.lastIndex))) return null;
  return { minor, currency, raw: matched[0].trim(), end: moneyLex.lastIndex };
}
function moneyList(text: string): Money[] | null {
  const values: Money[] = []; let cursor = 0;
  while (cursor < text.length && values.length < 20) {
    const value = readMoney(text, cursor); if (!value) return null;
    values.push(value); cursor = value.end;
    const remainder = text.slice(cursor); if (!remainder.trim()) break;
    const separator = /^\s*(?:、|，|,|\+|and\b|และ)\s*/iu.exec(remainder); if (!separator) return null;
    cursor += separator[0].length; if (cursor >= text.length) return null;
  }
  return cursor >= text.length && values.length >= 2 ? values : null;
}
function wholeMoney(text: string): Money | null {
  const clean = text.trim().replace(/[。.!！]$/u, '').trim(); const value = readMoney(clean);
  return value && value.end === clean.length ? value : null;
}
function labeledMoney(text: string, start: number, unitPrice = false): Money | null {
  const value = readMoney(text, start); if (!value) return null;
  const after = text.slice(value.end);
  if (/^(?:$|[;；,，。.!！\n])/u.test(after)) return value;
  if (unitPrice && /^(?:\/(?:件|台|个|套|份|unit\b|item\b|piece\b)|per\s+(?:unit|item|piece)\b)/iu.test(after)) return value;
  return null;
}
function quoteAt(block: Block, start: number, end = start + 100): string {
  let left = Math.max(0, start - 45); let right = Math.min(block.text.length, Math.max(start + 100, end + 45), left + 1800);
  if (left && /[\uDC00-\uDFFF]/u.test(block.text[left])) left--;
  if (right < block.text.length && /[\uD800-\uDBFF]/u.test(block.text[right - 1])) right++;
  return block.text.slice(left, right);
}
function makeIssue(kind: ProgramCheckKind, block: Block, key: string, start: number, end: number, title: string, description: string, calculation: string | null, severity: ProgramCheckIssue['severity'] = 'medium'): ProgramCheckIssue {
  return { id: randomUUID(), key, kind, blockIds: [block.id], quote: quoteAt(block, start, end), title, description,
    suggestion: '请对照原合同及交易资料确认，并由法务决定是否修改；程序结果不构成法律效力判断。', severity, calculation };
}
const taxOrComplexMoney = /含税|不含税|税前|税后|税额|税率|增值税|VAT|\btax\b|ภาษี|汇率|exchange\s+rate|อัตราแลกเปลี่ยน|港币|港元|新台币|日元|日圆|JPY|HKD|NTD|折扣|优惠|运费|配送费|安装费|杂费|手续费|包装费|discount|shipping|freight|surcharge|additional\s+fee|ส่วนลด|ค่าขนส่ง/iu;
const moneyCandidate = /(?:金额|价款|单价|数量|合计|预付款|付款|支付|total|price|payment|amount|บาท|ชำระ|ยอดรวม)/iu;
function uncertainThresholdContext(text: string, index: number, end: number): boolean {
  return /不得|不应|不可|不予|不接受|不支付|不需要|无需|无须|禁止|例如|举例|假设|示例|\bno\s+(?:advance|prepayment)|\bnot\s+(?:pay|accept)|for\s+example|e\.g\.|ห้าม|ตัวอย่าง|สมมติ/iu.test(text.slice(Math.max(0, index - 35), index))
    || /^\s*(?:至|到|或|[-–~～]|\bor\b|\bto\b)/iu.test(text.slice(end, end + 12));
}

const financialDigits: Record<string, bigint> = { 零: 0n, 壹: 1n, 贰: 2n, 貳: 2n, 叁: 3n, 參: 3n, 肆: 4n, 伍: 5n, 陆: 6n, 陸: 6n, 柒: 7n, 捌: 8n, 玖: 9n };
function canonicalFinancialInteger(value: bigint): string {
  if (!value) return '零'; const names = '零壹贰叁肆伍陆柒捌玖'; const sections: number[] = [];
  for (let rest = value; rest; rest /= 10000n) sections.push(Number(rest % 10000n));
  let output = ''; let skipped = false;
  for (let index = sections.length - 1; index >= 0; index--) {
    const section = sections[index]; if (!section) { if (output) skipped = true; continue; }
    if (output && (skipped || section < 1000)) output += '零';
    let group = ''; let zero = false;
    for (let power = 3; power >= 0; power--) { const digit = Math.floor(section / 10 ** power) % 10;
      if (digit) { if (zero && group) group += '零'; group += `${names[digit]}${['', '拾', '佰', '仟'][power]}`; zero = false; }
      else if (group) zero = true;
    }
    output += group + ['', '万', '亿'][index]; skipped = false;
  }
  return output;
}
/** Strict finite financial numeral grammar; unsupported colloquial forms stay unknown. */
function uppercaseYuan(value: string): bigint | null {
  const matched = /^(?:人民币)?([零壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万萬亿億]{1,45})[元圆圓]((?:整|正)|(?:[零壹贰貳叁參肆伍陆陸柒捌玖]角)?(?:零?[壹贰貳叁參肆伍陆陸柒捌玖]分)?(?:整|正)?)$/u.exec(value.replace(/\s/gu, ''));
  if (!matched) return null;
  let total = 0n; let section = 0n; let pending: bigint | null = null; let lastUnit = 10000n; let lastSection = 1000000000000n;
  for (const character of matched[1]) {
    if (character in financialDigits) {
      const digit = financialDigits[character];
      if (digit === 0n) { if (pending !== null && pending !== 0n) return null; pending = null; continue; }
      if (pending !== null) return null; pending = digit;
    } else if ('拾佰仟'.includes(character)) {
      const unit = ({ 拾: 10n, 佰: 100n, 仟: 1000n } as Record<string, bigint>)[character];
      if (pending === null || unit >= lastUnit) return null;
      section += pending * unit; pending = null; lastUnit = unit;
    } else {
      const unit = /[万萬]/u.test(character) ? 10000n : 100000000n;
      if (unit >= lastSection || section + (pending ?? 0n) === 0n) return null;
      total += (section + (pending ?? 0n)) * unit; section = 0n; pending = null; lastUnit = 10000n; lastSection = unit;
    }
  }
  const whole = total + section + (pending ?? 0n);
  if (whole > 999999999999999n) return null;
  const simplified = matched[1].replace(/[貳參陸萬億]/gu, character => ({ 貳: '贰', 參: '叁', 陸: '陆', 萬: '万', 億: '亿' })[character]!);
  if (canonicalFinancialInteger(whole) !== simplified) return null;
  const jiao = /([零壹贰貳叁參肆伍陆陸柒捌玖])角/u.exec(matched[2]); const fen = /([壹贰貳叁參肆伍陆陸柒捌玖])分/u.exec(matched[2]);
  return whole * 100n + (jiao ? financialDigits[jiao[1]] * 10n : 0n) + (fen ? financialDigits[fen[1]] : 0n);
}
function advancedAmountChecks(block: Block, coverage: Coverage, emit: (issue: ProgramCheckIssue) => void): boolean {
  const text = normalizedDigits(block.text); let recognized = false;
  const capitals = [...text.matchAll(/(?:大写(?:金额)?|金额大写)\s*[:：]\s*([人民币零壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万萬亿億元圆圓角分整正\s]{2,80})/gu)];
  const numeric = [...text.matchAll(/(?<!大写)(?:小写(?:金额)?|数字金额|金额小写|合同金额|合同价款|金额)\s*[:：]\s*/gu)];
  if (capitals.length) {
    recognized = true;
    const small = numeric.length === 1 ? readMoney(text, numeric[0].index! + numeric[0][0].length) : null;
    const large = capitals.length === 1 ? uppercaseYuan(capitals[0][1].trim()) : null;
    if (!small || small.currency !== 'CNY' || large === null || capitals.length !== 1 || numeric.length !== 1 || small.minor < 0n || /待填写|TBD|_{2,}/iu.test(text)) addLimit(coverage, '大写金额缺少唯一明确的人民币数字金额对应关系，或超出受支持的大写语法，未比较。');
    else {
      coverage.checkedCount++;
      if (small.minor !== large) emit(makeIssue('amounts', block, 'amounts.uppercase_mismatch', 0, text.length, '人民币数字金额与中文大写不一致', '同一段唯一明确标注的数字人民币金额与财务大写金额不同。程序未自动采用其中一种金额。', `数字 ${displayMinor(small.minor)} CNY；大写解析 ${displayMinor(large)} CNY`));
    }
  }
  const labels = {
    base: [...text.matchAll(/(?:税前金额|不含税金额|税前价款)\s*[:：]\s*/gu)],
    tax: [...text.matchAll(/(?:^|[；;，,\s])税额\s*[:：]\s*/gu)],
    total: [...text.matchAll(/(?:含税金额|含税总价|价税合计)\s*[:：]\s*/gu)],
    rate: [...text.matchAll(/税率\s*[:：]\s*(\d{1,2}(?:\.\d{1,2})?)\s*[%％]/gu)],
  };
  if (labels.base.length && labels.tax.length && labels.total.length) {
    recognized = true;
    const one = (list: RegExpMatchArray[]) => list.length === 1 ? labeledMoney(text, list[0].index! + list[0][0].length) : null;
    const base = one(labels.base); const tax = one(labels.tax); const total = one(labels.total);
    if (!base || !tax || !total || base.currency !== tax.currency || tax.currency !== total.currency || [base, tax, total].some(value => value.minor < 0n) || /折扣|优惠|运费|汇率|discount|shipping/iu.test(text)) addLimit(coverage, '税前、税额与含税金额存在多组口径、附加项目或币种歧义，未比较。');
    else {
      coverage.checkedCount++; const sum = base.minor + tax.minor;
      if (sum !== total.minor) emit(makeIssue('amounts', block, 'amounts.tax_total_mismatch', 0, text.length, '税前金额加税额与含税金额不一致', '仅核对原文明确税前金额与税额的加法关系，不判断税率是否依法适用。', `${displayMinor(base.minor)} + ${displayMinor(tax.minor)} = ${displayMinor(sum)} ${total.currency}；原文含税 ${displayMinor(total.minor)} ${total.currency}`));
      if (labels.rate.length === 1) {
        const rate = fixedDecimal(labels.rate[0][1]);
        if (rate !== null) { coverage.checkedCount++; const rounded = (base.minor * rate + 5000n) / 10000n;
          if (rounded !== tax.minor) emit(makeIssue('amounts', block, 'amounts.tax_rate_mismatch', 0, text.length, '标注税率计算与税额不一致', '按原文明示单一税率计算，四舍五入至分；未判断税收政策、抵扣、差额征税或实际计税口径。', `${displayMinor(base.minor)} × ${displayMinor(rate)}% = ${displayMinor(rounded)} ${tax.currency}（四舍五入至分）；原文税额 ${displayMinor(tax.minor)}`));
        }
      } else if (labels.rate.length > 1) addLimit(coverage, '存在多组税率，未选择其中任一税率计算。');
    }
  }
  return recognized;
}

function partyChecks(blocks: Block[], coverage: Coverage, emit: (issue: ProgramCheckIssue) => void): void {
  const declarations = new Map<string, Array<{ block: Block; value: string; index: number; field: string }>>();
  const add = (role: string, field: string, value: string, block: Block, index: number) => {
    const key = `${role}:${field}`; const values = declarations.get(key) ?? []; values.push({ block, value, index, field }); declarations.set(key, values);
  };
  let previousRole: string | null = null;
  for (const block of blocks) {
    const text = block.text; const roles = [...text.matchAll(/(?:^|[\n；;])\s*(甲方|乙方|丙方|丁方|采购方|供应方|服务提供方|服务接受方)(?:名称|主体名称)?\s*[:：]\s*([^\n；;，,]{2,160})/gu)];
    for (const item of roles) {
      const value = item[2].trim();
      if (/待填写|待确认|_{2,}|以下简称|名称.*[:：]/u.test(value)) { addLimit(coverage, '主体名称含占位、别称或多重标签，未做确定的一致性比较。'); continue; }
      add(item[1], '名称', value.replace(/\s/gu, '').normalize('NFC'), block, item.index!);
    }
    const ids = [...text.matchAll(/(统一社会信用代码|注册编号|登记编号|registration\s+(?:number|no\.?))\s*[:：]\s*([A-Za-z0-9-]{4,40})(?![A-Za-z0-9-])/giu)];
    const role = roles.length === 1 ? roles[0][1] : roles.length === 0 && /^\s*(?:统一社会信用代码|注册编号|登记编号|registration\s+(?:number|no\.?))/iu.test(text) ? previousRole : null;
    for (const id of ids) {
      if (!role) { addLimit(coverage, '部分主体编号未与唯一主体角色明确关联，未跨主体比较。'); continue; }
      add(role, id[1].toLowerCase(), id[2].toUpperCase(), block, id.index!);
    }
    previousRole = roles.length === 1 ? roles[0][1] : null;
  }
  for (const [key, values] of declarations) {
    if (values.length < 2) continue;
    coverage.checkedCount++; const distinct = [...new Set(values.map(value => value.value))];
    if (distinct.length > 1) {
      const last = values.at(-1)!; const issue = makeIssue('parties', last.block, 'parties.inconsistent_identity', last.index, last.index + last.value.length, '同一主体角色的信息不一致', `已解析文字中同一标签“${key.split(':')[0]}”的${last.field}出现不同值；名称变更、主体替换或别称需由人工确认，程序不认定主体相同或不同。`, `${key}：${distinct.join(' ≠ ')}`, 'unrated'); issue.blockIds = [...new Set(values.map(value => value.block.id))]; emit(issue);
    }
  }
  if (declarations.size && !coverage.checkedCount) addLimit(coverage, '已提取主体标签，但缺少同角色同字段的重复明确声明，无法完成一致性比较。');
  addLimit(coverage, '仅比较同一主体角色明确声明的名称、统一社会信用代码或注册/登记编号；未查询登记机关，不校验身份真实性、不做别名归并。', false);
}

function tableChecks(blocks: Block[], coverage: Coverage, emit: (issue: ProgramCheckIssue) => void): void {
  const tables = new Map<string, Map<number, Map<number, Block[]>>>();
  for (const block of blocks) {
    if (block.locator?.kind !== 'docx') continue;
    const match = /^(.*\/w:tbl\[\d+\])\/w:tr\[(\d+)\]\/w:tc\[(\d+)\](?:\/|$)/u.exec(block.locator.structuralPath);
    if (!match || /\/w:tbl\[/u.test(block.locator.structuralPath.slice(match[1].length))) continue;
    const key = `${block.locator.partName}:${match[1]}`; const table = tables.get(key) ?? new Map(); const row = table.get(Number(match[2])) ?? new Map(); const cell = row.get(Number(match[3])) ?? [];
    cell.push(block); row.set(Number(match[3]), cell); table.set(Number(match[2]), row); tables.set(key, table);
  }
  for (const table of tables.values()) {
    const rows = [...table.entries()].sort(([a], [b]) => a - b).map(([, cells]) => cells); if (rows.length < 3) continue;
    const textOf = (items: Block[]) => items.map(item => item.text).join('\n').trim();
    const headers = [...rows[0].entries()].filter(([, items]) => /^(?:金额|金额[（(](?:元|CNY|人民币)[)）]|Amount\s*\(CNY\))$/iu.test(textOf(items)));
    if (headers.length !== 1) continue;
    const [column, header] = headers[0]; const currencyKnown = /元|CNY|人民币/iu.test(textOf(header)); const values: Money[] = []; const sources: Block[] = []; let total: Money | null = null; let totalBlock: Block | null = null; let ambiguous = false;
    for (let index = 1; index < rows.length; index++) {
      const row = rows[index]; const cells = [...row.entries()].sort(([a], [b]) => a - b); const valueBlocks = row.get(column); if (!valueBlocks || valueBlocks.length !== 1) { ambiguous = true; break; }
      if (row.size !== rows[0].size || [...row.keys()].some(key => !rows[0].has(key))) { ambiguous = true; break; }
      const amountText = textOf(valueBlocks); let money = wholeMoney(amountText);
      if (!money && currencyKnown) { const minor = fixedDecimal(amountText); if (minor !== null) money = { minor, currency: 'CNY', raw: amountText, end: amountText.length }; }
      const rowText = cells.map(([, items]) => textOf(items)).join('；');
      if (!money || /税|折扣|优惠|差额|运费|小计|subtotal|discount|tax/iu.test(rowText)) { ambiguous = true; break; }
      if (cells.some(([cellColumn, items]) => cellColumn !== column && /^(?:合计|总计|Total)$/iu.test(textOf(items)))) {
        if (total || index !== rows.length - 1) { ambiguous = true; break; } total = money; totalBlock = valueBlocks[0];
      } else { values.push(money); sources.push(valueBlocks[0]); }
    }
    if (!total || !totalBlock || values.length < 2) { if (ambiguous) addLimit(coverage, '部分金额表格存在空格、合并/多段单元格、税费或小计，未建立唯一跨段合计。'); continue; }
    if (ambiguous || values.some(value => value.currency !== total.currency)) { addLimit(coverage, '部分金额表格存在币种或行列歧义，未计算跨段合计。'); continue; }
    coverage.checkedCount++; const sum = values.reduce((accumulator, item) => accumulator + item.minor, 0n);
    if (sum !== total.minor) { const issue = makeIssue('amounts', totalBlock, 'amounts.table_total_mismatch', 0, totalBlock.text.length, '表格明确金额列与合计不一致', '同一DOCX表格的明确金额列、逐行数值与末行唯一合计建立了确定关系；不支持混合币种、税费、小计及复杂合并单元格。', `${values.map(value => displayMinor(value.minor)).join(' + ')} = ${displayMinor(sum)} ${total.currency}；表格合计 ${displayMinor(total.minor)}`); issue.blockIds = [...sources.map(block => block.id), totalBlock.id]; emit(issue); }
  }
}

function amountChecks(block: Block, input: ProgramCheckInput, coverage: Coverage, emit: (issue: ProgramCheckIssue) => void): void {
  const text = normalizedDigits(block.text); let recognized = advancedAmountChecks(block, coverage, emit);
  const financial = moneyCandidate.test(text) && /\d|待填写|待确认|_/.test(text);
  const uncertain = /待填写|待确认|未确定|\[\s*\]|_{2,}|\bTBD\b|to be (?:agreed|completed)|รอกรอก|รอยืนยัน/iu.test(text);
  const complex = taxOrComplexMoney.test(text);
  const totals = /(?:分项金额|各项金额|明细金额|line\s+amounts|item\s+amounts|ยอดรายการ)\s*[:：]\s*([^;；\n]{1,1000})[;；]\s*(?:合计金额|合计|总金额|total(?:\s+amount)?|ยอดรวม)\s*[:：]\s*([^。;；\n]{1,150})/giu;
  for (const match of text.matchAll(totals)) {
    recognized = true;
    const values = moneyList(match[1].trim()); const total = wholeMoney(match[2]);
    if (complex || uncertain || !values || !total || values.some(value => value.currency !== total.currency)) { addLimit(coverage, '部分分项合计因币种、税务、占位或数字语法不明确而未比较。'); continue; }
    coverage.checkedCount++; const sum = values.reduce((value, item) => value + item.minor, 0n);
    if (sum !== total.minor) emit(makeIssue('amounts', block, 'amounts.line_total_mismatch', match.index!, match.index! + match[0].length, '分项金额与合计不一致', '同一段明确列出的分项金额之和与合计金额不同；已按相同币种和最小货币单位精确计算。', `${values.map(value => displayMinor(value.minor)).join(' + ')} = ${displayMinor(sum)} ${total.currency}；原文合计 ${displayMinor(total.minor)} ${total.currency}`));
  }
  const percentageTotals = /(?:分期付款比例|各期付款比例|payment\s+percentages|สัดส่วนการชำระเงิน)\s*[:：]\s*([^;；\n]{1,500})[;；]\s*(?:合计比例|合计|total(?:\s+percentage)?|รวม)\s*[:：]\s*(\d{1,3}(?:\.\d{1,2})?)\s*[%％]/giu;
  for (const match of text.matchAll(percentageTotals)) {
    recognized = true;
    const parts = match[1].split(/\s*(?:、|，|,|\+)\s*/u); const values = parts.map(value => /^(\d{1,3}(?:\.\d{1,2})?)\s*[%％]$/u.exec(value.trim())?.[1]).map(value => value === undefined ? null : fixedDecimal(value));
    const total = fixedDecimal(match[2]);
    if (uncertain || parts.length < 2 || parts.length > 20 || values.some(value => value === null) || total === null) { addLimit(coverage, '部分分期付款比例因占位或语法不明确而未合计。'); continue; }
    coverage.checkedCount++; const sum = (values as bigint[]).reduce((value, item) => value + item, 0n);
    if (sum !== total) emit(makeIssue('amounts', block, 'amounts.payment_percentage_mismatch', match.index!, match.index! + match[0].length, '分期付款比例与标注合计不一致', '同一段明确列出的各期百分比之和与其标注合计不同；没有将未声明完整的部分付款安排强行凑为100%。', `${(values as bigint[]).map(value => `${displayMinor(value)}%`).join(' + ')} = ${displayMinor(sum)}%；原文合计 ${displayMinor(total)}%`));
  }
  const priceLabels = [...text.matchAll(/(?:单价|unit\s+price|ราคาต่อหน่วย)\s*[:：]/giu)];
  const quantityLabels = [...text.matchAll(/(?:数量|quantity|จำนวน)\s*[:：]\s*(\d{1,10})(?![\d.,])/giu)];
  const totalLabels = [...text.matchAll(/(?:总价|总金额|合计金额|合计|total(?:\s+amount)?|ยอดรวม)\s*[:：]/giu)];
  if (priceLabels.length && quantityLabels.length && totalLabels.length) {
    recognized = true;
    const priceMatch = priceLabels[0]; const totalMatch = totalLabels[0];
    const price = labeledMoney(text, priceMatch.index! + priceMatch[0].length, true); const total = labeledMoney(text, totalMatch.index! + totalMatch[0].length);
    if (priceLabels.length !== 1 || quantityLabels.length !== 1 || totalLabels.length !== 1 || complex || uncertain || !price || !total || price.currency !== total.currency) addLimit(coverage, '部分单价乘数量关系因多组数值、币种、税务或占位不明确而未比较。');
    else {
      coverage.checkedCount++; const quantity = BigInt(quantityLabels[0][1]); const expected = price.minor * quantity;
      if (expected !== total.minor) emit(makeIssue('amounts', block, 'amounts.unit_total_mismatch', priceMatch.index!, Math.max(total.end, quantityLabels[0].index! + quantityLabels[0][0].length), '单价乘数量与总价不一致', '同一段唯一标注的单价、整数数量与总价未满足乘积关系；未计算税费、折扣、汇率或额外费用。', `${displayMinor(price.minor)} × ${quantity} = ${displayMinor(expected)} ${price.currency}；原文总价 ${displayMinor(total.minor)} ${total.currency}`));
    }
  }
  if (input.thresholds.maxPrepaymentPercent !== null) {
    const threshold = fixedDecimal(String(input.thresholds.maxPrepaymentPercent));
    const patterns = [/(?:预付款比例|预付款|预付比例|预付)\s*(?:[:：为]|占(?:合同)?(?:总价|总金额|价款)(?:的)?)?\s*(\d{1,3}(?:\.\d{1,2})?)\s*[%％]/giu,
      /(?:prepayment|advance\s+payment)\s*(?:ratio\s*)?(?:[:：]|of|is|at)?\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/giu,
      /(?:ชำระล่วงหน้า|เงินล่วงหน้า)\s*[:：]?\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/gu];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
      recognized = true; const percentage = fixedDecimal(match[1]);
      if (uncertainThresholdContext(text, match.index!, match.index! + match[0].length)) { addLimit(coverage, '否定、示例或区间中的预付款比例未直接套用企业阈值。'); continue; }
      if (threshold === null || percentage === null) { addLimit(coverage, '部分预付款比例超出明确百分比语法，未套用企业阈值。'); continue; }
      coverage.checkedCount++;
      if (percentage > threshold) emit(makeIssue('amounts', block, 'amounts.prepayment_threshold', match.index!, match.index! + match[0].length, '预付款比例超过企业设定值', `原文明确的预付款比例高于本次审核标准的 ${input.thresholds.maxPrepaymentPercent}%。这是企业商业阈值提醒，不是法律禁止。`, `${displayMinor(percentage)}% > ${displayMinor(threshold)}%`));
    }
  }
  if (financial && (!recognized || uncertain)) addLimit(coverage, '存在未建立明确比较关系或仍待填写的金额、比例信息；未据此认定金额正确。');
}

const englishMonths = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const thaiMonths = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
function calendarValid(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function validIso(value: string): boolean { const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value); return !!match && calendarValid(Number(match[1]), Number(match[2]), Number(match[3])); }
function businessDateChecks(block: Block, input: ProgramCheckInput, coverage: Coverage, emit: (issue: ProgramCheckIssue) => void): void {
  const text = normalizedDigits(block.text); if (!/工作日|business\s+days|วันทำการ/iu.test(text)) return;
  const calendar = input.calendar;
  if (!calendar) { addLimit(coverage, '工作日期限未配置用户工作日历（含适用范围及休息/补班日期），未推算截止日。'); return; }
  const starts = [...text.matchAll(/付款起算日\s*[:：]\s*(\d{4}-\d{2}-\d{2})/gu)]; const terms = [...text.matchAll(/付款期限\s*[:：]\s*(\d{1,4})\s*(?:个)?工作日/gu)]; const due = [...text.matchAll(/付款截止日\s*[:：]\s*(\d{4}-\d{2}-\d{2})/gu)];
  if (starts.length !== 1 || terms.length !== 1 || due.length !== 1 || !/不含起算日|起算日不计入/u.test(text) || !validIso(starts[0][1]) || !validIso(due[0][1]) || uncertainThresholdContext(text, terms[0].index!, terms[0].index! + terms[0][0].length)) { addLimit(coverage, '工作日计算需唯一明确的付款起算日、工作日数、截止日及“不含起算日”约定；缺失或歧义未推算。'); return; }
  const days = Number(terms[0][1]); if (days < 1 || days > 3650) { addLimit(coverage, '工作日期限超出1–3650日的计算预算。'); return; }
  const start = starts[0][1]; if (start < calendar.validFrom || start > calendar.validTo) { addLimit(coverage, '付款起算日不在用户工作日历适用范围内，未推算。'); return; }
  const date = new Date(`${start}T00:00:00Z`); const holidays = new Set(calendar.holidays); const workdays = new Set(calendar.workingDays); let count = 0; let elapsed = 0;
  while (count < days && elapsed < 7300) {
    date.setUTCDate(date.getUTCDate() + 1); elapsed++; const iso = date.toISOString().slice(0, 10);
    if (iso > calendar.validTo) { addLimit(coverage, '付款期间超出用户工作日历适用范围，未用周末规则补猜未来节假日。'); return; }
    if (workdays.has(iso) || !holidays.has(iso) && !calendar.weekendDays.includes(date.getUTCDay())) count++;
  }
  if (count !== days) { addLimit(coverage, '工作日推算达到7300自然日预算，未生成截止日结论。'); return; }
  coverage.checkedCount++; const expected = date.toISOString().slice(0, 10); const calculation = `${start}（不含起算日）+ ${days} 工作日 = ${expected}；用户日历“${calendar.name}”[${calendar.validFrom}–${calendar.validTo}]；原文截止 ${due[0][1]}`;
  if (expected !== due[0][1]) emit(makeIssue('dates', block, 'dates.business_due_mismatch', 0, text.length, '工作日付款期限与标注截止日不一致', '按本次审核冻结的用户工作日历及原文明示的不含起算日规则推算；未自动取得或确认法定节假日。', calculation));
  if (input.thresholds.maxPaymentDays !== null && elapsed > input.thresholds.maxPaymentDays) emit(makeIssue('dates', block, 'dates.business_payment_threshold', 0, text.length, '工作日付款期限换算超过企业设定值', '按用户日历换算为自然日后超过企业付款天数阈值；这是企业商业提醒，不判断合同期限的法律效力。', `${elapsed} 自然日 > ${input.thresholds.maxPaymentDays} 自然日；${calculation}`));
}
const dateKey = (value: DateToken) => value.year * 10_000 + value.month * 100 + value.day;
function dateChecks(block: Block, input: ProgramCheckInput, coverage: Coverage, emit: (issue: ProgramCheckIssue) => void): void {
  const text = normalizedDigits(block.text); const tokens: DateToken[] = [];
  businessDateChecks(block, input, coverage, emit);
  const addDate = (match: RegExpMatchArray, year: number, month: number, day: number) => {
    const start = match.index!; const end = start + match[0].length;
    if (tokens.some(token => start < token.end && token.start < end)) return;
    const context = text.slice(Math.max(0, start - 30), Math.min(text.length, end + 8));
    const uncertain = /พ\.?\s*ศ\.?|พุทธศักราช|\bB\.?E\.?\b/iu.test(context) || year >= 2400 && /[ก-๛]/u.test(context);
    const valid = !uncertain && calendarValid(year, month, day); tokens.push({ start, end, year, month, day, valid, uncertain });
    if (uncertain) { addLimit(coverage, '部分泰文日期可能使用佛历或其他历法，未自动换算或判为错误。'); return; }
    coverage.checkedCount++;
    if (!valid) emit(makeIssue('dates', block, 'dates.invalid_calendar_date', start, end, '日期不符合公历日历', '原文明确数字日期的年月日组合在公历中不存在；未自动修正合同日期。', `原文数值：${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`));
  };
  for (const pattern of [/(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/gu, /(?<!\d)(\d{4})\/(\d{1,2})\/(\d{1,2})(?!\d)/gu]) for (const match of text.matchAll(pattern)) addDate(match, Number(match[1]), Number(match[2]), Number(match[3]));
  for (const match of text.matchAll(/(?<!\d)(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/gu)) addDate(match, Number(match[1]), Number(match[2]), Number(match[3]));
  const months = englishMonths.map(value => `${value}|${value.slice(0, 3)}\\.?`).join('|');
  for (const match of text.matchAll(new RegExp(`\\b(${months})\\s+(\\d{1,2})(?:,)?\\s+(\\d{4})\\b`, 'giu'))) addDate(match, Number(match[3]), englishMonths.findIndex(value => value.startsWith(match[1].replace('.', '').toLowerCase())) + 1, Number(match[2]));
  for (const match of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${months})\\s+(\\d{4})\\b`, 'giu'))) addDate(match, Number(match[3]), englishMonths.findIndex(value => value.startsWith(match[2].replace('.', '').toLowerCase())) + 1, Number(match[1]));
  for (const match of text.matchAll(new RegExp(`(\\d{1,2})\\s+(${thaiMonths.join('|')})\\s+(?:(?:ค\\.ศ\\.|พ\\.ศ\\.)\\s*)?(\\d{4})`, 'gu'))) addDate(match, Number(match[3]), thaiMonths.indexOf(match[2]) + 1, Number(match[1]));
  tokens.sort((a, b) => a.start - b.start);
  for (let index = 1; index < tokens.length; index++) {
    const left = tokens[index - 1]; const right = tokens[index]; if (!left.valid || !right.valid) continue;
    const prefix = text.slice(Math.max(0, left.start - 50), left.start); const between = text.slice(left.end, right.start);
    const range = /(?:自|从|\bfrom|ตั้งแต่|เริ่ม(?:วันที่)?)\s*$/iu.test(prefix) && /^\s*(?:起|日起)?\s*(?:至|到|to|until|through|ถึง)\s*$/iu.test(between);
    const labels = /(?:开始日期|起始日期|start\s+date|วันที่เริ่ม)\s*[:：]\s*$/iu.test(prefix) && /^\s*[;；,，]?\s*(?:结束日期|终止日期|届满日期|end\s+date|expiry\s+date|วันที่สิ้นสุด)\s*[:：]\s*$/iu.test(between);
    if (!range && !labels) continue;
    coverage.checkedCount++;
    if (dateKey(left) > dateKey(right)) emit(makeIssue('dates', block, 'dates.reversed_period', left.start, right.end, '明确期间的开始日晚于结束日', '同一段以自至、from/to或开始/结束标签明确关联的两个公历日期顺序倒置；未推断其他无关日期之间的关系。', `${text.slice(left.start, left.end)} > ${text.slice(right.start, right.end)}`));
  }
  if (input.thresholds.maxPaymentDays !== null) {
    const patterns = [/(?:付款期限|支付期限|付款期)\s*[:：为]?\s*(\d{1,5})\s*(?:个)?\s*(自然日|日|天)(?!\s*(?:工作|营业))/gu,
      /(?:payment\s+term|payment\s+period)\s*[:：]?\s*(\d{1,5})\s*(?:calendar\s+)?days\b/giu,
      /(?:กำหนดชำระเงิน|ระยะเวลาชำระเงิน)\s*[:：]?\s*(\d{1,5})\s*วัน(?!ทำการ)/gu];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
      if (uncertainThresholdContext(text, match.index!, match.index! + match[0].length) || /工作日|business\s+days|วันทำการ/iu.test(text)) { addLimit(coverage, '否定、示例、区间或工作日付款期限未自动换算并套用阈值。'); continue; }
      coverage.checkedCount++; const days = Number(match[1]);
      if (days > input.thresholds.maxPaymentDays) emit(makeIssue('dates', block, 'dates.payment_term_threshold', match.index!, match.index! + match[0].length, '付款期限超过企业设定值', `原文明确以日或天标注的付款期限数值高于本次标准的 ${input.thresholds.maxPaymentDays} 天。程序未解释起算条件，也未换算工作日。`, `${days} 日 > ${input.thresholds.maxPaymentDays} 日`));
    }
  }
  if (/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\d{4}\.\d{1,2}\.\d{1,2}|202[Xx]|_{2,}\s*年|待填写.*日期|\bTBD\b|วันทำการ|工作日|business\s+days/iu.test(text)) addLimit(coverage, '部分日期、历法或期限存在日月顺序、占位、工作日等未覆盖语法，未推定为已核验。');
}

function chineseNumber(value: string): number | null {
  if (/^\d{1,4}$/u.test(value)) { const number = Number(value); return number > 0 ? number : null; }
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^[零〇一二两三四五六七八九]{1,4}$/u.test(value)) { const number = Number([...value].map(character => digits[character]).join('')); return number > 0 ? number : null; }
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }; let total = 0; let pending = 0; let lastUnit = 10_000;
  for (const character of value) {
    if (character in digits) pending = digits[character];
    else if (character in units && units[character] < lastUnit) { total += (pending || 1) * units[character]; pending = 0; lastUnit = units[character]; }
    else return null;
  }
  const result = total + pending; return result > 0 && result < 10_000 ? result : null;
}
const chineseOrdinal = '[零〇一二两三四五六七八九十百千0-9]{1,12}';
type ClauseRef = { key: string; index: number; raw: string };
function headingRefs(block: Block): ClauseRef[] {
  const text = normalizedDigits(block.text); const values: ClauseRef[] = [];
  const add = (match: RegExpMatchArray, family: string, number: number | null) => { if (number !== null) values.push({ key: `${family}:${number}`, index: match.index!, raw: match[0].trim() }); };
  for (const match of text.matchAll(new RegExp(`(?:^|\\n)\\s*第(${chineseOrdinal})条(?=[\\s:：、.．]|$)`, 'gu'))) add(match, 'article', chineseNumber(match[1]));
  for (const match of text.matchAll(/(?:^|\n)\s*(Article|Section)\s+(\d{1,4})(?!\d)(?!\.\d)(?=[\s:：.]|$)/giu)) add(match, match[1].toLowerCase(), Number(match[2]) || null);
  for (const match of text.matchAll(/(?:^|\n)\s*ข้อ\s+(\d{1,4})(?!\d)(?!\.\d)(?=[\s:：.]|$)/gu)) add(match, 'thai_clause', Number(match[1]) || null);
  for (const match of text.matchAll(new RegExp(`(?:^|\\n)\\s*(?:附件|附录)\\s*(${chineseOrdinal})\\s*[:：、.．]`, 'gu'))) add(match, 'attachment', chineseNumber(match[1]));
  for (const match of text.matchAll(/(?:^|\n)\s*(?:Attachment|Annex|Schedule)\s+(\d{1,4})(?!\d)(?=[\s:：.]|$)/giu)) add(match, 'attachment', Number(match[1]) || null);
  if (block.numberingLabel) {
    const label = normalizedDigits(block.numberingLabel).trim(); const chinese = new RegExp(`^第(${chineseOrdinal})条[.．、:]?$`, 'u').exec(label);
    if (chinese) { const number = chineseNumber(chinese[1]); if (number) values.push({ key: `article:${number}`, index: 0, raw: block.numberingLabel }); }
    const decimal = /^(\d{1,4}(?:\.\d{1,4}){0,4})[.．、)]?$/u.exec(label);
    if (decimal) values.push({ key: `article:${decimal[1]}`, index: 0, raw: block.numberingLabel });
    const english = /^(Article|Section)\s+(\d{1,4})(?:[.．、:]|$)/iu.exec(label);
    if (english) values.push({ key: `${english[1].toLowerCase()}:${Number(english[2])}`, index: 0, raw: block.numberingLabel });
    const thai = /^ข้อ\s+(\d{1,4})(?:[.．、:]|$)/u.exec(label);
    if (thai) values.push({ key: `thai_clause:${Number(thai[1])}`, index: 0, raw: block.numberingLabel });
  }
  return values.filter((item, index) => values.findIndex(other => item.key === other.key) === index);
}
function internalRefs(block: Block): ClauseRef[] {
  const text = normalizedDigits(block.text); const values: ClauseRef[] = [];
  const add = (match: RegExpMatchArray, family: string, number: number | null) => { if (number !== null) values.push({ key: `${family}:${number}`, index: match.index!, raw: match[0] }); };
  for (const match of text.matchAll(new RegExp(`(?:本合同|本协议)(?:中|的|之)?\\s*第(${chineseOrdinal})条`, 'gu'))) add(match, 'article', chineseNumber(match[1]));
  for (const match of text.matchAll(/\b(Article|Section)\s+(\d{1,4})(?![\d.])\s+of\s+this\s+(?:Agreement|Contract)\b/giu)) add(match, match[1].toLowerCase(), Number(match[2]) || null);
  for (const match of text.matchAll(/\bthis\s+(?:Agreement|Contract)(?:'s)?\s*[,，]?\s*(Article|Section)\s+(\d{1,4})(?![\d.])/giu)) add(match, match[1].toLowerCase(), Number(match[2]) || null);
  for (const match of text.matchAll(/ข้อ\s+(\d{1,4})(?![\d.])\s*(?:ของ|ตาม)?\s*สัญญานี้/gu)) add(match, 'thai_clause', Number(match[1]) || null);
  for (const match of text.matchAll(new RegExp(`(?:本合同|本协议)(?:的|之)?\\s*(?:附件|附录)\\s*(${chineseOrdinal})(?![零〇一二两三四五六七八九十百千0-9])`, 'gu'))) add(match, 'attachment', chineseNumber(match[1]));
  for (const match of text.matchAll(/\b(?:Attachment|Annex|Schedule)\s+(\d{1,4})(?!\d)\s+of\s+this\s+(?:Agreement|Contract)\b/giu)) add(match, 'attachment', Number(match[1]) || null);
  for (const match of text.matchAll(/(?:本合同|本协议)(?:中|的|之)?\s*第(\d{1,4}(?:\.\d{1,4}){1,4})条/gu)) values.push({ key: `article:${match[1]}`, index: match.index!, raw: match[0] });
  return values;
}

/** Finite, auditable syntax checks. No legal inference, model, filesystem or
 * network access. Unrecognized relationships stay explicitly partial. */
export const runProgramChecks: ProgramCheckRunner = (document, input, signal) => {
  cancel(signal);
  if (!input || requiredKinds.some(kind => typeof input.checks?.[kind] !== 'boolean') || input.checks.parties !== undefined && typeof input.checks.parties !== 'boolean' || !input.thresholds || input.thresholds.maxPrepaymentPercent !== null && (!Number.isFinite(input.thresholds.maxPrepaymentPercent) || input.thresholds.maxPrepaymentPercent < 0 || input.thresholds.maxPrepaymentPercent > 100 || fixedDecimal(String(input.thresholds.maxPrepaymentPercent)) === null) || input.thresholds.maxPaymentDays !== null && (!Number.isSafeInteger(input.thresholds.maxPaymentDays) || input.thresholds.maxPaymentDays < 0 || input.thresholds.maxPaymentDays > 36500)) throw new Error('程序核验配置无效。');
  if (input.calendar && (!input.calendar.name || !validIso(input.calendar.validFrom) || !validIso(input.calendar.validTo) || input.calendar.validFrom > input.calendar.validTo || !Array.isArray(input.calendar.weekendDays) || input.calendar.weekendDays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || !Array.isArray(input.calendar.holidays) || !Array.isArray(input.calendar.workingDays) || [...input.calendar.holidays, ...input.calendar.workingDays].some(day => !validIso(day) || day < input.calendar!.validFrom || day > input.calendar!.validTo) || input.calendar.holidays.some(day => input.calendar!.workingDays.includes(day)))) throw new Error('程序工作日历配置无效。');
  const activeKinds: readonly ProgramCheckKind[] = input.checks.parties === undefined ? requiredKinds : kinds;
  const report: ProgramCheckReport = { engineVersion: VERSION, checks: activeKinds.map(kind => ({ kind, status: input.checks[kind] ? 'completed' : 'disabled', checkedCount: 0, limitations: [] })), issues: [] };
  const byKind = Object.fromEntries(report.checks.map(coverage => [coverage.kind, coverage])) as Record<ProgramCheckKind, Coverage>;
  if (!kinds.some(kind => input.checks[kind])) return report;
  if (!document || !Array.isArray(document.blocks)) throw new Error('待核验合同内容无效。');
  const blocks: Block[] = []; const ids = new Set<string>(); let remaining = MAX_CHARACTERS; let bounded = document.blocks.length > MAX_BLOCKS;
  for (const block of document.blocks.slice(0, MAX_BLOCKS)) {
    cancel(signal);
    if (!block || typeof block.id !== 'string' || !block.id || ids.has(block.id) || typeof block.text !== 'string') throw new Error('程序核验的原文块或定位无效。');
    ids.add(block.id); const limit = Math.min(remaining, MAX_BLOCK_CHARACTERS); if (limit <= 0) { bounded = true; break; }
    // Never create a synthetic token boundary by truncating a number/date.
    if (block.text.length > limit) { bounded = true; continue; }
    blocks.push({ ...block }); remaining -= block.text.length;
  }
  const emit = (issue: ProgramCheckIssue) => {
    if (report.issues.length < MAX_ISSUES) report.issues.push(issue);
    else addLimit(byKind[issue.kind], '核验提示达到100项上限，后续提示未完整列出。');
  };
  if (input.checks.amounts) addLimit(byKind.amounts, '有限核对明确金额合计、单价乘整数数量、付款比例、唯一人民币数字/大写对照、明示税前/税额/含税口径及结构明确的DOCX表格金额列；不推断折扣、汇率、利息或复杂表格。', false);
  if (input.checks.dates) addLimit(byKind.dates, '核对明确公历日期、同段明确期间及付款天数；工作日仅在用户日历有效范围与明确不含起算日约定下推算，不自动取得法定节假日。', false);
  if (input.checks.references) addLimit(byKind.references, '按明确条号、附件标题及已可靠提取的Word自动编号核对显式内部引用；未提取自动编号、任意隐式指代和外部法律引用不推断。', false);
  if (input.checks.amounts) tableChecks(blocks, byKind.amounts, emit);
  if (input.checks.parties) partyChecks(blocks, byKind.parties, emit);
  const headings = new Map<string, number>();
  if (input.checks.references) for (const block of blocks) { cancel(signal); for (const heading of headingRefs(block)) headings.set(heading.key, (headings.get(heading.key) ?? 0) + 1); }
  if (input.checks.references && [...headings.values()].some(count => count > 1)) addLimit(byKind.references, '识别到重复条号标题，条号索引存在歧义；匹配不代表交叉引用语义正确。');
  for (const block of blocks) {
    cancel(signal);
    if (input.checks.amounts) amountChecks(block, input, byKind.amounts, emit);
    if (input.checks.dates) dateChecks(block, input, byKind.dates, emit);
    if (input.checks.references) for (const ref of internalRefs(block)) {
      if (!headings.size) { addLimit(byKind.references, '未提取到可靠的条号标题，无法核对内部引用；可能存在Word自动编号，不能视为引用正确或条款缺失。'); continue; }
      byKind.references.checkedCount++;
      if (!headings.has(ref.key)) {
        addLimit(byKind.references, '部分内部引用未在已提取条号标题中匹配，需核对自动编号、遗漏或解析缺口。');
        emit(makeIssue('references', block, 'references.unmatched_internal_clause', ref.index, ref.index + ref.raw.length, '内部条款引用需核对', '原文明确指向本合同的条号，未在已提取的条号标题中匹配。自动编号、缺少标题或解析缺口也可能造成未匹配，不能据此断定条款不存在。', null, 'unrated'));
      }
    }
  }
  for (const coverage of report.checks) if (coverage.status !== 'disabled') {
    if (!coverage.checkedCount) addLimit(coverage, '本轮未找到可按受支持语法完成核验的候选；不表示未发现问题或核验通过。');
    if (document.partial) addLimit(coverage, '原文解析不完整，程序仅核对已提取内容。');
    if (bounded) addLimit(coverage, '程序核验达到块数或文字预算，未覆盖全部原文。');
  }
  cancel(signal); return report;
};
