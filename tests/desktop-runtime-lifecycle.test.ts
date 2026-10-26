import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDesktopRuntime } from '../src/desktop/runtime';
import type { DesktopRuntime } from '../src/desktop/types';

async function untilFile(path:string):Promise<void>{for(let n=0;n<200;n++){if(await stat(path).catch(()=>null))return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Synthetic worker request was not received.');}
async function fixture(run:(runtime:DesktopRuntime,directory:string,phases:string[])=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'law-desktop-close-'));let runtime:DesktopRuntime|undefined;
 try{
  const entry=join(directory,'core.mjs');
  await writeFile(entry,`import {parentPort,workerData} from 'node:worker_threads';import {writeFileSync} from 'node:fs';import {join} from 'node:path';
const port=parentPort;const state={modelConfig:{provider:'chat-completions',baseUrl:'http://127.0.0.1:12345/v1'},retrievalConfig:null,tasks:[],documents:[]};
port.on('message',m=>{if(m.command==='getState')port.postMessage({type:'response',id:m.id,data:state});else if(m.command==='close')port.postMessage({type:'response',id:m.id,data:null});else{writeFileSync(join(workerData.dataDir,'waiting-'+m.command),'synthetic');setTimeout(()=>port.postMessage({type:'response',id:m.id,data:{ok:true}}),1000);}});port.postMessage({type:'ready'});`);
  const phases:string[]=[];
  runtime=await createDesktopRuntime({call:async<T>(operation:string)=>(operation==='showOpenDialog'?{canceled:false,filePaths:[directory]}:false) as T,emitTask:()=>{},emitShutdownProgress:phase=>{phases.push(phase);}},{dataDir:directory,coreEntry:pathToFileURL(entry),shutdownTimeoutMs:50});
  await run(runtime,directory,phases);
 }finally{await runtime?.close();await rm(directory,{recursive:true,force:true});}
}

test('ordinary shutdown bounds a non-cooperative Core request and clears its queue/timer',async()=>fixture(async(runtime,directory,phases)=>{
 const pending=runtime.invoke({name:'testModelConnection'});await untilFile(join(directory,'waiting-testModelConnection'));
 const started=performance.now();await runtime.close();assert.ok(performance.now()-started<700,'Shutdown waited for the synthetic one-second connection request.');
 assert.deepEqual(phases,['draining']);assert.equal((await pending).ok,false);await runtime.close();
}));

test('read-only maintenance status cannot disable the ordinary shutdown deadline',async()=>fixture(async(runtime,directory,phases)=>{
 const pending=runtime.invoke({name:'runWorkspaceCommand',payload:{action:'maintenance.status'}});await untilFile(join(directory,'waiting-runWorkspaceCommand'));
 assert.equal(runtime.isMaintenanceBusy?.(),false);
 const started=performance.now();await runtime.close();assert.ok(performance.now()-started<700);
 assert.deepEqual(phases,['draining']);assert.equal((await pending).ok,false);
}));

test('maintenance preflight reads remain cancellable before any critical file publication begins',async()=>fixture(async(runtime,directory,phases)=>{
 const pending=runtime.invoke({name:'runWorkspaceCommand',payload:{action:'maintenance.backup',payload:{includeKnowledge:false}}});await untilFile(join(directory,'waiting-getKnowledgeState'));
 assert.equal(runtime.isMaintenanceBusy?.(),false);
 const started=performance.now();await runtime.close();assert.ok(performance.now()-started<700);
 assert.deepEqual(phases,['draining']);assert.equal((await pending).ok,false);
}));
