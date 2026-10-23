import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, opendir, open, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { ContractDetail, PublicRetrievalConfig, RetrievalAttempt, RetrievalBundle, RetrievalConfigInput, RetrievalStatus, ReviewContext, SourceEvidence } from '../shared/contracts';
import { parseContract } from './documents';
import { createRetrievalHttp, parseNetworkUrl, RetrievalError, type HttpResult } from './retrieval-http';
import type { KnowledgeSearchInput, KnowledgeSearchResult } from '../shared/knowledge';
import { defaultKnowledgePreferences, normalizeKnowledgePreferences } from '../shared/knowledge-preferences';
import { parseOfficialPage, retrieveOfficialSources, validateOfficialSourceUrl, type OfficialPageReader } from './official-sources';

export const RETRIEVAL_PROTOCOL_SOURCES = [
  'https://docs.dify.ai/en/api-reference/knowledge-bases/retrieve-chunks-from-a-knowledge-base-test-retrieval',
  'https://docs.searxng.org/dev/search_api.html',
] as const;
export const FOLDER_LIMITS = Object.freeze({ files: 80, entries: 1000, depth: 5, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, textCharacters: 500000 });
const officialDomains = ['gov.cn', 'npc.gov.cn', 'court.gov.cn'];
const http = createRetrievalHttp();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown, max = 4000) => typeof value === 'string' ? value.slice(0, max) : '';

function endpoint(value: string, required: boolean): string {
  if (!value.trim() && !required) return '';
  const url = parseNetworkUrl(value.trim());
  if (url.search || url.hash || value.includes('#')) throw new RetrievalError('failed', '检索配置地址不能包含查询参数或片段。');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new RetrievalError('failed', '检索配置 HTTP 地址仅允许本机回环服务；其他地址请使用 HTTPS。');
  return url.toString();
}

export function validateRetrievalConfig(input: RetrievalConfigInput): PublicRetrievalConfig {
  if (!input || !input.knowledge || !input.knowledge.api || !input.web) throw new RetrievalError('failed', '检索配置结构不完整。');
  for (const value of [input.knowledge.enabled, input.knowledge.api.enabled, input.web.enabled, input.web.fetchPages]) if (typeof value !== 'boolean') throw new RetrievalError('failed', '检索开关设置无效。');
  if (!['dify', 'standard'].includes(input.knowledge.api.provider) || !['brave', 'searxng'].includes(input.web.provider)) throw new RetrievalError('failed', '检索服务类型无效。');
  if (input.web.provider === 'brave' && input.web.enabled) throw new RetrievalError('failed', 'Brave Search 已暂缓，请选择 SearXNG。');
  if (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 8 || !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 5 || input.timeoutSeconds > 60) throw new RetrievalError('failed', '检索结果上限应为 1 到 8，超时应为 5 到 60 秒。');
  const folderPath = input.knowledge.folderPath;
  if (folderPath !== null && (typeof folderPath !== 'string' || !isAbsolute(folderPath) || folderPath.length > 4096 || folderPath.includes('\0'))) throw new RetrievalError('failed', '请选择有效的本地资料文件夹。');
  const api = input.knowledge.api;
  const apiRequired = input.knowledge.enabled && api.enabled;
  if (typeof api.baseUrl !== 'string' || typeof api.collectionId !== 'string' || api.baseUrl.length > 2048 || api.collectionId.length > 200) throw new RetrievalError('failed', '知识库 API 地址或集合标识无效。');
  if (apiRequired && (!api.baseUrl.trim() || !api.collectionId.trim() || (api.provider === 'dify' && !/^[a-zA-Z0-9_-]+$/.test(api.collectionId.trim())))) throw new RetrievalError('failed', '请填写知识库 API 地址及明确的集合/数据集标识，不允许跨全部知识库检索。');
  if (typeof input.web.baseUrl !== 'string' || input.web.baseUrl.length > 2048 || !Array.isArray(input.web.allowedDomains) || input.web.allowedDomains.length > 12) throw new RetrievalError('failed', '网页检索地址或域名设置无效。');
  const domains = input.web.allowedDomains.map(value => {
    if (typeof value !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value.trim()) || value.length > 253) throw new RetrievalError('failed', '允许域名只能填写域名，不可包含协议、路径、端口或通配符。');
    return value.trim().toLowerCase();
  });
  const official = input.official ?? { enabled: false, maxCatalogPages: 3, sourceUrls: [] };
  if (typeof official.enabled !== 'boolean' || !Number.isInteger(official.maxCatalogPages) || official.maxCatalogPages < 1 || official.maxCatalogPages > 10 || !Array.isArray(official.sourceUrls) || official.sourceUrls.length > 8) throw new RetrievalError('failed', '官方目录页数应为 1–10，补充原文链接最多 8 条。');
  const sourceUrls = [...new Set(official.sourceUrls.map(value => {
    if (typeof value !== 'string' || value.length > 2048) throw new RetrievalError('failed', '官方原文链接无效。');
    return validateOfficialSourceUrl(value.trim());
  }))];
  if (official.courtCatalogs !== undefined && (!Array.isArray(official.courtCatalogs) || official.courtCatalogs.length > 1 || official.courtCatalogs.some(value => value !== 'interpretations') || new Set(official.courtCatalogs).size !== official.courtCatalogs.length)) throw new RetrievalError('failed', '最高法栏目选择无效，仅支持已验证的司法解释公开栏目。');
  return {
    knowledge: { enabled: input.knowledge.enabled, folderPath, preferences: input.knowledge.preferences === undefined ? defaultKnowledgePreferences() : normalizeKnowledgePreferences(input.knowledge.preferences), api: { enabled: api.enabled, provider: api.provider,
      baseUrl: endpoint(api.baseUrl, apiRequired), collectionId: api.collectionId.trim(), hasApiKey: Boolean(api.apiKey?.trim()), keyStorage: 'session-only' } },
    web: { enabled: input.web.enabled, provider: input.web.provider, baseUrl: endpoint(input.web.baseUrl, input.web.enabled),
      allowedDomains: [...new Set(domains.length ? domains : officialDomains)], fetchPages: input.web.fetchPages,
      hasApiKey: Boolean(input.web.apiKey?.trim()), keyStorage: 'session-only' },
    official: { enabled: official.enabled, maxCatalogPages: official.maxCatalogPages, sourceUrls, ...(official.courtCatalogs === undefined ? {} : { courtCatalogs: [...official.courtCatalogs] }) },
    maxResults: input.maxResults, timeoutSeconds: input.timeoutSeconds,
  };
}

