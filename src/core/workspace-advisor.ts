import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ReviewContext } from '../shared/contracts';
import type { AdvisorPromptAsset, AdvisorPromptBody, AdvisorPromptSnapshot, AdvisorRegressionAsset, AdvisorRegressionBody, AdvisorSampleAsset, LibraryScope } from '../shared/library';
import type { WorkspaceAssets } from './workspace-assets';
import { runProgramChecks } from './program-checks';
import { applicableLibraryScope } from './workspace-experience-policy';

const PACKAGE = 'advisor_prompt', SAMPLE = 'advisor_sample', REGRESSION = 'advisor_regression';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const line = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const uuid = z.string().uuid(), revision = z.number().int().min(1), base = { id: uuid.optional(), expectedRevision: z.number().int().min(0), actorLabel: line(80) };
const scope = z.object({ level: z.enum(['personal','enterprise','project']), projectId: line(120).nullable(), contractTypes: z.array(z.enum(['procurement','service','other'])).min(1).max(3), partyRoles: z.array(z.enum(['buyer','seller','service_provider','service_recipient','other'])).min(1).max(5) }).strict().refine(value => value.level === 'project' ? Boolean(value.projectId) : value.projectId === null);
const category = z.enum(['legal','commercial','operational']), severity = z.enum(['high','medium','low','unrated']);
function checked<T>(schema: z.ZodType<T>, input: unknown): T { const result = schema.safeParse(input); if (!result.success) throw new Error(`顾问资料输入无效：${result.error.issues.slice(0,3).map(value=>value.path.join('.')+' '+value.message).join('；')}`); return result.data; }
function asset<T>(assets: WorkspaceAssets,id: string,kind: string) { const value = assets.get(id); if(value.kind!==kind||value.deleted)throw new Error('顾问资料不存在或已停用移除。');return value as T; }
export const advisorPackageHash = (body: Pick<AdvisorPromptBody,'name'|'content'|'scope'|'advisorLabel'>) => digest({name:body.name,content:body.content,scope:body.scope,advisorLabel:body.advisorLabel});
function usableRegression(assets: WorkspaceAssets,body: AdvisorPromptBody): AdvisorRegressionAsset {
  if(!body.regressionId)throw new Error('批准前须运行本版本内容的样本程序回归并记录人工评审。');
  const run=asset<AdvisorRegressionAsset>(assets,body.regressionId,REGRESSION);
  if(run.body.packageContentSha256!==advisorPackageHash(body)||!run.body.passed||run.body.humanReview.status!=='accepted')throw new Error('回归内容已过期、检查未通过或尚未人工接受评审。');
  for(const sample of run.body.samples){const current=asset<AdvisorSampleAsset>(assets,sample.id,SAMPLE);if(current.revision!==sample.revision||digest(current.body)!==sample.contentSha256)throw new Error('测试样本已更新，请重新运行回归并评审。');}
  return run;
}
export function getApplicableAdvisorPackages(deps:{assets:WorkspaceAssets},context:Pick<ReviewContext,'contractType'|'ourPartyRole'>&{projectId?:string|null}):AdvisorPromptSnapshot[]{
  return (deps.assets.list(PACKAGE) as AdvisorPromptAsset[]).filter(value=>!value.deleted&&value.body.state==='approved'&&applicableLibraryScope(value.body.scope,context)).flatMap(value=>{try{const regression=usableRegression(deps.assets,value.body);return[{id:value.id,revision:value.revision,body:structuredClone(value.body),contentSha256:advisorPackageHash(value.body),regression:structuredClone(regression.body)}];}catch{return[];}});
}
export async function runAdvisorCommand(action:string,payload:unknown,deps:{assets:WorkspaceAssets}):Promise<unknown>{
 const assets=deps.assets;
 switch(action){
 case 'library.advisor.list': return assets.list(PACKAGE);
 case 'library.advisor.save': {
  const p=checked(z.object({...base,name:line(160),content:text(16000),scope,state:z.enum(['candidate','approved','disabled']),reason:text(2000),advisorLabel:line(120),regressionId:uuid.nullable(),confirmed:z.boolean().optional()}).strict(),payload);
  if(p.id)asset<AdvisorPromptAsset>(assets,p.id,PACKAGE);
  const body:AdvisorPromptBody={name:p.name,content:p.content,scope:p.scope as LibraryScope,state:p.state,reason:p.reason,actorLabel:p.actorLabel,advisorLabel:p.advisorLabel,regressionId:p.regressionId,approvedAt:p.state==='approved'?new Date().toISOString():null};
  if(p.state==='approved'){if(!p.confirmed)throw new Error('批准顾问提示词包须明确人工确认。');const run=usableRegression(assets,body);if(run.body.packageId!==p.id)throw new Error('回归记录不属于当前提示词包。');}
  return assets.save({id:p.id,kind:PACKAGE,expectedRevision:p.expectedRevision,body,actorLabel:p.actorLabel});
 }
 case 'library.advisor.samples': {const p=checked(z.object({packageId:uuid}).strict(),payload);asset(assets,p.packageId,PACKAGE);return assets.list(SAMPLE).filter(value=>value.body.packageId===p.packageId);}
 case 'library.advisor.sample.save': {
  const p=checked(z.object({...base,packageId:uuid,packageRevision:revision,name:line(160),text:text(60000),source:line(300),reason:text(2000),expectedRisks:z.array(z.object({key:line(100),terms:z.array(line(200)).min(1).max(8),category,severity}).strict()).min(1).max(50),observedRisks:z.array(z.object({title:line(200),description:text(4000),category,severity}).strict()).max(100)}).strict(),payload);
  const pack=asset<AdvisorPromptAsset>(assets,p.packageId,PACKAGE);if(pack.revision!==p.packageRevision)throw new Error('提示词包已更新，请刷新后绑定当前版本。');
  if(p.id){const previous=asset<AdvisorSampleAsset>(assets,p.id,SAMPLE);if(previous.body.packageId!==p.packageId)throw new Error('样本不能更换所属提示词包。');}
  if(new Set(p.expectedRisks.map(item=>item.key)).size!==p.expectedRisks.length)throw new Error('样本期望风险标识不能重复。');
  return assets.save({id:p.id,kind:SAMPLE,expectedRevision:p.expectedRevision,body:{packageId:p.packageId,packageRevision:pack.revision,packageContentSha256:advisorPackageHash(pack.body),name:p.name,text:p.text,source:p.source,reason:p.reason,expectedRisks:p.expectedRisks,observedRisks:p.observedRisks,actorLabel:p.actorLabel},actorLabel:p.actorLabel});
 }
 case 'library.advisor.sample.remove': {const p=checked(z.object({id:uuid,expectedRevision:revision,actorLabel:line(80),reason:text(2000)}).strict(),payload);const current=asset<AdvisorSampleAsset>(assets,p.id,SAMPLE);return assets.save({id:current.id,kind:SAMPLE,expectedRevision:p.expectedRevision,body:{...current.body,reason:p.reason,actorLabel:p.actorLabel},deleted:true,actorLabel:p.actorLabel});}
 case 'library.advisor.rollback': {const p=checked(z.object({id:uuid,expectedRevision:revision,revision,actorLabel:line(80),reason:text(2000)}).strict(),payload);const current=asset<AdvisorPromptAsset>(assets,p.id,PACKAGE);const previous=assets.history(p.id).find(value=>value.revision===p.revision&&!value.deleted);if(!previous)throw new Error('历史提示词包版本不存在。');return assets.save({id:current.id,kind:PACKAGE,expectedRevision:p.expectedRevision,body:{...previous.body,state:'candidate',approvedAt:null,regressionId:null,reason:p.reason,actorLabel:p.actorLabel},actorLabel:p.actorLabel});}
 case 'library.advisor.regressions': {const p=checked(z.object({packageId:uuid}).strict(),payload);asset(assets,p.packageId,PACKAGE);return assets.list(REGRESSION).filter(value=>value.body.packageId===p.packageId);}
 case 'library.advisor.regression.run': {
  const p=checked(z.object({packageId:uuid,expectedRevision:revision,sampleIds:z.array(uuid).min(1).max(50),actorLabel:line(80)}).strict(),payload),pack=asset<AdvisorPromptAsset>(assets,p.packageId,PACKAGE);
  if(pack.revision!==p.expectedRevision)throw new Error('提示词包已更新，未使用旧版本执行回归。');if(new Set(p.sampleIds).size!==p.sampleIds.length)throw new Error('测试样本不能重复选择。');
  const hash=advisorPackageHash(pack.body);
  const samples=p.sampleIds.map(id=>{const sample=asset<AdvisorSampleAsset>(assets,id,SAMPLE);if(sample.body.packageId!==pack.id||sample.body.packageContentSha256!==hash)throw new Error('样本未绑定本提示词包当前内容版本，请重新保存样本。');const report=runProgramChecks({partial:false,blocks:sample.body.text.split(/\r?\n/u).filter(Boolean).map((text,ordinal)=>({id:randomUUID(),ordinal,text,kind:'paragraph' as const,locator:{kind:'docx' as const,partName:'word/document.xml',structuralPath:`/w:document[1]/w:body[1]/w:p[${ordinal+1}]`,paragraphId:null}}))},{checks:{amounts:true,dates:true,references:true,parties:true},thresholds:{maxPrepaymentPercent:null,maxPaymentDays:null}});
   const observed=[...sample.body.observedRisks,...report.issues.map(issue=>({title:issue.title,description:issue.description,category:'operational' as const,severity:issue.severity}))];
   const checks=sample.body.expectedRisks.map(expected=>{const match=observed.find(risk=>risk.category===expected.category&&risk.severity===expected.severity&&expected.terms.every(term=>(risk.title+'\n'+risk.description).includes(term)));return{key:expected.key,passed:Boolean(match),reason:match?'人工登记观察结果或程序问题与期望文字、类别和等级相符；未验证法律正确性。':'未找到同时匹配文字、类别和等级的观察结果。'};});
   return{id:sample.id,revision:sample.revision,contentSha256:digest(sample.body),checks,programReport:report};});
  const body:AdvisorRegressionBody={packageId:pack.id,packageRevision:pack.revision,packageContentSha256:hash,samples,passed:samples.every(sample=>sample.checks.every(check=>check.passed)),legalCorrectnessCertified:false,createdAt:new Date().toISOString(),actorLabel:p.actorLabel,humanReview:{status:'pending',reason:'尚待专业人员评审；程序回归仅检查样本结构及登记结果匹配。',actorLabel:p.actorLabel,reviewedAt:null}};
  return assets.save({kind:REGRESSION,expectedRevision:0,body,actorLabel:p.actorLabel});
 }
 case 'library.advisor.regression.review': {
  const p=checked(z.object({id:uuid,expectedRevision:revision,status:z.enum(['accepted','rejected']),reason:text(2000),actorLabel:line(80),confirmed:z.literal(true)}).strict(),payload),run=asset<AdvisorRegressionAsset>(assets,p.id,REGRESSION);
  return assets.save({id:run.id,kind:REGRESSION,expectedRevision:p.expectedRevision,body:{...run.body,humanReview:{status:p.status,reason:p.reason,actorLabel:p.actorLabel,reviewedAt:new Date().toISOString()}},actorLabel:p.actorLabel});
 }
 case 'library.advisor.history': {const p=checked(z.object({id:uuid}).strict(),payload);const current=assets.get(p.id);if(![PACKAGE,SAMPLE,REGRESSION].includes(current.kind))throw new Error('非顾问资料记录。');return assets.history(p.id);}
 default:throw new Error('不支持的顾问资料操作。');
 }
}
