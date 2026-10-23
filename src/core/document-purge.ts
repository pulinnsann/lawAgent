import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppStore } from './storage';

interface PurgePlan { operationId:string; contractId:string; documentIds:string[]; reportIds:string[]; runIds:string[]; relatedAssetIds:string[]; draftIds:string[]; title:string }
const uuid=z.string().uuid();
const hasReference=(value:unknown,ids:Set<string>):boolean=>typeof value==='string'?ids.has(value):Array.isArray(value)?value.some(v=>hasReference(v,ids)):!!value&&typeof value==='object'?Object.values(value).some(v=>hasReference(v,ids)):false;
export function inspectContractPurge(store:AppStore,contractId:string):PurgePlan {
 uuid.parse(contractId);const contract=store.rows('SELECT title,lifecycle_status FROM contracts WHERE id=? AND workspace_id=?',[contractId,store.workspaceId])[0];
 if(!contract)throw new Error('合同不存在或已清理。');if(contract.lifecycle_status!=='trashed')throw new Error('请先将合同移入回收站，再清理。');
 const documentIds=store.rows('SELECT id,artifact_uri FROM document_versions WHERE contract_id=?',[contractId]).map(r=>{const key=uuid.parse(r.id);if(!String(r.artifact_uri).startsWith(`documents/${key}/`))throw new Error('受管文件路径不符合当前合同目录约定，已阻止清理。');return key;});
 const runIds=store.rows('SELECT id FROM analysis_runs WHERE contract_id=?',[contractId]).map(r=>String(r.id));const identifiers=new Set([contractId,...documentIds,...runIds]);
 const reports=store.rows('SELECT id,input_manifest_json FROM reports WHERE workspace_id=?',[store.workspaceId]);const reportIds=reports.filter(r=>hasReference(JSON.parse(String(r.input_manifest_json)),identifiers)).map(r=>String(r.id));reportIds.forEach(v=>identifiers.add(v));
 const draftIds=store.rows('SELECT DISTINCT e.draft_id FROM contract_draft_exports e JOIN document_versions d ON d.id=e.document_version_id WHERE d.contract_id=?',[contractId]).map(r=>String(r.draft_id));
 // Prepared drafts also carry their source draft ID through authoring assets.
 const events=store.rows('SELECT entity_id,detail_json FROM audit_events WHERE workspace_id=?',[store.workspaceId]);
 const related=new Set<string>();let changed=true;while(changed){changed=false;for(const event of events){if(related.has(String(event.entity_id)))continue;const value=JSON.parse(String(event.detail_json));if(identifiers.has(String(event.entity_id))||hasReference(value,identifiers)){related.add(String(event.entity_id));identifiers.add(String(event.entity_id));if(value?.kind==='authoring_case'&&value?.body?.origin?.draftId)draftIds.push(String(value.body.origin.draftId));changed=true;}}}
 for(const key of new Set(draftIds)){const other=store.rows('SELECT e.id FROM contract_draft_exports e JOIN document_versions d ON d.id=e.document_version_id WHERE e.draft_id=? AND d.contract_id<>?',[key,contractId]);if(!other.length)identifiers.add(key);}
 return{operationId:randomUUID(),contractId,documentIds,reportIds,runIds,relatedAssetIds:[...related],draftIds:[...new Set(draftIds)].filter(k=>identifiers.has(k)),title:String(contract.title)};
}
async function ordinaryDirectory(path:string){const stat=await lstat(path);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('清理目录含有不受支持的链接或对象。');return realpath(path);}
/** Recover a crash on either side of the SQLite commit. A live contract wins:
 * its staged files are restored; only a committed deletion is swept. */
