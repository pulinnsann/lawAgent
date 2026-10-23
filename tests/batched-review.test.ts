import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import type { ContractDetail, ModelConfigInput, RetrievalBundle, ReviewContext } from '../src/shared/contracts';
import { defaultRetrievalConfig } from '../src/shared/contracts';
import { defaultEnterpriseStandard } from '../src/shared/assurance';
import type { EnterpriseStandardSnapshot } from '../src/shared/assurance';
import { estimateReviewRequestSize, reviewContract } from '../src/core/review';
import { reviewWithBatches } from '../src/core/batched-review';

const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', businessContext: '', strictness: 'balanced', longContractMode: 'batch' };
function document(texts: string[]): ContractDetail { const id = randomUUID(); return { id, name: '虚构长合同', format: 'docx', language: 'zh', byteSize: 1, blockCount: texts.length, importedAt: '2026-01-01T00:00:00Z', warnings: [], partial: false, latestReviewId: null, reviews: [], blocks: texts.map((text, ordinal) => ({ id: randomUUID(), ordinal, kind: 'paragraph', text, locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: `/w:document[1]/w:body[1]/w:p[${ordinal + 1}]`, paragraphId: null } })) }; }
function config(url = 'http://127.0.0.1:9/v1'): ModelConfigInput { return { name: '合成工程模拟', baseUrl: url, model: 'synthetic', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 500, contextWindowTokens: 24000, timeoutSeconds: 5 }; }
const finding = (id: string, quote: string, title = '工程意见') => ({ blockIds: [id], quote, title, category: 'operational', severity: 'unrated', description: '纯工程测试，等待律师确认。', suggestion: '核对原文。', legalBasis: null, citations: [] });
async function mock(responder: (payload: any, call: number) => any) {
  const requests: any[] = [];
  const server = createServer(async (request, response) => { try { let raw = ''; for await (const piece of request) raw += piece; const body = JSON.parse(raw); const payload = JSON.parse(body.messages[1].content); requests.push({ payload, body }); const content = await responder(payload, requests.length); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ model: 'synthetic', usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] })); } catch (error) { response.statusCode = 500; response.end(String(error)); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('直接审核保留旧超限拒绝，分批需显式启用，64批预算超限在请求前拒绝', async () => {
  const doc = document(['长'.repeat(4000)]); const cfg = config(); cfg.contextWindowTokens = estimateReviewRequestSize({ ...doc, blocks: [] }, context, cfg) + 500;
  await assert.rejects(reviewContract(doc, context, cfg, null, 'model', new AbortController().signal, () => {}), (error: any) => error.code === 'CONTEXT_TOO_LONG');
  await assert.rejects(reviewWithBatches(doc, { ...context, longContractMode: 'reject' }, cfg, null, 'model', new AbortController().signal, () => {}), (error: any) => error.code === 'CONTEXT_TOO_LONG');
  const huge = document(['长'.repeat(40000)]);
  await assert.rejects(reviewWithBatches(huge, context, cfg, null, 'model', new AbortController().signal, () => {}), (error: any) => error.code === 'CONTEXT_TOO_LONG' && /64/u.test(error.message));
});

test('长合同连续切片覆盖全部中英泰及emoji，映射原ID，全局规则一次，综合原文与实际来源分别核验', async () => {
  const doc = document(['开头😀สัญญา。'.repeat(120) + '后段原文唯一标记', '付款安排及2025-02-30。' + '服务'.repeat(500), '保密内容仅在最后批，การบริการ。' + '条款'.repeat(400)]);
  const content = { ...defaultEnterpriseStandard(), name: '测试标准', rules: [{ key: 'confidentiality', name: '保密主题', enabled: true, kind: 'required_topic' as const, terms: ['保密'], category: 'operational' as const, severity: 'medium' as const, guidance: '' }] };
  const standard: EnterpriseStandardSnapshot = { id: randomUUID(), standardId: randomUUID(), versionNo: 1, content, contentSha256: createHash('sha256').update(JSON.stringify(content)).digest('hex'), publishedAt: '2026-01-01T00:00:00Z', publishedBy: '测试' };
  const retrieval: RetrievalBundle = { configSnapshot: defaultRetrievalConfig(), knowledgeStatus: 'complete', webStatus: 'not_configured', attempts: [], limitations: [], evidence: [{ id: randomUUID(), attemptId: randomUUID(), channel: 'knowledge', kind: 'company_policy', title: '虚构内部制度', sourceUri: null, locator: '第1条', excerpt: '内部制度摘录仅供工程验证。', excerptSha256: '0'.repeat(64), contentScope: 'fragment', retrievedAt: '2026-01-01T00:00:00Z', publishedAt: null, effectiveAt: null, currentness: 'unknown', isOfficial: false, warnings: [] }] };
  const fake = await mock((payload, call) => {
    if (payload.contractBlocks) { const first = payload.contractBlocks[0]; return { summary: `第${call}批工程摘要，不是合同原文。`, reviewedBlockIds: payload.contractBlocks.map((block: any) => block.id), findings: [finding(first.id, first.text.slice(0, 12)), ...(call === 1 ? [finding(first.id, '后段原文唯一标记', '未提供切片不能认领定位')] : [])] }; }
    const excerpt = payload.contractExcerpts[0]; return { summary: '各批工程意见已进行有限关联综合。', findings: [finding(excerpt.blockId, excerpt.text.slice(0, 10), '综合关联意见'), finding(excerpt.blockId, '第1批工程摘要，不是合同原文。', '摘要不能充当原文')] };
  });
  try {
    const cfg = config(fake.url); cfg.contextWindowTokens = estimateReviewRequestSize({ ...doc, blocks: [] }, context, cfg, standard, [], retrieval) + 1800;
    const result = await reviewWithBatches(doc, context, cfg, null, 'model', new AbortController().signal, () => {}, retrieval, standard);
    const batchRequests = fake.requests.filter(request => request.payload.contractBlocks); assert.ok(batchRequests.length > 1);
    const sentTexts = batchRequests.flatMap(request => request.payload.contractBlocks.map((block: any) => block.text)).join(''); assert.equal(sentTexts, doc.blocks.map(block => block.text).join(''));
    assert.ok(batchRequests.every(request => !/[\uD800-\uDBFF]$/u.test(request.payload.contractBlocks.at(-1).text))); assert.ok(batchRequests.every(request => !/^[\uDC00-\uDFFF]/u.test(request.payload.contractBlocks[0].text)));
    assert.deepEqual(result.coverage.reviewedBlockIds, doc.blocks.map(block => block.id)); assert.equal(result.batchCoverage!.batchCount, batchRequests.length);
    assert.equal(result.findings.filter(item => item.checkKey === 'dates.invalid_calendar_date').length, 1); assert.ok(!result.findings.some(item => item.origin === 'enterprise'));
    assert.ok(result.findings.every(item => item.blockIds.every(id => doc.blocks.some(block => block.id === id))));
    assert.equal(result.findings.find(item => item.title === '未提供切片不能认领定位')!.locationStatus, 'unmatched');
    const synthesis = fake.requests.find(request => request.payload.batchAnalyses);
    assert.ok(synthesis, '此测试必须实际执行跨批综合请求。');
    assert.equal(result.findings.find(item => item.title === '摘要不能充当原文')!.locationStatus, 'unmatched'); assert.equal(result.findings.find(item => item.title === '综合关联意见')!.locationStatus, 'matched');
    const sourceIds = [...new Set(fake.requests.flatMap(request => request.payload.sources?.map((source: any) => source.id) ?? []))]; assert.deepEqual(result.retrieval!.modelEvidenceIds!.sort(), sourceIds.sort());
    assert.equal(result.inputTokens, fake.requests.length * 100); assert.equal(result.outputTokens, fake.requests.length * 10);
    assert.deepEqual(result.standardSnapshot, standard); assert.equal(doc.blocks[0].text.endsWith('后段原文唯一标记'), true);
  } finally { await fake.close(); }
});

test('批次失败或取消不产出成功报告，不重试请求，不回退为不完整结果', async () => {
  const doc = document(['合同'.repeat(1500)]);
  const failure = await mock((payload, call) => call === 2 ? { bad: true } : { summary: '工程摘要。', reviewedBlockIds: payload.contractBlocks.map((block: any) => block.id), findings: [] });
  try { const cfg = config(failure.url); cfg.contextWindowTokens = estimateReviewRequestSize({ ...doc, blocks: [] }, context, cfg) + 1000; await assert.rejects(reviewWithBatches(doc, context, cfg, null, 'model', new AbortController().signal, () => {}), (error: any) => error.code === 'MODEL_OUTPUT_INVALID'); assert.equal(failure.requests.length, 2); } finally { await failure.close(); }
  const controller = new AbortController(); const cancellation = await mock(payload => { controller.abort(); return { summary: '工程摘要。', reviewedBlockIds: payload.contractBlocks.map((block: any) => block.id), findings: [] }; });
  try { const cfg = config(cancellation.url); cfg.contextWindowTokens = estimateReviewRequestSize({ ...doc, blocks: [] }, context, cfg) + 1000; await assert.rejects(reviewWithBatches(doc, context, cfg, null, 'model', controller.signal, () => {}), (error: any) => error.code === 'CANCELLED'); assert.equal(cancellation.requests.length, 1); } finally { await cancellation.close(); }
});

test('各批完整意见超出综合预算明确标记综合未完成，不额外发综合请求', async () => {
  const doc = document(['甲方委托服务。'.repeat(400)]); const fake = await mock(payload => ({ summary: '批次意见'.repeat(500), reviewedBlockIds: payload.contractBlocks.map((block: any) => block.id), findings: [] }));
  try { const cfg = config(fake.url); cfg.contextWindowTokens = estimateReviewRequestSize({ ...doc, blocks: [] }, context, cfg) + 900; const result = await reviewWithBatches(doc, context, cfg, null, 'model', new AbortController().signal, () => {}); assert.ok(result.batchCoverage!.batchCount > 1); assert.equal(result.batchCoverage!.crossBatchSynthesis, false); assert.ok(result.batchCoverage!.limitations.some(item => item.includes('综合未完成'))); assert.ok(fake.requests.every(request => request.payload.contractBlocks)); } finally { await fake.close(); }
});
