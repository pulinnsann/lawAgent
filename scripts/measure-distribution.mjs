#!/usr/bin/env node
// Read-only package accounting. Never launches an app or reads a user workspace.
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
let app;
let output;
const artifacts = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--help') {
    console.log('Usage: node scripts/measure-distribution.mjs --app /path/to/unpacked-app [--artifact /path/to/installer]... [--output /path/to/report.json]');
    process.exit(0);
  }
  if (!['--app', '--artifact', '--output'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${arg}`);
  const value = resolve(args[++i]);
  if (arg === '--app') app = value;
  else if (arg === '--output') output = value;
  else artifacts.push(value);
}
if (!app) throw new Error('--app must name one explicitly selected unpacked distribution, not a source checkout or user workspace.');

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const unix = value => value.split(sep).join('/');
const appInfo = await fs.lstat(app);
if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) throw new Error('The app root must be a real directory.');
const resources = join(app, app.endsWith('.app') ? 'Contents/Resources' : 'resources');
const archive = join(resources, 'app.asar');
const archiveInfo = await fs.lstat(archive);
if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw new Error('Expected a regular packaged app.asar.');
const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
if (metadata.name !== 'law-agent-desktop') throw new Error('This is not a law-agent-desktop distribution.');

async function inventory(root) {
  const files = [];
  let symlinks = 0;
  async function walk(path) {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) { symlinks += 1; continue; }
      if (stat.isDirectory()) await walk(full);
      else if (stat.isFile()) files.push({ path: full, bytes: stat.size });
    }
  }
  await walk(root);
  return { files, symlinks };
}
const tree = await inventory(app);
const unpackedPrefix = `${archive}.unpacked${sep}`;
const shell = tree.files.filter(file => file.path !== archive && !file.path.startsWith(unpackedPrefix));
const unpacked = tree.files.filter(file => file.path.startsWith(unpackedPrefix));
const unpackedByPath = new Map(unpacked.map(file => [unix(relative(`${archive}.unpacked`, file.path)), file]));
const accountedUnpacked = new Set();
const groups = new Map();
function classify(path) {
  if (path.startsWith('out/')) return 'compiled-application';
  if (path.startsWith('node_modules/@napi-rs/canvas')) return 'canvas-packages';
  if (path.startsWith('node_modules/pdfjs-dist/')) return 'pdfjs-package';
  if (/^node_modules\/tesseract\.js(?:-core)?\//u.test(path)) return 'ocr-primary-packages';
  if (path.startsWith('node_modules/sql.js/')) return 'sqlite-wasm-package';
  if (path.startsWith('node_modules/')) return 'other-production-dependencies';
  return 'application-package-metadata';
}
let packedMemberBytes = 0;
for (const raw of asar.listPackage(archive)) {
  const path = raw.replace(/^\//u, '');
  const stat = asar.statFile(archive, path, false);
  if (stat.files || stat.link) continue;
  let bytes = stat.size;
  if (stat.unpacked) {
    const file = unpackedByPath.get(path);
    if (!file) throw new Error(`Missing unpacked file: ${path}`);
    bytes = file.bytes; // macOS code signing may enlarge native files after ASAR creation.
    accountedUnpacked.add(path);
  } else packedMemberBytes += stat.size;
  const group = classify(path);
  const current = groups.get(group) ?? { bytes: 0, files: 0 };
  current.bytes += bytes;
  current.files += 1;
  groups.set(group, current);
}
const sum = files => files.reduce((total, file) => total + file.bytes, 0);
const unindexedUnpacked = unpacked.filter(file => !accountedUnpacked.has(unix(relative(`${archive}.unpacked`, file.path))));
const archiveMetadataBytes = archiveInfo.size - packedMemberBytes;
if (archiveMetadataBytes < 0) throw new Error('ASAR payload accounting does not reconcile.');
const totalRegularBytes = sum(tree.files);
const applicationGroups = [...groups].map(([name, values]) => ({ name, ...values })).sort((a, b) => b.bytes - a.bytes);
const accountedBytes = sum(shell) + applicationGroups.reduce((total, group) => total + group.bytes, 0) + archiveMetadataBytes + sum(unindexedUnpacked);
if (accountedBytes !== totalRegularBytes) throw new Error(`Byte accounting mismatch: ${accountedBytes} !== ${totalRegularBytes}`);
const artifactStats = [];
for (const artifact of artifacts) {
  const stat = await fs.lstat(artifact);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Artifact must be a regular file: ${artifact}`);
  artifactStats.push({ path: artifact, bytes: stat.size });
}
const report = {
  format: 'law-agent-distribution-size-v1',
  measuredAt: new Date().toISOString(),
  version: metadata.version,
  app,
  unit: 'bytes; MiB = bytes / 1048576',
  artifacts: artifactStats,
  installedPayload: {
    regularFileBytes: totalRegularBytes,
    regularFiles: tree.files.length,
    symlinksExcludedWithoutFollowing: tree.symlinks,
    shellAndPlatformResourcesBytes: sum(shell),
    applicationArchivePhysicalBytes: archiveInfo.size,
    unpackedApplicationPhysicalBytes: sum(unpacked),
    archiveMetadataBytes,
    unindexedUnpackedBytes: sum(unindexedUnpacked),
    applicationGroups,
    accountingReconciles: true,
  },
  limits: [
    'Regular file lengths, not filesystem allocated blocks or installer overhead.',
    'Symlinks are not followed, so macOS framework aliases are not counted repeatedly.',
    'Shell includes Electron/Chromium/Node and platform resources; no unsupported split of the combined runtime binary is claimed.',
    'OCR primary packages exclude transitive packages counted under other dependencies; downloaded OCR language models are not bundled.',
    'No app was launched. Startup time, process memory, indexing throughput and user data are not measured.',
    'This script uses the @electron/asar development dependency after npm ci; the measured files come only from the selected distribution.',
  ],
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) { await fs.mkdir(dirname(output), { recursive: true }); await fs.writeFile(output, serialized); }
process.stdout.write(serialized);
