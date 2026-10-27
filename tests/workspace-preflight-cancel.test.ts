import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDesktopRuntime } from '../src/desktop/runtime';
import type { DesktopHost, DesktopResult, DesktopRuntime } from '../src/desktop/types';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function within<T>(operation: Promise<T>, milliseconds = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation was blocked behind a controlled preflight operation')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function untilFile(path: string) { for (let n = 0; n < 400; n++) { if (await stat(path).catch(() => null)) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Synthetic desktop operation did not reach its controlled barrier'); }
function data<T>(result: DesktopResult): T { if (!result.ok) assert.fail(result.error); return result.data as T; }
function assertCancelled(result: DesktopResult) { assert.equal(result.ok, false); if (!result.ok) assert.match(result.error, /取消|CANCELLED/u); }
interface Stats { forwarded: Array<{ action: string; requestId: string }>; stateReads: number; cancelled: string[]; heldConnection: boolean; heldState: boolean }
type Mode = 'connection' | 'state' | 'vault' | 'core' | 'picker' | 'late-conversion' | 'pass';
const modelActions = ['translations.generate', 'modelRuntime.probe', 'alignment.compare', 'reporting.translation.generate'] as const;
const syntheticState = { modelConfig: { provider: 'chat-completions', baseUrl: 'http://127.0.0.1:12345/v1' }, retrievalConfig: null, tasks: [], documents: [] };

/** Real desktop runtime and worker messaging, with deterministic test barriers.
 * No model endpoint, native keychain, customer workspace or PDF engine is used. */
async function fixture(mode: Mode, run: (runtime: DesktopRuntime, directory: string, releaseHost: () => void) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'law-workspace-preflight-')); let runtime: DesktopRuntime | undefined; const hostGate = deferred<void>();
  try {
    const entry = join(directory, 'synthetic-core.mjs');
    await writeFile(entry, `import {parentPort,workerData} from 'node:worker_threads';
import {writeFileSync} from 'node:fs';import {join} from 'node:path';
const port=parentPort,state=${JSON.stringify(syntheticState)},mode=${JSON.stringify(mode)};
let forwarded=[],stateReads=0,cancelled=[],heldConnection=null,heldState=null,heldCore=null;
const reply=(message,data)=>port.postMessage({type:'response',id:message.id,data});
const completeCore=()=>{if(heldCore){const message=heldCore;heldCore=null;reply(message,message.payload.action==='conversion.convert'?{docxBase64:Buffer.from('synthetic conversion').toString('base64'),filename:'Synthetic.docx'}:{synthetic:true,requestId:message.payload.requestId});}};
port.on('message',message=>{
 if(message.command==='close'){if(heldState){const late=heldState;heldState=null;setTimeout(()=>reply(late,state),20);}reply(message,null);return;}
 if(message.command==='getState'){stateReads++;if(mode==='state'&&stateReads===1){heldState=message;writeFileSync(join(workerData.dataDir,'state-held'),'synthetic');return;}reply(message,state);return;}
 if(message.command==='testModelConnection'){heldConnection=message;writeFileSync(join(workerData.dataDir,'connection-held'),'synthetic');return;}
 if(message.command==='runWorkspaceCommand'){
  const input=message.payload;
  if(input.action==='workspace.cancel'){cancelled.push(input.payload.requestId);if(mode==='core'&&heldCore?.payload.requestId===input.payload.requestId){port.postMessage({type:'response',id:heldCore.id,error:'CANCELLED'});heldCore=null;}reply(message,{cancelled:true});return;}
  if(input.action==='workspace.progress'){
   if(input.payload?.release==='connection'&&heldConnection){reply(heldConnection,{synthetic:true});heldConnection=null;}
   if(input.payload?.release==='state'&&heldState){reply(heldState,state);heldState=null;}
   if(input.payload?.release==='core')completeCore();
   reply(message,{forwarded,stateReads,cancelled,heldConnection:Boolean(heldConnection),heldState:Boolean(heldState)});return;
  }
  forwarded.push({action:input.action,requestId:input.requestId});
  writeFileSync(join(workerData.dataDir,'forwarded'),'synthetic');
  if(mode==='core'||mode==='late-conversion'){heldCore=message;writeFileSync(join(workerData.dataDir,'core-held'),'synthetic');return;}
  reply(message,{synthetic:true,requestId:input.requestId});return;
 }
 reply(message,null);
});port.postMessage({type:'ready'});`);
    if (mode === 'vault') { await mkdir(join(directory, 'credentials')); await writeFile(join(directory, 'credentials/model-key.tauri.bin'), 'synthetic encrypted fixture'); }
    const host: DesktopHost = {
      emitTask: () => {},
      call: async <T>(operation: string) => {
        if (mode === 'vault' && operation === 'credentialAvailable') return true as T;
        if (mode === 'vault' && operation === 'credentialDecrypt') {
          await writeFile(join(directory, 'vault-held'), 'synthetic'); await hostGate.promise;
          return { result: JSON.stringify({ version: 1, endpoint: 'http://127.0.0.1:12345/v1/chat/completions', apiKey: 'synthetic-only' }) } as T;
        }
        if (operation === 'showSaveDialog') {
          if (mode === 'picker') { await writeFile(join(directory, 'picker-held'), 'synthetic'); await hostGate.promise; }
          return { canceled: false, filePath: join(directory, 'conversion.docx') } as T;
        }
        return false as T;
      },
    };
    runtime = await createDesktopRuntime(host, { dataDir: directory, coreEntry: pathToFileURL(entry), shutdownTimeoutMs: 100 });
    await run(runtime, directory, () => hostGate.resolve());
  } finally { hostGate.resolve(); await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
}
function start(runtime: DesktopRuntime, action: string = 'reporting.translation.generate', requestId = randomUUID()) {
  return { requestId, pending: runtime.invoke({ name: 'runWorkspaceCommand', payload: { action, requestId, payload: { id: randomUUID(), documentId: randomUUID(), confirmed: true } } }) };
}
function cancel(runtime: DesktopRuntime, requestId: string) { return runtime.invoke({ name: 'runWorkspaceCommand', payload: { action: 'workspace.cancel', payload: { requestId } } }); }
async function stats(runtime: DesktopRuntime, release?: 'connection' | 'state' | 'core') { return data<Stats>(await runtime.invoke({ name: 'runWorkspaceCommand', payload: { action: 'workspace.progress', payload: { release } } })); }

