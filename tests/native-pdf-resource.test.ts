import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDesktopRuntime } from '../src/desktop/runtime';
import type { DesktopHost, DesktopRuntime } from '../src/desktop/types';
import { normalizeNativePressure } from '../src/desktop/resource-pressure';

test('native pressure normalization preserves unknown capacity and rejects invalid native readings', () => {
  const now=Date.now();
  assert.deepEqual(normalizeNativePressure(false,now),{level:'unknown',source:'unavailable',observedAt:new Date(now).toISOString(),availableBytes:null,totalBytes:null});
  assert.equal(normalizeNativePressure({level:'normal',source:'macos',totalBytes:1024},now).availableBytes,null);
  assert.equal(normalizeNativePressure({level:'critical',source:'windows',totalBytes:1024,availableBytes:0},now).availableBytes,0);
  for(const input of [{level:'critical',source:'test'},{level:'bad',source:'macos'},{level:'critical',source:'windows',totalBytes:1,availableBytes:2},{level:'normal',source:'windows',availableBytes:-1}])assert.equal(normalizeNativePressure(input,now).level,'unknown');
});

async function fixture(run:(runtime:DesktopRuntime,folder:string,calls:string[])=>Promise<void>, failPdf=false, failAcquire=false) {
  const folder=await mkdtemp(join(tmpdir(),'law-pdf-resource-'));let runtime:DesktopRuntime|undefined;
  try{
    const script=join(folder,'worker.mjs');
    await writeFile(script,`import{parentPort}from'node:worker_threads';const port=parentPort;let acquire;const calls=[];port.on('message',m=>{const answer=data=>port.postMessage({type:'response',id:m.id,data});if(m.command==='runWorkspaceCommand'){const a=m.payload.action;if(a==='reporting.render')answer({html:'<html><body>Synthetic report</body></html>',snapshot:{}});else if(a==='workspace.testRelease'){if(acquire){port.postMessage({type:'response',id:acquire,data:null});acquire=null;}answer(calls);}else if(a==='workspace.testStats')answer(calls);else if(a==='workspace.testLease')answer({held:Boolean(acquire),calls});else answer(null);}else if(m.command==='acquireResource'){calls.push('acquire');acquire=m.id;if(${failAcquire})port.postMessage({type:'response',id:m.id,error:'Synthetic acquisition acknowledgement lost'});}else if(m.command==='releaseResource'){calls.push('release');acquire=null;answer(null);}else if(m.command==='close'){if(acquire){port.postMessage({type:'response',id:acquire,error:'Application closing'});acquire=null;}answer(null);}else answer(null);});port.postMessage({type:'ready'});`);
    const calls:string[]=[];
    const host:DesktopHost={emitTask:()=>{},call:async<T>(operation:string)=>{
      calls.push(operation);
      if(operation==='showSaveDialog')return{canceled:false,filePath:join(folder,'report.pdf')} as T;
      if(operation==='renderPdf'){if(failPdf)throw new Error('Synthetic PDF failure');return{base64:Buffer.from('%PDF-1.4\n%%EOF').toString('base64')} as T;}
      return false as T;
    }};
    runtime=await createDesktopRuntime(host,{dataDir:folder,coreEntry:pathToFileURL(script),shutdownTimeoutMs:100});
    await run(runtime,folder,calls);
  }finally{await runtime?.close();await rm(folder,{recursive:true,force:true});}
}
async function waitAcquired(runtime:DesktopRuntime){for(let n=0;n<200;n++){const result=await runtime.invoke({name:'runWorkspaceCommand',payload:{action:'workspace.testStats'}});if(result.ok&&(result.data as string[]).includes('acquire'))return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Private resource lease was not requested');}

test('native PDF does not render before Core admits its lease and releases after actual completion',async()=>fixture(async(runtime,folder,calls)=>{
  const pending=runtime.invoke({name:'runWorkspaceCommand',payload:{action:'reporting.export',payload:{format:'pdf'}}});
  await waitAcquired(runtime);assert.equal(calls.includes('renderPdf'),false);
  await runtime.invoke({name:'runWorkspaceCommand',payload:{action:'workspace.testRelease'}});
  const result=await pending;assert.equal(result.ok,true);assert.match(await readFile(join(folder,'report.pdf'),'utf8'),/^%PDF/u);
  const stats=await runtime.invoke({name:'runWorkspaceCommand',payload:{action:'workspace.testStats'}});assert.ok(stats.ok);if(stats.ok)assert.deepEqual(stats.data,['acquire','release']);
  const denied=await runtime.invoke({name:'acquireResource',payload:{id:randomUUID()}});assert.equal(denied.ok,false,'Renderer must not acquire private Core leases');
}));

test('a failed native PDF renderer still releases its lease without writing an export',async()=>fixture(async(runtime,folder,calls)=>{
  const pending=runtime.invoke({name:'runWorkspaceCommand',payload:{action:'reporting.export',payload:{format:'pdf'}}});await waitAcquired(runtime);
  await runtime.invoke({name:'runWorkspaceCommand',payload:{action:'workspace.testRelease'}});assert.equal((await pending).ok,false);
  const stats=await runtime.invoke({name:'runWorkspaceCommand',payload:{action:'workspace.testStats'}});if(stats.ok)assert.deepEqual(stats.data,['acquire','release']);
  await assert.rejects(readFile(join(folder,'report.pdf')),/ENOENT/);assert.equal(calls.includes('renderPdf'),true);
},true));

test('closing while native PDF waits for resources does not start the OS renderer',async()=>fixture(async(runtime,_folder,calls)=>{
  const pending=runtime.invoke({name:'runWorkspaceCommand',payload:{action:'reporting.export',payload:{format:'pdf'}}});await waitAcquired(runtime);
  await runtime.close();assert.equal((await pending).ok,false);assert.equal(calls.includes('renderPdf'),false);
}));


test('a failed resource-acquisition acknowledgement still cancels the retained Core request before any renderer or output',async()=>fixture(async(runtime,folder,calls)=>{
  const result=await runtime.invoke({name:'runWorkspaceCommand',payload:{action:'reporting.export',payload:{format:'pdf'}}});
  assert.equal(result.ok,false);if(!result.ok)assert.match(result.error,/acknowledgement lost/);
  assert.equal(calls.includes('renderPdf'),false);await assert.rejects(readFile(join(folder,'report.pdf')),/ENOENT/);
  const stats=await runtime.invoke({name:'runWorkspaceCommand',payload:{action:'workspace.testLease'}});assert.equal(stats.ok,true);
  if(stats.ok)assert.deepEqual(stats.data,{held:false,calls:['acquire','release']});
  await runtime.invoke({name:'runWorkspaceCommand',payload:{action:'workspace.testRelease'}});
  assert.equal(calls.includes('renderPdf'),false,'a late admission cannot reach a renderer after failed acquisition');
},false,true));
