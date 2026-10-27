import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rename, rm, stat, symlink, truncate, utimes, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readManagedDocumentSource, verifyManagedDocumentSource, type ManagedDocumentArtifact } from '../src/core/managed-document-source';

const MAX_BYTES = 50 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const sourceError = /合同原件与审核版本不一致|原件|受管目录/u;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: test.TestContext, bytes = Buffer.from('Synthetic managed original — 合同 สัญญา 🔒')) {
  const root = await mkdtemp(join(tmpdir(), 'law-managed-document-'));
  const dataDir = join(root, 'data');
  const directory = join(dataDir, 'documents');
  await mkdir(directory, { recursive: true });
  const source = join(directory, 'original.docx');
  await writeFile(source, bytes);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, dataDir, source, bytes, artifact: { artifactUri: 'documents/original.docx', sha256: sha(bytes), byteSize: bytes.length } satisfies ManagedDocumentArtifact };
}

/** Observe real pinned-descriptor reads and inject a deterministic external
 * source change between chunks; the application helper has no test hooks. */
async function observeReads(t: test.TestContext, path: string, mutate?: () => Promise<void>) {
  const probe = await open(path, 'r');
  const prototype = Object.getPrototypeOf(probe);
  const identity = await probe.stat({ bigint: true });
  await probe.close();
  const originalRead = prototype.read as (...args: any[]) => Promise<{ bytesRead: number }>;
  const handles = new Set<FileHandle>();
  const buffers: number[] = [];
  let bytesRead = 0;
  let changed = false;
  t.mock.method(prototype, 'read', async function (this: FileHandle, ...args: any[]) {
    const current = await this.stat({ bigint: true });
    const relevant = current.dev === identity.dev && current.ino === identity.ino;
    const result = await originalRead.apply(this, args);
    if (relevant) {
      handles.add(this);
      buffers.push((args[0] as Buffer).length);
      bytesRead += result.bytesRead;
      if (!changed && mutate && result.bytesRead > 0) { changed = true; await mutate(); }
    }
    return result;
  });
  return { handles, buffers, bytesRead: () => bytesRead };
}
async function assertClosed(handles: Set<FileHandle>): Promise<void> {
  assert.ok(handles.size > 0);
  for (const handle of handles) await assert.rejects(handle.stat(), error => (error as NodeJS.ErrnoException).code === 'EBADF');
}

test('managed source reads exact bytes and independently verifies a fresh SHA256 without a retained caller buffer', async t => {
  const f = await fixture(t);
  const read = await readManagedDocumentSource(f.dataDir, f.artifact);
  assert.deepEqual(read, f.bytes);
  assert.equal(await verifyManagedDocumentSource(f.dataDir, f.artifact), undefined);
  read.fill(0);
  assert.deepEqual(await readManagedDocumentSource(f.dataDir, f.artifact), f.bytes);
  assert.deepEqual(await readFile(f.source), f.bytes);
});

test('verification hashes through one fixed 64KiB scratch buffer and closes its descriptor', async t => {
  const f = await fixture(t, Buffer.alloc(3 * CHUNK_BYTES + 17, 71));
  const observed = await observeReads(t, f.source);
  await verifyManagedDocumentSource(f.dataDir, f.artifact);
  assert.equal(observed.bytesRead(), f.bytes.length);
  assert.ok(observed.buffers.length >= 4);
  assert.ok(observed.buffers.every(length => length === CHUNK_BYTES));
  await assertClosed(observed.handles);
});

test('same-size tampering with restored modification time still fails a fresh source hash', async t => {
  const f = await fixture(t);
  await verifyManagedDocumentSource(f.dataDir, f.artifact);
  const prior = await stat(f.source);
  const changed = Buffer.from(f.bytes); changed[0] ^= 1;
  await writeFile(f.source, changed);
  await utimes(f.source, prior.atime, prior.mtime);
  assert.equal((await stat(f.source)).size, f.artifact.byteSize);
  await assert.rejects(verifyManagedDocumentSource(f.dataDir, f.artifact), sourceError);
  await assert.rejects(readManagedDocumentSource(f.dataDir, f.artifact), sourceError);
});

test('missing sources, root selection and paths escaping the managed root fail explicitly', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside.docx'); await writeFile(outside, f.bytes);
  for (const artifactUri of ['../outside.docx', outside, '.', 'documents/missing.docx']) {
    await assert.rejects(readManagedDocumentSource(f.dataDir, { ...f.artifact, artifactUri }), sourceError);
    await assert.rejects(verifyManagedDocumentSource(f.dataDir, { ...f.artifact, artifactUri }), sourceError);
  }
});

