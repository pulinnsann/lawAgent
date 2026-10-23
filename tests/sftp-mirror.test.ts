import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeConnection, runConnectionCommand, ReadonlyMcpClient } from '../src/core/workspace-connections';
import type { SftpMirrorClient, ConnectionDeps } from '../src/core/workspace-connections';
import type { WorkspaceAsset } from '../src/core/workspace-assets';

const hostKey = Buffer.from('synthetic-server-host-key'); const fingerprint = `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=+$/u, '')}`;
type Remote = { data?: Buffer; type?: '-' | 'd' | 'l'; mtime?: number; resolved?: string; stream?: () => Readable; listedSize?: number; changeAfterRead?: boolean };
class FakeSftp implements SftpMirrorClient {
  reads: string[] = []; connected = 0; ended = 0; options: any; private afterRead = new Set<string>();
  constructor(readonly files: Map<string, Remote>) {}
  async connect(options: any) { this.options = options; if (!options.hostVerifier(hostKey)) throw new Error('host key mismatch'); this.connected++; }
  async realPath(path: string) { return this.files.get(path)?.resolved ?? path; }
  async lstat(path: string) { const entry = this.files.get(path); if (!entry && path !== '/authorized') throw new Error('missing'); const directory = path === '/authorized' || entry?.type === 'd'; const size = entry?.data?.length ?? 0; return { size: entry?.changeAfterRead && this.afterRead.has(path) ? size + 1 : size, modifyTime: entry?.mtime ?? 1, isSymbolicLink: entry?.type === 'l', isDirectory: directory, isFile: !directory && entry?.type !== 'l', mode: 0, uid: 0, gid: 0, accessTime: 0, isBlockDevice: false, isCharacterDevice: false, isFIFO: false, isSocket: false }; }
  async list(path: string) { return [...this.files.entries()].filter(([name]) => name.startsWith(`${path}/`) && !name.slice(path.length + 1).includes('/')).map(([name, entry]) => ({ type: entry.type ?? '-' as const, name: name.slice(path.length + 1), size: entry.listedSize ?? entry.data?.length ?? 0, modifyTime: entry.mtime ?? 1, accessTime: 0, rights: { user: 'r', group: '', other: '' }, owner: 0, group: 0 })); }
  createReadStream(path: string) { this.reads.push(path); this.afterRead.add(path); return this.files.get(path)?.stream?.() ?? Readable.from([this.files.get(path)!.data!]); }
  async end() { this.ended++; }
}
async function fixture(files: Map<string, Remote>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'law-sftp-synthetic-'))); const client = new FakeSftp(files);
  const asset: WorkspaceAsset = { id: randomUUID(), kind: 'connection', revision: 1, body: normalizeConnection({ name: '工程SFTP镜像', type: 'sftp', enabled: true, host: 'synthetic.invalid', username: 'readonly-user', root: '/authorized', fingerprint, maxFileMb: 1 }), deleted: false, actorLabel: '测试', createdAt: '', updatedAt: '', contentSha256: '0'.repeat(64) };
  const deps: ConnectionDeps = { dataDir: root, assets: { get: () => asset } as any, secrets: { [asset.id]: '1234' }, knowledge: {} as any, sftpFactory: () => client };
  const sync = () => runConnectionCommand('connections.sync', { id: asset.id }, deps); const cache = join(root, 'remote-cache', asset.id);
  return { root, client, asset, deps, cache, sync, close: () => rm(root, { recursive: true, force: true }) };
}

test('SFTP镜像按本机SHA256校验增量，损坏缓存重新下载，完整同步才传播删除', async () => {
  const files = new Map<string, Remote>([['/authorized/a.txt', { data: Buffer.from('原始合同A') }], ['/authorized/b.txt', { data: Buffer.from('原始合同B') }]]); const f = await fixture(files);
  try {
    const first = await f.sync(); assert.equal(first.downloaded, 2); assert.equal(first.partial, false); assert.equal(f.client.options.password, '1234');
    const unchanged = await f.sync(); assert.equal(unchanged.unchanged, 2); assert.equal(f.client.reads.length, 2);
    await writeFile(join(f.cache, 'a.txt'), '本机缓存被改写'); const repaired = await f.sync(); assert.equal(repaired.downloaded, 1); assert.equal(repaired.unchanged, 1); assert.equal(await readFile(join(f.cache, 'a.txt'), 'utf8'), '原始合同A');
    files.delete('/authorized/b.txt'); const deleted = await f.sync(); assert.equal(deleted.deleted, 1); assert.ok(!(await readdir(f.cache)).includes('b.txt'));
    const manifest = JSON.parse(await readFile(join(f.cache, '.law-sync-manifest.json'), 'utf8')); assert.equal(manifest['a.txt'].sha256, createHash('sha256').update('原始合同A').digest('hex')); assert.ok(f.client.ended >= 4);
  } finally { await f.close(); }
});

