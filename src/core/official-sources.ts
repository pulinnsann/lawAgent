import type { OfficialRetrievalCoverage, OfficialSourceMetadata, SourceEvidence } from '../shared/contracts';
import { courtCatalogOptions, type CourtCatalogKind } from '../shared/official-discovery';
import { createRetrievalHttp, parseNetworkUrl, RetrievalError, type HttpResult } from './retrieval-http';

export const OFFICIAL_CATALOG_URL = 'https://xzfg.moj.gov.cn/search2.html';
export const OFFICIAL_SOURCE_LIMITS = Object.freeze({ catalogPages: 10, userUrls: 8, results: 8, documentReads: 16, excerptCharacters: 6000 });
export type OfficialPageReader = (url: string, signal: AbortSignal, seconds: number) => Promise<HttpResult>;
export interface OfficialSource extends Pick<SourceEvidence, 'kind' | 'title' | 'locator' | 'excerpt' | 'contentScope' | 'retrievedAt' | 'publishedAt' | 'effectiveAt' | 'warnings'> {
  sourceUri: string;
  officialMetadata: OfficialSourceMetadata;
}
export interface OfficialRetrievalInput {
  terms: string[];
  /** Kept for retrieval-attempt display; never sent to official sites. */
  query: string;
  maxResults: number;
  maxCatalogPages: number;
  courtCatalogs?: CourtCatalogKind[];
  sourceUrls: string[];
  timeoutSeconds: number;
}
export interface OfficialRetrievalResult {
  status: 'complete' | 'partial' | 'empty' | 'failed' | 'cancelled' | 'timeout';
  sources: OfficialSource[];
  coverage: OfficialRetrievalCoverage;
  warnings: string[];
}
type Discovery = Pick<OfficialSourceMetadata, 'discoveredVia' | 'catalogUrl'>;
type HtmlNode = { tag: string; attrs: Record<string, string>; children: Array<HtmlNode | string> };
const http = createRetrievalHttp();
const validityNote = '仅确认从官方公开页面取得文字；法律效力、现行版本、适用时间及案件相似性均未自动核验。';
const broadTerms = new Set(['合同', '服务', '采购', 'contract', 'contracts', 'service', 'services', 'procurement', 'สัญญา']);
const blocks = new Set(['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'br', 'hr']);
const ignored = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'nav', 'header', 'footer', 'button', 'input', 'select']);
const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Only verified public article routes are accepted, never arbitrary official-host paths. */
export function validateOfficialSourceUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 2048) throw new RetrievalError('failed', '官方来源地址无效。');
  const url = parseNetworkUrl(value.trim());
  if (url.protocol !== 'https:' || url.port || value.includes('#')) throw new RetrievalError('failed', '官方原文仅支持无凭据、无片段的标准 HTTPS 地址。');
  const host = url.hostname.toLowerCase();
  const keys = [...url.searchParams.keys()];
  if (host === 'xzfg.moj.gov.cn' && url.pathname === '/front/law/detail') {
    if (keys.some(key => !['LawID', 'Query'].includes(key)) || url.searchParams.getAll('LawID').length !== 1 || url.searchParams.getAll('Query').length > 1 || !/^[1-9]\d{0,8}$/.test(url.searchParams.get('LawID') ?? '')) throw new RetrievalError('failed', '行政法规来源必须是公开详情页的唯一 LawID。');
    return `https://xzfg.moj.gov.cn/front/law/detail?LawID=${url.searchParams.get('LawID')}`;
  }
  if (['www.court.gov.cn', 'court.gov.cn'].includes(host) && /^\/(?:zixun|fabu)\/xiangqing\/[1-9]\d{0,11}\.html$/.test(url.pathname) && !keys.length) return url.toString();
  if (host === 'htsfwb.samr.gov.cn' && url.pathname === '/View' && keys.length === 1 && keys[0] === 'id' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(url.searchParams.get('id') ?? '')) return `https://htsfwb.samr.gov.cn/View?id=${url.searchParams.get('id')!.toLowerCase()}`;
  throw new RetrievalError('failed', '仅支持行政法规库详情、最高法公开发布正文和合同示范文本库 View 页面。');
}

