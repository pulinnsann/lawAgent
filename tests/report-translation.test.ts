import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { WorkspaceAssets } from '../src/core/workspace-assets';
import { defaultReportSettings, type ReportSnapshot, type ReportingRenderResult } from '../src/shared/reporting';
import type { ReportTranslationUnit, ReportTranslationWorkspace } from '../src/shared/report-translation';
import { defaultRetrievalConfig, type ParsedContract, type ReviewResult } from '../src/shared/contracts';
import { getWorkflowBeforeReview, runReviewCompletionCommand } from '../src/core/workspace-review-completion';
import { runReportingCommand, reportHtml, reportCsv, buildReportSnapshot, normalizeReportRequest } from '../src/core/reporting';
import { generateReportTranslation, protectReportText, reportDependencySha256, resolveReportTranslationUnit, validateReportTranslationUnit } from '../src/core/report-translation';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'law-report-translation-'));const store=await AppStore.open(dir);const service=new ContractService(store,dir);const assets=new WorkspaceAssets(store);
  const blockId=randomUUID();const parsed:ParsedContract={format:'docx',language:'zh',pageCount:null,partial:false,warnings:[],blocks:[{id:blockId,ordinal:0,kind:'paragraph',text:'乙方应于2026-10-31支付CNY 99,000.50，不得提前扣款。',locator:{kind:'docx',partName:'word/document.xml',structuralPath:'/w:document[1]/w:body[1]/w:p[1]',paragraphId:null}}]};
  const document=await store.addDocument(randomUUID(),'合成测试合同.docx','synthetic/not-a-real-file.docx',100,hash(parsed.blocks[0].text),parsed);
  const context={contractType:'service' as const,ourPartyRole:'service_recipient' as const,strictness:'balanced' as const,businessContext:'仅供工程验证的业务背景'};
  const taskId=randomUUID();const runId=await store.createTask({id:taskId,documentId:document.id,status:'queued',stage:'synthetic',startedAt:'2026-10-23T00:00:00Z',finishedAt:null,error:null,resultId:null},context,'local',null,null);
  const review:ReviewResult={id:randomUUID(),documentId:document.id,createdAt:'2026-10-23T00:00:00Z',mode:'local',modelId:null,summary:'须核对付款授权。',findings:[{id:randomUUID(),blockIds:[blockId],quote:parsed.blocks[0].text,title:'预付款授权风险',category:'commercial',severity:'high',description:'付款前未明确授权流程。',suggestion:'取得书面付款授权后支付。',legalBasis:'法律依据需另行核对',basisStatus:'unverified',source:'rule',locationStatus:'matched'}],context,coverage:{reviewedBlockIds:[blockId],totalBlockCount:1,knowledgeStatus:'user_disabled',webStatus:'user_disabled',limitations:['工程测试并未确认法律正确性。']},elapsedMs:1,inputTokens:null,outputTokens:null};
  await store.saveReview(review,runId);await store.saveRiskDisposition({reviewId:review.id,findingId:review.findings[0].id,expectedRevision:0,status:'needs_information',reason:'须补充付款审批附件。',actorLabel:'合成法务'});
  await assets.save({kind:'library_annotation',expectedRevision:0,body:{reviewId:review.id,documentId:document.id,findingId:review.findings[0].id,title:'独立人工关注',category:'commercial',severity:'low',description:'需要人工核对审批链。',suggestion:'取得审批附件。',blockIds:[blockId],quote:parsed.blocks[0].text,reason:'人工判断应保留。',actorLabel:'合成律师',state:'active',originalReviewSha256:hash(JSON.stringify(review))}});
  const f={dir,store,service,assets,document,review,blockId,close:async()=>{await service.close();await rm(dir,{recursive:true,force:true});}};return f;
}
const request=(reviewId:string,language:'en'|'th')=>({scope:'current',style:'risk',reviewId,settings:{...defaultReportSettings(),language}});
async function prepare(f:Awaited<ReturnType<typeof fixture>>,language:'en'|'th'='en') {return await runReportingCommand('reporting.translation.prepare',{request:request(f.review.id,language),actorLabel:'合成翻译人员'},f) as ReportTranslationWorkspace;}
/** Synthetic manual edits test the mapping and gates, not translation quality. */
function target(unit:ReportTranslationUnit,language:'en'|'th') {
  const tokens=unit.protectedValues.map(value=>value.token).join(' ');
  let text=language==='en'?'Synthetic translated report metadata':'ข้อความรายงานที่แปลเพื่อทดสอบ';
  if(unit.source.includes('验收条件事实'))text=language==='en'?'Known fact: Payment depends on acceptance.':'ข้อเท็จจริง: การชำระเงินขึ้นอยู่กับการตรวจรับ';
  else if(unit.source.includes('采信范围需要人工限定'))text=language==='en'?'Human source review: Limit the reliance scope manually.':'การตรวจแหล่งข้อมูลโดยผู้ตรวจ: จำกัดขอบเขตการใช้ข้อมูลด้วยตนเอง';
  else if(unit.source.includes('须核对付款授权。'))text=language==='en'?'Saved summary: Verify payment authorization.':'สรุปที่บันทึกไว้: ตรวจสอบอำนาจอนุมัติการชำระเงิน';
  else if(unit.source.includes('付款前未明确授权流程。'))text=language==='en'?'The authorization process before payment is unspecified.':'ยังไม่ได้ระบุขั้นตอนอนุมัติก่อนชำระเงิน';
  else if(unit.source.includes('取得书面付款授权后支付。'))text=language==='en'?'Pay after obtaining written payment authorization.':'ชำระเงินหลังได้รับหนังสืออนุมัติการชำระเงิน';
  else if(unit.source.includes('须补充付款审批附件。'))text=language==='en'?'Human note: Obtain the payment approval attachment.':'หมายเหตุผู้ตรวจ: ขอเอกสารแนบการอนุมัติชำระเงิน';
  else if(unit.source.includes('需要人工核对审批链。'))text=language==='en'?'Human annotation: Manually verify the approval chain.':'ข้อสังเกตผู้ตรวจ: ตรวจสอบลำดับการอนุมัติด้วยตนเอง';
  else if(unit.source.includes('预付款授权风险'))text=language==='en'?'Prepayment authorization risk':'ความเสี่ยงเรื่องอำนาจอนุมัติเงินล่วงหน้า';
  return `${text} ${tokens}`.trim();
}
async function fill(f:Awaited<ReturnType<typeof fixture>>,value:ReportTranslationWorkspace){return await runReportingCommand('reporting.translation.save',{id:value.asset.id,expectedRevision:value.asset.revision,actorLabel:'合成翻译人员',edits:value.asset.body.units.filter(unit=>!unit.target).map(unit=>({id:unit.id,target:target(unit,value.asset.body.targetLanguage)}))},f) as ReportTranslationWorkspace;}
async function approve(f:Awaited<ReturnType<typeof fixture>>,value:ReportTranslationWorkspace){return await runReportingCommand('reporting.translation.confirm',{id:value.asset.id,expectedRevision:value.asset.revision,actorLabel:'合成复核人员',reason:'仅验收翻译映射与工程流程，法律正确性交由律师。',confirmed:true},f) as ReportTranslationWorkspace;}

