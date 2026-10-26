import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../src/core/storage';
import { defaultRetrievalConfig, type SourceEvidence } from '../src/shared/contracts';
import { hydrateWebEvidence, validateRetrievalConfig } from '../src/core/retrieval';
import { OFFICIAL_CATALOG_URL, parseCourtInterpretationCatalog, retrieveOfficialSources } from '../src/core/official-sources';
import { RetrievalError, type HttpResult } from '../src/core/retrieval-http';

const court = 'https://www.court.gov.cn/fabu/gengduo/16.html';
const detail = 'https://www.court.gov.cn/fabu/xiangqing/12345.html';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const page = (html: string): HttpResult => ({ body: Buffer.from(html), contentType: 'text/html;charset=utf-8', fetchedAt: '2026-10-23T00:00:00.000Z' });
const catalog = (links: Array<[string, string]>, total = 2, next = true) => `<div class="sec_list"><div class="title"><div class="tit">司法解释</div></div><ul>${links.map(([url, title]) => `<li><a href="${url}" title="${title}">${title.slice(0, 4)}...</a></li>`).join('')}</ul><div class="count">共<span>40</span>篇文章</div><ul class="yiiPager">${next ? '<li class="next"><a href="/fabu/gengduo/16_2.html">下一页</a></li>' : ''}<li class="last"><a href="/fabu/gengduo/16_${total}.html">尾页</a></li></ul></div>`;
const courtPage = (body = '<p>法释〔2026〕1号</p><p>自2026年10月1日起施行</p><p>第一条 支付争议需要结合合同和业务事实核查，本段仅为合成工程资料。</p>') => `<title>站点页面标题</title><nav>站点导航和无关推荐</nav><div class="detail"><div class="title">最高人民法院关于支付问题的解释（合成测试）</div><div class="detail_mes">发布时间：2026-09-01 09:00:00</div><div class="txt_txt">${body}</div></div><footer>无关页脚</footer>`;
function evidence(uri = detail): SourceEvidence { return { id: randomUUID(), attemptId: randomUUID(), channel: 'web', kind: 'case', title: '搜索推断标题', sourceUri: uri, locator: '搜索摘要', excerpt: '搜索返回摘要', excerptSha256: sha('搜索返回摘要'), contentScope: 'search_snippet', retrievedAt: '2026-10-23T00:00:00.000Z', publishedAt: null, effectiveAt: null, currentness: 'unknown', isOfficial: true, warnings: [] }; }

test('最高法栏目只取已验证容器和公开详情，使用完整title属性及真实分页，导航外链不作为条目', () => {
  const html = `<nav><a href="/fabu/xiangqing/999.html">导航假命中</a></nav>${catalog([[detail, '支付问题解释完整标题'], ['https://attacker.test/fabu/xiangqing/2.html', '伪造支付'], ['/fabu/xiangqing/5.html?token=secret', '带凭据'], ['/fabu/gengduo/16_2.html', '下一页']])}`;
  const result = parseCourtInterpretationCatalog(page(html), court); assert.equal(result.totalPages, 2); assert.deepEqual(result.candidates, [{ url: detail, title: '支付问题解释完整标题' }]);
  assert.throws(() => parseCourtInterpretationCatalog(page('<div>请登录或启用脚本</div>'), court), /结构|名称/);
  assert.throws(() => parseCourtInterpretationCatalog(page(html), 'https://www.court.gov.cn/fabu/gengduo/16.html?search=合同'), /不支持/);
  assert.throws(() => parseCourtInterpretationCatalog(page(html.replace('司法解释', '任意栏目')), court), /名称/);
});

test('最高法目录是显式可选项，默认不额外请求；标题筛选在本机完成并单独记录覆盖上限', async () => {
  const calls: string[] = [];
  const reader = async (url: string) => { calls.push(url); if (url === OFFICIAL_CATALOG_URL) return page('<input id="page-count" value="0"/>'); if (url === court) return page(catalog([[detail, '最高法支付问题解释'], ['/fabu/xiangqing/7.html', '无关主题']], 21)); if (url === detail) return page(courtPage()); throw new Error('unexpected request'); };
  const input = { query: '客户名称与金额不可发送', terms: ['支付', '合同'], maxResults: 2, maxCatalogPages: 1, timeoutSeconds: 5, sourceUrls: [] };
  const old = await retrieveOfficialSources(input, new AbortController().signal, reader); assert.deepEqual(calls, [OFFICIAL_CATALOG_URL]); assert.equal(old.coverage.courtCatalogs, undefined);
  calls.length = 0; const result = await retrieveOfficialSources({ ...input, courtCatalogs: ['interpretations'] }, new AbortController().signal, reader);
  assert.deepEqual(calls, [OFFICIAL_CATALOG_URL, court, detail]); assert.equal(result.sources[0].kind, 'judicial_interpretation'); assert.equal(result.sources[0].officialMetadata.catalogUrl, court); assert.equal(result.coverage.courtCatalogs?.[0].pagesRead, 1); assert.equal(result.coverage.courtCatalogs?.[0].totalPages, 21); assert.equal(result.coverage.courtCatalogs?.[0].matchedCandidates, 1); assert.equal(result.coverage.courtCatalogs?.[0].documentsRead, 1); assert.equal(result.coverage.courtCatalogs?.[0].truncated, true); assert.equal(result.status, 'partial'); assert.ok(!calls.join(' ').includes('客户名称'));
});

