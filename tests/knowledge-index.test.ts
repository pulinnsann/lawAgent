import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { KNOWLEDGE_INDEX_LIMITS, LocalKnowledgeIndex } from '../src/core/knowledge-index';
import { KNOWLEDGE_TOKENIZER_VERSION, knowledgeQuery } from '../src/core/knowledge-tokenizer';
import { createDocx, createPdf } from './fixtures-documents';

async function fixture(t: test.TestContext): Promise<{ base: string; folder: string; data: string; index: LocalKnowledgeIndex }> {
  const base = await mkdtemp(join(tmpdir(), 'law-index-')); const folder = join(base, 'sources'); const data = join(base, 'app');
  await mkdir(folder); const index = new LocalKnowledgeIndex(data);
  t.after(async () => { await index.close(); await rm(base, { recursive: true, force: true }); });
  return { base, folder, data, index };
}
const sync = (index: LocalKnowledgeIndex, folderPath: string, mode: 'incremental' | 'verify' = 'incremental', signal = new AbortController().signal) => index.syncFolder({ folderPath, jobId: randomUUID(), mode }, signal);

test('persistent FTS indexes all text, increments add/change/delete, and keeps stable unchanged chunks', async t => {
  const { index, folder, data } = await fixture(t);
  const textPath = join(folder, '业务制度.txt');
  await writeFile(textPath, `${'背景资料普通条文\n'.repeat(800)}深部专属检索词：验收合格后付款。\n`);
  let job = await sync(index, folder); assert.equal(job.status, 'completed'); assert.equal(job.indexed, 1); assert.equal(job.fullScan, true);
  let result = await index.search({ folderPath: folder, query: '深部专属检索词' });
  assert.ok(result.hits.some(hit => hit.excerpt.includes('深部专属检索词')));
  const hit = result.hits.find(item => item.excerpt.includes('深部专属检索词'))!;
  assert.equal(hit.location.kind, 'text'); if (hit.location.kind === 'text') assert.ok(hit.location.lineStart > 500);
  assert.equal(hit.excerptSha256, createHash('sha256').update(hit.excerpt).digest('hex'));
  assert.match(hit.sourceUri, /^file:/);
  assert.equal((await index.readChunk({ folderPath: folder, chunkId: hit.chunkId })).fileSha256, hit.fileSha256);
  job = await sync(index, folder); assert.equal(job.unchanged, 1); assert.equal(job.indexed, 0);
  assert.equal((await index.readChunk({ folderPath: folder, chunkId: hit.chunkId })).chunkId, hit.chunkId);
  // 文件元数据变化而内容相同时，verify 也不能重建块/引用版本。
  await utimes(textPath, new Date(), new Date(Date.now() + 3000));
  job = await sync(index, folder, 'verify'); assert.equal(job.unchanged, 1); assert.equal(job.indexed, 0);
  await writeFile(join(folder, 'new.md'), '供应商应承担产品质量保证责任。');
  await writeFile(textPath, '修改之后唯一标记：终止合同。');
  job = await sync(index, folder); assert.equal(job.indexed, 2);
  await assert.rejects(index.readChunk({ folderPath: folder, chunkId: hit.chunkId }), /不存在/);
  await rm(join(folder, 'new.md')); job = await sync(index, folder); assert.equal(job.deleted, 1);
  await index.close(); const reopened = new LocalKnowledgeIndex(data);
  try {
    const state = await reopened.getState(folder); assert.equal(state.indexedFiles, 1); assert.ok(state.chunks > 0); assert.equal(state.job?.id, job.id);
    result = await reopened.search({ folderPath: folder, query: '唯一标记' }); assert.equal(result.hits.length, 1); assert.match(result.hits[0]!.excerpt, /修改之后/);
  } finally { await reopened.close(); }
});

