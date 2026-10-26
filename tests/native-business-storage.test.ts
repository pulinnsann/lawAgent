import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const nativeOnly = { skip: process.env.LAW_AGENT_STORAGE_BACKEND === 'sqljs' ? 'Native handoff tests require the default Rust backend.' : false };

async function legacyFixture(parent: string) {
  const dataDir = join(parent, 'legacy-workspace');
  const { stdout } = await execute(process.execPath, ['--import', 'tsx', 'scripts/seed-business-storage-fixture.mjs', '--data-dir', dataDir, '--documents', '3'], {
    cwd: root, env: { ...process.env, LAW_AGENT_STORAGE_BACKEND: 'sqljs' }, maxBuffer: 2 * 1024 * 1024,
  });
  return { dataDir, snapshot: JSON.parse(stdout) };
}

async function holdNativeWriter(dataDir: string, pendingId?: string) {
  const code = `import { AppStore } from './src/core/storage.ts'; const store = await AppStore.open(process.argv[1]); if (process.argv[2]) { store.rows('PRAGMA cache_size=1'); store.rows('BEGIN IMMEDIATE'); const stamp = new Date().toISOString(); store.rows('INSERT INTO workspaces(id,name,company_name,created_at,updated_at) VALUES(?,?,?,?,?)', [process.argv[2], 'Uncommitted crash fixture', null, stamp, stamp]); for(let i=0;i<64;i++) store.rows('INSERT INTO projects(id,workspace_id,name,created_at,updated_at) VALUES(?,?,?,?,?)', [crypto.randomUUID(), process.argv[2], 'Synthetic pending '+i+' '+('S'.repeat(8192)), stamp, stamp]); } process.stdout.write('READY\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code, dataDir, ...(pendingId ? [pendingId] : [])], {
    cwd: root, env: { ...process.env, LAW_AGENT_STORAGE_BACKEND: 'rust' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error(`Synthetic writer did not become ready: ${stderr}`)); }, 20000);
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('READY\n')) { clearTimeout(timeout); resolve(); } });
      child.once('exit', code => { clearTimeout(timeout); if (!stdout.includes('READY\n')) reject(new Error(`Synthetic writer exited (${code}): ${stderr}`)); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
    });
  } catch (error) { child.kill('SIGKILL'); await exited; throw error; }
  return { child, exited };
}

test('a closed schema-7 sql.js workspace keeps original bytes, reviews, approved changes and tracked export after native handoff and restart', nativeOnly, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'law-agent-native-handoff-'));
  let store: AppStore | undefined; let service: ContractService | undefined;
  try {
    const { dataDir, snapshot } = await legacyFixture(parent);
    const databasePath = join(dataDir, 'workspace.sqlite');
    const originalDatabase = await readFile(databasePath);
    const originalFile = await readFile(join(dataDir, snapshot.originalRelativePath));
    assert.equal(snapshot.schemaVersion, 7);
    store = await AppStore.open(dataDir);
    assert.equal((store as AppStore & { storageBackend: string }).storageBackend, 'rust');
    assert.deepEqual(await readFile(`${databasePath}.pre-rust-backup`), originalDatabase);
    assert.equal(store.workspaceId, snapshot.workspaceId);
    assert.deepEqual(store.getDocument(snapshot.documentId), snapshot.document);
    assert.deepEqual(store.getReview(snapshot.reviewId), snapshot.review);
    assert.deepEqual(store.getChangeProposals(snapshot.reviewId), snapshot.proposals);
    assert.equal(store.getChangeRevision(snapshot.reviewId), snapshot.changeRevision);
    service = new ContractService(store, dataDir);
    let workspace = await service.getChanges(snapshot.reviewId);
    assert.equal(workspace.proposals[0].status, 'accepted');
    const exported = await service.exportModified({ reviewId: snapshot.reviewId, expectedRevision: workspace.revision,
      format: 'tracked', revisionAuthor: 'Native storage QA', filePath: join(parent, 'tracked-native-handoff.docx') });
    const zip = await JSZip.loadAsync(await readFile(exported.documentPath));
    const xml = await zip.file('word/document.xml')!.async('string');
    assert.match(xml, /<[\w-]+:del\b/); assert.match(xml, /<[\w-]+:ins\b/);
    assert.match(xml, /Native storage QA/); assert.match(xml, /双方书面确认/);
    assert.match(xml, /w:id="37" w:author="Original Author"/);
    assert.match(xml, /<w:b\s*\/>/);
    assert.equal(hash(await readFile(join(dataDir, snapshot.originalRelativePath))), hash(originalFile));
    assert.equal(hash(originalFile), snapshot.originalSha256);
    assert.deepEqual(service.getReview(snapshot.reviewId), snapshot.review);
    await service.close(); service = undefined; store = undefined;
    store = await AppStore.open(dataDir); service = new ContractService(store, dataDir);
    workspace = await service.getChanges(snapshot.reviewId);
    assert.equal(workspace.exports.length, 1);
    assert.equal(workspace.exports[0].format, 'tracked');
    assert.equal(workspace.exports[0].revisionAuthor, 'Native storage QA');
    assert.equal(workspace.proposals[0].status, 'accepted');
    assert.deepEqual(service.getReview(snapshot.reviewId), snapshot.review);
    assert.equal(service.getDocument(snapshot.documentId).blocks.length, snapshot.document.blocks.length);
    assert.deepEqual(await readFile(`${databasePath}.pre-rust-backup`), originalDatabase, 'Restart must not replace the original rollback snapshot');
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
    await service.close(); service = undefined; store = undefined;
    const legacyRead = `import { AppStore } from './src/core/storage.ts'; const s = await AppStore.open(process.argv[1]); try { console.log(JSON.stringify({review:s.getReview(process.argv[2]),exports:s.getChangeExports(process.argv[2]),fk:s.rows('PRAGMA foreign_key_check')})); } finally { await s.close(); }`;
    const { stdout } = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', legacyRead, dataDir, snapshot.reviewId], {
      cwd: root, env: { ...process.env, LAW_AGENT_STORAGE_BACKEND: 'sqljs' }, maxBuffer: 2 * 1024 * 1024,
    });
    const legacy = JSON.parse(stdout);
    assert.deepEqual(legacy.review, snapshot.review);
    assert.equal(legacy.exports[0].documentId, exported.export.documentId);
    assert.deepEqual(legacy.fk, []);
  } finally { await service?.close(); await store?.close(); await rm(parent, { recursive: true, force: true }); }
});

test('native transactions roll back a partial multi-statement change durably without copying the database', nativeOnly, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'law-agent-native-rollback-'));
  let store: AppStore | undefined;
  try {
    const { dataDir, snapshot } = await legacyFixture(parent);
    store = await AppStore.open(dataDir);
    const id = randomUUID(); const stamp = new Date().toISOString();
    const beforeWorkspaces = store.rows('SELECT * FROM workspaces ORDER BY id');
    const beforeReview = store.getReview(snapshot.reviewId);
    await assert.rejects(store.transaction(() => {
      store!.rows('INSERT INTO workspaces(id,name,company_name,created_at,updated_at) VALUES(?,?,?,?,?)', [id, 'Must roll back', null, stamp, stamp]);
      store!.rows('INSERT INTO projects(id,workspace_id,name,created_at,updated_at) VALUES(?,?,?,?,?)', [randomUUID(), 'missing-workspace', 'Invalid FK', stamp, stamp]);
    }), /FOREIGN KEY|foreign key/);
    assert.deepEqual(store.rows('SELECT * FROM workspaces ORDER BY id'), beforeWorkspaces);
    assert.equal(store.rows('PRAGMA foreign_keys')[0].foreign_keys, 1);
    await store.close(); store = await AppStore.open(dataDir);
    assert.deepEqual(store.rows('SELECT * FROM workspaces ORDER BY id'), beforeWorkspaces);
    assert.deepEqual(store.getReview(snapshot.reviewId), beforeReview);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { await store?.close(); await rm(parent, { recursive: true, force: true }); }
});

test('a native workspace lease rejects competing processes and is released by process termination', nativeOnly, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'law-agent-native-process-lease-'));
  let owner: Awaited<ReturnType<typeof holdNativeWriter>> | undefined; let store: AppStore | undefined;
  try {
    const { dataDir, snapshot } = await legacyFixture(parent);
    owner = await holdNativeWriter(dataDir);
    const probe = `import { AppStore } from './src/core/storage.ts'; try { const s = await AppStore.open(process.argv[1]); await s.close(); console.log(JSON.stringify({opened:true})); } catch(error) { console.log(JSON.stringify({opened:false,error:error.message})); }`;
    for (const backend of ['rust', 'sqljs']) {
      const { stdout } = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', probe, dataDir], {
        cwd: root, env: { ...process.env, LAW_AGENT_STORAGE_BACKEND: backend }, maxBuffer: 1024 * 1024,
      });
      const result = JSON.parse(stdout); assert.equal(result.opened, false, `${backend} must not open another writer's workspace`);
      assert.match(result.error, /实例|打开|lease|lock|used|busy|opened/i);
    }
    owner.child.kill('SIGKILL'); await owner.exited; owner = undefined;
    store = await AppStore.open(dataDir);
    assert.equal(store.storageBackend, 'rust');
    assert.deepEqual(store.getReview(snapshot.reviewId), snapshot.review);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally { if (owner) { owner.child.kill('SIGKILL'); await owner.exited; } await store?.close(); await rm(parent, { recursive: true, force: true }); }
});

