import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = process.env.LAW_AGENT_CARGO_TARGET ?? join(root, '.local/rust-target');
const output = join(root, 'release/license-issuer');
const platform = process.platform;
if (!['darwin', 'win32'].includes(platform)) throw new Error('Collect this installer on macOS or Windows.');
const folder = join(target, 'release/bundle', platform === 'darwin' ? 'dmg' : 'nsis');
const extension = platform === 'darwin' ? '.dmg' : '.exe';
const files = (await readdir(folder)).filter(name => name.startsWith('LawAgent License Issuer_0.1.0_') && name.endsWith(extension));
if (files.length !== 1) throw new Error('Expected exactly one versioned issuer installer.');
if (platform === 'darwin') {
  const bundle = join(target, 'release/bundle/macos/LawAgent License Issuer.app');
  const inventory = [];
  async function visit(directory, prefix = '') {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), relative = prefix + name, stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('Unexpected link in issuer bundle.');
      if (stat.isDirectory()) await visit(path, `${relative}/`); else inventory.push(relative);
    }
  }
  await visit(bundle);
  const allowed = new Set(['Contents/Info.plist', 'Contents/MacOS/law-license-issuer', 'Contents/Resources/icon.icns', 'Contents/_CodeSignature/CodeResources', 'Contents/PkgInfo', 'Contents/Resources/licenses/LICENSE', 'Contents/Resources/licenses/THIRD_PARTY_NOTICES.md', 'Contents/Resources/licenses/native-dependencies.md']);
  if (inventory.some(name => !allowed.has(name))) throw new Error('Unexpected resource in issuer bundle; do not distribute.');
  const info = await readFile(join(bundle, 'Contents/Info.plist'), 'utf8');
  if (!info.includes('com.lawagent.license-issuer')) throw new Error('Incorrect issuer application identifier.');
  const executable = await readFile(join(bundle, 'Contents/MacOS/law-license-issuer'));
  if (executable.includes(Buffer.from('Ephemeral issuer diagnostic failed.'))) throw new Error('Do not distribute a diagnostic binary.');
}
const source = join(folder, files[0]);
if (!(await lstat(source)).isFile() || (await lstat(source)).isSymbolicLink()) throw new Error('Invalid installer artifact.');
const bytes = await readFile(source);
const packagedArch = files[0].match(/_(aarch64|x64|universal)(?:-setup)?\.(?:dmg|exe)$/u)?.[1];
if (!packagedArch) throw new Error('Unrecognized installer architecture.');
const arch = packagedArch === 'aarch64' ? 'arm64' : packagedArch;
const file = `LawAgent-License-Issuer-0.1.0-${platform === 'darwin' ? 'mac' : 'windows'}-${arch}${extension}`;
await mkdir(output, { recursive: true });
await copyFile(source, join(output, file));
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(join(output, `${file}.sha256`), `${sha256}  ${file}\n`);
await writeFile(join(output, 'INSTALL.txt'), `LawAgent License Issuer 0.1.0\n\nAdministrator utility only. Do not send signing material to customers.\n\nmacOS: open the DMG, drag the app to Applications, then launch it.\nWindows: run the NSIS setup executable when a Windows artifact is available.\n\nChoose your original issuance directory containing issuer-private.pem,\nlicenses.sqlite and issuer-identity.json. An empty directory cannot issue\nlicenses. Retain and back up this one directory across updates. The installer\ncontains no private signing key or ledger. The app needs no Node installation.\n\nPolicy: at most 100 trials through the retained ledger, one device each,\n90 days from the signed start time. Retrieve original codes through history.\n\nCurrent local macOS package is unsigned and not notarized. Windows installer\ncompilation and execution require a Windows build/acceptance environment.\n\nFull instructions: docs/en/license-issuer-desktop.md in the source repository.\n`);
console.log(JSON.stringify({ artifact: `release/license-issuer/${file}`, bytes: bytes.length, sha256, signingMaterialIncluded: false }));
