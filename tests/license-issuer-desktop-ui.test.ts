import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

type Summary = { licenseId: string; seat: number; deviceCode: string; issuedAt: string; startsAt: string; expiresAt: string };
type Envelope = { configured: boolean; directory?: string; error?: string; state?: { limit: number; issued: number; remaining: number; keyId: string; publicKeySha256: string; licenses: Summary[] } };
type Controller = { refresh(): Promise<void>; selectDirectory(): Promise<void>; issue(): Promise<void>; retrieve(license: Summary): Promise<void>; copy(): Promise<void>; exportToken(): Promise<void> };
const { checkedState, checkedIssueInput, createIssuerController } = await import(new URL('../tools/license-issuer/desktop/app.js', import.meta.url).href) as {
  checkedState(value: unknown): Envelope;
  checkedIssueInput(device: string, starts: string): { deviceCode: string; startsAt?: string };
  createIssuerController(options: unknown): Controller;
};
const DEVICE = `LAWDEV1-${'a'.repeat(64)}`;
const TOKEN = 'LAW1.synthetic-key.c3ludGhldGlj.c2lnbmF0dXJl';
const NOW = '2026-10-27T01:02:03.000Z';
function license(seat = 1): Summary {
  return { licenseId: `00000000-0000-4000-8000-${String(seat).padStart(12, '0')}`, seat, deviceCode: seat === 1 ? DEVICE : `LAWDEV1-${seat.toString(16).padStart(64, '0')}`,
    issuedAt: NOW, startsAt: NOW, expiresAt: new Date(Date.parse(NOW) + 90 * 24 * 60 * 60 * 1000).toISOString() };
}
function configured(licenses: Summary[] = []): Envelope {
  return { configured: true, directory: '/synthetic/operator/issuer', state: { limit: 100, issued: licenses.length, remaining: 100 - licenses.length, keyId: 'synthetic-key', publicKeySha256: 'a'.repeat(64), licenses } };
}
class Element {
  textContent = ''; className = ''; value = ''; disabled = false; colSpan = 0; type = '';
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {}; children: Element[] = []; focused = false; selected = false;
  handlers = new Map<string, (...args: any[]) => void>();
  constructor(readonly tagName = 'div') {}
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(key: string, handler: (...args: any[]) => void) { this.handlers.set(key, handler); }
  append(child: Element) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}
function fixture(invoke: (command: string, input?: any) => Promise<unknown>, clipboard?: { writeText(value: string): Promise<void> }) {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const descendants = (element: Element): Element[] => [element, ...element.children.flatMap(descendants)];
  const document = { getElementById: get, createElement: (tag: string) => new Element(tag), querySelectorAll: () => [...elements.values()].flatMap(descendants).filter(element => element.dataset.licenseToken) };
  const controller = createIssuerController({ document, invoke, clipboard });
  return { get, controller, elements };
}

test('installed issuer assets expose native commands only and preserve installation / administrator boundaries', async () => {
  const [html, js, css] = await Promise.all(['index.html', 'app.js', 'styles.css'].map(file => readFile(new URL(`../tools/license-issuer/desktop/${file}`, import.meta.url), 'utf8')));
  assert.match(html, /选择已有签发资料目录/u); assert.match(html, /空目录不会创建新名额/u); assert.match(html, /升级或重新安装不会重置名额/u);
  assert.match(html, /勿随客户安装包分发/u); assert.match(html, /最多 100 份许可/u); assert.match(html, /有效期 90 天/u);
  assert.match(html, /aria-live="polite"/u); assert.match(html, /for="device-code"/u); assert.match(html, /for="starts-at"/u);
  assert.match(js, /window\.__TAURI__\?\.core\?\.invoke/u);
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|\.innerHTML\s*=|issuer_reset|issuer_delete/u);
  assert.match(css, /@media\(max-width:700px\)/u);
});

test('unconfigured startup never invents a quota or enables signing, and selecting existing data uses a native command', async () => {
  const calls: unknown[] = [];
  const f = fixture(async command => { calls.push(command); return { configured: false }; });
  await f.controller.refresh();
  assert.equal(f.get('limit').textContent, '—'); assert.equal(f.get('remaining').textContent, '—');
  assert.equal(f.get('issue-button').disabled, true); assert.equal(f.get('device-code').disabled, true);
  assert.equal(f.get('select-directory').disabled, false);
  await f.controller.issue(); assert.deepEqual(calls, ['issuer_state']);
  await f.controller.selectDirectory(); assert.deepEqual(calls, ['issuer_state', 'issuer_select_directory']);
});

test('state validation rejects malformed counts, incomplete records, duplicate bindings and invalid trial dates', () => {
  const valid = configured([license()]);
  assert.deepEqual(checkedState(valid), valid);
  for (const value of [null, {}, { configured: 'true' }, { configured: true }, { configured: false, directory: 5 },
    { ...valid, state: { ...valid.state, limit: 200 } }, { ...valid, state: { ...valid.state, issued: 2 } },
    { ...valid, state: { ...valid.state, remaining: 100 } }, { ...valid, state: { ...valid.state, publicKeySha256: 'invalid' } },
    configured([{ ...license(), expiresAt: NOW }]), configured([{ ...license(), seat: 2 }]),
    configured([license(), { ...license(2), deviceCode: DEVICE }]), configured([license(), { ...license(2), licenseId: license().licenseId }]),
  ]) assert.throws(() => checkedState(value), /记录无效/u);
});

