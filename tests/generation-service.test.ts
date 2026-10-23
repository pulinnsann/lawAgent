import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { parseContract } from '../src/core/documents';
import type { GenerateContractInput,AuthoringCaseView } from '../src/shared/generation';

const description = '拟定技术维护服务合同，我方为接受方。双方名称、金额、服务期限和验收标准尚待确认。';
const request = (): GenerateContractInput => ({ requestId: randomUUID(), description, language: 'zh', contractType: 'service', ourPartyRole: 'service_recipient' });
const output = () => ({ title: '技术维护服务合同', clauses: [{ heading: '合同主体与服务', paragraphs: ['甲方：[待填写名称]。乙方：[待填写名称]。', '服务范围及期限：[待确认]。'] }, { heading: '价款与签署', paragraphs: ['金额、付款条件、验收标准及签署日期：[待确认]。'] }], missingInformation: ['当事人名称、范围、期限、金额、验收及签署日期。'], warnings: ['交易条件须业务及法务确认。'] });
async function mock(handler: (body: Record<string, unknown>, response: ServerResponse) => void) {
  let count = 0;
  const server = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; count++; handler(JSON.parse(body), res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, get requests() { return count; },
    async close() { const done = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await done; } };
}
function respond(response: ServerResponse, data: unknown) {
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ model: 'mock-generation', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }));
}
async function fixture(baseUrl: string) {
  const folder = await mkdtemp(join(tmpdir(), 'law-generation-service-')); const dataDir = join(folder, 'data'); const exports = join(folder, 'exports'); await mkdir(exports);
  const store = await AppStore.open(dataDir); const service = new ContractService(store, dataDir);
  await service.saveConfig({ name: '本机生成模拟', baseUrl, model: 'mock', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 4096, contextWindowTokens: 64000, timeoutSeconds: 5 });
  return { folder, dataDir, exports, store, service };
}

