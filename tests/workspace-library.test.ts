import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { AppStore } from '../src/core/storage';
import { WorkspaceAssets } from '../src/core/workspace-assets';
import { assembleTemplate, getApplicableExperiences, getEffectiveReviewFindings, getReviewAnnotations, runLibraryCommand, type LibraryDeps } from '../src/core/workspace-library';
import { parseDocx } from '../src/core/documents';
import { defaultLibraryScope, type AnnotationAsset, type ExperienceAsset, type TemplateAsset, type TemplateRenderResult } from '../src/shared/library';
import type { ParsedContract, ReviewContext, ReviewResult, ReviewTask } from '../src/shared/contracts';
import type { ContractService } from '../src/core/service';
import type { ChangeProposal } from '../src/shared/changes';

const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '仅用于工程测试的虚构合同。' };
const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const saveInput = () => ({ expectedRevision: 0, actorLabel: '测试法务', name: '履约审核偏好', kind: 'preference', content: '依据明确的交付清单核对验收事项，不推定法定义务。', scope: defaultLibraryScope(), state: 'candidate', reason: '人工整理的测试偏好。', source: { kind: 'manual', reviewId: null, findingId: null, changeId: null } });
async function setup() { const dir = await mkdtemp(join(tmpdir(), 'law-library-')); const store = await AppStore.open(dir); const assets = new WorkspaceAssets(store); return { dir, store, assets, service: null as unknown as ContractService }; }
async function source(deps: LibraryDeps, paragraphs = ['服务合同', '甲方：{{甲方名称}}；乙方：{{乙方名称}}。', '付款币种：{{币种}}；价款：{{金额}}。']) {
  const parsed: ParsedContract = { format: 'docx', language: 'zh', pageCount: null, partial: false, warnings: [], blocks: paragraphs.map((text, ordinal) => ({ id: randomUUID(), ordinal, text, kind: 'paragraph', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: `/w:document[1]/w:body[1]/w:p[${ordinal + 1}]`, paragraphId: null } })) };
  const artifactSha = sha(paragraphs); const document = await deps.store.addDocument(randomUUID(), '虚构工程合同.docx', `documents/${randomUUID()}/original.docx`, 100, artifactSha, parsed);
  const task: ReviewTask = { id: randomUUID(), documentId: document.id, status: 'queued', stage: '工程测试', startedAt: new Date().toISOString(), finishedAt: null, resultId: null, error: null }; const run = await deps.store.createTask(task, context, 'local', null, null);
  const review: ReviewResult = { id: randomUUID(), documentId: document.id, createdAt: new Date().toISOString(), mode: 'local', modelId: null, summary: '测试合成审核摘要。', context, findings: [{ id: randomUUID(), blockIds: [parsed.blocks[1].id], quote: parsed.blocks[1].text, title: '确认主体信息', category: 'commercial', severity: 'high', description: '合成测试关注。', suggestion: '补充主体信息。', legalBasis: '未经核验的原始描述', basisStatus: 'unverified', source: 'model', origin: 'model', locationStatus: 'matched' }], coverage: { reviewedBlockIds: parsed.blocks.map(block => block.id), totalBlockCount: parsed.blocks.length, knowledgeStatus: 'user_disabled', webStatus: 'user_disabled', limitations: [] }, inputTokens: null, outputTokens: null, elapsedMs: 0 };
  await deps.store.saveReview(review, run); return { document, review, artifactSha };
}
async function close(value: Awaited<ReturnType<typeof setup>>) { await value.store.close(); await rm(value.dir, { recursive: true, force: true }); }
const command = <T = unknown>(deps: LibraryDeps, action: string, payload: unknown = {}) => runLibraryCommand(action, payload, deps) as Promise<T>;