const topics = [
  { name: '付款价款', terms: ['付款','价款','支付','payment','price','fee','ชำระเงิน','ราคา','ค่าบริการ'] },
  { name: '交付验收', terms: ['交付','验收','delivery','acceptance','ส่งมอบ','ตรวจรับ'] },
  { name: '违约责任', terms: ['违约','赔偿','责任','breach','liability','damages','ผิดสัญญา','ความรับผิด','ค่าเสียหาย'] },
  { name: '解除终止', terms: ['解除','终止','terminate','termination','เลิกสัญญา','สิ้นสุด'] },
  { name: '争议管辖', terms: ['争议','仲裁','管辖','dispute','arbitration','jurisdiction','ข้อพิพาท','อนุญาโตตุลาการ'] },
  { name: '保密义务', terms: ['保密','confidential','non-disclosure','ความลับ'] },
  { name: '知识产权', terms: ['知识产权','著作权','intellectual property','copyright','ทรัพย์สินทางปัญญา'] },
  { name: '个人信息', terms: ['个人信息','个人数据','personal data','personal information','ข้อมูลส่วนบุคคล'] },
] as const;

/** Only fixed vocabulary can reach a search provider. No names, amounts, businessContext or contract quotations. */
export function retrievalTopics(document: ContractDetail, context: ReviewContext): { query: string; terms: string[]; officialTerms: string[]; webQueries: Array<{ kind: 'statute' | 'case'; query: string }> } {
  const text = document.blocks.map(block => block.text).join('\n').toLowerCase();
  const matched = topics.filter(topic => topic.terms.some(term => text.includes(term)));
  const selected = matched.slice(0, 3);
  const contract = context.contractType === 'procurement' ? '采购合同' : context.contractType === 'service' ? '服务合同' : '合同';
  const query = `${contract} ${selected.map(topic => topic.name).join(' ')}`.trim();
  const officialVocabulary: Record<string, string[]> = { 付款价款: ['支付','付款','款项'], 交付验收: ['质量','服务','采购'], 违约责任: ['合同','责任'], 解除终止: ['合同','解除'], 争议管辖: ['仲裁','争议'], 保密义务: ['保密','秘密'], 知识产权: ['知识产权','著作权','专利'], 个人信息: ['个人信息','数据','网络'] };
  return { query, terms: ['合同','contract','สัญญา', ...selected.flatMap(topic => [...topic.terms])],
    officialTerms: [...new Set(matched.flatMap(topic => officialVocabulary[topic.name] ?? [topic.name]))],
    webQueries: [{ kind: 'statute', query: `${query} 民法典 法律法规` }, { kind: 'case', query: `${query} 典型案例 裁判` }] };
}

function safeSourceUri(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try { return parseNetworkUrl(value).toString(); } catch { return null; }
}
function matchesDomain(url: string, domains: string[]): boolean {
  try { const host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); return domains.some(domain => host === domain || host.endsWith(`.${domain}`)); } catch { return false; }
}
function evidence(attempt: RetrievalAttempt, value: Omit<SourceEvidence, 'id' | 'attemptId' | 'channel' | 'excerptSha256' | 'currentness' | 'publishedAt' | 'effectiveAt'>): SourceEvidence {
  return { id: randomUUID(), attemptId: attempt.id, channel: attempt.channel, ...value, excerptSha256: sha(value.excerpt), publishedAt: null, effectiveAt: null, currentness: 'unknown' };
}
function kindHint(title: string, hint?: unknown): SourceEvidence['kind'] {
  if (typeof hint === 'string' && ['company_policy','statute','judicial_interpretation','case','commentary'].includes(hint)) return hint as SourceEvidence['kind'];
  if (/司法解释|关于适用.{0,60}解释/.test(title)) return 'judicial_interpretation';
  if (/典型案例|指导案例|判决|裁定|裁判|案件|\bcase\b|\bjudgment\b|คำพิพากษา/i.test(title)) return 'case';
  if (/中华人民共和国.{0,30}(?:法|条例)|民法典|法律法规|条例|管理办法/.test(title)) return 'statute';
  if (/内部制度|公司制度|管理制度|采购制度|公司政策|\bpolicy\b/i.test(title)) return 'company_policy';
  return 'commentary';
}
function apiPath(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl); const path = url.pathname.replace(/\/+$/, '');
  url.pathname = `${path.endsWith('/v1') ? path : `${path}/v1`}/${suffix}`; return url.toString();
}
function checkCancelled(signal: AbortSignal): void { if (signal.aborted) throw new RetrievalError('cancelled', '检索已取消。'); }
function inside(root: string, file: string): boolean { const delta = relative(root, file); return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta)); }