test('描述生成结果独立保存、幂等恢复，先核验审核确认再导出同一原稿且原合同不变', async () => {
  const apiKey = 'synthetic-generation-credential';
  const server = await mock((_body, response) => respond(response, { ...output(), warnings: [`模拟回显须隐去 ${apiKey}`] }));
  const f = await fixture(server.baseUrl); let { store, service } = f;
  try {
    const original = await service.loadSample(); const artifact = store.getDocumentArtifact(original.id); const beforeBytes = await readFile(join(f.dataDir, artifact.artifactUri));
    const input = request(); const generated = await service.generateContract(input, apiKey);
    assert.equal(generated.id, input.requestId); assert.equal(service.listContractDrafts().length, 1); assert.equal(service.getState().documents.length, 1);
    assert.ok(!JSON.stringify(store.rows('SELECT * FROM contract_drafts')).includes(apiKey)); assert.ok(generated.warnings.some(value => value.includes('[REDACTED]')));
    assert.deepEqual(await service.generateContract({ ...input }, apiKey), generated); assert.equal(server.requests, 1);
    await assert.rejects(service.generateContract({ ...input, description: `${description}另有其他条件。` }, apiKey), /不同内容/); assert.equal(server.requests, 1);
    await assert.rejects(service.exportContractDraft({draftId:input.requestId,filePath:join(f.exports,'未确认.docx')}),/先完成/);
    let view=await service.runWorkspaceCommand({action:'library.authoring.prepareDescription',payload:{draftId:input.requestId,actorLabel:'测试法务'}}) as AuthoringCaseView;
    assert.ok(view.issues.some(item=>item.blocking));
    view=await service.runWorkspaceCommand({action:'library.authoring.update',payload:{id:view.asset.id,expectedRevision:view.asset.revision,actorLabel:'测试法务',reason:'填入合成测试所需信息',title:generated.title,clauses:[{heading:'合同主体与服务',paragraphs:['甲方：测试企业甲。乙方：测试企业乙。','服务范围：合成系统维护；服务起始日期：2027年1月1日；截止日期：2027年12月31日。']},{heading:'价款与签署',paragraphs:['总价：CNY 100.00；按完成的维护清单验收后支付。','签署日期：2027年1月1日。']}],missingInformation:[]}}) as AuthoringCaseView;
    const task=await service.startReview({documentId:view.document.id,mode:'local',context:{contractType:'service',ourPartyRole:'service_recipient',strictness:'balanced',businessContext:'仅为工程测试的合成交易事实。'}},null);
    view=await service.runWorkspaceCommand({action:'library.authoring.attachReview',payload:{id:view.asset.id,expectedRevision:view.asset.revision,taskId:task.taskId,actorLabel:'测试法务'}}) as AuthoringCaseView;
    const deadline=Date.now()+5000;
    while(service.getState().tasks.find(item=>item.id===task.taskId)?.status!=='completed'){const current=service.getState().tasks.find(item=>item.id===task.taskId);if(current?.status==='failed')throw new Error(current.error??'Review failed');if(Date.now()>deadline)throw new Error('Local draft review timed out');await new Promise(resolve=>setTimeout(resolve,5));}
    view=await service.runWorkspaceCommand({action:'library.authoring.get',payload:{id:view.asset.id}}) as AuthoringCaseView;
    view=await service.runWorkspaceCommand({action:'library.authoring.confirm',payload:{id:view.asset.id,expectedRevision:view.asset.revision,contentSha256:view.asset.body.contentSha256,actorLabel:'测试法务',reason:'已核对合成交易和各项程序限制，不认证法律正确性。',confirmed:true,decisions:view.issues.map(issue=>({key:issue.key,status:'accepted',reason:'人工核对该合成测试事项。'}))}}) as AuthoringCaseView;
    assert.equal(view.canExport,true);const count=service.getState().documents.length;
    const existing = join(f.exports, '已有文件.docx'); await writeFile(existing, 'existing');
    await assert.rejects(service.exportContractDraft({ draftId: input.requestId, filePath: existing }), /已存在/); assert.equal(await readFile(existing, 'utf8'), 'existing');
    assert.equal(service.getState().documents.length,count);
    await assert.rejects(service.exportContractDraft({ draftId: input.requestId, filePath: join(f.dataDir, '禁止导出.docx') }), /数据目录/);
    const result=await service.exportContractDraft({draftId:input.requestId,filePath:join(f.exports,'已确认生成合同.docx')});
    const parsed=await parseContract(result.path);assert.equal(parsed.partial,false);assert.ok(parsed.blocks.some(block=>block.text.includes('测试企业甲')));assert.ok(!parsed.blocks.some(block=>block.text.includes('[待填写名称]')));
    assert.equal(result.document.id,view.document.id);assert.ok(result.document.latestReviewId);assert.equal(service.getState().documents.length,count);
    assert.equal(createHash('sha256').update(await readFile(result.path)).digest('hex'),store.getDocumentArtifact(view.document.id).sha256);
    assert.deepEqual(service.getDocument(original.id),original);assert.deepEqual(await readFile(join(f.dataDir,artifact.artifactUri)),beforeBytes);
    await service.close(); store = await AppStore.open(f.dataDir); service = new ContractService(store, f.dataDir);
    assert.deepEqual(service.getContractDraft(generated.id), generated); assert.equal(service.getDocument(result.document.id).reviews.length, 1);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await service.close(); await server.close(); await rm(f.folder, { recursive: true, force: true }); }
});

test('生成取消、无效输出及关闭均不创建成功草稿，取消后可重试独立请求', async () => {
  let arrived!: () => void; let response!: ServerResponse;
  let received = new Promise<void>(resolve => { arrived = resolve; });
  const server = await mock((_body, res) => { response = res; arrived(); }); const f = await fixture(server.baseUrl);
  try {
    const input = request(); const pending = f.service.generateContract(input, null); const failure = assert.rejects(pending, /取消/); await received;
    await assert.rejects(f.service.generateContract(request(), null), /正在生成/);
    await f.service.cancelContractGeneration(input.requestId); await failure;
    respond(response, output()); assert.deepEqual(f.service.listContractDrafts(), []); assert.equal(f.service.getState().documents.length, 0);
    received = new Promise<void>(resolve => { arrived = resolve; });
    const invalid = f.service.generateContract(request(), null); const invalidFailure = assert.rejects(invalid, /结构|JSON/); await received; respond(response, { ...output(), clauses: [] }); await invalidFailure;
    assert.deepEqual(f.service.listContractDrafts(), []);
    received = new Promise<void>(resolve => { arrived = resolve; });
    const closing = f.service.generateContract(request(), null); const closeFailure = assert.rejects(closing, /取消/); await received; await f.service.close(); await closeFailure;
    const reopened = await AppStore.open(f.dataDir); assert.deepEqual(reopened.listContractDrafts(), []); assert.deepEqual(reopened.rows('PRAGMA foreign_key_check'), []); await reopened.close();
  } finally { await f.service.close(); await server.close(); await rm(f.folder, { recursive: true, force: true }); }
});
