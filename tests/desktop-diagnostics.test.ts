import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { createDesktopRuntime } from '../src/desktop/runtime';
import type { DesktopHost, DesktopResult } from '../src/desktop/types';

const PRIVATE = 'synthetic-private-contract-content-and-key';
function value<T>(result: DesktopResult): T { if (!result.ok) assert.fail(result.error); return result.data as T; }
async function until(predicate: () => Promise<boolean>) {
  for (let index = 0; index < 200; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected synthetic worker event.');
}
async function fixture(t: TestContext, options: { denyLicense?: boolean; cancelled?: boolean; holdMaintenance?: boolean; disabledLog?: boolean; delayNativeRead?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'law-desktop-diagnostics-')));
  const entry = join(directory, 'synthetic-core.mjs'), exported = join(directory, 'support.log');
  const hostCalls: string[] = [];
  let nativeEntered = false, releaseNative!: () => void;
  const nativeWait = new Promise<void>(resolve => { releaseNative = resolve; });
  await writeFile(entry, `import {parentPort} from 'node:worker_threads';
import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(directory)};const calls=root+'/worker-calls';const task=${JSON.stringify(randomUUID())};
const state={documents:[],tasks:[],modelConfig:null,retrievalConfig:null};
parentPort.on('message',m=>{
 appendFileSync(calls,m.command+'\\n');const reply=data=>parentPort.postMessage({type:'response',id:m.id,data});
 if(m.command==='assertLicenseWritable'){${options.denyLicense ? "parentPort.postMessage({type:'response',id:m.id,error:'LICENSE_EXPIRED'});return;" : 'reply(null);return;'}}
 if(m.command==='getState'){
  ${options.holdMaintenance ? "writeFileSync(root+'/held','ready');const timer=setInterval(()=>{if(existsSync(root+'/release')){clearInterval(timer);reply(state);}},5);return;" : 'reply(state);return;'}
 }
 if(m.command==='getKnowledgeState'){reply({job:null});return;}
 if(m.command==='getDocument'){process.exit(37);return;}
 if(m.command==='loadSample'){
  for(let n=0;n<30;n++)parentPort.postMessage({type:'task',task:{id:task,status:'running',stage:'model_request',mode:'local',message:${JSON.stringify(PRIVATE)}}});
  parentPort.postMessage({type:'task',task:{id:task,status:'completed',stage:'completed',mode:'local',message:${JSON.stringify(PRIVATE)}}});reply(null);return;
 }
 if(m.command==='getReview'){parentPort.postMessage({type:'response',id:m.id,error:${JSON.stringify(PRIVATE)}});return;}
 if(m.command==='runWorkspaceCommand'&&m.payload.action==='workspace.licenseActivate'){reply({accepted:false});return;}
 reply(null);
});parentPort.postMessage({type:'ready'});`);
  if (options.disabledLog) await writeFile(join(directory, 'diagnostics'), 'synthetic unavailable diagnostics');
  const host: DesktopHost = { emitTask: () => {}, call: async <T>(operation: string, payload: unknown) => {
    hostCalls.push(operation);
    if (operation === 'showSaveDialog') {
      assert.match((payload as { defaultPath: string }).defaultPath, /^lawagent-problem-log-[0-9TZ-]+\.log$/u);
      return (options.cancelled ? { canceled: true } : { canceled: false, filePath: exported }) as T;
    }
    if (operation === 'readNativeDiagnostics') {
      nativeEntered = true; if (options.delayNativeRead) await nativeWait;
      return { text: '# Native journal\n{"event":"native_ready"}\n' } as T;
    }
    throw new Error('Synthetic unsupported host operation.');
  } };
  const runtime = await createDesktopRuntime(host, { dataDir: directory, coreEntry: pathToFileURL(entry), enforceLicensing: Boolean(options.denyLicense), pressurePollMs: 0, shutdownTimeoutMs: 300 });
  t.after(async () => { releaseNative(); await writeFile(join(directory, 'release'), 'release'); await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const command = (action: string, payload: unknown = {}) => runtime.invoke({ name: 'runWorkspaceCommand', payload: { action, payload } });
  return { directory, runtime, exported, hostCalls, command, nativeEntered: () => nativeEntered, releaseNative };
}

test('diagnostics export bypasses expired licensing and adds only bounded native records to a new private file', async t => {
  const f = await fixture(t, { denyLicense: true });
  const status = value<{ available: boolean; coreReady: boolean }>(await f.command('maintenance.diagnosticsStatus'));
  assert.equal(status.available, true); assert.equal(status.coreReady, true);
  const result = value<{ path: string; fileName: string; bytes: number }>(await f.command('maintenance.exportDiagnostics'));
  assert.equal(result.path, f.exported); assert.equal(result.fileName, 'support.log'); assert.ok(result.bytes > 0);
  const text = await readFile(f.exported, 'utf8');
  assert.match(text, /desktop\.starting/u); assert.match(text, /core\.ready/u); assert.match(text, /native_ready/u);
  assert.doesNotMatch(await readFile(join(f.directory, 'worker-calls'), 'utf8').catch(() => ''), /assertLicenseWritable|maintenance\.exportDiagnostics/u);
  if (process.platform !== 'win32') assert.equal((await lstat(f.exported)).mode & 0o777, 0o600);
  assert.deepEqual(f.hostCalls, ['showSaveDialog', 'readNativeDiagnostics']);
});

test('cancelled export writes no selected file and does not request native logs or credentials', async t => {
  const f = await fixture(t, { cancelled: true, denyLicense: true });
  assert.equal(value(await f.command('maintenance.exportDiagnostics')), null);
  await assert.rejects(access(f.exported)); assert.deepEqual(f.hostCalls, ['showSaveDialog']);
});

test('export never overwrites an existing file and rejects renderer-controlled paths or extra payload fields', async t => {
  const f = await fixture(t);
  await writeFile(f.exported, 'keep original');
  const result = await f.command('maintenance.exportDiagnostics');
  assert.equal(result.ok, false); assert.equal(await readFile(f.exported, 'utf8'), 'keep original');
  const calls = f.hostCalls.length;
  assert.equal((await f.command('maintenance.exportDiagnostics', { path: join(f.directory, 'unexpected.log') })).ok, false);
  assert.equal(f.hostCalls.length, calls);
});

test('a faulted Core still permits status and log export without another Core request', async t => {
  const f = await fixture(t);
  assert.equal((await f.runtime.invoke({ name: 'getDocument', payload: randomUUID() })).ok, false);
  assert.equal(value<{ coreReady: boolean }>(await f.command('maintenance.diagnosticsStatus')).coreReady, false);
  assert.ok(value(await f.command('maintenance.exportDiagnostics')));
  const text = await readFile(f.exported, 'utf8');
  assert.match(text, /core\.exit/u); assert.match(text, /"exitCode":37/u);
});

test('export remains available during maintenance while ordinary commands remain blocked', async t => {
  const f = await fixture(t, { holdMaintenance: true });
  const maintaining = f.command('maintenance.clearKnowledge', { confirmed: true });
  await until(async () => access(join(f.directory, 'held')).then(() => true, () => false));
  const ordinary = await f.runtime.invoke({ name: 'getState' });
  assert.equal(ordinary.ok, false); if (!ordinary.ok) assert.match(ordinary.error, /维护数据/u);
  assert.equal(value<{ coreReady: boolean }>(await f.command('maintenance.diagnosticsStatus')).coreReady, true);
  assert.ok(value(await f.command('maintenance.exportDiagnostics')));
  await writeFile(join(f.directory, 'release'), 'release'); await maintaining;
});

test('metadata logging excludes contract text, keys, arbitrary names and messages, and coalesces repeated task progress', async t => {
  const f = await fixture(t);
  assert.equal((await f.runtime.invoke({ name: 'getReview', payload: randomUUID() })).ok, false);
  await f.runtime.invoke({ name: 'runWorkspaceCommand', payload: { action: 'workspace.licenseActivate', payload: { token: PRIVATE, url: 'https://secret.example/private' } } });
  await f.runtime.invoke({ name: PRIVATE, payload: { content: PRIVATE } });
  await f.runtime.invoke({ name: 'loadSample' });
  await f.command('maintenance.exportDiagnostics');
  const text = await readFile(f.exported, 'utf8');
  assert.doesNotMatch(text, new RegExp(PRIVATE, 'u')); assert.doesNotMatch(text, /secret\.example|https:\/\//u);
  const entries = text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(entries.filter(row => row.event === 'task.progress').length, 2);
  assert.ok(entries.some(row => row.event === 'command.failed' && row.command === 'getReview'));
});

test('unavailable diagnostic storage cannot stop ordinary business reads', async t => {
  const f = await fixture(t, { disabledLog: true });
  assert.equal(value<{ available: boolean }>(await f.command('maintenance.diagnosticsStatus')).available, false);
  assert.deepEqual(value<{ documents: unknown[] }>(await f.runtime.invoke({ name: 'getState' })).documents, []);
});

test('shutdown during export drains its operation and prevents a late file save', async t => {
  const f = await fixture(t, { delayNativeRead: true });
  const exporting = f.command('maintenance.exportDiagnostics');
  await until(async () => f.nativeEntered());
  const closing = f.runtime.close(); f.releaseNative();
  assert.equal((await exporting).ok, false); await closing;
  await assert.rejects(access(f.exported));
});

test('normal shutdown flushes the final lifecycle event without retaining raw worker output', async t => {
  const f = await fixture(t);
  await f.runtime.close();
  const text = await readFile(join(f.directory, 'diagnostics', 'app.jsonl'), 'utf8');
  assert.match(text, /desktop\.closed/u); assert.doesNotMatch(text, new RegExp(PRIVATE, 'u'));
});

test('a Core startup failure retains a sanitized failure record while preserving startup rejection', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'law-diagnostics-startup-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, 'failed-core.mjs');
  await writeFile(entry, `throw new Error(${JSON.stringify(PRIVATE)});`);
  await assert.rejects(createDesktopRuntime({ emitTask: () => {}, call: async () => { throw new Error('Unexpected host request.'); } }, {
    dataDir: directory, coreEntry: pathToFileURL(entry), pressurePollMs: 0,
  }), /本地服务已停止/u);
  const text = await readFile(join(directory, 'diagnostics', 'app.jsonl'), 'utf8');
  assert.match(text, /desktop\.startup_failed/u); assert.match(text, /core\.error/u);
  assert.doesNotMatch(text, new RegExp(PRIVATE, 'u'));
});
