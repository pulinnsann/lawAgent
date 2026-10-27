import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';

interface License { licenseId: string; seat: number; deviceCode: string; issuedAt: string; startsAt: string; expiresAt: string; token: string }
interface FakeIssuerPort { state(): unknown; issue(input: { deviceCode: string; startsAt?: string }): unknown; getToken(id: string): unknown; close(): void }
const { startLicenseIssuer } = await import(new URL('../tools/license-issuer/server.mjs', import.meta.url).href) as {
  startLicenseIssuer(options: { issuer: FakeIssuerPort; port?: number }): Promise<{ url: string; close(): Promise<void> }>;
};
const NOW = '2026-10-27T01:02:03.000Z';
const TRIAL = 90 * 24 * 60 * 60 * 1000;
const SECRET = 'synthetic-private-material-must-not-cross-http';
const device = (value = 1) => `LAWDEV1-${value.toString(16).padStart(64, '0')}`;
class FakeIssuer implements FakeIssuerPort {
  records: License[] = [];
  calls: Array<{ deviceCode: string; startsAt?: string }> = [];
  closed = 0;
  state() { return { limit: 100, issued: this.records.length, remaining: 100 - this.records.length, keyId: 'synthetic-key', publicKeySha256: 'a'.repeat(64), privateKey: SECRET, licenses: this.records.map(row => ({ ...row, privateKey: SECRET })) }; }
  issue(input: { deviceCode: string; startsAt?: string }) {
    this.calls.push(structuredClone(input));
    if (this.records.some(row => row.deviceCode === input.deviceCode)) throw Object.assign(new Error(SECRET), { code: 'ISSUER_DUPLICATE_DEVICE' });
    if (this.records.length >= 100) throw Object.assign(new Error(SECRET), { code: 'ISSUER_LIMIT' });
    const seat = this.records.length + 1;
    const startsAt = input.startsAt ?? NOW;
    const row = { licenseId: `00000000-0000-4000-8000-${seat.toString(16).padStart(12, '0')}`, seat, deviceCode: input.deviceCode,
      issuedAt: NOW, startsAt, expiresAt: new Date(Date.parse(startsAt) + TRIAL).toISOString(), token: `synthetic-token-${seat}` };
    this.records.push(row); return { ...row, privateKey: SECRET };
  }
  getToken(id: string) { const row = this.records.find(value => value.licenseId === id); if (!row) throw new Error(SECRET); return row.token; }
  close() { this.closed++; }
}
async function fixture(t: test.TestContext) {
  const issuer = new FakeIssuer(); const running = await startLicenseIssuer({ issuer });
  t.after(() => running.close());
  const url = new URL(running.url);
  const call = (path: string, options: { method?: string; headers?: Record<string, string>; bytes?: Buffer | string } = {}) => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string; json: any }>((resolve, reject) => {
    const incoming = request({ hostname: '127.0.0.1', port: Number(url.port), path, method: options.method ?? 'GET', headers: options.headers }, response => {
      const bytes: Buffer[] = [];
      response.on('data', chunk => bytes.push(chunk));
      response.once('end', () => { const text = Buffer.concat(bytes).toString('utf8'); let data; try { data = JSON.parse(text); } catch {} resolve({ status: response.statusCode!, headers: response.headers, text, json: data }); });
      response.once('error', reject);
    });
    incoming.setTimeout(3_000, () => incoming.destroy(new Error('Synthetic issuer HTTP request timed out.')));
    incoming.once('error', reject); incoming.end(options.bytes);
  });
  const session = await call('/api/session'); assert.equal(session.status, 200);
  const csrfToken = session.json.csrfToken as string;
  const post = (path: string, payload: unknown, extraHeaders: Record<string, string> = {}) => call(path, { method: 'POST', headers: { Origin: running.url, 'X-License-CSRF': csrfToken, 'Content-Type': 'application/json', ...extraHeaders }, bytes: JSON.stringify(payload) });
  return { issuer, running, call, post, csrfToken };
}

