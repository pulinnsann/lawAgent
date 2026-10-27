import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KnowledgeWorkerClient } from '../src/core/knowledge-client';

const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
async function events(directory: string): Promise<string[]> {
  return (await readFile(join(directory, 'events.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
}
async function waitForEvent(directory: string, event: string, count = 1): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await events(directory)).filter(value => value.startsWith(`${event}:`)).length < count) {
    if (Date.now() > deadline) throw new Error(`Synthetic worker did not reach ${event}: ${JSON.stringify(await events(directory))}`);
    await pause(5);
  }
}
async function waitForWorkerClose(directory: string, threadId: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await events(directory)).includes(`close-done:${threadId}`)) {
    if (Date.now() > deadline) throw new Error('Synthetic index worker did not finish closing.');
    await pause(5);
  }
}
async function gatedWorker(directory: string): Promise<URL> {
  const entry = join(directory, 'gated-worker.mjs');
  await writeFile(entry, `import { parentPort, workerData, threadId } from 'node:worker_threads';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const log = name => appendFileSync(join(workerData.dataDir, 'events.log'), name + ':' + threadId + '\\n');
const wait = async name => { while (!existsSync(join(workerData.dataDir, name))) await new Promise(resolve => setTimeout(resolve, 5)); };
const cancelled = new Set();
log('start');
parentPort.on('message', message => {
  if (message.command === 'cancel') { cancelled.add(message.id); return; }
  void (async () => {
    if (message.command === 'close') {
      log('close-start');
      if (existsSync(join(workerData.dataDir, 'hold-close'))) await wait('release-close');
      log('close-done'); parentPort.postMessage({ id: message.id, data: null }); parentPort.close(); return;
    }
    if (message.command === 'syncFolder' || message.command === 'search' || message.command === 'readChunk') {
      log(message.command + '-start');
      if (message.command === 'syncFolder') parentPort.postMessage({ type: 'progress', id: message.id, job: { status: 'running', phase: 'synthetic gated work' } });
      await wait('release-operation'); log(message.command + '-done');
      parentPort.postMessage(cancelled.has(message.id) ? { id: message.id, error: 'Synthetic cancellation completed after cleanup' } : { id: message.id, data: { status: 'completed', instanceId: threadId } }); return;
    }
    if (message.command === 'getState' && message.payload?.folderPath === 'hold-poll') { log('poll-start'); await wait('release-poll'); }
    parentPort.postMessage({ id: message.id, data: { folderPath: message.payload?.folderPath ?? null, instanceId: threadId } });
  })();
});`);
  return pathToFileURL(entry);
}

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

