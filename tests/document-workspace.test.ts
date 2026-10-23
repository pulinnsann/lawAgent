import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm,lstat,mkdir,rename,symlink,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { createSampleContract } from '../src/core/sample';
import type { DocumentCatalog,TranslationWorkspace } from '../src/shared/document-workspace';
import type { ReviewTask } from '../src/shared/contracts';
import { recoverContractPurges } from '../src/core/document-purge';
import { randomUUID } from 'node:crypto';

const context={contractType:'service',ourPartyRole:'service_recipient',strictness:'balanced',businessContext:'虚构工程测试'} as const;
async function setup(){const root=await mkdtemp(join(tmpdir(),'law-document-workspace-'));const store=await AppStore.open(join(root,'data'));const tasks:ReviewTask[]=[];const service=new ContractService(store,join(root,'data'),t=>tasks.push(t));const document=await service.loadSample();const command=(action:string,payload?:unknown)=>service.runWorkspaceCommand({action,payload});const close=async()=>{await service.close();await rm(root,{recursive:true,force:true});};return{root,store,service,document,command,close,tasks};}
async function nextFile(root:string,label:string){const zip=await JSZip.loadAsync(await createSampleContract());const xml=await zip.file('word/document.xml')!.async('string');zip.file('word/document.xml',xml.replace('服务采购合同',`服务采购合同${label}`));const path=join(root,`${label}.docx`);await writeFile(path,await zip.generateAsync({type:'nodebuffer'}));return path;}
async function waitReview(f:Awaited<ReturnType<typeof setup>>){await f.service.startReview({documentId:f.document.id,context,mode:'local'},null);for(let i=0;i<400;i++){const t=f.tasks.at(-1);if(t&&['completed','failed','cancelled'].includes(t.status)){assert.equal(t.status,'completed',t.error??'');return f.service.getReview(t.resultId!);}await new Promise(r=>setTimeout(r,5));}throw new Error('审核未结束');}

test('项目、外稿版本链及乐观并发；归档/回收站恢复保留原文和审核',async()=>{const f=await setup();try{
 const projectId=await f.command('documents.project.save',{expectedRevision:0,name:'虚构业务项目',actorLabel:'测试人'});
 await assert.rejects(f.command('documents.project.save',{expectedRevision:0,name:'虚构业务项目',actorLabel:'测试人'}),/已存在/);
 let catalog=await f.command('documents.catalog') as DocumentCatalog;let contract=catalog.contracts[0];
 await f.command('documents.contract.assign',{contractId:contract.id,expectedRevision:contract.revision,projectId,actorLabel:'测试人'});
 const file=await nextFile(f.root,'对方第二稿');const external=await f.service.importVersionFile(file,{parentDocumentId:f.document.id,expectedLatestDocumentId:f.document.id});
 assert.equal(external.contractId,f.document.contractId);assert.equal(external.versionNo,2);assert.equal(external.parentVersionId,f.document.id);assert.equal(external.projectId,projectId);
 assert.equal((await f.service.importVersionFile(file,{parentDocumentId:f.document.id,expectedLatestDocumentId:f.document.id})).id,external.id);
 await assert.rejects(f.service.importVersionFile(await nextFile(f.root,'并发第三稿'),{parentDocumentId:f.document.id,expectedLatestDocumentId:f.document.id}),/已有更新版本/);
 assert.equal(f.store.getDocument(f.document.id).blocks[0].text,f.document.blocks[0].text);
 const review=await waitReview(f);catalog=await f.command('documents.catalog');contract=catalog.contracts[0];
 await f.command('documents.contract.status',{id:contract.id,expectedRevision:contract.revision,status:'archived',actorLabel:'测试人',reason:'归档测试'});
 assert.equal(f.service.getState().documents.length,0);assert.equal(f.service.getReview(review.id).id,review.id);
 await assert.rejects(f.service.startReview({documentId:f.document.id,mode:'local',context},null),/归档/);
 catalog=await f.command('documents.catalog');contract=catalog.contracts[0];await f.command('documents.contract.status',{id:contract.id,expectedRevision:contract.revision,status:'active',actorLabel:'测试人',reason:'恢复测试'});
 assert.equal(f.service.getState().documents.length,2);
 catalog=await f.command('documents.catalog');const project=catalog.projects[0];await f.command('documents.project.status',{id:project.id,expectedRevision:project.revision,status:'trashed',actorLabel:'测试人',reason:'回收站测试'});
 assert.equal(f.service.getState().documents.length,0);catalog=await f.command('documents.catalog');await f.command('documents.project.status',{id:project.id,expectedRevision:catalog.projects[0].revision,status:'active',actorLabel:'测试人',reason:'恢复项目'});
 assert.equal(f.service.getState().documents.length,2);assert.deepEqual(f.store.rows('PRAGMA foreign_key_check'),[]);
 }finally{await f.close();}});

