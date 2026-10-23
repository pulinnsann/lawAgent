import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { ContractDraft, AuthoringCaseAsset, AuthoringCaseBody, AuthoringCaseView, AuthoringIssue } from '../shared/generation';
import type { TemplateRenderResult } from '../shared/library';
import type { LibraryDeps } from './workspace-library';
import { runLibraryCommand,getEffectiveReviewFindings,getReviewAnnotations } from './workspace-library';
import { buildGeneratedContractDocx } from './contract-generation';
import { runProgramChecks } from './program-checks';
import { buildReviewCompletionReport,getReviewFreshness } from './workspace-review-completion';
import { assertDocumentActive } from './workspace-documents';

export interface AuthoringDeps extends LibraryDeps { dataDir: string }
export const AUTHORING_KIND = 'authoring_case';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = z.string().uuid(), revision = z.number().int().min(1);
const line = (max:number) => z.string().trim().min(1).max(max).refine(value=>!/[\u0000-\u001f\u007f]/u.test(value));
const text = (max:number) => z.string().trim().min(1).max(max).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const identity = { id:uuid,expectedRevision:revision };
function checked<T>(schema:z.ZodType<T>,payload:unknown):T{const result=schema.safeParse(payload);if(!result.success)throw new Error(`起草确认输入无效：${result.error.issues.slice(0,3).map(item=>item.path.join('.')+' '+item.message).join('；')}`);return result.data;}
export function authoringContentHash(draft:ContractDraft):string{return digest({id:draft.id,title:draft.title,language:draft.language,request:draft.request,clauses:draft.clauses,missingInformation:draft.missingInformation,warnings:draft.warnings});}
function getCase(deps:AuthoringDeps,id:string):AuthoringCaseAsset{const value=deps.assets.get(id);if(value.kind!==AUTHORING_KIND||value.deleted)throw new Error('起草确认记录不存在。');return value as AuthoringCaseAsset;}
function programReport(draft:ContractDraft,document:AuthoringCaseView['document'],template:boolean){const count=1+draft.clauses.reduce((n,clause)=>n+clause.paragraphs.length+(template?0:1),0);return runProgramChecks({...document,blocks:document.blocks.slice(0,count)},{checks:{amounts:true,dates:true,references:true,parties:true},thresholds:{maxPrepaymentPercent:null,maxPaymentDays:null}});}
function reviewFor(deps:AuthoringDeps,asset:AuthoringCaseAsset){const task=deps.store.listTasks().find(value=>value.id===asset.body.taskId);if(!task||task.documentId!==asset.body.documentId||task.status!=='completed'||!task.resultId)return{review:null,status:task?.status??'not_started'};const review=deps.store.getReview(task.resultId);if(review.documentId!==asset.body.documentId)throw new Error('审核记录与起草原稿不一致。');if(review.context.contractType!==asset.body.draft.request.contractType||review.context.ourPartyRole!==asset.body.draft.request.ourPartyRole||(review.context.projectId??null)!==(asset.body.origin.projectId??null))return{review:null,status:'scope_mismatch'};return{review,status:task.status};}
export function getAuthoringCaseView(deps:AuthoringDeps,id:string):AuthoringCaseView{
 const asset=getCase(deps,id),body=asset.body,document=deps.store.getDocument(body.documentId),artifact=deps.store.getDocumentArtifact(document.id);
 if(authoringContentHash(body.draft)!==body.contentSha256||artifact.sha256!==body.artifactSha256)throw new Error('起草内容或原稿版本已变化，须重新核验。');
 const found=reviewFor(deps,asset);const issues:AuthoringIssue[]=[];if(found.status==='scope_mismatch')issues.push({key:'review-scope',source:'coverage',title:'审核类型、立场或项目与本起草版本不一致',detail:'请按本草稿保留的合同类型、我方立场和项目重新审核；其他范围的审核不能用于本次确认。',blocking:true});
 const contractText=[body.draft.title,...body.draft.clauses.flatMap(clause=>[clause.heading,...clause.paragraphs])].join('\n');
 const markers=[...new Set([...contractText.matchAll(/\{\{[^{}\r\n]{1,100}\}\}|\[[^\]\r\n]{0,100}(?:待|TBD|TODO|to (?:be )?(?:complete(?:d)?|confirm(?:ed)?|fill(?:ed)?)|insert|กรอก|ระบุ|รอ)[^\]\r\n]{0,100}\]|_{3,}/giu)].map(value=>value[0]))];
 markers.slice(0,100).forEach((marker,index)=>issues.push({key:`placeholder:${index}`,source:'placeholder',title:'合同正文仍有待填占位',detail:marker,blocking:true}));
 if(body.draft.missingInformation.length)issues.push({key:'missing-information',source:'placeholder',title:'待补信息尚未清空',detail:body.draft.missingInformation.join('；'),blocking:true});
 for(const issue of body.checks.issues)issues.push({key:`program:${issue.key}:${issue.blockIds.join(',')}`,source:'program',title:issue.title,detail:issue.description+(issue.calculation?'；'+issue.calculation:''),blocking:false});
 const coverage=body.checks.checks.filter(check=>check.status!=='completed'||check.limitations.length);
 if(coverage.length)issues.push({key:'program-coverage',source:'coverage',title:'程序检查适用范围须人工确认',detail:coverage.map(check=>`${check.kind}: ${check.status}; ${check.limitations.join('；')}`).join('\n'),blocking:false});
 if(found.review){for(const {finding,annotation} of getEffectiveReviewFindings(deps,found.review.id))issues.push({key:`review:${finding.id}`,source:'review',title:finding.title,detail:`${annotation?'人工意见 r'+annotation.revision+'；':''}${finding.description}\n建议：${finding.suggestion}`,blocking:false});
  const limitations=[...found.review.coverage.limitations];if(found.review.mode==='local')limitations.push('本次使用本地规则审核，未进行模型法律分析；需由法务补充法律和商业适用性复核。');if(document.blocks.some(block=>!found.review!.coverage.reviewedBlockIds.includes(block.id)))limitations.push('审核未覆盖原稿全部段落。');if(limitations.length)issues.push({key:'review-coverage',source:'coverage',title:'审核范围与局限须人工确认',detail:limitations.join('\n'),blocking:false});}
 const completion=found.review?buildReviewCompletionReport(deps,found.review):null;
 const freshness=found.review?getReviewFreshness(deps,found.review):null;
 const reviewAugmentationSha256=found.review?digest({annotations:getReviewAnnotations(deps,found.review.id),facts:completion!.currentFacts,sourceVerifications:completion!.sourceVerifications.map(value=>value.current).sort((a,b)=>a.id.localeCompare(b.id)),freshness:{status:freshness!.status,reasons:freshness!.reasons,limitations:freshness!.limitations}}):null;
 for(const update of freshness?.reasons??[])issues.push({key:`freshness:${digest(update).slice(0,24)}`,source:'coverage',title:'审核后存在已知更新，需要人工核对',detail:update.message+' 请核对后选择重审或明确本次继续导出的理由；这不自动判断法律效力或外部来源的最新状态。',blocking:false});
 if(issues.length>250)throw new Error('需确认事项超过250项，请整理人工意见或缩小范围后重新审核。');
 const confirmation=body.confirmation;
 const valid=Boolean(confirmation&&found.review&&confirmation.contentSha256===body.contentSha256&&confirmation.artifactSha256===body.artifactSha256&&confirmation.reviewId===found.review.id&&confirmation.reviewSha256===digest(found.review)&&confirmation.reviewAugmentationSha256===reviewAugmentationSha256&&issues.every(issue=>!issue.blocking&&confirmation.decisions.some(decision=>decision.key===issue.key&&Boolean(decision.reason.trim()))));
 return{asset,document,review:found.review,reviewStatus:found.status,issues,canConfirm:Boolean(found.review)&&!issues.some(issue=>issue.blocking),canExport:valid,reviewAugmentationSha256,freshness};
}
async function managedBytes(deps:AuthoringDeps,body:AuthoringCaseBody):Promise<Buffer>{
 const artifact=deps.store.getDocumentArtifact(body.documentId);if(artifact.format!=='docx'||artifact.sha256!==body.artifactSha256)throw new Error('待导出原稿已变化。');
 const root=await realpath(deps.dataDir),file=await realpath(join(root,artifact.artifactUri));const delta=relative(root,file);
 if(!delta||isAbsolute(delta)||delta==='..'||delta.startsWith(`..${sep}`))throw new Error('原稿不在当前受控工作空间内。');
 const bytes=await readFile(file);if(createHash('sha256').update(bytes).digest('hex')!==body.artifactSha256)throw new Error('原稿文件摘要不一致，请重新核验，未导出。');return bytes;
}
async function prepare(deps:AuthoringDeps,draft:ContractDraft,origin:AuthoringCaseBody['origin'],actorLabel:string,bytes?:Buffer):Promise<AuthoringCaseView>{
 const hash=authoringContentHash(draft);const prior=(deps.assets.list(AUTHORING_KIND) as AuthoringCaseAsset[]).find(value=>value.body.origin.kind===origin.kind&&value.body.origin.draftId===origin.draftId&&value.body.contentSha256===hash);
 if(prior)return getAuthoringCaseView(deps,prior.id);
 bytes??=await buildGeneratedContractDocx(draft);
 const filename=`${draft.title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu,'_').slice(0,90)||'合同'}-审核草稿.docx`;
 const document=await deps.service.importDerivedBytes({name:filename,base64:bytes.toString('base64'),source:{kind:'authoring_review_draft',origin,contentSha256:hash},draft});
 const body:AuthoringCaseBody={draft:structuredClone(draft),origin,contentSha256:hash,documentId:document.id,artifactSha256:deps.store.getDocumentArtifact(document.id).sha256,checks:programReport(draft,document,origin.kind==='template'),taskId:null,confirmation:null,actorLabel,reason:'起草后生成独立审核原稿；尚未确认最终导出。'};
 const asset=await deps.assets.save({kind:AUTHORING_KIND,expectedRevision:0,body,actorLabel});return getAuthoringCaseView(deps,asset.id);
}
export async function assertAuthoringExport(deps:AuthoringDeps,input:{id?:string;draftId?:string;expectedRevision?:number}):Promise<{view:AuthoringCaseView;bytes:Buffer}>{
 const cases=(deps.assets.list(AUTHORING_KIND) as AuthoringCaseAsset[]).filter(value=>value.body.origin.kind==='description'&&value.body.origin.draftId===input.draftId);
 const asset=input.id?getCase(deps,input.id):cases.find(value=>getAuthoringCaseView(deps,value.id).canExport);
 if(!asset)throw new Error('请先完成起草后核验、审核和人工确认，再导出。');
 if(input.expectedRevision!==undefined&&asset.revision!==input.expectedRevision)throw new Error('起草确认版本已更新，请刷新后导出。');
 assertDocumentActive(deps.store,asset.body.documentId);
 if(asset.body.origin.projectId){const project=deps.store.rows('SELECT lifecycle_status FROM projects WHERE id=? AND workspace_id=?',[asset.body.origin.projectId,deps.store.workspaceId])[0];if(project&&project.lifecycle_status!=='active')throw new Error('起草所属项目已归档或移入回收站，请先恢复后再导出。');}
 const view=getAuthoringCaseView(deps,asset.id);if(!view.canExport)throw new Error('起草后核验、审核或人工确认尚未完成或已失效。');
 return{view,bytes:await managedBytes(deps,asset.body)};
}
async function runAuthoringCommandImpl(action:string,payload:unknown,deps:AuthoringDeps):Promise<unknown>{
 switch(action){
 case 'library.authoring.prepareDescription': {const p=checked(z.object({draftId:uuid,actorLabel:line(80)}).strict(),payload);return prepare(deps,deps.store.getContractDraft(p.draftId),{kind:'description',draftId:p.draftId},p.actorLabel);}
 case 'library.authoring.prepareTemplate': {const p=checked(z.object({input:z.unknown(),actorLabel:line(80)}).strict(),payload);const rendered=await runLibraryCommand('library.template.render',p.input,deps) as TemplateRenderResult;return prepare(deps,rendered.draft,{kind:'template',draftId:rendered.draft.id,...((p.input as {projectId?:string|null}).projectId?{projectId:(p.input as {projectId:string}).projectId}:{}),templateSnapshot:rendered.sourceSnapshot},p.actorLabel,Buffer.from(rendered.docxBase64,'base64'));}
 case 'library.authoring.get': {const p=checked(z.object({id:uuid}).strict(),payload);return getAuthoringCaseView(deps,p.id);}
 case 'library.authoring.list': return (deps.assets.list(AUTHORING_KIND) as AuthoringCaseAsset[]).map(value=>({id:value.id,revision:value.revision,title:value.body.draft.title,origin:value.body.origin.kind,contentSha256:value.body.contentSha256,updatedAt:value.updatedAt}));
 case 'library.authoring.update': {
  const p=checked(z.object({...identity,actorLabel:line(80),reason:text(2000),title:line(200),clauses:z.array(z.object({heading:line(300),paragraphs:z.array(line(6000)).min(1).max(400)}).strict()).min(1).max(80),missingInformation:z.array(line(1000)).max(40)}).strict(),payload),current=getCase(deps,p.id);
  if(current.revision!==p.expectedRevision)throw new Error('起草记录已更新，请刷新后再修改。');
  const draft={...current.body.draft,title:p.title,clauses:p.clauses,missingInformation:p.missingInformation};const bytes=await buildGeneratedContractDocx(draft);
  const document=await deps.service.importDerivedBytes({name:`${draft.title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu,'_').slice(0,90)}-审核草稿.docx`,base64:bytes.toString('base64'),source:{kind:'authoring_revision',caseId:current.id,revision:current.revision,contentSha256:authoringContentHash(draft)},draft});
  const body={...current.body,draft,contentSha256:authoringContentHash(draft),documentId:document.id,artifactSha256:deps.store.getDocumentArtifact(document.id).sha256,checks:programReport(draft,document,false),taskId:null,confirmation:null,actorLabel:p.actorLabel,reason:p.reason};
  await deps.assets.save({id:current.id,kind:AUTHORING_KIND,expectedRevision:p.expectedRevision,body,actorLabel:p.actorLabel});return getAuthoringCaseView(deps,current.id);
 }
 case 'library.authoring.attachReview': {
  const p=checked(z.object({...identity,taskId:uuid,actorLabel:line(80)}).strict(),payload),current=getCase(deps,p.id),task=deps.store.listTasks().find(value=>value.id===p.taskId);
  if(!task||task.documentId!==current.body.documentId)throw new Error('审核任务不属于当前起草原稿。');
  await managedBytes(deps,current.body);await deps.assets.save({id:current.id,kind:AUTHORING_KIND,expectedRevision:p.expectedRevision,body:{...current.body,taskId:p.taskId,confirmation:null,actorLabel:p.actorLabel,reason:'绑定现有审核管线任务；最终确认尚未完成。'},actorLabel:p.actorLabel});return getAuthoringCaseView(deps,current.id);
 }
 case 'library.authoring.confirm': {
  const p=checked(z.object({...identity,contentSha256:z.string().regex(/^[a-f0-9]{64}$/u),actorLabel:line(80),reason:text(2000),confirmed:z.literal(true),decisions:z.array(z.object({key:line(300),status:z.enum(['resolved','accepted']),reason:text(2000)}).strict()).max(250)}).strict(),payload),view=getAuthoringCaseView(deps,p.id);
  if(view.asset.revision!==p.expectedRevision||view.asset.body.contentSha256!==p.contentSha256)throw new Error('合同或核验版本已更新，请重新逐项确认。');
  if(!view.canConfirm||!view.review)throw new Error('请补齐占位与待补信息，并等待本原稿审核完成。');
  if(new Set(p.decisions.map(item=>item.key)).size!==p.decisions.length||p.decisions.length!==view.issues.length||view.issues.some(issue=>!p.decisions.some(item=>item.key===issue.key)))throw new Error('请对全部核验、审核事项及局限逐项填写处置与原因。');
  await managedBytes(deps,view.asset.body);
  const confirmation={contentSha256:view.asset.body.contentSha256,artifactSha256:view.asset.body.artifactSha256,reviewId:view.review.id,reviewSha256:digest(view.review),reviewAugmentationSha256:view.reviewAugmentationSha256!,decisions:p.decisions,actorLabel:p.actorLabel,reason:p.reason,confirmedAt:new Date().toISOString()};
  await deps.assets.save({id:p.id,kind:AUTHORING_KIND,expectedRevision:p.expectedRevision,body:{...view.asset.body,confirmation,actorLabel:p.actorLabel,reason:p.reason},actorLabel:p.actorLabel});return getAuthoringCaseView(deps,p.id);
 }
 case 'library.authoring.renderConfirmed': {const p=checked(z.object(identity).strict(),payload);const {view,bytes}=await assertAuthoringExport(deps,p);return{docxBase64:bytes.toString('base64'),filename:`${view.asset.body.draft.title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu,'_').slice(0,100)}.docx`,document:view.document,sourceSnapshot:{caseId:view.asset.id,revision:view.asset.revision,origin:view.asset.body.origin,confirmation:view.asset.body.confirmation},contentSha256:view.asset.body.contentSha256};}
 case 'library.authoring.recordExport': {const p=checked(z.object({...identity,sha256:z.string().regex(/^[a-f0-9]{64}$/u),actorLabel:line(80)}).strict(),payload);const {view,bytes}=await assertAuthoringExport(deps,p);if(p.sha256!==createHash('sha256').update(bytes).digest('hex'))throw new Error('导出摘要与已确认原稿不一致。');return deps.assets.save({kind:'authoring_export',expectedRevision:0,body:{caseId:view.asset.id,caseRevision:view.asset.revision,sha256:p.sha256,confirmation:view.asset.body.confirmation,exportedAt:new Date().toISOString()},actorLabel:p.actorLabel});}
 case 'library.authoring.history': {const p=checked(z.object({id:uuid}).strict(),payload);getCase(deps,p.id);return deps.assets.history(p.id);}
 default:throw new Error('不支持的起草后核验操作。');
 }
}

const authoringQueues = new WeakMap<AuthoringDeps['assets'],Promise<unknown>>();
export function runAuthoringCommand(action:string,payload:unknown,deps:AuthoringDeps):Promise<unknown>{
  if(['library.authoring.get','library.authoring.list','library.authoring.history','library.authoring.renderConfirmed'].includes(action))return runAuthoringCommandImpl(action,payload,deps);
  const previous=authoringQueues.get(deps.assets)??Promise.resolve();
  const next=previous.then(()=>runAuthoringCommandImpl(action,payload,deps),()=>runAuthoringCommandImpl(action,payload,deps));
  authoringQueues.set(deps.assets,next.catch(()=>{}));return next;
}