export async function recoverContractPurges(store:AppStore,dataDir:string):Promise<void>{
 const root=join(dataDir,'contract-purge');await mkdir(root,{recursive:true,mode:0o700});await ordinaryDirectory(root);
 for(const name of await readdir(root)){
  if(!uuid.safeParse(name).success)continue;const folder=join(root,name);await ordinaryDirectory(folder);
  let p:{contractId:string;documentIds:string[]};try{p=z.object({contractId:uuid,documentIds:z.array(uuid)}).parse(JSON.parse(await readFile(join(folder,'plan.json'),'utf8')));}catch{throw new Error('合同清理恢复记录不可读取，请保留清理目录并检查磁盘。');}
  const exists=store.rows('SELECT id FROM contracts WHERE id=? AND workspace_id=?',[p.contractId,store.workspaceId]).length>0;
  if(exists){await mkdir(join(dataDir,'documents'),{recursive:true});await ordinaryDirectory(join(dataDir,'documents'));for(const key of p.documentIds){const staged=join(folder,key);if(!await lstat(staged).catch(()=>null))continue;await ordinaryDirectory(staged);const target=join(dataDir,'documents',key);if(await lstat(target).catch(()=>null))throw new Error('清理恢复遇到同名目录，未覆盖任何文件。');await rename(staged,target);}}
  await rm(folder,{recursive:true,force:true});
 }
}
export async function purgeContract(store:AppStore,dataDir:string,payload:unknown):Promise<{deleted:true;versions:number;reports:number;message:string}>{
 const p=z.object({contractId:uuid,expectedRevision:z.number().int().min(1),confirmation:z.string().min(1).max(200),actorLabel:z.string().trim().min(1).max(80),confirmed:z.literal(true)}).strict().parse(payload);
 await recoverContractPurges(store,dataDir);const plan=inspectContractPurge(store,p.contractId);
 const row=store.rows('SELECT revision FROM contracts WHERE id=?',[plan.contractId])[0];if(Number(row.revision)!==p.expectedRevision||p.confirmation!==plan.title)throw new Error('合同已更新或确认名称不一致，请刷新清理清单。');
 const documentsRoot=join(dataDir,'documents');await ordinaryDirectory(documentsRoot);const folder=join(dataDir,'contract-purge',plan.operationId);await mkdir(folder,{mode:0o700});await writeFile(join(folder,'plan.json'),JSON.stringify({contractId:plan.contractId,documentIds:plan.documentIds}),{mode:0o600,flag:'wx'});
 try{
  for(const key of plan.documentIds){const original=join(documentsRoot,key);if(!await lstat(original).catch(()=>null))continue;await ordinaryDirectory(original);await rename(original,join(folder,key));}
  await store.transaction(()=>{
   store.rows('PRAGMA secure_delete=ON');store.rows('PRAGMA defer_foreign_keys=ON');
   // Only the explicit permanent-cleanup transaction may delete immutable
   // audit children. Restore every original trigger before committing.
   const triggers=store.rows("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%BEFORE DELETE%' AND tbl_name IN ('risk_disposition_events','change_editable_copy_events','contract_draft_exports','contract_drafts')");
   for(const t of triggers)store.rows(`DROP TRIGGER "${String(t.name).replaceAll('"','""')}"`);
   const remove=(table:string,column:string,ids:string[])=>{for(const key of ids)store.rows(`DELETE FROM ${table} WHERE ${column}=?`,[key]);};
   const runIds=plan.runIds,docIds=plan.documentIds,reviewIds=plan.reportIds;
   const findingIds=store.rows('SELECT f.id FROM findings f JOIN analysis_runs a ON a.id=f.analysis_run_id WHERE a.contract_id=?',[plan.contractId]).map(r=>String(r.id));
   const changeIds=store.rows('SELECT p.id FROM change_proposals p JOIN analysis_runs a ON a.id=p.analysis_run_id WHERE a.contract_id=?',[plan.contractId]).map(r=>String(r.id));
   remove('risk_disposition_events','review_id',reviewIds);remove('risk_disposition_workspaces','review_id',reviewIds);
   remove('change_proposal_events','review_id',reviewIds);remove('change_proposal_meta','review_id',reviewIds);remove('change_exports','review_id',reviewIds);remove('change_editable_copy_events','review_id',reviewIds);remove('change_workspaces','review_id',reviewIds);
   const feedbackIds=store.rows('SELECT id,analysis_run_id,finding_id,change_proposal_id FROM feedback WHERE workspace_id=?',[store.workspaceId]).filter(r=>runIds.includes(String(r.analysis_run_id))||findingIds.includes(String(r.finding_id))||changeIds.includes(String(r.change_proposal_id))).map(r=>String(r.id));
   const memoryIds=store.rows('SELECT id FROM memories WHERE contract_id=?',[plan.contractId]).map(r=>String(r.id));remove('memories','id',memoryIds);remove('feedback','id',feedbackIds);
   remove('report_sources','report_id',reviewIds);remove('reports','id',reviewIds);remove('change_proposals','id',changeIds);remove('dispositions','finding_id',findingIds);remove('finding_evidence','finding_id',findingIds);remove('findings','id',findingIds);
   const taskIds=store.rows('SELECT id,analysis_run_id FROM tasks WHERE workspace_id=?',[store.workspaceId]).filter(r=>runIds.includes(String(r.analysis_run_id))).map(r=>String(r.id));remove('command_receipts','task_id',taskIds);
   for(const run of runIds){store.rows('DELETE FROM evidence WHERE analysis_run_id=?',[run]);store.rows('DELETE FROM retrieval_attempts WHERE analysis_run_id=?',[run]);store.rows('DELETE FROM questions WHERE analysis_run_id=?',[run]);}
   remove('analysis_runs','id',runIds);remove('contract_draft_exports','document_version_id',docIds);
   remove('document_versions','id',docIds);remove('contracts','id',[plan.contractId]);remove('contract_drafts','id',plan.draftIds);
   remove('audit_events','entity_id',[...plan.relatedAssetIds,plan.contractId,...docIds,...runIds,...reviewIds,...plan.draftIds]);
   for(const t of triggers)store.rows(String(t.sql));
   if(store.rows('PRAGMA foreign_key_check').length)throw new Error('清理会影响其他合同或独立引用，已回滚，请先处理关联记录。');
   store.rows('INSERT INTO audit_events(id,workspace_id,entity_type,entity_id,action,actor_kind,actor_label,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[randomUUID(),store.workspaceId,'contract_purge',plan.contractId,'purged','user',p.actorLabel,JSON.stringify({operationId:plan.operationId,versions:docIds.length,reports:reviewIds.length,externalFilesRemoved:false}),new Date().toISOString()]);
  });
 }catch(e){await recoverContractPurges(store,dataDir);throw e;}
 await recoverContractPurges(store,dataDir);
 return{deleted:true,versions:plan.documentIds.length,reports:plan.reportIds.length,message:'当前工作区的合同原件、版本、关联审核与派生记录已清理。外部知识库、独立合同、已导出文件和历史备份需分别管理。'};
}
