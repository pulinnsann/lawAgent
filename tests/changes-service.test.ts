import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, access, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { parseContract } from '../src/core/documents';
import { createDocx } from './fixtures-documents';
import JSZip from 'jszip';

const context = { contractType: 'service' as const, ourPartyRole: 'service_recipient' as const, strictness: 'balanced' as const, businessContext: '虚构工程验证。' };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function setup(inputBytes?: Buffer) {
  const parent = await mkdtemp(join(tmpdir(), 'law-changes-service-')); const dataDir = join(parent, 'data'); const output = join(parent, 'exports');
  await mkdir(output); const input = join(parent, 'trilingual.docx');
  const bytes = inputBytes ?? await createDocx({ paragraphs: ['服务付款应在验收后办理。', 'Payment follows acceptance.', 'ชำระเงินหลังตรวจรับบริการ'], rawBody: '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格价款：100元。</w:t></w:r></w:p></w:tc></w:tr></w:tbl>', header: '页眉保持不变' });
  await writeFile(input, bytes); const store = await AppStore.open(dataDir); const service = new ContractService(store, dataDir);
  const document = await service.importFile(input); const task = await service.startReview({ documentId: document.id, mode: 'local', context }, null);
  const deadline = Date.now() + 5000;
  while (service.getState().tasks.find(item => item.id === task.taskId)?.status !== 'completed') {
    if (Date.now() > deadline) throw new Error('Local review fixture did not complete');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const review = service.getDocument(document.id).reviews[0];
  return { parent, dataDir, output, input, bytes, store, service, document, review };
}

test('原生修订导出只包含采纳项，保留旧修订与样式并记录作者、格式和重启历史', async () => {
  const oldRevision = '<w:ins w:id="37" w:author="原作者" w:date="2025-01-01T00:00:00Z"><w:r><w:t>原有修订正文。</w:t></w:r></w:ins>';
  const rich = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Payment </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>follows acceptance.</w:t></w:r></w:p>';
  const source = await createDocx({ paragraphs: ['付款应在验收后办理。', '未采纳部分应保持原样。'], rawBody: `${rich}<w:p>${oldRevision}</w:p>`, header: '页眉保持', extraFiles: { 'word/settings.xml': '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:revisionView w:markup="0" w:insDel="0"/></w:settings>' } });
  const f = await setup(source); let { service, store } = f;
  try {
    const frozenReview = structuredClone(f.review); let workspace = await service.getChanges(f.review.id);
    for (const [block, replacementText, status] of [[f.document.blocks[0], '付款应在书面确认后办理。', 'accepted'], [f.document.blocks[1], '拒绝项不得出现在修订中。', 'rejected'], [f.document.blocks[2], 'Payment follows written confirmation.', 'accepted']] as const) {
      workspace = await service.saveChange({ reviewId: f.review.id, findingId: null, blockId: block.id, expectedRevision: workspace.revision, replacementText });
      const proposal = workspace.proposals.find(item => item.blockId === block.id)!;
      workspace = await service.decideChange({ reviewId: f.review.id, proposalId: proposal.id, expectedRevision: workspace.revision, status });
    }
    const author = '张法务 & QA';
    const exported = await service.exportModified({ reviewId: f.review.id, expectedRevision: workspace.revision, format: 'tracked', revisionAuthor: author, filePath: join(f.output, '原生修订稿.docx') });
    const bytes = await readFile(exported.documentPath); const zip = await JSZip.loadAsync(bytes); const xml = await zip.file('word/document.xml')!.async('string');
    assert.match(xml, /<[\w-]+:del\b/); assert.match(xml, /<[\w-]+:delText\b/); assert.match(xml, /<[\w-]+:ins\b/); assert.ok(xml.includes('张法务 &amp; QA')); assert.ok(xml.includes(oldRevision));
    assert.ok(!xml.includes('拒绝项不得出现在修订中')); assert.ok(xml.includes('<w:b/>')); assert.ok(xml.includes('<w:i/>'));
    assert.match(await zip.file('word/settings.xml')!.async('string'), /revisionView[^>]*insDel="(?:1|true)"/);
    assert.equal(exported.export.format, 'tracked'); assert.equal(exported.export.revisionAuthor, author);
    const snapshot = JSON.parse(String(store.rows('SELECT snapshot_json FROM change_exports WHERE id=?', [exported.export.id])[0].snapshot_json));
    assert.equal(snapshot.format, 'tracked'); assert.equal(snapshot.revisionAuthor, author); assert.ok(Number.isFinite(Date.parse(snapshot.revisionDate)));
    assert.match(await readFile(exported.changeListPath, 'utf8'), /Word原生修订稿/);
    workspace = await service.getChanges(f.review.id);
    const clean = await service.exportModified({ reviewId: f.review.id, expectedRevision: workspace.revision, format: 'clean', filePath: join(f.output, '普通修改稿.docx') });
    assert.equal(clean.export.format, 'clean'); assert.equal(clean.export.revisionAuthor, null);
    const text = async (path: string) => (await parseContract(path)).blocks.map(block => block.text);
    assert.deepEqual(await text(clean.documentPath), await text(exported.documentPath));
    assert.deepEqual(service.getReview(f.review.id), frozenReview); assert.equal(sha(await readFile(f.input)), sha(source));
    await service.close(); store = await AppStore.open(f.dataDir); service = new ContractService(store, f.dataDir);
    const restored = await service.getChanges(f.review.id); assert.equal(restored.exports.length, 2); assert.equal(restored.exports[0].format, 'tracked'); assert.equal(restored.exports[0].revisionAuthor, author);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await service.close(); }
});

test('只读保护明确说明，显式启用后沿用原审核锚点导出独立副本并留下保护变更记录', async () => {
  const complex = '<w:p><w:ins w:id="1"><w:r><w:t>带修订的条款仍保持原样。</w:t></w:r></w:ins></w:p>';
  const bytes = await createDocx({ paragraphs: ['服务付款应在验收后办理。'], rawBody: complex, extraFiles: {
    'word/settings.xml': '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:documentProtection w:edit="readOnly" w:enforcement="1" w:hash="c3ludGhldGlj" w:salt="dGVzdA=="/></w:settings>',
  } });
  const f = await setup(bytes); let { store, service } = f;
  try {
    const frozen = structuredClone(f.review); const target = f.document.blocks[0];
    let workspace = await service.getChanges(f.review.id);
    assert.equal(workspace.supported, false); assert.match(workspace.reason!, /只读|保护/);
    assert.equal(workspace.editableCopy?.available, true); assert.equal(workspace.editableCopy?.enabled, false);
    await assert.rejects(service.saveChange({ reviewId: f.review.id, findingId: null, blockId: target.id, expectedRevision: 0, replacementText: `${target.text}请书面确认。` }), /保护|只读/);
    workspace = await service.enableEditableCopy({ reviewId: f.review.id, expectedRevision: 0 });
    assert.equal(workspace.revision, 1); assert.equal(workspace.supported, true); assert.equal(workspace.editableCopy?.enabled, true);
    assert.equal(workspace.sourceFileSha256, sha(bytes)); assert.equal(workspace.targets[1].editable, false);
    await assert.rejects(service.saveChange({ reviewId: f.review.id, findingId: null, blockId: target.id, expectedRevision: 0, replacementText: '陈旧页面不得提交。' }), /变化|更新/);
    workspace = await service.saveChange({ reviewId: f.review.id, findingId: null, blockId: target.id, expectedRevision: workspace.revision, replacementText: '服务付款应在双方书面验收后办理。' });
    assert.ok(workspace.proposals[0].warnings.some(value => /只读|保护/.test(value)));
    workspace = await service.decideChange({ reviewId: f.review.id, proposalId: workspace.proposals[0].id, status: 'accepted', expectedRevision: workspace.revision });
    const result = await service.exportModified({ reviewId: f.review.id, expectedRevision: workspace.revision, filePath: join(f.output, '可编辑修改稿.docx') });
    const exportedBytes = await readFile(result.documentPath); const originalZip = await JSZip.loadAsync(bytes); const outputZip = await JSZip.loadAsync(exportedBytes);
    assert.ok(!(await outputZip.file('word/settings.xml')!.async('string')).includes('documentProtection'));
    assert.ok((await outputZip.file('word/document.xml')!.async('string')).includes(complex));
    assert.equal((await parseContract(result.documentPath)).blocks[0].text, '服务付款应在双方书面验收后办理。');
    for (const [name, file] of Object.entries(originalZip.files)) if (!file.dir && !['word/document.xml', 'word/settings.xml'].includes(name)) assert.deepEqual(await outputZip.file(name)!.async('nodebuffer'), await file.async('nodebuffer'));
    assert.equal(sha(await readFile(f.input)), sha(bytes)); assert.equal(sha(await readFile(join(f.dataDir, store.getDocumentArtifact(f.document.id).artifactUri))), sha(bytes));
    assert.deepEqual(service.getReview(f.review.id), frozen);
    assert.match(await readFile(result.changeListPath, 'utf8'), /可编辑副本/);
    const snapshot = JSON.parse(String(store.rows('SELECT snapshot_json FROM change_exports WHERE id=?', [result.export.id])[0].snapshot_json));
    assert.equal(snapshot.editableCopyAuthorization.enabled, true); assert.ok(snapshot.editableCopyAuthorization.enabledAt);
    await service.close(); store = await AppStore.open(f.dataDir); service = new ContractService(store, f.dataDir);
    workspace = await service.getChanges(f.review.id); assert.equal(workspace.editableCopy?.enabled, true); assert.equal(workspace.exports.length, 1);
    assert.deepEqual(service.getReview(f.review.id), frozen);
  } finally { await service.close(); }
});

test('未保护、数字签名及其他保护模式不能被副本入口静默转换', async () => {
  const cases: Array<Record<string, string> | undefined> = [undefined, { '_xmlsignatures/sig1.xml': '<Signature/>' }, {
    'word/settings.xml': '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:documentProtection w:edit="trackedChanges" w:enforcement="1"/></w:settings>',
  }];
  for (const extraFiles of cases) {
    const f = await setup(await createDocx({ paragraphs: ['服务付款应在验收后办理。'], extraFiles }));
    try {
      const workspace = await f.service.getChanges(f.review.id); assert.equal(workspace.editableCopy?.available, false);
      await assert.rejects(f.service.enableEditableCopy({ reviewId: f.review.id, expectedRevision: 0 }));
      assert.equal(f.store.getChangeRevision(f.review.id), 0); assert.equal(f.store.getEditableCopyAuthorization(f.review.id).enabled, false);
      assert.equal(sha(await readFile(f.input)), sha(f.bytes));
    } finally { await f.service.close(); }
  }
});

test('三语手动修改逐项采纳后仅写入所选项，原件与报告不变，版本及导出可重启回溯', async () => {
  const fixture = await setup(); let { service, store } = fixture;
  try {
    const { document, review } = fixture; const beforeReview = structuredClone(review);
    let workspace = await service.getChanges(review.id);
    assert.equal(workspace.revision, 0); assert.ok(workspace.supported);
    const first = document.blocks[0]; const second = document.blocks[1];
    workspace = await service.saveChange({ reviewId: review.id, findingId: null, blockId: first.id, expectedRevision: workspace.revision, replacementText: '服务付款应在书面验收后办理。' });
    const acceptedId = workspace.proposals[0].id;
    workspace = await service.decideChange({ reviewId: review.id, proposalId: acceptedId, status: 'accepted', expectedRevision: workspace.revision });
    workspace = await service.saveChange({ reviewId: review.id, findingId: null, blockId: second.id, expectedRevision: workspace.revision, replacementText: 'Payment follows written acceptance.' });
    const other = workspace.proposals.find(item => item.id !== acceptedId)!;
    workspace = await service.decideChange({ reviewId: review.id, proposalId: other.id, status: 'rejected', expectedRevision: workspace.revision });
    const result = await service.exportModified({ reviewId: review.id, expectedRevision: workspace.revision, filePath: join(fixture.output, '修改稿.docx') });
    const parsed = await parseContract(result.documentPath);
    assert.equal(parsed.blocks[0].text, '服务付款应在书面验收后办理。');
    assert.equal(parsed.blocks[1].text, second.text); assert.equal(parsed.blocks[2].text, document.blocks[2].text);
    assert.ok(parsed.blocks.some(item => item.kind === 'table_cell' && item.text === '表格价款：100元。'));
    assert.ok(parsed.blocks.some(item => item.kind === 'header' && item.text === '页眉保持不变'));
    assert.equal(sha(await readFile(fixture.input)), sha(fixture.bytes));
    assert.equal(sha(await readFile(join(fixture.dataDir, store.getDocumentArtifact(document.id).artifactUri))), sha(fixture.bytes));
    assert.deepEqual(service.getReview(review.id), beforeReview);
    assert.equal(result.export.versionNo, 2); assert.equal(result.export.sourceDocumentId, document.id);
    assert.ok(service.getDocument(result.export.documentId).name.includes('修改稿 v2'));
    const changeList = await readFile(result.changeListPath, 'utf8');
    assert.ok(changeList.includes('书面验收')); assert.ok(!changeList.includes('Payment follows written acceptance.'));
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
    await service.close(); store = await AppStore.open(fixture.dataDir); service = new ContractService(store, fixture.dataDir);
    const restored = await service.getChanges(review.id);
    assert.equal(restored.exports[0].documentId, result.export.documentId);
    assert.equal(restored.proposals.find(item => item.id === acceptedId)?.status, 'accepted');
    assert.deepEqual(service.getReview(review.id), beforeReview);
  } finally { await service.close(); }
});

test('陈旧修订号、同段冲突、编辑后重新采纳及原件变化均被明确处理', async () => {
  const f = await setup();
  try {
    const target = f.document.blocks[0]; let workspace = await f.service.getChanges(f.review.id);
    workspace = await f.service.saveChange({ reviewId: f.review.id, findingId: null, blockId: target.id, expectedRevision: 0, replacementText: `${target.text}待双方确认。` });
    await assert.rejects(f.service.saveChange({ reviewId: f.review.id, findingId: null, blockId: target.id, expectedRevision: 0, replacementText: '不能覆盖的旧草稿。' }), /更新|变化/);
    const first = workspace.proposals[0]; workspace = await f.service.decideChange({ reviewId: f.review.id, proposalId: first.id, status: 'accepted', expectedRevision: workspace.revision });
    workspace = await f.service.saveChange({ reviewId: f.review.id, findingId: null, blockId: target.id, expectedRevision: workspace.revision, replacementText: `${target.text}另一表述。` });
    const second = workspace.proposals.find(item => item.id !== first.id)!;
    await assert.rejects(f.service.decideChange({ reviewId: f.review.id, proposalId: second.id, status: 'accepted', expectedRevision: workspace.revision }), /冲突|已有采纳/);
    workspace = await f.service.saveChange({ reviewId: f.review.id, proposalId: first.id, findingId: null, blockId: target.id, expectedRevision: workspace.revision, replacementText: `${target.text}重新编辑。` });
    assert.equal(workspace.proposals.find(item => item.id === first.id)?.status, 'proposed');
    await assert.rejects(f.service.exportModified({ reviewId: f.review.id, expectedRevision: workspace.revision, filePath: join(f.output, '未采纳.docx') }), /采纳/);
    await writeFile(join(f.dataDir, f.store.getDocumentArtifact(f.document.id).artifactUri), Buffer.from('changed-managed-original'));
    await assert.rejects(f.service.getChanges(f.review.id), /原件|版本/);
  } finally { await f.service.close(); }
});

test('已有目标或清单不被覆盖，后续文件创建失败回滚本次新文件和版本', async () => {
  const f = await setup();
  try {
    let workspace = await f.service.saveChange({ reviewId: f.review.id, findingId: null, blockId: f.document.blocks[0].id, expectedRevision: 0, replacementText: '双方确认书面验收后办理付款。' });
    workspace = await f.service.decideChange({ reviewId: f.review.id, proposalId: workspace.proposals[0].id, status: 'accepted', expectedRevision: workspace.revision });
    await assert.rejects(f.service.exportModified({ reviewId: f.review.id, expectedRevision: workspace.revision, filePath: f.input }), /已存在|覆盖/);
    assert.equal(sha(await readFile(f.input)), sha(f.bytes));
    const path = join(f.output, '名称冲突.docx'); const manifest = join(f.output, '名称冲突.修改清单.md'); await writeFile(manifest, '已有清单，必须保留');
    await assert.rejects(f.service.exportModified({ reviewId: f.review.id, expectedRevision: workspace.revision, filePath: path }), /已存在|覆盖/);
    await assert.rejects(access(path)); assert.equal(await readFile(manifest, 'utf8'), '已有清单，必须保留');
    assert.equal(f.service.getState().documents.length, 1); assert.equal(f.store.getChangeExports(f.review.id).length, 0);
    await assert.rejects(f.service.exportModified({ reviewId: f.review.id, expectedRevision: workspace.revision, filePath: join(f.dataDir, 'bad.docx') }), /数据目录/);
  } finally { await f.service.close(); }
});

test('目标已创建后写入中途失败，也会清理本次半文件而不新增修改版本', async t => {
  const f = await setup();
  try {
    let workspace = await f.service.saveChange({ reviewId: f.review.id, findingId: null, blockId: f.document.blocks[0].id, expectedRevision: 0, replacementText: '双方书面验收后办理付款。' });
    workspace = await f.service.decideChange({ reviewId: f.review.id, proposalId: workspace.proposals[0].id, status: 'accepted', expectedRevision: workspace.revision });
    const probe = await open(join(f.output, 'handle-probe'), 'wx'); const prototype = Object.getPrototypeOf(probe); await probe.close();
    const original = prototype.writeFile; let injected = false;
    t.mock.method(prototype, 'writeFile', async function (this: any, data: any, options: any) {
      if (!injected && Buffer.isBuffer(data) && data[0] === 0x50 && data[1] === 0x4b) {
        injected = true; await original.call(this, Buffer.from('partial-new-file'), options);
        throw Object.assign(new Error('simulated-disk-full'), { code: 'ENOSPC' });
      }
      return original.call(this, data, options);
    });
    const path = join(f.output, '半文件.docx');
    await assert.rejects(f.service.exportModified({ reviewId: f.review.id, expectedRevision: workspace.revision, filePath: path }), /simulated-disk-full/);
    assert.ok(injected); await assert.rejects(access(path));
    assert.equal(f.store.getChangeExports(f.review.id).length, 0); assert.equal(f.service.getState().documents.length, 1);
    assert.equal(sha(await readFile(f.input)), sha(f.bytes));
  } finally { await f.service.close(); }
});

async function modelFixture(bytes?: Buffer) {
  const f = await setup(bytes); let received: any; let action: 'normal' | 'bad_anchor' | 'wait' = 'normal'; let release: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw); received = JSON.parse(body.messages[1].content);
    if (action === 'wait') await new Promise<void>(resolve => { release = resolve; });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ model: 'synthetic-change-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ blockId: received.targetBlock.id,
      originalText: action === 'bad_anchor' ? 'fabricated-original' : received.targetBlock.text,
      replacementText: `${received.targetBlock.text}具体程序由双方书面确认。`, explanation: '虚构模型措辞，仅验证数据流程。', warnings: ['工程样例，待人工确认。'] }) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  await f.service.saveConfig({ name: '合成草稿模型', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-change-model', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 2000, contextWindowTokens: 64000, timeoutSeconds: 2 });
  return { ...f, server, received: () => received, setAction: (value: typeof action) => { action = value; }, release: () => release?.(), async close() { release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.service.close(); } };
}

test('模型草稿保留完整合同与精确原文，默认未采纳；编造锚点和取消不会保存草稿', async () => {
  const f = await modelFixture();
  try {
    const finding = f.review.findings[0]; assert.ok(finding);
    const input = { reviewId: f.review.id, findingId: finding.id, blockId: f.document.blocks[0].id, expectedRevision: 0 };
    let workspace = await f.service.generateChangeDraft(input, null);
    assert.deepEqual(f.received().contractBlocks, f.document.blocks.map(item => ({ id: item.id, text: item.text })));
    assert.equal(workspace.proposals[0].status, 'proposed'); assert.equal(workspace.proposals[0].modelId, 'synthetic-change-model');
    f.setAction('bad_anchor');
    await assert.rejects(f.service.generateChangeDraft({ ...input, expectedRevision: workspace.revision }, null), /目标或原文/);
    assert.equal((await f.service.getChanges(f.review.id)).proposals.length, 1);
    f.setAction('wait'); const previous = f.received();
    const running = f.service.generateChangeDraft({ ...input, expectedRevision: workspace.revision }, null);
    while (f.received() === previous) await new Promise(resolve => setTimeout(resolve, 5));
    await f.service.cancelChangeDraft(f.review.id); await assert.rejects(running, /取消/); f.release();
    assert.equal((await f.service.getChanges(f.review.id)).proposals.length, 1);
  } finally { await f.close(); }
});

test('模型已返回但仍在定位验证时取消，不把迟到草稿提交到存储', async t => {
  const f = await modelFixture();
  try {
    const original = f.service.getChanges.bind(f.service); let calls = 0;
    t.mock.method(f.service, 'getChanges', async (reviewId: string) => {
      const result = await original(reviewId);
      if (++calls === 2) await f.service.cancelChangeDraft(reviewId);
      return result;
    });
    await assert.rejects(f.service.generateChangeDraft({ reviewId: f.review.id, findingId: f.review.findings[0].id, blockId: f.document.blocks[0].id, expectedRevision: 0 }, null), /取消/);
    assert.equal(f.store.getChangeRevision(f.review.id), 0); assert.deepEqual(f.store.getChangeProposals(f.review.id), []);
  } finally { await f.close(); }
});

test('生成期间修改列表变化时拒绝迟到草稿，关闭服务会取消待完成生成', async () => {
  const f = await modelFixture(); let closed = false;
  try {
    const input = { reviewId: f.review.id, findingId: f.review.findings[0].id, blockId: f.document.blocks[0].id, expectedRevision: 0 };
    f.setAction('wait'); let previous = f.received(); const stale = f.service.generateChangeDraft(input, null);
    while (f.received() === previous) await new Promise(resolve => setTimeout(resolve, 5));
    await f.service.saveChange({ reviewId: f.review.id, findingId: null, blockId: f.document.blocks[1].id, expectedRevision: 0, replacementText: 'Payment follows written acceptance.' });
    f.release(); await assert.rejects(stale, /更新|变化/);
    assert.equal((await f.service.getChanges(f.review.id)).proposals.length, 1);
    previous = f.received(); const pending = f.service.generateChangeDraft({ ...input, expectedRevision: 1 }, null);
    while (f.received() === previous) await new Promise(resolve => setTimeout(resolve, 5));
    const rejected = assert.rejects(pending, /取消/); await f.service.close(); closed = true; await rejected;
  } finally {
    f.release(); f.server.closeAllConnections(); await new Promise<void>(resolve => f.server.close(() => resolve()));
    if (!closed) await f.service.close();
  }
});

const numberingHistory = '<w:ins w:id="77" w:author="Original reviewer" w:date="2020-01-02T03:04:05Z"/>';
const preservedPageBreak = '<w:br w:type="page"/>';
async function complexDocument() {
  return createDocx({ rawBody:
    '<w:p><w:r><w:t>服务付款应在</w:t></w:r><w:permStart w:id="1" w:edGrp="everyone"/><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>验收后</w:t></w:r><w:permEnd w:id="1"/><w:r><w:t>办理。</w:t></w:r></w:p>' +
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/>${numberingHistory}</w:numPr></w:pPr><w:r><w:t>保留编号历史的通知条款。</w:t></w:r></w:p>` +
    '<w:p><w:r><w:t>原有书签文字。</w:t></w:r><w:bookmarkStart w:id="2" w:name="OriginalBookmark"/><w:bookmarkEnd w:id="2"/></w:p>' +
    `<w:p><w:r><w:t>签署日期待确认。</w:t>${preservedPageBreak}</w:r></w:p>` });
}

test('复杂目标按片段保存和独立采纳，拒绝全段绕过，保留权限、格式、编号修订与分页', async () => {
  const f = await setup(await complexDocument()); let service = f.service;
  try {
    let workspace = await service.getChanges(f.review.id);
    assert.ok(workspace.targets.every(target => target.editable && target.editMode === 'segments'));
    const first = workspace.targets[0]; const fragments = first.segments!.filter(segment => segment.editable);
    assert.ok(fragments.length >= 2);
    const input = { reviewId: f.review.id, findingId: null, blockId: first.blockId, expectedRevision: workspace.revision, replacementText: `${fragments[0].text}（测试）` };
    await assert.rejects(service.saveChange(input), /选择|片段/);
    await assert.rejects(service.saveChange({ ...input, segmentId: 'invented-segment' }), /选择|片段/);
    for (const [index, segment] of fragments.slice(0, 2).entries()) {
      workspace = await service.saveChange({ ...input, segmentId: segment.id, expectedRevision: workspace.revision, replacementText: index === 0 ? `${segment.text}（测试1）` : `（测试2）${segment.text}` });
      const proposal = workspace.proposals.find(item => item.rangeStart === segment.rangeStart && item.rangeEnd === segment.rangeEnd)!;
      assert.equal(proposal.originalText, segment.text);
      assert.equal(proposal.originalTextSha256, sha(Buffer.from(segment.text)));
      workspace = await service.decideChange({ reviewId: f.review.id, proposalId: proposal.id, status: 'accepted', expectedRevision: workspace.revision });
    }
    const saved = workspace.proposals[0];
    await assert.rejects(service.saveChange({ ...input, proposalId: saved.id, segmentId: fragments[2].id, expectedRevision: workspace.revision }), /失效|选择/);
    const otherTarget = workspace.targets[1]; const otherSegment = otherTarget.segments!.find(item => item.editable)!;
    workspace = await service.saveChange({ reviewId: f.review.id, findingId: null, blockId: otherTarget.blockId, segmentId: otherSegment.id, expectedRevision: workspace.revision, replacementText: '这项修改不应进入导出。' });
    workspace = await service.decideChange({ reviewId: f.review.id, proposalId: workspace.proposals.find(item => item.blockId === otherTarget.blockId)!.id, status: 'rejected', expectedRevision: workspace.revision });
    const pageTarget = workspace.targets[3]; const locked = pageTarget.segments!.find(item => !item.editable)!;
    await assert.rejects(service.saveChange({ reviewId: f.review.id, findingId: null, blockId: pageTarget.blockId, segmentId: locked.id, expectedRevision: workspace.revision, replacementText: '不能移除分页。' }), /分页|保留|片段|只读/);
    const exported = await service.exportModified({ reviewId: f.review.id, expectedRevision: workspace.revision, filePath: join(f.output, '片段修改稿.docx') });
    const original = await JSZip.loadAsync(f.bytes); const changed = await JSZip.loadAsync(await readFile(exported.documentPath));
    const beforeXml = await original.file('word/document.xml')!.async('string'); const afterXml = await changed.file('word/document.xml')!.async('string');
    const stripText = (xml: string) => xml.replace(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/gu, '<w:t/>');
    assert.equal(stripText(beforeXml), stripText(afterXml));
    assert.ok(afterXml.includes(numberingHistory)); assert.ok(afterXml.includes(preservedPageBreak));
    const textNodes = [...afterXml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/gu)].map(match => match[1]);
    assert.equal(textNodes[0], `${fragments[0].text}（测试1）`);
    assert.equal(textNodes[1], `（测试2）${fragments[1].text}`, 'Prefix must stay inside the selected formatted text node and permission range');
    const parsed = await parseContract(exported.documentPath);
    assert.equal(parsed.blocks[0].text, `${fragments[0].text}（测试1）（测试2）${fragments[1].text}${fragments[2].text}`);
    assert.equal(parsed.blocks[1].text, f.document.blocks[1].text); assert.equal(parsed.blocks[3].text, f.document.blocks[3].text);
    assert.match(await readFile(exported.changeListPath, 'utf8'), /文字片段/);
    assert.equal(sha(await readFile(f.input)), sha(f.bytes)); assert.deepEqual(service.getReview(f.review.id), f.review);
    await service.close(); service = new ContractService(await AppStore.open(f.dataDir), f.dataDir);
    workspace = await service.getChanges(f.review.id); assert.equal(workspace.proposals.filter(item => item.status === 'accepted').length, 2);
    assert.equal(workspace.exports.length, 1); assert.deepEqual(workspace.proposals.find(item => item.id === saved.id)?.originalText, saved.originalText);
  } finally { await service.close(); }
});

test('模型仅改所选片段，取得整段上下文，未选择或虚构片段不会发出请求', async () => {
  const f = await modelFixture(await complexDocument());
  try {
    const workspace = await f.service.getChanges(f.review.id); const target = workspace.targets[0]; const segment = target.segments!.find(item => item.editable)!;
    const finding = f.review.findings.find(item => item.blockIds.includes(target.blockId)) ?? f.review.findings.find(item => item.blockIds.length === 0); assert.ok(finding);
    const input = { reviewId: f.review.id, findingId: finding.id, blockId: target.blockId, expectedRevision: workspace.revision };
    await assert.rejects(f.service.generateChangeDraft(input, null), /选择|片段/); assert.equal(f.received(), undefined);
    await assert.rejects(f.service.generateChangeDraft({ ...input, segmentId: 'invented-segment' }, null), /选择|片段/); assert.equal(f.received(), undefined);
    const updated = await f.service.generateChangeDraft({ ...input, segmentId: segment.id }, null);
    assert.equal(f.received().targetBlock.text, segment.text); assert.equal(f.received().targetBlock.paragraphText, target.text);
    assert.equal(f.received().targetBlock.scope, 'text_segment'); assert.deepEqual(f.received().contractBlocks, f.document.blocks.map(block => ({ id: block.id, text: block.text })));
    assert.equal(updated.proposals[0].rangeStart, segment.rangeStart); assert.equal(updated.proposals[0].rangeEnd, segment.rangeEnd);
    assert.equal(updated.proposals[0].originalText, segment.text); assert.equal(updated.proposals[0].status, 'proposed');
  } finally { await f.close(); }
});
