import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../src/core/storage';
import { WorkspaceAssets } from '../src/core/workspace-assets';
import { getApplicableAdvisorPackages,runAdvisorCommand } from '../src/core/workspace-advisor';
import { defaultLibraryScope,type AdvisorPromptAsset,type AdvisorSampleAsset,type AdvisorRegressionAsset } from '../src/shared/library';
const context={contractType:'service' as const,ourPartyRole:'service_recipient' as const};
test('顾问包须当前内容样本回归和人工评审后批准；样本修改使启用依据失效且历史保留',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'law-advisor-'));const store=await AppStore.open(dir);const assets=new WorkspaceAssets(store);const command=<T,>(action:string,payload:unknown={})=>runAdvisorCommand(action,payload,{assets}) as Promise<T>;
 try{
 const input={expectedRevision:0,name:'顾问测试方法',content:'根据已给定的交易事实核对交付约定。',scope:defaultLibraryScope(),state:'candidate',reason:'仅为合成工程用例',actorLabel:'测试法务',advisorLabel:'人工提供的测试顾问标签',regressionId:null};
 const pack=await command<AdvisorPromptAsset>('library.advisor.save',input);assert.equal(getApplicableAdvisorPackages({assets},context).length,0);
 await assert.rejects(command('library.advisor.save',{...input,id:pack.id,expectedRevision:1,state:'approved',confirmed:true}),/回归/);
 const sampleInput={expectedRevision:0,packageId:pack.id,packageRevision:pack.revision,name:'交付期望测试',text:'甲方：测试企业甲。乙方：测试企业乙。服务按附件清单交付。',source:'完全合成样本',reason:'工程匹配验证',actorLabel:'测试法务',expectedRisks:[{key:'delivery',terms:['交付范围'],category:'legal',severity:'medium'}],observedRisks:[{title:'交付范围需确认',description:'人工登记的观察结果。',category:'legal',severity:'medium'}]};
 const sample=await command<AdvisorSampleAsset>('library.advisor.sample.save',sampleInput);
 const run=await command<AdvisorRegressionAsset>('library.advisor.regression.run',{packageId:pack.id,expectedRevision:1,sampleIds:[sample.id],actorLabel:'测试法务'});assert.equal(run.body.passed,true);assert.equal(run.body.legalCorrectnessCertified,false);assert.equal(run.body.samples[0].programReport.checks.length,4);
 await assert.rejects(command('library.advisor.save',{...input,id:pack.id,expectedRevision:1,state:'approved',confirmed:true,regressionId:run.id}),/人工接受/);
 const reviewed=await command<AdvisorRegressionAsset>('library.advisor.regression.review',{id:run.id,expectedRevision:1,status:'accepted',reason:'人工核对合成观察匹配，不作法律有效性认证。',actorLabel:'测试法务',confirmed:true});assert.equal(reviewed.revision,2);
 const approved=await command<AdvisorPromptAsset>('library.advisor.save',{...input,id:pack.id,expectedRevision:1,state:'approved',confirmed:true,regressionId:run.id});const snapshots=getApplicableAdvisorPackages({assets},context);assert.equal(snapshots[0].revision,2);assert.equal(snapshots[0].regression.packageRevision,1);assert.equal(snapshots[0].body.state,'approved');
 await assert.rejects(command('library.advisor.save',{...input,id:pack.id,expectedRevision:2,state:'approved',content:'发生变化的实务方法',confirmed:true,regressionId:run.id}),/过期/);
 await command('library.advisor.sample.save',{...sampleInput,id:sample.id,expectedRevision:1,packageRevision:approved.revision,text:sampleInput.text+'测试更新。'});assert.equal(getApplicableAdvisorPackages({assets},context).length,0);assert.equal(snapshots[0].body.state,'approved');assert.equal((await command<unknown[]>('library.advisor.history',{id:pack.id})).length,2);
 await assert.rejects(command('library.advisor.sample.save',{...sampleInput,packageRevision:1}),/更新/);
 const restored=await command<AdvisorPromptAsset>('library.advisor.rollback',{id:pack.id,expectedRevision:2,revision:1,actorLabel:'测试法务',reason:'回退旧内容需重新人工确认。'});assert.equal(restored.body.state,'candidate');assert.equal(restored.body.regressionId,null);assert.equal(assets.history(pack.id).length,3);const current=assets.get(sample.id);await command('library.advisor.sample.remove',{id:sample.id,expectedRevision:current.revision,actorLabel:'测试法务',reason:'停用合成样本，历史保留。'});assert.equal((await command<unknown[]>('library.advisor.samples',{packageId:pack.id})).length,0);assert.equal(assets.history(sample.id).length,3);
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});
test('未匹配期望风险的回归不能通过人工接受升级为批准依据',async()=>{const dir=await mkdtemp(join(tmpdir(),'law-advisor-negative-'));const store=await AppStore.open(dir),assets=new WorkspaceAssets(store);const command=<T,>(action:string,payload:unknown)=>runAdvisorCommand(action,payload,{assets}) as Promise<T>;try{const input={expectedRevision:0,name:'测试包',content:'人工方法',scope:defaultLibraryScope(),state:'candidate',reason:'合成测试',actorLabel:'测试',advisorLabel:'顾问测试',regressionId:null};const pack=await command<AdvisorPromptAsset>('library.advisor.save',input);const sample=await command<AdvisorSampleAsset>('library.advisor.sample.save',{expectedRevision:0,packageId:pack.id,packageRevision:1,name:'未匹配样本',text:'无对应观察结果。',source:'合成',reason:'验证未匹配分支',actorLabel:'测试',expectedRisks:[{key:'missing',terms:['不可能匹配的期望'],category:'legal',severity:'high'}],observedRisks:[]});const run=await command<AdvisorRegressionAsset>('library.advisor.regression.run',{packageId:pack.id,expectedRevision:1,sampleIds:[sample.id],actorLabel:'测试'});assert.equal(run.body.passed,false);await command('library.advisor.regression.review',{id:run.id,expectedRevision:1,status:'accepted',reason:'人工接受记录仍不能伪造程序通过',actorLabel:'测试',confirmed:true});await assert.rejects(command('library.advisor.save',{...input,id:pack.id,expectedRevision:1,state:'approved',confirmed:true,regressionId:run.id}),/未通过/);}finally{await store.close();await rm(dir,{recursive:true,force:true});}});