test('最高法分页、重定向/交互失败与取消都有覆盖记录，不把错误说成无结果', async () => {
  const input = { query: '支付', terms: ['支付'], maxResults: 2, maxCatalogPages: 2, courtCatalogs: ['interpretations'] as const, timeoutSeconds: 5, sourceUrls: [] };
  const result = await retrieveOfficialSources({ ...input, courtCatalogs: [...input.courtCatalogs] }, new AbortController().signal, async url => {
    if (url === OFFICIAL_CATALOG_URL) return page('<input id="page-count" value="0"/>');
    if (url === court) return page(catalog([[detail, '支付解释']], 2));
    if (url.includes('16_2.html')) return page(catalog([['/fabu/xiangqing/6.html', '支付补充解释']], 2, false));
    if (url === detail) return page(courtPage()); throw new RetrievalError('failed', '公开原文需要交互，未读取。');
  });
  assert.equal(result.coverage.courtCatalogs?.[0].pagesRead, 2); assert.equal(result.coverage.courtCatalogs?.[0].exhausted, true); assert.equal(result.coverage.courtCatalogs?.[0].failedReads, 1); assert.equal(result.coverage.failedReads, 1); assert.equal(result.status, 'partial'); assert.equal(result.sources.length, 1);
  const controller = new AbortController(); controller.abort(); let reads = 0; const cancelled = await retrieveOfficialSources({ ...input, courtCatalogs: [...input.courtCatalogs] }, controller.signal, async () => { reads++; return page(''); }); assert.equal(reads, 0); assert.equal(cancelled.status, 'cancelled');
});

test('搜索发现的支持官方URL优先站点正文parser，保留分类/元信息/直接引文且不混导航', async () => {
  const source = evidence(); const id = source.id; const attemptId = source.attemptId;
  assert.equal(await hydrateWebEvidence(source, new AbortController().signal, 5, async () => page(courtPage()), ['支付']), true);
  assert.equal(source.id, id); assert.equal(source.attemptId, attemptId); assert.equal(source.kind, 'judicial_interpretation'); assert.equal(source.contentScope, 'full_text'); assert.equal(source.officialMetadata?.discoveredVia, 'search'); assert.equal(source.officialMetadata?.documentNumber, '法释〔2026〕1号'); assert.equal(source.effectiveAt, '2026-10-01'); assert.equal(source.currentness, 'unknown'); assert.equal(source.excerptSha256, sha(source.excerpt)); assert.ok(!source.excerpt.includes('站点导航')); assert.ok(!source.excerpt.includes('无关页脚'));
  const failed = evidence(); const original = failed.excerpt; assert.equal(await hydrateWebEvidence(failed, new AbortController().signal, 5, async () => page('<nav>很多站点导航文字</nav><div id="app">请登录</div>'), ['支付']), false); assert.equal(failed.contentScope, 'search_snippet'); assert.equal(failed.excerpt, original); assert.match(failed.warnings.join('；'), /没有退回/);
  const ordinary = evidence('https://example.test/public-article'); assert.equal(await hydrateWebEvidence(ordinary, new AbortController().signal, 5, async () => page('<article>普通公开网页可以使用通用正文提取。</article>')), true); assert.equal(ordinary.officialMetadata, undefined);
});

test('搜索命中官方长文按受控主题选择连续原文；缺主题不能截开头冒充相关依据', async () => {
  const body = `<p>法释〔2026〕1号</p><p>第一条 ${'不相关事项。'.repeat(1400)}</p><p>第二条 支付安排应人工核对。本段只供工程测试。</p>`;
  const hit = evidence(); assert.equal(await hydrateWebEvidence(hit, new AbortController().signal, 5, async () => page(courtPage(body)), ['支付']), true); assert.equal(hit.contentScope, 'fragment'); assert.match(hit.excerpt, /支付安排/); assert.ok(hit.excerpt.length <= 6000);
  const missing = evidence(); assert.equal(await hydrateWebEvidence(missing, new AbortController().signal, 5, async () => page(courtPage(body))), false); assert.equal(missing.contentScope, 'search_snippet');
});

test('最高法栏目配置有界校验并真实保存重启，缺省保持旧配置不补字段', async () => {
  const value = defaultRetrievalConfig(); const old = validateRetrievalConfig(value); assert.equal(old.official?.courtCatalogs, undefined);
  const next = { ...value, official: { enabled: true, maxCatalogPages: 2, sourceUrls: [], courtCatalogs: ['interpretations' as const] } }; assert.deepEqual(validateRetrievalConfig(next).official?.courtCatalogs, ['interpretations']);
  assert.throws(() => validateRetrievalConfig({ ...value, official: { ...next.official, courtCatalogs: ['interpretations', 'interpretations'] } }));
  const dir = await mkdtemp(join(tmpdir(), 'law-court-config-'));
  try { const store = await AppStore.open(dir); try { await store.saveRetrievalConfig(validateRetrievalConfig(next)); } finally { await store.close(); } const reopened = await AppStore.open(dir); try { assert.deepEqual(reopened.getRetrievalConfig()?.official?.courtCatalogs, ['interpretations']); } finally { await reopened.close(); } } finally { await rm(dir, { recursive: true, force: true }); }
});