test('issuer HTTP binds a random loopback address and applies restrictive headers without CORS', async t => {
  const f = await fixture(t);
  assert.equal(new URL(f.running.url).hostname, '127.0.0.1'); assert.ok(Number(new URL(f.running.url).port) > 0);
  const page = await f.call('/'); assert.equal(page.status, 200);
  assert.match(page.text, /离线体验许可签发/); assert.match(page.text, /100 份许可/); assert.match(page.text, /90 天/);
  assert.equal(page.headers['cache-control'], 'no-store'); assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['x-frame-options'], 'DENY'); assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/u); assert.doesNotMatch(String(page.headers['content-security-policy']), /unsafe-inline|unsafe-eval/u);
  assert.equal((await f.call('/app.js')).status, 200); assert.equal((await f.call('/styles.css')).status, 200);
  assert.ok(f.csrfToken.length >= 40);
});

test('Host and Origin must match the exact loopback origin, including for session reads', async t => {
  const f = await fixture(t);
  for (const headers of [{ Host: 'attacker.example' }, { Host: `localhost:${new URL(f.running.url).port}` }, { Origin: 'https://attacker.example' }, { Origin: 'null' }, { Origin: `${f.running.url}/` }] as Array<Record<string, string>>) {
    assert.equal((await f.call('/api/session', { headers })).status, 403);
  }
  assert.equal((await f.call('/api/session', { headers: { Origin: f.running.url } })).status, 200);
  assert.equal((await f.call('/api/state', { method: 'OPTIONS', headers: { Origin: f.running.url } })).status, 405);
});

test('signing requests require both same-origin and the unpredictable session nonce', async t => {
  const f = await fixture(t); const bytes = JSON.stringify({ deviceCode: device() });
  for (const headers of [
    { 'Content-Type': 'application/json' },
    { 'Content-Type': 'application/json', Origin: f.running.url },
    { 'Content-Type': 'application/json', 'X-License-CSRF': f.csrfToken },
    { 'Content-Type': 'application/json', Origin: f.running.url, 'X-License-CSRF': 'wrong-session' },
  ] as Array<Record<string, string>>) for (const path of ['/api/issue', '/api/token']) assert.equal((await f.call(path, { method: 'POST', headers, bytes })).status, 403);
  assert.equal(f.issuer.calls.length, 0);
});

test('static routing never serves source, keys, traversal paths or query-string endpoints', async t => {
  const f = await fixture(t);
  for (const path of ['/../issuer.ts', '/%2e%2e/issuer.ts', '/server.mjs', '/issuer-private.pem', '/api/state?secret=anything', '/app.js?file=issuer.ts']) {
    const response = await f.call(path); assert.equal(response.status, 404); assert.doesNotMatch(response.text, /LicenseIssuer|synthetic-private-material/);
  }
  assert.equal((await f.post('/api/reset', {})).status, 404);
  assert.equal((await f.post('/api/delete', {})).status, 404);
  assert.equal(f.issuer.calls.length, 0);
});

test('POST bodies are JSON-only, bounded to 4KiB and cannot select a seat, expiry or private key path', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/issue', { deviceCode: device() }, { 'Content-Type': 'text/plain' })).status, 415);
  const headers = { Origin: f.running.url, 'X-License-CSRF': f.csrfToken, 'Content-Type': 'application/json' };
  assert.equal((await f.call('/api/issue', { method: 'POST', headers, bytes: '{' })).status, 400);
  assert.equal((await f.call('/api/issue', { method: 'POST', headers, bytes: Buffer.from([0xff]) })).status, 400);
  assert.equal((await f.call('/api/issue', { method: 'POST', headers: { ...headers, 'Content-Length': '4097' }, bytes: 'x'.repeat(4097) })).status, 413);
  assert.equal((await f.call('/api/issue', { method: 'POST', headers: { ...headers, 'Transfer-Encoding': 'chunked' }, bytes: 'x'.repeat(4097) })).status, 413);
  for (const input of [[], {}, { deviceCode: 'bad' }, { deviceCode: device(), startsAt: 123 }, { deviceCode: device(), seat: 2 }, { deviceCode: device(), expiresAt: NOW }, { deviceCode: device(), privateKeyPath: '/not-readable' }]) assert.equal((await f.post('/api/issue', input)).status, 400);
  assert.equal(f.issuer.calls.length, 0);
  const allowed = JSON.stringify({ deviceCode: device(3) });
  const exact = await f.call('/api/issue', { method: 'POST', headers: { ...headers, 'Content-Length': '4096' }, bytes: allowed + ' '.repeat(4096 - Buffer.byteLength(allowed)) });
  assert.equal(exact.status, 200, 'the 4KiB transport boundary itself remains usable');
});

