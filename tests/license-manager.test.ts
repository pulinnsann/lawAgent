import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { LicenseActivationError, LicenseManager, type LicenseErrorCode } from '../src/core/license-manager';
import { LICENSE_TOKEN_MAX_BYTES, LICENSE_TRIAL_MILLISECONDS, type LicenseMode, type LicensePayload } from '../src/shared/licensing';

// Test-only ephemeral keys: the application never contains an issuer private key.
const trusted = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const publicKey = trusted.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherPublicKey = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const deviceCode = 'LAWDEV1-' + 'a'.repeat(64);
const wrongDevice = 'LAWDEV1-' + 'b'.repeat(64);
const START = Date.parse('2026-10-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (value: number) => new Date(value).toISOString();
const payload = (overrides: Record<string, unknown> = {}) => ({
  version: 1, product: 'law-agent', licenseId: randomUUID(), seat: 1,
  deviceCode, issuedAt: iso(START), startsAt: iso(START), expiresAt: iso(START + LICENSE_TRIAL_MILLISECONDS), ...overrides,
});
function rawToken(bytes: Buffer, kid = 'test-2026', key: KeyObject = trusted.privateKey) {
  const prefix = `LAW1.${kid}.${bytes.toString('base64url')}`;
  return `${prefix}.${sign(null, Buffer.from(prefix), key).toString('base64url')}`;
}
function token(value: Record<string, unknown> = payload(), kid = 'test-2026', key = trusted.privateKey) {
  return rawToken(Buffer.from(JSON.stringify(value)), kid, key);
}
async function fixture(t: TestContext, options: { mode?: LicenseMode; deviceCode?: string | null; now?: () => number; publicKeys?: Record<string, string> } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-license-test-'));
  const manager = new LicenseManager(dataDir, { mode: 'required', deviceCode, publicKeys: { 'test-2026': publicKey }, now: () => START + DAY, ...options });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { manager, dataDir, activationPath: join(dataDir, 'licensing', 'activation.json') };
}
async function rejectsCode(work: Promise<unknown>, code: LicenseErrorCode, sensitive?: string) {
  await assert.rejects(work, error => {
    assert.ok(error instanceof LicenseActivationError);
    assert.equal(error.code, code);
    if (sensitive) {
      assert.equal(error.message.includes(sensitive), false);
      assert.equal(error.stack?.includes(sensitive), false);
      assert.equal(JSON.stringify(error).includes(sensitive), false);
    }
    return true;
  });
}
async function installRecord(dataDir: string, signed: string, observedAt = iso(START + DAY)) {
  await mkdir(join(dataDir, 'licensing'), { recursive: true });
  await writeFile(join(dataDir, 'licensing', 'activation.json'), JSON.stringify({ token: signed, observedAt }));
}

test('required mode starts read-only and never returns a token in public state', async t => {
  const { manager, dataDir } = await fixture(t);
  assert.deepEqual(await readdir(dataDir), []);
  const before = await manager.state();
  assert.equal(before.status, 'missing'); assert.equal(before.mode, 'required');
  assert.equal(before.canCreate, false); assert.equal(before.canViewExport, true);
  assert.equal(before.deviceCode, deviceCode); assert.equal(before.license, null);
  await rejectsCode(manager.assertWritable(), 'LICENSE_READ_ONLY');
  const signed = token(); const active = await manager.activate(signed);
  assert.equal(active.status, 'active'); assert.equal(active.canCreate, true); assert.equal(active.canViewExport, true);
  assert.equal(active.license?.seat, 1); assert.equal(active.license?.expiresAt, iso(START + LICENSE_TRIAL_MILLISECONDS));
  assert.equal(JSON.stringify(active).includes(signed), false);
  assert.deepEqual(Object.keys(active.license!).sort(), ['expiresAt', 'issuedAt', 'licenseId', 'seat', 'startsAt']);
  await manager.assertWritable();
});

test('activation persists only the signed token and observed UTC time with owner-only permissions', async t => {
  const { manager, dataDir, activationPath } = await fixture(t);
  const signed = token(payload({ seat: 100 })); await manager.activate(signed);
  const saved = JSON.parse(await readFile(activationPath, 'utf8'));
  assert.deepEqual(saved, { token: signed, observedAt: iso(START + DAY) });
  assert.deepEqual(await readdir(join(dataDir, 'licensing')), ['activation.json']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(activationPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dataDir, 'licensing'))).mode & 0o777, 0o700);
  }
  await manager.close();
  const restored = new LicenseManager(dataDir, { mode: 'required', deviceCode, publicKeys: { 'test-2026': publicKey }, now: () => START + 2 * DAY });
  t.after(() => restored.close());
  const state = await restored.state(); assert.equal(state.status, 'active'); assert.equal(state.license?.seat, 100);
  assert.equal(state.license?.expiresAt, iso(START + LICENSE_TRIAL_MILLISECONDS));
});

