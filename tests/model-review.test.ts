import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { MAX_MODEL_RESPONSE_BYTES, ModelRequestError, testConnection, validateModelConfig } from '../src/core/model';
import { reviewContract } from '../src/core/review';
import type { ContractDetail, ModelConfigInput, ReviewContext } from '../src/shared/contracts';

const mockKey = 'mock-test-key-not-a-production-secret';
const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', businessContext: '购买技术服务', strictness: 'balanced' };
const document: ContractDetail = {
  id: 'contract-test', name: '中英泰服务合同', format: 'docx', language: 'mixed', byteSize: 1000,
  blockCount: 3, importedAt: '2026-10-22T00:00:00Z', warnings: [], partial: false,
  latestReviewId: null, reviews: [], blocks: [
    { id: 'block-zh', ordinal: 0, kind: 'paragraph', text: '甲方应在验收完成后支付服务费用。', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/p[1]', paragraphId: null } },
    { id: 'block-en', ordinal: 1, kind: 'paragraph', text: 'The supplier shall deliver the services within 30 days.', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/p[2]', paragraphId: null } },
    { id: 'block-th', ordinal: 2, kind: 'paragraph', text: 'คู่สัญญาตกลงชำระเงินภายในสามสิบวัน', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/p[3]', paragraphId: null } },
  ],
};

function config(baseUrl: string, overrides: Partial<ModelConfigInput> = {}): ModelConfigInput {
  return { name: '本机测试模型', baseUrl, model: 'mock-model', responseFormat: 'json_schema',
    tokenParameter: 'max_completion_tokens', maxOutputTokens: 2000, contextWindowTokens: 64000,
    timeoutSeconds: 2, ...overrides };
}

async function mockService(handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void | Promise<void>) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    await handler(request, response, body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    get requests() { return requests; },
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

function respond(response: ServerResponse, content: unknown, finishReason = 'stop') {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ model: 'mock-model-actual', choices: [{ finish_reason: finishReason,
    message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }],
  usage: { prompt_tokens: 123, completion_tokens: 45 } }));
}

function validReview() {
  return { summary: '需人工确认付款与责任安排。', reviewedBlockIds: document.blocks.map(block => block.id), findings: [{
    blockIds: ['block-zh'], quote: '验收完成后支付服务费用', title: '确认验收与付款衔接', category: 'commercial', severity: 'medium',
    description: '需要结合业务确认验收触发条件。', suggestion: '明确验收标准及确认流程。', legalBasis: null as string | null,
  }] };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof ModelRequestError && error.code === code;
}

test('Chat Completions 使用配置的协议、参数和认证，连接测试只发一次请求', async t => {
  const service = await mockService((request, response, body) => {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${mockKey}`);
    assert.equal(body.model, 'mock-model');
    assert.equal(body.max_completion_tokens, 256);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.stream, false);
    assert.equal((body.response_format as { type: string }).type, 'json_schema');
    assert.ok(!JSON.stringify(body).includes(mockKey));
    respond(response, { ok: true });
  });
  t.after(() => service.close());
  const result = await testConnection(config(service.baseUrl), mockKey);
  assert.equal(result.model, 'mock-model-actual');
  assert.ok(result.latencyMs >= 0);
  assert.match(result.message, /不代表/);
  assert.equal(service.requests, 1);
});

test('完整端点、json_object 与 max_tokens 设置原样生效', async t => {
  const service = await mockService((request, response, body) => {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(body.max_tokens, 256);
    assert.equal(body.max_completion_tokens, undefined);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    respond(response, { ok: true });
  });
  t.after(() => service.close());
  await testConnection(config(`${service.baseUrl}/chat/completions/`, { responseFormat: 'json_object', tokenParameter: 'max_tokens' }), null);
});

test('地址策略拒绝远端HTTP、userinfo、片段及凭据查询参数，验证返回不含密钥', () => {
  for (const baseUrl of ['http://example.com/v1', 'https://user:password@example.com/v1', 'https://example.com/v1#fragment', 'https://example.com/v1#', 'https://example.com/v1?api_key=private-value', 'https://example.com/v1?access_token=private-value']) {
    assert.throws(() => validateModelConfig(config(baseUrl)), error => {
      assert.ok(error instanceof ModelRequestError);
      assert.ok(!error.message.includes('private-value'));
      assert.ok(!error.message.includes('password@'));
      return error.code === 'VALIDATION_ERROR';
    });
  }
  const safe = validateModelConfig(config('http://127.0.0.1:8080/v1', { apiKey: mockKey, clearApiKey: true }));
  assert.equal(safe.apiKey, undefined);
  assert.equal(safe.clearApiKey, undefined);
  assert.equal(validateModelConfig(config('http://[::1]:8080/v1')).model, 'mock-model');
});

test('重定向不会转发认证或发起第二次请求', async t => {
  const service = await mockService((request, response) => {
    if (request.url?.includes('redirect-target')) { assert.fail('不得跟随重定向'); }
    response.writeHead(302, { location: '/redirect-target' });
    response.end('redirect body');
  });
  t.after(() => service.close());
  await assert.rejects(testConnection(config(service.baseUrl), mockKey), hasCode('MODEL_NETWORK_ERROR'));
  assert.equal(service.requests, 1);
});

test('HTTP错误不会泄露服务正文或密钥，也不自动重试', async t => {
  const service = await mockService((_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: `secret body ${mockKey}` }));
  });
  t.after(() => service.close());
  await assert.rejects(testConnection(config(service.baseUrl), mockKey), error => {
    assert.ok(error instanceof ModelRequestError);
    assert.equal(error.code, 'MODEL_HTTP_ERROR');
    assert.ok(!error.message.includes(mockKey));
    assert.ok(!error.message.includes('secret body'));
    return true;
  });
  assert.equal(service.requests, 1);
});

test('连接测试也校验最小JSON输出，不把任意响应当作结构化输出成功', async t => {
  const service = await mockService((_request, response) => { respond(response, 'not json'); });
  t.after(() => service.close());
  await assert.rejects(testConnection(config(service.baseUrl), null), hasCode('MODEL_OUTPUT_INVALID'));
  assert.equal(service.requests, 1);
});

test('取消中断已发出的模型请求', async t => {
  let markReceived!: () => void;
  const received = new Promise<void>(resolve => { markReceived = resolve; });
  const service = await mockService(() => { markReceived(); });
  t.after(() => service.close());
  const controller = new AbortController();
  const pending = testConnection(config(service.baseUrl), mockKey, controller.signal);
  await received;
  controller.abort();
  await assert.rejects(pending, error => error instanceof ModelRequestError && error.name === 'AbortError' && error.code === 'CANCELLED');
  assert.equal(service.requests, 1);
});

test('超时结束等待且不自动重试', async t => {
  const service = await mockService(() => undefined);
  t.after(() => service.close());
  // Allow connection dispatch under parallel native-build/test load; the
  // fixture deliberately never responds, so this still exercises an actual
  // in-flight request timeout and proves it is not retried.
  await assert.rejects(testConnection(config(service.baseUrl, { timeoutSeconds: 1 }), null), hasCode('TIMEOUT'));
  assert.equal(service.requests, 1);
});

test('限制响应大小，包括没有Content-Length的流式响应', async t => {
  const service = await mockService((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.write(' ');
    response.end('x'.repeat(MAX_MODEL_RESPONSE_BYTES + 1));
  });
  t.after(() => service.close());
  await assert.rejects(testConnection(config(service.baseUrl), null), hasCode('RESPONSE_TOO_LARGE'));
});

test('模型审核保留三语全部块、实际用量、未接入检索与未核实法条状态', async t => {
  const stages: string[] = [];
  const service = await mockService((_request, response, body) => {
    const messages = body.messages as Array<{ role: string; content: string }>;
    const data = JSON.parse(messages[1].content) as { contractBlocks: Array<{ id: string; text: string }> };
    assert.deepEqual(data.contractBlocks.map(block => block.id), document.blocks.map(block => block.id));
    assert.ok(data.contractBlocks[2].text.includes('คู่สัญญา'));
    assert.match(messages[0].content, /待分析数据/);
    assert.match(messages[0].content, /合同示范文本\(contract_template\)仅可参考结构/);
    assert.match(messages[0].content, /发布日期或施行日期晚于审核日期/);
    assert.equal(body.tools, undefined);
    const result = validReview();
    result.findings[0].legalBasis = '模型提供的法律线索';
    respond(response, result);
  });
  t.after(() => service.close());
  const result = await reviewContract(document, context, config(service.baseUrl), mockKey, 'model', new AbortController().signal, stage => stages.push(stage));
  assert.equal(result.mode, 'model');
  assert.equal(result.modelId, 'mock-model-actual');
  assert.deepEqual(result.coverage.reviewedBlockIds, document.blocks.map(block => block.id));
  assert.equal(result.coverage.knowledgeStatus, 'not_configured');
  assert.equal(result.coverage.webStatus, 'not_configured');
  assert.equal(result.findings[0].locationStatus, 'matched');
  assert.equal(result.findings[0].basisStatus, 'unverified');
  assert.equal(result.inputTokens, 123);
  assert.equal(result.outputTokens, 45);
  assert.ok(stages.length > 1);
});

test('伪造块ID或不匹配引文降为unmatched并保留人工核实限制', async t => {
  const service = await mockService((_request, response) => {
    const result = validReview();
    result.findings[0].blockIds = ['forged-block'];
    result.findings[0].quote = '这段原文根本不存在';
    respond(response, result);
  });
  t.after(() => service.close());
  const result = await reviewContract(document, context, config(service.baseUrl), null, 'model', new AbortController().signal, () => undefined);
  assert.equal(result.findings[0].locationStatus, 'unmatched');
  assert.deepEqual(result.findings[0].blockIds, []);
  assert.ok(result.coverage.limitations.some(value => value.includes('未能与原文定位')));
});

test('模型覆盖遗漏会阻断，不能用完整发送范围冒充完整模型覆盖', async t => {
  const service = await mockService((_request, response) => {
    const result = validReview();
    result.reviewedBlockIds = ['block-zh'];
    respond(response, result);
  });
  t.after(() => service.close());
  await assert.rejects(reviewContract(document, context, config(service.baseUrl), null, 'model', new AbortController().signal, () => undefined), hasCode('MODEL_COVERAGE_INCOMPLETE'));
});

test('无效JSON及越界风险枚举不落为成功，不偷偷回退或重试', async t => {
  for (const content of ['not json', { ...validReview(), findings: [{ ...validReview().findings[0], severity: 'critical' }] }]) {
    const service = await mockService((_request, response) => { respond(response, content); });
    t.after(() => service.close());
    await assert.rejects(reviewContract(document, context, config(service.baseUrl), null, 'model', new AbortController().signal, () => undefined), hasCode('MODEL_OUTPUT_INVALID'));
    assert.equal(service.requests, 1);
  }
});

test('text配置不发送response_format，仍验证模型结构', async t => {
  const service = await mockService((_request, response, body) => {
    assert.equal(body.response_format, undefined);
    respond(response, '```json\n' + JSON.stringify(validReview()) + '\n```');
  });
  t.after(() => service.close());
  const result = await reviewContract(document, context, config(service.baseUrl, { responseFormat: 'text' }), null, 'model', new AbortController().signal, () => undefined);
  assert.equal(result.findings[0].locationStatus, 'matched');
});

test('过长合同在调用前阻断，不静默截断或产生付费请求', async t => {
  const service = await mockService((_request, response) => { respond(response, validReview()); });
  t.after(() => service.close());
  const largeDocument = { ...document, blocks: [{ ...document.blocks[0], text: '超长合同'.repeat(10000) }] };
  await assert.rejects(reviewContract(largeDocument, context, config(service.baseUrl, { contextWindowTokens: 4096, maxOutputTokens: 1000 }), null, 'model', new AbortController().signal, () => undefined), hasCode('CONTEXT_TOO_LONG'));
  assert.equal(service.requests, 0);
});

test('本地模式明确为关键词提示，覆盖全部块且不声称法律分析已核实', async () => {
  const result = await reviewContract({ ...document, partial: true, warnings: ['有未处理扫描页'] }, context, null, null, 'local', new AbortController().signal, () => undefined);
  assert.equal(result.mode, 'local');
  assert.equal(result.modelId, null);
  assert.equal(result.inputTokens, null);
  assert.match(result.summary, /不构成法律审核结论/);
  assert.deepEqual(result.coverage.reviewedBlockIds, document.blocks.map(block => block.id));
  assert.ok(result.findings.length > 0);
  assert.ok(result.findings.every(finding => finding.category === 'operational' && finding.severity === 'unrated' && finding.source === 'rule' && finding.basisStatus === 'unverified'));
  assert.ok(result.coverage.limitations.some(value => value.includes('解析不完整')));
});

test('预先取消的本地审核直接结束', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reviewContract(document, context, null, null, 'local', controller.signal, () => undefined), hasCode('CANCELLED'));
});
