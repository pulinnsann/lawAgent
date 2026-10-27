import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';

const root=resolve(import.meta.dirname,'..');
const entry=resolve(process.argv[2]??join(root,'out/desktop/backend.js'));
const execute=promisify(execFile);
const parent=await realpath(await mkdtemp(join(tmpdir(),'law-desktop-backend-')));
const dataDir=join(parent,'workspace');
const key=randomBytes(32);
const exportPath=join(parent,'retained-tracked-contract.docx');
let hostCalls=[];
const openSelections=[];
let backend;
async function launch(workspace=dataDir){
 const child=spawn(process.execPath,[entry],{cwd:root,env:{...process.env,LAW_AGENT_DATA_DIR:workspace,LAW_AGENT_STORAGE_BACKEND:'rust'},stdio:['pipe','pipe','pipe']});
 const pending=new Map();let content='';let diagnostics='';let readyResolve;let readyReject;let ready=false;let stoppedResolve;
 const readyPromise=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const stopped=new Promise(resolve=>{stoppedResolve=resolve;});
 child.stderr.on('data',chunk=>{diagnostics+=chunk.toString();});
 child.once('error',readyReject);
 child.once('exit',(code,signal)=>{if(!ready)readyReject(new Error(`Backend startup failed: ${code}/${signal}: ${diagnostics}`));for(const p of pending.values())p.reject(new Error(`Backend exited ${code}/${signal}`));pending.clear();stoppedResolve({code,signal});});
 const send=frame=>child.stdin.write(`${JSON.stringify(frame)}\n`);
 child.stdout.on('data',chunk=>{content+=chunk.toString();let end;while((end=content.indexOf('\n'))>=0){const message=JSON.parse(content.slice(0,end));content=content.slice(end+1);
  if(message.type==='ready'){ready=true;readyResolve();}
  if(message.type==='response'){const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(new Error(message.error)):message.data?.ok?p.resolve(message.data.data):p.reject(new Error(message.data?.error??'Missing desktop response.'));}}
  if(message.type==='host')void handleHost(message).then(data=>send({type:'hostResponse',id:message.id,data}),error=>send({type:'hostResponse',id:message.id,error:error.message}));
 }});
 async function handleHost(message){
  hostCalls.push(message.operation);
  switch(message.operation){
   case 'deviceIdentity':return{deviceCode:'LAWDEV1-'+'c'.repeat(64)};
   case 'licenseBuildMode':return'development';
   case 'showSaveDialog':return{canceled:false,filePath:exportPath};
   case 'showOpenDialog':return openSelections.length?{canceled:false,filePaths:[openSelections.shift()]}:{canceled:true,filePaths:[]};
   case 'credentialAvailable':return true;
   case 'credentialEncrypt':{const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);const encrypted=Buffer.concat([cipher.update(message.payload.value,'utf8'),cipher.final()]);return{base64:Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64')};}
   case 'credentialDecrypt':{const bytes=Buffer.from(message.payload.base64,'base64');const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return{result:Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')};}
   case 'setTitle':return null;
   default:throw new Error(`Unplanned native host operation: ${message.operation}`);
  }
 }
 const timeout=setTimeout(()=>readyReject(new Error(`Backend readiness timed out: ${diagnostics}`)),30_000);
 try{await readyPromise;}catch(error){child.kill('SIGKILL');await stopped;throw error;}finally{clearTimeout(timeout);}
 const invoke=(name,payload)=>new Promise((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timed out: ${name}`));},60_000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});send({type:'invoke',id,name,payload});});
 let closeTask;
 const close=()=>closeTask??=(async()=>{send({type:'shutdown',id:randomUUID()});const deadline=setTimeout(()=>child.kill('SIGKILL'),30_000);try{const exit=await stopped;assert.equal(exit.code,0,diagnostics);assert.equal(content,'');}finally{clearTimeout(deadline);}})();
 return{invoke,close};
}
try{
 backend=await launch(join(parent,'fresh-workspace'));assert.equal((await backend.invoke('getState')).documents.length,0);await backend.invoke('loadSample');assert.equal((await backend.invoke('getState')).documents.length,1);await backend.close();backend=undefined;
 const {stdout}=await execute(process.execPath,['--import','tsx','scripts/seed-business-storage-fixture.mjs','--data-dir',dataDir,'--documents','3'],{cwd:root,env:{...process.env,LAW_AGENT_STORAGE_BACKEND:'sqljs'},maxBuffer:4*1024**2});
 const fixture=JSON.parse(stdout);
 const originalDatabase=await readFile(join(dataDir,'workspace.sqlite'));
 const originalContract=await readFile(join(dataDir,fixture.originalRelativePath));
 const legacyKey=Buffer.from('Synthetic Electron ciphertext: preserve exactly.');
 await mkdir(join(dataDir,'credentials'),{recursive:true});await writeFile(join(dataDir,'credentials/model-key.bin'),legacyKey,{mode:0o600});
 backend=await launch();
 const before=await backend.invoke('getState');assert.equal(before.storageBackend,'rust');assert.equal(before.documents.length,3);assert.equal(before.credentialMigration.legacyCredentialFiles,1);assert.deepEqual(await readFile(join(dataDir,'workspace.sqlite.pre-rust-backup')),originalDatabase);
 assert.deepEqual(await backend.invoke('getReview',fixture.reviewId),fixture.review);
 let changes=await backend.invoke('getChanges',fixture.reviewId);assert.equal(changes.proposals[0].status,'accepted');
 const exported=await backend.invoke('exportModified',{reviewId:fixture.reviewId,expectedRevision:changes.revision,format:'tracked',revisionAuthor:'Tauri backend QA'});
 assert.equal(exported.documentPath,exportPath);
 const zip=await JSZip.loadAsync(await readFile(exportPath));const xml=await zip.file('word/document.xml').async('string');assert.match(xml,/Tauri backend QA/u);assert.match(xml,/Original Author/u);assert.match(xml,/<w:b\s*\/>/u);assert.match(xml,/<[\w-]+:ins\b/u);
 const document=await backend.invoke('getDocument',fixture.documentId);const task=await backend.invoke('startReview',{documentId:fixture.documentId,mode:'local',context:{contractType:'service',ourPartyRole:'service_recipient',businessContext:'Synthetic desktop migration validation',strictness:'balanced'}});
 for(let attempt=0;attempt<100;attempt++){const state=await backend.invoke('getState');const current=state.tasks.find(item=>item.id===task.taskId);if(current?.status==='completed')break;if(current?.status==='failed')assert.fail(current.message);if(attempt===99)assert.fail('Local review did not complete.');await new Promise(resolve=>setTimeout(resolve,25));}
 const reviews=await backend.invoke('getDocumentReviews',{documentId:fixture.documentId});assert.ok(reviews.items.length>=2);assert.equal(document.blocks.length,fixture.document.blocks.length);
 const config={name:'Synthetic Tauri credentials',baseUrl:'http://127.0.0.1:12345/v1',model:'synthetic-no-inference',responseFormat:'json_schema',tokenParameter:'max_completion_tokens',maxOutputTokens:4096,contextWindowTokens:16384,timeoutSeconds:30,apiKey:'synthetic-api-key-retained'};
 const saved=await backend.invoke('saveModelConfig',config);assert.equal(saved.hasApiKey,true);assert.equal(saved.keyStorage,'os-encrypted');assert.deepEqual(await readFile(join(dataDir,'credentials/model-key.bin')),legacyKey);assert.ok(!(await readFile(join(dataDir,'credentials/model-key.tauri.bin'))).includes(Buffer.from(config.apiKey)));
 await assert.rejects(backend.invoke('runWorkspaceCommand',{action:'reporting.render',payload:{}}),/导出/u);
 await assert.rejects(backend.invoke('configureLocalKnowledge',{folderPath:parent,preferences:{displayName:'Unauthorized',fileTypes:['txt'],excludeDirectories:[],autoSyncEnabled:false,syncIntervalMinutes:10,maxFileSizeMb:10},buildNow:false}),/授权/u);
 const documentsBeforeBackup=(await backend.invoke('getState')).documents.length;assert.equal(documentsBeforeBackup,4,'Tracked export adds one derived contract while retaining the original three.');
 const backupParent=join(parent,'backups');await mkdir(backupParent);openSelections.push(backupParent);const backup=await backend.invoke('runWorkspaceCommand',{action:'maintenance.backup',payload:{includeKnowledge:false}});assert.ok(backup.manifest.files.some(file=>file.path==='workspace.sqlite'));openSelections.push(backup.path);const inspected=await backend.invoke('runWorkspaceCommand',{action:'maintenance.inspectBackup'});assert.equal(inspected.documents,documentsBeforeBackup);const restored=await backend.invoke('runWorkspaceCommand',{action:'maintenance.restore',payload:{backupPath:backup.path,confirmed:true}});assert.ok(restored.recoveryPath);assert.equal((await backend.invoke('getState')).documents.length,documentsBeforeBackup);
 await backend.close();backend=await launch();const restarted=await backend.invoke('getState');assert.equal(restarted.modelConfig.model,config.model);assert.equal(restarted.credentialMigration.legacyCredentialFiles,0);
 // A key action lazily decrypts only the new namespace; no model request is sent.
 const {apiKey:_removed,...sameConfig}=config;const reloaded=await backend.invoke('saveModelConfig',sameConfig);assert.equal(reloaded.hasApiKey,true);assert.equal(reloaded.keyStorage,'os-encrypted');
 changes=await backend.invoke('getChanges',fixture.reviewId);assert.equal(changes.proposals[0].status,'accepted');assert.equal(changes.exports.length,1);assert.deepEqual(await backend.invoke('getReview',fixture.reviewId),fixture.review);assert.deepEqual(await readFile(join(dataDir,fixture.originalRelativePath)),originalContract);assert.deepEqual(await readFile(join(dataDir,'credentials/model-key.bin')),legacyKey);
 await backend.close();backend=undefined;
 console.log(JSON.stringify({ok:true,checks:['fresh-workspace-migrations','closed-schema7-native-handoff','legacy-review-retained','approved-tracked-export','original-format-and-revisions','local-review','paged-history','credential-encryption-and-restart','legacy-ciphertext-preserved','unauthorized-path-rejected','internal-export-command-rejected','backup-inspection-restore-and-worker-restart','clean-sidecar-shutdown'],hostCalls:hostCalls.filter(value=>!value.startsWith('credential'))},null,2));
}finally{await backend?.close();await rm(parent,{recursive:true,force:true});}
