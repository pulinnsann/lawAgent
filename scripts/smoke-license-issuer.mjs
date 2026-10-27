import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { LicenseIssuer } from '../tools/license-issuer/issuer.ts';
import { LicenseManager } from '../src/core/license-manager.ts';

// No official signing material is read or written by this probe.
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'law-issuer-interop-'));
const now = Date.parse('2026-10-27T00:00:00.000Z');
const kid = 'lawagent-trial-v1';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const run = (executable, args, input, env = process.env) => new Promise((done, reject) => {
  const child = spawn(executable, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = []; let size = 0;
  const timer = setTimeout(() => { child.kill(); reject(new Error('Ephemeral issuer diagnostic timed out.')); }, 180_000);
  child.stdout.on('data', chunk => { size += chunk.length; if (size > 65_536) child.kill(); else output.push(chunk); });
  child.stderr.resume(); child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? done(Buffer.concat(output).toString('utf8')) : reject(new Error('Ephemeral issuer process failed.')); });
  child.stdin.end(input ?? '');
});
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let issuer, verifier;
try {
  await writeFile(join(directory, 'issuer-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const options = { directory, privateKeyPath: join(directory, 'issuer-private.pem'), expectedPublicKeys: { [kid]: publicPem }, kid, now: () => now };
  issuer = new LicenseIssuer(options);
  const first = issuer.issue({ deviceCode: `LAWDEV1-${'1'.repeat(64)}` });
  issuer.close(); issuer = undefined;
  await run(process.execPath, ['scripts/native-core.mjs', 'build', '-p', 'law-license-issuer', '--bin', 'issuer-diagnostic', '--features', 'issuer-smoke', '--locked']);
  const target = process.env.LAW_AGENT_CARGO_TARGET ?? join(root, '.local/rust-target');
  const executable = join(target, 'debug', `issuer-diagnostic${process.platform === 'win32' ? '.exe' : ''}`);
  const deviceCode = `LAWDEV1-${'2'.repeat(64)}`;
  const result = JSON.parse(await run(executable, [], JSON.stringify({ directory, publicKeyPem: publicPem, nowMs: now, deviceCode })));
  assert(result.before.issued === 1 && result.after.issued === 2 && result.issued.license.seat === 2, 'Rust must continue the existing Node ledger.');
  await mkdir(join(directory, 'client'), { mode: 0o700 });
  verifier = new LicenseManager(join(directory, 'client'), { mode: 'required', deviceCode, publicKeys: { [kid]: publicPem }, now: () => now });
  const state = await verifier.activate(result.issued.token);
  assert(state.status === 'active' && state.canCreate, 'The actual client must accept the Rust-signed license.');
  issuer = new LicenseIssuer(options);
  assert(issuer.state().issued === 2 && issuer.getToken(first.licenseId) === first.token && issuer.getToken(result.issued.license.licenseId) === result.issued.token, 'Node must read both original and Rust-signed licenses.');
  const third = issuer.issue({ deviceCode: `LAWDEV1-${'3'.repeat(64)}` });
  assert(third.seat === 3, 'Node must continue Rust issuance without resetting inventory.');
  console.log(JSON.stringify({ passed: true, nodeToRustLedger: true, rustToClientActivation: true, rustToNodeLedger: true, originalTokenPreserved: true, officialSeatsConsumed: 0 }));
} finally {
  issuer?.close(); await verifier?.close(); await rm(directory, { recursive: true, force: true });
}