test('90 days run from signed startsAt, and every admission checks the exact expiry boundary', async t => {
  let now = START + 89 * DAY;
  const { manager } = await fixture(t, { now: () => now });
  const active = await manager.activate(token());
  assert.equal(active.license?.expiresAt, iso(START + 90 * DAY));
  now = START + 90 * DAY - 1; await manager.assertWritable();
  now += 1;
  const expired = await manager.state();
  assert.equal(expired.status, 'expired'); assert.equal(expired.canCreate, false); assert.equal(expired.canViewExport, true);
  await rejectsCode(manager.assertWritable(), 'LICENSE_READ_ONLY');
  now += DAY; await rejectsCode(manager.activate(token()), 'LICENSE_EXPIRED');
});

test('trusted development mode remains explicit and optional license expiry remains visible', async t => {
  let now = START + DAY;
  const { manager } = await fixture(t, { mode: 'development', now: () => now });
  const initial = await manager.state(); assert.equal(initial.status, 'development'); assert.equal(initial.canCreate, true);
  await manager.assertWritable(); await manager.activate(token());
  now = START + LICENSE_TRIAL_MILLISECONDS;
  const state = await manager.state(); assert.equal(state.status, 'expired'); assert.equal(state.canCreate, true);
  await manager.assertWritable();
  assert.throws(() => new LicenseManager('/unused', { mode: 'community' as LicenseMode, deviceCode, publicKeys: {} }), /授权运行配置无效/u);
});

test('device binding is exact, unknown devices remain read-only, and a copied activation cannot activate another device', async t => {
  const first = await fixture(t); const signed = token(); await first.manager.activate(signed);
  const second = await fixture(t, { deviceCode: wrongDevice });
  await rejectsCode(second.manager.activate(signed), 'LICENSE_WRONG_DEVICE', signed);
  await installRecord(second.dataDir, signed);
  assert.equal((await second.manager.state()).status, 'invalid');
  await rejectsCode(second.manager.assertWritable(), 'LICENSE_READ_ONLY');
  for (const value of [null, 'LAWDEV1-' + 'A'.repeat(64), 'invalid', 'LAWDEV1-' + 'a'.repeat(63)]) {
    const unknown = await fixture(t, { deviceCode: value });
    assert.equal((await unknown.manager.state()).status, 'device_unavailable');
    assert.equal((await unknown.manager.state()).canCreate, false);
    await rejectsCode(unknown.manager.activate(signed), 'LICENSE_DEVICE_UNAVAILABLE', signed);
  }
});

test('signature covers the payload and key id and untrusted signers cannot activate', async t => {
  const { manager } = await fixture(t);
  const signed = token(); const parts = signed.split('.');
  const edited = Buffer.from(JSON.stringify(payload({ seat: 2 }))).toString('base64url');
  const cases = [token(payload(), 'unknown'), token(payload(), 'test-2026', other.privateKey),
    [parts[0], parts[1], edited, parts[3]].join('.'), ['LAW1', 'other', parts[2], parts[3]].join('.'),
    [...parts.slice(0, 3), Buffer.alloc(64).toString('base64url')].join('.')];
  for (const value of cases) await rejectsCode(manager.activate(value), 'LICENSE_INVALID', value);
  assert.equal((await manager.state()).status, 'missing');
});

