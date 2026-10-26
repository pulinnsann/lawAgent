import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const files = ['Cargo.toml', 'Cargo.lock', 'native/law-node/Cargo.toml', 'native/law-node/build.rs'];
async function sources(directory) { for (const entry of await readdir(join(root, directory), { withFileTypes: true })) { const name = `${directory}/${entry.name}`; if (entry.isDirectory()) await sources(name); else if (entry.isFile() && name.endsWith('.rs')) files.push(name); } }
await sources('native/law-node/src');
const fingerprint = createHash('sha256').update(`${process.platform}-${process.arch}`);
for (const name of files.sort()) fingerprint.update(name).update(await readFile(join(root, name)));
const sourceSha256 = fingerprint.digest('hex');
const binary = join(root, '.local', 'native', `law-agent-store-${process.platform}-${process.arch}.node`);
let current = false;
try { const metadata = JSON.parse(await readFile(`${binary}.json`, 'utf8')); const bytes = await readFile(binary); current = metadata.sourceSha256 === sourceSha256 && metadata.sha256 === createHash('sha256').update(bytes).digest('hex'); } catch { /* First build or stale binding. */ }
if (!current) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/build-native-binding.mjs')], { cwd: root, stdio: 'inherit', shell: false });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Native storage build failed (${code})`)));
  });
  const metadata = JSON.parse(await readFile(`${binary}.json`, 'utf8'));
  await writeFile(`${binary}.json`, `${JSON.stringify({ ...metadata, sourceSha256 }, null, 2)}\n`);
}
