import assert from 'node:assert/strict';
import test from 'node:test';
import { OFFICIAL_CATALOG_URL, OFFICIAL_SOURCE_LIMITS, parseOfficialPage, retrieveOfficialSources, validateOfficialSourceUrl, type OfficialPageReader, type OfficialRetrievalInput } from '../src/core/official-sources';
import { RetrievalError, type HttpResult } from '../src/core/retrieval-http';

const lawUrl = 'https://xzfg.moj.gov.cn/front/law/detail?LawID=1694';
const courtUrl = 'https://www.court.gov.cn/zixun/xiangqing/504221.html';
const templateUrl = 'https://htsfwb.samr.gov.cn/View?id=b6cdd9b5-4d70-4fd1-8de2-b39a53229b47';
const signal = () => new AbortController().signal;
const page = (html: string): HttpResult => ({ body: Buffer.from(html), contentType: 'text/html;charset=utf-8', fetchedAt: '2026-10-22T00:00:00.000Z' });
const lawHtml = (body = '<p>第一条 付款应根据交易双方约定核对条件，本段仅为接口解析测试样本。</p>') => `<html><title>官方法规测试样本</title><nav>导航中的付款不属于正文</nav><div class="text-title">支付条件条例（测试）</div><div class="law-chapter"><p>（2023年9月20日会议通过 2023年10月16日中华人民共和国国务院令第766号公布 自2024年1月1日起施行）</p>${body}</div><footer>无关页脚</footer></html>`;
const courtHtml = (body = '<p>法释〔2026〕12号</p><p>（自2026年6月30日起施行）</p><p>第一条 支付争议应结合交易事实核实，本段仅为解析测试，不是法律意见。</p>') => `<html><div class="detail"><div class="title">最高法发布《关于合同问题的解释》（测试）</div><div class="detail_mes"><span>来源：测试</span><span>发布时间：2026-06-29 10:00:00</span></div><div class="txt"><div class="txt_txt" id="zoom">${body}</div><div>推荐阅读中的付款</div></div></div></html>`;
const catalog = (links: Array<[string, string]>, totalPages = 1) => `<html><input id="page-count" value="${totalPages}"/><div>${links.map(([url, title]) => `<a href="${url}">${title}</a>`).join('')}</div></html>`;
const input = (overrides: Partial<OfficialRetrievalInput> = {}): OfficialRetrievalInput => ({ terms: ['合同', '服务', '付款', '支付'], query: '不可发送到官方目录的客户名称和金额123456', maxResults: 4, maxCatalogPages: 1, sourceUrls: [], timeoutSeconds: 5, ...overrides });

test('官方原文URL仅接受验证过的站点和详情路径，并去掉行政法规的Query', () => {
  assert.equal(validateOfficialSourceUrl(`${lawUrl}&Query=%E5%AE%A2%E6%88%B7`), lawUrl);
  assert.equal(validateOfficialSourceUrl(courtUrl), courtUrl);
  assert.equal(validateOfficialSourceUrl(templateUrl), templateUrl);
  for (const value of ['http://xzfg.moj.gov.cn/front/law/detail?LawID=1', 'https://xzfg.moj.gov.cn/law/download?LawID=1', 'https://xzfg.moj.gov.cn/front/law/detail?LawID=1&LawID=2', 'https://xzfg.moj.gov.cn/front/law/detail?LawID=1&token=secret', 'https://user:secret@www.court.gov.cn/zixun/xiangqing/1.html', 'https://www.court.gov.cn:9443/zixun/xiangqing/1.html', 'https://court.gov.cn.evil.test/zixun/xiangqing/1.html', 'https://www.court.gov.cn/zixun/xiangqing/1.html?redirect=bad', 'https://www.court.gov.cn/zixun/xiangqing/1.html#body', 'https://127.0.0.1/zixun/xiangqing/1.html', 'https://htsfwb.samr.gov.cn/View?id=../../private', 'https://htsfwb.samr.gov.cn/View?id=b6cdd9b5-4d70-4fd1-8de2-b39a53229b47&id=other']) assert.throws(() => validateOfficialSourceUrl(value), RetrievalError, value);
});

