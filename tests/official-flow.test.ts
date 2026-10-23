import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRetrievalConfig, type ContractDetail } from '../src/shared/contracts';
import { retrieveContext } from '../src/core/retrieval';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import type { OfficialPageReader } from '../src/core/official-sources';

const stamp = '2026-10-22T09:00:00Z';
const page = (body: string) => ({ body: Buffer.from(body), contentType: 'text/html; charset=utf-8', fetchedAt: stamp });
const catalog = page('<input id="page-count" value="2"><a href="/front/law/detail?LawID=100">网络数据管理条例</a>');
const article = page('<div class="text-title">网络数据管理条例（虚构协议测试资料）</div><div class="law-chapter"><p>国务院令第100号</p><p>2026年9月1日公布，自2026年11月1日起施行。</p><p>第一条 网络数据与个人信息处理应按实际取得的资料复核。</p></div>');
const context = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: 'SecretCompany987，99999888，不应发送' } as const;

test('官方目录与企业资料同时运行，保留覆盖和日期且公网请求不含合同内容', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'law-official-flow-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, '制度.txt'), '合同付款与个人信息处理需要遵守公司制度。');
  const document: ContractDetail = { id: 'document', name: '私密合同文件名', format: 'docx', language: 'mixed', byteSize: 0, blockCount: 1, importedAt: stamp, warnings: [], partial: false, latestReviewId: null, reviews: [], blocks: [{ id: 'block', ordinal: 0, kind: 'paragraph', text: 'SecretCompany987 paid 99999888. payment acceptance personal data ข้อมูลส่วนบุคคล。', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/p[1]', paragraphId: null } }] };
  const requests: string[] = [];
  const reader: OfficialPageReader = async url => { requests.push(url); return url.includes('search2.html') ? catalog : article; };
  const config = defaultRetrievalConfig(); config.knowledge.enabled = true; config.knowledge.folderPath = dir;
  config.official = { enabled: true, maxCatalogPages: 1, sourceUrls: [] };
  const bundle = await retrieveContext(document, context, config, { knowledgeApiKey: null, webApiKey: null }, new AbortController().signal, () => {}, undefined, reader);
  assert.equal(bundle.knowledgeStatus, 'complete'); assert.equal(bundle.officialStatus, 'partial'); assert.equal(bundle.searchStatus, 'user_disabled');
  assert.ok(bundle.evidence.some(source => source.channel === 'knowledge'));
  const source = bundle.evidence.find(source => source.officialMetadata);
  assert.ok(source); assert.equal(source.officialMetadata?.discoveredVia, 'catalog'); assert.equal(source.currentness, 'unknown'); assert.equal(source.effectiveAt, '2026-11-01');
  assert.equal(bundle.attempts.find(attempt => attempt.provider === 'official_catalog')?.coverage?.catalogPagesRead, 1);
  assert.deepEqual(requests, ['https://xzfg.moj.gov.cn/search2.html', 'https://xzfg.moj.gov.cn/front/law/detail?LawID=100']);
  assert.ok(!JSON.stringify(bundle.attempts).includes('SecretCompany987')); assert.ok(!JSON.stringify(requests).includes('99999888'));
});

test('独立官方测试只读保存的官方范围，不创建合同、审核或模型请求', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'law-official-service-')); await mkdir(join(dir, 'data'));
  const store = await AppStore.open(join(dir, 'data')); const calls: string[] = [];
  const service = new ContractService(store, join(dir, 'data'), () => {}, undefined, async url => { calls.push(url); return url.includes('search2.html') ? catalog : article; });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const config = defaultRetrievalConfig(); config.official = { enabled: true, maxCatalogPages: 1, sourceUrls: [] };
  config.knowledge.api = { ...config.knowledge.api, enabled: true, baseUrl: 'http://127.0.0.1:9', collectionId: 'untouched' };
  config.web.baseUrl = 'http://127.0.0.1:9/search';
  await service.saveRetrievalConfig(config);
  const result = await service.testOfficialRetrieval({ query: '网络、数据' });
  assert.equal(result.evidence.length, 1); assert.equal(calls.length, 2);
  for (const table of ['contracts', 'analysis_runs', 'retrieval_attempts', 'evidence', 'reports']) assert.equal(store.rows(`SELECT * FROM ${table}`).length, 0);
  assert.equal(service.getState().retrievalConfig?.knowledge.api.collectionId, 'untouched');
  await assert.rejects(service.testOfficialRetrieval({ query: '\u0000' }), /关键词/);
  assert.equal(calls.length, 2);
});

test('取消独立测试立即结束等待，不派发迟到请求或修改保存的配置', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'law-official-cancel-')); const store = await AppStore.open(dir);
  let requested!: () => void; const started = new Promise<void>(resolve => { requested = resolve; });
  let calls = 0;
  const service = new ContractService(store, dir, () => {}, undefined, async () => { calls++; requested(); return new Promise(() => {}); });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const config = defaultRetrievalConfig(); config.official = { enabled: true, maxCatalogPages: 3, sourceUrls: [] }; await service.saveRetrievalConfig(config);
  const pending = service.testOfficialRetrieval({ query: '数据' }); await started;
  await service.cancelOfficialRetrieval();
  const result = await pending; assert.equal(result.officialStatus, 'cancelled'); assert.equal(calls, 1);
  assert.equal(service.getState().retrievalConfig?.official?.maxCatalogPages, 3); assert.equal(store.rows('SELECT * FROM analysis_runs').length, 0);
});
