import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { BLOCK_PAGE_MAX_BYTES, getDocumentBlocks, getDocumentReviews, getDocumentView, listDocumentsPage } from '../src/core/storage-pages';
import type { ParsedContract, ReviewContext, ReviewResult, ReviewTask, BlockPageCursor } from '../src/shared/contracts';

async function document(store: AppStore, texts: string[]) {
  const parsed: ParsedContract = { format: 'docx', language: 'mixed', warnings: [], partial: false, pageCount: null, blocks: texts.map((text, ordinal) => ({ id: randomUUID(), ordinal, kind: 'paragraph', text, numberingLabel: `第${ordinal + 1}条`, locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: `body/p[${ordinal + 1}]`, paragraphId: null } })) };
  return store.addDocument(randomUUID(), 'Synthetic pagination contract.docx', `documents/${randomUUID()}/original.docx`, 100, createHash('sha256').update(JSON.stringify(parsed)).digest('hex'), parsed);
}
async function withStore(run: (store: AppStore, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'law-pagination-')); let store: AppStore | undefined;
  try { store = await AppStore.open(dir); await run(store, dir); } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
}

test('bounded block cursors reconstruct Unicode and huge original paragraphs without truncation', async () => withStore(async store => {
  const huge = '中文😀 e\u0301 ภาษาไทย \n'.repeat(11000);
  const original = await document(store, ['short first', huge, ...Array.from({ length: 125 }, (_, index) => `段落 ${index} ภาษาไทย`)]);
  const reconstructed = new Map<string, string>(); const ids: string[] = []; let cursor: BlockPageCursor | undefined;
  let windows = 0;
  do {
    const page = getDocumentBlocks(store, { documentId: original.id, cursor, limit: 7 });
    assert.ok(page.items.length <= 7); assert.ok(page.byteSize <= BLOCK_PAGE_MAX_BYTES); assert.equal(page.totalCount, original.blocks.length);
    for (const block of page.items) { if (!reconstructed.has(block.id)) ids.push(block.id); reconstructed.set(block.id, (reconstructed.get(block.id) ?? '') + block.text); if (block.textWindow) { windows++; assert.equal(block.textWindow.length, Array.from(block.text).length); assert.equal(block.textWindow.unit, 'unicode-code-point'); } }
    assert.equal(page.hasMore, page.nextCursor !== null); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.ok(windows > 2); assert.deepEqual(ids, original.blocks.map(block => block.id));
  for (const block of original.blocks) assert.equal(reconstructed.get(block.id), block.text);
  assert.deepEqual(store.getDocument(original.id), original, 'pagination must never modify source text or original locators');
}));

test('search scans complete stored text, preserves literal wildcard searches and resolves findings across pages', async () => withStore(async store => {
  const original = await document(store, ['start', ...Array.from({ length: 120 }, (_, index) => `text ${index}`), 'literal % _ 中文 Payment ภาษาไทย']);
  assert.equal(getDocumentBlocks(store, { documentId: original.id, query: '%' }).items[0].id, original.blocks.at(-1)!.id);
  const search = getDocumentBlocks(store, { documentId: original.id, query: 'PAYMENT' }); assert.equal(search.matchedCount, 1);
  const located = getDocumentBlocks(store, { documentId: original.id, aroundBlockId: original.blocks[110].id });
  assert.equal(located.items[0].id, original.blocks[110].id); assert.equal(located.items[0].ordinal, 110);
  assert.equal(located.items[0].numberingLabel, '第111条');
  assert.throws(() => getDocumentBlocks(store, { documentId: original.id, limit: 101 }));
  assert.throws(() => getDocumentBlocks(store, { documentId: original.id, cursor: { ordinal: 0, textOffset: 10000 } }), /分页/);
  assert.throws(() => getDocumentBlocks(store, { documentId: original.id, aroundBlockId: randomUUID() }), /不属于/);
}));

test('the serialized response budget stops pages before the row limit and never loses the next fragment', async () => withStore(async store => {
  const original = await document(store, Array.from({ length: 18 }, (_, index) => `${index}:` + '汉😀'.repeat(7500)));
  const first = getDocumentBlocks(store, { documentId: original.id, limit: 100 });
  assert.ok(first.items.length < 18); assert.ok(first.hasMore); assert.ok(first.nextCursor);
  assert.equal(first.byteSize, Buffer.byteLength(JSON.stringify(first))); assert.ok(first.byteSize <= BLOCK_PAGE_MAX_BYTES);
  const second = getDocumentBlocks(store, { documentId: original.id, cursor: first.nextCursor!, limit: 100 });
  assert.equal(second.items[0].ordinal, first.items.at(-1)!.ordinal + 1);
  assert.ok(second.byteSize <= BLOCK_PAGE_MAX_BYTES);
}));

test('contract list cursor tie-breaks equal timestamps and applies workspace and lifecycle visibility before paging', async () => withStore(async store => {
  const originals: Awaited<ReturnType<typeof document>>[] = []; for (let index = 0; index < 5; index++) originals.push(await document(store, [`contract ${index}`]));
  const stamp = '2026-01-01T00:00:00.000Z';
  await store.transaction(() => { store.rows('UPDATE document_versions SET created_at=?', [stamp]); store.rows("UPDATE contracts SET lifecycle_status='archived' WHERE id=?", [originals[0].contractId!]); });
  const ids: string[] = []; let cursor: ReturnType<typeof listDocumentsPage>['nextCursor'] | undefined;
  do { const page = listDocumentsPage(store, { limit: 2, ...(cursor ? { cursor } : {}) }); assert.equal(page.totalCount, 4); ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(ids, originals.slice(1).map(item => item.id).sort().reverse()); assert.equal(new Set(ids).size, 4);
  assert.throws(() => listDocumentsPage(store, { cursor: { createdAt: stamp, id: originals[0].id } }), /分页/);
  const foreign = Object.create(store) as AppStore; Object.defineProperty(foreign, 'workspaceId', { value: randomUUID() });
  assert.equal(listDocumentsPage(foreign).items.length, 0);
  assert.throws(() => getDocumentView(foreign, originals[1].id), /不属于当前工作空间/);
  assert.throws(() => getDocumentBlocks(foreign, { documentId: originals[1].id }), /不属于当前工作空间/);
  assert.throws(() => getDocumentReviews(foreign, { documentId: originals[1].id }), /不属于当前工作空间/);
}));

test('lightweight views and review history project metadata without loading historical findings or evidence', async () => withStore(async (store, dir) => {
  const source = await document(store, Array.from({ length: 120 }, (_, index) => `Source ${index}`));
  const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', businessContext: 'synthetic test', strictness: 'balanced' };
  const expected: ReviewResult[] = [];
  for (let index = 0; index < 3; index++) {
    const task: ReviewTask = { id: randomUUID(), documentId: source.id, status: 'queued', stage: 'synthetic', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, resultId: null, error: null };
    const runId = await store.createTask(task, context, 'local');
    const review: ReviewResult = { id: randomUUID(), documentId: source.id, createdAt: '2026-01-01T00:00:00.000Z', mode: 'local', modelId: null, summary: 'Synthetic history '.repeat(10000), context, findings: [], coverage: { reviewedBlockIds: source.blocks.map(block => block.id), totalBlockCount: source.blocks.length, knowledgeStatus: 'user_disabled', webStatus: 'user_disabled', limitations: [] }, elapsedMs: 1, inputTokens: null, outputTokens: null };
    await store.saveReview(review, runId); expected.push(review);
  }
  const realGetReview = store.getReview.bind(store); store.getReview = () => { throw new Error('historical full report eagerly fetched'); };
  const view = getDocumentView(store, source.id); assert.equal(view.blocks.length, 50); assert.equal(view.reviews.length, 0); assert.equal(view.reviewPage.totalCount, 3); assert.ok(!JSON.stringify(view).includes('Synthetic history'));
  const first = getDocumentReviews(store, { documentId: source.id, limit: 2 }); assert.equal(first.items.length, 2); assert.equal(first.hasMore, true); assert.ok(first.nextCursor);
  const last = getDocumentReviews(store, { documentId: source.id, limit: 2, cursor: first.nextCursor! }); assert.equal(last.items.length, 1); assert.equal(last.hasMore, false);
  assert.deepEqual([...first.items, ...last.items].map(item => item.id), expected.map(review => review.id).sort().reverse());
  store.getReview = realGetReview; assert.equal(store.getReview(first.items[0].id).summary, expected[0].summary);
  const service = new ContractService(store, dir);
  assert.equal(service.getDocumentView(source.id).reviews.length, 0); assert.equal(service.getReview(first.items[0].id).documentId, source.id);
  assert.equal(service.getState().documentsPage?.totalCount, 1);
  await service.close();
}));