test('a killed native transaction recovers its rollback journal without losing the original review or rollback snapshot', nativeOnly, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'law-agent-native-hot-journal-'));
  let owner: Awaited<ReturnType<typeof holdNativeWriter>> | undefined; let store: AppStore | undefined;
  try {
    const { dataDir, snapshot } = await legacyFixture(parent);
    const databasePath = join(dataDir, 'workspace.sqlite'); const originalDatabase = await readFile(databasePath);
    const pendingId = randomUUID(); owner = await holdNativeWriter(dataDir, pendingId);
    assert.ok((await lstat(`${databasePath}-journal`)).isFile(), 'The crash fixture must create a real rollback journal');
    owner.child.kill('SIGKILL'); await owner.exited; owner = undefined;
    store = await AppStore.open(dataDir);
    assert.equal(store.storageBackend, 'rust');
    assert.deepEqual(store.rows('SELECT id FROM workspaces WHERE id=?', [pendingId]), []);
    assert.deepEqual(store.getReview(snapshot.reviewId), snapshot.review);
    assert.deepEqual(store.getChangeProposals(snapshot.reviewId), snapshot.proposals);
    assert.deepEqual(await readFile(`${databasePath}.pre-rust-backup`), originalDatabase);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
    await store.close(); store = await AppStore.open(dataDir);
    assert.deepEqual(store.rows('SELECT id FROM workspaces WHERE id=?', [pendingId]), []);
    assert.deepEqual(store.getReview(snapshot.reviewId), snapshot.review);
  } finally { if (owner) { owner.child.kill('SIGKILL'); await owner.exited; } await store?.close(); await rm(parent, { recursive: true, force: true }); }
});

test('first native activation refuses an unrelated preexisting rollback snapshot and leaves both files unchanged', nativeOnly, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'law-agent-native-invalid-backup-'));
  let store: AppStore | undefined;
  try {
    const { dataDir, snapshot } = await legacyFixture(parent);
    const path = join(dataDir, 'workspace.sqlite'); const backupPath = `${path}.pre-rust-backup`;
    const original = await readFile(path); const unrelated = Buffer.alloc(0);
    // An empty SQLite file can pass quick_check; it is not this workspace's
    // byte-identical preimage and cannot serve as its rollback snapshot.
    await writeFile(backupPath, unrelated);
    await assert.rejects(AppStore.open(dataDir), /备份|backup|snapshot/i);
    assert.deepEqual(await readFile(path), original);
    assert.deepEqual(await readFile(backupPath), unrelated);
    await rm(backupPath);
    store = await AppStore.open(dataDir);
    assert.deepEqual(store.getReview(snapshot.reviewId), snapshot.review);
    assert.deepEqual(await readFile(backupPath), original);
  } finally { await store?.close(); await rm(parent, { recursive: true, force: true }); }
});
