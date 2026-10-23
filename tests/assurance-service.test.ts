import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../src/core/storage';
import { ContractService, renderReviewMarkdown } from '../src/core/service';
import { createDocx } from './fixtures-documents';
import { defaultEnterpriseStandard, enterpriseStandardModelContext } from '../src/shared/assurance';
import type { EnterpriseStandardContent } from '../src/shared/assurance';
import type { ReviewContext, ReviewTask } from '../src/shared/contracts';

const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '虚构交易，仅工程测试。' };
const content = (): EnterpriseStandardContent => ({ ...defaultEnterpriseStandard(), name: '服务采购企业标准',
  rules: [{ key: 'price-change', name: '单方调价', kind: 'flag_phrase', terms: ['单方调整价格'], category: 'commercial', severity: 'high', enabled: true, guidance: '请按内部权限确认调价条件。' },
    { key: 'confidentiality', name: '保密主题', kind: 'required_topic', terms: ['保密', 'confidentiality'], category: 'operational', severity: 'high', enabled: true, guidance: '人工核对是否有等价约定。' },
    { key: 'disabled', name: '停用规则不得送模型', kind: 'flag_phrase', terms: ['inactive-enterprise-secret'], category: 'commercial', severity: 'high', enabled: false, guidance: '' }],
  thresholds: { maxPrepaymentPercent: 30, maxPaymentDays: 60 }, workflow: { runEnterpriseRules: true, highRiskHandling: 'escalate' } });
