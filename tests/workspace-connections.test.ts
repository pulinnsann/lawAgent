import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { normalizeConnection, connectionBinding, ReadonlyMcpClient, retrieveConnectionEvidence, crossCheckSources } from '../src/core/workspace-connections';
import type { WorkspaceAsset } from '../src/core/workspace-assets';
import type { SourceEvidence } from '../src/shared/contracts';

const mapping = (name = 'search_statutes') => ({ name, queryArgument: 'query', arguments: { collection: 'synthetic' }, resultsPath: '', readonly: true as const });
const body = (endpoint = 'https://example.com/mcp') => normalizeConnection({ name: '合成专业只读检索', enabled: true, type: 'mcp', endpoint, statutes: mapping(), cases: null });
const asset = (endpoint: string): WorkspaceAsset => ({ id: randomUUID(), kind: 'connection', revision: 2, body: body(endpoint), deleted: false, createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', actorLabel: '合成法务', contentSha256: 'a'.repeat(64) });
const reply = (id: number, result: unknown) => ({ body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })), contentType: 'application/json', fetchedAt: new Date().toISOString() });
async function server(handler: (message: any, request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const instance = createServer(async (request, response) => { let raw = ''; for await (const chunk of request) raw += chunk; try { await handler(JSON.parse(raw), request, response); } catch { response.statusCode = 500; response.end('synthetic server error'); } });
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}/mcp`, close: async () => { const closing = new Promise<void>(resolve => instance.close(() => resolve())); instance.closeAllConnections(); await closing; } };
}

test('连接配置不保存凭据或可执行映射，端点认证与SFTP指纹必须显式配置', () => {
  const value = body(); assert.equal(value.endpoint, 'https://example.com/mcp');
  for (const endpoint of ['http://example.com/mcp', 'https://user:password@example.com/mcp', 'https://example.com/mcp?apiKey=x', 'https://example.com/mcp#hash', 'file:///etc/passwd']) assert.throws(() => body(endpoint));
  for (const extra of [{ secret: 'never-store' }, { password: 'never-store' }, { statutes: { ...mapping(), readonly: false } }, { statutes: { ...mapping(), execute: 'delete' } }, { maxResults: 21 }, { timeoutSeconds: 121 }]) assert.throws(() => normalizeConnection({ ...value, ...extra }));
  const sftp = normalizeConnection({ name: 'SFTP工程配置', enabled: false, type: 'sftp', host: 'files.example.com', username: 'synthetic', root: '/legal', fingerprint: `SHA256:${'a'.repeat(43)}` });
  assert.equal(sftp.port, 22); for (const extra of [{ fingerprint: '' }, { root: 'relative' }, { host: 'host; touch x' }, { username: '' }]) assert.throws(() => normalizeConnection({ ...sftp, ...extra }));
  const id = randomUUID(); const before = connectionBinding({ id, body: value }); assert.equal(connectionBinding({ id, body: { ...value, name: '改显示名称' } }), before); assert.notEqual(connectionBinding({ id, body: { ...value, endpoint: 'https://different.example.com/mcp' } }), before);
});

test('MCP初始化协商版本和会话，JSON与有限SSE响应可读取，参数固定映射只发送查询', async () => {
  const seen: Array<{ message: any; headers: IncomingMessage['headers'] }> = [];
  const local = await server((message, request, response) => {
    seen.push({ message, headers: request.headers });
    if (message.method === 'initialize') { response.setHeader('Mcp-Session-Id', 'synthetic-session'); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } })); }
    else if (message.method === 'notifications/initialized') { response.statusCode = 202; response.end(); }
    else if (message.method === 'tools/list') { response.setHeader('Content-Type', 'text/event-stream'); response.end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search_statutes', annotations: { readOnlyHint: true } }] } })}\n\n`); }
    else if (message.method === 'tools/call') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { results: [{ title: '合成法规片段', text: '工程内容，待律师复核。', url: 'https://example.com/document/1' }] } } })); }
  });
  try {
    const client = new ReadonlyMcpClient(local.url, 'synthetic-token', 5, new AbortController().signal); await client.initialize(); const result = await client.search({ ...mapping(), queryArgument: 'keywords', arguments: { collection: 'statutes', keywords: 'fixed-must-be-overridden' } }, '违约条款');
    assert.equal(result.structuredContent.results[0].title, '合成法规片段');
    assert.deepEqual(seen.map(item => item.message.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.equal(seen[1].message.id, undefined); for (const item of seen.slice(1)) { assert.equal(item.headers['mcp-session-id'], 'synthetic-session'); assert.equal(item.headers['mcp-protocol-version'], '2025-06-18'); }
    assert.equal(seen[0].headers.authorization, 'Bearer synthetic-token'); assert.deepEqual(seen[3].message.params, { name: 'search_statutes', arguments: { collection: 'statutes', keywords: '违约条款' } });
    assert.ok(!JSON.stringify(seen.map(item => item.message)).includes('synthetic-token'));
  } finally { await local.close(); }
});

