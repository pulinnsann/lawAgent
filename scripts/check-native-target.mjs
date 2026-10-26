import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const targetPlatform = process.argv[2] ?? process.platform;
const targetArch = process.argv[3] ?? process.arch;
if (!['win32-x64', 'darwin-arm64', 'darwin-x64'].includes(`${targetPlatform}-${targetArch}`)) throw new Error('Unsupported desktop native target.');
const path = join(root, '.local', 'native', `law-agent-store-${targetPlatform}-${targetArch}.node`);
try {
  const bytes = await readFile(path); const metadata = JSON.parse(await readFile(`${path}.json`, 'utf8'));
  if (metadata.platform !== targetPlatform || metadata.arch !== targetArch || metadata.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Native binding metadata/hash mismatch.');
  if (targetPlatform === 'win32' && bytes.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('Expected a Windows native binding.');
  if (targetPlatform === 'darwin' && !['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(bytes.subarray(0, 4).toString('hex'))) throw new Error('Expected a macOS native binding.');
} catch (cause) { throw new Error(`Build the ${targetPlatform}/${targetArch} Rust storage binding on its target toolchain before packaging. The Windows manual workflow builds it on Windows.`, { cause }); }
console.log(`Native target verified: ${targetPlatform}/${targetArch}`);
