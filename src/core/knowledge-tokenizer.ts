/** 索引/查询必须一起升级；ICU 版本也保存在版本中，跨运行时更新会重建。 */
export const KNOWLEDGE_TOKENIZER_VERSION = `icu-word-legal-1/icu-${process.versions.icu ?? 'unknown'}`;

const segmenter = new Intl.Segmenter(['zh', 'en', 'th'], { granularity: 'word' });
const topics = [
  ['payment', ['付款', '支付', '价款', '付款期限', 'payment', 'payments', 'pay', 'ชำระเงิน', 'การชำระเงิน']],
  ['acceptance', ['验收', '交付', 'acceptance', 'delivery', 'deliverables', 'ตรวจรับ', 'การตรวจรับ', 'ส่งมอบ']],
  ['breach', ['违约', '违约金', '赔偿', 'breach', 'liability', 'damages', 'penalty', 'ผิดสัญญา', 'ค่าเสียหาย']],
  ['termination', ['解除', '终止', 'termination', 'terminate', 'cancellation', 'เลิกสัญญา', 'บอกเลิก']],
  ['confidentiality', ['保密', '商业秘密', 'confidentiality', 'confidential', '秘密', 'ความลับ']],
  ['dispute', ['争议', '仲裁', '管辖', '诉讼', 'dispute', 'arbitration', 'jurisdiction', 'ข้อพิพาท', 'อนุญาโตตุลาการ']],
  ['intellectualproperty', ['知识产权', '著作权', 'intellectual property', 'copyright', 'ทรัพย์สินทางปัญญา']],
  ['warranty', ['质保', '保证', '瑕疵', 'warranty', 'guarantee', 'รับประกัน']],
  ['procurement', ['采购', '供应商', 'procurement', 'purchase', 'supplier', 'จัดซื้อ', 'ผู้ขาย']],
  ['service', ['服务', 'service', 'services', 'บริการ']],
] as const;
const stopWords = new Set(['的', '了', '和', '与', '及', '或', '是', '在', '请', '如何', '是否', 'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'is', 'for', 'what', 'how', 'does', 'do', 'are', 'can', 'ที่', 'และ']);
const normalize = (text: string): string => text.normalize('NFKC').toLowerCase();

function lexical(text: string): string[] {
  return [...segmenter.segment(normalize(text))]
    .filter(part => part.isWordLike)
    .map(part => part.segment)
    .filter(part => /[\p{L}\p{N}]/u.test(part) && part.length <= 80 && !stopWords.has(part));
}

function topicTerms(text: string): string[] {
  const normalized = normalize(text);
  return topics.filter(([, aliases]) => aliases.some(originalAlias => {
    const alias = normalize(originalAlias);
    if (/^[a-z ]+$/.test(alias)) {
      return new RegExp(`(?:^|[^a-z])${alias}(?:$|[^a-z])`, 'u').test(normalized);
    }
    return normalized.includes(alias);
  })).map(([topic]) => `legaltopic${topic}`);
}

/** 只改变检索字段；原文、引文和定位不经过归一化或翻译。 */
export function tokenizeKnowledgeText(text: string): string {
  return [...lexical(text), ...topicTerms(text)].join(' ');
}

/** 不接收 FTS 语法；所有词均被双引号转义，自然语言按 OR 召回。 */
export function knowledgeQuery(query: string, extraTerms: string[] = []): { expandedTerms: string[]; match: string | null } {
  const input = [query.slice(0, 2048), ...extraTerms.slice(0, 16).map(term => term.slice(0, 128))].join(' ');
  const expandedTerms = [...new Set([...topicTerms(input), ...lexical(input)])].slice(0, 48);
  return {
    expandedTerms,
    match: expandedTerms.length ? expandedTerms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ') : null,
  };
}
