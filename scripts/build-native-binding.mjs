import { spawn } from 'node:child_process';
import { mkdir, copyFile, stat, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.length) throw new Error('Build the binding on the target operating system and architecture; no cross-platform binary fallback is permitted.');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, 'scripts/native-core.mjs'), 'build', '-p', 'law-agent-node', '--release', '--locked'], { cwd: root, stdio: 'inherit', shell: false });
  child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Native binding build failed (${code})`)));
});
const target = process.env.LAW_AGENT_CARGO_TARGET ?? join(root, '.local', 'rust-target');
const library = process.platform === 'win32' ? 'law_agent_node.dll' : process.platform === 'darwin' ? 'liblaw_agent_node.dylib' : 'liblaw_agent_node.so';
const destination = join(root, '.local', 'native', `law-agent-store-${process.platform}-${process.arch}.node`);
await mkdir(join(root, '.local', 'native'), { recursive: true });
const temporary = `${destination}.${randomUUID()}.tmp`;
try { await copyFile(join(target, 'release', library), temporary); await rename(temporary, destination); }
catch (cause) { throw new Error('Native binding publication failed. Close any running development app before rebuilding a loaded Windows library.', { cause }); }
finally { await rm(temporary, { force: true }); }
const bytes = await readFile(destination);
await writeFile(`${destination}.json`, `${JSON.stringify({ platform: process.platform, arch: process.arch, bytes: (await stat(destination)).size, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2)}\n`);
console.log(`Built ${destination}`);
