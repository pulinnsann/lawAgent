import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { createDocx } from './fixtures-documents';
import { defaultReportSettings } from '../src/shared/reporting';
import type { ClauseAlignmentAsset, ClauseAlignmentWorkspace } from '../src/shared/clause-alignment';
import type { ReviewContext, ReviewTask } from '../src/shared/contracts';
import type { ReportTranslationWorkspace } from '../src/shared/report-translation';
import { nativeInterfaceText } from '../src/shared/interface-language';

const actorLabel='Synthetic reviewer', key='synthetic-engineering-only';
const context:ReviewContext={contractType:'service',ourPartyRole:'service_recipient',strictness:'balanced',businessContext:'Synthetic multilingual integration test'};
const paragraphs=['第1条 买方必须在30日内支付人民币100元。','Article 1. The buyer shall pay CNY 120 within 60 days.','ข้อ 1. ผู้ซื้อต้องชำระเงิน 100 บาทภายใน 30 วัน'];
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'law-multilingual-service-'));const calls:Array<{input:any;authorization:string}>=[];
 const server=createServer(async(req,res)=>{let raw='';for await(const data of req)raw+=data;const body=JSON.parse(raw),input=JSON.parse(body.messages[1].content);calls.push({input,authorization:String(req.headers.authorization)});
  let result:unknown;
  if(input.contractBlocks)result={summary:'合成审核摘要，不代表法律意见。',reviewedBlockIds:input.contractBlocks.map((b:any)=>b.id),findings:[]};
  else if(input.entries)result={entries:input.entries.map((entry:any)=>({id:entry.id,text:'Synthetic translated narrative '+[...entry.text.matchAll(/\[\[LAW_[0-9]+\]\]/gu)].map((m:any)=>m[0]).join(' ')})),warnings:[]};
  else result={summary:'Synthetic comparison candidate',differences:[{category:'amount_date',description:'Synthetic values differ; verify manually.',blockRefs:input.segments.slice(0,2).map((s:any)=>({documentId:s.documentId,blockId:s.blocks[0].blockId}))}],warnings:[]};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:'synthetic-local-model',choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:100,completion_tokens:40}}));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as any;
 const store=await AppStore.open(join(dir,'data'));const tasks:ReviewTask[]=[];const service=new ContractService(store,join(dir,'data'),task=>tasks.push(task));
 const file=join(dir,'synthetic-trilingual.docx');await writeFile(file,await createDocx({paragraphs}));const document=await service.importFile(file);
 await service.saveConfig({name:'Synthetic loopback',baseUrl:`http://127.0.0.1:${address.port}/v1`,model:'synthetic-local-model',responseFormat:'json_schema',tokenParameter:'max_tokens',contextWindowTokens:128000,maxOutputTokens:4096,timeoutSeconds:5});
 const command=(action:string,payload:unknown={})=>service.runWorkspaceCommand({action,payload},{},key);
 const finish=async(id:string)=>{for(let i=0;i<500;i++){const task=[...tasks].reverse().find(t=>t.id===id&&['completed','failed','cancelled'].includes(t.status));if(task){assert.equal(task.status,'completed',task.error??'');return service.getReview(task.resultId!);}await new Promise(r=>setTimeout(r,10));}throw new Error('Synthetic review timeout');};
 const workspace=await command('alignment.get',{contractId:document.contractId}) as ClauseAlignmentWorkspace;const source=workspace.documents[0];
 const input={contractId:document.contractId,expectedRevision:0,label:'Payment',segments:(['zh','en','th'] as const).map((language,i)=>({language,documentId:source.id,sourceFileSha256:source.sourceFileSha256,blocks:[{blockId:source.blocks[i].id,textSha256:source.blocks[i].textSha256}]})),state:'candidate',priority:{state:'unspecified',language:null,basis:'No priority text confirmed',blockRefs:[]},actorLabel,reason:'Synthetic source-bound mapping'};
 const group=await command('alignment.save',input) as ClauseAlignmentAsset;
 const close=async()=>{await service.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});};
 return{dir,store,service,document,calls,command,finish,group,input,close};
}