test('经验须人工批准，按合同和项目范围复用，历史快照、停用、移除及回退均可追溯', async () => {
  const deps = await setup();
  try {
    const candidate = await command<ExperienceAsset>(deps, 'library.experience.save', saveInput()); assert.equal(getApplicableExperiences(deps, context).length, 0);
    const input = { ...saveInput(), id: candidate.id, expectedRevision: candidate.revision, state: 'approved' };
    await assert.rejects(command(deps, 'library.experience.save', input), /人工确认/);
    const approved = await command<ExperienceAsset>(deps, 'library.experience.save', { ...input, confirmed: true }); const frozen = getApplicableExperiences(deps, context);
    assert.equal(frozen.length, 1); assert.equal(frozen[0].revision, 2); assert.equal(frozen[0].contentSha256, sha(approved.body));
    const disabled = await command<ExperienceAsset>(deps, 'library.experience.save', { ...input, expectedRevision: 2, state: 'disabled', reason: '测试停用。' }); assert.equal(getApplicableExperiences(deps, context).length, 0); assert.equal(frozen[0].body.state, 'approved');
    await command(deps, 'library.asset.remove', { id: candidate.id, expectedRevision: disabled.revision, reason: '测试移除。', actorLabel: '测试法务' }); assert.equal((await command<ExperienceAsset[]>(deps, 'library.experience.list')).length, 0);
    assert.equal((await command<ExperienceAsset[]>(deps, 'library.experience.list', { includeDeleted: true }))[0].deleted, true);
    const restored = await command<ExperienceAsset>(deps, 'library.asset.rollback', { id: candidate.id, expectedRevision: 4, revision: 2, reason: '从已批准历史恢复为候选。', actorLabel: '测试法务' }); assert.equal(restored.body.state, 'candidate'); assert.equal(restored.deleted, false); assert.equal(restored.body.approvedAt, null); assert.equal(getApplicableExperiences(deps, context).length, 0);
    const project = await command<ExperienceAsset>(deps, 'library.experience.save', { ...saveInput(), name: '项目甲', state: 'approved', confirmed: true, scope: { ...defaultLibraryScope(), level: 'project', projectId: 'project-A', contractTypes: ['service'], partyRoles: ['service_recipient'] } });
    assert.equal(getApplicableExperiences(deps, context).length, 0); assert.equal(getApplicableExperiences(deps, { ...context, projectId: 'project-B' }).length, 0); assert.equal(getApplicableExperiences(deps, { ...context, projectId: 'project-A' })[0].id, project.id); assert.equal(getApplicableExperiences(deps, { ...context, contractType: 'procurement', projectId: 'project-A' }).length, 0);
    const records = await command<ExperienceAsset[]>(deps, 'library.asset.history', { id: candidate.id }); assert.equal(records.length, 5); assert.equal(records[1].body.state, 'approved');
    await deps.store.close(); deps.store = await AppStore.open(deps.dir); deps.assets = new WorkspaceAssets(deps.store); assert.equal(deps.assets.history(candidate.id).length, 5); assert.equal(getApplicableExperiences(deps, { ...context, projectId: 'project-A' }).length, 1);
  } finally { await close(deps); }
});

test('来源风险与修改必须属于当前审核，来源版本摘要不能伪造', async () => {
  const deps = await setup(); try {
    const first = await source(deps), second = await source(deps); const input = { ...saveInput(), source: { kind: 'finding', reviewId: first.review.id, findingId: first.review.findings[0].id, changeId: null } };
    const experience = await command<ExperienceAsset>(deps, 'library.experience.save', input); assert.equal(experience.body.source.documentId, first.document.id); assert.equal(experience.body.source.contentSha256, sha(first.review.findings[0]));
    await assert.rejects(command(deps, 'library.experience.save', { ...input, source: { ...input.source, findingId: second.review.findings[0].id } }), /不属于/);
    await assert.rejects(command(deps, 'library.experience.save', { ...input, source: { ...input.source, kind: 'manual' } }), /冒用/);
    await assert.rejects(command(deps, 'library.experience.save', { ...saveInput(), content: 'bad\u0000value' }), /无效/);
    await assert.rejects(command(deps, 'library.experience.save', { ...saveInput(), scope: { ...defaultLibraryScope(), level: 'project', projectId: null } }), /项目/);
    const outcomes = await Promise.allSettled([command(deps, 'library.experience.save', { ...saveInput(), id: experience.id, expectedRevision: 1 }), command(deps, 'library.experience.save', { ...saveInput(), id: experience.id, expectedRevision: 1 })]); assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1); assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  } finally { await close(deps); }
});