test('只读MCP拒绝缺失或矛盾的只读声明，不调用写入工具', async () => {
  for (const annotations of [{ readOnlyHint: false }, {}, { readOnlyHint: true, destructiveHint: true }]) {
    let calls = 0;
    const client = new ReadonlyMcpClient('https://synthetic.example/mcp', undefined, 5, new AbortController().signal, async (_endpoint, request) => { const message = request.body as any; if (message.method === 'tools/list') return reply(message.id, { tools: [{ name: 'search_statutes', annotations }] }); calls++; return reply(message.id, {}); });
    await assert.rejects(client.search(mapping(), 'query'), /只读|修改|写入/); assert.equal(calls, 0);
  }
});

test('MCP工具目录分页有上限，未声明tools能力 不支持版本和错误RPC不伪装成功', async () => {
  let pages = 0;
  const client = new ReadonlyMcpClient('https://synthetic.example/mcp', undefined, 5, new AbortController().signal, async (_endpoint, request) => { const message = request.body as any; pages++; return reply(message.id, { tools: Array.from({ length: 70 }, (_, index) => ({ name: `tool-${pages}-${index}`, annotations: { readOnlyHint: true } })), nextCursor: 'same-cursor' }); });
  assert.equal((await client.tools()).length, 200); assert.equal(pages, 4);
  for (const result of [{ protocolVersion: '3000-01-01', capabilities: { tools: {} } }, { protocolVersion: '2025-06-18', capabilities: {} }]) { const invalid = new ReadonlyMcpClient('https://synthetic.example/mcp', undefined, 5, new AbortController().signal, async (_endpoint, request) => reply((request.body as any).id, result)); await assert.rejects(invalid.initialize(), /协议版本|tools能力/); }
  for (const response of [{ jsonrpc: '2.0', id: 999, result: {} }, { jsonrpc: '1.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 1, error: { message: 'secret-error' } }]) { const invalid = new ReadonlyMcpClient('https://synthetic.example/mcp', undefined, 5, new AbortController().signal, async () => ({ body: Buffer.from(JSON.stringify(response)), contentType: 'application/json', fetchedAt: '' })); await assert.rejects(invalid.initialize(), error => error instanceof Error && !error.message.includes('secret-error')); }
});

test('MCP映射形成带版本和哈希的证据，不保留令牌回显及含凭据的来源链接', async () => {
  const token = 'synthetic-credential-never-in-evidence';
  const local = await server((message, _request, response) => {
    response.setHeader('Content-Type', 'application/json'); const respond = (result: unknown) => response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    if (message.method === 'initialize') respond({ protocolVersion: '2025-11-25', capabilities: { tools: {} } });
    else if (message.method === 'notifications/initialized') { response.statusCode = 202; response.end(); }
    else if (message.method === 'tools/list') respond({ tools: [{ name: 'search_statutes', annotations: { readOnlyHint: true } }] });
    else respond({ structuredContent: { payload: { results: [{ title: `合成资料 ${token}`, excerpt: `公开工程片段 ${token}`, url: `https://example.com/detail?token=${token}`, id: 'doc-1', version: 'v1', article: '第1条' }] } } });
  });
  try {
    const configured = asset(local.url); configured.body.statutes.resultsPath = 'payload.results';
    const result = await retrieveConnectionEvidence([configured], { [configured.id]: token }, '合成查询', new AbortController().signal);
    assert.equal(result.attempts[0].status, 'complete'); assert.equal(result.evidence.length, 1); const source = result.evidence[0];
    assert.equal(source.sourceUri, null); assert.equal(source.kind, 'statute'); assert.equal(source.connection?.revision, 2); assert.equal(source.connection?.version, 'v1'); assert.equal(source.currentness, 'unknown'); assert.equal(source.isOfficial, false); assert.equal(source.contentScope, 'fragment');
    assert.ok(!JSON.stringify(result).includes(token)); assert.equal(source.excerptSha256, createHash('sha256').update(source.excerpt).digest('hex')); assert.ok(source.warnings.some(value => /隐去|凭据|脱敏/u.test(value)));
  } finally { await local.close(); }
});

test('取消和超长响应有界失败，错误不含远端正文或凭据，预先取消不发请求', async () => {
  let reached!: () => void; const arrived = new Promise<void>(resolve => { reached = resolve; }); let count = 0;
  const local = await server((_message, _request, _response) => { count++; reached(); });
  try {
    const configured = asset(local.url); const controller = new AbortController(); const running = retrieveConnectionEvidence([configured], { [configured.id]: 'no-echo-token' }, '合成查询', controller.signal); await arrived; controller.abort();
    const result = await running; assert.equal(result.attempts[0].status, 'cancelled'); assert.equal(result.evidence.length, 0); assert.ok(!JSON.stringify(result).includes('no-echo-token'));
    const previous = count; const cancelled = new AbortController(); cancelled.abort(); const pre = await retrieveConnectionEvidence([configured], {}, '合成', cancelled.signal); assert.equal(count, previous); assert.equal(pre.evidence.length, 0);
  } finally { await local.close(); }
  const oversized = await server((_message, _request, response) => { response.setHeader('Content-Type', 'application/json'); response.setHeader('Content-Length', String(3 * 1024 * 1024)); response.end('sensitive remote error text'); });
  try { const result = await retrieveConnectionEvidence([asset(oversized.url)], {}, '合成', new AbortController().signal); assert.equal(result.attempts[0].status, 'failed'); assert.equal(result.evidence.length, 0); assert.ok(!JSON.stringify(result).includes('sensitive remote')); } finally { await oversized.close(); }
});

test('非法结果字段路径不能遍历原型链，来源冲突只标识差异而不覆盖原文', async () => {
  const local = await server((message, _request, response) => { response.setHeader('Content-Type', 'application/json'); const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } } : message.method === 'tools/list' ? { tools: [{ name: 'search_statutes', annotations: { readOnlyHint: true } }] } : { structuredContent: { text: 'synthetic' } }; if (message.method === 'notifications/initialized') { response.statusCode = 202; response.end(); } else response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); });
  try { const configured = asset(local.url); configured.body.statutes.resultsPath = '__proto__.results'; const result = await retrieveConnectionEvidence([configured], {}, '合成', new AbortController().signal); assert.equal(result.attempts[0].status, 'failed'); assert.equal(result.evidence.length, 0); } finally { await local.close(); }
  const source = (id: string, text: string): SourceEvidence => ({ id, attemptId: 'synthetic', channel: 'web', kind: 'statute', title: '同名合成材料', sourceUri: 'https://example.com/doc', locator: '第1条', excerpt: text, excerptSha256: 'f'.repeat(64), contentScope: 'fragment', retrievedAt: '2026-10-23T00:00:00Z', publishedAt: null, effectiveAt: null, currentness: 'unknown', isOfficial: false, warnings: [], connection: { id: 'connection', revision: 1, provider: 'mcp', documentId: id, version: 'v1', documentNumber: '', crossCheck: 'not_attempted', relatedEvidenceIds: [] } });
  const sources = [source('left', '甲方付款'), source('right', '乙方付款')]; const before = sources.map(value => value.excerpt); const notes = crossCheckSources(sources); assert.equal(notes.length, 1); assert.deepEqual(sources.map(value => value.excerpt), before); assert.ok(sources.every(value => value.connection?.crossCheck === 'different')); assert.deepEqual(sources[0].connection?.relatedEvidenceIds, ['right']);
});

