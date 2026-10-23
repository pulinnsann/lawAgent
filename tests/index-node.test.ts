import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeNodeOptionsFromEnv, startKnowledgeNode } from '../src/main/index-node';
import { normalizeConnection, retrieveConnectionEvidence } from '../src/core/workspace-connections';
import type { WorkspaceAsset } from '../src/core/workspace-assets';

const token = `synthetic-token-${randomUUID()}`;
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'law-index-node-')); const documents = join(root, 'documents'); const data = join(root, 'index-data'); await mkdir(documents); await mkdir(data); return { root, documents, data }; }
async function call(url: string, path: string, body?: unknown, credential = token, extra: Record<string, string> = {}) { return fetch(`${url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }); }
async function idle(url: string) { const deadline = Date.now() + 10000; for (;;) { const response = await call(url, '/v1/status'); const status = await response.json() as any; if (!status.syncing) return status; if (Date.now() > deadline) throw new Error('synthetic index sync timeout'); await new Promise(resolve => setTimeout(resolve, 10)); } }

test('节点环境强制配置令牌和固定绝对目录，拒绝嵌套索引目录、符号链接及非法公开地址', async () => {
  assert.throws(() => knowledgeNodeOptionsFromEnv({}), /配置/u); assert.throws(() => knowledgeNodeOptionsFromEnv({ LAW_KB_ROOT: '/root', LAW_KB_DATA: '/data', LAW_KB_TOKEN: token, LAW_KB_PORT: '0' }), /PORT/u);
  const f = await fixture();
  try {
    await assert.rejects(startKnowledgeNode({ root: f.documents, dataDir: f.data, token: 'short', port: 0 }), /令牌/u);
    await assert.rejects(startKnowledgeNode({ root: f.documents, dataDir: join(f.documents, 'index'), token, port: 0 }), /独立/u);
    const link = join(f.root, 'linked-root'); await symlink(f.documents, link); await assert.rejects(startKnowledgeNode({ root: link, dataDir: f.data, token, port: 0 }), /符号链接/u);
    await assert.rejects(startKnowledgeNode({ root: f.documents, dataDir: f.data, token, port: 0, publicUrl: 'http://public.example.com/v1/' }), /HTTPS/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('索引节点只检索固定授权目录，认证/JSON预算/路径边界有效，返回可复核原文和版本', async () => {
  const f = await fixture(); const text = '企业采购制度：验收通过后付款，违约责任依约处理。'; await writeFile(join(f.documents, '采购制度.txt'), text); await writeFile(join(f.root, 'outside.txt'), '越界密文only-outside-secret');
  const node = await startKnowledgeNode({ root: f.documents, dataDir: f.data, token, port: 0, publicUrl: 'https://kb.example.com/v1/', autoSync: false });
  try {
    assert.equal((await fetch(`${node.url}/v1/status`)).status, 401); assert.equal((await call(node.url, '/v1/status', undefined, 'wrong-token')).status, 401); assert.equal((await call(node.url, '/v1/status', undefined, token, { Origin: 'https://browser.example.com' })).status, 403);
    assert.equal((await call(node.url, '/v1/sync', { mode: 'incremental', folderPath: f.root })).status, 400);
    const sync = await call(node.url, '/v1/sync', { mode: 'incremental' }); assert.equal(sync.status, 202); assert.ok((await sync.json() as any).jobId);
    const progress = await call(node.url, '/v1/status'); assert.equal(progress.status, 200); const status = await idle(node.url); assert.equal(status.state.indexedFiles, 1); assert.equal(status.state.job.status, 'completed'); assert.ok(!JSON.stringify(status).includes(token));
    assert.equal((await call(node.url, '/v1/search', { query: '验收', folderPath: f.root })).status, 400); assert.equal((await call(node.url, '/v1/search', { query: '验收', limit: 31 })).status, 400);
    assert.equal((await call(node.url, '/v1/search', { query: 'x'.repeat(17000) })).status, 413); assert.equal((await call(node.url, '/v1/search', '{invalid')).status, 400);
    assert.equal((await call(node.url, '/v1/status?file=outside.txt')).status, 400); assert.equal((await call(node.url, '/v1/chunks/..%2f..%2foutside.txt')).status, 400);
    const search = await call(node.url, '/v1/search', { query: '验收', limit: 6 }); assert.equal(search.status, 200); const result = await search.json() as any; assert.equal(result.results.length, 1); const hit = result.results[0]; assert.ok(hit.text.includes('验收通过后付款')); assert.equal(hit.fileSha256, createHash('sha256').update(text).digest('hex')); assert.ok(hit.version); assert.ok(hit.sourceUri.startsWith('https://kb.example.com/v1/chunks/')); assert.ok(!hit.sourceUri.includes(token));
    const source = await call(node.url, `/v1/chunks/${hit.id}`); assert.equal(source.status, 200); assert.equal((await source.json() as any).result.text, hit.text);
    const outside = await call(node.url, '/v1/search', { query: 'only-outside-secret' }); assert.deepEqual((await outside.json() as any).results, []);
    await writeFile(join(f.documents, '采购制度.txt'), '资料已经更新，应重建索引。'); assert.equal((await call(node.url, `/v1/chunks/${hit.id}`)).status, 404);
    assert.equal((await call(node.url, '/v1/cancel', {})).status, 202);
  } finally { await node.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('同步后台运行、拒绝重复同步并可取消，状态接口不等待整个扫描完成', async () => {
  const f = await fixture(); await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(f.documents, `${index}.txt`), '合同付款资料。'.repeat(100))));
  const node = await startKnowledgeNode({ root: f.documents, dataDir: f.data, token, port: 0, autoSync: false });
  try {
    assert.equal((await call(node.url, '/v1/sync', {})).status, 202);
    const started = Date.now(); const response = await call(node.url, '/v1/status'); const status = await response.json() as any; assert.equal(response.status, 200); assert.ok(Date.now() - started < 3000); assert.equal(status.syncing, true);
    assert.equal((await call(node.url, '/v1/sync', {})).status, 409); const cancel = await call(node.url, '/v1/cancel', {}); assert.equal(cancel.status, 202); assert.equal((await cancel.json() as any).cancelled, true);
    const stopped = await idle(node.url); assert.ok(['cancelled', 'completed'].includes(stopped.state.job.status));
  } finally { await node.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('桌面index_api连接可直接接节点，来源保留连接修订和远端版本', async () => {
  const f = await fixture(); await writeFile(join(f.documents, '制度.txt'), '验收和付款需要内部审批。');
  const node = await startKnowledgeNode({ root: f.documents, dataDir: f.data, token, port: 0 });
  try {
    await idle(node.url); const asset: WorkspaceAsset = { id: randomUUID(), kind: 'connection', revision: 2, body: normalizeConnection({ name: '测试索引节点', enabled: true, type: 'index_api', endpoint: `${node.url}/v1/` }), deleted: false, createdAt: '', updatedAt: '', actorLabel: '测试', contentSha256: '0'.repeat(64) };
    const result = await retrieveConnectionEvidence([asset], { [asset.id]: token }, '验收', new AbortController().signal);
    assert.equal(result.attempts[0].status, 'complete'); assert.equal(result.evidence.length, 1); assert.equal(result.evidence[0].connection?.revision, 2); assert.ok(result.evidence[0].connection?.version); assert.match(result.evidence[0].sourceUri!, /\/v1\/chunks\//u);
  } finally { await node.close(); await rm(f.root, { recursive: true, force: true }); }
});