test('queued report translation is cancelled while a sensitive connection operation remains held', async () => fixture('connection', async (runtime, directory) => {
  const connection = runtime.invoke({ name: 'testModelConnection' }); await untilFile(join(directory, 'connection-held')); const before = await stats(runtime);
  const task = start(runtime); assert.equal(data<{ cancelled: boolean }>(await within(cancel(runtime, task.requestId))).cancelled, true);
  const blocked = await stats(runtime); assert.equal(blocked.heldConnection, true); assert.equal(blocked.forwarded.length, 0); assert.ok(blocked.cancelled.includes(task.requestId));
  await stats(runtime, 'connection'); data(await within(connection)); assertCancelled(await within(task.pending));
  const after = await stats(runtime); assert.equal(after.stateReads, before.stateReads); assert.equal(after.forwarded.length, 0);
  const next = start(runtime); data(await within(next.pending)); assert.equal((await stats(runtime)).forwarded.length, 1, 'cancelled request registration must not block later user work');
}));

for (const action of modelActions) test(`${action}: cancelling getState preflight prevents a late response from dispatching a model call`, async () => fixture('state', async (runtime, directory) => {
  const task = start(runtime, action); await untilFile(join(directory, 'state-held')); data(await within(cancel(runtime, task.requestId)));
  const blocked = await stats(runtime); assert.equal(blocked.heldState, true); assert.equal(blocked.forwarded.length, 0); assert.ok(blocked.cancelled.includes(task.requestId));
  await stats(runtime, 'state'); assertCancelled(await within(task.pending)); assert.equal((await stats(runtime)).forwarded.length, 0);
}));

test('report translation cancelled during OS credential unlock cannot forward a late decrypted key to Core', async () => fixture('vault', async (runtime, directory, releaseHost) => {
  const task = start(runtime); await untilFile(join(directory, 'vault-held')); data(await within(cancel(runtime, task.requestId))); assert.equal((await stats(runtime)).forwarded.length, 0);
  releaseHost(); assertCancelled(await within(task.pending)); assert.equal((await stats(runtime)).forwarded.length, 0);
}));

test('workspace cancellation still reaches Core after a model operation has been dispatched', async () => fixture('core', async (runtime, directory) => {
  const task = start(runtime); await untilFile(join(directory, 'core-held')); data(await within(cancel(runtime, task.requestId))); assertCancelled(await within(task.pending));
  const state = await stats(runtime); assert.equal(state.forwarded[0].requestId, task.requestId); assert.ok(state.cancelled.includes(task.requestId));
}));

test('PDF conversion cancelled in the native save picker cannot start OCR when the picker later returns', async () => fixture('picker', async (runtime, directory, releaseHost) => {
  const task = start(runtime, 'conversion.convert'); await untilFile(join(directory, 'picker-held')); data(await within(cancel(runtime, task.requestId)));
  releaseHost(); assertCancelled(await within(task.pending)); assert.equal((await stats(runtime)).forwarded.length, 0); assert.equal(await stat(join(directory, 'conversion.docx')).catch(() => null), null);
}));

test('a cancelled conversion cannot publish a file from a late Core result', async () => fixture('late-conversion', async (runtime, directory) => {
  const task = start(runtime, 'conversion.convert'); await untilFile(join(directory, 'core-held')); data(await within(cancel(runtime, task.requestId)));
  await stats(runtime, 'core'); assertCancelled(await within(task.pending)); assert.equal(await stat(join(directory, 'conversion.docx')).catch(() => null), null);
}));

test('desktop shutdown marks preflight workspace tasks cancelled before their late configuration response', async () => fixture('state', async (runtime, directory) => {
  const task = start(runtime); await untilFile(join(directory, 'state-held'));
  const closing = runtime.close(); await within(closing); assertCancelled(await task.pending); assert.equal(await stat(join(directory, 'forwarded')).catch(() => null), null);
}));

test('workspace tasks without caller IDs receive stable UUIDs', async () => fixture('pass', async runtime => {
  const result = data<{ requestId: string }>(await runtime.invoke({ name: 'runWorkspaceCommand', payload: { action: 'translations.generate', payload: { confirmed: true } } }));
  assert.match(result.requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
}));

test('a duplicate caller request ID cannot replace the original preflight cancellation registration', async () => fixture('state', async (runtime, directory) => {
  const original = start(runtime); await untilFile(join(directory, 'state-held'));
  const duplicate = await within(start(runtime, 'modelRuntime.probe', original.requestId).pending);
  assert.equal(duplicate.ok, false); if (!duplicate.ok) assert.match(duplicate.error, /重复/);
  data(await within(cancel(runtime, original.requestId))); await stats(runtime, 'state'); assertCancelled(await within(original.pending)); assert.equal((await stats(runtime)).forwarded.length, 0);
}));
