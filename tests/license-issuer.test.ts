import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { LicenseIssuer, LicenseIssuerError, type IssuerErrorCode, type LicenseIssuerOptions } from '../tools/license-issuer/issuer';
import { LicenseManager } from '../src/core/license-manager';
import { LICENSE_TRIAL_MILLISECONDS } from '../src/shared/licensing';

const at = Date.parse('2026-10-26T03:00:00.000Z');
const keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const otherPublic = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const device = (n: number) => 'LAWDEV1-' + n.toString(16).padStart(64, '0');
const invoke = promisify(execFile);
const skipWindows = process.platform === 'win32' ? { skip: 'Windows signing requires independently qualified owner-only ACL verification.' } : {};
function code(action: () => unknown, expected: IssuerErrorCode, secret?: string) {
  assert.throws(action, error => {
    assert.ok(error instanceof LicenseIssuerError); assert.equal(error.code, expected);
    if (secret) { assert.equal(error.message.includes(secret), false); assert.equal(error.stack?.includes(secret), false); assert.equal(JSON.stringify(error).includes(secret), false); }
    return true;
  });
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'law-issuer-test-'));
  const directory = join(root, 'issuer'), privateKeyPath = join(root, 'ephemeral-private.pem');
  await writeFile(privateKeyPath, privatePem, { mode: 0o600 });
  const options: LicenseIssuerOptions = { directory, privateKeyPath, expectedPublicKeys: { 'test-issuer': publicPem }, kid: 'test-issuer', now: () => at };
  const opened: LicenseIssuer[] = [];
  const open = (patch: Partial<LicenseIssuerOptions> = {}) => { const issuer = new LicenseIssuer({ ...options, ...patch }); opened.push(issuer); return issuer; };
  t.after(async () => { for (const issuer of opened) issuer.close(); await rm(root, { recursive: true, force: true }); });
  return { root, options, open };
}

test('issuer signs a single-device exact 90-day token accepted by the real client verifier', skipWindows, async t => {
  const { open, root, options } = await fixture(t); const issuer = open();
  assert.deepEqual(issuer.state(), { limit: 100, issued: 0, remaining: 100, keyId: 'test-issuer', publicKeySha256: issuer.state().publicKeySha256, licenses: [] });
  assert.match(issuer.state().publicKeySha256, /^[a-f0-9]{64}$/u);
  const issued = issuer.issue({ deviceCode: device(1) });
  assert.equal(issued.seat, 1); assert.equal(issued.startsAt, new Date(at).toISOString());
  assert.equal(Date.parse(issued.expiresAt) - Date.parse(issued.startsAt), LICENSE_TRIAL_MILLISECONDS);
  const data = join(root, 'client'); await mkdir(data);
  const manager = new LicenseManager(data, { mode: 'required', deviceCode: device(1), publicKeys: options.expectedPublicKeys, now: () => at });
  t.after(() => manager.close());
  assert.equal((await manager.activate(issued.token)).status, 'active'); await manager.assertWritable();
  const state = issuer.state(); assert.equal(state.issued, 1); assert.equal(state.remaining, 99);
  assert.equal(JSON.stringify(state).includes(issued.token), false); assert.equal(JSON.stringify(state).includes('PRIVATE KEY'), false);
  assert.deepEqual(state.licenses[0], Object.fromEntries(Object.entries(issued).filter(([key]) => key !== 'token')));
  assert.equal((await stat(join(options.directory, 'licenses.sqlite'))).mode & 0o777, 0o600);
  assert.equal((await stat(options.directory)).mode & 0o777, 0o700);
});

test('exactly 100 trials can be issued, every token verifies, and the 101st consumes no seat', skipWindows, async t => {
  const { open, root, options } = await fixture(t); const issuer = open();
  for (let n = 1; n <= 100; n++) {
    const issued = issuer.issue({ deviceCode: device(n) }); assert.equal(issued.seat, n);
    const data = join(root, `client-${n}`); await mkdir(data);
    const manager = new LicenseManager(data, { mode: 'required', deviceCode: device(n), publicKeys: options.expectedPublicKeys, now: () => at });
    try { assert.equal((await manager.activate(issued.token)).status, 'active'); } finally { await manager.close(); }
  }
  const before = issuer.state(); assert.equal(before.remaining, 0); assert.equal(new Set(before.licenses.map(x => x.licenseId)).size, 100);
  code(() => issuer.issue({ deviceCode: device(101) }), 'ISSUER_LIMIT'); assert.deepEqual(issuer.state(), before);
});