test('a final-component symlink cannot authorize an otherwise identical managed original', async t => {
  const f = await fixture(t);
  const link = join(f.dataDir, 'documents', 'linked.docx');
  try { await symlink(f.source, link, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Creating a test symlink requires OS permission.'); return; } throw error; }
  const artifact = { ...f.artifact, artifactUri: 'documents/linked.docx' };
  await assert.rejects(readManagedDocumentSource(f.dataDir, artifact), sourceError);
  await assert.rejects(verifyManagedDocumentSource(f.dataDir, artifact), sourceError);
});

test('an ancestor symlink leading outside the managed root is rejected before any source read', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'external'); await mkdir(outside); await writeFile(join(outside, 'original.docx'), f.bytes);
  try { await symlink(outside, join(f.dataDir, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Creating a test symlink requires OS permission.'); return; } throw error; }
  await assert.rejects(readManagedDocumentSource(f.dataDir, { ...f.artifact, artifactUri: 'external-link/original.docx' }), sourceError);
  await assert.rejects(verifyManagedDocumentSource(f.dataDir, { ...f.artifact, artifactUri: 'external-link/original.docx' }), sourceError);
});

test('truncated or enlarged originals cannot be read using the former artifact size', async t => {
  const f = await fixture(t);
  await truncate(f.source, f.bytes.length - 1);
  await assert.rejects(readManagedDocumentSource(f.dataDir, f.artifact), sourceError);
  await writeFile(f.source, Buffer.concat([f.bytes, Buffer.from('extra')]));
  await assert.rejects(verifyManagedDocumentSource(f.dataDir, f.artifact), sourceError);
});

test('growth while hashing cannot extend reads beyond the declared source size', async t => {
  const f = await fixture(t, Buffer.alloc(3 * CHUNK_BYTES + 11, 82));
  const observed = await observeReads(t, f.source, () => truncate(f.source, 100 * 1024 * 1024));
  await assert.rejects(verifyManagedDocumentSource(f.dataDir, f.artifact), sourceError);
  assert.ok(observed.bytesRead() <= f.bytes.length);
  assert.ok(observed.buffers.every(length => length === CHUNK_BYTES));
  await assertClosed(observed.handles);
});

test('truncation during a chunked retained read fails and closes the pinned descriptor', async t => {
  const f = await fixture(t, Buffer.alloc(3 * CHUNK_BYTES + 11, 83));
  const observed = await observeReads(t, f.source, () => truncate(f.source, 1));
  await assert.rejects(readManagedDocumentSource(f.dataDir, f.artifact), sourceError);
  assert.ok(observed.bytesRead() <= f.bytes.length);
  assert.ok(observed.buffers.every(length => length === f.bytes.length));
  await assertClosed(observed.handles);
});

test('a same-content replacement at the managed path cannot reuse the old open descriptor', async t => {
  const f = await fixture(t, Buffer.alloc(3 * CHUNK_BYTES + 11, 84));
  const observed = await observeReads(t, f.source, async () => {
    await rename(f.source, `${f.source}.preimage`);
    await writeFile(f.source, f.bytes);
  });
  await assert.rejects(verifyManagedDocumentSource(f.dataDir, f.artifact), sourceError);
  assert.deepEqual(await readFile(f.source), f.bytes);
  await assertClosed(observed.handles);
});

test('50MiB maximum and malformed declared sizes are rejected without reading an oversized source', async t => {
  const f = await fixture(t);
  for (const byteSize of [-1, 1.5, NaN, Infinity, MAX_BYTES + 1]) {
    await assert.rejects(readManagedDocumentSource(f.dataDir, { ...f.artifact, byteSize }), sourceError);
    await assert.rejects(verifyManagedDocumentSource(f.dataDir, { ...f.artifact, byteSize }), sourceError);
  }
  await truncate(f.source, MAX_BYTES + 1);
  const observed = await observeReads(t, f.source);
  await assert.rejects(readManagedDocumentSource(f.dataDir, { ...f.artifact, byteSize: MAX_BYTES }), sourceError);
  await assert.rejects(verifyManagedDocumentSource(f.dataDir, { ...f.artifact, byteSize: MAX_BYTES }), sourceError);
  assert.equal(observed.bytesRead(), 0);
});
