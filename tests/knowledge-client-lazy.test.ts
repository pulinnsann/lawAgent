import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KnowledgeWorkerClient } from '../src/core/knowledge-client';

test('unused index client opens no worker and closing does not require an index entry',async()=>{
  const client=new KnowledgeWorkerClient(tmpdir(),new URL('file:///nonexistent-law-agent-index-entry.js'));
  await client.close();await client.close();
  await assert.rejects(client.getState(null),/正在关闭/u);
});

test('lazy index worker still responds concurrently and closes after work',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'law-lazy-index-'));
  try{
    const entry=join(directory,'worker.mjs');
    await writeFile(entry,"import {parentPort} from 'node:worker_threads';parentPort.on('message',m=>parentPort.postMessage({id:m.id,data:m.command==='close'?null:{folderPath:m.payload.folderPath}}));");
    const client=new KnowledgeWorkerClient(directory,pathToFileURL(entry));
    const result=await Promise.all([client.getState('甲'),client.getState('ไทย')]);
    assert.deepEqual(result.map(value=>(value as any).folderPath),['甲','ไทย']);
    await client.close();await assert.rejects(client.getState(null),/正在关闭/u);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('an index worker ignoring close cannot hold shutdown indefinitely',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'law-index-close-timeout-'));
 try{
  const entry=join(directory,'worker.mjs');await writeFile(entry,"import {parentPort} from 'node:worker_threads';parentPort.on('message',m=>{if(m.command!=='close')parentPort.postMessage({id:m.id,data:{folderPath:null}});});");
  const client=new KnowledgeWorkerClient(directory,pathToFileURL(entry),20);await client.getState(null);
  const started=performance.now();await client.close();assert.ok(performance.now()-started<700);await client.close();
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a worker exiting successfully still fails later requests instead of silently dropping them',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'law-index-exit-zero-'));
 try{
  const entry=join(directory,'worker.mjs');await writeFile(entry,"import {parentPort} from 'node:worker_threads';parentPort.on('message',m=>{parentPort.postMessage({id:m.id,data:{folderPath:null}});parentPort.close();});");
  const client=new KnowledgeWorkerClient(directory,pathToFileURL(entry),20);await client.getState(null);await new Promise(resolve=>setTimeout(resolve,50));
  await assert.rejects(client.getState(null),/已停止/u);await client.close();
 }finally{await rm(directory,{recursive:true,force:true});}
});