test('a connected ledger renders actual counts and prevents accidental directory switching', async () => {
  const f = fixture(async () => configured([license()])); await f.controller.refresh();
  assert.equal(f.get('issued').textContent, '1'); assert.equal(f.get('remaining').textContent, '99'); assert.equal(f.get('limit').textContent, '100');
  assert.equal(f.get('select-directory').disabled, true); assert.equal(f.get('issue-button').disabled, false);
  assert.equal(f.get('setup-status').textContent, '已连接'); assert.equal(f.get('directory-path').textContent, '/synthetic/operator/issuer');
  assert.equal(f.get('license-rows').children.length, 1);
});

test('issue submission trims the device and leaves unspecified start time to the native signer', async () => {
  const calls: unknown[] = []; let issued = false;
  const f = fixture(async (command, input) => {
    calls.push({ command, input });
    if (command === 'issuer_issue') { issued = true; return { license: license(), token: TOKEN }; }
    return configured(issued ? [license()] : []);
  });
  await f.controller.refresh(); f.get('device-code').value = ` ${DEVICE}\n`;
  await f.controller.issue();
  assert.deepEqual(calls, [{ command: 'issuer_state', input: undefined }, { command: 'issuer_issue', input: { deviceCode: DEVICE } }, { command: 'issuer_state', input: undefined }]);
  assert.equal(f.get('license-token').value, TOKEN); assert.equal(f.get('remaining').textContent, '99');
  assert.equal(f.get('copy-token').disabled, false); assert.equal(f.get('export-token').disabled, false);
  assert.match(f.get('message').textContent, /签发成功/u);
});

test('bad device / time input is rejected before invoking the signer', async () => {
  assert.deepEqual(checkedIssueInput(` ${DEVICE} `, ''), { deviceCode: DEVICE });
  assert.deepEqual(checkedIssueInput(DEVICE, '2026-11-01T00:00:00.000Z'), { deviceCode: DEVICE, startsAt: '2026-11-01T00:00:00.000Z' });
  assert.throws(() => checkedIssueInput('bad-device', ''), /设备码/u); assert.throws(() => checkedIssueInput(DEVICE, 'invalid'), /开始时间/u);
  const calls: string[] = []; const f = fixture(async command => { calls.push(command); return configured(); });
  await f.controller.refresh(); f.get('device-code').value = 'bad-device'; await f.controller.issue(); assert.deepEqual(calls, ['issuer_state']);
});

test('copied LawAgent request information accepts compact or formatted JSON and only submits the device code', async () => {
  const request = { product: 'law-agent', appVersion: '0.3.0', deviceCode: DEVICE };
  for (const value of [JSON.stringify(request), JSON.stringify(request, null, 2), ` \n${JSON.stringify(request)}\n `]) {
    assert.deepEqual(checkedIssueInput(value, ''), { deviceCode: DEVICE });
  }
  assert.deepEqual(checkedIssueInput(JSON.stringify({ ...request, appVersion: '0.3.0-rc.1+build.2' }), NOW), { deviceCode: DEVICE, startsAt: NOW });
  const calls: unknown[] = []; let issued = false;
  const f = fixture(async (command, input) => {
    calls.push({ command, input });
    if (command === 'issuer_issue') { issued = true; return { license: license(), token: TOKEN }; }
    return configured(issued ? [license()] : []);
  });
  await f.controller.refresh(); f.get('device-code').value = JSON.stringify(request, null, 2); await f.controller.issue();
  assert.deepEqual(calls[1], { command: 'issuer_issue', input: { deviceCode: DEVICE } });
  assert.equal(f.get('remaining').textContent, '99'); assert.equal(f.get('license-token').value, TOKEN);
});

test('request information rejects other products, extra fields, malformed versions and byte-overflow without forwarding input', async () => {
  const request = { product: 'law-agent', appVersion: '0.3.0', deviceCode: DEVICE };
  const forbidden = 'synthetic-secret-never-forward';
  const invalid = [
    { ...request, product: 'other-agent' }, { ...request, deviceCode: 'invalid' }, { ...request, appVersion: '0.3.0\n' },
    { ...request, appVersion: 'v0.3.0' }, { ...request, appVersion: '0.3.0-' + 'a'.repeat(80) },
    { ...request, seat: 2 }, { ...request, token: forbidden }, { ...request, expiresAt: NOW },
    { product: 'law-agent', deviceCode: DEVICE }, [request], null,
  ].map(value => JSON.stringify(value));
  const unicodeOverflow = '\u00a0'.repeat(1000) + JSON.stringify(request);
  assert.ok(unicodeOverflow.length < 2048); assert.ok(Buffer.byteLength(unicodeOverflow) > 2048);
  invalid.push(unicodeOverflow, ' '.repeat(2048) + DEVICE);
  for (const value of invalid) assert.throws(() => checkedIssueInput(value, ''), error => {
    assert.match((error as Error).message, /设备码/u); assert.ok(!(error as Error).message.includes(forbidden)); return true;
  });
  const calls: string[] = []; const f = fixture(async command => { calls.push(command); return configured(); });
  await f.controller.refresh();
  for (const value of invalid) { f.get('device-code').value = value; await f.controller.issue(); }
  assert.deepEqual(calls, ['issuer_state']);
});

