import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { WorkspaceAssets } from '../src/core/workspace-assets';
import { buildReportDocx, buildReportSnapshot, normalizeReportRequest, reportCsv, reportHtml, reportMarkdown, runReportingCommand } from '../src/core/reporting';
import { defaultReportSettings, type ReportSnapshot, type SavedReportSettings } from '../src/shared/reporting';
import { defaultEnterpriseStandard } from '../src/shared/assurance';
import type { EnterpriseStandardSnapshot } from '../src/shared/assurance';
import type { ContractDetail, ParsedContract, ReviewContext, ReviewResult, ReviewTask, SourceEvidence } from '../src/shared/contracts';

const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '合成工程资料' };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'law-reporting-')); const store = await AppStore.open(dir); const service = new ContractService(store, dir); const assets = new WorkspaceAssets(store);
  return { dir, store, service, assets, close: async () => { await service.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function document(store: AppStore, name = '同名合同.docx', stamp = '2026-10-22T04:00:00.000Z') {
  const parsed: ParsedContract = { format: 'docx', language: 'zh', pageCount: null, partial: false, warnings: [], blocks: [{ id: randomUUID(), ordinal: 0, kind: 'paragraph', text: '合成付款条款，仅供程序验证。', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/w:document[1]/w:body[1]/w:p[1]', paragraphId: null } }] };
  const result = await store.addDocument(randomUUID(), name, 'synthetic/not-a-real-artifact.docx', 100, digest(parsed.blocks[0].text), parsed);
  await store.transaction(() => { store.rows('UPDATE document_versions SET created_at=? WHERE id=?', [stamp, result.id]); });
  return store.getDocument(result.id);
}
async function review(store: AppStore, doc: ContractDetail, createdAt: string, standard?: EnterpriseStandardSnapshot, findingCount = 1) {
  const task: ReviewTask = { id: randomUUID(), documentId: doc.id, status: 'queued', stage: 'synthetic', startedAt: createdAt, finishedAt: null, error: null, resultId: null };
  const runId = await store.createTask(task, context, 'local', null, null, standard);
  const result: ReviewResult = { id: randomUUID(), documentId: doc.id, createdAt, mode: 'local', modelId: null, summary: '应由法务人工复核的合成摘要。', findings: Array.from({ length: findingCount }, (_, index) => ({ id: randomUUID(), blockIds: [doc.blocks[0].id], quote: doc.blocks[0].text, title: `合成风险 ${index + 1}`, category: 'commercial', severity: 'high', description: '工程记录，不代表法律结论。', suggestion: '核对付款授权。', legalBasis: null, basisStatus: 'unverified', source: 'rule', locationStatus: 'matched' })), context,
    coverage: { reviewedBlockIds: doc.blocks.map(block => block.id), totalBlockCount: doc.blockCount, knowledgeStatus: 'user_disabled', webStatus: 'user_disabled', limitations: ['人工质量验收由律师完成。'] }, elapsedMs: 3, inputTokens: null, outputTokens: null, ...(standard ? { standardSnapshot: standard } : {}) };
  await store.saveReview(result, runId); return result;
}
async function standard(store: AppStore) { let profile = await store.saveEnterpriseStandard({ expectedRevision: 0, content: { ...defaultEnterpriseStandard(), name: '合成标准' } }); profile = await store.publishEnterpriseStandard({ standardId: profile.id, expectedRevision: profile.revision, publishedBy: '合成法务' }); return profile.versions[0]; }

test('报告请求使用真实日期并拒绝隐藏指令及无效范围', () => {
  assert.throws(() => normalizeReportRequest({ scope: 'current' }), /指定审核/);
  for (const value of [{ scope: 'workspace', from: '2026-02-30' }, { scope: 'workspace', from: '2026-10-23', to: '2026-10-22' }, { scope: 'workspace', from: '2026-1-1' }, { scope: 'workspace', systemPrompt: 'drop' }]) assert.throws(() => normalizeReportRequest(value));
  assert.deepEqual(normalizeReportRequest({ scope: 'workspace', from: '2024-02-29' }), { scope: 'workspace', from: '2024-02-29', style: 'management' });
});

test('工作汇总按真实合同和版本去重，使用北京时间边界与已保存轮次，区分不同标准', async () => {
  const f = await fixture();
  try {
    const doc = await document(f.store, '同名合同.docx', '2026-10-21T15:00:00Z');
    const other = await document(f.store, '同名合同.docx');
    const revisedId = randomUUID();
    const contractId = String(f.store.rows('SELECT contract_id FROM document_versions WHERE id=?', [doc.id])[0].contract_id);
    await f.store.transaction(() => {
      const source = f.store.rows('SELECT * FROM document_versions WHERE id=?', [doc.id])[0];
      const copy = { ...source, source_name:null, id: revisedId, contract_id: contractId, version_no: 2, parent_version_id: doc.id, kind: 'revised', created_at: '2026-10-22T04:00:00Z' };
      f.store.rows(`INSERT INTO document_versions(${Object.keys(copy).join(',')}) VALUES(${Object.keys(copy).map(() => '?').join(',')})`, Object.values(copy));
      const block = f.store.rows('SELECT * FROM document_blocks WHERE document_version_id=?', [doc.id])[0];
      const copiedBlock = { ...block, id: randomUUID(), document_version_id: revisedId };
      f.store.rows(`INSERT INTO document_blocks(${Object.keys(copiedBlock).join(',')}) VALUES(${Object.keys(copiedBlock).map(() => '?').join(',')})`, Object.values(copiedBlock));
    });
    const revised = f.store.getDocument(revisedId);
    await review(f.store, doc, '2026-10-21T15:59:59.999Z', undefined, 4);
    const one = await review(f.store, doc, '2026-10-21T16:00:00.000Z', await standard(f.store), 2);
    const two = await review(f.store, doc, '2026-10-22T15:59:59.999Z', undefined, 1);
    await review(f.store, f.store.getDocument(revised.id), '2026-10-22T04:00:00Z', undefined, 3);
    await review(f.store, other, '2026-10-22T16:00:00Z', undefined, 9);
    await f.store.saveRiskDisposition({ reviewId: one.id, findingId: one.findings[0].id, expectedRevision: 0, status: 'business_accepted', reason: '合成业务决策', actorLabel: '合成人员' });
    const before = f.store.rows('SELECT content_json FROM reports ORDER BY id');
    const result = buildReportSnapshot(normalizeReportRequest({ scope: 'workspace', from: '2026-10-22', to: '2026-10-22' }), f.store, defaultReportSettings(), '2026-10-23T01:00:00Z');
    assert.equal(result.metrics.contracts, 2); assert.equal(result.metrics.documentVersions, 3); assert.equal(result.metrics.importedVersions, 2);
    assert.equal(result.metrics.reviewRounds, 3); assert.equal(result.metrics.riskItems, 6); assert.equal(result.metrics.latestVersionRiskItems, 4);
    assert.equal(result.metrics.dispositions.business_accepted, 1); assert.equal(result.metrics.dispositions.unreviewed, 5); assert.equal(result.metrics.pendingDecisions, 5);
    assert.equal(result.metrics.severities.high, 6); assert.equal(result.standardGroups.length, 2); assert.ok(result.limitations.some(value => value.includes('不能直接')));
    assert.ok(result.reviews.some(item => item.review.id === two.id));
    assert.deepEqual(f.store.rows('SELECT content_json FROM reports ORDER BY id'), before);
    const { snapshotSha256, ...content } = result; assert.equal(snapshotSha256, digest(content));
    assert.equal(new Set(result.documents.map(item => item.name)).size, 2);
    const empty = buildReportSnapshot(normalizeReportRequest({ scope: 'workspace', from: '1999-01-01', to: '1999-01-01' }), f.store, defaultReportSettings());
    assert.equal(empty.metrics.reviewRounds, 0); assert.ok(empty.limitations.some(value => value.includes('没有已完成')));
  } finally { await f.close(); }
});

test('报告配置并发首次保存不生成两份单例配置，CAS保留历史且不接受未知字段', async () => {
  const f = await fixture();
  try {
    const get = () => runReportingCommand('reporting.settings.get', {}, f) as Promise<SavedReportSettings>;
    assert.equal((await get()).id, null);
    const input = { expectedRevision: 0, body: { ...defaultReportSettings(), organization: '合成单位' }, actorLabel: '合成标签' };
    const attempts = await Promise.allSettled([runReportingCommand('reporting.settings.save', input, f), runReportingCommand('reporting.settings.save', input, f)]);
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1); assert.equal(attempts.filter(item => item.status === 'rejected').length, 1);
    const saved = await get(); assert.equal(saved.revision, 1); assert.equal(f.assets.list('reporting_settings').length, 1);
    await runReportingCommand('reporting.settings.save', { id: saved.id, expectedRevision: 1, body: { ...saved.body, includeContractQuotes: false }, actorLabel: '合成标签' }, f);
    assert.equal((await get()).revision, 2); assert.equal(f.assets.history(saved.id!).length, 2);
    await assert.rejects(runReportingCommand('reporting.settings.save', { id: saved.id, expectedRevision: 1, body: saved.body, actorLabel: '旧标签' }, f), /变化/);
    await assert.rejects(runReportingCommand('reporting.settings.save', { expectedRevision: 0, body: { ...saved.body, apiKey: 'must-not-store' }, actorLabel: '标签' }, f));
    assert.ok(!JSON.stringify(f.assets.list('reporting_settings')).includes('must-not-store'));
  } finally { await f.close(); }
});

test('导出登记严格核对格式 文件hash 快照hash和统计明细，异常输入不写记录', async () => {
  const f = await fixture();
  try {
    const doc = await document(f.store); const result = await review(f.store, doc, '2026-10-22T04:00:00Z');
    const snapshot = buildReportSnapshot(normalizeReportRequest({ scope: 'current', reviewId: result.id }), f.store, defaultReportSettings());
    const input = { format: 'html', sha256: digest(reportHtml(snapshot)), snapshot };
    const exported = await runReportingCommand('reporting.recordExport', input, f) as { id: string; body: typeof input; revision: number };
    assert.equal(exported.body.sha256, input.sha256); assert.deepEqual(exported.body.snapshot, snapshot); assert.equal(f.assets.list('report_export').length, 1);
    const tampered = structuredClone(snapshot); tampered.metrics.riskItems++;
    await assert.rejects(runReportingCommand('reporting.recordExport', { ...input, snapshot: tampered }, f), /SHA256/);
    const { snapshotSha256: _old, ...content } = tampered; tampered.snapshotSha256 = digest(content);
    await assert.rejects(runReportingCommand('reporting.recordExport', { ...input, snapshot: tampered }, f), /统计口径/);
    for (const changed of [{ ...input, format: 'exe' }, { ...input, sha256: 'not-a-file-hash' }, { ...input, secret: 'forbidden' }, { ...input, snapshot: { ...snapshot, extension: 'forbidden' } }]) await assert.rejects(runReportingCommand('reporting.recordExport', changed, f));
    assert.equal(f.assets.list('report_export').length, 1);
  } finally { await f.close(); }
});

test('报告读取最新处置和独立人工补充意见，原审核意见及风险等级不变', async () => {
  const f = await fixture();
  try {
    const doc = await document(f.store); const result = await review(f.store, doc, '2026-10-22T04:00:00Z'); const original = f.store.getReview(result.id);
    await f.store.saveRiskDisposition({ reviewId: result.id, findingId: result.findings[0].id, expectedRevision: 0, status: 'business_accepted', reason: '业务接受理由', actorLabel: '业务标签' });
    await f.store.saveRiskDisposition({ reviewId: result.id, findingId: result.findings[0].id, expectedRevision: 1, status: 'needs_information', reason: '仍需附件', actorLabel: '法务标签' });
    const kind = 'library_annotation';
    await f.assets.save({ kind, expectedRevision: 0, body: { reviewId: result.id, documentId: doc.id, findingId: result.findings[0].id, title: '人工重新关注', category: 'commercial', severity: 'low', description: '独立人工补充', suggestion: '人工补充建议', blockIds: [doc.blocks[0].id], quote: doc.blocks[0].text, reason: '人工重新判断的理由', actorLabel: '律师标签', state: 'active', originalReviewSha256: digest(result) } });
    const snapshot = await runReportingCommand('reporting.query', { scope: 'current', reviewId: result.id, style: 'summary' }, f) as ReportSnapshot;
    assert.equal(snapshot.metrics.dispositions.needs_information, 1); assert.equal(snapshot.metrics.dispositions.business_accepted, 0);
    assert.equal(snapshot.metrics.severities.high, 1); assert.equal(snapshot.metrics.activeManualOpinions, 1);
    const markdown = reportMarkdown(snapshot); assert.ok(markdown.includes('人工重新关注')); assert.ok(markdown.includes('独立人工补充意见')); assert.ok(markdown.includes('人工重新判断的理由')); assert.ok(markdown.includes('业务接受理由')); assert.ok(markdown.includes('仍需附件'));
    const html = reportHtml(snapshot); const introduction = html.slice(0, html.indexOf('<h2>需要跟进的事项'));
    assert.ok(introduction.includes('核心审核指标')); assert.ok(introduction.includes('待跟进或待决策意见')); assert.ok(!introduction.includes('各版本范围内最后一轮原始意见条数'));
    assert.ok(html.indexOf('<h2>完整统计附录') > html.indexOf('<h2>需要跟进的事项')); assert.ok(!html.includes('<h3>来源与检索依据</h3>')); assert.ok(html.includes('本次没有保存检索记录或来源原文'));
    assert.deepEqual(f.store.getReview(result.id), original);
    await assert.rejects(runReportingCommand('reporting.query', { scope: 'current', reviewId: randomUUID() }, f), /不存在/);
    await assert.rejects(runReportingCommand('reporting.unknown', {}, f), /未知/);
  } finally { await f.close(); }
});

test('HTML Markdown CSV 编码不执行外部内容，来源摘要和不可核验状态完整保留', async () => {
  const f = await fixture();
  try {
    const doc = await document(f.store, '=HYPERLINK("https://invalid","x").docx'); const result = await review(f.store, doc, '2026-10-22T04:00:00Z');
    const snapshot = buildReportSnapshot(normalizeReportRequest({ scope: 'current', reviewId: result.id, style: 'summary' }), f.store, { ...defaultReportSettings(), includeContractQuotes: false });
    const item = snapshot.reviews[0]; item.review.findings[0].title = '<script>bad()</script>\n## forged';
    item.review.findings[0].basisStatus = 'source_matched';
    item.review.experienceSnapshot = [{ id: 'synthetic-experience', revision: 3, contentSha256: 'd'.repeat(64), body: { name: '经验工程记录', kind: 'preference', content: '偏好工程样本，不能代替法律。', state: 'approved', actorLabel: '人工标签', reason: '显式确认', approvedAt: '2026-10-22' } }];
    item.review.batchCoverage = { batchCount: 2, crossBatchSynthesis: false, limitations: ['跨批意见需人工核对'] };
    item.review.findings[0].citations = [{ evidenceId: 'synthetic-source', quote: '来源文字', matchStatus: 'matched' }];
    const source: SourceEvidence = { id: 'synthetic-source', attemptId: 'synthetic-attempt', title: '来源 <img src=x>', sourceUri: 'javascript:alert(1)', channel: 'web', kind: 'statute', locator: '第 1 条', excerpt: '来源文字仅工程样本', excerptSha256: 'a'.repeat(64), contentScope: 'fragment', retrievedAt: '2026-10-22T00:00:00Z', publishedAt: null, effectiveAt: null, currentness: 'unknown', isOfficial: true, warnings: ['效力尚未核验'] };
    item.review.retrieval = { configSnapshot: { knowledge: { enabled: false, folderPath: null, api: { enabled: false, provider: 'standard', baseUrl: '', collectionId: '', hasApiKey: false, keyStorage: 'session-only' } }, web: { enabled: false, provider: 'searxng', baseUrl: '', allowedDomains: [], fetchPages: false, hasApiKey: false, keyStorage: 'session-only' }, maxResults: 4, timeoutSeconds: 20 }, knowledgeStatus: 'not_configured', webStatus: 'complete', attempts: [], evidence: [source], limitations: ['目录覆盖有限'] };
    const html = reportHtml(snapshot); const markdown = reportMarkdown(snapshot); const csv = reportCsv(snapshot);
    assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img')); assert.ok(!html.includes('href="javascript:'));
    assert.ok(html.includes("default-src 'none'")); assert.ok(html.includes(source.excerptSha256)); assert.ok(html.includes('来源文字仅工程样本')); assert.ok(html.includes('效力尚未核验'));
    assert.ok(html.includes('synthetic-experience')); assert.ok(html.includes('本次采用的本地经验版本')); assert.ok(html.includes('偏好工程样本')); assert.ok(html.includes('审核批次数 2')); assert.ok(html.includes('跨批意见需人工核对')); assert.ok(html.includes('未完成综合'));
    assert.ok(markdown.includes('\\#\\# forged')); assert.ok(!markdown.includes('\n## forged')); assert.ok(markdown.includes('效力和适用未核验')); assert.ok(!markdown.includes('合同引文'));
    assert.ok(csv.includes("'=HYPERLINK")); const lines = csv.replace(/^\uFEFF/u, '').split('\r\n'); assert.ok(lines[0].includes('报告快照SHA256')); assert.ok(csv.includes('synthetic-source'));
    const bodyBefore = JSON.stringify(snapshot); reportHtml(snapshot); reportCsv(snapshot); assert.equal(JSON.stringify(snapshot), bodyBefore);
  } finally { await f.close(); }
});

test('DOCX 报告仅包含普通 OOXML 无外部关系，标题样式和来源处置均可回读', async () => {
  const f = await fixture();
  try {
    const doc = await document(f.store, '中 English ไทย 合同.docx'); const result = await review(f.store, doc, '2026-10-22T04:00:00Z', await standard(f.store));
    await f.store.saveRiskDisposition({ reviewId: result.id, findingId: result.findings[0].id, expectedRevision: 0, status: 'escalated', reason: '须由领导作业务决策', actorLabel: '合成法务' });
    const snapshot = buildReportSnapshot(normalizeReportRequest({ scope: 'current', reviewId: result.id }), f.store, defaultReportSettings());
    const bytes = await buildReportDocx(snapshot); const zip = await JSZip.loadAsync(bytes);
    assert.ok(zip.file('word/document.xml')); const xml = await zip.file('word/document.xml')!.async('string'); const styles = await zip.file('word/styles.xml')!.async('string');
    assert.equal(XMLValidator.validate(xml), true); assert.equal(XMLValidator.validate(styles), true);
    assert.ok(xml.includes('w:pStyle w:val="Title"')); assert.ok(xml.includes('中 English ไทย')); assert.ok(xml.includes(snapshot.snapshotSha256)); assert.ok(xml.includes('须由领导作业务决策')); assert.ok(xml.includes('冻结企业标准')); assert.ok(xml.includes('D9D9D9')); assert.ok(xml.includes('<w:tblHeader/>'));
    const parser = new XMLParser(); assert.ok(parser.parse(xml)['w:document']['w:body']);
    for (const name of Object.keys(zip.files).filter(name => name.endsWith('.rels'))) assert.ok(!(await zip.file(name)!.async('string')).includes('TargetMode="External"'));
    assert.ok(!Object.keys(zip.files).some(name => /vba|embeddings|oleObject/iu.test(name)));
    const rendered = await runReportingCommand('reporting.render', { scope: 'current', reviewId: result.id }, f) as { docxBase64: string; snapshot: ReportSnapshot; html: string; markdown: string; csv: string };
    assert.ok(Buffer.from(rendered.docxBase64, 'base64').length > 1000); assert.equal(rendered.snapshot.metrics.riskItems, 1); assert.ok(rendered.html.includes(rendered.snapshot.snapshotSha256)); assert.ok(rendered.csv.includes(rendered.snapshot.snapshotSha256)); assert.ok(rendered.markdown.includes(rendered.snapshot.snapshotSha256));
  } finally { await f.close(); }
});