function entities(text: string): string {
  const named: Record<string, string> = { nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•', copy: '©', reg: '®' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (!code.startsWith('#')) return named[code.toLowerCase()] ?? whole;
    const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : ' ';
  });
}
function decodeHtml(page: HttpResult): string {
  if (page.body.length > 2 * 1024 * 1024 || !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(page.contentType)) throw new RetrievalError('failed', '官方来源未返回资源限额内的 HTML 正文；PDF和其他附件暂不自动读取。');
  const prefix = page.body.subarray(0, 4096).toString('latin1');
  let charset = /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(page.contentType)?.[1] ?? /<meta\b[^>]*charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(prefix)?.[1] ?? 'utf-8';
  if (/^(?:gbk|gb2312|gb_2312-80)$/i.test(charset)) charset = 'gb18030';
  try { const text = new TextDecoder(charset, { fatal: true }).decode(page.body); if (!text.includes('\uFFFD')) return text; } catch { /* Reject invalid encodings rather than quoting damaged text. */ }
  throw new RetrievalError('failed', '官方页面字符编码无法可靠识别。');
}
/** Bounded structural parser, with no script execution or resource loading. */
function tree(html: string): HtmlNode {
  const root: HtmlNode = { tag: 'root', attrs: {}, children: [] }; const stack = [root]; let count = 0;
  const safe = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(script|style|noscript|template|iframe)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  for (const match of safe.matchAll(/<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</g)) {
    if (++count > 100000 || stack.length > 160) throw new RetrievalError('failed', '官方页面结构超过解析上限。');
    const token = match[0];
    if (!token.startsWith('<')) { stack.at(-1)!.children.push(entities(token)); continue; }
    if (/^<\//.test(token)) { const tag = /^<\/\s*([\w:-]+)/.exec(token)?.[1].toLowerCase(); for (let index = stack.length - 1; index > 0; index--) if (stack[index].tag === tag) { stack.length = index; break; } continue; }
    const tag = /^<\s*([\w:-]+)/.exec(token)?.[1].toLowerCase(); if (!tag) continue;
    const node: HtmlNode = { tag, attrs: {}, children: [] };
    for (const attr of token.slice(token.indexOf(tag) + tag.length).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) node.attrs[attr[1].toLowerCase()] = entities(attr[2] ?? attr[3] ?? attr[4]);
    if (/\shidden(?:\s|=|>)/i.test(token)) node.attrs.hidden = '';
    stack.at(-1)!.children.push(node); if (!voids.has(tag) && !/\/\s*>$/.test(token)) stack.push(node);
  }
  return root;
}
function hasClass(node: HtmlNode, value: string): boolean { return (node.attrs.class ?? '').split(/\s+/).includes(value); }
function find(node: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) if (typeof child !== 'string') { const found = find(child, predicate); if (found) return found; }
  return undefined;
}
function all(node: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode[] {
  const output: HtmlNode[] = []; const visit = (item: HtmlNode) => { if (predicate(item)) output.push(item); for (const child of item.children) if (typeof child !== 'string') visit(child); }; visit(node); return output;
}
function text(node: HtmlNode): string {
  const read = (item: HtmlNode | string): string => {
    if (typeof item === 'string') return item;
    if (ignored.has(item.tag) || item.attrs.hidden !== undefined || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(item.attrs.style ?? '')) return '';
    const body = item.children.map(read).join(''); return blocks.has(item.tag) ? `\n${body}\n` : body;
  };
  return read(node).replace(/[\t\f\v \u00a0\u3000]+/g, ' ').split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n').trim();
}
function usefulTerms(values: string[]): string[] { return [...new Set(values.filter(value => typeof value === 'string').map(value => value.normalize('NFC').trim().toLowerCase()).filter(value => value.length >= 2 && value.length <= 100 && !broadTerms.has(value)))].slice(0, 64); }
function score(value: string, terms: string[]): number { const lower = value.toLowerCase(); return terms.reduce((sum, term) => sum + (lower.includes(term) ? Math.min(term.length, 8) : 0), 0); }
function date(year: string, month: string, day: string): string | null {
  const value = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.valueOf()) && parsed.toISOString().startsWith(value) ? value : null;
}
function firstDate(value: string): string | null { const found = /((?:19|20)\d{2})[-年](\d{1,2})[-月](\d{1,2})(?:日)?/.exec(value); return found ? date(found[1], found[2], found[3]) : null; }
function lawDates(body: string): { publishedAt: string | null; effectiveAt: string | null; ambiguous: boolean } {
  // Dates in later substantive clauses can refer to older laws or transaction facts.
  const firstArticle = /(?:^|\n)第[零〇一二三四五六七八九十百千万两\d]{1,20}条/.exec(body)?.index;
  const heading = body.slice(0, Math.min(firstArticle ?? 2500, 3000));
  const dates = (pattern: RegExp) => [...new Set([...heading.matchAll(pattern)].map(found => date(found[1], found[2], found[3])).filter((value): value is string => value !== null))];
  const published = dates(/((?:19|20)\d{2})年(\d{1,2})月(\d{1,2})日(?:(?!(?:19|20)\d{2}年)[^\n。]){0,45}?(?:公布|发布)/g);
  const effective = dates(/自\s*((?:19|20)\d{2})年(\d{1,2})月(\d{1,2})日\s*(?:起)?(?:施行|实施|生效)/g);
  const revised = dates(/((?:19|20)\d{2})年(\d{1,2})月(\d{1,2})日(?:(?!(?:19|20)\d{2}年)[^\n。]){0,45}?(?:修订|修正|修改)/g);
  const ambiguous = published.length > 1 || effective.length > 1 || revised.length > 0;
  return { publishedAt: ambiguous ? null : published[0] ?? null, effectiveAt: ambiguous ? null : effective[0] ?? null, ambiguous };
}
function shanghaiDay(timestamp: string): string | null {
  const parsed = new Date(timestamp); if (!Number.isFinite(parsed.valueOf())) return null;
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(parsed);
  const value = (type: string) => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function selectExcerpt(body: string, terms: string[]): { excerpt: string; locator: string; article?: string; contentScope: OfficialSource['contentScope']; warnings: string[] } {
  const max = OFFICIAL_SOURCE_LIMITS.excerptCharacters;
  if (body.length <= max) return { excerpt: body, locator: '已读取指定正文容器的全部可读文字', contentScope: 'full_text', warnings: [] };
  const starts = [...body.matchAll(/(?:^|\n)(第[零〇一二三四五六七八九十百千万两\d]{1,20}条(?:之[零〇一二三四五六七八九十\d]+)?)[ \n]/g)].map(match => ({ start: match.index! + (match[0].startsWith('\n') ? 1 : 0), article: match[1] }));
  const segments = starts.length ? [{ start: 0, article: undefined as string | undefined }, ...starts] : [...body.matchAll(/(?:^|\n)[^\n]+/g)].map(match => ({ start: match.index! + (match[0].startsWith('\n') ? 1 : 0), article: undefined as string | undefined }));
  const ranked = segments.map((segment, index) => ({ ...segment, end: segments[index + 1]?.start ?? body.length, score: score(body.slice(segment.start, segments[index + 1]?.start ?? body.length), terms) })).sort((a, b) => b.score - a.score || a.start - b.start);
  const best = ranked[0];
  if (!best || !best.score) throw new RetrievalError('failed', '官方长篇正文未定位到与本次受控主题词相关的段落，未截取页面开头冒充相关依据。');
  let start = best.start; let end = best.end;
  const warnings: string[] = [];
  if (end - start > max) {
    const lower = body.slice(start, end).toLowerCase(); const offsets = terms.map(term => lower.indexOf(term)).filter(index => index >= 0); const first = offsets.length ? Math.min(...offsets) : 0;
    // Keep the hit inside the reviewer's smallest (160-character) excerpt.
    // A short tail stays short: backfilling earlier text could push the hit out
    // of the model budget again, even though the saved window contains it.
    start = Math.max(best.start, best.start + first - 40); end = Math.min(best.end, start + max);
    warnings.push('相关条款超过片段预算，仅保存其连续原文窗口；条款上下文未全部提供。');
  }
  return { excerpt: body.slice(start, end).trim(), locator: `${best.article ?? '相关正文段落'}；提取正文字符 ${start + 1}–${end}`, article: best.article, contentScope: 'fragment', warnings };
}

export function parseOfficialPage(sourceUri: string, page: HttpResult, terms: string[], discovery: Discovery = { discoveredVia: 'user_url' }): OfficialSource {
  const canonical = validateOfficialSourceUrl(sourceUri); const url = new URL(canonical); const root = tree(decodeHtml(page));
  let container: HtmlNode | undefined; let title = ''; let kind: OfficialSource['kind'] = 'commentary'; let publisher = ''; let documentNumber: string | null = null; let versionLabel: string | null = null;
  let publishedAt: string | null = null; let effectiveAt: string | null = null; const warnings: string[] = [];
  if (url.hostname === 'xzfg.moj.gov.cn') {
    const chapters = all(root, node => hasClass(node, 'law-chapter'));
    container = chapters.length ? { tag: 'section', attrs: {}, children: chapters } : undefined;
    title = text(find(root, node => hasClass(node, 'text-title')) ?? { tag: 'root', attrs: {}, children: [] }); kind = 'statute';
    warnings.push('原文由司法部国家行政法规库托管；发布机关与托管网站分别记录。');
  } else if (url.hostname.endsWith('court.gov.cn')) {
    container = find(root, node => hasClass(node, 'txt_txt')); const detail = find(root, node => hasClass(node, 'detail'));
    title = text(detail && find(detail, node => hasClass(node, 'title')) || { tag: 'root', attrs: {}, children: [] }); publisher = '最高人民法院';
    const meta = find(root, node => hasClass(node, 'detail_mes')); const stamp = meta ? /发布时间[：:]\s*([^\n]+)/.exec(text(meta)) : null; publishedAt = stamp ? firstDate(stamp[1]) : null;
  } else {
    container = find(root, node => hasClass(node, 'samr-view-content')); publisher = '国家市场监督管理总局合同示范文本库'; kind = 'contract_template';
    title = text(find(root, node => node.tag === 'title') ?? { tag: 'root', attrs: {}, children: [] }).replace(/\s*-\s*合同示范文本库[\s\S]*$/, '');
    const info = find(root, node => hasClass(node, 'samr-view-info'));
    if (info) for (const child of info.children) if (typeof child !== 'string') {
      const label = text(find(child, node => hasClass(node, 'info-title')) ?? { tag: 'root', attrs: {}, children: [] }); const value = text(find(child, node => hasClass(node, 'info-content')) ?? { tag: 'root', attrs: {}, children: [] });
      if (/发布机关/.test(label) && value) publisher = value;
      if (/发布编号/.test(label) && value) documentNumber = value;
      if (/发布年份/.test(label) && value) versionLabel = `${value}发布版本`;
      if (/发布日期/.test(label)) publishedAt = firstDate(value);
    }
    if (find(root, node => hasClass(node, 'samr-view-risk'))) warnings.push('页面另有风险提示，未混入合同示范文本正文；请打开原始页面分别查看。');
    warnings.push('合同示范文本供参照起草，不等于本企业已批准模板，也不代表条款适用于本次交易。');
  }
  if (!container) throw new RetrievalError('failed', '未找到此站点已验证的正文容器；登录页、动态壳和页面改版不作为原文使用。');
  const body = text(container);
  if (body.length < 40 || /^(?:请.*(?:登录|启用JavaScript)|本页面需要.*JavaScript)/i.test(body)) throw new RetrievalError('failed', '官方页面正文不足或需要交互，未取得可用原文。');
  title = title.trim().slice(0, 300); if (!title) throw new RetrievalError('failed', '官方页面缺少可核验标题。');
  if (kind !== 'contract_template') {
    documentNumber = /(?:法释〔\d{4}〕\d+号|法〔\d{4}〕\d+号|(?:中华人民共和国)?国务院令第\s*\d+\s*号)/.exec(body.slice(0, 3000))?.[0] ?? null;
    if (url.hostname.endsWith('court.gov.cn')) kind = /征求意见|草案/.test(title) ? 'commentary' : /(?:典型|指导性|参考)案例|判决|裁定/.test(title) ? 'case' : /解释/.test(title) && /法释〔\d{4}〕\d+号/.test(body.slice(0, 3000)) && /(?:^|\n)第[零〇一二三四五六七八九十百千万两\d]+条/.test(body) ? 'judicial_interpretation' : 'commentary';
    const dates = kind === 'statute' || kind === 'judicial_interpretation' ? lawDates(body) : { publishedAt: null, effectiveAt: null, ambiguous: false };
    if (url.hostname === 'xzfg.moj.gov.cn') publisher = /国务院/.test(body.slice(0, 3000)) ? /中央军事委员会/.test(body.slice(0, 3000)) ? '国务院、中央军事委员会' : '国务院' : '发布机关待核验（司法部行政法规库托管）';
    if (dates.ambiguous) {
      publishedAt = null; effectiveAt = null; documentNumber = null; versionLabel = '存在历次公布、修订或施行日期，当前版本待核验';
      warnings.push('正文题注包含历次公布、修订或施行日期，未将首个日期或文号当作当前版本；公布日期、施行日期和文号暂记未知。');
    } else {
      publishedAt ??= dates.publishedAt; effectiveAt = dates.effectiveAt;
      versionLabel = /征求意见|草案/.test(title) ? '征求意见或草案文本，非现行正式依据' : documentNumber ?? (publishedAt ? `${publishedAt}发布页面` : null);
    }
  }
  const excerpt = selectExcerpt(body, usefulTerms(terms)); warnings.push(...excerpt.warnings);
  const relevantOffsets = usefulTerms(terms).map(term => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu').exec(excerpt.excerpt)?.index)
    .filter((offset): offset is number => offset !== undefined);
  const relevantTextOffset = relevantOffsets.length ? Math.min(...relevantOffsets) : undefined;
  const retrievedDay = shanghaiDay(page.fetchedAt);
  if (effectiveAt && retrievedDay && effectiveAt > retrievedDay) warnings.push(`页面标示施行日期 ${effectiveAt} 晚于取得日期（中国大陆日历日）；不得当作已施行依据。`);
  if (publishedAt && retrievedDay && publishedAt > retrievedDay) warnings.push('页面标示公布日期晚于取得日期，日期需要人工核验。');
  warnings.push(validityNote);
  return { kind, title, sourceUri: canonical, locator: excerpt.locator, excerpt: excerpt.excerpt, contentScope: excerpt.contentScope, retrievedAt: page.fetchedAt, publishedAt, effectiveAt,
    officialMetadata: { publisher, documentNumber, versionLabel, ...discovery, ...(excerpt.article ? { article: excerpt.article } : {}),
      ...(relevantTextOffset === undefined ? {} : { relevantTextOffset }), validityNote }, warnings };
}

function parseCatalog(page: HttpResult): { candidates: Array<{ url: string; title: string }>; totalPages: number | null } {
  const root = tree(decodeHtml(page)); const count = find(root, node => node.tag === 'input' && node.attrs.id === 'page-count')?.attrs.value;
  const totalPages = count !== undefined && /^\d{1,5}$/.test(count) ? Number(count) : null;
  const candidates: Array<{ url: string; title: string }> = []; const seen = new Set<string>();
  for (const node of all(root, node => node.tag === 'a' && Boolean(node.attrs.href))) {
    try {
      const url = validateOfficialSourceUrl(new URL(node.attrs.href, OFFICIAL_CATALOG_URL).toString());
      if (new URL(url).hostname !== 'xzfg.moj.gov.cn' || seen.has(url)) continue;
      const title = text(node).slice(0, 300); if (!title) continue;
      seen.add(url); candidates.push({ url, title });
    } catch { /* Foreign links, attachments and navigation cannot become candidates. */ }
  }
  if (!candidates.length && totalPages !== 0) throw new RetrievalError('failed', '公开目录未找到可识别条目，可能需要交互或已经改版，未宣称目录无结果。');
  return { candidates, totalPages };
}
function stopReason(signal: AbortSignal): RetrievalError { return signal.reason instanceof RetrievalError ? signal.reason : new RetrievalError('cancelled', '官方资料检索已取消。'); }
function check(signal: AbortSignal): void { if (signal.aborted) throw stopReason(signal); }
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); throw stopReason(signal); } let cancel!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => { cancel = () => reject(stopReason(signal)); signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([work, stopped]); } finally { signal.removeEventListener('abort', cancel); }
}