test('译文独立版本与人工状态：错误原文hash、错误关联、旧修订号均被阻止',async()=>{const f=await setup();try{
 const workspace=await f.command('translations.get',{documentId:f.document.id}) as TranslationWorkspace;const block=workspace.blocks[0];
 const input={documentId:f.document.id,blockId:block.id,sourceTextSha256:block.sourceTextSha256,sourceFileSha256:workspace.sourceFileSha256,targetLanguage:'th',text:'ข้อความตัวอย่างสำหรับทดสอบเท่านั้น',status:'unreviewed',actorLabel:'测试人',reason:'人工参考译文',origin:'manual',modelId:null,expectedRevision:0};
 await assert.rejects(f.command('translations.save',{...input,sourceTextSha256:'0'.repeat(64)}),/原文已变化/);
 const first=await f.command('translations.save',input);await assert.rejects(f.command('translations.save',{...input,text:'另一个并发译文'}),/已有此语言译文/);
 await assert.rejects(f.command('translations.save',{...input,id:first.id,expectedRevision:1,status:'reviewed'}),/人工确认/);
 const second=await f.command('translations.save',{...input,id:first.id,expectedRevision:1,status:'reviewed',confirmed:true,reason:'按原文核对'});assert.equal(second.revision,2);
 await assert.rejects(f.command('translations.save',{...input,id:first.id,expectedRevision:1,text:'旧页覆盖'}),/已更新/);
 await assert.rejects(f.command('translations.save',{...input,id:first.id,expectedRevision:2,blockId:workspace.blocks[1].id,sourceTextSha256:workspace.blocks[1].sourceTextSha256}),/不可更改/);
 const history=await f.command('translations.history',{id:first.id});assert.equal(history.length,2);assert.equal(history[0].body.status,'unreviewed');assert.equal(history[1].body.status,'reviewed');
 assert.equal(f.store.getDocument(f.document.id).blocks[0].text,block.text);
 }finally{await f.close();}});

