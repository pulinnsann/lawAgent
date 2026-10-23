import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { z } from 'zod';
import type { ContractDetail, ReviewContext, ReviewFinding } from '../shared/contracts';
import type { ContractDraft } from '../shared/generation';
import type { AnnotationAsset, AnnotationBody, EffectiveReviewFinding, ExperienceAsset, ExperienceBody, ExperienceSnapshot, LibraryAsset, LibraryScope, LibrarySource, TemplateAsset, TemplateBody, TemplateRenderInput, TemplateRenderResult } from '../shared/library';
import { defaultLibraryScope } from '../shared/library';
import type { AppStore } from './storage';
import type { ContractService } from './service';
import type { WorkspaceAssets } from './workspace-assets';
import { parseDocx } from './documents';
import { runAdvisorCommand } from './workspace-advisor';
import { defaultExperiencePolicy, experiencePolicySchema, resolveExperiencePolicy } from './workspace-experience-policy';

export interface LibraryDeps { store: AppStore; service: ContractService; assets: WorkspaceAssets }
const EXPERIENCE = 'library_experience', TEMPLATE = 'library_template', ANNOTATION = 'library_annotation';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
const validText = (text: string, multiline = false) => [...text].every(char => { const code = char.codePointAt(0)!; return (multiline && [9, 10, 13].includes(code)) || (code >= 32 && code !== 127 && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff); });
const line = (max: number) => z.string().trim().min(1).max(max).refine(value => validText(value));
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => validText(value, true));
const id = z.string().uuid();
const scopeSchema = z.object({ level: z.enum(['personal', 'enterprise', 'project']), projectId: line(120).nullable(), contractTypes: z.array(z.enum(['procurement', 'service', 'other'])).min(1).max(3), partyRoles: z.array(z.enum(['buyer', 'seller', 'service_provider', 'service_recipient', 'other'])).min(1).max(5) }).strict().refine(scope => scope.level === 'project' ? Boolean(scope.projectId) : scope.projectId === null, '项目经验必须填写项目标识，其他范围不接受项目标识');
const baseSave = { id: id.optional(), expectedRevision: z.number().int().min(0), actorLabel: line(80) };
const saveExperienceSchema = z.object({ ...baseSave, name: line(160), kind: z.enum(['preference', 'rule', 'clause']), content: text(12000), scope: scopeSchema, state: z.enum(['candidate', 'approved', 'disabled']), reason: text(2000), policy: experiencePolicySchema.optional(), confirmed: z.boolean().optional(), source: z.object({ kind: z.enum(['manual', 'review', 'finding', 'change']), reviewId: id.nullable(), findingId: id.nullable(), changeId: id.nullable() }).strict() }).strict();
const sourceRequired = (value: string | null, name: string): string => { if (!value) throw new Error(`请提供${name}。`); return value; };
function asset<T>(deps: LibraryDeps, identifier: string, kind: string, includeDeleted = false): LibraryAsset<T> { const value = deps.assets.get(identifier); if (value.kind !== kind || value.deleted && !includeDeleted) throw new Error('记录不存在、已移除或类型不匹配。'); return value as LibraryAsset<T>; }
function list<T>(deps: LibraryDeps, kind: string, includeDeleted = false): LibraryAsset<T>[] { return deps.assets.list(kind, includeDeleted).filter(item => includeDeleted || !item.deleted) as LibraryAsset<T>[]; }
function checked<T>(schema: z.ZodType<T>, payload: unknown): T { const result = schema.safeParse(payload); if (!result.success) throw new Error(`输入不完整或格式无效：${result.error.issues.map(item => `${item.path.join('.')} ${item.message}`).slice(0, 4).join('；')}`); return result.data; }
function within(scope: LibraryScope, context: Pick<ReviewContext, 'contractType' | 'ourPartyRole'> & { projectId?: string | null }): boolean { return scope.contractTypes.includes(context.contractType) && scope.partyRoles.includes(context.ourPartyRole) && (scope.level !== 'project' || Boolean(context.projectId) && scope.projectId === context.projectId); }
function sourceSnapshot(deps: LibraryDeps, input: z.infer<typeof saveExperienceSchema>['source'], content: string): LibrarySource {
  if (input.kind === 'manual') { if (input.reviewId || input.findingId || input.changeId) throw new Error('手工经验不得冒用审核来源。'); return { ...input, documentId: null, contentSha256: digest(content), excerpt: content.slice(0, 2000) }; }
  const review = deps.store.getReview(sourceRequired(input.reviewId, '来源审核'));
  if (input.kind === 'review') { if (input.findingId || input.changeId) throw new Error('审核来源信息不匹配。'); return { ...input, documentId: review.documentId, contentSha256: digest(review), excerpt: review.summary.slice(0, 2000) }; }
  const finding = review.findings.find(item => item.id === input.findingId);
  if (input.kind === 'finding') { if (!finding || input.changeId) throw new Error('来源风险不属于所选审核。'); return { ...input, documentId: review.documentId, contentSha256: digest(finding), excerpt: `${finding.title}\n${finding.quote}\n${finding.suggestion}`.slice(0, 2000) }; }
  const change = deps.store.getChangeProposals(review.id).find(item => item.id === input.changeId);
  if (!change || change.documentId !== review.documentId || input.findingId !== change.findingId) throw new Error('来源修改不属于所选审核或风险。');
  return { ...input, documentId: review.documentId, contentSha256: digest(change), excerpt: `${change.originalText}\n→\n${change.replacementText}`.slice(0, 2000) };
}
export function getExperienceResolution(deps: Pick<LibraryDeps, 'assets'>, context: Pick<ReviewContext, 'contractType' | 'ourPartyRole'> & { projectId?: string | null; taskRequirements?: import('../shared/library').TaskExperienceRequirement[] }) {
  return resolveExperiencePolicy(deps.assets.list(EXPERIENCE) as ExperienceAsset[], context);
}
export function getApplicableExperiences(deps: Pick<LibraryDeps, 'assets'>, context: Pick<ReviewContext, 'contractType' | 'ourPartyRole'> & { projectId?: string | null; taskRequirements?: import('../shared/library').TaskExperienceRequirement[] }): ExperienceSnapshot[] { return getExperienceResolution(deps, context).selected; }
export function getReviewAnnotations(deps: Pick<LibraryDeps, 'assets' | 'store'>, reviewId: string): AnnotationAsset[] { deps.store.getReview(reviewId); return (deps.assets.list(ANNOTATION) as AnnotationAsset[]).filter(value => !value.deleted && value.body.reviewId === reviewId); }
export function getEffectiveReviewFindings(deps: Pick<LibraryDeps, 'assets' | 'store'>, reviewId: string): EffectiveReviewFinding[] {
  const review = deps.store.getReview(reviewId); const annotations = getReviewAnnotations(deps, reviewId).filter(value => value.body.state === 'active');
  const convert = (annotation: AnnotationAsset, original: ReviewFinding | null): EffectiveReviewFinding => {
    const body = annotation.body;
    return { originalFinding: original, annotation, finding: { id: original?.id ?? `annotation:${annotation.id}`, blockIds: body.blockIds, quote: body.quote, title: body.title, category: body.category, severity: body.severity, description: body.description, suggestion: body.suggestion, legalBasis: null, basisStatus: 'unverified', citations: [], source: 'rule', checkKey: `annotation:${annotation.id}:r${annotation.revision}`, calculation: null, locationStatus: body.blockIds.some(blockId => deps.store.getDocument(body.documentId).blocks.find(block => block.id === blockId)?.text.includes(body.quote)) && Boolean(body.quote) ? 'matched' : 'unmatched' } };
  };
  return [...review.findings.map(finding => { const amendment = annotations.filter(item => item.body.findingId === finding.id).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1); return amendment ? convert(amendment, finding) : { finding, originalFinding: finding, annotation: null }; }), ...annotations.filter(item => item.body.findingId === null).map(item => convert(item, null))];
}