/** Verified 2026-10-23 public HTML route. It is a title catalog, not a search
 * API or complete collection of currently effective interpretations. */
export function parseCourtInterpretationCatalog(page: HttpResult, catalogUrl: string): { candidates: Array<{ url: string; title: string }>; totalPages: number | null } {
  const url = new URL(catalogUrl);
  const route = /^\/fabu\/gengduo\/16(?:_([1-9]\d{0,2}))?\.html$/u.exec(url.pathname);
  if (url.origin !== 'https://www.court.gov.cn' || url.search || url.hash || !route) throw new RetrievalError('failed', '不支持的最高法栏目地址。');
  const root = tree(decodeHtml(page)); const container = find(root, node => hasClass(node, 'sec_list'));
  if (!container || !/司法解释/.test(text(find(container, node => hasClass(node, 'tit')) ?? { tag: 'root', attrs: {}, children: [] }))) throw new RetrievalError('failed', '最高法栏目结构或栏目名称不符，未将登录页或其他页面当作目录。');
  const candidates: Array<{ url: string; title: string }> = []; const seen = new Set<string>();
  for (const anchor of all(container, node => node.tag === 'a')) {
    if (!anchor.attrs.href || !text(anchor)) continue;
    try {
      const candidateUrl = validateOfficialSourceUrl(new URL(anchor.attrs.href, catalogUrl).toString());
      if (!candidateUrl.startsWith('https://www.court.gov.cn/fabu/xiangqing/')) continue;
      const title = (anchor.attrs.title?.trim() || text(anchor)).slice(0, 300);
      if (title && !seen.has(candidateUrl)) { seen.add(candidateUrl); candidates.push({ url: candidateUrl, title }); }
    } catch { /* Navigation, foreign URLs, attachments and credentials are excluded. */ }
  }
  const pager = find(container, node => hasClass(node, 'yiiPager'));
  let totalPages: number | null = null;
  if (pager) {
    const last = find(pager, node => node.tag === 'li' && hasClass(node, 'last'));
    const href = last && find(last, node => node.tag === 'a')?.attrs.href;
    if (href) {
      const target = new URL(href, catalogUrl); const match = /^\/fabu\/gengduo\/16(?:_([1-9]\d{0,2}))?\.html$/u.exec(target.pathname);
      if (target.origin === url.origin && !target.search && !target.hash && match) totalPages = Number(match[1] ?? 1);
    }
    const next = find(pager, node => node.tag === 'li' && hasClass(node, 'next') && !hasClass(node, 'hidden'));
    if (!next && totalPages === null) totalPages = Number(route[1] ?? 1);
  }
  const count = find(container, node => hasClass(node, 'count'));
  const countText = count ? text(count).replace(/\s/gu, '') : '';
  const explicitlyEmpty = /^共0篇文章$/u.test(countText);
  if (!candidates.length && !explicitlyEmpty) throw new RetrievalError('failed', '最高法栏目未取得可识别文章条目，未宣称检索无结果。');
  if (explicitlyEmpty) totalPages = 0;
  return { candidates, totalPages };
}

