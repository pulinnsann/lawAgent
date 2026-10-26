import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { WorkspaceAssets } from '../src/core/workspace-assets';
import { defaultRetrievalConfig } from '../src/shared/contracts';
import { defaultKnowledgePreferences } from '../src/shared/knowledge-preferences';
import type { KnowledgePort } from '../src/shared/knowledge';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
async function within<T>(operation:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic shutdown did not settle.')),3000);})]);}finally{if(timer)clearTimeout(timer);}}
const idleKnowledge=():KnowledgePort=>({getState:async folderPath=>({folderPath,engine:'sqlite-fts5',tokenizerVersion:'synthetic',indexedFiles:0,chunks:0,staleFiles:0,lastSyncedAt:null,job:null,limitations:[]}),syncFolder:async()=>{throw new Error('No index work in this fixture.');},search:async()=>{throw new Error('No index retrieval in this fixture.');},readChunk:async()=>{throw new Error('No chunks.');},close:async()=>{}});
async function heldServer(){
 const arrived=deferred<void>();const disconnected=deferred<void>();
 const server=createServer((request,response)=>{request.resume();response.once('close',()=>disconnected.resolve());arrived.resolve();});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});const address=server.address();assert.ok(address&&typeof address!=='string');
 return{url:`http://127.0.0.1:${address.port}`,arrived:arrived.promise,disconnected:disconnected.promise,close:async()=>{const stopped=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeAllConnections();await stopped;}};
}

test('service shutdown aborts a held model connection test and persists its cancelled ledger before releasing storage',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'law-close-model-test-'));const remote=await heldServer();let store:AppStore|undefined;let service:ContractService|undefined;
 try{
  store=await AppStore.open(directory);service=new ContractService(store,directory,()=>{},idleKnowledge());
  await service.saveConfig({name:'Synthetic held connection',baseUrl:remote.url,model:'synthetic',responseFormat:'json_schema',tokenParameter:'max_tokens',maxOutputTokens:4096,contextWindowTokens:16384,timeoutSeconds:600});
  const running=service.testConnection(null);const cancelled=assert.rejects(running,error=>(error as any)?.code==='CANCELLED'||(error as any)?.name==='AbortError');await within(remote.arrived);
  await within(Promise.all([service.close(),service.close()]));await within(cancelled);await within(remote.disconnected);service=undefined;store=undefined;
  store=await AppStore.open(directory);const assets=new WorkspaceAssets(store);const runs=assets.list('model_runtime_run');assert.equal(runs.length,1);assert.equal(runs[0].body.status,'cancelled');assert.equal(runs[0].body.calls[0].status,'cancelled');assert.ok(runs[0].body.finishedAt);
 }finally{await remote.close();await service?.close();await store?.close();await rm(directory,{recursive:true,force:true});}
});

test('service shutdown aborts held retrieval-API tests before closing the workspace',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'law-close-retrieval-test-'));const remote=await heldServer();let store:AppStore|undefined;let service:ContractService|undefined;
 try{
  store=await AppStore.open(directory);service=new ContractService(store,directory,()=>{},idleKnowledge());const config=defaultRetrievalConfig();config.knowledge.enabled=true;config.knowledge.api={...config.knowledge.api,enabled:true,provider:'standard',baseUrl:remote.url,collectionId:'synthetic'};config.timeoutSeconds=60;
  await service.saveRetrievalConfig(config);const running=service.testRetrieval();await within(remote.arrived);await within(service.close());const result=await within(running);await within(remote.disconnected);assert.equal(result.knowledgeStatus,'cancelled');assert.equal(result.attempts[0].status,'cancelled');
  await assert.rejects(service.testRetrieval(),/正在关闭/u);service=undefined;store=undefined;store=await AppStore.open(directory);assert.equal(store.getRetrievalConfig()?.knowledge.api.collectionId,'synthetic');
 }finally{await remote.close();await service?.close();await store?.close();await rm(directory,{recursive:true,force:true});}
});

test('an index close error still releases the business database and writer lease exactly once',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'law-close-index-error-'));let store:AppStore|undefined;let service:ContractService|undefined;let closes=0;
 try{
  store=await AppStore.open(directory);const index=idleKnowledge();index.close=async()=>{closes++;throw new Error('Synthetic index close failure.');};service=new ContractService(store,directory,()=>{},index);
  await assert.rejects(service.close(),/Synthetic index close/u);await assert.rejects(service.close(),/Synthetic index close/u);assert.equal(closes,1);service=undefined;store=undefined;
  store=await AppStore.open(directory);assert.ok(store.workspaceId);
 }finally{await store?.close();await rm(directory,{recursive:true,force:true});}
});