test('service工具发现回显凭据统一脱敏，关闭服务会取消并等待未完成连接再关闭存储', { timeout: 5000 }, async () => {
  const secret = 'synthetic-tools-secret'; let hold = false; let reached!: () => void; const holding = new Promise<void>(resolve => { reached = resolve; });
  const local = await server((message, _request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const respond = (result: unknown) => response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    if (message.method === 'initialize') respond({ protocolVersion: '2025-11-25', capabilities: { tools: {} } });
    else if (message.method === 'notifications/initialized') { response.statusCode = 202; response.end(); }
    else if (message.method === 'tools/list' && hold) reached();
    else respond({ tools: [{ name: 'search_statutes', description: `server accidentally echoes ${secret}`, annotations: { readOnlyHint: true } }] });
  });
  const dir = await mkdtemp(join(tmpdir(), 'law-mcp-service-')); const store = await AppStore.open(dir); const service = new ContractService(store, dir);
  try {
    const configured = await service.runWorkspaceCommand({ action: 'connections.save', payload: { expectedRevision: 0, body: body(local.url), actorLabel: '合成标签' } }) as WorkspaceAsset;
    const tools = await service.runWorkspaceCommand({ action: 'connections.tools', payload: { id: configured.id } }, { [configured.id]: secret });
    assert.equal(tools.length, 1); assert.ok(!JSON.stringify(tools).includes(secret)); assert.ok(JSON.stringify(tools).includes('[REDACTED]'));
    hold = true;
    const running = service.runWorkspaceCommand({ action: 'connections.tools', payload: { id: configured.id }, requestId: randomUUID() }, { [configured.id]: secret });
    await holding;
    const results = await Promise.allSettled([running, service.close()]);
    assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
    assert.throws(() => store.rows('SELECT 1'));
  } finally { await service.close(); await local.close(); await rm(dir, { recursive: true, force: true }); }
});
