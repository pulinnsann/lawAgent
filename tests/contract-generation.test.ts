import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';
import { buildGeneratedContractDocx, generateContractDraft, normalizeGenerateContractInput } from '../src/core/contract-generation';
import { inspectDocxTargets } from '../src/core/docx-patcher';
import { parseDocx } from '../src/core/documents';
import { ModelRequestError } from '../src/core/model';
import type { ModelConfigInput } from '../src/shared/contracts';
import type { ContractDraft, GenerateContractInput } from '../src/shared/generation';

const input: GenerateContractInput = { requestId: randomUUID(), language: 'zh', description: '起草技术维护服务合同，我方是服务接受方，主体名称、金额和期限尚未确定。', contractType: 'service', ourPartyRole: 'service_recipient' };
const generated = () => ({ title: '技术维护服务合同', clauses: [
  { heading: '第一条 合同主体与服务范围', paragraphs: ['甲方：[待填写：甲方名称]。乙方：[待填写：乙方名称]。', '乙方向甲方提供[待确认：维护范围及交付成果]。'] },
  { heading: '第二条 费用与签署', paragraphs: ['服务费用：[待确认：金额及币种]。付款安排：[待确认：付款条件]。', '甲乙双方签署日期：[待填写：签署日期]。'] },
], missingInformation: ['双方名称、服务范围、费用与履行期限。'], warnings: ['验收条件和责任安排须由双方确认。'] });
function config(baseUrl: string, extra: Partial<ModelConfigInput> = {}): ModelConfigInput {
  return { name: '生成测试', baseUrl, model: 'mock-contract-model', responseFormat: 'json_schema', tokenParameter: 'max_completion_tokens', maxOutputTokens: 4096, contextWindowTokens: 64000, timeoutSeconds: 2, ...extra };
}
const hasCode = (code: string) => (error: unknown) => error instanceof ModelRequestError && error.code === code;
async function mockService(handler: (body: Record<string, unknown>, response: ServerResponse) => void | Promise<void>) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++; let raw = '';
    for await (const chunk of request) raw += chunk;
    await handler(JSON.parse(raw), response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, get requests() { return requests; },
    async close() { const done = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await done; },
  };
}
function respond(response: ServerResponse, content: unknown, finishReason = 'stop') {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ model: 'actual-generation-model', choices: [{ finish_reason: finishReason, message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 123, completion_tokens: 234 } }));
}
function draft(language: GenerateContractInput['language'] = 'zh'): ContractDraft {
  const texts = { zh: ['合同草稿', '服务范围', '双方约定的服务范围为[待填写]。'], en: ['Contract draft', 'Scope of services', 'The agreed scope of services is [to be completed].'], th: ['ร่างสัญญา', 'ขอบเขตการให้บริการ', 'คู่สัญญาตกลงขอบเขตการให้บริการดังต่อไปนี้ [รอกรอกข้อมูล]'] }[language];
  return { id: input.requestId, request: { ...input, language }, language, title: texts[0], clauses: [{ heading: texts[1], paragraphs: [texts[2]] }], missingInformation: [], warnings: [], modelId: 'mock', createdAt: '2026-10-23T00:00:00.000Z', inputTokens: null, outputTokens: null };
}

test('合同需求严格校验且保留明确交易描述，非法输入不会规范化成可发送请求', () => {
  assert.deepEqual(normalizeGenerateContractInput({ ...input, description: `  ${input.description}\n\t` }), input);
  for (const value of [null, { ...input, extra: 'ignored?' }, { ...input, requestId: 'bad' }, { ...input, description: '太短' }, { ...input, description: 'a'.repeat(12001) }, { ...input, description: `${input.description}\u0000` }, { ...input, description: `${input.description}\ud800` }, { ...input, language: 'de' }, { ...input, contractType: 'lease' }, { ...input, ourPartyRole: 'unknown' }]) assert.throws(() => normalizeGenerateContractInput(value), hasCode('VALIDATION_ERROR'));
});

test('单次描述生成携带完整需求与严格schema，固定披露未检索和法务复核状态', async t => {
  const service = await mockService((body, response) => {
    const messages = body.messages as Array<{ role: string; content: string }>;
    const sent = JSON.parse(messages[1].content);
    assert.equal(sent.description, input.description); assert.equal(sent.language, 'zh'); assert.equal(sent.ourPartyRole, input.ourPartyRole);
    assert.equal(sent.jurisdiction, '中国大陆法律');
    assert.match(messages[0].content, /不得编造/); assert.match(messages[0].content, /不可信/); assert.match(messages[0].content, /不得运行工具/);
    assert.equal(body.tools, undefined); assert.equal(body.stream, false);
    const format = body.response_format as { json_schema: { strict: boolean; name: string; schema: { additionalProperties: boolean } } };
    assert.equal(format.json_schema.strict, true); assert.equal(format.json_schema.name, 'contract_generation_draft'); assert.equal(format.json_schema.schema.additionalProperties, false);
    respond(response, generated());
  });
  t.after(() => service.close());
  const result = await generateContractDraft(input, config(service.baseUrl), 'mock-key', new AbortController().signal);
  assert.equal(result.id, input.requestId); assert.deepEqual(result.request, input); assert.equal(result.modelId, 'actual-generation-model');
  assert.equal(result.inputTokens, 123); assert.equal(result.outputTokens, 234); assert.ok(Number.isFinite(Date.parse(result.createdAt)));
  assert.deepEqual(result.clauses, generated().clauses); assert.deepEqual(result.missingInformation, generated().missingInformation);
  assert.ok(result.warnings.some(item => item.includes('未检索'))); assert.ok(result.warnings.some(item => item.includes('法务复核')));
  assert.equal(service.requests, 1);
});