test('报告译文保护完整原文、业务日期、金额和标识，拒绝删除重复新增标记及改写数值',()=>{
  const quote='原文 CNY 99,000.50 截止2026-10-31。';const source=`合同引文 ${quote}，期间2026-10-01至2026-10-31，税率6%，编号${randomUUID()}`;
  const protectedText=protectReportText(source,[quote]);const unit:ReportTranslationUnit={id:'u_012345678901234567890123',source,...protectedText,target:'',origin:'manual'};
  unit.target=`Original quotation and reference data: ${unit.protectedValues.map(value=>value.token).join(' ')}`;
  const result=resolveReportTranslationUnit(unit);assert.ok(result.includes(quote));assert.ok(result.includes('2026-10-31'));assert.ok(result.includes('6%'));
  for(const changed of [unit.target.replace(unit.protectedValues[0].token,''),unit.target+unit.protectedValues[0].token,unit.target+' [[LAW_9999]]',unit.target+' 2030',unit.target+' ๒๕๗๓',unit.protectedSource])assert.throws(()=>validateReportTranslationUnit(unit,changed));
});

test('历史报告设置无language时中文默认，旧报告仍可导出且未改写原审核',async()=>{
  const f=await fixture();try{const {language:_language,...legacy}=defaultReportSettings();await f.assets.save({kind:'reporting_settings',expectedRevision:0,body:legacy});const saved=await runReportingCommand('reporting.settings.get',{},f) as any;assert.equal(saved.body.language,'zh');const original=f.store.getReview(f.review.id);const result=await runReportingCommand('reporting.render',{scope:'current',reviewId:f.review.id},f) as ReportingRenderResult;assert.ok(result.html.includes('合同审核管理报告'));assert.equal(result.snapshot.translation,undefined);assert.deepEqual(f.store.getReview(f.review.id),original);}finally{await f.close();}
});

