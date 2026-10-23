import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { reviewContract } from '../src/core/review';
import { defaultRetrievalConfig, type ContractDetail, type RetrievalBundle, type SourceEvidence } from '../src/shared/contracts';

const document: ContractDetail = {
  id: randomUUID(), name: '虚构服务合同', format: 'docx', language: 'zh', byteSize: 100,
  blockCount: 1, importedAt: new Date().toISOString(), warnings: [], partial: false, latestReviewId: null, reviews: [],
  blocks: [{ id: randomUUID(), ordinal: 0, kind: 'paragraph', text: '乙方完成服务即视为验收合格。', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/p[1]', paragraphId: null } }],
};
const context = { contractType: 'service' as const, ourPartyRole: 'service_recipient' as const, strictness: 'balanced' as const, businessContext: '虚构集成检查' };
function source(scope: SourceEvidence['contentScope'] = 'fragment', excerpt = '内部制度要求业务部门书面确认验收结果。'): SourceEvidence {
  return { id: randomUUID(), attemptId: randomUUID(), channel: scope === 'search_snippet' ? 'web' : 'knowledge', kind: 'company_policy', title: '虚构制度材料', sourceUri: null, locator: '第1段', excerpt, excerptSha256: createHash('sha256').update(excerpt).digest('hex'), contentScope: scope, retrievedAt: new Date().toISOString(), publishedAt: null, effectiveAt: null, currentness: 'unknown', isOfficial: false, warnings: [] };
}
function bundle(evidence: SourceEvidence[]): RetrievalBundle {
  return { configSnapshot: defaultRetrievalConfig(), attempts: [], evidence, knowledgeStatus: 'complete', webStatus: 'partial', limitations: ['合成来源仅用于工程检查。'] };
}
function finding(citations: Array<{evidenceId:string;quote:string}>) {
  return { blockIds: [document.blocks[0].id], quote: document.blocks[0].text, title: '验收条件需复核', category: 'commercial', severity: 'medium', description: '请结合履约事实确认。', suggestion: '明确书面验收程序。', legalBasis: '内部材料不自动等同法律强制义务。', citations };
}
async function run(evidence: SourceEvidence[], respond: (payload: any) => unknown[], contextWindowTokens = 64000) {
  let payload: any;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    payload = JSON.parse(JSON.parse(body).messages[1].content);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ model: 'citation-test', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '工程检查。', reviewedBlockIds: payload.contractBlocks.map((block: any) => block.id), findings: respond(payload) }) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const review = await reviewContract(document, context, { name: '工程检查', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'citation-test', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 1000, contextWindowTokens, timeoutSeconds: 2 }, null, 'model', new AbortController().signal, () => {}, bundle(evidence));
    return { review, payload };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('引用只能绑定本次真实来源，逐字校验；摘要匹配不代表原文或法律核验', async () => {
  const policy = source(); const snippet = source('search_snippet', '搜索摘要提示需核实验收约定。');
  const { review } = await run([policy, snippet], () => [
    finding([{ evidenceId: policy.id, quote: '业务部门书面确认验收结果' }]),
    finding([{ evidenceId: snippet.id, quote: '搜索摘要提示' }]),
    finding([{ evidenceId: randomUUID(), quote: '伪造出处' }]),
    finding([{ evidenceId: policy.id, quote: '原文不存在的结论' }]),
    finding([{ evidenceId: policy.id, quote: '   ' }]),
  ]);
  assert.equal(review.findings[0].basisStatus, 'source_matched');
  assert.equal(review.findings[0].citations?.[0].matchStatus, 'matched');
  assert.equal(review.findings[1].basisStatus, 'unverified');
  assert.equal(review.findings[1].citations?.[0].matchStatus, 'matched');
  assert.deepEqual(review.findings[2].citations, []);
  assert.equal(review.findings[3].citations?.[0].matchStatus, 'unmatched');
  assert.equal(review.findings[4].citations?.[0].matchStatus, 'unmatched');
  assert.equal(review.retrieval?.evidence[0].currentness, 'unknown');
  assert.equal(review.coverage.knowledgeStatus, 'complete');
  assert.equal(review.coverage.webStatus, 'partial');
  assert.ok(review.coverage.limitations.some(text => text.includes('无效来源编号已移除')));
  assert.ok(review.coverage.limitations.some(text => text.includes('不代表效力')));
});

test('来源预算不截断合同，未发给模型的材料保留审计且不能伪造为模型引用', async () => {
  const evidence = Array.from({ length: 20 }, () => source('fragment', '需要业务部门书面验收。'.repeat(1000)));
  const withheld = evidence[19];
  const { review, payload } = await run(evidence, () => [finding([{ evidenceId: withheld.id, quote: '需要业务部门书面验收。' }])], 16000);
  assert.deepEqual(payload.contractBlocks, document.blocks.map(block => ({ id: block.id, text: block.text })));
  assert.equal(review.retrieval?.evidence.length, 20);
  assert.ok(review.retrieval!.modelEvidenceIds!.length > 0);
  assert.ok(review.retrieval!.modelEvidenceIds!.length <= 12);
  assert.ok(!review.retrieval!.modelEvidenceIds!.includes(withheld.id));
  assert.deepEqual(review.findings[0].citations, []);
  assert.deepEqual(review.retrieval?.modelEvidenceIds, payload.sources.map((item: any) => item.id));
  assert.ok(review.coverage.limitations.some(text => text.includes('未作为本次模型分析输入')));
});

test('来源存在也不会给没有引用的模型结论自动背书', async () => {
  const { review } = await run([source()], () => [finding([])]);
  assert.equal(review.findings[0].basisStatus, 'unverified');
  assert.deepEqual(review.findings[0].citations, []);
  assert.ok(review.coverage.limitations.some(text => text.includes('没有关联可回溯来源')));
});

test('只校验实际发给模型的连续摘录，持久候选尾部的原文也不能冒充本次模型引用', async () => {
  const beginning = '验收应经业务部门书面确认。';
  const tail = '这是已保存但没有提供给模型的尾部条款。';
  const evidence = source('full_text', beginning.repeat(400) + tail);
  const { review, payload } = await run([evidence], () => [
    finding([{ evidenceId: evidence.id, quote: beginning }]),
    finding([{ evidenceId: evidence.id, quote: tail }]),
  ]);
  assert.ok(!payload.sources[0].excerpt.includes(tail));
  assert.equal(payload.sources[0].contentScope, 'fragment');
  assert.equal(payload.sources[0].excerpt, evidence.excerpt.slice(0, payload.sources[0].excerpt.length));
  assert.equal(review.findings[0].citations?.[0].matchStatus, 'matched');
  assert.equal(review.findings[1].citations?.[0].matchStatus, 'unmatched');
  assert.equal(review.findings[1].basisStatus, 'unverified');
  assert.ok(review.retrieval?.evidence[0].excerpt.endsWith(tail));
});
