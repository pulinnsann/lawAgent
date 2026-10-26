import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';

// Electron treats app.asar as a virtual directory. Inventory must inspect its
// physical file, while runtime module resolution deliberately keeps ASAR on.
const filesystem = process.versions.electron ? createRequire(import.meta.url)('original-fs').promises : await import('node:fs/promises');
const { lstat, readFile, writeFile, mkdir } = filesystem;

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetBindings = {
  'win32-x64': { package: '@napi-rs/canvas-win32-x64-msvc', binary: 'skia.win32-x64-msvc.node' },
  'darwin-arm64': { package: '@napi-rs/canvas-darwin-arm64', binary: 'skia.darwin-arm64.node' },
  'darwin-x64': { package: '@napi-rs/canvas-darwin-x64', binary: 'skia.darwin-x64.node' },
};
const wasmNames = ['tesseract-core', 'tesseract-core-lstm', 'tesseract-core-simd', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd', 'tesseract-core-relaxedsimd-lstm'];
function argumentsOf(argv) {
  const options = { root: defaultRoot, platform: process.platform, arch: process.arch, resources: null, runtime: false, report: null };
  for (let index = 0; index < argv.length; index++) { const flag = argv[index]; if (flag === '--runtime') options.runtime = true; else if (['--root', '--platform', '--arch', '--resources', '--report'].includes(flag)) { const value = argv[++index]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`); options[flag.slice(2)] = value; } else throw new Error(`Unknown argument: ${flag}`); }
  options.root = resolve(options.root); if (options.resources) options.resources = resolve(options.resources); if (options.report) options.report = resolve(options.report);
  return options;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => { const value = relative(root, path); return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
async function regularFile(root, name) {
  const path = join(root, name); if (!within(root, path)) throw new Error('Resource path escaped the selected root'); let cursor = root;
  for (const segment of relative(root, path).split(sep).filter(Boolean)) { cursor = join(cursor, segment); if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Linked resource is not accepted: ${name}`); }
  const info = await lstat(path); if (!info.isFile()) throw new Error(`Missing regular resource: ${name}`); return path;
}
async function ocrCoreProbe(workerPath, corePath) {
  const worker = new Worker(workerPath); let timer;
  try { await new Promise((resolveReady, reject) => { timer = setTimeout(() => reject(new Error('Offline Tesseract worker/core startup exceeded 30 seconds')), 30000); worker.once('error', reject); worker.once('exit', code => { if (code !== 0) reject(new Error('Tesseract worker exited before core readiness')); }); worker.on('message', message => { if (message.jobId !== 'release-core-probe') return; if (message.status === 'resolve' && message.data?.loaded === true) resolveReady(); if (message.status === 'reject') reject(new Error(`Tesseract core initialization failed: ${String(message.data).slice(0, 400)}`)); }); worker.postMessage({ workerId: 'release-resource-check', jobId: 'release-core-probe', action: 'load', payload: { options: { lstmOnly: true, corePath, logging: false } } }); }); }
  finally { clearTimeout(timer); await worker.terminate(); }
}

export async function verifyReleaseResources(options) {
  const binding = targetBindings[`${options.platform}-${options.arch}`]; if (!binding) throw new Error('This validator supports Windows x64 and macOS arm64/x64 targets');
  const projectRequire = createRequire(pathToFileURL(join(options.root, 'package.json'))); let archive = null; let asar = null;
  if (options.resources) { archive = await regularFile(options.resources, 'app.asar'); asar = projectRequire('@electron/asar'); }
  const entries = [];
  const readResource = async (name, unpacked = false) => {
    let bytes; let location;
    if (archive) { const stat = asar.statFile(archive, name, false); if (stat.link) throw new Error(`Linked archive resource is not accepted: ${name}`); if (unpacked && !stat.unpacked) throw new Error(`Resource must be unpacked for native/worker access: ${name}`); if (stat.unpacked) { const path = await regularFile(join(options.resources, 'app.asar.unpacked'), name); bytes = await readFile(path); location = 'app.asar.unpacked'; } else { bytes = asar.extractFile(archive, name, false); location = 'app.asar'; } }
    else { bytes = await readFile(await regularFile(options.root, name)); location = 'project'; }
    entries.push({ path: name, location, bytes: bytes.length, sha256: sha(bytes) }); return bytes;
  };
  const packageNames = ['@napi-rs/canvas', binding.package, 'sql.js', 'tesseract.js', 'tesseract.js-core', 'pdfjs-dist', 'regenerator-runtime', 'is-url', 'bmp-js', 'wasm-feature-detect'];
  const versions = {};
  for (const name of packageNames) { const data = JSON.parse((await readResource(`node_modules/${name}/package.json`, name.startsWith('@napi-rs/') || name.startsWith('tesseract.js'))).toString('utf8')); versions[name] = data.version; if (data.name !== name) throw new Error(`Unexpected package identity: ${name}`); }
  await readResource('node_modules/@napi-rs/canvas/index.js', true); await readResource('node_modules/@napi-rs/canvas/js-binding.js', true);
  const native = await readResource(`node_modules/${binding.package}/${binding.binary}`, true);
  if (native.length < 16 || options.platform === 'win32' && native.subarray(0, 2).toString('ascii') !== 'MZ' || options.platform === 'darwin' && !['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(native.subarray(0, 4).toString('hex'))) throw new Error('Canvas binding does not have the expected target binary signature');
  await readResource('node_modules/sql.js/dist/sql-wasm.js'); const sqlWasm = await readResource('node_modules/sql.js/dist/sql-wasm.wasm', true);
  if (sqlWasm.subarray(0, 8).toString('hex') !== '0061736d01000000') throw new Error('sql.js WASM header is invalid');
  const workerRelative = 'node_modules/tesseract.js/src/worker-script/node/index.js'; await readResource(workerRelative, true);
  await readResource('node_modules/tesseract.js/src/worker-script/index.js', true); await readResource('node_modules/tesseract.js/src/worker-script/node/getCore.js', true);
  for (const name of wasmNames) { await readResource(`node_modules/tesseract.js-core/${name}.js`, true); await readResource(`node_modules/tesseract.js-core/${name}.wasm.js`, true); const bytes = await readResource(`node_modules/tesseract.js-core/${name}.wasm`, true); if (bytes.subarray(0, 8).toString('hex') !== '0061736d01000000') throw new Error(`Tesseract WASM header is invalid: ${name}`); }
  await readResource('node_modules/pdfjs-dist/legacy/build/pdf.mjs'); await readResource('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
  const businessName = `law-agent-store-${options.platform}-${options.arch}.node`;
  const businessRoot = options.nativeRoot ?? (options.resources ? join(options.resources, 'native') : join(options.root, '.local', 'native'));
  const businessPath = await regularFile(businessRoot, businessName);
  const businessBytes = await readFile(businessPath);
  const businessSignature = options.platform === 'win32' ? businessBytes.subarray(0, 2).toString('ascii') === 'MZ' : ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(businessBytes.subarray(0, 4).toString('hex'));
  if (!businessSignature) throw new Error('Rust business storage does not have the expected target binary signature');
  entries.push({ path: `native/${businessName}`, location: archive ? 'resources' : 'development-native', bytes: businessBytes.length, sha256: sha(businessBytes) });
  const workerPath = archive ? join(options.resources, 'app.asar.unpacked', workerRelative) : join(options.root, workerRelative);
  const corePath = archive ? join(options.resources, 'app.asar.unpacked', 'node_modules/tesseract.js-core') : join(options.root, 'node_modules/tesseract.js-core');
  // These are imported during worker startup, before any OCR language/data
  // download. Verify resolution from the actual unpacked worker location.
  const workerRequire = createRequire(pathToFileURL(workerPath)); const workerDependencies = {};
  for (const name of ['regenerator-runtime/runtime', 'is-url', 'bmp-js', 'wasm-feature-detect', 'tesseract.js-core/tesseract-core-lstm']) { const located = workerRequire.resolve(name); if (archive && !within(options.resources, located)) throw new Error(`Worker dependency resolved outside the packaged resources: ${name}`); const path = archive ? relative(options.resources, located).split(sep).join('/') : relative(options.root, located).split(sep).join('/'); workerDependencies[name] = path; const resourcePath = archive ? path.replace(/^app\.asar(?:\.unpacked)?\//u, '') : path; if (!entries.some(entry => entry.path === resourcePath)) await readResource(resourcePath, true); }
  const runtime = { requested: Boolean(options.runtime), verified: false, node: process.versions.node, electron: process.versions.electron ?? null };
  if (options.runtime) {
    if (process.platform !== options.platform || process.arch !== options.arch) throw new Error('Native runtime verification must run on the target platform and architecture');
    const runtimeRequire = archive ? createRequire(pathToFileURL(join(options.resources, 'app.asar', 'package.json'))) : projectRequire;
    if (archive && ['@napi-rs/canvas', 'sql.js'].some(name => !within(options.resources, runtimeRequire.resolve(name)))) throw new Error('A runtime dependency resolved outside packaged resources');
    const canvas = runtimeRequire('@napi-rs/canvas'); const image = canvas.createCanvas(2, 2); const context = image.getContext('2d'); context.fillStyle = '#123456'; context.fillRect(0, 0, 2, 2); const pixel = [...context.getImageData(0, 0, 1, 1).data]; if (pixel.join(',') !== '18,52,86,255' || image.toBuffer('image/png').subarray(1, 4).toString('ascii') !== 'PNG') throw new Error('Native Canvas raster/PNG probe failed');
    const { DatabaseSync } = await import('node:sqlite'); const database = new DatabaseSync(':memory:'); try { database.exec("CREATE VIRTUAL TABLE probe USING fts5(text); INSERT INTO probe(text) VALUES('contract');"); if (database.prepare("SELECT COUNT(*) AS n FROM probe WHERE probe MATCH 'contract'").get().n !== 1) throw new Error('SQLite FTS5 probe failed'); } finally { database.close(); }
    const { mkdtemp, rm } = await import('node:fs/promises');
    const probeRoot = await mkdtemp(join(tmpdir(), 'law-native-resource-'));
    try {
      const { NativeDatabase, WorkspaceLease } = runtimeRequire(businessPath);
      const lease = new WorkspaceLease(join(probeRoot, 'writer.lock'));
      const business = new NativeDatabase(join(probeRoot, 'probe.sqlite'));
      try { business.run('CREATE TABLE probe(value TEXT);BEGIN IMMEDIATE'); business.run('INSERT INTO probe VALUES(?)', '["中 English ไทย"]'); business.run('COMMIT'); if (JSON.parse(business.query('SELECT value FROM probe'))[0]?.values[0]?.[0] !== '中 English ไทย') throw new Error('Rust business SQLite Unicode transaction probe failed'); }
      finally { business.close(); lease.close(); }
    } finally { await rm(probeRoot, { recursive: true, force: true }); }
    await ocrCoreProbe(workerPath, corePath); runtime.verified = true; Object.assign(runtime, { canvas: 'raster-and-png-passed', nativeSqlite: 'fts5-passed', businessSqlite: 'rust-napi-unicode-transaction-passed', tesseract: 'offline-worker-and-core-passed' });
  }
  return { format: 'law-agent-release-resources-v1', createdAt: new Date().toISOString(), target: { platform: options.platform, arch: options.arch }, stage: archive ? 'packaged' : 'preflight', versions, files: entries, workerDependencies, runtime, limitations: ['OCR traineddata language files are installed by the user; this probe does not download them or test recognition accuracy.', 'Resource and engine probes do not certify legal correctness, Word rendering, installer behavior or code signing.'] };
}

async function main() { const options = argumentsOf(process.argv.slice(2)); const result = await verifyReleaseResources(options); if (options.report) { await mkdir(dirname(options.report), { recursive: true }); await writeFile(options.report, JSON.stringify(result, null, 2)); } process.stdout.write(`Release resource verification passed (${result.stage}, ${result.target.platform}/${result.target.arch}, ${result.files.length} resources, runtime=${result.runtime.verified}).\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(error => { process.stderr.write(`Release resource verification failed: ${error instanceof Error ? error.message : 'unknown failure'}\n`); process.exitCode = 1; });