test('英泰报告未填完或未人工确认时阻止全部导出，不静默回退中文',async()=>{
  const f=await fixture();try{for(const language of ['en','th'] as const){let value=await prepare(f,language);assert.ok(value.missingUnits>0);const metadata=value.asset.body.units.find(unit=>unit.source.startsWith('编制人 '))!;assert.ok(!metadata.protectedValues.some(value=>value.value==='法务'||value.value==='内部汇报'));await assert.rejects(runReportingCommand('reporting.render',{...request(f.review.id,language),translationId:value.asset.id},f),/人工确认/);await assert.rejects(approve(f,value),/尚未填写/);value=await fill(f,value);assert.equal(value.missingUnits,0);assert.equal(value.asset.body.state,'draft');await assert.rejects(runReportingCommand('reporting.render',{...request(f.review.id,language),translationId:value.asset.id},f),/人工确认/);assert.throws(()=>reportHtml(value.asset.body.sourceSnapshot),/未完成译文人工确认/);assert.throws(()=>reportCsv(value.asset.body.sourceSnapshot),/未完成译文人工确认/);}}finally{await f.close();}
});

test('英泰报告真实映射摘要风险建议人工意见，5格式共用已确认译文并保留原文、数字和日期',async()=>{
  const f=await fixture();try{const original=f.store.getReview(f.review.id);for(const language of ['en','th'] as const){const value=await approve(f,await fill(f,await prepare(f,language)));const rendered=await runReportingCommand('reporting.render',{...request(f.review.id,language),translationId:value.asset.id},f) as ReportingRenderResult;
    const expected=language==='en'?'The authorization process before payment is unspecified.':'ยังไม่ได้ระบุขั้นตอนอนุมัติก่อนชำระเงิน';const suggestion=language==='en'?'Pay after obtaining written payment authorization.':'ชำระเงินหลังได้รับหนังสืออนุมัติการชำระเงิน';
    for(const output of [rendered.html,rendered.markdown]){assert.ok(output.includes(expected));assert.ok(output.includes(suggestion));assert.ok(output.includes(f.document.blocks[0].text));assert.ok(output.includes('2026-10-31'));assert.ok(output.includes('CNY 99,000.50'));assert.ok(!output.includes('[[LAW_'));}
    assert.ok(rendered.html.includes(language==='en'?'<html lang="en">':'<html lang="th">'));assert.ok(rendered.csv.includes(language==='en'?'Prepayment authorization risk':'ความเสี่ยงเรื่องอำนาจอนุมัติเงินล่วงหน้า'));assert.ok(rendered.csv.includes(language==='en'?'More information needed':'ต้องการข้อมูลเพิ่มเติม'));assert.ok(!rendered.csv.includes('[[LAW_'));
    const zip=await JSZip.loadAsync(Buffer.from(rendered.docxBase64,'base64'));const xml=await zip.file('word/document.xml')!.async('string');const styles=await zip.file('word/styles.xml')!.async('string');assert.equal(XMLValidator.validate(xml),true);assert.ok(xml.includes(expected));assert.ok(xml.includes(suggestion));assert.ok(xml.includes('CNY 99,000.50'));assert.ok(styles.includes(`w:val="${language==='en'?'en-US':'th-TH'}"`));if(language==='th'){assert.ok(styles.includes('w:ascii="Tahoma"'));assert.ok(rendered.html.includes("'Noto Sans Thai'"));}
    // The same HTML is the PDF print input. No translated PDF-only text path exists.
    for(const format of ['docx','pdf','markdown','html','csv'])await runReportingCommand('reporting.recordExport',{format,sha256:hash(format),snapshot:rendered.snapshot},f);
    assert.equal(rendered.snapshot.translation?.assetId,value.asset.id);assert.equal(rendered.snapshot.translation?.revision,value.asset.revision);
  }assert.equal(f.assets.list('report_export').length,10);assert.deepEqual(f.store.getReview(f.review.id),original);}finally{await f.close();}
});