const placeholder = /\{\{\s*([^{}\r\n]{1,80}?)\s*\}\}/gu;
const templateLabels = {
  zh: { missing: '待补充或确认的信息', missingItem: '待填写：', appendix: '模板来源与装配说明', terms: '合同正文', review: '交易条件、占位信息及所选条款的适用性须由法务确认后使用。', source: '由人工批准的模板装配，未调用模型或检索法律。原文件格式不随模板文字复制。', version: '模板版本', file: '来源文件摘要', clause: '附加条款' },
  en: { missing: 'Information to complete or confirm', missingItem: 'To complete: ', appendix: 'Template source and assembly notes', terms: 'Contract terms', review: 'Legal counsel must confirm the transaction terms, placeholders and applicability of selected clauses before use.', source: 'Assembled from a manually approved template without model calls or legal searches. Original file formatting is not copied.', version: 'Template version', file: 'Source file hash', clause: 'Additional clause' },
  th: { missing: 'ข้อมูลที่ต้องเพิ่มเติมหรือยืนยัน', missingItem: 'ต้องกรอก: ', appendix: 'แหล่งที่มาของแม่แบบและหมายเหตุ', terms: 'ข้อกำหนดสัญญา', review: 'ที่ปรึกษากฎหมายต้องยืนยันเงื่อนไขธุรกรรม ข้อมูลที่ยังไม่ครบ และความเหมาะสมของข้อสัญญาที่เลือกก่อนใช้งาน', source: 'ประกอบจากแม่แบบที่ได้รับการยืนยันโดยมนุษย์ โดยไม่เรียกโมเดลหรือค้นกฎหมาย และไม่คัดลอกรูปแบบของไฟล์ต้นฉบับ', version: 'รุ่นแม่แบบ', file: 'ค่าแฮชไฟล์ต้นฉบับ', clause: 'ข้อสัญญาเพิ่มเติม' },
};
export function templateFields(paragraphs: string[]): string[] { return [...new Set(paragraphs.flatMap(value => [...value.matchAll(placeholder)].map(match => match[1].trim())))]; }
function validateTemplate(body: TemplateBody): TemplateBody {
  const value = checked(z.object({ name: line(160), title: line(200), language: z.enum(['zh', 'en', 'th']), scope: scopeSchema, paragraphs: z.array(line(6000)).min(1).max(380), fields: z.array(z.object({ key: line(80), label: line(120), required: z.boolean() }).strict()).max(80), state: z.enum(['candidate', 'approved', 'disabled']), reason: text(2000), actorLabel: line(80), approvedAt: z.string().nullable(), source: z.object({ documentId: id, fileSha256: z.string().regex(/^[a-f0-9]{64}$/), paragraphsSha256: z.string().regex(/^[a-f0-9]{64}$/), name: line(200), importedAt: z.string() }).strict() }).strict(), body);
  if (value.paragraphs.reduce((n, item) => n + item.length, value.title.length) > 90000) throw new Error('模板文字超过90000字符。');
  const keys = templateFields([value.title, ...value.paragraphs]);
  if (keys.includes('__proto__')) throw new Error('字段名 __proto__ 为保留名称，请更换字段名。');
  if (keys.length > 80 || new Set(value.fields.map(item => item.key)).size !== value.fields.length || keys.some(key => !value.fields.some(field => field.key === key)) || value.fields.some(field => !keys.includes(field.key))) throw new Error('字段必须与 {{字段名}} 占位符一一对应，最多80个。');
  return value;
}
export function assembleTemplate(template: TemplateAsset, input: TemplateRenderInput, clauses: ExperienceSnapshot[] = []): Omit<TemplateRenderResult, 'docxBase64' | 'filename'> {
  if (template.deleted || template.body.state !== 'approved' || template.revision !== input.expectedRevision) throw new Error('模板未批准、已更新或已移除，请刷新并重新确认。');
  const body = validateTemplate(template.body); const context = { contractType: input.contractType ?? body.scope.contractTypes[0], ourPartyRole: input.ourPartyRole ?? body.scope.partyRoles[0], projectId: input.projectId };
  if (!within(body.scope, context)) throw new Error('当前合同类型、我方立场或项目与模板范围不匹配。');
  if (body.scope.level === 'project' && body.scope.projectId !== input.projectId) throw new Error('当前项目与模板范围不匹配。');
  const allText = [body.title, ...body.paragraphs, ...clauses.map(value => value.body.content)];
  for (const clause of clauses) if (clause.body.kind !== 'clause' || clause.body.state !== 'approved' || !within(clause.body.scope, context)) throw new Error('条款尚未批准或不适用于模板范围。');
  const keys = templateFields(allText); const provided = checked(z.record(z.string(), z.string().max(6000).refine(value => validText(value))), input.fields);
  if (Object.keys(provided).some(key => !keys.includes(key))) throw new Error('填写的字段不属于当前模板及所选条款。');
  const valueFor = (key: string): string => Object.hasOwn(provided, key) && typeof provided[key] === 'string' ? provided[key].trim() : '';
  const words = templateLabels[body.language];
  const missingInformation = keys.filter(key => !valueFor(key)).map(key => `${words.missingItem}${body.fields.find(item => item.key === key)?.label ?? key}`);
  const substitute = (value: string) => value.replace(placeholder, (whole, key: string) => valueFor(key.trim()) || whole);
  const paragraphs = [...body.paragraphs.map(substitute), ...clauses.flatMap(value => value.body.content.split(/\r?\n/u).filter(Boolean).map(substitute))];
  if (paragraphs.length > 400 || paragraphs.reduce((n, item) => n + item.length, 0) > 95000 || paragraphs.some(value => value.length > 6000)) throw new Error('装配结果超过400段、单段6000字或95000字上限，请缩减模板或字段。');
  const assembledAt = stamp(); const sourceSnapshot = { templateId: template.id, revision: template.revision, contentSha256: digest(body), source: body.source, clauses, fieldValuesSha256: digest(provided), assembledAt };
  const title = substitute(body.title);
  if (title.length > 200) throw new Error('装配后的合同标题超过200字，请缩短标题或字段内容。');
  const draft: ContractDraft = { id: randomUUID(), title, language: body.language, createdAt: assembledAt, modelId: 'deterministic-template', request: { requestId: '', description: `由人工批准的企业模板确定性装配；模板${template.id}，修订${template.revision}。`, language: body.language, contractType: context.contractType, ourPartyRole: context.ourPartyRole }, clauses: [{ heading: words.terms, paragraphs }], missingInformation, warnings: [words.source, `${words.version}: ${template.id} r${template.revision}; SHA-256: ${sourceSnapshot.contentSha256}`, words.review], inputTokens: null, outputTokens: null }; draft.request.requestId = draft.id;
  return { draft, sourceSnapshot, missingInformation };
}
const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
/** Deterministic template exporter: text-only; no source OOXML, macros, URLs or executable expressions are copied. */
export async function buildTemplateContractDocx(draft: ContractDraft, snapshot: TemplateRenderResult['sourceSnapshot']): Promise<Buffer> {
  const words = templateLabels[draft.language];
  const lines = [draft.title, ...draft.clauses.flatMap(clause => clause.paragraphs), ...(draft.missingInformation.length ? [words.missing, ...draft.missingInformation] : []), words.appendix, ...draft.warnings, `${words.file}: ${snapshot.source.fileSha256}`, ...snapshot.clauses.map(value => `${words.clause}: ${value.body.name}; ${value.id} r${value.revision}; SHA-256: ${value.contentSha256}`)];
  if (lines.some(value => !validText(value) || value.length > 6000)) throw new Error('装配结果存在无效文字。');
  const zip = new JSZip(), ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${ns}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:color w:val="000000"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="000000"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="000000"/></w:rPr></w:style></w:styles>`);
  const paragraph = (value: string, index: number) => `<w:p><w:pPr><w:pStyle w:val="${index === 0 ? 'Title' : value === words.missing || value === words.appendix ? 'Heading1' : 'Normal'}"/><w:spacing w:after="120" w:line="360" w:lineRule="atLeast"/><w:widowControl/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="SimSun" w:cs="Tahoma"/>${draft.language === 'th' ? '<w:cs/>' : ''}<w:color w:val="000000"/><w:sz w:val="${index === 0 ? '32' : '24'}"/><w:szCs w:val="${index === 0 ? '32' : '24'}"/><w:lang w:val="${{ zh: 'zh-CN', en: 'en-US', th: 'th-TH' }[draft.language]}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(value)}</w:t></w:r></w:p>`;
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${ns}"><w:body>${lines.map(paragraph).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }); const parsed = await parseDocx(bytes);
  if (parsed.partial || parsed.blocks.length !== lines.length || parsed.blocks.some((block, index) => block.text !== lines[index])) throw new Error('模板导出回读校验失败。');
  return bytes;
}