export async function retrieveOfficialSources(input: OfficialRetrievalInput, signal: AbortSignal, reader: OfficialPageReader = http.page): Promise<OfficialRetrievalResult> {
  if (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > OFFICIAL_SOURCE_LIMITS.results || !Number.isInteger(input.maxCatalogPages) || input.maxCatalogPages < 1 || input.maxCatalogPages > OFFICIAL_SOURCE_LIMITS.catalogPages || !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 60 || !Array.isArray(input.sourceUrls) || input.sourceUrls.length > OFFICIAL_SOURCE_LIMITS.userUrls || !Array.isArray(input.terms)) throw new RetrievalError('failed', '官方资料检索范围参数无效。');
  if (input.courtCatalogs !== undefined && (!Array.isArray(input.courtCatalogs) || input.courtCatalogs.length > 1 || input.courtCatalogs.some(value => value !== 'interpretations') || new Set(input.courtCatalogs).size !== input.courtCatalogs.length)) throw new RetrievalError('failed', '最高法栏目选择无效。');
  const urls = [...new Set(input.sourceUrls.map(validateOfficialSourceUrl))]; const terms = usefulTerms(input.terms);
  const result: OfficialRetrievalResult = { status: 'empty', sources: [], coverage: { catalogPagesRequested: 0, catalogPagesRead: 0, catalogCandidates: 0, matchedCandidates: 0, userUrlsRequested: urls.length, userUrlsRead: 0, failedReads: 0, catalogExhausted: false, truncated: false, totalPages: null, pagesLimit: input.maxCatalogPages }, warnings: ['自动发现仅检查预算内的行政法规库公开目录标题，不代表对法规全文或全部法律资料完成检索。'] };
  const controller = new AbortController(); const cancel = () => controller.abort(new RetrievalError('cancelled', '官方资料检索已取消。'));
  signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  const budget = Math.min(input.timeoutSeconds * 2, 120); const timer = setTimeout(() => controller.abort(new RetrievalError('timeout', '官方资料检索达到总时间预算，保留已读取资料。')), budget * 1000);
  const seen = new Set<string>();
  if (input.courtCatalogs?.length) {
    result.coverage.courtCatalogs = input.courtCatalogs.map(catalog => { const option = courtCatalogOptions.find(value => value.key === catalog)!; return { catalog, label: option.label, entryUrl: option.url, pagesRequested: 0, pagesRead: 0, totalPages: null, candidates: 0, matchedCandidates: 0, documentsRead: 0, failedReads: 0, exhausted: false, truncated: false }; });
    result.warnings[0] = '自动发现仅在预算内的行政法规库和已选择最高法栏目的公开目录标题中匹配，不代表对法规全文、现行有效司法解释或全部案例完成检索。';
  }
  const read = async (url: string, discovery: Discovery): Promise<void> => {
    check(controller.signal); if (seen.has(url)) return; seen.add(url);
    try {
      const page = await abortable(reader(url, controller.signal, input.timeoutSeconds), controller.signal); check(controller.signal);
      const source = parseOfficialPage(url, page, terms, discovery); check(controller.signal); result.sources.push(source);
      if (discovery.discoveredVia === 'user_url') result.coverage.userUrlsRead++;
    } catch (error) {
      if (controller.signal.aborted) throw stopReason(controller.signal);
      result.coverage.failedReads++; result.warnings.push(error instanceof RetrievalError ? error.message : '部分官方正文读取失败，未回显远端错误或敏感信息。');
    }
  };
  try {
    for (const url of urls) {
      if (result.sources.length >= input.maxResults) { result.coverage.truncated = true; break; }
      await read(url, { discoveredVia: 'user_url' });
    }
    const candidates = new Map<string, { title: string; score: number; catalogUrl: string }>();
    for (let index = 1; index <= input.maxCatalogPages; index++) {
      check(controller.signal); const catalogUrl = index === 1 ? OFFICIAL_CATALOG_URL : `${OFFICIAL_CATALOG_URL}?PageIndex=${index}`;
      result.coverage.catalogPagesRequested++;
      try {
        const page = await abortable(reader(catalogUrl, controller.signal, input.timeoutSeconds), controller.signal); check(controller.signal);
        const catalog = parseCatalog(page); result.coverage.catalogPagesRead++;
        if (catalog.totalPages !== null) result.coverage.totalPages = catalog.totalPages;
        for (const candidate of catalog.candidates) if (!candidates.has(candidate.url)) candidates.set(candidate.url, { title: candidate.title, score: score(candidate.title, terms), catalogUrl });
        result.coverage.catalogCandidates = candidates.size;
        result.coverage.matchedCandidates = [...candidates.values()].filter(candidate => candidate.score > 0).length;
        if (catalog.totalPages !== null && index >= catalog.totalPages) { result.coverage.catalogExhausted = true; break; }
      } catch (error) {
        if (controller.signal.aborted) throw stopReason(controller.signal);
        result.coverage.failedReads++; result.warnings.push(error instanceof RetrievalError ? error.message : '官方公开目录读取失败，未回显远端错误。'); break;
      }
    }
    for (const coverage of result.coverage.courtCatalogs ?? []) {
      const courtCandidates = new Set<string>();
      for (let index = 1; index <= input.maxCatalogPages; index++) {
        check(controller.signal); const catalogUrl = index === 1 ? coverage.entryUrl : `https://www.court.gov.cn/fabu/gengduo/16_${index}.html`;
        coverage.pagesRequested++;
        try {
          const page = await abortable(reader(catalogUrl, controller.signal, input.timeoutSeconds), controller.signal); check(controller.signal);
          const catalog = parseCourtInterpretationCatalog(page, catalogUrl); coverage.pagesRead++;
          if (catalog.totalPages !== null) coverage.totalPages = catalog.totalPages;
          for (const candidate of catalog.candidates) { courtCandidates.add(candidate.url); if (!candidates.has(candidate.url)) candidates.set(candidate.url, { title: candidate.title, score: score(candidate.title, terms), catalogUrl }); }
          coverage.candidates = courtCandidates.size;
          coverage.matchedCandidates = [...courtCandidates].filter(candidate => candidates.get(candidate)!.score > 0).length;
          if (coverage.totalPages !== null && index >= coverage.totalPages) { coverage.exhausted = true; break; }
        } catch (error) {
          if (controller.signal.aborted) throw stopReason(controller.signal);
          coverage.failedReads++; result.coverage.failedReads++; result.warnings.push(error instanceof RetrievalError ? error.message : '最高法公开栏目读取失败，未回显远端响应。'); break;
        }
      }
      coverage.truncated = !coverage.exhausted;
      if (coverage.truncated) result.warnings.push(`${coverage.label}仅读取 ${coverage.pagesRead} 页${coverage.totalPages === null ? '（总页数未知）' : ` / 共 ${coverage.totalPages} 页`}；标题未命中不能证明没有相关司法解释。`);
    }
    const matches = [...candidates].filter(([, candidate]) => candidate.score > 0).sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
    for (const [url, candidate] of matches) {
      const courtCoverage = result.coverage.courtCatalogs?.find(value => candidate.catalogUrl.startsWith('https://www.court.gov.cn/fabu/gengduo/16'));
      if (result.sources.length >= input.maxResults) { if (!seen.has(url)) { result.coverage.truncated = true; if (courtCoverage) courtCoverage.truncated = true; } continue; }
      if (seen.size >= OFFICIAL_SOURCE_LIMITS.documentReads) { result.coverage.truncated = true; for (const coverage of result.coverage.courtCatalogs ?? []) if (matches.some(([pendingUrl, pending]) => !seen.has(pendingUrl) && pending.catalogUrl.startsWith('https://www.court.gov.cn/fabu/gengduo/16'))) coverage.truncated = true; result.warnings.push('达到官方原文读取次数上限，剩余候选尚未读取。'); break; }
      const before = result.sources.length; const failures = result.coverage.failedReads;
      await read(url, { discoveredVia: 'catalog', catalogUrl: candidate.catalogUrl });
      if (courtCoverage) { courtCoverage.documentsRead += result.sources.length - before; courtCoverage.failedReads += result.coverage.failedReads - failures; }
    }
    result.coverage.truncated ||= !result.coverage.catalogExhausted || Boolean(result.coverage.courtCatalogs?.some(value => value.truncated));
    if (!terms.length) result.warnings.push('本次没有可用于目录标题筛选的具体法律主题词；通用“合同/服务/采购”未用于扩大候选。');
    if (result.coverage.truncated) result.warnings.push(`官方目录或结果达到配置预算；行政法规目录只读 ${result.coverage.catalogPagesRead} 页${result.coverage.totalPages === null ? '（总页数未知）' : ` / 共 ${result.coverage.totalPages} 页`}，其他栏目范围另列，未覆盖部分仍需补查。`);
    result.status = result.coverage.failedReads || result.coverage.truncated ? result.sources.length || result.coverage.catalogPagesRead ? 'partial' : 'failed' : result.sources.length ? 'complete' : 'empty';
  } catch (error) {
    const reason = controller.signal.aborted ? stopReason(controller.signal) : error;
    result.status = reason instanceof RetrievalError && ['cancelled', 'timeout'].includes(reason.code) ? reason.code as 'cancelled' | 'timeout' : 'failed';
    result.coverage.truncated = true; result.warnings.push(reason instanceof RetrievalError ? reason.message : '官方资料检索失败，保留已读取资料。');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  result.warnings = [...new Set(result.warnings)].slice(0, 30); return result;
}
