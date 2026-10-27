import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { LicenseManager } from '../src/core/license-manager';
import { LICENSE_TRIAL_MILLISECONDS } from '../src/shared/licensing';

const context = { contractType: 'service' as const, ourPartyRole: 'service_recipient' as const, strictness: 'balanced' as const, businessContext: 'Synthetic license engineering fixture.' };
const start = Date.parse('2026-10-01T00:00:00.000Z');
const deviceCode = 'LAWDEV1-' + 'a'.repeat(64);
const keys = generateKeyPairSync('ed25519');
function token() {
  const payload = { version: 1, product: 'law-agent', licenseId: randomUUID(), seat: 1, deviceCode, issuedAt: new Date(start).toISOString(), startsAt: new Date(start).toISOString(), expiresAt: new Date(start + LICENSE_TRIAL_MILLISECONDS).toISOString() };
  const prefix = `LAW1.test.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${prefix}.${sign(null, Buffer.from(prefix), keys.privateKey).toString('base64url')}`;
}
const delay = () => new Promise<void>(resolve => setImmediate(resolve));
async function until<T>(read: () => T, good: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const value = read(); if (good(value)) return value; await delay(); }
  throw new Error(`Synthetic license test timeout: ${label}`);
}
async function fixture(run: (value: { service: ContractService; store: AppStore; root: string; output: string; expire: () => void; manager: LicenseManager }) => Promise<void>, activate = true) {
  const root = await mkdtemp(join(tmpdir(), 'law-licensed-service-')); const output = await mkdtemp(join(tmpdir(), 'law-licensed-export-'));
  const store = await AppStore.open(root); let now = start + 86400000;
  const manager = new LicenseManager(root, { mode: 'required', deviceCode, publicKeys: { test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, now: () => now });
  if (activate) await manager.activate(token());
  const service = new ContractService(store, root, undefined, undefined, undefined, { licenseManager: manager });
  try { await run({ service, store, root, output, expire: () => { now = start + LICENSE_TRIAL_MILLISECONDS; }, manager }); }
  finally { await service.close(); await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
}
const reviewTask = (service: ContractService, taskId: string) => until(() => service.getState().tasks.find(item => item.id === taskId), item => Boolean(item && ['completed', 'failed', 'cancelled'].includes(item.status)), 'terminal review');

test('required unactivated Core rejects new imports, drafts and workspace mutations without side effects', () => fixture(async ({ service, store }) => {
  await assert.rejects(service.loadSample(), /授权/u);
  await assert.rejects(service.importFile('/synthetic/not-read.docx'), /授权/u);
  await assert.rejects(service.generateContract({ requestId: randomUUID(), description: '拟定一份双方就虚构服务、费用和验收作出约定的合同，仅用于工程测试。', language: 'zh', contractType: 'service', ourPartyRole: 'service_recipient' }, null), /授权/u);
  await assert.rejects(service.runWorkspaceCommand({ action: 'library.template.save', payload: {} }), /授权/u);
  await assert.rejects(service.runWorkspaceCommand({ action: 'documents.project.save', payload: {} }), /授权/u);
  assert.equal(service.getState().documents.length, 0); assert.equal(store.listContractDrafts().length, 0);
  const state = await service.runWorkspaceCommand({ action: 'workspace.licenseState' }); assert.equal(state.canCreate, false); assert.equal(state.status, 'missing');
}, false));

test('expiry preserves existing reviews, decisions, original files and tracked/report exports while blocking new work', () => fixture(async ({ service, store, root, output, expire }) => {
  const document = await service.loadSample(); const started = await service.startReview({ documentId: document.id, context, mode: 'local' }, null);
  const completed = await reviewTask(service, started.taskId); assert.equal(completed?.status, 'completed'); const reviewId = completed!.resultId!;
  const review = structuredClone(service.getReview(reviewId)); let changes = await service.getChanges(reviewId); const target = changes.targets.find(item => item.editable && item.editMode !== 'segments')!; assert.ok(target);
  changes = await service.saveChange({ reviewId, findingId: null, blockId: target.blockId, expectedRevision: changes.revision, replacementText: `${target.text}（合成测试）` });
  changes = await service.decideChange({ reviewId, proposalId: changes.proposals[0].id, expectedRevision: changes.revision, status: 'accepted' });
  const originalArtifact = store.getDocumentArtifact(document.id); const original = await readFile(join(root, originalArtifact.artifactUri));
  expire(); assert.equal((await service.runWorkspaceCommand({ action: 'workspace.licenseState' })).status, 'expired');
  assert.equal(service.getDocumentView(document.id).id, document.id); assert.deepEqual(service.getReview(reviewId), review);
  assert.equal((await service.getChanges(reviewId)).proposals[0].status, 'accepted');
  const exported = await service.exportModified({ reviewId, expectedRevision: changes.revision, filePath: join(output, 'existing-tracked.docx'), format: 'tracked' }); assert.ok((await readFile(exported.documentPath)).length);
  const report = await service.runWorkspaceCommand({ action: 'reporting.render', payload: { scope: 'current', reviewId, style: 'risk' } }); assert.ok(report.markdown.length > 100); assert.ok(report.snapshot.reviews.some((item:{review:{id:string}})=>item.review.id===reviewId));
  await assert.rejects(service.startReview({ documentId: document.id, context, mode: 'local' }, null), /授权/u);
  await assert.rejects(service.saveChange({ reviewId, findingId: null, blockId: target.blockId, expectedRevision: changes.revision, replacementText: '不得保存的新修改。' }), /授权/u);
  await assert.rejects(service.decideChange({ reviewId, proposalId: changes.proposals[0].id, expectedRevision: changes.revision, status: 'rejected' }), /授权/u);
  await assert.rejects(service.runWorkspaceCommand({ action: 'reporting.translation.generate', payload: {} }), /授权/u);
  await assert.rejects(service.runWorkspaceCommand({ action: 'future.unsafe.list', payload: {} }), /授权/u);
  assert.deepEqual(await readFile(join(root, originalArtifact.artifactUri)), original); assert.deepEqual(service.getReview(reviewId), review);
}));

test('a queued model review rechecks expiry at actual resource admission and sends no paid request', () => fixture(async ({ service, expire }) => {
  const originalFetch = globalThis.fetch; let calls = 0;
  try {
    const document = await service.loadSample(); await service.saveConfig({ name: 'Synthetic license endpoint', baseUrl: 'https://model.example.invalid/v1', model: 'synthetic', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 2048, contextWindowTokens: 65536, timeoutSeconds: 5 });
    globalThis.fetch = async () => { calls++; throw new Error('No model call expected'); };
    const nativeId = randomUUID(); await service.acquireExternalResource(nativeId);
    const started = await service.startReview({ documentId: document.id, context, mode: 'model' }, null);
    await until(() => service.getResourceState().queued, items => items.some(item => item.operation === 'contract_review'), 'queued licensed review');
    expire(); service.releaseExternalResource(nativeId); const done = await reviewTask(service, started.taskId);
    assert.equal(done?.status, 'failed'); assert.match(done?.error ?? '', /授权/u); assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
}));

test('an already admitted model call may finish and retain its result after trial expiry', () => fixture(async ({ service, expire }) => {
  const originalFetch = globalThis.fetch; let release!: () => void; let received = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const document = await service.loadSample(); await service.saveConfig({ name: 'Synthetic held endpoint', baseUrl: 'https://model.example.invalid/v1', model: 'synthetic', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 2048, contextWindowTokens: 65536, timeoutSeconds: 5 });
    globalThis.fetch = async (_url, init) => { const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); received = true; await held; return new Response(JSON.stringify({ model: 'synthetic', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'Synthetic completed work.', findings: [], reviewedBlockIds: input.contractBlocks.map((item: {id:string}) => item.id) }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { headers: { 'content-type': 'application/json' } }); };
    const started = await service.startReview({ documentId: document.id, context, mode: 'model' }, null); await until(() => received, Boolean, 'admitted API request'); expire(); release();
    const done = await reviewTask(service, started.taskId); assert.equal(done?.status, 'completed', done?.error ?? ''); assert.equal(service.getReview(done!.resultId!).summary, 'Synthetic completed work.');
    await assert.rejects(service.startReview({ documentId: document.id, context, mode: 'model' }, null), /授权/u);
  } finally { release?.(); globalThis.fetch = originalFetch; }
}));

test('activation commands cannot supply trust anchors or change the required build mode', () => fixture(async ({ service }) => {
  await assert.rejects(service.runWorkspaceCommand({ action: 'workspace.licenseActivate', payload: { token: token(), mode: 'development' } }), /许可证/u);
  const state = await service.runWorkspaceCommand({ action: 'workspace.licenseActivate', payload: { token: token() } }); assert.equal(state.mode, 'required'); assert.equal(state.status, 'active'); assert.equal('token' in state, false);
}, false));