test('one trial per device survives restart; retrieving its token does not reissue or extend it', skipWindows, async t => {
  const { open } = await fixture(t); const issuer = open(); const issued = issuer.issue({ deviceCode: device(1) }); issuer.close();
  const restored = open({ now: () => at + LICENSE_TRIAL_MILLISECONDS + 1 });
  assert.equal(restored.getToken(issued.licenseId), issued.token);
  code(() => restored.issue({ deviceCode: device(1) }), 'ISSUER_DUPLICATE_DEVICE');
  assert.equal(restored.state().issued, 1); assert.equal(restored.state().licenses[0].expiresAt, issued.expiresAt);
  code(() => restored.getToken(randomUUID()), 'ISSUER_NOT_FOUND'); code(() => restored.getToken('../sensitive-query'), 'ISSUER_NOT_FOUND', '../sensitive-query');
});

test('start time accepts bounded future UTC but rejects past, malformed or excessive dates without consuming a seat', skipWindows, async t => {
  const { open } = await fixture(t); const issuer = open();
  for (const startsAt of ['2026-10-26', '2026-10-26T03:00:00+00:00', '2026-02-30T03:00:00.000Z', new Date(at - 1).toISOString(), new Date(at + 366 * 86400000).toISOString()]) code(() => issuer.issue({ deviceCode: device(1), startsAt }), 'ISSUER_INPUT');
  for (const input of [null, [], { deviceCode: device(0xab).toUpperCase() }, { deviceCode: device(1), publicKey: 'injected-key' }, { deviceCode: device(1), seat: 101 }]) code(() => issuer.issue(input as { deviceCode: string }), 'ISSUER_INPUT');
  assert.equal(issuer.state().issued, 0);
  const future = at + 365 * 86400000; const issued = issuer.issue({ deviceCode: device(1), startsAt: new Date(future).toISOString() });
  assert.equal(Date.parse(issued.startsAt), future); assert.equal(Date.parse(issued.expiresAt), future + LICENSE_TRIAL_MILLISECONDS);
});

test('private key must be Ed25519, owned ordinary 0600, and match the pinned key before ledger creation', skipWindows, async t => {
  const { open, options } = await fixture(t);
  code(() => open({ expectedPublicKeys: { 'test-issuer': otherPublic } }), 'ISSUER_KEY', privatePem);
  code(() => open({ expectedPublicKeys: { 'test-issuer': privatePem } }), 'ISSUER_KEY', privatePem);
  code(() => open({ kid: 'unknown' }), 'ISSUER_KEY');
  await chmod(options.privateKeyPath, 0o644); code(() => open(), 'ISSUER_KEY', privatePem);
  await chmod(options.privateKeyPath, 0o600); await writeFile(options.privateKeyPath, 'SENSITIVE_PRIVATE_KEY_PARSE_ERROR');
  code(() => open(), 'ISSUER_KEY', 'SENSITIVE_PRIVATE_KEY_PARSE_ERROR');
  await writeFile(options.privateKeyPath, privatePem); assert.equal(open().state().issued, 0);
});

