import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { createDocx } from './fixtures-documents';
import { defaultModelRuntimeSettings } from '../src/shared/model-runtime';
import type { ReviewTask } from '../src/shared/contracts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function wait<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> { const until = Date.now() + 5000; while (Date.now() < until) { const value = await read(); if (accept(value)) return value; await sleep(10); } throw new Error('Synthetic runtime service condition timed out.'); }

test('real SSE preview survives repeated getState/stage task emission and never enters checkpoints or ledger', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-runtime-service-')); const store = await AppStore.open(dataDir);
  const events: ReviewTask[] = []; const service = new ContractService(store, dataDir, event => events.push(event));
  const secret = 'SYNTHETIC_SERVICE_RUNTIME_KEY_NOT_REAL'; const marker = 'LIVE_SYNTHETIC_MODEL_PREVIEW'; let held: ServerResponse | undefined; let calls = 0;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
    assert.equal(body.stream, true); assert.equal(request.headers.authorization, `Bearer ${secret}`); calls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${marker} ${secret}` }, finish_reason: null }] })}\n\n`); held = response;
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address !== 'string');
    const input = join(dataDir, 'synthetic.docx'); await writeFile(input, await createDocx({ paragraphs: ['用于工程回归的合成服务合同。验收后付款。'] })); const document = await service.importFile(input);
    await service.saveConfig({ name: 'synthetic', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-stream', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 1024, contextWindowTokens: 65536, timeoutSeconds: 10 });
    const policy = defaultModelRuntimeSettings(); policy.streaming = true; policy.capabilities.streaming = 'supported';
    await service.runWorkspaceCommand({ action: 'modelRuntime.settings.save', payload: { expectedRevision: 0, body: policy } });
    const { taskId } = await service.startReview({ documentId: document.id, mode: 'model', context: { contractType: 'service', ourPartyRole: 'service_recipient', businessContext: '', strictness: 'balanced' } }, secret);
    await wait(() => service.runWorkspaceCommand({ action: 'workspace.progress', payload: { requestId: taskId } }), (value: any) => value.modelRuntime?.characters > 0);
    for (let i = 0; i < 5; i++) { const task = service.getState().tasks.find(task => task.id === taskId)!; assert(task.runtimeProgress?.characters); assert(task.runtimeProgress.preview.includes(marker)); assert(!task.runtimeProgress.preview.includes(secret)); await sleep(5); }
    const latestEvent = events.filter(task => task.id === taskId && task.status === 'running').at(-1)!; assert(latestEvent.runtimeProgress?.preview.includes(marker));
    const persisted = JSON.stringify(store.rows('SELECT checkpoint_json FROM tasks WHERE id=?', [taskId])); assert(!persisted.includes(marker)); assert(!persisted.includes('runtimeProgress')); assert(!persisted.includes(secret));
    await service.cancelReview(taskId); await wait(() => service.getState(), state => state.tasks.find(task => task.id === taskId)?.status === 'cancelled');
    assert.equal(calls, 1); const ledger: any = await service.runWorkspaceCommand({ action: 'modelRuntime.ledger.list', payload: { taskId } }); assert.equal(ledger[0].body.status, 'cancelled'); assert.equal(ledger[0].body.calls[0].status, 'cancelled'); assert(!JSON.stringify(ledger).includes(marker)); assert(!JSON.stringify(ledger).includes(secret));
    await service.close(); const database = await readFile(join(dataDir, 'workspace.sqlite')); assert(!database.includes(Buffer.from(marker))); assert(!database.includes(Buffer.from(secret)));
  } finally { held?.destroy(); await service.close().catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); }
});