async function readCustomerFile(root: string, path: string, signal: AbortSignal, remainingBytes: number): Promise<Buffer> {
  checkCancelled(signal);
  const prior = await lstat(path);
  if (!prior.isFile() || prior.isSymbolicLink() || !inside(root, await realpath(path))) throw new RetrievalError('failed', '文件不是资料目录内的普通文件。');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat(); const resolved = await realpath(path); const live = await lstat(path);
    if (!inside(root, resolved) || live.isSymbolicLink() || !current.isFile() || current.dev !== live.dev || current.ino !== live.ino || current.dev !== prior.dev || current.ino !== prior.ino) throw new RetrievalError('failed', '文件在读取前发生变化或越出资料目录，已跳过。');
    const limit = Math.min(FOLDER_LIMITS.fileBytes, remainingBytes);
    if (current.size > limit) throw new RetrievalError('failed', '资料文件超过单文件或剩余读取上限。');
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      checkCancelled(signal); const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += bytes.length;
      if (length > limit) throw new RetrievalError('failed', '资料文件超过单文件或剩余读取上限。');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, length);
  } finally { await handle.close(); }
}

async function folderSearch(folder: string, queryTerms: string[], maxResults: number, seconds: number, attempt: RetrievalAttempt, output: SourceEvidence[], signal: AbortSignal): Promise<void> {
  const started = performance.now(); const info = await lstat(folder);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new RetrievalError('failed', '资料文件夹必须是普通目录，不能使用符号链接。');
  const root = await realpath(folder); const queue = [{ path: root, depth: 0 }];
  const candidates: Array<{ score: number; source: SourceEvidence }> = [];
  let entries = 0; let files = 0; let totalBytes = 0; let characters = 0; let scratch: string | null = null;
  const check = () => { checkCancelled(signal); if (performance.now() - started > seconds * 1000) throw new RetrievalError('timeout', '本地资料扫描超时，保留已取得的结果。'); };
  try {
    scan: while (queue.length) {
      check(); const directory = queue.shift()!;
      const dirInfo = await lstat(directory.path);
      if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory() || !inside(root, await realpath(directory.path))) { attempt.warnings.push('跳过变更、链接或越界目录。'); continue; }
      let reader;
      try { reader = await opendir(directory.path); } catch { attempt.warnings.push('部分子目录无法读取。'); continue; }
      for await (const item of reader) {
        const name = item.name;
        check(); entries++;
        if (entries > FOLDER_LIMITS.entries) { attempt.warnings.push('资料目录项超过扫描上限，部分内容未检索。'); break scan; }
        const path = join(directory.path, name); let entry;
        try { entry = await lstat(path); } catch { attempt.warnings.push('部分目录项读取失败。'); continue; }
        if (entry.isSymbolicLink()) { attempt.warnings.push('跳过符号链接，未读取链接目标。'); continue; }
        if (entry.isDirectory()) { if (directory.depth < FOLDER_LIMITS.depth) queue.push({ path, depth: directory.depth + 1 }); else attempt.warnings.push('部分子目录超过扫描深度，未检索。'); continue; }
        const extension = extname(name).toLowerCase(); if (!entry.isFile() || !['.txt','.md','.docx','.pdf'].includes(extension)) continue;
        if (++files > FOLDER_LIMITS.files || totalBytes + entry.size > FOLDER_LIMITS.totalBytes) { attempt.warnings.push('资料扫描达到文件数量或总字节上限，部分内容未检索。'); break scan; }
        try {
          const bytes = await readCustomerFile(root, path, signal, FOLDER_LIMITS.totalBytes - totalBytes); totalBytes += bytes.length;
          let blocks: Array<{ text: string; locator: string }>;
          if (extension === '.txt' || extension === '.md') {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            blocks = text.split(/\r?\n/).map((line, index) => ({ text: line, locator: `第 ${index + 1} 行` }));
          } else {
            scratch ??= await mkdtemp(join(tmpdir(), 'law-agent-retrieval-'));
            const temporary = join(scratch, `${randomUUID()}${extension}`); await writeFile(temporary, bytes, { mode: 0o600 });
            const parsed = await parseContract(temporary); await rm(temporary, { force: true });
            if (parsed.partial) attempt.warnings.push(`资料 ${name} 解析不完整；未解析内容未检索。`);
            blocks = parsed.blocks.map(block => ({ text: block.text, locator: block.locator.kind === 'pdf' ? `第 ${block.locator.pageIndex + 1} 页；块 ${block.ordinal + 1}` : `${block.locator.partName} ${block.locator.structuralPath}` }));
          }
          check(); let best: { score: number; text: string; locator: string } | null = null;
          for (const block of blocks) {
            characters += block.text.length;
            if (characters > FOLDER_LIMITS.textCharacters) { attempt.warnings.push('资料文本量达到扫描上限，部分内容未检索。'); break scan; }
            const lower = block.text.toLowerCase(); const hits = queryTerms.filter(term => lower.includes(term));
            if (hits.length && (!best || hits.length > best.score)) {
              const first = lower.indexOf(hits[0]); const start = Math.max(0, first - 200);
              best = { score: hits.length, text: block.text.slice(start, start + 3000), locator: `${block.locator}；字符 ${start} 起` };
            }
          }
          if (best) candidates.push({ score: best.score, source: evidence(attempt, { kind: kindHint(name), title: name, sourceUri: pathToFileURL(path).toString(), locator: best.locator, excerpt: best.text, contentScope: 'fragment', retrievedAt: new Date().toISOString(), isOfficial: false, warnings: ['客户现有文件的匹配片段；资料类别为标题线索，完整性及法律效力未核验。'] }) });
        } catch (error) { if (error instanceof RetrievalError && ['cancelled','timeout'].includes(error.code)) throw error; attempt.warnings.push(`资料 ${name} 无法安全读取或解析，已跳过。`); }
      }
    }
  } finally {
    output.push(...candidates.sort((a,b) => b.score - a.score).slice(0,maxResults).map(value => value.source));
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
  if (files > maxResults) attempt.warnings.push(`只返回至多 ${maxResults} 个最相关文件片段；这是即时只读扫描，未创建知识库或持久索引。`);
}