test('only pinned Ed25519 public PEM keys become trust anchors and keyring mutation has no effect', async t => {
  const privatePem = trusted.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  for (const pem of [privatePem, rsa, 'not a PEM key']) {
    const { manager } = await fixture(t, { publicKeys: { 'test-2026': pem } });
    await rejectsCode(manager.activate(token()), 'LICENSE_INVALID');
  }
  const pinned = { 'test-2026': publicKey }; const { manager } = await fixture(t, { publicKeys: pinned });
  pinned['test-2026'] = otherPublicKey;
  await rejectsCode(manager.activate(token(payload(), 'test-2026', other.privateKey)), 'LICENSE_INVALID');
  assert.equal((await manager.activate(token())).status, 'active');
});

test('token grammar is canonical and bounded, including decoded UTF-8 and payload limits', async t => {
  const { manager } = await fixture(t); const signed = token(); const parts = signed.split('.');
  const malformed = ['', ' ' + signed, signed + '\n', signed + '.extra', signed.replace('LAW1.', 'LAW2.'),
    ['LAW1', '../key', parts[2], parts[3]].join('.'), [parts[0], parts[1], parts[2] + '=', parts[3]].join('.'),
    [parts[0], parts[1], parts[2], parts[3] + '='].join('.'),
    [parts[0], parts[1], parts[2], Buffer.alloc(63).toString('base64url')].join('.'),
    'x'.repeat(LICENSE_TOKEN_MAX_BYTES + 1), '界'.repeat(LICENSE_TOKEN_MAX_BYTES / 2),
    rawToken(Buffer.from([0xff, 0xfe])), rawToken(Buffer.from('null')), rawToken(Buffer.from('[]')),
    rawToken(Buffer.from('{')), rawToken(Buffer.alloc(2049, 32))];
  for (const value of malformed) await rejectsCode(manager.activate(value), 'LICENSE_INVALID', value || undefined);
  await rejectsCode(manager.activate(null as unknown as string), 'LICENSE_INVALID');
  assert.equal((await manager.state()).status, 'missing');
});