test('ledger rejects a different signing-key fingerprint, unknown schemas, missing metadata and corrupted tokens', skipWindows, async t => {
  const { open, options, root } = await fixture(t); const issuer = open(); const issued = issuer.issue({ deviceCode: device(1) }); issuer.close();
  const alternative = join(root, 'other-private.pem'); await writeFile(alternative, other.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  code(() => open({ privateKeyPath: alternative, expectedPublicKeys: { 'test-issuer': otherPublic } }), 'ISSUER_LEDGER');
  const db = new DatabaseSync(join(options.directory, 'licenses.sqlite')); db.prepare('UPDATE licenses SET token=? WHERE license_id=?').run('sensitive-invalid-token', issued.licenseId); db.close();
  code(() => open(), 'ISSUER_LEDGER', 'sensitive-invalid-token');
  for (const schema of ['', 'CREATE TABLE unknown_table(x)']) {
    const unknown = join(root, 'unknown-' + randomUUID()); await mkdir(unknown, { mode: 0o700 });
    const path = join(unknown, 'licenses.sqlite'); await writeFile(path, '', { mode: 0o600 });
    if (schema) { const otherDb = new DatabaseSync(path); otherDb.exec(schema); otherDb.close(); }
    code(() => open({ directory: unknown }), 'ISSUER_LEDGER');
  }
});

test('failed durable commit rolls back the inserted license and preserves the next free seat', skipWindows, async t => {
  const { open } = await fixture(t); const issuer = open();
  // Inject a disk/commit failure after INSERT, without changing public API or
  // persisting a malicious trigger into the ledger schema.
  const internal = issuer as unknown as { db: DatabaseSync }; const original = internal.db.exec.bind(internal.db); let fail = true;
  internal.db.exec = sql => { if (sql === 'COMMIT' && fail) { fail = false; throw new Error('synthetic private disk diagnostics'); } return original(sql); };
  code(() => issuer.issue({ deviceCode: device(1) }), 'ISSUER_LEDGER', 'synthetic private disk diagnostics');
  assert.equal(issuer.state().issued, 0); assert.equal(issuer.issue({ deviceCode: device(1) }).seat, 1);
});

test('lost ledger, missing identity and incomplete initialization never silently reset the counter', skipWindows, async t => {
  for (const missing of ['licenses.sqlite', 'issuer-identity.json']) {
    const { open, options } = await fixture(t); const issuer = open(); issuer.issue({ deviceCode: device(1) }); issuer.close();
    const retained = missing === 'licenses.sqlite' ? 'issuer-identity.json' : 'licenses.sqlite';
    const before = await readFile(join(options.directory, retained));
    await rm(join(options.directory, missing));
    code(() => open(), 'ISSUER_LEDGER');
    assert.deepEqual(await readFile(join(options.directory, retained)), before);
    await assert.rejects(stat(join(options.directory, missing)), { code: 'ENOENT' });
  }
  const { open, options } = await fixture(t); const issuer = open(); issuer.close();
  await writeFile(join(options.directory, 'licenses.sqlite'), '');
  code(() => open(), 'ISSUER_LEDGER');
  assert.equal((await stat(join(options.directory, 'licenses.sqlite'))).size, 0);
});

test('identity marker is owner-only, bounded and fingerprint-bound, and cannot redirect to an outside file', skipWindows, async t => {
  for (const invalid of ['{', 'x'.repeat(1025), JSON.stringify({ version: 1, keyId: 'test-issuer', publicKeySha256: '0'.repeat(64) })]) {
    const { open, options } = await fixture(t); const issuer = open(); issuer.close();
    const path = join(options.directory, 'issuer-identity.json'); assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writeFile(path, invalid); code(() => open(), 'ISSUER_LEDGER', invalid.length > 10 ? invalid : undefined);
  }
  const { open, options, root } = await fixture(t); const issuer = open(); issuer.close();
  const path = join(options.directory, 'issuer-identity.json'), outside = join(root, 'marker-sentinel');
  await writeFile(outside, 'preserve external identity', { mode: 0o600 }); await rm(path); await symlink(outside, path);
  code(() => open(), 'ISSUER_LEDGER'); assert.equal(await readFile(outside, 'utf8'), 'preserve external identity');
});

test('separate simultaneous processes share one atomic capacity limit and unique seats', skipWindows, async t => {
  const { open, options } = await fixture(t); const issuer = open();
  for (let n = 1; n <= 94; n++) issuer.issue({ deviceCode: device(n) });
  const url = pathToFileURL(join(process.cwd(), 'tools/license-issuer/issuer.ts')).href;
  const run = async (offset: number) => {
    const source = `import {LicenseIssuer} from ${JSON.stringify(url)};const issuer=new LicenseIssuer(${JSON.stringify({ ...options, now: undefined })});let issued=0,limited=0;for(let n=${offset};n<${offset + 8};n++){try{issuer.issue({deviceCode:'LAWDEV1-'+n.toString(16).padStart(64,'0')});issued++;}catch(error){if(error.code!=='ISSUER_LIMIT')throw error;limited++;}}issuer.close();process.stdout.write(JSON.stringify({issued,limited}));`;
    const result = await invoke(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], { cwd: process.cwd(), timeout: 20000, maxBuffer: 8192 });
    assert.equal(result.stderr.includes('PRIVATE KEY'), false); return JSON.parse(result.stdout) as { issued: number; limited: number };
  };
  const results = await Promise.all([run(200), run(300)]);
  assert.equal(results.reduce((n, r) => n + r.issued, 0), 6); assert.equal(results.reduce((n, r) => n + r.limited, 0), 10);
  assert.equal(issuer.state().issued, 100); assert.deepEqual(issuer.state().licenses.map(r => r.seat), Array.from({ length: 100 }, (_, i) => i + 1));
});