async function accepted(deps: LibraryDeps, fixture: Awaited<ReturnType<typeof source>>, after = '修改后的相同条款') {
  const block = fixture.document.blocks[1], originalText = block.text; const proposal: ChangeProposal = { id: randomUUID(), reviewId: fixture.review.id, documentId: fixture.document.id, findingId: fixture.review.findings[0].id, blockId: block.id, rangeStart: 0, rangeEnd: originalText.length, originalText, replacementText: after, sourceFileSha256: fixture.artifactSha, originalTextSha256: sha(originalText), status: 'proposed', explanation: '测试修改。', warnings: [], modelId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await deps.store.saveChangeProposal(proposal, 0); await deps.store.decideChangeProposal(fixture.review.id, proposal.id, 'accepted', 1); return proposal;
}
test('重复采纳仅在不同文档且文字完全相同时生成一次候选，从不自动批准', async () => {
  const deps = await setup(); try {
    const first = await source(deps), second = await source(deps); await accepted(deps, first); assert.equal((await command<{ created: ExperienceAsset[] }>(deps, 'library.experience.suggest', { actorLabel: '测试法务', scope: defaultLibraryScope() })).created.length, 0);
    const last = await accepted(deps, second); const result = await command<{ created: ExperienceAsset[] }>(deps, 'library.experience.suggest', { actorLabel: '测试法务', scope: defaultLibraryScope() }); assert.equal(result.created.length, 1); assert.equal(result.created[0].body.state, 'candidate'); assert.equal(result.created[0].body.source.changeId, last.id); assert.equal(getApplicableExperiences(deps, context).length, 0);
    assert.equal((await command<{ created: ExperienceAsset[] }>(deps, 'library.experience.suggest', { actorLabel: '测试法务', scope: defaultLibraryScope() })).created.length, 0);
    const third = await source(deps); await accepted(deps, third, '不同的修改内容'); assert.equal((await command<{ created: ExperienceAsset[] }>(deps, 'library.experience.suggest', { actorLabel: '测试法务', scope: defaultLibraryScope() })).created.length, 0);
  } finally { await close(deps); }
});

async function template(deps: LibraryDeps) {
  const fixture = await source(deps); const candidate = await command<TemplateAsset>(deps, 'library.template.createFromDocument', { documentId: fixture.document.id, name: '服务合同模板', language: 'zh', actorLabel: '测试法务', scope: defaultLibraryScope() });
  const approved = await command<TemplateAsset>(deps, 'library.template.save', { id: candidate.id, expectedRevision: 1, body: { ...candidate.body, state: 'approved', reason: '人工确认模板适用于测试交易。' }, confirmed: true }); return { fixture, candidate, approved };
}
test('模板从原文建立来源快照，批准后只做字面字段装配，缺失字段保留占位', async () => {
  const deps = await setup(); try {
    const { candidate, approved, fixture } = await template(deps); assert.equal(candidate.body.state, 'candidate'); assert.equal(approved.body.source.fileSha256, fixture.artifactSha); assert.equal(approved.body.fields.length, 4);
    const base = { templateId: approved.id, expectedRevision: 2, fields: { 甲方名称: '虚构甲方', 币种: '人民币', 金额: '100.00' }, clauseIds: [], actorLabel: '测试法务' };
    assert.throws(() => assembleTemplate(candidate, { ...base, expectedRevision: 1 }), /未批准/);
    const assembled = assembleTemplate(approved, base); assert.deepEqual(assembled.missingInformation, ['待填写：乙方名称']); assert.match(assembled.draft.clauses[0].paragraphs[1], /虚构甲方/); assert.match(assembled.draft.clauses[0].paragraphs[1], /\{\{乙方名称\}\}/); assert.equal(assembled.sourceSnapshot.revision, 2); assert.equal(assembled.sourceSnapshot.contentSha256, sha(approved.body));
    const literal = assembleTemplate(approved, { ...base, fields: { ...base.fields, 金额: '${process.exit(1)}' } }); assert.match(literal.draft.clauses[0].paragraphs[2], /\$\{process.exit\(1\)\}/);
    const prototypeField: TemplateAsset = { ...approved, body: { ...approved.body, title: '{{constructor}}', paragraphs: ['{{toString}}'], fields: ['constructor', 'toString'].map(key => ({ key, label: key, required: true })) } };
    const inert = assembleTemplate(prototypeField, { ...base, fields: {} }); assert.equal(inert.missingInformation.length, 2); assert.equal(inert.draft.title, '{{constructor}}');
    const named = assembleTemplate(prototypeField, { ...base, fields: Object.fromEntries([['constructor', '普通字段'], ['toString', '字面值']]) }); assert.equal(named.draft.title, '普通字段'); assert.equal(named.draft.clauses[0].paragraphs[0], '字面值');
    assert.throws(() => assembleTemplate({ ...prototypeField, body: { ...prototypeField.body, title: '{{__proto__}}' } }, { ...base, fields: {} }), /保留名称/);
    assert.throws(() => assembleTemplate(approved, { ...base, expectedRevision: 1 }), /已更新/); assert.throws(() => assembleTemplate(approved, { ...base, fields: { 任意字段: '越界' } }), /不属于/);
    await assert.rejects(command(deps, 'library.template.save', { id: approved.id, expectedRevision: 2, body: { ...approved.body, source: { ...approved.body.source, fileSha256: '0'.repeat(64) } }, confirmed: true }), /来源不可改写/);
    assert.equal(deps.store.getDocument(fixture.document.id).blocks[1].text, fixture.document.blocks[1].text); assert.equal(deps.assets.history(candidate.id).length, 2);
  } finally { await close(deps); }
});

test('模板附加条款须批准并匹配范围，DOCX 导出安全转义且原文回读一致', async () => {
  const deps = await setup(); try {
    const { approved } = await template(deps); const clause = await command<ExperienceAsset>(deps, 'library.experience.save', { ...saveInput(), name: '条款示例', kind: 'clause', content: '附加条款：{{业务选择}}；文字 <w:ins> & "example"。', state: 'approved', confirmed: true });
    const input = { templateId: approved.id, expectedRevision: 2, fields: { 甲方名称: '<虚构甲方>&', 乙方名称: 'Virtual B', 币种: 'THB', 金额: '100', 业务选择: '人工确认项' }, clauseIds: [clause.id], actorLabel: '测试法务' };
    const result = await command<TemplateRenderResult>(deps, 'library.template.render', input); assert.equal(result.sourceSnapshot.clauses[0].id, clause.id); assert.deepEqual(result.missingInformation, []);
    const bytes = Buffer.from(result.docxBase64, 'base64'); const parsed = await parseDocx(bytes); assert.equal(parsed.partial, false); assert.ok(parsed.blocks.some(block => block.text.includes('<虚构甲方>&'))); assert.ok(parsed.blocks.some(block => block.text.includes('文字 <w:ins> & "example"。')));
    const zip = await JSZip.loadAsync(bytes); const xml = await zip.file('word/document.xml')!.async('string'); assert.ok(xml.includes('&lt;w:ins&gt;')); assert.ok(!xml.includes('<w:ins>')); assert.ok(!Object.keys(zip.files).some(name => /vba|macro|externalLink/iu.test(name)));
    await assert.rejects(command(deps, 'library.template.render', { ...input, clauseIds: [clause.id, clause.id] }), /重复/);
    const candidate = await command<ExperienceAsset>(deps, 'library.experience.save', { ...saveInput(), name: '未批准条款', kind: 'clause' }); await assert.rejects(command(deps, 'library.template.render', { ...input, clauseIds: [candidate.id], fields: {} }), /尚未批准/);
    const project = await command<ExperienceAsset>(deps, 'library.experience.save', { ...saveInput(), kind: 'clause', state: 'approved', confirmed: true, scope: { ...defaultLibraryScope(), level: 'project', projectId: 'A' } }); await assert.rejects(command(deps, 'library.template.render', { ...input, fields: {}, clauseIds: [project.id] }), /不适用/);
  } finally { await close(deps); }
});

test('人工补录和修订不改写原报告，原因、类别、关注等级、原文定位和历史独立保存', async () => {
  const deps = await setup(); try {
    const fixture = await source(deps), other = await source(deps); const before = JSON.stringify(deps.store.getReview(fixture.review.id));
    const input = { expectedRevision: 0, actorLabel: '测试法务', reviewId: fixture.review.id, findingId: fixture.review.findings[0].id, title: '人工修订标题', category: 'legal', severity: 'medium', description: '人工重新分析事项。', suggestion: '建议人工补充确认。', blockIds: [fixture.document.blocks[1].id], quote: fixture.document.blocks[1].text, reason: '原意见表述需要修订。', state: 'active' };
    const annotation = await command<AnnotationAsset>(deps, 'library.annotation.save', input); const effective = getEffectiveReviewFindings(deps, fixture.review.id); assert.equal(effective.length, 1); assert.equal(effective[0].finding.title, input.title); assert.equal(effective[0].finding.severity, 'medium'); assert.equal(effective[0].finding.locationStatus, 'matched'); assert.equal(effective[0].originalFinding?.severity, 'high'); assert.equal(effective[0].finding.origin, undefined); assert.equal(effective[0].finding.legalBasis, null); assert.deepEqual(effective[0].finding.citations, []); assert.equal(effective[0].annotation?.revision, 1);
    await assert.rejects(command(deps, 'library.annotation.save', input), /已有有效人工意见/);
    await assert.rejects(command(deps, 'library.annotation.save', { ...input, findingId: null, blockIds: [other.document.blocks[0].id] }), /不属于/);
    await assert.rejects(command(deps, 'library.annotation.save', { ...input, findingId: other.review.findings[0].id }), /不属于/);
    await assert.rejects(command(deps, 'library.annotation.save', { ...input, findingId: null, reason: ' ' }), /无效/);
    const addition = await command<AnnotationAsset>(deps, 'library.annotation.save', { ...input, findingId: null, quote: '不在原文中的摘录', reason: '补录漏检。' }); assert.equal(getEffectiveReviewFindings(deps, fixture.review.id).length, 2); assert.equal(getEffectiveReviewFindings(deps, fixture.review.id).at(-1)?.finding.locationStatus, 'unmatched');
    const changed = await command<AnnotationAsset>(deps, 'library.annotation.save', { ...input, id: annotation.id, expectedRevision: 1, severity: 'low', reason: '第二次人工修订。' }); assert.equal(changed.revision, 2); assert.equal(deps.assets.history(annotation.id)[0].body.severity, 'medium');
    await command(deps, 'library.asset.rollback', { id: annotation.id, expectedRevision: 2, revision: 1, actorLabel: '测试法务', reason: '回退为停用状态待确认。' }); assert.equal(getEffectiveReviewFindings(deps, fixture.review.id)[0].finding.title, fixture.review.findings[0].title); assert.equal(getReviewAnnotations(deps, fixture.review.id).find(item => item.id === annotation.id)?.body.state, 'disabled');
    assert.equal(JSON.stringify(deps.store.getReview(fixture.review.id)), before); assert.equal(addition.body.originalReviewSha256, sha(fixture.review)); assert.equal(deps.store.getRiskDispositions(fixture.review.id).revision, 0);
  } finally { await close(deps); }
});

test('经验明确覆盖绑定目标版本，目标更新须重新人工确认，法律约束不可配置放宽',async()=>{const deps=await setup();try{
 const policy={conflictKey:'payment.prepayment',domain:'business' as const,effect:'tighten' as const,override:{targetIds:[] as string[],reason:''}};const base={...saveInput(),scope:{...defaultLibraryScope(),level:'enterprise' as const},state:'approved',confirmed:true,policy};
 const first=await command<ExperienceAsset>(deps,'library.experience.save',{...base,name:'企业旧关注'});
 const candidate=await command<ExperienceAsset>(deps,'library.experience.save',{...base,name:'特定企业关注',state:'candidate',policy:{...policy,override:{targetIds:[first.id],reason:'人工明确覆盖同范围旧关注'}}});assert.equal(candidate.body.policy!.override.targetRevisions![first.id],first.revision);
 const second=await command<ExperienceAsset>(deps,'library.experience.save',{...base,id:candidate.id,expectedRevision:1,name:candidate.body.name,policy:candidate.body.policy});assert.deepEqual(getApplicableExperiences(deps,context).map(value=>value.id),[second.id]);
 await command(deps,'library.experience.save',{...base,id:first.id,expectedRevision:1,name:first.body.name,content:'新的人工关注内容。'});
 const resolution=await command<{selected:unknown[];conflicts:unknown[]}>(deps,'library.experience.resolve',{contractType:context.contractType,ourPartyRole:context.ourPartyRole});assert.equal(resolution.selected.length,0);assert.equal(resolution.conflicts.length,1);
 await assert.rejects(command(deps,'library.experience.save',{...base,id:second.id,expectedRevision:2,name:second.body.name,policy:second.body.policy}),/目标版本已变化/);
 await assert.rejects(command(deps,'library.experience.save',{...base,policy:{...policy,domain:'legal_guardrail',effect:'relax'}}),/法律约束/);
 }finally{await close(deps);}});