test('法规提取限定正文容器，保留分段、文号与不同公布/施行日期', () => {
  const html = lawHtml('<p>第一条 支付条款&#xFF0C;保留原文。</p><p>第二条 本段是用于验证段落连续性的测试文字。</p><script>恶意脚本中的支付</script><div hidden>隐藏内容中的支付</div>');
  const source = parseOfficialPage(lawUrl, page(html), ['支付']);
  assert.equal(source.kind, 'statute'); assert.equal(source.publishedAt, '2023-10-16'); assert.equal(source.effectiveAt, '2024-01-01');
  assert.equal(source.officialMetadata.publisher, '国务院');
  assert.equal(source.officialMetadata.documentNumber, '中华人民共和国国务院令第766号');
  assert.equal(source.contentScope, 'full_text'); assert.match(source.excerpt, /第一条 支付条款，保留原文。\n第二条/);
  assert.doesNotMatch(source.excerpt, /导航|页脚|恶意脚本|隐藏内容/); assert.match(source.officialMetadata.validityNote, /未自动核验/);
});

test('长篇法规根据主题定位后面的条号，拒绝固定截取网页开头', () => {
  const source = parseOfficialPage(lawUrl, page(lawHtml(`<p>第一条 ${'一般事项及流程说明。'.repeat(900)}</p><p>第九条 支付安排应核对相关条件。本条完整保留，供定位测试。</p><p>第十条 后续一般事项不属于本次命中的支付条款。</p>`)), ['支付']);
  assert.equal(source.contentScope, 'fragment'); assert.equal(source.officialMetadata.article, '第九条'); assert.match(source.locator, /第九条.*正文字符/);
  assert.match(source.excerpt, /^第九条 支付安排/); assert.doesNotMatch(source.excerpt, /第一条|第十条/);
});

test('超长条款截取相关连续窗口且明确上下文未全提供', () => {
  const body = `<p>第一条 ${'普通内容。'.repeat(1700)}支付条件的相关内容。${'其他说明。'.repeat(1000)}</p>`;
  const source = parseOfficialPage(lawUrl, page(lawHtml(body)), ['支付']);
  assert.ok(source.excerpt.length <= OFFICIAL_SOURCE_LIMITS.excerptCharacters); assert.match(source.excerpt, /支付条件/);
  assert.ok(source.warnings.some(value => value.includes('上下文未全部提供')));
});

test('行政法规正文跨章节完整保留，多个题注日期不冒充当前版本', () => {
  const html = '<div class="text-title">测试条例</div><div class="law-chapter"><p>（2001年1月1日国务院令第1号公布 根据2024年2月2日修订 自2024年3月3日起施行）</p><h2>第一章 总则</h2><p>第一条 本段是用于章节覆盖检查的测试文字。</p></div><div class="law-chapter"><h2>第二章 支付</h2><p>第二条 后续章节的支付约定需要保留，不能因只读取第一章而遗漏。</p></div>';
  const source = parseOfficialPage(lawUrl, page(html), ['支付']);
  assert.match(source.excerpt, /第一章.*\n第一条[\s\S]*第二章.*\n第二条/);
  assert.equal(source.publishedAt, null); assert.equal(source.effectiveAt, null); assert.equal(source.officialMetadata.documentNumber, null);
  assert.match(source.officialMetadata.versionLabel!, /当前版本待核验/); assert.ok(source.warnings.some(value => value.includes('未将首个日期')));
  const multiple = parseOfficialPage(lawUrl, page('<div class="text-title">测试条例</div><div class="law-chapter"><p>（2001年1月1日国务院令第1号公布 2024年2月2日国务院令第2号公布 自2001年2月2日起施行 自2024年3月3日起施行）</p><p>第一条 支付安排属于本次章节覆盖与日期识别的测试内容。</p></div>'), ['支付']);
  assert.equal(multiple.publishedAt, null); assert.equal(multiple.effectiveAt, null);
});

test('施行日期比较使用中国大陆日历日，避免UTC午夜边界误报未来', () => {
  const source = parseOfficialPage(courtUrl, { ...page(courtHtml('<p>法释〔2026〕12号</p><p>自2026年10月22日起施行</p><p>第一条 支付问题只用于日期边界测试，不构成法律意见。</p>')), fetchedAt: '2026-10-21T17:00:00.000Z' }, ['支付']);
  assert.equal(source.effectiveAt, '2026-10-22'); assert.ok(!source.warnings.some(value => value.includes('不得当作已施行')));
});

test('无法定位长篇正文中的主题时不以开头填充结果', () => {
  assert.throws(() => parseOfficialPage(lawUrl, page(lawHtml(`<p>第一条 ${'一般事项。'.repeat(1600)}</p>`)), ['知识产权']), /未定位到/);
});

