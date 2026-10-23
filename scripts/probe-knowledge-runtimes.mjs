import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const probe = resolve(import.meta.dirname, 'probe-local-knowledge.mjs');
for (const [name, binary, environment] of [
  ['node', process.execPath, {}],
  ['electron-node', require('electron'), { ELECTRON_RUN_AS_NODE: '1' }],
]) {
  process.stdout.write(`${name}\n`);
  const result = spawnSync(binary, [probe], { env: { ...process.env, ...environment }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