test('idle recycling waits for real old-worker cleanup before admitting queued requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-index-idle-queue-'));
  const client = new KnowledgeWorkerClient(directory, await gatedWorker(directory), 5_000, { idleTimeoutMs: 20 });
  try {
    await writeFile(join(directory, 'hold-close'), 'synthetic cleanup gate');
    const first = await client.getState(null) as any;
    await waitForEvent(directory, 'close-start');
    let settled = false;
    const queued = client.getState('next request').then(value => { settled = true; return value as any; });
    await pause(40);
    assert.equal(settled, false);
    assert.equal((await events(directory)).filter(value => value.startsWith('start:')).length, 1);
    await writeFile(join(directory, 'release-close'), 'release');
    const second = await queued;
    assert.notEqual(second.instanceId, first.instanceId);
    assert.equal(second.folderPath, 'next request');
    const recorded = await events(directory);
    assert.ok(recorded.indexOf(`close-done:${first.instanceId}`) < recorded.indexOf(`start:${second.instanceId}`));
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('active sync and original-source reads are never recycled for being slow', async () => {
  for (const command of ['syncFolder', 'readChunk'] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'law-index-idle-active-'));
    const client = new KnowledgeWorkerClient(directory, await gatedWorker(directory), 500, { idleTimeoutMs: 20 });
    try {
      const operation = command === 'syncFolder'
        ? client.syncFolder({ folderPath: directory, jobId: randomUUID(), mode: 'incremental' }, new AbortController().signal, () => {})
        : client.readChunk({ folderPath: directory, chunkId: 'synthetic-chunk' });
      await waitForEvent(directory, `${command}-start`);
      await client.getState(null);
      await pause(50);
      assert.ok(!(await events(directory)).some(value => value.startsWith('close-start:')));
      await writeFile(join(directory, 'release-operation'), 'release');
      await operation;
      await waitForEvent(directory, 'close-done');
    } finally { await writeFile(join(directory, 'release-operation'), 'release'); await client.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('cancelled search remains internally busy until the worker acknowledges actual cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-index-idle-search-drain-'));
  const client = new KnowledgeWorkerClient(directory, await gatedWorker(directory), 5_000, { idleTimeoutMs: 20 });
  try {
    const controller = new AbortController();
    const pending = client.search({ folderPath: directory, query: 'synthetic query' }, controller.signal);
    const rejected = assert.rejects(pending, /synthetic caller cancellation/u);
    await waitForEvent(directory, 'search-start');
    controller.abort(new Error('synthetic caller cancellation'));
    await rejected;
    let drained = false;
    const drain = client.waitForIdle().then(() => { drained = true; });
    // A second finished request must not hide the still-draining cancelled one.
    await client.getState(null);
    await pause(50);
    assert.equal(drained, false);
    assert.ok(!(await events(directory)).some(value => value.startsWith('close-start:')));
    await writeFile(join(directory, 'release-operation'), 'release');
    await waitForEvent(directory, 'search-done');
    await drain;
    await waitForEvent(directory, 'close-done');
    assert.ok(await client.getState(null));
  } finally { await writeFile(join(directory, 'release-operation'), 'release'); await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('drain snapshots wait for cancelled search cleanup but exclude later state polling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-index-drain-snapshot-'));
  const client = new KnowledgeWorkerClient(directory, await gatedWorker(directory), 500, { idleTimeoutMs: 20 });
  try {
    const controller = new AbortController();
    const pending = client.search({ folderPath: directory, query: 'synthetic query' }, controller.signal);
    const rejection = assert.rejects(pending, /cancel snapshot search/u);
    await waitForEvent(directory, 'search-start');
    controller.abort(new Error('cancel snapshot search'));
    await rejection;
    const drain = client.waitForIdle();
    let pollFinished = false;
    const laterPoll = client.getState('hold-poll').then(() => { pollFinished = true; });
    await waitForEvent(directory, 'poll-start');
    await writeFile(join(directory, 'release-operation'), 'release search');
    await drain;
    assert.equal(pollFinished, false);
    await writeFile(join(directory, 'release-poll'), 'release poll');
    await laterPoll;
  } finally {
    await writeFile(join(directory, 'release-operation'), 'release');
    await writeFile(join(directory, 'release-poll'), 'release');
    await client.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('forced permanent close releases a cancelled search drain only after thread termination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-index-drain-force-'));
  const entry = join(directory, 'worker.mjs');
  await writeFile(entry, `import{parentPort,workerData,threadId}from'node:worker_threads';import{appendFileSync}from'node:fs';import{join}from'node:path';parentPort.on('message',message=>{if(message.command==='search')appendFileSync(join(workerData.dataDir,'events.log'),'search-start:'+threadId+'\\n');});`);
  const client = new KnowledgeWorkerClient(directory, pathToFileURL(entry), 20, { idleTimeoutMs: 20 });
  try {
    const controller = new AbortController();
    const pending = client.search({ folderPath: directory, query: 'synthetic never-reply query' }, controller.signal);
    const rejection = assert.rejects(pending, /cancel forced drain/u);
    await waitForEvent(directory, 'search-start');
    controller.abort(new Error('cancel forced drain'));
    await rejection;
    let drained = false;
    const drain = client.waitForIdle().then(() => { drained = true; });
    await pause(40);
    assert.equal(drained, false);
    await Promise.all([client.close(), drain]);
    assert.equal(drained, true);
    await assert.rejects(client.getState(null), /正在关闭/u);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unexpected worker failure rejects callers and releases snapshot drains on actual exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-index-drain-failure-'));
  const entry = join(directory, 'worker.mjs');
  await writeFile(entry, "import{parentPort}from'node:worker_threads';parentPort.on('message',message=>{if(message.command==='search')throw new Error('Synthetic worker failure');});");
  const client = new KnowledgeWorkerClient(directory, pathToFileURL(entry), 20);
  try {
    const pending = client.search({ folderPath: directory, query: 'synthetic failing query' });
    const rejection = assert.rejects(pending, /已停止/u);
    const drain = client.waitForIdle();
    await Promise.all([rejection, drain]);
    await assert.rejects(client.getState(null), /已停止/u);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('permanent close rejects requests queued behind recycling and never starts a replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-index-idle-final-close-'));
  const client = new KnowledgeWorkerClient(directory, await gatedWorker(directory), 5_000, { idleTimeoutMs: 20 });
  try {
    await writeFile(join(directory, 'hold-close'), 'synthetic cleanup gate');
    await client.getState(null);
    await waitForEvent(directory, 'close-start');
    const queued = client.getState(null);
    const rejection = assert.rejects(queued, /正在关闭/u);
    const closed = client.close();
    assert.equal(client.close(), closed);
    await writeFile(join(directory, 'release-close'), 'release');
    await closed;
    await rejection;
    assert.equal((await events(directory)).filter(value => value.startsWith('start:')).length, 1);
    await assert.rejects(client.getState(null), /正在关闭/u);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an idle worker ignoring graceful close is terminated before its replacement is opened', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-index-idle-force-close-'));
  const entry = join(directory, 'worker.mjs');
  await writeFile(entry, `import {parentPort,workerData,threadId} from 'node:worker_threads';import{appendFileSync}from'node:fs';import{join}from'node:path';parentPort.on('message',m=>{if(m.command==='close'){appendFileSync(join(workerData.dataDir,'events.log'),'close-start:'+threadId+'\\n');return;}parentPort.postMessage({id:m.id,data:{folderPath:null,instanceId:threadId}});});`);
  const client = new KnowledgeWorkerClient(directory, pathToFileURL(entry), 20, { idleTimeoutMs: 20 });
  try {
    const first = await client.getState(null) as any;
    await waitForEvent(directory, 'close-start');
    const started = performance.now();
    const second = await client.getState(null) as any;
    assert.notEqual(second.instanceId, first.instanceId);
    assert.ok(performance.now() - started < 1_000);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an aborted request waiting for recycling does not open a replacement worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-index-idle-abort-queue-'));
  const client = new KnowledgeWorkerClient(directory, await gatedWorker(directory), 5_000, { idleTimeoutMs: 20 });
  try {
    await writeFile(join(directory, 'hold-close'), 'synthetic cleanup gate');
    await client.getState(null);
    await waitForEvent(directory, 'close-start');
    const controller = new AbortController();
    const pending = client.search({ folderPath: directory, query: 'synthetic query' }, controller.signal);
    const rejection = assert.rejects(pending, /cancel queued request/u);
    controller.abort(new Error('cancel queued request'));
    await rejection;
    assert.equal((await events(directory)).filter(value => value.startsWith('start:')).length, 1);
    await writeFile(join(directory, 'release-close'), 'release');
    await client.close();
    assert.equal((await events(directory)).filter(value => value.startsWith('start:')).length, 1);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('recycled real indexing workers reopen committed FTS data and retain exact original citations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-index-idle-persisted-'));
  const sources = join(directory, 'sources');
  await mkdir(sources);
  const original = '合成制度专属标记：验收完成后付款，原文引文须保持一致。';
  await writeFile(join(sources, 'policy.txt'), original);
  const entry = join(directory, 'real-worker.mjs');
  await writeFile(entry, `import {parentPort,workerData,threadId} from 'node:worker_threads';
import {appendFileSync} from 'node:fs';import {join} from 'node:path';
import {register} from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
const log=name=>appendFileSync(join(workerData.dataDir,'events.log'),name+':'+threadId+'\\n');log('start');
let closeId;parentPort.on('message',message=>{if(message.command==='close')closeId=message.id;});
const send=parentPort.postMessage.bind(parentPort);parentPort.postMessage=(message,...transfer)=>{if(message.id===closeId)log('close-done');if(message.data&&typeof message.data==='object')message.data.syntheticThreadId=threadId;return send(message,...transfer);};
register();await import(${JSON.stringify(new URL('../src/main/knowledge-worker.ts', import.meta.url).href)});`);
  const client = new KnowledgeWorkerClient(directory, pathToFileURL(entry), 2_000, { idleTimeoutMs: 30 });
  try {
    const job = await client.syncFolder({ folderPath: sources, jobId: randomUUID(), mode: 'incremental' }, new AbortController().signal, () => {});
    assert.equal(job.status, 'completed');
    assert.equal(job.indexed, 1);
    const first = await client.search({ folderPath: sources, query: '合成制度专属标记' });
    assert.equal(first.hits.length, 1);
    const quote = first.hits[0]!;
    assert.equal(quote.excerpt, original);
    await waitForWorkerClose(directory, (first as any).syntheticThreadId);
    const state = await client.getState(sources);
    assert.equal(state.indexedFiles, 1);
    assert.equal(state.job?.id, job.id);
    assert.notEqual((state as any).syntheticThreadId, (first as any).syntheticThreadId);
    const restored = await client.readChunk({ folderPath: sources, chunkId: quote.chunkId });
    assert.deepEqual(restored, { ...quote, score: restored.score, syntheticThreadId: (restored as any).syntheticThreadId });
    const increment = await client.syncFolder({ folderPath: sources, jobId: randomUUID(), mode: 'incremental' }, new AbortController().signal, () => {});
    assert.equal(increment.unchanged, 1);
    assert.equal(increment.indexed, 0);
    assert.equal(await readFile(join(sources, 'policy.txt'), 'utf8'), original);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});