test('ICU Chinese/Thai words, bounded legal cross-language aliases, and OR natural queries', async t => {
  const { index, folder } = await fixture(t);
  await writeFile(join(folder, 'EN.txt'), 'Payment is due thirty days after acceptance.');
  await writeFile(join(folder, 'TH.txt'), 'ผู้ซื้อจะชำระเงินภายในสามสิบวันหลังการตรวจรับสินค้า');
  await writeFile(join(folder, 'ZH.txt'), '合同验收须有书面记录。');
  await sync(index, folder);
  const results = await index.search({ folderPath: folder, query: '这份合同付款风险应该如何处理？', limit: 10 });
  assert.ok(results.expandedTerms.includes('legaltopicpayment'));
  assert.ok(results.hits.some(hit => hit.relativePath === 'EN.txt'));
  assert.ok(results.hits.some(hit => hit.relativePath === 'TH.txt'));
  assert.ok((await index.search({ folderPath: folder, query: 'ตรวจรับ', limit: 10 })).hits.some(hit => hit.relativePath === 'ZH.txt'));
  assert.equal((await index.search({ folderPath: folder, query: '* OR NEAR() " ; -- ?' })).hits.length, 0);
  assert.equal(knowledgeQuery('？！...***').match, null);
  assert.ok(knowledgeQuery('payment '.repeat(1000), Array(100).fill('acceptance')).expandedTerms.length <= 48);
  assert.match(KNOWLEDGE_TOKENIZER_VERSION, /icu-word/);
});

test('DOCX paragraph/cell and PDF page coordinates are retained, with full long-block coverage', async t => {
  const { index, folder } = await fixture(t);
  await writeFile(join(folder, '合同.docx'), await createDocx({ paragraphs: ['甲方验收条款。', `${'正文'.repeat(1500)}尾部定位专词`], rawBody: '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格付款节点。</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' }));
  await writeFile(join(folder, '条件.pdf'), createPdf([['泰文 ภาษาไทย 中文 English'], ['第二页PDF独有字样：争议仲裁。']]));
  const job = await sync(index, folder); assert.equal(job.indexed, 2);
  const tail = await index.search({ folderPath: folder, query: '尾部定位专词' }); assert.ok(tail.hits.some(hit => hit.excerpt.includes('尾部定位专词')));
  const cells = await index.search({ folderPath: folder, query: '表格付款节点' }); const cell = cells.hits.find(hit => hit.excerpt.includes('表格付款节点'))!;
  assert.equal(cell.location.kind, 'docx'); if (cell.location.kind === 'docx') { assert.equal(cell.location.partName, 'word/document.xml'); assert.match(cell.location.structuralPath, /tbl.*tc/); }
  const pdf = await index.search({ folderPath: folder, query: '第二页PDF独有字样' }); const page = pdf.hits.find(hit => hit.excerpt.includes('第二页PDF独有字样'))!;
  assert.equal(page.location.kind, 'pdf'); if (page.location.kind === 'pdf') { assert.equal(page.location.pageIndex, 1); assert.ok(page.location.boxes.length > 0); assert.ok(page.location.boxes.every(box => box.y >= 0)); }
});

test('parse failure retains old version stale, blocks citations, and prevents unrelated deletion', async t => {
  const { index, folder, data } = await fixture(t);
  const docx = join(folder, '契约.docx');
  await writeFile(docx, await createDocx({ paragraphs: ['验收失败可拒绝付款。'] })); await writeFile(join(folder, '保留.txt'), '其他资料违约条款');
  await sync(index, folder); const before = (await index.search({ folderPath: folder, query: '验收失败' })).hits.find(hit => hit.relativePath === '契约.docx')!;
  await writeFile(docx, 'broken zip'); await rm(join(folder, '保留.txt'));
  const job = await sync(index, folder); assert.equal(job.status, 'partial'); assert.equal(job.failed, 1); assert.equal(job.deleted, 0); assert.equal(job.fullScan, false);
  const state = await index.getState(folder); assert.equal(state.indexedFiles, 2); assert.equal(state.staleFiles, 1);
  await assert.rejects(index.readChunk({ folderPath: folder, chunkId: before.chunkId }), /来源已变化/);
  assert.equal((await index.search({ folderPath: folder, query: '验收失败' })).hits.length, 0);
  // 旧块的哈希及版本仍在数据库中，失败不会把成功版本替成半成品。
  const db = new DatabaseSync(join(data, 'local-knowledge', 'index.sqlite'));
  try { assert.ok(db.prepare('SELECT id FROM chunks WHERE id=?').get(before.chunkId)); assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0); } finally { db.close(); }
  await writeFile(docx, await createDocx({ paragraphs: ['验收失败可拒绝付款。'] })); await sync(index, folder, 'verify');
  assert.equal((await index.readChunk({ folderPath: folder, chunkId: before.chunkId })).versionId, before.versionId);
});