async function fixture(onTask?: (task: ReviewTask) => void) {
  const folder = await mkdtemp(join(tmpdir(), 'law-assurance-service-')); const dataDir = join(folder, 'data');
  const file = join(folder, 'synthetic.docx'); const bytes = await createDocx({ paragraphs: [
    '第一条 服务范围', '乙方提供技术服务，甲方可单方调整价格。',
    '第二条 费用', '分项金额：100.00元、200.00元；合计金额：400.00元。',
    '预付款比例为50%，付款期限为90天。', '履行期限自2026年5月20日至2026年5月10日。',
    '交付日期：2025年2月30日。', '本合同第九条约定的验收条件另行确认。',
  ] }); await writeFile(file, bytes);
  const store = await AppStore.open(dataDir); const tasks: ReviewTask[] = []; const service = new ContractService(store, dataDir, task => { tasks.push({ ...task }); onTask?.(task); });
  const document = await service.importFile(file);
  return { folder, dataDir, file, bytes, store, service, document, tasks };
}
async function wait(service: ContractService, taskId: string) {
  const end = Date.now() + 5000;
  for (;;) {
    const task = service.getState().tasks.find(item => item.id === taskId);
    if (task?.status === 'completed') return service.getReview(task.resultId!);
    if (task?.status === 'failed' || task?.status === 'cancelled') throw new Error(task.error ?? task.status);
    if (Date.now() > end) throw new Error('Synthetic review timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function publish(service: ContractService, value = content()) {
  const draft = await service.saveEnterpriseStandard({ expectedRevision: 0, content: value });
  const profile = await service.publishEnterpriseStandard({ standardId: draft.id, expectedRevision: draft.revision, publishedBy: '工程确认标签' });
  return { profile, version: profile.versions.at(-1)! };
}

test('企业版本在开始审核时固定，模型仅见启用规则，后续发布不改原报告或程序核验结果', async () => {
  const f = await fixture(); let { service, store } = f;
  let response!: ServerResponse; let payload: any; let arrived!: () => void;
  const received = new Promise<void>(resolve => { arrived = resolve; }); let calls = 0;
  const server = createServer(async (request, res) => { let raw = ''; for await (const chunk of request) raw += chunk; calls++; payload = JSON.parse(JSON.parse(raw).messages[1].content); response = res; arrived(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { profile, version } = await publish(service);
    await service.saveConfig({ name: '审核标准模拟', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'mock', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 4096, contextWindowTokens: 64000, timeoutSeconds: 5 });
    const start = await service.startReview({ documentId: f.document.id, mode: 'model', context, standardVersionId: version.id }, null); await received;
    assert.equal(payload.enterpriseStandard.versionId, version.id);
    assert.deepEqual(payload.enterpriseStandard.enabledRules.map((rule: any) => rule.key), ['price-change', 'confidentiality']);
    assert.ok(!JSON.stringify(payload).includes('inactive-enterprise-secret'));
    const nextDraft = await service.saveEnterpriseStandard({ standardId: profile.id, expectedRevision: profile.revision, content: { ...content(), checks: { amounts: false, dates: false, references: false }, workflow: { runEnterpriseRules: false, highRiskHandling: 'manual_review' } } });
    const next = await service.publishEnterpriseStandard({ standardId: profile.id, expectedRevision: nextDraft.revision, publishedBy: '后续版本标签' }); assert.equal(next.versions.length, 2);
    const modelFinding = { blockIds: [payload.contractBlocks[1].id], quote: payload.contractBlocks[1].text, title: '模型模拟意见', category: 'commercial', severity: 'high', description: '模拟内容，不是法律结论。', suggestion: '请人工复核。', legalBasis: null, citations: [] };
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ model: 'mock', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '工程审核结果。', reviewedBlockIds: payload.contractBlocks.map((block: any) => block.id), findings: [modelFinding] }) } }] }));
    const review = await wait(service, start.taskId); assert.equal(calls, 1);
    assert.deepEqual(review.standardSnapshot, version); assert.ok(review.programChecks?.issues.length);
    assert.ok(review.findings.some(item => item.origin === 'program')); assert.ok(review.findings.some(item => item.origin === 'enterprise' && item.checkKey?.endsWith(':price-change')));
    assert.ok(review.findings.some(item => item.origin === 'enterprise' && item.severity === 'unrated' && !item.blockIds.length));
    assert.ok(review.findings.some(item => item.origin === 'model'));
    assert.ok(review.coverage.limitations.some(item => item.includes(version.contentSha256)));
    assert.equal(store.rows('SELECT rule_set_version_id FROM analysis_runs WHERE document_version_id=?', [f.document.id])[0].rule_set_version_id, version.id);
    const frozen = structuredClone(review);
    const high = review.findings.find(item => item.origin === 'model')!;
    assert.deepEqual(service.getRiskDispositions(review.id).events, []);
    let dispositions = await service.saveRiskDisposition({ reviewId: review.id, findingId: high.id, expectedRevision: 0, status: 'business_accepted', reason: '业务负责人确认 | 继续谈判', actorLabel: '测试法务' });
    await assert.rejects(service.saveRiskDisposition({ reviewId: review.id, findingId: high.id, expectedRevision: 0, status: 'fixed', reason: '旧页面不得覆盖', actorLabel: '测试法务' }), /变化|更新|过期|修订/);
    dispositions = await service.saveRiskDisposition({ reviewId: review.id, findingId: high.id, expectedRevision: dispositions.revision, status: 'needs_information', reason: '补充验收附件后再判断\n## 伪造报告章节', actorLabel: '测试法务' });
    assert.equal(dispositions.events.length, 2); assert.equal(dispositions.events.at(-1)!.status, 'needs_information');
    assert.deepEqual(service.getReview(review.id), frozen); assert.equal(service.getReview(review.id).findings.find(item => item.id === high.id)!.severity, 'high');
    const exported = renderReviewMarkdown(review, f.document.name, dispositions);
    assert.ok(exported.includes(version.contentSha256)); assert.ok(exported.includes('程序核验')); assert.ok(exported.includes('业务接受')); assert.ok(exported.includes('不代表法律合法')); assert.ok(exported.includes('补充验收附件'));
    assert.ok(!exported.includes('\n## 伪造报告章节')); assert.ok(exported.includes('\\#\\# 伪造报告章节'));
    assert.ok(exported.includes('未提供直接引文，需人工核对')); assert.ok(!exported.includes('缺失条款检查，无直接引文'));
    assert.equal(createHash('sha256').update(await readFile(f.file)).digest('hex'), createHash('sha256').update(f.bytes).digest('hex'));
    await service.close(); store = await AppStore.open(f.dataDir); service = new ContractService(store, f.dataDir);
    assert.deepEqual(service.getReview(review.id), frozen); assert.deepEqual(service.getRiskDispositions(review.id), dispositions); assert.equal(service.getEnterpriseStandard(profile.id).versions.length, 2);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await service.close(); const done = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await done; await rm(f.folder, { recursive: true, force: true }); }
});

test('已完成事件发出后可立即开始下一次审核，结束清理不会误占任务名额', async () => {
  let service!: ContractService; let documentId = ''; let secondStart: Promise<{ taskId: string }> | undefined;
  let notify!: () => void; const completedEvent = new Promise<void>(resolve => { notify = resolve; });
  const f = await fixture(task => {
    if (task.status === 'completed' && !secondStart) {
      secondStart = service.startReview({ documentId, mode: 'local', context }, null);
      void secondStart.catch(() => {});
      notify();
    }
  });
  service = f.service; documentId = f.document.id;
  try {
    const first = await service.startReview({ documentId, mode: 'local', context }, null);
    await wait(service, first.taskId);
    await completedEvent;
    assert.ok(secondStart);
    const second = await secondStart;
    const result = await wait(service, second.taskId);
    assert.equal(result.documentId, documentId);
    assert.equal(service.getState().tasks.filter(task => task.status === 'completed').length, 2);
  } finally { await service.close(); await rm(f.folder, { recursive: true, force: true }); }
});

