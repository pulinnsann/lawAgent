import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const marker = 'synthetic-worker-secret-never-a-protocol-frame';
const delay = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));

test('Core and nested PDF-like worker diagnostics cannot enter the private JSONL pipe or leak to stderr', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-worker-output-'));
  let child: ReturnType<typeof spawn> | undefined; let stopped = false; let stdout = ''; let stderr = ''; let partial = ''; let protocolError: Error | null = null;
  const frames: Array<Record<string, any>> = [];
  const until = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (protocolError) throw protocolError;
      if (predicate()) return;
      if (stopped) assert.fail('Synthetic desktop stopped before ' + label);
      await delay(5);
    }
    assert.fail('Synthetic desktop did not reach ' + label);
  };
  try {
    const nested = join(directory, 'pdf-like-worker.mjs');
    await writeFile(nested, [
      "import{parentPort}from'node:worker_threads';",
      'const marker=' + JSON.stringify(marker) + ';',
      "console.log('nested parser warning '+marker);console.warn('nested warning '+marker);",
      "await new Promise(done=>process.stdout.write(marker+'x'.repeat(256*1024)+'\\n',done));",
      "await new Promise(done=>process.stderr.write(marker+'y'.repeat(256*1024)+'\\n',done));",
      "parentPort.postMessage({ready:true});",
    ].join('\n'));
    const core = join(directory, 'core.mjs');
    await writeFile(core, [
      "import{parentPort,Worker}from'node:worker_threads';",
      'const marker=' + JSON.stringify(marker) + ';',
      "console.log('Core startup '+marker);console.warn('Core startup warning '+marker);",
      "parentPort.on('message',async message=>{",
      "if(message.command==='importFile'){",
      " console.log('PDF-like command '+marker);console.warn('PDF-like warning '+marker);",
      " await new Promise(done=>process.stdout.write(marker+'\\n',done));",
      " const worker=new Worker(new URL('./pdf-like-worker.mjs',import.meta.url));",
      " await new Promise((done,reject)=>{worker.once('error',reject);worker.once('exit',code=>code===0?done():reject(new Error('Synthetic nested worker failed')));});",
      " parentPort.postMessage({type:'response',id:message.id,data:{id:'synthetic-pdf',parsed:true}});",
      "}else if(message.command==='getState')parentPort.postMessage({type:'response',id:message.id,data:{documents:[],tasks:[],modelConfig:null,retrievalConfig:null,storageBackend:'rust'}});",
      "else parentPort.postMessage({type:'response',id:message.id,data:null});",
      "});parentPort.postMessage({type:'ready'});",
    ].join('\n'));
    const entry = join(directory, 'desktop.mjs');
    await writeFile(entry, [
      'import{createDesktopRuntime}from ' + JSON.stringify(pathToFileURL(join(root, 'src/desktop/runtime.ts')).href) + ';',
      'import{startDesktopProtocol}from ' + JSON.stringify(pathToFileURL(join(root, 'src/desktop/protocol.ts')).href) + ';',
      // Mirror the production parent overrides; they cannot intercept a Worker's console.
      "console.log=console.info=console.debug=(..._values)=>process.stderr.write('Desktop backend diagnostic.\\n');",
      'const session=startDesktopProtocol(process.stdin,process.stdout,host=>createDesktopRuntime(host,{dataDir:' + JSON.stringify(directory) + ',coreEntry:new URL(' + JSON.stringify(pathToFileURL(core).href) + '),shutdownTimeoutMs:1000}));',
      'void session.done.finally(()=>{process.stdin.pause();process.stdin.destroy();});',
    ].join('\n'));
    child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child!.once('exit', (code, signal) => { stopped = true; done({ code, signal }); }));
    child.once('error', () => { protocolError = new Error('Synthetic desktop process could not start'); });
    child.stdout!.on('data', chunk => {
      stdout += chunk.toString(); partial += chunk.toString();
      if (stdout.length > 2 * 1024 ** 2) { protocolError = new Error('Private protocol exceeded the synthetic output bound'); return; }
      let end;
      while ((end = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, end); partial = partial.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (!frame || !['ready', 'response', 'host', 'task', 'shutdownProgress', 'shutdownComplete'].includes(frame.type)) throw new Error('Unexpected frame');
          frames.push(frame);
        } catch { protocolError = new Error('Worker diagnostics corrupted the private JSONL protocol'); }
      }
    });
    child.stderr!.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1024 * 1024); });
    const send = (value: unknown) => child!.stdin!.write(JSON.stringify(value) + '\n');
    await until(() => frames.some(frame => frame.type === 'ready'), 'private protocol startup');
    send({ type: 'invoke', id: 'pdf-like-import', name: 'importContract' });
    await until(() => frames.some(frame => frame.type === 'host'), 'native dialog request');
    const dialog = frames.find(frame => frame.type === 'host')!; assert.equal(dialog.operation, 'showOpenDialog');
    send({ type: 'hostResponse', id: dialog.id, data: { canceled: false, filePaths: [join(directory, 'synthetic.pdf')] } });
    await until(() => frames.some(frame => frame.type === 'response' && frame.id === 'pdf-like-import'), 'noisy PDF-like command completion');
    assert.equal(frames.find(frame => frame.id === 'pdf-like-import')!.data.data.parsed, true);
    send({ type: 'invoke', id: 'after-noisy-worker', name: 'getState' });
    await until(() => frames.some(frame => frame.type === 'response' && frame.id === 'after-noisy-worker'), 'subsequent state response');
    assert.equal(frames.find(frame => frame.id === 'after-noisy-worker')!.data.data.storageBackend, 'rust');
    send({ type: 'shutdown', id: 'test-shutdown' }); await until(() => frames.some(frame => frame.type === 'shutdownComplete'), 'clean shutdown');
    const outcome = await exit; assert.equal(outcome.code, 0); assert.equal(outcome.signal, null); assert.equal(partial, '');
    assert.ok(!stdout.includes(marker), 'Worker output must not be forwarded to the private protocol');
    assert.ok(!stderr.includes(marker), 'Discarded worker diagnostics must not become parent logs');
    assert.equal(protocolError, null);
  } finally {
    if (child && !stopped) {
      child.stdin?.write(JSON.stringify({ type: 'shutdown', id: 'cleanup' }) + '\n');
      await Promise.race([new Promise<void>(done => child!.once('exit', () => done())), delay(1500)]);
      if (!stopped) { child.kill('SIGKILL'); await Promise.race([new Promise<void>(done => child!.once('exit', () => done())), delay(1500)]); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