test('报告译文冻结快照的比较时钟不造成过期，处置修改后立即失效且编辑撤销确认',async()=>{
  const f=await fixture();try{let value=await approve(f,await fill(f,await prepare(f)));const oldSnapshot=value.asset.body.sourceSnapshot;const later=buildReportSnapshot(normalizeReportRequest(request(f.review.id,'en')),f.store,oldSnapshot.settings,'2030-01-01T00:00:00Z',f.assets,f.dir);assert.equal(reportDependencySha256(oldSnapshot),reportDependencySha256(later));
    const unit=value.asset.body.units.find(unit=>unit.source==='付款前未明确授权流程。')!;value=await runReportingCommand('reporting.translation.save',{id:value.asset.id,expectedRevision:value.asset.revision,actorLabel:'合成译者',edits:[{id:unit.id,target:'Payment authorization has not been specified.'}]},f) as ReportTranslationWorkspace;assert.equal(value.asset.body.state,'draft');assert.equal(value.asset.body.approvedAt,null);value=await approve(f,value);
    await f.store.saveRiskDisposition({reviewId:f.review.id,findingId:f.review.findings[0].id,expectedRevision:1,status:'escalated',reason:'审批范围变更，需要重新决策。',actorLabel:'合成法务'});
    const checked=await runReportingCommand('reporting.translation.get',{id:value.asset.id},f) as ReportTranslationWorkspace;assert.equal(checked.stale,true);await assert.rejects(runReportingCommand('reporting.render',{...request(f.review.id,'en'),translationId:value.asset.id},f),/过期/);assert.ok(f.assets.history(value.asset.id).length>=4);
  }finally{await f.close();}
});

test('译文命令拒绝伪造来源/单元/范围/语言与导出快照，CAS冲突不覆盖',async()=>{
  const f=await fixture();try{let value=await prepare(f);await assert.rejects(runReportingCommand('reporting.translation.prepare',{request:request(f.review.id,'en'),actorLabel:'测试',sourceSnapshot:{}},f));await assert.rejects(runReportingCommand('reporting.translation.save',{id:value.asset.id,expectedRevision:value.asset.revision,actorLabel:'测试',edits:[{id:'u_012345678901234567890123',target:'Forged'}]},f),/不属于/);
    value=await fill(f,value);await assert.rejects(runReportingCommand('reporting.translation.save',{id:value.asset.id,expectedRevision:1,actorLabel:'测试',edits:[{id:value.asset.body.units[0].id,target:value.asset.body.units[0].target}]},f),/已更新/);value=await approve(f,value);
    await assert.rejects(runReportingCommand('reporting.render',{...request(f.review.id,'th'),translationId:value.asset.id},f),/语言/);await assert.rejects(runReportingCommand('reporting.render',{...request(f.review.id,'en'),style:'summary',translationId:value.asset.id},f),/不一致/);
    const rendered=await runReportingCommand('reporting.render',{...request(f.review.id,'en'),translationId:value.asset.id},f) as ReportingRenderResult;const forged=structuredClone(rendered.snapshot);const block=forged.translation!.blocks.find(block=>block.type==='text');if(block&&block.type!=='table')block.text='Forged source report';const {snapshotSha256:_old,...content}=forged;forged.snapshotSha256=hash(JSON.stringify(content));await assert.rejects(runReportingCommand('reporting.recordExport',{format:'html',sha256:hash('x'),snapshot:forged},f),/可信记录不一致/);
  }finally{await f.close();}
});