test('an intervening signer may consume a seat without hiding this newly committed activation code', async () => {
  const other = { ...license(), deviceCode: `LAWDEV1-${'b'.repeat(64)}` };
  const issued = { ...license(2), deviceCode: DEVICE };
  let complete = false;
  const f = fixture(async command => {
    if (command === 'issuer_issue') { complete = true; return { license: issued, token: TOKEN }; }
    return configured(complete ? [other, issued] : []);
  });
  await f.controller.refresh(); f.get('device-code').value = DEVICE; await f.controller.issue();
  assert.equal(f.get('license-token').value, TOKEN); assert.equal(f.get('issued').textContent, '2');
  assert.match(f.get('token-summary').textContent, /许可序号 2/u);
});

test('exhausted state disables new signing and historical retrieval preserves the quota', async () => {
  const licenses = Array.from({ length: 100 }, (_, index) => license(index + 1)); const calls: unknown[] = [];
  const f = fixture(async (command, input) => { calls.push({ command, input }); return command === 'issuer_token' ? TOKEN : configured(licenses); });
  await f.controller.refresh(); assert.equal(f.get('remaining').textContent, '0'); assert.equal(f.get('issue-button').disabled, true);
  await f.controller.issue(); assert.equal(calls.length, 1);
  await f.controller.retrieve(licenses[36]);
  assert.deepEqual(calls.at(-1), { command: 'issuer_token', input: { licenseId: licenses[36].licenseId } });
  assert.equal(f.get('license-token').value, TOKEN); assert.equal(f.get('remaining').textContent, '0'); assert.match(f.get('token-summary').textContent, /许可序号 37/u);
});

test('already committed activation code remains copyable if only the post-issue state refresh fails', async () => {
  let states = 0;
  const f = fixture(async command => {
    if (command === 'issuer_issue') return { license: license(), token: TOKEN };
    if (++states > 1) throw new Error('读取签发记录失败。'); return configured();
  });
  await f.controller.refresh(); f.get('device-code').value = DEVICE; await f.controller.issue();
  assert.equal(f.get('license-token').value, TOKEN); assert.equal(f.get('copy-token').disabled, false);
  assert.equal(f.get('issue-button').disabled, true); assert.equal(f.get('remaining').textContent, '—'); assert.match(f.get('message').textContent, /激活码已取得/u);
});

test('a resolved unconfigured envelope after a committed issue retains the code and reports the ledger error', async () => {
  let states = 0;
  const f = fixture(async command => {
    if (command === 'issuer_issue') return { license: license(), token: TOKEN };
    if (++states > 1) return { configured: false, error: '签发记录未通过校验。' }; return configured();
  });
  await f.controller.refresh(); f.get('device-code').value = DEVICE; await f.controller.issue();
  assert.equal(f.get('license-token').value, TOKEN); assert.equal(f.get('copy-token').disabled, false);
  assert.equal(f.get('issue-button').disabled, true); assert.equal(f.get('remaining').textContent, '—');
  assert.match(f.get('message').textContent, /激活码已取得/u); assert.match(f.get('message').textContent, /签发记录未通过校验/u);
  assert.equal(f.get('message').attributes.role, 'alert');
});

test('native errors remain text and a failed state refresh disables signing until recovery', async () => {
  let fail = false; const f = fixture(async () => { if (fail) throw '<script>synthetic</script>'; return configured(); });
  await f.controller.refresh(); fail = true; await f.controller.refresh();
  assert.equal(f.get('issue-button').disabled, true); assert.equal(f.get('remaining').textContent, '—');
  assert.equal(f.get('message').textContent, '<script>synthetic</script>'); assert.equal(f.get('message').attributes.role, 'alert');
  fail = false; await f.controller.refresh(); assert.equal(f.get('issue-button').disabled, false);
});

test('copy fallback selects the token, and export sends only the existing license ID to the native save dialog', async () => {
  const calls: unknown[] = []; const f = fixture(async (command, input) => {
    calls.push({ command, input }); if (command === 'issuer_token') return TOKEN; if (command === 'issuer_export_token') return true; return configured([license()]);
  });
  await f.controller.refresh(); await f.controller.retrieve(license()); await f.controller.copy();
  assert.equal(f.get('license-token').focused, true); assert.equal(f.get('license-token').selected, true);
  await f.controller.exportToken();
  assert.deepEqual(calls.at(-1), { command: 'issuer_export_token', input: { licenseId: license().licenseId } });
  assert.match(f.get('message').textContent, /文件已保存/u);
});