test('永久清理限定回收站和名称确认；关联文件/报告/译文清理且其他合同保留',async()=>{const f=await setup();try{
 await waitReview(f);const other=await f.service.importFile(await nextFile(f.root,'独立合同'));
 const ws=await f.command('translations.get',{documentId:f.document.id}) as TranslationWorkspace;await f.command('translations.save',{documentId:f.document.id,blockId:ws.blocks[0].id,sourceTextSha256:ws.blocks[0].sourceTextSha256,sourceFileSha256:ws.sourceFileSha256,targetLanguage:'en',text:'Synthetic translation',status:'unreviewed',actorLabel:'测试人',reason:'测试',expectedRevision:0});
 await assert.rejects(f.command('documents.inspectPurge',{contractId:f.document.contractId}),/先将合同移入/);
 let catalog=await f.command('documents.catalog') as DocumentCatalog;let c=catalog.contracts.find(c=>c.id===f.document.contractId)!;
 await f.command('documents.contract.status',{id:c.id,expectedRevision:c.revision,status:'trashed',actorLabel:'测试人',reason:'永久清理工程样本'});
 catalog=await f.command('documents.catalog');c=catalog.contracts.find(item=>item.id===f.document.contractId)!;
 const plan=await f.command('documents.inspectPurge',{contractId:c.id});assert.equal(plan.reportIds.length,1);assert.equal(plan.documentIds.length,1);
 await assert.rejects(f.command('documents.purge',{contractId:c.id,expectedRevision:c.revision,confirmation:'错误名称',actorLabel:'测试人',confirmed:true}),/确认名称不一致/);
 await f.command('documents.purge',{contractId:c.id,expectedRevision:c.revision,confirmation:c.title,actorLabel:'测试人',confirmed:true});
 assert.throws(()=>f.store.getDocument(f.document.id),/不存在/);assert.equal(f.store.getDocument(other.id).id,other.id);
 assert.equal(await lstat(join(f.root,'data/documents',f.document.id)).catch(()=>null),null);
 assert.equal(f.service.assets.list('reference_translation').length,0);assert.deepEqual(f.store.rows('PRAGMA foreign_key_check'),[]);
 assert.equal(f.store.rows("SELECT name FROM sqlite_master WHERE type='trigger' AND name='risk_disposition_event_no_delete'").length,1);
 }finally{await f.close();}});

test('清理中断后按数据库提交状态恢复原目录，防止误删和同名覆盖',async()=>{const f=await setup();try{
 const job=join(f.root,'data/contract-purge',randomUUID());await mkdir(job);await writeFile(join(job,'plan.json'),JSON.stringify({contractId:f.document.contractId,documentIds:[f.document.id]}));
 await rename(join(f.root,'data/documents',f.document.id),join(job,f.document.id));await recoverContractPurges(f.store,join(f.root,'data'));
 assert.ok(await readFile(join(f.root,'data/documents',f.document.id,'original.docx')));assert.equal(await lstat(job).catch(()=>null),null);
 }finally{await f.close();}});

test('并发译文唯一性检查与保存共用事务队列，归档后拒绝写入译文',async()=>{const f=await setup();try{
 const ws=await f.command('translations.get',{documentId:f.document.id}) as TranslationWorkspace;const b=ws.blocks[0];
 const input={documentId:f.document.id,blockId:b.id,sourceTextSha256:b.sourceTextSha256,sourceFileSha256:ws.sourceFileSha256,targetLanguage:'en',text:'Synthetic reference',status:'unreviewed',actorLabel:'测试人',reason:'并发保存',expectedRevision:0};
 const results=await Promise.allSettled([f.command('translations.save',input),f.command('translations.save',input)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.service.assets.list('reference_translation').length,1);
 const catalog=await f.command('documents.catalog') as DocumentCatalog;const c=catalog.contracts[0];await f.command('documents.contract.status',{id:c.id,expectedRevision:c.revision,status:'archived',actorLabel:'测试人',reason:'先归档'});
 await assert.rejects(f.command('translations.save',{...input,targetLanguage:'th'}),/归档/);
 }finally{await f.close();}});

test('清理恢复拒绝被替换为外部符号链接的documents父目录，原暂存文件保留',async()=>{const f=await setup();try{
 const job=join(f.root,'data/contract-purge',randomUUID());await mkdir(job);await writeFile(join(job,'plan.json'),JSON.stringify({contractId:f.document.contractId,documentIds:[f.document.id]}));
 const parent=join(f.root,'data/documents'),held=join(f.root,'held-documents'),outside=join(f.root,'outside');await mkdir(outside);await rename(parent,held);await rename(join(held,f.document.id),join(job,f.document.id));await symlink(outside,parent,'dir');
 await assert.rejects(recoverContractPurges(f.store,join(f.root,'data')),/链接/);assert.deepEqual(await readdir(outside),[]);assert.ok(await lstat(join(job,f.document.id)));
 await rm(parent);await rename(held,parent);await recoverContractPurges(f.store,join(f.root,'data'));assert.ok(await lstat(join(parent,f.document.id)));
 }finally{await f.close();}});