test('symlinked key, ledger, directory or SQLite sidecar is rejected without touching outside data', skipWindows, async t => {
  for (const kind of ['key', 'ledger', 'directory', 'sidecar']) {
    const { open, options, root } = await fixture(t); const outside = join(root, 'outside'); await mkdir(outside, { mode: 0o700 });
    const sentinel = join(outside, 'sentinel'); await writeFile(sentinel, 'preserve me', { mode: 0o600 });
    if (kind === 'key') { const link = join(root, 'linked-private.pem'); await symlink(options.privateKeyPath, link); code(() => open({ privateKeyPath: link }), 'ISSUER_KEY'); }
    else if (kind === 'directory') { await symlink(outside, options.directory, 'dir'); code(() => open(), 'ISSUER_LEDGER'); }
    else { await mkdir(options.directory, { mode: 0o700 }); if (kind === 'ledger') await symlink(sentinel, join(options.directory, 'licenses.sqlite')); else { const issuer = open(); issuer.close(); await symlink(sentinel, join(options.directory, 'licenses.sqlite-journal')); } code(() => open(), 'ISSUER_LEDGER'); }
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve me');
  }
});

test('issuer rejects invalid clocks and closes without retaining an accessible signer', skipWindows, async t => {
  const { open } = await fixture(t);
  for (const now of [() => NaN, () => Infinity, () => -1, () => 0.5, () => { throw new Error('sensitive clock diagnostics'); }]) {
    const issuer = open({ now }); code(() => issuer.issue({ deviceCode: device(1) }), 'ISSUER_INPUT', 'sensitive clock diagnostics'); assert.equal(issuer.state().issued, 0); issuer.close();
  }
  const issuer = open(); issuer.close(); issuer.close();
  code(() => issuer.state(), 'ISSUER_CLOSED'); code(() => issuer.issue({ deviceCode: device(1) }), 'ISSUER_CLOSED'); code(() => issuer.getToken(randomUUID()), 'ISSUER_CLOSED');
});

test('macOS extended ACL grants are rejected even when ordinary mode bits remain 0600/0700', { skip: process.platform !== 'darwin' }, async t => {
  for (const target of ['key', 'directory', 'ledger', 'marker'] as const) {
    const { open, options } = await fixture(t);
    const issuer = open(); issuer.close();
    const path = target === 'key' ? options.privateKeyPath : target === 'directory' ? options.directory : join(options.directory, target === 'ledger' ? 'licenses.sqlite' : 'issuer-identity.json');
    try {
      // This ACL is added only to an ephemeral test fixture and removed in
      // finally; the signer never changes any permission or invokes a shell.
      await invoke('/bin/chmod', ['+a', 'everyone allow read', path]);
      assert.equal((await stat(path)).mode & 0o777, target === 'directory' ? 0o700 : 0o600);
      code(() => open(), 'ISSUER_PERMISSIONS', privatePem);
    } finally { await invoke('/bin/chmod', ['-N', path]); }
    assert.equal(open().state().issued, 0, 'ACL rejection must not alter the ledger');
  }
});