async function knowledgeApi(config: PublicRetrievalConfig, query: string, apiKey: string | null, attempt: RetrievalAttempt, output: SourceEvidence[], signal: AbortSignal): Promise<void> {
  const api = config.knowledge.api; const headers: Record<string,string> = { 'Content-Type': 'application/json' }; if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (api.provider === 'dify') {
    if (!apiKey) throw new RetrievalError('failed', 'Dify 知识库 API 未配置密钥，未发起请求。');
    const result = await http.json(apiPath(api.baseUrl, `datasets/${encodeURIComponent(api.collectionId)}/retrieve`), { method: 'POST', headers,
      body: { query, retrieval_model: { top_k: config.maxResults } }, signal, timeoutSeconds: config.timeoutSeconds });
    const values = record(result.data).records; if (!Array.isArray(values)) throw new RetrievalError('failed', 'Dify 响应缺少 records 列表。');
    for (const item of values.slice(0, config.maxResults)) {
      const segment = record(record(item).segment); const doc = record(segment.document); const content = string(segment.content, 4000);
      if (!content || !string(segment.id) || !string(doc.id ?? segment.document_id)) { attempt.warnings.push('Dify 返回片段缺少内容或稳定定位，未作为证据使用。'); continue; }
      const documentId = string(doc.id ?? segment.document_id); const url = apiPath(api.baseUrl, `datasets/${encodeURIComponent(api.collectionId)}/documents/${encodeURIComponent(documentId)}`);
      output.push(evidence(attempt, { kind: kindHint(string(doc.name)), title: string(doc.name) || 'Dify 知识库片段', sourceUri: url,
        locator: `dataset=${api.collectionId}; document=${documentId}; segment=${string(segment.id)}; position=${typeof segment.position === 'number' ? segment.position : '未知'}`,
        excerpt: content, contentScope: 'fragment', retrievedAt: result.fetchedAt, isOfficial: false, warnings: ['Dify 返回的检索原文片段；资料类别为标题线索，未取得全文，未核验法律效力。'] }));
    }
    return;
  }
  const result = await http.json(apiPath(api.baseUrl, 'search'), { method: 'POST', headers, body: { query, queryLanguage: 'zh', collectionIds: [api.collectionId],
    filters: { languages: ['zh','en','th'], sourceKinds: [], contractTypes: [], partyRoles: [], relevantDate: null }, limit: config.maxResults }, signal, timeoutSeconds: config.timeoutSeconds });
  const data = record(result.data); if (!Array.isArray(data.candidates) || !['complete','empty'].includes(String(data.status))) throw new RetrievalError('failed', '标准知识库响应不符合 candidates/status 协议。');
  if (Array.isArray(data.warnings)) attempt.warnings.push(...data.warnings.filter((value): value is string => typeof value === 'string').map(value => value.slice(0,500)));
  for (const raw of data.candidates.slice(0, config.maxResults)) {
    checkCancelled(signal); const candidate = record(raw); const externalSourceId = string(candidate.externalSourceId,200); const snippet = string(candidate.snippet);
    if (!externalSourceId || !snippet) { attempt.warnings.push('标准知识库候选缺少来源标识或片段，已跳过。'); continue; }
    const source = evidence(attempt, { kind: kindHint(string(candidate.title),candidate.kindHint), title: string(candidate.title) || '客户知识库资料', sourceUri: safeSourceUri(candidate.sourceUri), locator: JSON.stringify(record(candidate.locator)),
      excerpt: snippet, contentScope: 'search_snippet', retrievedAt: result.fetchedAt, isOfficial: false, warnings: ['仅取得检索摘要，尚未回读来源。'] });
    output.push(source);
    try {
      const read = await http.json(apiPath(api.baseUrl, 'sources/read'), { method: 'POST', headers,
        body: { externalSourceId, fragmentId: candidate.fragmentId ?? null, expectedVersion: candidate.sourceVersion ?? null, collectionIds: [api.collectionId] }, signal, timeoutSeconds: config.timeoutSeconds });
      const value = record(read.data); const text = string(value.content);
      if (value.externalSourceId !== externalSourceId || !['full_text','fragment'].includes(String(value.contentScope)) || !text) throw new RetrievalError('failed', '来源回读的标识或内容范围不匹配。');
      source.excerpt = text; source.excerptSha256 = sha(text); source.contentScope = value.contentScope === 'full_text' && typeof value.content === 'string' && value.content.length <= 4000 ? 'full_text' : 'fragment';
      source.retrievedAt = read.fetchedAt; source.sourceUri = safeSourceUri(value.sourceUri) ?? source.sourceUri;
      source.locator = JSON.stringify(record(value.locator)); source.warnings = ['来源已回读，资料类别为元数据/标题线索，材料时间、法律效力及结论支持程度仍待核验。'];
    } catch (error) {
      source.warnings = ['原文回读失败，保留检索摘要；不能作为已核验原文。']; attempt.warnings.push('部分候选原文无法回读。');
      if (signal.aborted) throw new RetrievalError('cancelled', '检索已取消，保留已返回候选。');
      if (error instanceof RetrievalError && error.code === 'timeout') attempt.warnings.push('部分原文回读超时。');
    }
  }
}