test('上下文、输出预算与预先取消在发请求前被阻断', async t => {
  const service = await mockService((_body, response) => respond(response, generated()));
  t.after(() => service.close());
  await assert.rejects(generateContractDraft(input, config(service.baseUrl, { maxOutputTokens: 512 }), null, new AbortController().signal), hasCode('OUTPUT_BUDGET_TOO_SMALL'));
  await assert.rejects(generateContractDraft(input, config(service.baseUrl, { contextWindowTokens: 5000 }), null, new AbortController().signal), hasCode('CONTEXT_TOO_LONG'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generateContractDraft(input, config(service.baseUrl), null, controller.signal), hasCode('CANCELLED'));
  assert.equal(service.requests, 0);
});

test('无效结构、XML非法字符、过多段落、超长正文与截断输出均拒绝，不重试', async t => {
  const malformed = generated(); malformed.clauses[0].paragraphs[0] = 'invalid\u0000text';
  const many = generated(); many.clauses = Array.from({ length: 20 }, (_, index) => ({ heading: `第${index}条`, paragraphs: Array(21).fill('待确认事项') }));
  const large = generated(); large.clauses = Array.from({ length: 20 }, (_, index) => ({ heading: `第${index}条`, paragraphs: ['字'.repeat(5500)] }));
  const outputs: unknown[] = ['not JSON', { ...generated(), extra: 'unexpected' }, { ...generated(), clauses: [] }, malformed, many, large];
  let position = 0;
  const service = await mockService((_body, response) => respond(response, outputs[position++]));
  t.after(() => service.close());
  for (const _output of outputs) await assert.rejects(generateContractDraft(input, config(service.baseUrl), null, new AbortController().signal), hasCode('MODEL_OUTPUT_INVALID'));
  assert.equal(service.requests, outputs.length);
  const truncated = await mockService((_body, response) => respond(response, generated(), 'length')); t.after(() => truncated.close());
  await assert.rejects(generateContractDraft(input, config(truncated.baseUrl), null, new AbortController().signal), hasCode('MODEL_OUTPUT_TRUNCATED'));
  assert.equal(truncated.requests, 1);
});

test('合同生成取消与超时结束等待，不产生可保存的草稿或自动重试', async t => {
  let arrived!: () => void; const received = new Promise<void>(resolve => { arrived = resolve; });
  const service = await mockService(() => { arrived(); }); t.after(() => service.close());
  const controller = new AbortController(); const pending = generateContractDraft(input, config(service.baseUrl), null, controller.signal);
  await received; controller.abort(); await assert.rejects(pending, hasCode('CANCELLED'));
  await assert.rejects(generateContractDraft(input, config(service.baseUrl, { timeoutSeconds: 0.05 }), null, new AbortController().signal), hasCode('TIMEOUT'));
  assert.equal(service.requests, 2);
});

test('中英泰DOCX正文、附录与黑色样式可回读，模型文本被转义而非执行OOXML', async () => {
  for (const language of ['zh', 'en', 'th'] as const) {
    const source = draft(language);
    source.clauses[0].paragraphs.push('A & B <w:ins w:author="evil">literal</w:ins>');
    const bytes = await buildGeneratedContractDocx(source); const parsed = await parseDocx(bytes);
    assert.equal(parsed.partial, false); assert.equal(parsed.blocks[0].text, source.title);
    assert.equal(parsed.blocks[3].text, source.clauses[0].paragraphs[1]);
    assert.ok(parsed.blocks.length >= 10);
    const targets = await inspectDocxTargets(bytes); assert.ok(targets.every(target => target.editable));
    const zip = await JSZip.loadAsync(bytes); const documentXml = await zip.file('word/document.xml')!.async('string');
    assert.ok(documentXml.includes('&lt;w:ins')); assert.ok(!documentXml.includes('<w:ins'));
    assert.ok(!documentXml.includes(input.description)); assert.ok(!documentXml.includes('<w:hyperlink'));
    for (const entry of Object.values(zip.files).filter(item => !item.dir)) assert.equal(XMLValidator.validate(await entry.async('string')), true);
    const styleXml = await zip.file('word/styles.xml')!.async('string');
    assert.match(styleXml, /w:styleId="Title"/); assert.match(styleXml, /w:color w:val="000000"/); assert.match(styleXml, /w:eastAsia="SimSun"/); assert.match(styleXml, /w:cs="Tahoma"/);
    assert.match(styleXml, /w:styleId="AppendixTitle"/); assert.ok(!styleXml.includes('w:themeColor')); assert.ok(!styleXml.includes('w:pBdr'));
    assert.equal(Object.keys(zip.files).some(name => /vba|macro|external|embeddings/i.test(name)), false);
  }
});

test('导出再次核验持久草稿的需求和正文，拒绝错位语言与非法内容', async () => {
  const source = draft();
  await assert.rejects(buildGeneratedContractDocx({ ...source, id: randomUUID() }), hasCode('VALIDATION_ERROR'));
  await assert.rejects(buildGeneratedContractDocx({ ...source, language: 'th' }), hasCode('VALIDATION_ERROR'));
  await assert.rejects(buildGeneratedContractDocx({ ...source, warnings: ['bad\ud800'] }), hasCode('VALIDATION_ERROR'));
  await assert.rejects(buildGeneratedContractDocx({ ...source, title: 'bad\u0000' }), hasCode('MODEL_OUTPUT_INVALID'));
});