test('cancelled sync checkpoints completed files and never deletes unseen files', async t => {
  const { index, folder } = await fixture(t);
  await writeFile(join(folder, 'a.txt'), '付款甲资料'); await writeFile(join(folder, 'b.txt'), '验收乙资料'); await sync(index, folder);
  await rm(join(folder, 'b.txt')); await writeFile(join(folder, 'a.txt'), '付款甲更新资料');
  const controller = new AbortController();
  const job = await index.syncFolder({ folderPath: folder, jobId: randomUUID(), mode: 'incremental' }, controller.signal, update => { if (update.indexed === 1) controller.abort(); });
  assert.equal(job.status, 'cancelled'); assert.equal(job.deleted, 0); assert.equal(job.fullScan, false); assert.equal((await index.getState(folder)).indexedFiles, 2);
  const resumed = await sync(index, folder); assert.equal(resumed.unchanged, 1); assert.equal(resumed.deleted, 1);
});

test('query/read refuses changed, deleted, symlinked, and other-root sources without rescan', async t => {
  const { index, folder, base } = await fixture(t);
  const path = join(folder, '资料.txt'); await writeFile(path, '验收来源原文一'); await sync(index, folder);
  const original = (await index.search({ folderPath: folder, query: '验收' })).hits[0]!;
  await writeFile(path, '验收来源修改二');
  assert.equal((await index.search({ folderPath: folder, query: '验收' })).hits.length, 0); assert.equal((await index.getState(folder)).staleFiles, 1);
  await sync(index, folder); const modified = (await index.search({ folderPath: folder, query: '验收' })).hits[0]!; assert.notEqual(modified.fileSha256, original.fileSha256);
  const other = join(base, 'other'); await mkdir(other); await assert.rejects(index.readChunk({ folderPath: other, chunkId: modified.chunkId }), /尚未建立/);
  const outside = join(base, 'private.txt'); await writeFile(outside, '绝不索引机密孤词'); await rm(path); await symlink(outside, path);
  await assert.rejects(index.readChunk({ folderPath: folder, chunkId: modified.chunkId }), /来源已变化/);
  const job = await sync(index, folder); assert.equal(job.status, 'partial'); assert.equal(job.deleted, 0); assert.equal((await index.search({ folderPath: folder, query: '绝不索引机密孤词' })).hits.length, 0);
  await rm(path); await sync(index, folder); assert.equal((await index.getState(folder)).indexedFiles, 0);
});

test('scanned PDF marks incomplete and does not pretend OCR; self-index files are excluded', async t => {
  const { index, folder, data } = await fixture(t);
  await writeFile(join(folder, 'scan.pdf'), createPdf([null])); const job = await sync(index, folder);
  assert.equal(job.status, 'partial'); assert.equal(job.indexed, 0); assert.ok(job.errors.some(error => error.message.includes('OCR')));
  await writeFile(join(data, '客户资料.txt'), '客户目录本地付款制度'); const whole = await sync(index, data);
  assert.equal(whole.indexed, 1); assert.equal((await index.getState(data)).indexedFiles, 1);
  assert.ok((await index.search({ folderPath: data, query: '付款' })).hits.some(hit => hit.relativePath === '客户资料.txt'));
});

test('running checkpoints recover as interrupted and verify finds equal-size restored-mtime changes', async t => {
  const { index, folder, data } = await fixture(t);
  const path = join(folder, 'verify.txt'); await writeFile(path, '付款文档甲'); await sync(index, folder);
  const before = (await index.search({ folderPath: folder, query: '付款' })).hits[0]!;
  const db = new DatabaseSync(join(data, 'local-knowledge', 'index.sqlite'));
  const root = db.prepare('SELECT id FROM roots').get()!; const oldJob = (await index.getState(folder)).job!;
  const checkpoint = { ...oldJob, id: 'interrupted-job', status: 'running', finishedAt: null };
  db.prepare('INSERT INTO sync_jobs(id,root_id,folder_path,status,started_at,job_json) VALUES(?,?,?,?,?,?)').run(checkpoint.id, String(root.id), folder, 'running', new Date(Date.now() + 1000).toISOString(), JSON.stringify(checkpoint)); db.close();
  await index.close(); const reopened = new LocalKnowledgeIndex(data);
  try {
    assert.equal((await reopened.getState(folder)).job?.status, 'interrupted');
    const bytes = await readFile(path); assert.ok(bytes.length > 0);
    await writeFile(path, '付款文档乙'); const verified = await sync(reopened, folder, 'verify'); assert.equal(verified.indexed, 1);
    const after = (await reopened.search({ folderPath: folder, query: '付款' })).hits[0]!; assert.notEqual(after.versionId, before.versionId);
  } finally { await reopened.close(); }
});