export function extractPageText(result: HttpResult): string {
  if (!/text\/(?:html|plain)|application\/xhtml\+xml/i.test(result.contentType)) throw new RetrievalError('failed', '来源不是受支持的 HTML/文本；保留搜索摘要。');
  const meta = result.body.subarray(0,8192).toString('latin1');
  let charset = /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(result.contentType)?.[1]
    ?? /<meta\b[^>]*charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(meta)?.[1] ?? 'utf-8';
  if (/^(?:gb2312|gbk|gb_2312-80)$/i.test(charset)) charset = 'gb18030';
  let text: string; try { text = new TextDecoder(charset, { fatal: true }).decode(result.body); } catch { throw new RetrievalError('failed', '来源字符编码无法可靠识别，未将乱码作为原文。'); }
  if (text.includes('\uFFFD')) throw new RetrievalError('failed', '来源包含无法可靠解码的字符，保留搜索摘要。');
  if (/html/i.test(result.contentType)) text = text.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|template|iframe|nav)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,' ').replace(/<[^>]*>/g,' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code: string) => { const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1),16) : parseInt(code,10); return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ' '; })
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, entity => ({ '&nbsp;':' ', '&amp;':'&', '&lt;':'<', '&gt;':'>', '&quot;':'"', '&apos;':"'" }[entity.toLowerCase()] ?? ' '));
  return text.replace(/\s+/gu,' ').trim();
}

/** Isolated page reader seam for transport tests; production callers use the guarded HTTPS reader. */
export async function hydrateWebEvidence(source: SourceEvidence, signal: AbortSignal, seconds: number,
  reader: (url: string, signal: AbortSignal, seconds: number) => Promise<HttpResult> = http.page, terms: string[] = []): Promise<boolean> {
  let officialUrl: string | null = null;
  try {
    if (!source.sourceUri) throw new RetrievalError('failed', '来源地址不可用。');
    try { officialUrl = validateOfficialSourceUrl(source.sourceUri); } catch { /* Other allowed public sources retain the generic reader. */ }
    const page = await reader(officialUrl ?? source.sourceUri, signal, seconds);
    if (officialUrl) {
      const official = parseOfficialPage(officialUrl, page, terms, { discoveredVia: 'search' });
      Object.assign(source, official, { excerptSha256: sha(official.excerpt), isOfficial: true });
      source.warnings.push('通过已配置搜索服务发现此地址，已使用站点正文容器回读；搜索排序不构成法律效力排序。');
      return true;
    }
    const text = extractPageText(page);
    if (!text) throw new RetrievalError('failed', '原始页面未提取到可读正文。');
    source.excerpt = text.slice(0,5000); source.excerptSha256 = sha(source.excerpt); source.contentScope = text.length <= 5000 ? 'full_text' : 'fragment';
    source.retrievedAt = page.fetchedAt; source.locator = text.length <= 5000 ? '原始页面可读文本' : '原始页面可读文本前 5000 字符';
    source.warnings = ['原始页面已读取；页面正文提取可能包含导航信息，资料时效、法律效力及结论支持程度未核验。'];
    return true;
  } catch {
    source.warnings.push(officialUrl ? '支持的官方原文未通过站点正文解析或读取失败；保留搜索摘要，没有退回整页导航文字冒充原文。' : '原始页面读取失败或被安全策略阻止，仍为搜索摘要。');
    if (signal.aborted) throw new RetrievalError('cancelled', '检索已取消，保留已返回结果。');
    return false;
  }
}

function containsSecret(text: string, secrets: string[]): boolean {
  let decoded = text; try { decoded = decodeURIComponent(text); } catch { /* invalid escaping is checked by the URL reader */ }
  return secrets.some(secret => text.includes(secret) || decoded.includes(secret));
}

