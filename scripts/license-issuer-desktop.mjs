import { access, copyFile, mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { generateNativeNotices } from './generate-native-notices.mjs';

const root = resolve(import.meta.dirname, '..');
const native = join(root, 'native/license-issuer');
let cargo = process.env.LAW_AGENT_CARGO, rustc = process.env.RUSTC;
const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
if (!cargo) {
  const candidate = join(homedir(), '.cargo/bin', exe);
  try { await access(candidate); cargo = candidate; } catch {}
}
if (!cargo) {
  for (const name of (await readdir(join(homedir(), '.rustup/toolchains')).catch(() => [])).filter(name => name.startsWith('stable')).sort()) {
    const candidate = join(homedir(), '.rustup/toolchains', name, 'bin', exe);
    try { await access(candidate); cargo = candidate; rustc ??= join(dirname(candidate), process.platform === 'win32' ? 'rustc.exe' : 'rustc'); break; } catch {}
  }
}
const cache = process.env.LAW_AGENT_CARGO_CACHE ?? join(root, '.local/rust-cargo');
const target = process.env.LAW_AGENT_CARGO_TARGET ?? join(root, '.local/rust-target');
await mkdir(cache, { recursive: true }); await mkdir(target, { recursive: true });
const env = { ...process.env, CARGO_HOME: cache, CARGO_TARGET_DIR: target, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
if (cargo) env.PATH = `${dirname(cargo)}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`;
if (rustc) { env.RUSTC = rustc; env.RUSTDOC = join(dirname(rustc), process.platform === 'win32' ? 'rustdoc.exe' : 'rustdoc'); }
const run = (command, args, cwd) => new Promise((done, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
  child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`Issuer build exited ${code ?? signal}.`)));
});
const args = process.argv.slice(2);
if (!args.length) args.push('dev');
if (args[0] === 'build' && !args.includes('--')) args.push('--', '--locked');
// A DMG does not need Finder automation to install. Skip cosmetic AppleScript
// so packaging also works on unattended hosts without an Automation prompt.
if (args[0] === 'build') { env.CI = 'true'; env.TAURI_BUNDLER_DMG_IGNORE_CI = 'false'; }
try {
  // Only public assets are build inputs; signing data is never bundled.
  await run(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', join(root, 'assets/license-issuer-icon.svg'), '--output', join(native, 'icons')], root);
  const notices = join(root, '.local/license-issuer-notices');
  await mkdir(notices, { recursive: true });
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(join(root, file), join(notices, file));
  await generateNativeNotices(join(notices, 'native-dependencies.md'));
  if (args[0] !== 'prepare') await run(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...args], native);
  if (args[0] === 'build' && args.includes('--bundles') && !args.includes('--no-bundle')) {
    await run(process.execPath, [join(root, 'scripts/collect-license-issuer-installer.mjs')], root);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