test('SFTP流传输实际字节超过声明时立即有界拒绝，不覆盖旧镜像且清理临时文件', async () => {
  const remote: Remote = { data: Buffer.from('old-content') }; const files = new Map([['/authorized/a.txt', remote]]); const f = await fixture(files);
  try {
    await f.sync(); remote.mtime = 2; remote.stream = () => Readable.from([Buffer.alloc(256 * 1024), Buffer.alloc(256 * 1024)]);
    const result = await f.sync(); assert.equal(result.partial, true); assert.equal(result.downloaded, 0); assert.equal(result.skipped, 1); assert.equal(await readFile(join(f.cache, 'a.txt'), 'utf8'), 'old-content'); assert.ok(!(await readdir(f.cache)).some(name => name.endsWith('.tmp')));
  } finally { await f.close(); }
});

test('每层目录与文件realPath/lstat前后检查，链接或传输中变更不进入镜像', async () => {
  const f = await fixture(new Map([['/authorized/sub', { type: 'd', resolved: '/outside' }], ['/authorized/link.txt', { data: Buffer.from('outside-secret'), resolved: '/outside/private.txt' }], ['/authorized/change.txt', { data: Buffer.from('changing'), changeAfterRead: true }]]));
  try {
    const result = await f.sync(); assert.equal(result.partial, true); assert.equal(result.downloaded, 0); assert.ok(!f.client.reads.includes('/authorized/link.txt')); assert.ok(!f.client.reads.some(path => path.startsWith('/outside'))); assert.deepEqual((await readdir(f.cache)).filter(name => name.endsWith('.txt')), []);
  } finally { await f.close(); }
});

test('部分扫描不传播删除；取消保留已完成文件且不写成功清单；本机链接和篡改清单拒绝', async () => {
  const files = new Map<string, Remote>([['/authorized/keep.txt', { data: Buffer.from('retained') }]]); const f = await fixture(files);
  try {
    await f.sync(); files.clear(); files.set('/authorized/link.txt', { type: 'l' }); const partial = await f.sync(); assert.equal(partial.partial, true); assert.equal(partial.deleted, 0); assert.equal(await readFile(join(f.cache, 'keep.txt'), 'utf8'), 'retained');
    files.clear(); const controller = new AbortController(); files.set('/authorized/new.txt', { data: Buffer.from('new'), stream: () => Readable.from((async function* () { yield Buffer.from('n'); controller.abort(); yield Buffer.from('ew'); })()) }); f.deps.signal = controller.signal; await assert.rejects(f.sync(), /已取消/u); assert.ok(!(await readdir(f.cache)).some(name => name.endsWith('.tmp'))); assert.equal(await readFile(join(f.cache, 'keep.txt'), 'utf8'), 'retained'); f.deps.signal = undefined;
    const outside = join(f.root, 'outside.txt'); await writeFile(outside, 'outside'); await symlink(outside, join(f.cache, 'new.txt')); files.set('/authorized/new.txt', { data: Buffer.from('new') }); await assert.rejects(f.sync()); assert.equal(await readFile(outside, 'utf8'), 'outside'); await rm(join(f.cache, 'new.txt'));
    await writeFile(join(f.cache, '.law-sync-manifest.json'), JSON.stringify({ '../outside.txt': { size: 7, modifyTime: 1, sha256: '0'.repeat(64) } })); const connections = f.client.connected; await assert.rejects(f.sync(), /镜像记录无效/u); assert.equal(f.client.connected, connections);
  } finally { await f.close(); }
});

test('无session MCP在初始化后也发送协商协议版本头，仍不发送伪session', async () => {
  const headers: any[] = [];
  const client = new ReadonlyMcpClient('https://mcp.example.com', undefined, 5, new AbortController().signal, async (_url, request) => { headers.push(request.headers); const message = request.body as any; const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } } : { tools: [] }; return { body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })), contentType: 'application/json', fetchedAt: '' }; });
  await client.initialize(); await client.tools(); assert.equal(headers[0]['MCP-Protocol-Version'], undefined); assert.equal(headers[1]['MCP-Protocol-Version'], '2025-06-18'); assert.equal(headers[2]['MCP-Protocol-Version'], '2025-06-18'); assert.ok(headers.every(header => !header['Mcp-Session-Id']));
});