test('signed payload is strict about identity, seats, product and all dates', async t => {
  const { manager } = await fixture(t);
  const invalidPayloads = [
    { version: 2 }, { product: 'hr-agent' }, { licenseId: '../license' }, { seat: 0 }, { seat: 101 }, { seat: 1.5 }, { seat: '1' },
    { deviceCode: wrongDevice.toUpperCase() }, { additional: true }, { publicKey },
    { startsAt: '2026-10-01' }, { startsAt: '2026-10-01T00:00:00+00:00' }, { issuedAt: '2026-02-30T00:00:00.000Z' },
    { issuedAt: '2026-10-01T00:00:00.00Z' }, { issuedAt: iso(START + 1) },
    { expiresAt: iso(START + LICENSE_TRIAL_MILLISECONDS - 1) }, { expiresAt: iso(START + LICENSE_TRIAL_MILLISECONDS + 1) },
    { expiresAt: iso(START + 89 * DAY) }, { expiresAt: iso(START - DAY) },
  ];
  for (const invalidFields of invalidPayloads) await rejectsCode(manager.activate(token(payload(invalidFields))), 'LICENSE_INVALID');
  const missing = payload(); delete (missing as Partial<LicensePayload>).issuedAt;
  await rejectsCode(manager.activate(token(missing)), 'LICENSE_INVALID');
  // UTC timestamps without optional milliseconds are accepted canonically.
  assert.equal((await manager.activate(token(payload({ issuedAt: '2026-10-01T00:00:00Z', startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-12-30T00:00:00Z' })))).status, 'active');
});

test('invalid, future, expired or wrong-device activation never replaces an existing valid license', async t => {
  const { manager, activationPath, dataDir } = await fixture(t); const valid = token(); await manager.activate(valid);
  const before = await readFile(activationPath, 'utf8');
  const cases: Array<[string, LicenseErrorCode]> = [
    ['invalid-sensitive-token', 'LICENSE_INVALID'], [token(payload({ deviceCode: wrongDevice })), 'LICENSE_WRONG_DEVICE'],
    [token(payload({ issuedAt: iso(START + 2 * DAY), startsAt: iso(START + 2 * DAY), expiresAt: iso(START + 92 * DAY) })), 'LICENSE_NOT_STARTED'],
    [token(payload({ issuedAt: iso(START - 91 * DAY), startsAt: iso(START - 91 * DAY), expiresAt: iso(START - DAY) })), 'LICENSE_EXPIRED'],
  ];
  for (const [value, code] of cases) {
    await rejectsCode(manager.activate(value), code, value);
    assert.equal(await readFile(activationPath, 'utf8'), before);
    assert.equal((await manager.state()).status, 'active');
    assert.deepEqual(await readdir(join(dataDir, 'licensing')), ['activation.json']);
  }
});

test('persisted future/expired licenses remain available as read-only metadata', async t => {
  for (const [now, expected] of [[START - 1, 'not_started'], [START + LICENSE_TRIAL_MILLISECONDS, 'expired']] as const) {
    const { manager, dataDir } = await fixture(t, { now: () => now });
    await installRecord(dataDir, token(), iso(now));
    const state = await manager.state(); assert.equal(state.status, expected); assert.equal(state.canCreate, false);
    assert.equal(state.canViewExport, true); assert.equal(state.license?.seat, 1);
    await rejectsCode(manager.assertWritable(), 'LICENSE_READ_ONLY');
  }
});

test('a minute-bounded admission checkpoint catches significant clock rollback after restart', async t => {
  let now = START + DAY;
  const { manager, dataDir, activationPath } = await fixture(t, { now: () => now }); await manager.activate(token());
  const initial = await readFile(activationPath, 'utf8');
  now += 30_000; await manager.state(); await manager.assertWritable();
  assert.equal(await readFile(activationPath, 'utf8'), initial);
  now += 90_000; await manager.state();
  assert.equal(await readFile(activationPath, 'utf8'), initial, 'state polling must not write time checkpoints');
  await manager.assertWritable();
  assert.equal(JSON.parse(await readFile(activationPath, 'utf8')).observedAt, iso(now));
  await manager.close(); now = START + DAY;
  const restored = new LicenseManager(dataDir, { mode: 'required', deviceCode, publicKeys: { 'test-2026': publicKey }, now: () => now });
  t.after(() => restored.close());
  const state = await restored.state(); assert.equal(state.status, 'clock_rollback'); assert.equal(state.canCreate, false); assert.equal(state.canViewExport, true);
  await rejectsCode(restored.assertWritable(), 'LICENSE_READ_ONLY');
  await rejectsCode(restored.activate(token()), 'LICENSE_CLOCK_ROLLBACK');
  now += 61_000; assert.equal((await restored.state()).status, 'active', 'small clock corrections have a documented tolerance');
});

test('invalid clocks cannot admit writes or accidentally extend signed dates', async t => {
  for (const now of [() => Number.NaN, () => -1, () => 0.5, () => Number.POSITIVE_INFINITY, () => { throw new Error('private clock diagnostics'); }]) {
    const { manager } = await fixture(t, { now });
    const state = await manager.state(); assert.equal(state.status, 'invalid'); assert.equal(state.canCreate, false); assert.equal(state.canViewExport, true);
    assert.equal(JSON.stringify(state).includes('private clock diagnostics'), false);
    await rejectsCode(manager.activate(token()), 'LICENSE_INVALID');
    await rejectsCode(manager.assertWritable(), 'LICENSE_READ_ONLY');
  }
});

test('malformed, oversized or untrusted activation records fail closed without exposing stored content', async t => {
  const cases: Array<[string, string]> = [
    ['{', 'invalid'], ['sensitive-junk'.repeat(1000), 'storage_error'],
    [JSON.stringify({ token: token(payload(), 'unknown'), observedAt: iso(START + DAY) }), 'invalid'],
    [JSON.stringify({ token: token(), observedAt: '2026-02-30T00:00:00.000Z' }), 'invalid'],
    [JSON.stringify({ token: token(), observedAt: iso(START + DAY), publicKeys: { injected: publicKey } }), 'invalid'],
  ];
  for (const [body, expected] of cases) {
    const { manager, dataDir, activationPath } = await fixture(t); await mkdir(join(dataDir, 'licensing'));
    await writeFile(activationPath, body);
    const state = await manager.state(); assert.equal(state.status, expected); assert.equal(state.canCreate, false); assert.equal(state.canViewExport, true);
    assert.equal(state.license, null);
    if (body.length > 10) assert.equal(JSON.stringify(state).includes(body), false);
    await rejectsCode(manager.assertWritable(), 'LICENSE_READ_ONLY');
  }
});

test('licensing directory and activation file must be ordinary contained paths', async t => {
  const { manager, dataDir } = await fixture(t);
  await writeFile(join(dataDir, 'licensing'), 'ordinary file');
  assert.equal((await manager.state()).status, 'storage_error');
  await rejectsCode(manager.activate(token()), 'LICENSE_STORAGE_UNAVAILABLE');
  assert.equal(await readFile(join(dataDir, 'licensing'), 'utf8'), 'ordinary file');
  const second = await fixture(t); await mkdir(second.activationPath, { recursive: true });
  assert.equal((await second.manager.state()).status, 'storage_error');
  await rejectsCode(second.manager.activate(token()), 'LICENSE_STORAGE_UNAVAILABLE');
  assert.deepEqual(await readdir(join(second.dataDir, 'licensing')), ['activation.json']);
});

test('symlinked activation directory or file is never read or overwritten', async t => {
  for (const kind of ['directory', 'file'] as const) {
    const { manager, dataDir, activationPath } = await fixture(t);
    const external = await mkdtemp(join(tmpdir(), 'law-license-outside-'));
    t.after(() => rm(external, { recursive: true, force: true }));
    const target = join(external, 'activation.json'); const original = JSON.stringify({ token: token(), observedAt: iso(START + DAY) });
    await writeFile(target, original);
    try {
      if (kind === 'directory') await symlink(external, join(dataDir, 'licensing'), process.platform === 'win32' ? 'junction' : 'dir');
      else { await mkdir(join(dataDir, 'licensing')); await symlink(target, activationPath, 'file'); }
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Creating file symlinks requires Windows test-host privilege.'); return; }
      throw error;
    }
    assert.equal((await manager.state()).status, 'storage_error');
    await rejectsCode(manager.activate(token()), 'LICENSE_STORAGE_UNAVAILABLE');
    assert.equal(await readFile(target, 'utf8'), original);
    assert.deepEqual(await readdir(external), ['activation.json']);
  }
});

test('concurrent activation is serialized and close drains existing work while blocking new work', async t => {
  const { manager } = await fixture(t);
  const first = token(payload({ seat: 1 })), second = token(payload({ seat: 2 }));
  const a = manager.activate(first), b = manager.activate(second), closing = manager.close();
  assert.equal((await a).license?.seat, 1); assert.equal((await b).license?.seat, 2); await closing;
  await rejectsCode(manager.activate(first), 'LICENSE_CLOSED', first);
  await rejectsCode(manager.assertWritable(), 'LICENSE_CLOSED');
  await rejectsCode(manager.state(), 'LICENSE_CLOSED');
});