test('最高法正文与元数据分别提取，司法解释分类需正文文号，未来施行日期保留待核验', () => {
  const source = parseOfficialPage(courtUrl, page(courtHtml('<p>法释〔2026〕12号</p><p>（自2027年1月1日起施行）</p><p>第一条 支付问题仍需结合交易事实核实，本句只用于解析测试。</p>')), ['支付']);
  assert.equal(source.kind, 'judicial_interpretation'); assert.equal(source.publishedAt, '2026-06-29'); assert.equal(source.effectiveAt, '2027-01-01');
  assert.equal(source.officialMetadata.documentNumber, '法释〔2026〕12号'); assert.ok(source.warnings.some(value => value.includes('不得当作已施行')));
  assert.doesNotMatch(source.excerpt, /推荐阅读|发布时间/);
  const news = parseOfficialPage(courtUrl, page(courtHtml('<p>本次发布活动介绍司法解释相关背景，支付问题需要另行核查。本段只是新闻正文测试样本。</p>')), ['支付']);
  assert.equal(news.kind, 'commentary');
});

test('合同示范文本排除侧栏风险提示，不将正文签约日期当成发布日期', () => {
  const html = `<html><title>&#x4E2D;&#x4ECB;合同（市场监管总局2025版） - 合同示范文本库 - 国家市场监督管理总局</title><div class="samr-modal-content">使用弹窗中的支付</div><div class="samr-view-content"><p>GF—2025—2613</p><p>第一条 甲方与乙方确认支付条件。2020年1月1日公布的资料与签约日期不是本模板的发布日期。</p></div><div class="samr-view-info"><div><div class="info-title">发布机关：</div><div class="info-content">市场监管总局</div></div><div><div class="info-title">发布年份：</div><div class="info-content">2025年</div></div><div><div class="info-title">发布编号：</div><div class="info-content">GF-2025-2613</div></div></div><div class="samr-view-risk">风险侧栏中的支付提示，不属于合同正文</div></html>`;
  const source = parseOfficialPage(templateUrl, page(html), ['支付']);
  assert.equal(source.kind, 'contract_template'); assert.equal(source.title, '中介合同（市场监管总局2025版）');
  assert.equal(source.publishedAt, null); assert.equal(source.effectiveAt, null); assert.equal(source.officialMetadata.versionLabel, '2025年发布版本');
  assert.equal(source.officialMetadata.publisher, '市场监管总局'); assert.equal(source.officialMetadata.documentNumber, 'GF-2025-2613');
  assert.doesNotMatch(source.excerpt, /侧栏|弹窗/); assert.ok(source.warnings.some(value => value.includes('未混入')));
});

test('动态壳、损坏编码和非HTML不作为官方正文', () => {
  assert.throws(() => parseOfficialPage(lawUrl, page('<div id="app"></div><script src="app.js"></script>'), ['支付']), /正文容器/);
  assert.throws(() => parseOfficialPage(lawUrl, { ...page(''), body: Buffer.from([0xff, 0xfe, 0xff]) }, ['支付']), /字符编码/);
  assert.throws(() => parseOfficialPage(lawUrl, { ...page('%PDF-1.7'), contentType: 'application/pdf' }, ['支付']), /HTML/);
});

test('有限目录分页独立发现候选，版本URL去重、主题匹配与第二页发现位置可追溯', async () => {
  const calls: string[] = []; const first = 'https://xzfg.moj.gov.cn/front/law/detail?LawID=100'; const second = 'https://xzfg.moj.gov.cn/front/law/detail?LawID=101';
  const reader: OfficialPageReader = async url => {
    calls.push(url);
    if (url === OFFICIAL_CATALOG_URL) return page(catalog([[`${first}&amp;Query=不得发送`, '支付安排条例'], [first, '支付安排条例重复链接'], ['https://xzfg.moj.gov.cn/front/law/detail?LawID=90', '一般服务合同条例'], ['https://attacker.test/front/law/detail?LawID=1', '支付伪造条目']], 2));
    if (url === `${OFFICIAL_CATALOG_URL}?PageIndex=2`) return page(catalog([[first, '支付安排条例'], [second, '付款安排条例']], 2));
    assert.ok([first, second].includes(url)); return page(lawHtml());
  };
  const result = await retrieveOfficialSources(input({ maxCatalogPages: 2 }), signal(), reader);
  assert.equal(result.status, 'complete'); assert.equal(result.coverage.catalogPagesRead, 2); assert.equal(result.coverage.totalPages, 2); assert.equal(result.coverage.pagesLimit, 2);
  assert.equal(result.coverage.catalogCandidates, 3); assert.equal(result.coverage.matchedCandidates, 2); assert.equal(result.coverage.catalogExhausted, true);
  assert.equal(result.sources.length, 2); assert.equal(calls.filter(value => value === first).length, 1);
  assert.equal(result.sources.find(source => source.sourceUri === second)?.officialMetadata.catalogUrl, `${OFFICIAL_CATALOG_URL}?PageIndex=2`);
  assert.ok(calls.every(value => !value.includes('客户') && !value.includes('123456') && !value.includes('不得发送') && !value.includes('attacker')));
});