async function webSearch(config: PublicRetrievalConfig, planned: { kind: 'statute' | 'case'; query: string }, apiKey: string | null, attempt: RetrievalAttempt, output: SourceEvidence[], signal: AbortSignal, secrets: string[], terms: string[]): Promise<void> {
  const web = config.web; if (web.provider !== 'searxng') throw new RetrievalError('failed', 'Brave Search 已暂缓，请选择 SearXNG。');
  const url = new URL(web.baseUrl); const path = url.pathname.replace(/\/+$/,'');
  if (!path.endsWith('/search')) url.pathname = `${path}/search`;
  const query = `${planned.query} (${web.allowedDomains.map(domain => `site:${domain}`).join(' OR ')})`;
  attempt.query = query; url.searchParams.set('q', query);
  const headers: Record<string,string> = {};
  url.searchParams.set('format','json'); url.searchParams.set('categories','general'); url.searchParams.set('language','zh-CN');
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const result = await http.json(url.toString(), { headers, signal, timeoutSeconds: config.timeoutSeconds });
  const data = record(result.data); const rawResults = data.results;
  if (!Array.isArray(rawResults)) throw new RetrievalError('failed', '搜索服务响应缺少结果列表；SearXNG 实例需启用 JSON 格式。');
  for (const raw of rawResults) {
    if (output.filter(value => value.attemptId === attempt.id).length >= config.maxResults) break;
    checkCancelled(signal); const item = record(raw); const sourceUri = safeSourceUri(item.url);
    if (sourceUri && containsSecret(sourceUri,secrets)) { attempt.warnings.push('搜索结果地址含配置凭据，已移除且未请求该网页。'); continue; }
    if (!sourceUri || new URL(sourceUri).protocol !== 'https:' || !matchesDomain(sourceUri, web.allowedDomains)) { attempt.warnings.push('搜索结果中存在不符合 HTTPS/允许域名要求的来源，已过滤。'); continue; }
    const snippet = string(item.content);
    if (!snippet) { attempt.warnings.push('搜索结果缺少摘要，未作为证据使用。'); continue; }
    const source = evidence(attempt, { kind: kindHint(string(item.title)), title: string(item.title) || '搜索结果', sourceUri, locator: '搜索服务返回的摘要，尚未读取原始页面', excerpt: snippet,
      contentScope: 'search_snippet', retrievedAt: result.fetchedAt, isOfficial: matchesDomain(sourceUri, officialDomains), warnings: ['搜索摘要仅作线索，资料类别根据标题初步识别、待核验，法律效力及时间未知。'] });
    output.push(source);
    if (web.fetchPages) {
      if (!await hydrateWebEvidence(source, signal, config.timeoutSeconds, http.page, terms)) attempt.warnings.push('部分原始页面未读取成功，证据仅保留摘要。');
    } else source.warnings.push('用户未启用原始页面读取。');
  }
  if (Array.isArray(data.unresponsive_engines) && data.unresponsive_engines.length) attempt.warnings.push('SearXNG 报告部分搜索引擎未响应。');
}

function aggregate(attempts: RetrievalAttempt[], disabled: boolean, configured: boolean): RetrievalStatus {
  if (disabled) return 'user_disabled'; if (!configured) return 'not_configured';
  if (attempts.some(attempt => attempt.status === 'partial')) return 'partial';
  const success = attempts.filter(attempt => attempt.status === 'complete' || attempt.status === 'empty');
  if (success.length === attempts.length) return attempts.some(attempt => attempt.warnings.length) ? 'partial' : attempts.some(attempt => attempt.resultCount > 0) ? 'complete' : 'empty';
  if (success.length || attempts.some(attempt => attempt.resultCount > 0)) return 'partial';
  return attempts.some(attempt => attempt.status === 'cancelled') ? 'cancelled' : attempts.some(attempt => attempt.status === 'timeout') ? 'timeout' : 'failed';
}

async function collectOfficial(config: PublicRetrievalConfig, query: string, terms: string[], attempt: RetrievalAttempt, output: SourceEvidence[], signal: AbortSignal, reader?: OfficialPageReader): Promise<RetrievalAttempt['status']> {
  const settings = config.official!;
  const result = await retrieveOfficialSources({ query, terms, maxResults: config.maxResults, maxCatalogPages: settings.maxCatalogPages, ...(settings.courtCatalogs === undefined ? {} : { courtCatalogs: settings.courtCatalogs }), sourceUrls: settings.sourceUrls, timeoutSeconds: config.timeoutSeconds }, signal, reader);
  attempt.coverage = result.coverage;
  attempt.warnings.push(...result.warnings);
  if (['failed', 'timeout', 'cancelled'].includes(result.status)) attempt.error = result.status === 'failed' ? '官方目录或原文读取未能完成，请查看覆盖记录。' : result.status === 'timeout' ? '官方检索达到时间预算，已保留完成的来源。' : '官方检索已取消，已保留完成的来源。';
  for (const source of result.sources) output.push({ ...source, id: randomUUID(), attemptId: attempt.id, channel: 'web', excerptSha256: sha(source.excerpt), currentness: 'unknown', isOfficial: true });
  return result.status;
}

