import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, rename, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const nodeVersion = '24.22.1';
const nodeLicenseSha256 = '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace';
// SHA256 values from https://nodejs.org/dist/v24.22.1/SHASUMS256.txt.
// Pin the release and digest; builds never silently select a newer runtime.
const releases = {
  'darwin-arm64': { file: `node-v${nodeVersion}-darwin-arm64.tar.gz`, sha256: '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7' },
  'darwin-x64': { file: `node-v${nodeVersion}-darwin-x64.tar.gz`, sha256: 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035' },
  'win32-x64': { file: 'win-x64/node.exe', sha256: 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5' },
  'win32-arm64': { file: 'win-arm64/node.exe', sha256: '8bea91dc437fe01e7d92ef0efc6c9eaf654369aaba9b2d3e9841552ea7b95a00' },
};
export async function ensureNodeRuntime() {
  const root = resolve(import.meta.dirname, '..');
  const release = releases[`${process.platform}-${process.arch}`];
  if (!release) throw new Error('Build the Tauri runtime on a supported Windows or macOS target.');
  const directory = join(root, '.local/node-runtime', `v${nodeVersion}-${process.platform}-${process.arch}`);
  const executable = join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  try {
    const metadata = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const bytes = await readFile(executable);
    if (metadata.releaseSha256 === release.sha256 && metadata.binarySha256 === createHash('sha256').update(bytes).digest('hex') && createHash('sha256').update(await readFile(join(directory, 'LICENSE'))).digest('hex') === nodeLicenseSha256) return executable;
  } catch {}
  const stage = `${directory}.${randomUUID()}.tmp`;
  await mkdir(stage, { recursive: true });
  try {
    const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${release.file}`, { signal: AbortSignal.timeout(120000), redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length')) > 128 * 1024 ** 2) throw new Error('Official Node runtime download failed.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 128 * 1024 ** 2 || createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Official Node runtime checksum mismatch.');
    const stagedExecutable = join(stage, process.platform === 'win32' ? 'node.exe' : 'node');
    if (process.platform === 'win32') await writeFile(stagedExecutable, bytes, { flag: 'wx' });
    else {
      const archive = join(stage, 'node.tar.gz'); await writeFile(archive, bytes, { flag: 'wx' });
      await promisify(execFile)('tar', ['-xzf', archive, '-C', stage, '--strip-components=2', `node-v${nodeVersion}-${process.platform}-${process.arch}/bin/node`]);
      await promisify(execFile)('tar', ['-xzf', archive, '-C', stage, '--strip-components=1', `node-v${nodeVersion}-${process.platform}-${process.arch}/LICENSE`]);
      await rm(archive); await chmod(stagedExecutable, 0o755);
    }
    if (process.platform === 'win32') {
      const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!license.ok) throw new Error('Official Node runtime license download failed.');
      await writeFile(join(stage, 'LICENSE'), await license.text());
    }
    if(createHash('sha256').update(await readFile(join(stage, 'LICENSE'))).digest('hex') !== nodeLicenseSha256) throw new Error('Official Node license checksum mismatch.');
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ version: nodeVersion, platform: process.platform, arch: process.arch, releaseSha256: release.sha256, licenseSha256: nodeLicenseSha256, binarySha256: createHash('sha256').update(await readFile(stagedExecutable)).digest('hex') }) + '\n');
    await mkdir(resolve(directory, '..'), { recursive: true });
    await rm(directory, { recursive: true, force: true }); await rename(stage, directory);
    return executable;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) console.log(await ensureNodeRuntime());