test('目标语言译文始终转义HTML/Markdown/CSV，不执行候选中的内容',async()=>{
  const f=await fixture();try{let value=await fill(f,await prepare(f));const titleUnit=value.asset.body.units.find(unit=>unit.source==='预付款授权风险')!;value=await runReportingCommand('reporting.translation.save',{id:value.asset.id,expectedRevision:value.asset.revision,actorLabel:'测试',edits:[{id:titleUnit.id,target:'=HYPERLINK("https://invalid","x")<script>bad()</script>'},{id:value.asset.body.units.find(unit=>unit.source==='付款前未明确授权流程。')!.id,target:'<script>bad()</script>'}]},f) as ReportTranslationWorkspace;value=await approve(f,value);const rendered=await runReportingCommand('reporting.render',{...request(f.review.id,'en'),translationId:value.asset.id},f) as ReportingRenderResult;assert.ok(rendered.html.includes('&lt;script&gt;'));assert.ok(!rendered.html.includes('<script>'));assert.ok(rendered.markdown.includes('&lt;script&gt;'));assert.ok(rendered.csv.includes('"\'=HYPERLINK'));
  }finally{await f.close();}
});

test('显式模型翻译真实调用已配API，候选保持未确认，保护失败不保存半份结果',async()=>{
  const f=await fixture();let mode:'valid'|'invalid'='valid';let calls=0;let failAt=0;let lastAuth='';
  const server=createServer(async(req,res)=>{let raw='';for await(const data of req)raw+=data;const body=JSON.parse(raw);calls++;lastAuth=String(req.headers.authorization);const input=JSON.parse(body.messages[1].content);const entries=input.entries.map((entry:{id:string;text:string})=>({id:entry.id,text:'Translated narrative '+[...entry.text.matchAll(/\[\[LAW_[0-9]+\]\]/gu)].map(value=>value[0]).join(' ')}));if(mode==='invalid'&&calls>=failAt)entries[0].text+=' 2030';res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:'synthetic-model',choices:[{message:{content:JSON.stringify({entries,warnings:['Synthetic engineering translation.']})}}],usage:{prompt_tokens:100,completion_tokens:50}}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));try{const address=server.address() as any;await f.store.saveConfig({provider:'chat-completions',name:'synthetic-loopback',baseUrl:`http://127.0.0.1:${address.port}/v1`,model:'synthetic-model',responseFormat:'json_schema',tokenParameter:'max_tokens',maxOutputTokens:4096,contextWindowTokens:32000,timeoutSeconds:10});let value=await prepare(f);value=await generateReportTranslation(f,{id:value.asset.id,expectedRevision:value.asset.revision,actorLabel:'合成译者',confirmed:true},'synthetic-key',new AbortController().signal);assert.ok(calls>1);assert.equal(lastAuth,'Bearer synthetic-key');assert.equal(value.missingUnits,0);assert.equal(value.asset.body.state,'draft');assert.equal(value.asset.body.modelId,'synthetic-model');assert.ok(!JSON.stringify(f.assets.history(value.asset.id)).includes('synthetic-key'));
    const again=await prepare(f);mode='invalid';failAt=calls+2;await assert.rejects(generateReportTranslation(f,{id:again.asset.id,expectedRevision:again.asset.revision,actorLabel:'合成译者',confirmed:true},'synthetic-key',new AbortController().signal),/数值/);assert.equal(f.assets.get(again.asset.id).revision,1);
    mode='valid';const queuedValue=await prepare(f);let release:()=>void=()=>{};let queued=false;
    const gatedAssets=new WorkspaceAssets(f.store,operation=>new Promise((resolve,reject)=>{queued=true;release=()=>void operation().then(resolve,reject);}));const controller=new AbortController();
    const pending=generateReportTranslation({...f,assets:gatedAssets},{id:queuedValue.asset.id,expectedRevision:1,actorLabel:'合成译者',confirmed:true},'synthetic-key',controller.signal);const cancellation=assert.rejects(pending,/abort/i);const until=Date.now()+3000;while(!queued&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(queued,true);controller.abort();release();await cancellation;assert.equal(f.assets.get(queuedValue.asset.id).revision,1,'cancel while waiting for commit must not save');
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});


test('事实假设与人工来源意见进入译文，来源原文不改写，核验记录变更使确认失效',async()=>{
  const f=await fixture();try{
    await runReviewCompletionCommand('reviewCompletion.facts.save',{documentId:f.document.id,expectedRevision:0,actorLabel:'合成法务',reason:'仅供工程验证',items:[{id:randomUUID(),kind:'fact',label:'验收条件事实',detail:'付款须在验收后。',status:'confirmed',required:true,scopes:['payment'],blockIds:[f.blockId],quote:f.document.blocks[0].text,reason:'合成已确认业务事实。'}]},f);
    const before=await getWorkflowBeforeReview(f,f.document.id);const sourceId=randomUUID();const attemptId=randomUUID();const config=defaultRetrievalConfig();config.web={...config.web,enabled:true,baseUrl:'https://example.invalid/search'};await f.store.saveConfig({name:'合成模型配置',baseUrl:'https://example.invalid/model',model:'synthetic',responseFormat:'json_schema',tokenParameter:'max_tokens',maxOutputTokens:1024,contextWindowTokens:32000,timeoutSeconds:10});const sourceExcerpt='法源原文工程样本：2026-10-31，CNY 99,000.50；不是法律意见。';
    const enriched:ReviewResult={...f.review,id:randomUUID(),findings:f.review.findings.map(finding=>({...finding,id:randomUUID()})),mode:'model',modelId:'synthetic',completionSnapshot:before.snapshot,retrieval:{configSnapshot:config,knowledgeStatus:'user_disabled',webStatus:'complete',attempts:[{id:attemptId,channel:'web',provider:'searxng',query:'合成法源',status:'complete',startedAt:'2026-10-23T00:00:00Z',finishedAt:'2026-10-23T00:00:01Z',resultCount:1,error:null,warnings:[]}],evidence:[{id:sourceId,attemptId,channel:'web',kind:'statute',title:'合成法源标题',sourceUri:'https://example.invalid/synthetic-law',locator:'合成第1条',excerpt:sourceExcerpt,excerptSha256:hash(sourceExcerpt),contentScope:'fragment',retrievedAt:'2026-10-23T00:00:00Z',publishedAt:null,effectiveAt:null,currentness:'unknown',isOfficial:false,warnings:['未核实真实法律效力。']}],limitations:[]}};
    const taskId=randomUUID();const run=await f.store.createTask({id:taskId,documentId:f.document.id,status:'queued',stage:'synthetic',startedAt:enriched.createdAt,finishedAt:null,error:null,resultId:null},enriched.context,'model',config,f.store.getConfig());await f.store.saveReview(enriched,run);f.review=enriched;
    const verification={reviewId:enriched.id,evidenceId:sourceId,expectedRevision:0,actorLabel:'合成律师',status:'pending',authenticity:'工程来源，未核验真实性。',legalEffect:'待律师核对。',applicableFrom:'2026-10-01',applicableTo:'2026-10-31',applicableScope:'采信范围需要人工限定',conflictReason:'合成冲突仍需复核。',reason:'工程样本没有法律认证。'};await runReviewCompletionCommand('reviewCompletion.source.save',verification,f);
    const value=await approve(f,await fill(f,await prepare(f,'th')));const rendered=await runReportingCommand('reporting.render',{...request(enriched.id,'th'),translationId:value.asset.id},f) as ReportingRenderResult;assert.ok(rendered.html.includes('ข้อเท็จจริง: การชำระเงินขึ้นอยู่กับการตรวจรับ'));assert.ok(rendered.html.includes('การตรวจแหล่งข้อมูลโดยผู้ตรวจ: จำกัดขอบเขตการใช้ข้อมูลด้วยตนเอง'));assert.ok(rendered.html.includes(sourceExcerpt));assert.ok(rendered.html.includes('https://example.invalid/synthetic-law'));
    await runReviewCompletionCommand('reviewCompletion.source.save',{...verification,expectedRevision:1,reason:'人工来源采信理由更新。'},f);await assert.rejects(runReportingCommand('reporting.render',{...request(enriched.id,'th'),translationId:value.asset.id},f),/过期/);
  }finally{await f.close();}
});