test('more than eighty files are indexed and query validation has a bounded source budget', async t => {
  const { index, folder, data } = await fixture(t);
  await Promise.all(Array.from({ length: 90 }, (_, i) => writeFile(join(folder, `${i}.txt`), '付款预算测试共同文字')));
  const job = await sync(index, folder); assert.equal(job.indexed, 90); assert.equal(job.fullScan, true);
  // 模拟未同步的批量变化；一次查询不得逐个读取全部原件。
  await Promise.all(Array.from({ length: 90 }, (_, i) => writeFile(join(folder, `${i}.txt`), '付款更新文字')));
  const result = await index.search({ folderPath: folder, query: '付款' });
  assert.equal(result.hits.length, 0); assert.equal(result.state.staleFiles, KNOWLEDGE_INDEX_LIMITS.searchFiles);
  assert.ok(result.state.limitations.some(value => value.includes('本次查询达到检索预算')));
  const db = new DatabaseSync(join(data, 'local-knowledge', 'index.sqlite'));
  try {
    const totals = db.prepare('SELECT * FROM root_totals').get()!;
    assert.equal(totals.files, 90); assert.equal(totals.chunks, 90); assert.equal(totals.stale, KNOWLEDGE_INDEX_LIMITS.searchFiles);
  } finally { db.close(); }
});

test('oversize/depth errors prevent deletion, errors are bounded, and close waits in-flight reads', async t => {
  const { index, folder } = await fixture(t);
  await writeFile(join(folder, 'removed.txt'), '保留原件'); await sync(index, folder); await rm(join(folder, 'removed.txt'));
  const large = await open(join(folder, 'large.txt'), 'w'); await large.truncate(KNOWLEDGE_INDEX_LIMITS.fileBytes + 1); await large.close();
  await Promise.all(Array.from({ length: 55 }, (_, i) => writeFile(join(folder, `invalid${i}.txt`), Buffer.from([0xff]))));
  let path = folder; for (let i = 0; i <= KNOWLEDGE_INDEX_LIMITS.directoryDepth; i++) path = join(path, 'd'); await mkdir(path, { recursive: true });
  await writeFile(join(path, 'deep.txt'), '深度超限资料');
  const job = await sync(index, folder); assert.equal(job.status, 'partial'); assert.equal(job.fullScan, false); assert.equal(job.deleted, 0); assert.equal(job.errors.length, 50); assert.ok(job.failed >= 57);
  await rm(join(folder, 'large.txt')); await Promise.all(Array.from({ length: 55 }, (_, i) => rm(join(folder, `invalid${i}.txt`)))); await rm(join(folder, 'd'), { recursive: true });
  await writeFile(join(folder, 'current.txt'), '付款当前可引用资料'); await sync(index, folder);
  const reading = index.search({ folderPath: folder, query: '付款' });
  const closing = index.close(); assert.equal((await reading).hits.length, 1); await closing;
  await assert.rejects(index.getState(folder), /已关闭/);
});

test('search cancellation propagates without marking valid source stale', async t => {
  const { index, folder } = await fixture(t);
  await writeFile(join(folder, '引用.txt'), '付款审核有效原件'); await sync(index, folder);
  const controller = new AbortController();
  const searching = index.search({ folderPath: folder, query: '付款' }, controller.signal); controller.abort();
  await assert.rejects(searching, /已取消/); assert.equal((await index.getState(folder)).staleFiles, 0);
  assert.equal((await index.search({ folderPath: folder, query: '付款' })).hits.length, 1);
});