test('index close begins before waiting for an active sync that needs worker cleanup to settle',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'law-close-index-active-'));let store:AppStore|undefined;let service:ContractService|undefined;const arrived=deferred<void>();const released=deferred<void>();let closes=0;
 try{
  store=await AppStore.open(directory);const knowledge=idleKnowledge();knowledge.syncFolder=async(input,signal)=>{arrived.resolve();await released.promise;return{id:input.jobId,folderPath:input.folderPath,status:signal.aborted?'cancelled':'completed',phase:'Synthetic released worker',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),scanned:0,indexed:0,unchanged:0,deleted:0,skipped:0,failed:0,fullScan:false,errors:[]};};knowledge.close=async()=>{closes++;released.resolve();};service=new ContractService(store,directory,()=>{},knowledge);
  const config=defaultRetrievalConfig();config.knowledge.enabled=true;config.knowledge.folderPath=directory;config.knowledge.preferences={...defaultKnowledgePreferences(),autoSyncEnabled:false};await service.saveRetrievalConfig(config);await service.startKnowledgeSync();await within(arrived.promise);await within(service.close());assert.equal(closes,1);service=undefined;store=undefined;store=await AppStore.open(directory);assert.ok(store.workspaceId);
 }finally{released.resolve();await service?.close();await store?.close();await rm(directory,{recursive:true,force:true});}
});

test('a gated extension cleanup cannot delay cancelling another active model review or release storage early',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'law-close-parallel-'));const priorFetch=globalThis.fetch;let store:AppStore|undefined;let service:ContractService|undefined;
 const probeArrived=deferred<void>();const reviewArrived=deferred<void>();const reviewAborted=deferred<void>();const releaseProbe=deferred<void>();const terminal=deferred<import('../src/shared/contracts').ReviewTask>();let probeSignal:AbortSignal|undefined;
 try{
  store=await AppStore.open(directory);service=new ContractService(store,directory,task=>{if(['completed','cancelled','failed'].includes(task.status))terminal.resolve(task);},idleKnowledge());const document=await service.loadSample();await service.saveConfig({name:'Synthetic parallel close',baseUrl:'https://model.example.invalid/v1',model:'synthetic',responseFormat:'json_schema',tokenParameter:'max_tokens',maxOutputTokens:4096,contextWindowTokens:16384,timeoutSeconds:600});
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));const probe=body.response_format?.json_schema?.name==='model_capability_probe';const signal=init?.signal!;
   return new Promise<Response>((_resolve,reject)=>{
    if(probe){probeSignal=signal;probeArrived.resolve();signal.addEventListener('abort',()=>{void releaseProbe.promise.then(()=>reject(new DOMException('Synthetic extension cleanup complete.','AbortError')));},{once:true});}
    else{reviewArrived.resolve();signal.addEventListener('abort',()=>{reviewAborted.resolve();reject(new DOMException('Synthetic review cancelled.','AbortError'));},{once:true});}
   });};
  const probing=service.runWorkspaceCommand({action:'modelRuntime.probe',payload:{confirmed:true,capability:'jsonSchema'}});const probeCancelled=assert.rejects(probing,error=>(error as any)?.code==='CANCELLED'||(error as any)?.name==='AbortError');await within(probeArrived.promise);
  await service.startReview({documentId:document.id,mode:'model',context:{contractType:'service',ourPartyRole:'service_recipient',businessContext:'Synthetic shutdown concurrency fixture',strictness:'balanced'}},null);await within(reviewArrived.promise);
  let closed=false;const closing=service.close().then(()=>{closed=true;});await within(reviewAborted.promise);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(probeSignal?.aborted,true);assert.equal(closed,false,'Storage must remain open until the extension cleanup and its cancelled ledger have finished.');
  releaseProbe.resolve();await within(Promise.all([closing,probeCancelled]));assert.equal((await within(terminal.promise)).status,'cancelled');service=undefined;store=undefined;
  store=await AppStore.open(directory);const runs=new WorkspaceAssets(store).list('model_runtime_run');assert.equal(runs.length,2);assert.ok(runs.every(run=>run.body.status==='cancelled'));
 }finally{releaseProbe.resolve();globalThis.fetch=priorFetch;await service?.close();await store?.close();await rm(directory,{recursive:true,force:true});}
});