test('模型上下文按金额及日期独立开关隐藏商业阈值，停用企业规则不进入上下文', () => {
  const snapshot = { id: randomUUID(), standardId: randomUUID(), versionNo: 1, content: content(), contentSha256: 'f'.repeat(64), publishedAt: new Date().toISOString(), publishedBy: '测试' };
  snapshot.content.checks.amounts = false;
  assert.deepEqual(enterpriseStandardModelContext(snapshot)!.businessThresholds, { maxPrepaymentPercent: null, maxPaymentDays: 60 });
  snapshot.content.checks = { amounts: true, dates: false, references: true };
  snapshot.content.workflow.runEnterpriseRules = false;
  const view = enterpriseStandardModelContext(snapshot)!;
  assert.deepEqual(view.businessThresholds, { maxPrepaymentPercent: 30, maxPaymentDays: null });
  assert.deepEqual(view.enabledRules, []);
  assert.ok(!JSON.stringify(view).includes('inactive-enterprise-secret'));
  assert.equal(snapshot.content.rules.length, 3);
});

test('企业版本与连接凭据发生字符串冲突时在派任务前说明原因，不篡改快照或建立失败报告', async () => {
  const f = await fixture();
  try {
    const { profile, version } = await publish(f.service, { ...content(), name: 'dummy-key字符串冲突标准' });
    for (const [apiKey, keys] of [
      ['dummy-key', { knowledgeApiKey: null, webApiKey: null }],
      [null, { knowledgeApiKey: 'dummy-key', webApiKey: null }],
      [null, { knowledgeApiKey: null, webApiKey: 'dummy-key' }],
      ['e', { knowledgeApiKey: null, webApiKey: null }],
    ] as const) await assert.rejects(f.service.startReview({ documentId: f.document.id, mode: 'local', context, standardVersionId: version.id }, apiKey, keys), /连接凭据.*创建任务前/);
    assert.equal(f.service.getState().tasks.length, 0);
    assert.equal(f.store.rows('SELECT id FROM reports').length, 0);
    assert.deepEqual(f.service.getEnterpriseStandard(profile.id).versions[0], version);
    const started = await f.service.startReview({ documentId: f.document.id, mode: 'local', context, standardVersionId: version.id }, null);
    assert.deepEqual((await wait(f.service, started.taskId)).standardSnapshot, version);
  } finally { await f.service.close(); await rm(f.folder, { recursive: true, force: true }); }
});

test('未发布或不适用标准在派任务前拒绝，停用检查明确保留，风险处置不跨报告或自动整改', async () => {
  const f = await fixture();
  try {
    const draft = await f.service.saveEnterpriseStandard({ expectedRevision: 0, content: content() });
    await assert.rejects(f.service.startReview({ documentId: f.document.id, mode: 'local', context, standardVersionId: draft.id }, null), /版本|不存在|发布/);
    const buyer = await publish(f.service, { ...content(), name: '仅采购方标准', partyRoles: ['buyer'] });
    await assert.rejects(f.service.startReview({ documentId: f.document.id, mode: 'local', context, standardVersionId: buyer.version.id }, null), /不适用/);
    assert.equal(f.service.getState().tasks.length, 0);
    const disabled = await publish(f.service, { ...content(), name: '显式停用核验', checks: { amounts: false, dates: false, references: false }, workflow: { runEnterpriseRules: false, highRiskHandling: 'manual_review' } });
    const start = await f.service.startReview({ documentId: f.document.id, mode: 'local', context, standardVersionId: disabled.version.id }, null); const review = await wait(f.service, start.taskId);
    assert.ok(review.programChecks!.checks.every(check => check.status === 'disabled')); assert.equal(review.programChecks!.issues.length, 0); assert.ok(review.findings.every(finding => finding.origin === 'keyword'));
    const second = await f.service.startReview({ documentId: f.document.id, mode: 'local', context }, null); const next = await wait(f.service, second.taskId);
    const finding = next.findings[0]; assert.ok(finding);
    await assert.rejects(f.service.saveRiskDisposition({ reviewId: review.id, findingId: finding.id, expectedRevision: 0, status: 'confirmed', reason: '不能跨报告', actorLabel: '法务' }), /不属于|不存在|匹配/);
    await assert.rejects(f.service.saveRiskDisposition({ reviewId: next.id, findingId: finding.id, expectedRevision: 0, status: 'fixed', reason: ' ', actorLabel: '法务' }), /无效|原因/);
    const original = structuredClone(next);
    const decision = await f.service.saveRiskDisposition({ reviewId: next.id, findingId: finding.id, expectedRevision: 0, status: 'fixed', reason: '人工标记，效果仍待复核', actorLabel: '法务' });
    assert.equal(decision.events[0].status, 'fixed'); assert.deepEqual(f.service.getReview(next.id), original);
    assert.equal((await f.service.getChanges(next.id)).proposals.length, 0);
    assert.throws(() => renderReviewMarkdown(next, 'synthetic', { reviewId: randomUUID(), revision: 0, events: [] }), /不属于/);
  } finally { await f.service.close(); await rm(f.folder, { recursive: true, force: true }); }
});
