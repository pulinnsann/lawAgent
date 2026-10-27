import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

// Run on the build target. This collects the customer app, never the issuer.
const root = resolve(import.meta.dirname, '..');
const run = promisify(execFile);
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index], value = process.argv[++index];
  if (!['--date', '--portable-zip'].includes(flag) || !value || options[flag]) throw new Error('Usage: node scripts/collect-desktop-installers.mjs [--date YYYYMMDD] [--portable-zip path]');
  options[flag] = value;
}
const date = options['--date'] ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
if (!/^\d{8}$/u.test(date)) throw new Error('The release date must be YYYYMMDD.');
const platform = process.platform, arch = process.arch;
if (!(platform === 'darwin' && arch === 'arm64') && !(platform === 'win32' && arch === 'x64')) throw new Error('Collect on macOS arm64 or Windows x64.');
if (options['--portable-zip'] && platform !== 'win32') throw new Error('The portable ZIP is a Windows artifact.');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const config = JSON.parse(await readFile(join(root, 'native/law-desktop/tauri.conf.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/u.test(version) || config.version !== version || config.identifier !== 'com.lawagent.desktop') throw new Error('Unexpected desktop release identity.');
const target = resolve(process.env.LAW_AGENT_CARGO_TARGET ?? join(root, '.local/rust-target'));
const mac = platform === 'darwin', label = mac ? 'macOS-arm64' : 'Windows-x64';
const folder = join(target, 'release/bundle', mac ? 'dmg' : 'nsis');
const expected = `${config.productName}_${version}_${mac ? 'aarch64.dmg' : 'x64-setup.exe'}`;
if (!(await readdir(folder)).includes(expected)) throw new Error(`Missing current target installer: ${expected}`);
const source = join(folder, expected);
const output = join(root, 'release', `law-agent-${version}-${date}`);
const destinationName = `LawAgent-${version}-${label}${mac ? '.dmg' : '-Setup.exe'}`;
const smokeMarkers = ['desktop_smoke_report', 'LAW_AGENT_SMOKE_SCRIPT', 'LAW_AGENT_SMOKE_SHUTDOWN_DELAY_MS'];
async function regular(path) { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular artifact file.'); return info; }
async function hash(path) { const result = createHash('sha256'); for await (const chunk of createReadStream(path)) result.update(chunk); return result.digest('hex'); }
async function executable(path) {
  await regular(path);
  const bytes = await readFile(path);
  if (mac) {
    if (bytes.length < 12 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) throw new Error('The app is not a native arm64 Mach-O executable.');
  } else {
    if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid Windows executable.');
    const pe = bytes.readUInt32LE(0x3c);
    if (pe + 6 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error('The app is not a Windows x64 executable.');
  }
  if (smokeMarkers.some(marker => bytes.includes(Buffer.from(marker)))) throw new Error('Refusing to distribute a desktop-smoke binary.');
  return { bytes: bytes.length, sha256: await hash(path) };
}
async function windowsIdentity(path) {
  const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); (Get-Item -LiteralPath $env:LAW_AGENT_COLLECT_EXE).VersionInfo | Select-Object ProductVersion,ProductName | ConvertTo-Json -Compress';
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, LAW_AGENT_COLLECT_EXE: path }, windowsHide: true });
  const identity = JSON.parse(stdout.replace(/^\uFEFF/u, '').trim());
  if (![version, `${version}.0`].includes(identity.ProductVersion) || identity.ProductName !== config.productName) throw new Error('Windows artifact version or product identity does not match the app.');
}
async function verifyRuntime(runtime) {
  const manifest = JSON.parse(await readFile(join(runtime, 'runtime-manifest.json'), 'utf8'));
  if (manifest.format !== 'law-agent-tauri-runtime-v1' || manifest.platform !== platform || manifest.arch !== arch || !Array.isArray(manifest.files)) throw new Error('The bundled runtime target does not match the installer.');
  const privatePaths = /(?:^|\/)(?:\.local|license-issuer|credentials|local-knowledge|remote-cache|backups|diagnostics)(?:\/|$)|(?:^|\/)(?:issuer-private\.pem|issuer-identity\.json|licenses\.sqlite(?:[-.].*)?)$/iu;
  const listed = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || isAbsolute(file.path) || file.path.split('/').some(part => part === '..' || part === '.') || privatePaths.test(file.path) || listed.has(file.path)) throw new Error('Unexpected private or unsafe runtime resource.');
    listed.add(file.path);
  }
  const actual = [];
  async function visit(directory, prefix = '') {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), entry = `${prefix}${name}`, info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Unexpected link in the runtime.');
      if (info.isDirectory()) await visit(path, `${entry}/`); else if (info.isFile()) actual.push(entry); else throw new Error('Unexpected runtime entry.');
    }
  }
  await visit(runtime);
  if (actual.some(path => path !== 'runtime-manifest.json' && !listed.has(path)) || listed.size !== actual.length - 1) throw new Error('Unlisted or missing runtime resources.');
  const { stdout } = await run(join(runtime, 'bin', mac ? 'node' : 'node.exe'), [join(root, 'scripts/verify-tauri-resources.mjs'), runtime], { cwd: root, maxBuffer: 2 * 1024 ** 2, windowsHide: true });
  const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
  if (result.passed !== true || result.electronBundled !== false) throw new Error('Packaged runtime validation failed.');
  return { ...result, runtimeManifestSha256: await hash(join(runtime, 'runtime-manifest.json')), privateIssuerPathsIncluded: false };
}
await regular(source);
let native, resources;
if (mac) {
  // Inspect the actual DMG payload, not a potentially newer sibling .app.
  const mount = await mkdtemp(join(tmpdir(), 'lawagent-installer-check-'));
  let mounted = false;
  try {
    await run('/usr/bin/hdiutil', ['attach', source, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount]); mounted = true;
    const bundle = join(mount, `${config.productName}.app`);
    const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')]);
    const info = JSON.parse(stdout);
    if (info.CFBundleIdentifier !== config.identifier || info.CFBundleShortVersionString !== version || info.CFBundleVersion !== version || info.CFBundleExecutable !== 'law-agent-desktop' || info.LSMinimumSystemVersion !== config.bundle.macOS.minimumSystemVersion) throw new Error('The DMG contains an unexpected application version or identity.');
    native = await executable(join(bundle, 'Contents/MacOS/law-agent-desktop'));
    resources = await verifyRuntime(join(bundle, 'Contents/Resources/runtime'));
  } finally {
    if (mounted) await run('/usr/bin/hdiutil', ['detach', mount]);
    await rm(mount, { recursive: true, force: true });
  }
} else {
  const binary = join(target, 'release/law-agent-desktop.exe');
  native = await executable(binary);
  await windowsIdentity(binary); await windowsIdentity(source);
  resources = await verifyRuntime(join(root, '.local/tauri-runtime'));
  if ((await lstat(source)).mtimeMs < (await lstat(binary)).mtimeMs) throw new Error('The installer predates the current executable.');
}
await mkdir(output, { recursive: true });
const artifacts = [];
async function collect(path, name) {
  await regular(path); await copyFile(path, join(output, name));
  const artifact = { file: name, bytes: (await lstat(path)).size, sha256: await hash(join(output, name)) };
  await writeFile(join(output, `${name}.sha256`), `${artifact.sha256}  ${name}\n`); artifacts.push(artifact);
}
await collect(source, destinationName);
if (options['--portable-zip']) {
  const zip = resolve(root, options['--portable-zip']);
  const handle = await open(zip, 'r');
  try {
    const header = Buffer.alloc(4), result = await handle.read(header, 0, 4, 0);
    if (!zip.endsWith('.zip') || result.bytesRead !== 4 || header.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid Windows portable ZIP.');
  } finally { await handle.close(); }
  await collect(zip, `LawAgent-${version}-Windows-x64-Portable.zip`);
}
await writeFile(join(output, `build-manifest-${label}.json`), JSON.stringify({ format: 'law-agent-installer-v1', version, date, platform, arch, native, resources, resourceValidation: mac ? 'actual-read-only-dmg-payload' : 'native-executable-and-nsis-version-resource-plus-build-runtime', artifacts, productionSmokeHooksIncluded: false, commercialCodeSigning: false, notarized: false, customerDataIncluded: false, privateSigningMaterialIncluded: false, physicalWindowsAcceptance: 'pending' }, null, 2) + '\n');
const sums = [];
for (const name of (await readdir(output)).filter(name => /\.(?:dmg|exe|zip)$/u.test(name)).sort()) sums.push(`${await hash(join(output, name))}  ${name}`);
await writeFile(join(output, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
await writeFile(join(output, 'INSTALL.txt'), `LawAgent ${version} — test installers\n\nmacOS (Apple Silicon M series): macOS 13.5 or newer. Open the DMG and drag\nthe app to Applications, then launch it. Intel Macs are not supported by\nthis arm64 package.\n\nWindows x64: Windows 10 or newer. Run the Setup.exe installer. Microsoft\nWebView2 is required; setup may need internet access to download Microsoft's\nbootstrapper when WebView2 is missing. The optional Portable.zip must be\nextracted in full before opening the app. Do not remove its runtime folder.\n\nNo separate Node.js, Rust or development environment installation is needed.\nA model connection (local or remote API) is configured inside the app.\n\nActivation: official builds require a device-bound license. Open the app's\nUse authorization page, copy this computer's information, and send it to\nthe person issuing your license. Paste the issued license to activate.\nThe trial lasts 90 days; expired licenses can view/export existing data but\ncannot start new reviews or contract generation. The issuer app, private\nsigning key and issuance ledger are not included in this customer package.\n\nProblem reports: choose Export problem log in the sidebar, then Save log\nfile. Send the resulting .log file to your support contact. Logs stay local\nuntil you choose to share them; contract text, model keys and activation\ncodes are excluded. In Chinese these buttons are 导出问题日志 / 保存日志文件.\n\nThese test installers are not commercially code signed. The macOS package\nis not notarized, and Windows may show a publisher/reputation warning.\nVerify the source and SHA-256 checksum before installation. If your device\nor company policy blocks installation, ask your administrator or contact\nthe distributor for a signed package. Do not disable security protections.\n\nSHA256SUMS.txt and individual .sha256 files accompany the installers.\nExisting customer data is not included. Back up your workspace before an\nupgrade. Installer creation and resource checks do not certify Windows\n8 GB performance, legal correctness, or multilingual lawyer acceptance.\n`);
console.log(JSON.stringify({ releaseDirectory: relative(root, output).replaceAll('\\', '/'), version, platform, arch, artifacts }));
