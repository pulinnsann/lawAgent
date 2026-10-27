import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocxChangeInspector, type DocxChangeInspection } from '../src/core/docx-change-inspector';
import { LocalKnowledgeIndex } from '../src/core/knowledge-index';
import { ContractService } from '../src/core/service';
import { AppStore } from '../src/core/storage';
import { createDocx } from './fixtures-documents';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Synthetic inspection shutdown did not settle.')), 3_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function assertWriterStillOwned(directory: string): Promise<void> {
  let reopened: AppStore | undefined;
  try {
    reopened = await AppStore.open(directory);
    assert.fail('The business writer must remain owned until all real cleanup barriers finish.');
  } catch (error) {
    if (reopened) throw error;
    assert.match((error as Error).message, /写入锁|已经打开|另一个实例/u);
  } finally { await reopened?.close(); }
}

test('an inspector close failure waits for held knowledge cleanup, then rejects after releasing the business writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-inspection-close-error-'));
  const knowledgeStarted = deferred(); const releaseKnowledge = deferred(); const inspectorFailed = deferred();
  let knowledgeCloses = 0; let inspectionCloses = 0;
  class HeldKnowledge extends LocalKnowledgeIndex {
    override async close() { knowledgeCloses++; knowledgeStarted.resolve(); await releaseKnowledge.promise; await super.close(); }
  }
  class FailingInspector extends DocxChangeInspector {
    override async close() { inspectionCloses++; await super.close(); inspectorFailed.resolve(); throw new Error('Synthetic inspector close failure.'); }
  }
  const store = await AppStore.open(directory); const workspaceId = store.workspaceId;
  const knowledge = new HeldKnowledge(directory); const inspector = new FailingInspector(directory);
  const service = new ContractService(store, directory, undefined, knowledge, undefined, { docxInspector: inspector });
  let closing: Promise<void> | undefined;
  try {
    closing = service.close();
    let settled = false;
    const outcome = closing.then(() => ({ error: null }), error => ({ error })).finally(() => { settled = true; });
    assert.equal(service.close(), closing, 'Repeated close calls must share the same failed cleanup attempt.');
    await within(Promise.all([knowledgeStarted.promise, inspectorFailed.promise]));
    await tick();
    assert.equal(settled, false, 'One rejected disposer must not skip the remaining live knowledge cleanup.');
    await assertWriterStillOwned(directory);
    releaseKnowledge.resolve();
    assert.match((await within(outcome)).error?.message ?? '', /Synthetic inspector close failure/u);
    const reopened = await AppStore.open(directory);
    try { assert.equal(reopened.workspaceId, workspaceId); }
    finally { await reopened.close(); }
    assert.equal(knowledgeCloses, 1); assert.equal(inspectionCloses, 1);
    await assert.rejects(service.close(), /Synthetic inspector close failure/u);
  } finally {
    releaseKnowledge.resolve(); await closing?.catch(() => {}); await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a knowledge close failure waits for an actual in-flight inspection before releasing storage and propagating the error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'law-knowledge-close-inspection-drain-'));
  const parseStarted = deferred(); const releaseParse = deferred(); const knowledgeFailed = deferred();
  class FailingKnowledge extends LocalKnowledgeIndex {
    override async close() { await super.close(); knowledgeFailed.resolve(); throw new Error('Synthetic knowledge close failure.'); }
  }
  const store = await AppStore.open(directory); const workspaceId = store.workspaceId;
  const knowledge = new FailingKnowledge(directory);
  const result: DocxChangeInspection = { protection: { kind: 'none', canCreateEditableCopy: false, reason: null }, targets: [], warnings: [] };
  const inspector = new DocxChangeInspector(directory, { inspectBytes: async () => { parseStarted.resolve(); await releaseParse.promise; return result; } });
  const service = new ContractService(store, directory, undefined, knowledge, undefined, { docxInspector: inspector });
  let closing: Promise<void> | undefined;
  try {
    const bytes = await createDocx({ paragraphs: ['Synthetic source for a gated inspection cleanup.'] });
    await mkdir(join(directory, 'documents'), { recursive: true });
    await writeFile(join(directory, 'documents', 'inspection.docx'), bytes);
    const inspecting = inspector.inspect({ documentId: 'synthetic-close-version', artifact: { artifactUri: 'documents/inspection.docx', byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, editableCopy: false });
    const inspectionOutcome = inspecting.then(() => ({ error: null }), error => ({ error }));
    await within(parseStarted.promise);
    closing = service.close();
    let settled = false;
    const outcome = closing.then(() => ({ error: null }), error => ({ error })).finally(() => { settled = true; });
    await within(knowledgeFailed.promise); await tick();
    assert.equal(inspector.stats().closed, true);
    assert.equal(inspector.stats().pending, 1, 'The fixture must still own a real admitted inspection.');
    assert.equal(settled, false, 'A knowledge error must not bypass the live inspection parser cleanup.');
    await assertWriterStillOwned(directory);
    releaseParse.resolve();
    assert.match((await within(inspectionOutcome)).error?.message ?? '', /关闭/u);
    assert.match((await within(outcome)).error?.message ?? '', /Synthetic knowledge close failure/u);
    assert.equal(inspector.stats().pending, 0); assert.equal(inspector.stats().cachedEntries, 0);
    const reopened = await AppStore.open(directory);
    try { assert.equal(reopened.workspaceId, workspaceId); }
    finally { await reopened.close(); }
  } finally {
    releaseParse.resolve(); await closing?.catch(() => {}); await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
