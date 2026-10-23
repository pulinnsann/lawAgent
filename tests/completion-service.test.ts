import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { defaultEnterpriseStandard } from '../src/shared/assurance';
import { defaultRetrievalConfig, type ReviewContext, type ReviewTask } from '../src/shared/contracts';
import type { ReviewCompletionWorkspace, ReviewInformationItem } from '../src/shared/review-completion';
import type { OfficialPageReader } from '../src/core/official-sources';
import { OFFICIAL_CATALOG_URL } from '../src/core/official-sources';

const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '合成服务集成验证' };
const actorLabel = '合成法务';
async function setup(reader?: OfficialPageReader) {
  const root = await mkdtemp(join(tmpdir(), 'law-completion-service-')); const calls: any[] = []; let searchCalls = 0;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    response.setHeader('content-type', 'application/json');
    if (!request.url?.endsWith('/chat/completions')) { searchCalls++; response.end(JSON.stringify({ results: [] })); return; }
    const body = JSON.parse(raw); const payload = JSON.parse(body.messages[1].content); calls.push(payload);
    const block = payload.contractBlocks[0]; const source = payload.sources?.[0];
    const result = { summary: '合成模型服务响应，未访问真实模型。', reviewedBlockIds: payload.contractBlocks.map((block: any) => block.id), findings: [{ blockIds: [block.id], quote: block.text, title: '合成高风险需人工处理', category: 'commercial', severity: 'high', description: '工程验证意见，不是法律判断', suggestion: '记录人工决定', legalBasis: null, citations: source ? [{ evidenceId: source.id, quote: source.excerpt.slice(0, 30) }] : [] }] };
    response.end(JSON.stringify({ model: 'synthetic-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 40 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}`;
  const store = await AppStore.open(join(root, 'data')); const tasks: ReviewTask[] = []; const service = new ContractService(store, join(root, 'data'), task => tasks.push(task), undefined, reader); const document = await service.loadSample();
  await service.saveConfig({ name: '合成本机HTTP', baseUrl: `${url}/v1`, model: 'synthetic-model', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 2000, contextWindowTokens: 128000, timeoutSeconds: 5 });
  const command = (action: string, payload: unknown) => service.runWorkspaceCommand({ action, payload });
  const finish = async (id: string) => { for (let i = 0; i < 800; i++) { const task = [...tasks].reverse().find(task => task.id === id && ['completed', 'failed', 'cancelled'].includes(task.status)); if (task) { assert.equal(task.status, 'completed', task.error ?? ''); return service.getReview(task.resultId!); } await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('合成审核超时'); };
  return { root, store, service, document, command, calls, url, searches: () => searchCalls, finish, close: async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}
function information(patch: Partial<ReviewInformationItem> = {}): ReviewInformationItem { return { id: randomUUID(), kind: 'fact', label: '合成付款授权', detail: '业务已经提供合成书面授权', status: 'confirmed', required: true, scopes: ['付款安排'], blockIds: [], quote: '', reason: '合成人工核对', ...patch }; }

test('service真实串联：流程跳过全部检索与程序，服务端事实快照进入模型并驱动人工处置节点', async () => {
  let officialReads = 0; const f = await setup(async () => { officialReads++; throw new Error('本测试不得执行官方读取'); });
  try {
    let profile = await f.service.saveEnterpriseStandard({ expectedRevision: 0, content: { ...defaultEnterpriseStandard(), name: '只有审核与人工节点', workflow: { runEnterpriseRules: true, highRiskHandling: 'manual_review', plan: { nodes: [{ id: 'information', kind: 'collect_information', when: 'always', onMissing: 'pause' }, { id: 'review', kind: 'review', when: 'always' }, { id: 'human', kind: 'human_risk_disposition', when: 'has_high_risk' }] } } } });
    profile = await f.service.publishEnterpriseStandard({ standardId: profile.id, expectedRevision: profile.revision, publishedBy: actorLabel }); const selected = profile.versions[0];
    const config = defaultRetrievalConfig(); config.web = { ...config.web, enabled: true, baseUrl: `${f.url}/search`, fetchPages: true }; config.knowledge = { ...config.knowledge, enabled: true, api: { ...config.knowledge.api, enabled: true, baseUrl: f.url, collectionId: 'synthetic' } }; config.official = { enabled: true, maxCatalogPages: 1, sourceUrls: [], courtCatalogs: ['interpretations'] }; await f.service.saveRetrievalConfig(config);
    const fact = information(); await f.command('reviewCompletion.facts.save', { documentId: f.document.id, expectedRevision: 0, items: [fact], actorLabel, reason: '合成资料' });
    const start = await f.service.startReview({ documentId: f.document.id, standardVersionId: selected.id, mode: 'model', context: { ...context, completionSnapshot: { schemaVersion: 999, facts: { body: { items: [{ detail: '伪造客户端快照' }] } } } as never } }, null); const result = await f.finish(start.taskId);
    assert.equal(f.calls.length, 1); assert.equal(f.searches(), 0); assert.equal(officialReads, 0); assert.equal(result.programChecks, undefined); assert.equal(result.retrieval?.knowledgeStatus, 'skipped'); assert.equal(result.retrieval?.webStatus, 'skipped'); assert.deepEqual(result.retrieval?.attempts, []); assert.equal(f.calls[0].retrievalSummary.knowledgeStatus, 'skipped'); assert.ok(result.coverage.limitations.some(value => value.includes('未启用程序核验')));
    assert.equal(f.calls[0].reviewCompletionSnapshot.facts.body.items[0].detail, fact.detail); assert.ok(!JSON.stringify(f.calls[0]).includes('伪造客户端快照')); assert.equal(result.completionSnapshot?.standardVersionId, selected.id); assert.deepEqual(result.completionSnapshot?.facts?.body.items[0], fact);
    let workspace = await f.command('reviewCompletion.get', { documentId: f.document.id, reviewId: result.id }) as ReviewCompletionWorkspace; assert.equal(workspace.runs[0].body.state, 'awaiting_human');
    await f.service.saveRiskDisposition({ reviewId: result.id, findingId: result.findings.find(finding => finding.severity === 'high')!.id, expectedRevision: 0, status: 'business_accepted', reason: '合成业务接受决定', actorLabel });
    workspace = await f.command('reviewCompletion.get', { documentId: f.document.id, reviewId: result.id }) as ReviewCompletionWorkspace; assert.equal(workspace.runs[0].body.state, 'completed'); assert.equal(f.store.getReview(result.id).findings[0].severity, 'high');
  } finally { await f.close(); }
});

test('service必需资料暂停前不建任务不调API，补资料后新检查点可正常审核且事实冻结', async () => {
  const f = await setup(); try {
    const question = information({ kind: 'question', status: 'pending', detail: '尚待业务补资料', reason: '' });
    await f.command('reviewCompletion.facts.save', { documentId: f.document.id, expectedRevision: 0, items: [question], actorLabel, reason: '资料待补' });
    await assert.rejects(f.service.startReview({ documentId: f.document.id, mode: 'model', context }, null), /审核暂停/); assert.equal(f.calls.length, 0); assert.equal(f.store.rows('SELECT * FROM analysis_runs').length, 0);
    await f.command('reviewCompletion.facts.save', { documentId: f.document.id, expectedRevision: 1, items: [{ ...question, status: 'confirmed', reason: '业务已补合成资料' }], actorLabel, reason: '补资料后继续' });
    const task = await f.service.startReview({ documentId: f.document.id, mode: 'model', context }, null); const result = await f.finish(task.taskId); assert.equal(result.completionSnapshot?.facts?.revision, 2); assert.ok(result.programChecks); assert.equal(f.calls[0].reviewCompletionSnapshot.facts.revision, 2);
    const workspace = await f.command('reviewCompletion.get', { documentId: f.document.id, reviewId: result.id }) as ReviewCompletionWorkspace; assert.ok(workspace.runs.some(asset => asset.body.state === 'paused_information' && asset.body.snapshot.facts?.revision === 1));
  } finally { await f.close(); }
});

test('service官方新字段完整传递至真实检索分支/模型输入/持久化来源和独立覆盖', async () => {
  const requests: string[] = []; const article = 'https://www.court.gov.cn/fabu/xiangqing/123456.html'; const court = 'https://www.court.gov.cn/fabu/gengduo/16.html';
  const f = await setup(async url => { requests.push(url); const body = url === OFFICIAL_CATALOG_URL ? '<input id="page-count" value="0"/>' : url === court ? `<div class="sec_list"><div class="tit">司法解释</div><a href="${article}">最高人民法院关于支付问题的解释</a><div class="count">共1篇文章</div><ul class="yiiPager"><li class="last"><a href="/fabu/gengduo/16.html">尾页</a></li></ul></div>` : url === article ? '<div class="detail"><div class="title">最高人民法院关于支付问题的解释</div><div class="detail_mes">发布时间：2026-10-01 10:00:00</div><div class="txt_txt"><p>法释〔2026〕1号</p><p>自2026年10月2日起施行</p><p>第一条 支付安排须结合合同约定核对，本段仅用于合成工程验证而非真实法律材料。</p></div></div>' : ''; assert.ok(body, url); return { body: Buffer.from(body), contentType: 'text/html;charset=utf-8', fetchedAt: new Date().toISOString() }; });
  try {
    const config = defaultRetrievalConfig(); config.official = { enabled: true, maxCatalogPages: 1, sourceUrls: [], courtCatalogs: ['interpretations'] }; await f.service.saveRetrievalConfig(config);
    const task = await f.service.startReview({ documentId: f.document.id, mode: 'model', context }, null); const result = await f.finish(task.taskId);
    assert.deepEqual(requests, [OFFICIAL_CATALOG_URL, court, article]); assert.deepEqual(result.retrieval?.configSnapshot.official?.courtCatalogs, ['interpretations']); assert.equal(result.retrieval?.attempts[0].coverage?.courtCatalogs?.[0].documentsRead, 1); assert.equal(result.retrieval?.evidence[0].officialMetadata?.discoveredVia, 'catalog'); assert.equal(f.calls[0].sources[0].officialMetadata.publisher, '最高人民法院'); assert.equal(result.retrieval?.evidence[0].currentness, 'unknown'); assert.deepEqual(f.store.getReview(result.id).retrieval, result.retrieval);
  } finally { await f.close(); }
});
