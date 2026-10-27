import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { finished } from 'node:stream/promises';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile); const project = resolve(import.meta.dirname, '..'); const script = join(project, 'scripts/verify-release-resources.mjs'); const require = createRequire(import.meta.url);

test('发布资源校验在本机真实加载Canvas/SQLite及离线OCR Core，不下载语言数据', async t => {
  if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(`${process.platform}-${process.arch}`)) { t.skip('resource release targets are Windows x64 and macOS'); return; }
  const root = await mkdtemp(join(tmpdir(), 'law-release-runtime-'));
  try {
    const report = join(root, 'manifest.json'); const result = await run(process.execPath, [script, '--platform', process.platform, '--arch', process.arch, '--runtime', '--report', report], { cwd: project, timeout: 40000 });
    assert.match(result.stdout, /runtime=true/u); const data = JSON.parse(await readFile(report, 'utf8')); assert.equal(data.runtime.verified, true); assert.equal(data.runtime.tesseract, 'offline-worker-and-core-passed'); assert.equal(data.runtime.nativeSqlite, 'fts5-passed'); assert.ok(data.files.some((file: any) => file.path.endsWith('.node'))); assert.ok(data.files.filter((file: any) => file.path.endsWith('.wasm')).length >= 7); assert.ok(!JSON.stringify(data).includes('.local/data'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fakeWindowsArchive(root: string, unpack: boolean, native: Buffer) {
  const input = join(root, 'app-input'); const resources = join(root, 'resources'); await mkdir(resources);
  const files: Record<string, string | Buffer> = {};
  for (const name of ['@napi-rs/canvas', '@napi-rs/canvas-win32-x64-msvc', 'sql.js', 'tesseract.js', 'tesseract.js-core', 'pdfjs-dist', 'regenerator-runtime', 'is-url', 'bmp-js', 'wasm-feature-detect']) files[`node_modules/${name}/package.json`] = JSON.stringify({ name, version: 'synthetic' });
  files['node_modules/@napi-rs/canvas/index.js'] = ''; files['node_modules/@napi-rs/canvas/js-binding.js'] = ''; files['node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node'] = native;
  for (const [name, bytes] of Object.entries(files)) { const path = join(input, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
  // glob v7 treats backslashes as escapes, even on Windows. ASAR's crawler
  // needs a forward-slash pattern root; its file API still uses native paths.
  const asar = require('@electron/asar'); const archive = join(resources, 'app.asar');
  // ASAR v3 resolves to a WriteStream after end(), before pending writes finish.
  await finished(await asar.createPackageWithOptions(input.replaceAll('\\', '/'), archive, unpack ? { unpack: '**/*' } : {}));
  assert.equal(asar.statFile(archive, join('node_modules', '@napi-rs', 'canvas', 'package.json')).unpacked === true, unpack);
  assert.equal(JSON.parse(asar.extractFile(archive, join('node_modules', '@napi-rs', 'canvas', 'package.json')).toString('utf8')).name, '@napi-rs/canvas');
  return resources;
}

test('打包资源校验拒绝错误平台原生库，文件名正确不能冒充Windows二进制', async () => {
  const root = await mkdtemp(join(tmpdir(), 'law-release-wrong-native-'));
  try { const resources = await fakeWindowsArchive(root, true, Buffer.alloc(64, 1)); await assert.rejects(run(process.execPath, [script, '--platform', 'win32', '--arch', 'x64', '--resources', resources], { cwd: project }), (error: any) => /expected target binary signature/u.test(error.stderr)); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('打包校验拒绝只留在ASAR中的原生/Worker资源及未知脚本参数', async () => {
  const root = await mkdtemp(join(tmpdir(), 'law-release-packed-native-'));
  try { const native = Buffer.alloc(64); native.write('MZ'); const resources = await fakeWindowsArchive(root, false, native); await assert.rejects(run(process.execPath, [script, '--platform', 'win32', '--arch', 'x64', '--resources', resources], { cwd: project }), (error: any) => /must be unpacked/u.test(error.stderr)); await assert.rejects(run(process.execPath, [script, '--execute-any-file', '/not-authorized'], { cwd: project }), (error: any) => /Unknown argument/u.test(error.stderr)); }
  finally { await rm(root, { recursive: true, force: true }); }
});