test('issue and historical lookup expose tokens only in protected response bodies and keep actual quota counts', async t => {
  const f = await fixture(t);
  let state = await f.call('/api/state'); assert.equal(state.json.issued, 0); assert.equal(state.json.remaining, 100);
  const issued = await f.post('/api/issue', { deviceCode: device() }); assert.equal(issued.status, 200);
  assert.equal(issued.json.token, 'synthetic-token-1'); assert.equal(issued.json.license.deviceCode, device());
  assert.equal(issued.json.license.startsAt, NOW); assert.equal(Date.parse(issued.json.license.expiresAt) - Date.parse(issued.json.license.startsAt), TRIAL);
  assert.deepEqual(f.issuer.calls, [{ deviceCode: device() }], 'an omitted start time must remain omitted for server-authoritative default time');
  assert.doesNotMatch(issued.text, new RegExp(SECRET));
  state = await f.call('/api/state'); assert.equal(state.json.issued, 1); assert.equal(state.json.remaining, 99); assert.equal(state.json.licenses.length, 1);
  assert.doesNotMatch(state.text, /synthetic-token|synthetic-private-material|privateKey/u);
  const old = await f.post('/api/token', { licenseId: issued.json.license.licenseId }); assert.equal(old.status, 200); assert.equal(old.json.token, issued.json.token);
  assert.equal((await f.call('/api/state')).json.issued, 1);
  const duplicate = await f.post('/api/issue', { deviceCode: device() }); assert.equal(duplicate.status, 409); assert.doesNotMatch(duplicate.text, new RegExp(SECRET));
  assert.equal((await f.call('/api/state')).json.remaining, 99);
});

test('an explicit start time reaches the issuer and absent history cannot be reset or regenerated', async t => {
  const f = await fixture(t); const startsAt = '2026-11-01T00:00:00.000Z';
  const result = await f.post('/api/issue', { deviceCode: device(2), startsAt }); assert.equal(result.status, 200);
  assert.equal(result.json.license.startsAt, startsAt); assert.equal(Date.parse(result.json.license.expiresAt) - Date.parse(startsAt), TRIAL);
  const missing = await f.post('/api/token', { licenseId: '00000000-0000-4000-8000-999999999999' }); assert.equal(missing.status, 404); assert.doesNotMatch(missing.text, new RegExp(SECRET));
  assert.equal((await f.post('/api/token', { licenseId: '../../issuer-private.pem' })).status, 400);
  assert.equal((await f.call('/api/state')).json.issued, 1);
});

test('a full issuer reports its actual exhausted pool and errors never return internal issuer material', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 100; i++) f.issuer.issue({ deviceCode: device(i) });
  const state = await f.call('/api/state'); assert.equal(state.json.issued, 100); assert.equal(state.json.remaining, 0);
  assert.equal((await f.post('/api/issue', { deviceCode: device(101) })).status, 409);
  f.issuer.state = () => { throw new Error(SECRET); };
  const failed = await f.call('/api/state'); assert.equal(failed.status, 500); assert.doesNotMatch(failed.text, new RegExp(SECRET));
  await f.running.close(); await f.running.close(); assert.equal(f.issuer.closed, 1);
});

test('an aborted partial POST cannot sign a license or crash the local issuer server', async t => {
  const f = await fixture(t); const url = new URL(f.running.url);
  await new Promise<void>(resolve => {
    const incoming = request({ hostname: '127.0.0.1', port: Number(url.port), path: '/api/issue', method: 'POST', headers: { Origin: f.running.url, 'X-License-CSRF': f.csrfToken, 'Content-Type': 'application/json', 'Content-Length': '1000' } });
    incoming.on('error', () => {}); incoming.once('close', resolve); incoming.write('{'); incoming.flushHeaders();
    setTimeout(() => incoming.destroy(), 10);
  });
  assert.equal(f.issuer.calls.length, 0);
  assert.equal((await f.call('/api/state')).status, 200);
  assert.equal((await f.call('/api/state')).json.remaining, 100);
});
