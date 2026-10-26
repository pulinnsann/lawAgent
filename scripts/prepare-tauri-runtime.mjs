import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, mkdir, rm, cp, copyFile, chmod, realpath, stat, writeFile, rename } from 'node:fs/promises';
import { relative, resolve, join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensureNodeRuntime, nodeVersion } from './ensure-node-runtime.mjs';
import { generateNativeNotices } from './generate-native-notices.mjs';

const root = resolve(import.meta.dirname, '..');
const published = join(root, '.local/tauri-runtime');
const destination = `${published}.${randomUUID()}.tmp`;
const portableNode = await ensureNodeRuntime();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// npm's production dependency closure includes native Canvas, OCR and PDF assets.
// No Electron, browser binary, developer tool or customer workspace is copied.
const { stdout } = await promisify(execFile)(npm, ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, maxBuffer: 16 * 1024 ** 2, shell: process.platform === 'win32' });
const paths = [...new Set(stdout.trim().split(/\r?\n/u).filter(Boolean))].filter(path => path !== root);
for (const path of paths) { const rel = relative(join(root, 'node_modules'), path); if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('Dependency outside the project module tree.'); }
await mkdir(destination, { recursive: true });
await rm(join(destination, 'backend'), { recursive: true, force: true });
await cp(join(root, 'out/desktop'), join(destination, 'backend'), { recursive: true });
await writeFile(join(destination, 'package.json'), JSON.stringify({ name: 'law-agent-desktop-runtime', private: true, type: 'module' }) + '\n');
await mkdir(join(destination, 'native'), { recursive: true });
const binding = `law-agent-store-${process.platform}-${process.arch}.node`;
for (const name of [binding, `${binding}.json`]) await copyFile(join(root, '.local/native', name), join(destination, 'native', name));
await mkdir(join(destination, 'bin'), { recursive: true });
const nodePath = join(destination, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
await copyFile(portableNode, nodePath);
await copyFile(resolve(portableNode, '..', 'LICENSE'), join(destination, 'bin/LICENSE'));
await copyFile(resolve(portableNode, '..', 'manifest.json'), join(destination, 'bin/manifest.json'));
if (process.platform !== 'win32') await chmod(nodePath, 0o755);
// Build into a fresh dependency directory to avoid stale optional platform binaries.
await rm(join(destination, 'node_modules'), { recursive: true, force: true });
for (const path of paths) {
  const rel = relative(root, path);
  await mkdir(resolve(destination, rel, '..'), { recursive: true });
  await cp(path, join(destination, rel), { recursive: true, dereference: true, filter: source => !source.includes('/node_modules/.cache/') });
}
await mkdir(join(destination, 'licenses'), { recursive: true });
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(join(root, name), join(destination, 'licenses', name));
await generateNativeNotices(join(destination, 'licenses/native-dependencies.md'));
try { await copyFile(join(root, 'native/law-desktop/platform/fonts/OFL.txt'), join(destination, 'licenses/NotoSansThai-OFL.txt')); } catch(error) { if(error.code !== 'ENOENT') throw error; }
const files = [];
async function inventory(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await inventory(path);
    else { const bytes = await readFile(path); files.push({ path: relative(destination, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
  }
}
await inventory(destination);
await writeFile(join(destination, 'runtime-manifest.json'), JSON.stringify({ format: 'law-agent-tauri-runtime-v1', platform: process.platform, arch: process.arch, node: nodeVersion, files }, null, 2) + '\n');
const previous = `${published}.${randomUUID()}.previous`;
let moved = false;
try { await rename(published, previous); moved = true; } catch(error) { if(error.code !== 'ENOENT') throw error; }
try { await rename(destination, published); } catch(error) { if(moved) await rename(previous, published); throw error; }
if(moved) await rm(previous, { recursive: true, force: true });
console.log(JSON.stringify({ runtime: '.local/tauri-runtime', platform: process.platform, arch: process.arch, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), electronBundled: false }));