/** Directory queries are evaluated locally; only catalog URLs and approved source URLs leave the app. */
export async function retrieveOfficialContext(query: string, config: PublicRetrievalConfig, signal: AbortSignal, reader?: OfficialPageReader): Promise<RetrievalBundle> {
  const snapshot = validateRetrievalConfig(config);
  const clean = query.normalize('NFC').trim();
  if (!clean || clean.length > 120 || /[\u0000-\u001f]/u.test(clean)) throw new RetrievalError('failed', '目录测试关键词应为 1–120 个字符，不含控制字符。');
  const bundle: RetrievalBundle = { configSnapshot: snapshot, knowledgeStatus: snapshot.knowledge.enabled ? 'skipped' : 'user_disabled', webStatus: 'user_disabled', officialStatus: 'user_disabled', searchStatus: snapshot.web.enabled ? 'skipped' : 'user_disabled', attempts: [], evidence: [], limitations: ['本次仅测试已保存的官方目录与补充原文链接；不调用模型、企业知识库或通用搜索服务。'] };
  if (!snapshot.official?.enabled) return bundle;
  const attempt: RetrievalAttempt = { id: randomUUID(), provider: 'official_catalog', channel: 'web', query: clean, status: 'failed', startedAt: new Date().toISOString(), finishedAt: '', resultCount: 0, error: null, warnings: [] };
  bundle.attempts.push(attempt);
  attempt.status = await collectOfficial(snapshot, clean, clean.split(/[\s,，;；、]+/u).filter(Boolean).slice(0, 20), attempt, bundle.evidence, signal, reader);
  attempt.finishedAt = new Date().toISOString(); attempt.resultCount = bundle.evidence.length;
  bundle.officialStatus = aggregate(bundle.attempts, false, true); bundle.webStatus = bundle.officialStatus;
  bundle.limitations.push(...attempt.warnings, '目录只在本轮已读页面的标题中查找；正文回读与引文匹配不等于法律效力、时效或适用性核验。');
  return bundle;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new RetrievalError('cancelled', '检索已取消。'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

export async function retrieveContext(document: ContractDetail, context: ReviewContext, config: PublicRetrievalConfig,
  keys: { knowledgeApiKey: string | null; webApiKey: string | null }, signal: AbortSignal, onStage: (stage: string) => void,
  indexedSearch?: (input: KnowledgeSearchInput & { folderPath: string }, signal: AbortSignal) => Promise<KnowledgeSearchResult>, officialReader?: OfficialPageReader): Promise<RetrievalBundle> {
  const snapshot = validateRetrievalConfig(config);
  snapshot.knowledge.api.hasApiKey = config.knowledge.api.hasApiKey; snapshot.knowledge.api.keyStorage = config.knowledge.api.keyStorage;
  snapshot.web.hasApiKey = config.web.hasApiKey; snapshot.web.keyStorage = config.web.keyStorage;
  const bundle: RetrievalBundle = { configSnapshot: snapshot, knowledgeStatus: 'not_configured', webStatus: 'not_configured', attempts: [], evidence: [], limitations: [] };
  const planned = retrievalTopics(document, context); const jobs: Array<Promise<void>> = [];
  const run = async (provider: RetrievalAttempt['provider'], channel: RetrievalAttempt['channel'], query: string, work: (attempt: RetrievalAttempt, branchSignal: AbortSignal) => Promise<void | RetrievalAttempt['status']>) => {
    const attempt: RetrievalAttempt = { id: randomUUID(), provider, channel, query, status: 'failed', startedAt: new Date().toISOString(), finishedAt: '', resultCount: 0, error: null, warnings: [] };
    bundle.attempts.push(attempt);
    const branch = new AbortController(); const cancel = () => branch.abort(new RetrievalError('cancelled','检索已取消。'));
    signal.addEventListener('abort',cancel,{once:true}); if(signal.aborted) cancel();
    const timer=setTimeout(()=>branch.abort(new RetrievalError('timeout','此检索分支达到总时间预算，停止后续回读并保留已取得的结果。')),Math.min(120,snapshot.timeoutSeconds*2)*1000);
    try { checkCancelled(branch.signal); const status = await work(attempt,branch.signal); checkCancelled(branch.signal); attempt.resultCount = bundle.evidence.filter(source => source.attemptId === attempt.id).length; attempt.status = status ?? (attempt.resultCount ? 'complete' : 'empty'); }
    catch (error) {
      const failure=branch.signal.aborted && branch.signal.reason instanceof RetrievalError ? branch.signal.reason : error;
      attempt.status = signal.aborted ? 'cancelled' : failure instanceof RetrievalError ? failure.code : 'failed';
      attempt.error = failure instanceof RetrievalError ? failure.message : '此检索通道失败，未回显内部错误或敏感信息。';
    }
    finally { clearTimeout(timer); signal.removeEventListener('abort',cancel); attempt.resultCount = bundle.evidence.filter(source => source.attemptId === attempt.id).length; attempt.finishedAt = new Date().toISOString(); attempt.warnings = [...new Set(attempt.warnings)].slice(0,30); }
  };
  onStage('并发检索客户资料与互联网法律线索');
  if (snapshot.knowledge.enabled && snapshot.knowledge.folderPath) jobs.push(run('folder', 'knowledge', planned.query, async (attempt, branchSignal) => {
    if (!indexedSearch) {
      // Compatibility for direct connector consumers. Desktop always supplies its persistent index.
      return folderSearch(snapshot.knowledge.folderPath!, planned.terms, snapshot.maxResults, snapshot.timeoutSeconds, attempt, bundle.evidence, branchSignal);
    }
    const result = await abortable(indexedSearch({ folderPath: snapshot.knowledge.folderPath!, preferences: snapshot.knowledge.preferences, query: planned.query, terms: planned.terms, limit: snapshot.maxResults }, branchSignal), branchSignal);
    checkCancelled(branchSignal);
    attempt.warnings.push(...result.state.limitations);
    if (!result.state.lastSyncedAt) attempt.warnings.push('本地目录尚未完成建库，请在检索设置中建立知识库；本次未扫描源目录。');
    if (result.state.job?.status === 'running') attempt.warnings.push('知识库正在更新，本次仅查询已发布的文件版本。');
    for (const hit of result.hits) {
      const source = evidence(attempt, { kind: kindHint(hit.title), title: hit.title, sourceUri: hit.sourceUri,
        locator: `${hit.relativePath} · ${hit.locator} · 文件版本 ${hit.fileSha256.slice(0, 12)}`,
        excerpt: hit.excerpt, contentScope: 'fragment', retrievedAt: new Date().toISOString(), isOfficial: false, warnings: hit.warnings });
      source.localIndex = { chunkId: hit.chunkId, sourceFileId: hit.sourceFileId, versionId: hit.versionId, fileSha256: hit.fileSha256, indexedAt: hit.indexedAt, location: hit.location };
      bundle.evidence.push(source);
    }
  }));
  if (snapshot.knowledge.enabled && snapshot.knowledge.api.enabled) jobs.push(run(snapshot.knowledge.api.provider, 'knowledge', planned.query, (attempt,branchSignal) => knowledgeApi(snapshot, planned.query, keys.knowledgeApiKey, attempt, bundle.evidence, branchSignal)));
  const secrets = [keys.knowledgeApiKey,keys.webApiKey].filter((value):value is string=>Boolean(value));
  if (snapshot.official?.enabled) {
    const terms = planned.officialTerms.length ? planned.officialTerms : ['合同'];
    jobs.push(run('official_catalog', 'web', terms.join(' '), (attempt, branchSignal) => collectOfficial(snapshot, terms.join(' '), terms, attempt, bundle.evidence, branchSignal, officialReader)));
  }
  if (snapshot.web.enabled) for (const query of planned.webQueries) jobs.push(run(snapshot.web.provider, 'web', query.query, (attempt,branchSignal) => webSearch(snapshot, query, keys.webApiKey, attempt, bundle.evidence, branchSignal,secrets,planned.officialTerms)));
  await Promise.allSettled(jobs);
  bundle.knowledgeStatus = aggregate(bundle.attempts.filter(attempt => attempt.channel === 'knowledge'), !snapshot.knowledge.enabled, Boolean(snapshot.knowledge.folderPath || snapshot.knowledge.api.enabled));
  bundle.officialStatus = aggregate(bundle.attempts.filter(attempt => attempt.provider === 'official_catalog' || attempt.provider === 'official_page'), !snapshot.official?.enabled, true);
  bundle.searchStatus = aggregate(bundle.attempts.filter(attempt => attempt.channel === 'web' && attempt.provider !== 'official_catalog' && attempt.provider !== 'official_page'), !snapshot.web.enabled, Boolean(snapshot.web.baseUrl));
  bundle.webStatus = aggregate(bundle.attempts.filter(attempt => attempt.channel === 'web'), !snapshot.web.enabled && !snapshot.official?.enabled, Boolean(snapshot.web.baseUrl || snapshot.official?.enabled));
  for (const channel of ['knowledge','web'] as const) {
    const status = channel === 'knowledge' ? bundle.knowledgeStatus : bundle.webStatus;
    if (status !== 'complete') bundle.limitations.push(`${channel === 'knowledge' ? '客户资料' : '互联网'}检索状态：${status}；未完成或受限部分不能视为未发现风险。`);
  }
  if (bundle.evidence.some(source => source.contentScope === 'search_snippet')) bundle.limitations.push('部分材料仅为搜索摘要，不能冒充已读取原文。');
  const sourceUris = bundle.evidence.map(source=>source.sourceUri).filter((value):value is string=>Boolean(value));
  if (new Set(sourceUris).size !== sourceUris.length) bundle.limitations.push('不同检索尝试可能返回同一来源，当前保留各次命中关系；证据数量不等于独立来源数量。');
  bundle.limitations.push('检索命中与来源读取不等于法条时效、法律效力或结论支持程度已核验；所有未知时间与效力保持未知。');
  for (const attempt of bundle.attempts) if (attempt.error || attempt.warnings.length) bundle.limitations.push(`${attempt.provider}：${[attempt.error, ...attempt.warnings].filter(Boolean).join('；')}`);
  // Do not trust provider warnings/excerpts to avoid echoing authentication material.
  const redact = (text:string) => secrets.reduce((value,secret)=>value.split(secret).join('[已遮蔽凭据]'),text);
  for (const attempt of bundle.attempts) { attempt.error = attempt.error === null ? null : redact(attempt.error); attempt.warnings = attempt.warnings.map(redact); }
  for (const source of bundle.evidence) {
    source.title=redact(source.title); source.locator=redact(source.locator); source.warnings=source.warnings.map(redact);
    if (containsSecret(source.excerpt,secrets)) { source.excerpt=redact(source.excerpt); source.excerptSha256=sha(source.excerpt); source.warnings.push('片段中的配置凭据已遮蔽，不能把遮蔽内容当作未处理原文。'); }
    if (source.sourceUri && containsSecret(source.sourceUri,secrets)) { source.sourceUri=null; source.warnings.push('来源地址含配置凭据，已从结果移除。'); }
  }
  bundle.limitations=bundle.limitations.map(redact);
  return bundle;
}