test('service freezes trusted multilingual mappings in model input, checkpoint and saved review; later mapping changes flag historical review',async()=>{
 const f=await fixture();try{
  const started=await f.service.startReview({documentId:f.document.id,mode:'model',context:{...context,alignmentSnapshot:{contentSha256:'forged-client',groups:[{body:{label:'FORGED CLIENT'}}]} as never}},key);const review=await f.finish(started.taskId);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].authorization,`Bearer ${key}`);assert.equal(f.calls[0].input.alignmentSnapshot.groups[0].id,f.group.id);assert.equal(review.alignmentSnapshot?.groups[0].body.segments[2].blocks[0].text,paragraphs[2]);assert.ok(!JSON.stringify(review).includes('FORGED CLIENT'));assert.ok(review.coverage.limitations.some(t=>t.includes('优先文本')));
  assert.deepEqual(f.store.getReview(review.id).alignmentSnapshot,review.alignmentSnapshot);
  const before=await f.command('reviewCompletion.freshness',{reviewId:review.id});assert.ok(!before.reasons.some((r:any)=>r.kind==='alignment'));
  await f.command('alignment.save',{...f.input,id:f.group.id,expectedRevision:1,state:'confirmed',confirmed:true,reason:'Human confirmed source correspondence only'});
  const after=await f.command('reviewCompletion.freshness',{reviewId:review.id});assert.ok(after.reasons.some((r:any)=>r.kind==='alignment'));assert.equal(f.store.getReview(review.id).alignmentSnapshot?.groups[0].revision,1);
 }finally{await f.close();}
});

test('alignment model comparison uses configured credential and runtime ledger, stays a candidate, and rejects credential-containing source records',async()=>{
 const f=await fixture();try{
  const compared=await f.command('alignment.compare',{id:f.group.id,expectedRevision:1,confirmed:true,actorLabel,reason:'Explicit synthetic comparison'}) as ClauseAlignmentAsset;
  assert.equal(compared.body.comparison?.candidateOnly,true);assert.equal(compared.body.state,'candidate');assert.equal(f.calls[0].authorization,`Bearer ${key}`);
  const ledger=f.service.assets.list('model_runtime_run');assert.equal(ledger[0].body.operation,'clause_alignment');assert.equal(ledger[0].body.calls.length,1);assert.ok(!JSON.stringify(ledger).includes(key));
  await f.command('alignment.save',{...f.input,id:f.group.id,expectedRevision:compared.revision,label:key});const count=f.calls.length;
  await assert.rejects(f.command('alignment.compare',{id:f.group.id,expectedRevision:compared.revision+1,confirmed:true,actorLabel,reason:'Must not dispatch'}),/凭据/);assert.equal(f.calls.length,count);
 }finally{await f.close();}
});

test('report translation runs through service budgets and becomes stale after alignment changes; permanent cleanup includes both multilingual asset kinds',async()=>{
 const f=await fixture();try{
  const started=await f.service.startReview({documentId:f.document.id,mode:'local',context},null);const review=await f.finish(started.taskId);
  const request={scope:'current',reviewId:review.id,style:'risk',settings:{...defaultReportSettings(),language:'en'}};
  let translation=await f.command('reporting.translation.prepare',{request,actorLabel}) as ReportTranslationWorkspace;
  translation=await f.command('reporting.translation.generate',{id:translation.asset.id,expectedRevision:translation.asset.revision,actorLabel,confirmed:true}) as ReportTranslationWorkspace;
  assert.equal(translation.missingUnits,0);assert.equal(translation.asset.body.state,'draft');assert.ok(f.calls.every(c=>c.authorization===`Bearer ${key}`));
  const ledgers=f.service.assets.list('model_runtime_run').filter(a=>a.body.operation==='report_translation');assert.equal(ledgers.length,1);assert.ok(ledgers[0].body.calls.length>0);assert.ok(!JSON.stringify(ledgers).includes(key));
  translation=await f.command('reporting.translation.confirm',{id:translation.asset.id,expectedRevision:translation.asset.revision,actorLabel,reason:'Synthetic language approval only',confirmed:true}) as ReportTranslationWorkspace;
  const rendered=await f.command('reporting.render',{...request,translationId:translation.asset.id});assert.ok(rendered.html.includes('<html lang="en">'));assert.ok(rendered.html.includes(paragraphs[0]));
  await f.command('alignment.save',{...f.input,id:f.group.id,expectedRevision:1,state:'disputed',reason:'Source correspondence now disputed'});
  assert.equal((await f.command('reporting.translation.get',{id:translation.asset.id})).stale,true);await assert.rejects(f.command('reporting.render',{...request,translationId:translation.asset.id}),/过期/);
  const catalog=await f.command('documents.catalog');const contract=catalog.contracts.find((c:any)=>c.id===f.document.contractId);
  await f.command('documents.contract.status',{id:contract.id,expectedRevision:contract.revision,status:'trashed',actorLabel,reason:'Synthetic cleanup'});
  const plan=await f.command('documents.inspectPurge',{contractId:contract.id});assert.ok(plan.relatedAssetIds.includes(translation.asset.id));assert.ok(plan.relatedAssetIds.includes(f.group.id));
 }finally{await f.close();}
});

test('native interface labels localize while unknown user-supplied values remain unchanged',()=>{
 assert.equal(nativeInterfaceText('en','导入合同'),'Import contract');assert.equal(nativeInterfaceText('th','导出报告'),'ส่งออกรายงาน');assert.equal(nativeInterfaceText('zh','合同文档'),'合同文档');assert.equal(nativeInterfaceText('th','user-contract.docx'),'user-contract.docx');
});