test('仅扫描预算页数时报告部分覆盖，通用合同或服务词不吞掉主题筛选', async () => {
  const calls: string[] = [];
  const result = await retrieveOfficialSources(input({ terms: ['合同', '服务', '采购'] }), signal(), async url => { calls.push(url); return page(catalog([[lawUrl, '服务合同管理条例']], 61)); });
  assert.equal(result.status, 'partial'); assert.equal(result.sources.length, 0); assert.equal(result.coverage.catalogPagesRead, 1); assert.equal(result.coverage.totalPages, 61);
  assert.equal(result.coverage.truncated, true); assert.equal(result.coverage.matchedCandidates, 0); assert.deepEqual(calls, [OFFICIAL_CATALOG_URL]);
  assert.ok(result.warnings.some(value => value.includes('通用'))); assert.ok(result.warnings.some(value => value.includes('共 61 页')));
});

test('用户指定原文可独立读取；目录失败保留已读来源并隐藏远端错误细节', async () => {
  const result = await retrieveOfficialSources(input({ sourceUrls: [courtUrl] }), signal(), async url => {
    if (url === courtUrl) return page(courtHtml()); throw new Error('upstream-secret-credential');
  });
  assert.equal(result.status, 'partial'); assert.equal(result.sources.length, 1); assert.equal(result.coverage.userUrlsRead, 1); assert.equal(result.coverage.failedReads, 1);
  assert.equal(result.sources[0].officialMetadata.discoveredVia, 'user_url'); assert.ok(!JSON.stringify(result).includes('upstream-secret-credential'));
});

test('无条目且明确总页数为零可报告empty，动态壳不能当作无结果', async () => {
  const empty = await retrieveOfficialSources(input(), signal(), async () => page(catalog([], 0)));
  assert.equal(empty.status, 'empty'); assert.equal(empty.coverage.catalogExhausted, true);
  const shell = await retrieveOfficialSources(input(), signal(), async () => page('<div id="app"></div>'));
  assert.equal(shell.status, 'failed'); assert.equal(shell.coverage.failedReads, 1); assert.match(shell.warnings.join(' '), /未宣称目录无结果/);
});

test('非法配置在网络请求前拒绝', async () => {
  let requests = 0; const reader: OfficialPageReader = async () => { requests++; return page(''); };
  await assert.rejects(retrieveOfficialSources(input({ sourceUrls: ['https://localhost/private'] }), signal(), reader), /仅支持/);
  await assert.rejects(retrieveOfficialSources(input({ maxCatalogPages: 11 }), signal(), reader), /范围参数/);
  assert.equal(requests, 0);
});

test('取消时保留已完成来源，忽略迟到reader结果且不派发后续请求', async () => {
  const controller = new AbortController(); let release!: (value: HttpResult) => void; let calls = 0;
  const resultPromise = retrieveOfficialSources(input({ sourceUrls: [courtUrl] }), controller.signal, async url => {
    calls++; if (url === courtUrl) return page(courtHtml());
    return new Promise<HttpResult>(resolve => { release = resolve; controller.abort(); });
  });
  const result = await resultPromise;
  assert.equal(result.status, 'cancelled'); assert.equal(result.sources.length, 1); assert.equal(result.coverage.userUrlsRead, 1); assert.equal(calls, 2);
  release(page(catalog([[lawUrl, '支付条例']]))); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(result.sources.length, 1); assert.equal(result.coverage.catalogPagesRead, 0); assert.equal(calls, 2);
});

test('总时间预算终止不响应signal的reader，不会无限等待', async () => {
  const start = performance.now(); const result = await retrieveOfficialSources(input({ timeoutSeconds: 1 }), signal(), async () => new Promise<HttpResult>(() => {}));
  assert.equal(result.status, 'timeout'); assert.equal(result.coverage.truncated, true); assert.ok(performance.now() - start < 3500);
});