export async function runLibraryCommand(action: string, payload: unknown, deps: LibraryDeps): Promise<unknown> {
  if (action.startsWith('library.advisor.')) return runAdvisorCommand(action,payload,deps);
  switch (action) {
    case 'library.experience.resolve': { const input = checked(z.object({ contractType: z.enum(['procurement','service','other']), ourPartyRole: z.enum(['buyer','seller','service_provider','service_recipient','other']), projectId: z.string().max(120).nullable().optional(), taskRequirements: z.array(z.object({ id: line(120), conflictKey: line(100), content: text(4000), effect: z.enum(['supplement','tighten','relax']) }).strict()).max(30).optional() }).strict(), payload); return getExperienceResolution(deps,input); }
    case 'library.experience.list': { const input = checked(z.object({ includeDeleted: z.boolean().optional() }).strict(), payload); return list<ExperienceBody>(deps, EXPERIENCE, input.includeDeleted); }
    case 'library.experience.save': {
      const input = checked(saveExperienceSchema, payload); const previous = input.id ? asset<ExperienceBody>(deps, input.id, EXPERIENCE) : null;
      if (input.state === 'approved' && !input.confirmed) throw new Error('批准经验前请明确人工确认其内容与范围。');
      const source = sourceSnapshot(deps, input.source, input.content);
      const policy = input.policy ?? defaultExperiencePolicy();
      for (const targetId of policy.override.targetIds) { const target = asset<ExperienceBody>(deps, targetId, EXPERIENCE); if(input.state==='approved'&&policy.override.targetRevisions?.[targetId]!==target.revision)throw new Error('覆盖目标版本已变化或未明确，请重新选择目标并人工确认。'); if (targetId === input.id || target.body.policy?.conflictKey !== policy.conflictKey || target.body.policy?.domain === 'legal_guardrail') throw new Error('覆盖目标必须为同冲突键的其他业务经验，法律约束不能被覆盖。'); const rank = { personal: 1, enterprise: 2, project: 3 }; if (rank[input.scope.level] < rank[target.body.scope.level]) throw new Error('低优先范围不能覆盖高优先范围。'); }
      if(input.state!=='approved'&&policy.override.targetIds.length)policy.override.targetRevisions=Object.fromEntries(policy.override.targetIds.map(targetId=>[targetId,asset<ExperienceBody>(deps,targetId,EXPERIENCE).revision]));
      const body: ExperienceBody = { name: input.name, kind: input.kind, content: input.content, scope: input.scope, state: input.state, source, policy, reason: input.reason, actorLabel: input.actorLabel, approvedAt: input.state === 'approved' ? stamp() : null, ...(previous?.body.suggestionKey ? { suggestionKey: previous.body.suggestionKey } : {}) };
      return deps.assets.save({ id: input.id, kind: EXPERIENCE, expectedRevision: input.expectedRevision, body, actorLabel: input.actorLabel });
    }
    case 'library.experience.suggest': {
      const input = checked(z.object({ actorLabel: line(80), scope: scopeSchema }).strict(), payload); const existing = list<ExperienceBody>(deps, EXPERIENCE, true); const groups = new Map<string, Array<{ reviewId: string; documentId: string; changeId: string; findingId: string | null; before: string; after: string; updatedAt: string }>>();
      for (const summary of deps.store.listDocuments()) for (const review of deps.store.getDocument(summary.id).reviews) for (const change of deps.store.getChangeProposals(review.id).filter(item => item.status === 'accepted')) {
        if (!within(input.scope, review.context)) continue;
        const key = digest({ before: change.originalText.trim(), after: change.replacementText.trim() }); const group = groups.get(key) ?? []; group.push({ reviewId: review.id, documentId: summary.id, changeId: change.id, findingId: change.findingId, before: change.originalText, after: change.replacementText, updatedAt: change.updatedAt }); groups.set(key, group);
      }
      const created: unknown[] = [];
      for (const [key, group] of groups) {
        if (new Set(group.map(item => item.documentId)).size < 2 || existing.some(item => item.body.suggestionKey === key)) continue;
        const latest = [...group].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.changeId.localeCompare(b.changeId)).at(-1)!; const review = deps.store.getReview(latest.reviewId);
        if (!within(input.scope, review.context) || input.scope.level === 'project') continue;
        const content = `重复采纳的修改（${group.length}次，${new Set(group.map(item => item.documentId)).size}份文档）：\n原文：${latest.before}\n建议：${latest.after}`;
        if (content.length > 12000) continue;
        const source = sourceSnapshot(deps, { kind: 'change', reviewId: latest.reviewId, findingId: latest.findingId, changeId: latest.changeId }, content);
        created.push(await deps.assets.save({ kind: EXPERIENCE, expectedRevision: 0, body: { name: `重复修改候选 · ${latest.after.slice(0, 50)}`, kind: 'preference', content, scope: input.scope, state: 'candidate', source, reason: '由跨文档重复采纳生成候选，未自动批准或启用。', actorLabel: input.actorLabel, approvedAt: null, suggestionKey: key } satisfies ExperienceBody, actorLabel: input.actorLabel }));
      }
      return { created, message: '仅跨文档且完全相同的重复修改形成候选；候选须人工批准，项目记录不自动归组。' };
    }
    case 'library.template.list': { const input = checked(z.object({ includeDeleted: z.boolean().optional() }).strict(), payload); return list<TemplateBody>(deps, TEMPLATE, input.includeDeleted); }
    case 'library.template.createFromDocument': {
      const input = checked(z.object({ documentId: id, name: line(160), actorLabel: line(80), language: z.enum(['zh', 'en', 'th']), scope: scopeSchema }).strict(), payload);
      const document = deps.store.getDocument(input.documentId), original = deps.store.getDocumentArtifact(input.documentId); const paragraphs = document.blocks.filter(block => block.kind === 'paragraph' || block.kind === 'table_cell').map(block => block.text.trim()).filter(Boolean);
      if (document.partial) throw new Error('原文解析不完整，请补齐后再建立模板。');
      const body = validateTemplate({ name: input.name, title: input.name, language: input.language, scope: input.scope, paragraphs, fields: templateFields([input.name, ...paragraphs]).map(key => ({ key, label: key, required: true })), state: 'candidate', reason: '从已导入合同建立模板文字草稿，尚未批准。', actorLabel: input.actorLabel, approvedAt: null, source: { documentId: document.id, fileSha256: original.sha256, paragraphsSha256: digest(paragraphs), name: document.name, importedAt: document.importedAt } });
      return deps.assets.save({ kind: TEMPLATE, expectedRevision: 0, body, actorLabel: input.actorLabel });
    }
    case 'library.template.save': {
      const input = checked(z.object({ id, expectedRevision: z.number().int().min(1), body: z.unknown(), confirmed: z.boolean().optional() }).strict(), payload); const previous = asset<TemplateBody>(deps, input.id, TEMPLATE); const body = validateTemplate(input.body as TemplateBody);
      if (digest(previous.body.source) !== digest(body.source)) throw new Error('模板原始来源不可改写。');
      if (body.state === 'approved' && !input.confirmed) throw new Error('批准模板前请明确人工确认其内容与范围。');
      body.approvedAt = body.state === 'approved' ? stamp() : null;
      return deps.assets.save({ id: input.id, kind: TEMPLATE, expectedRevision: input.expectedRevision, body, actorLabel: body.actorLabel });
    }
    case 'library.template.render': {
      const input = checked(z.object({ templateId: id, expectedRevision: z.number().int().min(1), fields: z.record(z.string(), z.string()), clauseIds: z.array(id).max(20), projectId: line(120).nullable().optional(), actorLabel: line(80), contractType: z.enum(['procurement', 'service', 'other']).optional(), ourPartyRole: z.enum(['buyer', 'seller', 'service_provider', 'service_recipient', 'other']).optional() }).strict(), payload);
      if (new Set(input.clauseIds).size !== input.clauseIds.length) throw new Error('不可重复选择相同条款。');
      const template = asset<TemplateBody>(deps, input.templateId, TEMPLATE); const clauses = input.clauseIds.map(identifier => asset<ExperienceBody>(deps, identifier, EXPERIENCE)).map(value => ({ id: value.id, revision: value.revision, body: value.body, contentSha256: digest(value.body) }));
      const result = assembleTemplate(template, input, clauses); const bytes = await buildTemplateContractDocx(result.draft, result.sourceSnapshot);
      return { ...result, docxBase64: bytes.toString('base64'), filename: `${result.draft.title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').slice(0, 100) || '合同草稿'}.docx` } satisfies TemplateRenderResult;
    }
    case 'library.annotation.list': { const input = checked(z.object({ reviewId: id, includeDeleted: z.boolean().optional() }).strict(), payload); deps.store.getReview(input.reviewId); return list<AnnotationBody>(deps, ANNOTATION, input.includeDeleted).filter(value => value.body.reviewId === input.reviewId); }
    case 'library.annotation.effective': { const input = checked(z.object({ reviewId: id }).strict(), payload); return getEffectiveReviewFindings(deps, input.reviewId); }
    case 'library.annotation.save': {
      const input = checked(z.object({ ...baseSave, reviewId: id, findingId: id.nullable(), title: line(200), category: z.enum(['legal', 'commercial', 'operational']), severity: z.enum(['high', 'medium', 'low', 'unrated']), description: text(6000), suggestion: text(6000), blockIds: z.array(id).max(50), quote: z.string().max(6000).refine(value => validText(value, true)), reason: text(2000), state: z.enum(['active', 'disabled']) }).strict(), payload);
      const review = deps.store.getReview(input.reviewId), document = deps.store.getDocument(review.documentId); const previous = input.id ? asset<AnnotationBody>(deps, input.id, ANNOTATION) : null;
      if (previous && (previous.body.reviewId !== input.reviewId || previous.body.findingId !== input.findingId)) throw new Error('人工意见不能更换来源审核或原始风险。');
      if (input.findingId && !review.findings.some(item => item.id === input.findingId)) throw new Error('原始风险不属于当前审核。');
      if (new Set(input.blockIds).size !== input.blockIds.length || input.blockIds.some(identifier => !document.blocks.some(block => block.id === identifier))) throw new Error('原文段落不属于当前合同。');
      if (input.findingId && input.state === 'active' && getReviewAnnotations(deps, review.id).some(item => item.id !== input.id && item.body.findingId === input.findingId && item.body.state === 'active')) throw new Error('该风险已有有效人工意见，请编辑已有意见或先停用。');
      const body: AnnotationBody = { reviewId: review.id, documentId: review.documentId, findingId: input.findingId, title: input.title, category: input.category, severity: input.severity, description: input.description, suggestion: input.suggestion, blockIds: input.blockIds, quote: input.quote, reason: input.reason, actorLabel: input.actorLabel, state: input.state, originalReviewSha256: digest(review) };
      return deps.assets.save({ id: input.id, kind: ANNOTATION, expectedRevision: input.expectedRevision, body, actorLabel: input.actorLabel });
    }
    case 'library.asset.history': { const input = checked(z.object({ id }).strict(), payload); const value = deps.assets.get(input.id); if (![EXPERIENCE, TEMPLATE, ANNOTATION].includes(value.kind)) throw new Error('记录类型不匹配。'); return deps.assets.history(input.id); }
    case 'library.asset.remove': { const input = checked(z.object({ id, expectedRevision: z.number().int().min(1), actorLabel: line(80), reason: text(2000) }).strict(), payload); const value = deps.assets.get(input.id); if (![EXPERIENCE, TEMPLATE, ANNOTATION].includes(value.kind)) throw new Error('记录类型不匹配。'); return deps.assets.save({ id: value.id, kind: value.kind, expectedRevision: input.expectedRevision, body: { ...(value.body as object), reason: input.reason, actorLabel: input.actorLabel, state: 'disabled' }, deleted: true, actorLabel: input.actorLabel }); }
    case 'library.asset.rollback': {
      const input = checked(z.object({ id, expectedRevision: z.number().int().min(1), revision: z.number().int().min(1), actorLabel: line(80), reason: text(2000) }).strict(), payload); const current = deps.assets.get(input.id);
      if (![EXPERIENCE, TEMPLATE, ANNOTATION].includes(current.kind)) throw new Error('记录类型不匹配。');
      const previous = deps.assets.history(input.id).find(item => item.revision === input.revision); if (!previous || previous.deleted) throw new Error('所选历史版本不存在或为移除记录。');
      const body = { ...(previous.body as object), reason: input.reason, actorLabel: input.actorLabel, state: current.kind === ANNOTATION ? 'disabled' : 'candidate', ...(current.kind !== ANNOTATION ? { approvedAt: null } : {}) };
      return deps.assets.save({ id: current.id, kind: current.kind, expectedRevision: input.expectedRevision, body, deleted: false, actorLabel: input.actorLabel });
    }
    default: throw new Error('不支持的本地资料库操作。');
  }
}
