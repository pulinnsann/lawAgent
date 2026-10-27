import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync, type BigIntStats } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { LICENSE_DEVICE_PATTERN, LICENSE_TOKEN_MAX_BYTES, LICENSE_TRIAL_MILLISECONDS, type LicensePayload } from '../../src/shared/licensing';

export interface IssuerLicenseSummary { licenseId: string; seat: number; deviceCode: string; issuedAt: string; startsAt: string; expiresAt: string }
export interface LicenseIssuerState { limit: 100; issued: number; remaining: number; keyId: string; publicKeySha256: string; licenses: IssuerLicenseSummary[] }
export interface LicenseIssuerOptions { directory: string; privateKeyPath: string; expectedPublicKeys: Record<string, string>; kid: string; now?: () => number }
export type IssuerErrorCode = 'ISSUER_CONFIG' | 'ISSUER_KEY' | 'ISSUER_PERMISSIONS' | 'ISSUER_LEDGER' | 'ISSUER_INPUT' | 'ISSUER_LIMIT' | 'ISSUER_DUPLICATE_DEVICE' | 'ISSUER_NOT_FOUND' | 'ISSUER_CLOSED';
export class LicenseIssuerError extends Error {
  constructor(readonly code: IssuerErrorCode, message: string) { super(message); this.name = 'LicenseIssuerError'; }
}
const failure = (code: IssuerErrorCode, message: string) => new LicenseIssuerError(code, message);
const ledgerError = () => failure('ISSUER_LEDGER', 'The issuer ledger is unavailable or invalid. No license was returned; preserve the ledger and inspect it before retrying.');
// Header fragments describe the accepted format without embedding a private-key
// envelope that the public-source secret scanner must reject elsewhere.
const privatePemPattern = new RegExp('^-----BEGIN ' + 'PRIVATE KEY-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+-----END ' + 'PRIVATE KEY-----\\s*$', 'u');
const keyError = () => failure('ISSUER_KEY', 'The local Ed25519 private key does not match the pinned public key, or cannot be read safely.');
const inputError = () => failure('ISSUER_INPUT', 'Provide a valid device code and an optional UTC start time between now and 365 days from now.');
const KID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_DB_BYTES = 16 * 1024 * 1024;
const MAX_FUTURE = 365 * 24 * 60 * 60 * 1000;
const APP_ID = 0x4c415731;
const META_SQL = 'CREATE TABLE issuer_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), kid TEXT NOT NULL, public_key_sha256 TEXT NOT NULL)';
const LICENSE_SQL = 'CREATE TABLE licenses (license_id TEXT PRIMARY KEY NOT NULL, seat INTEGER NOT NULL UNIQUE CHECK(seat BETWEEN 1 AND 100), device_code TEXT NOT NULL UNIQUE, issued_at TEXT NOT NULL, starts_at TEXT NOT NULL, expires_at TEXT NOT NULL, token TEXT NOT NULL)';
const payloadKeys = ['deviceCode', 'expiresAt', 'issuedAt', 'licenseId', 'product', 'seat', 'startsAt', 'version'].sort().join(',');
function utc(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return null;
  const canonical = value.length === 20 ? value.slice(0, -1) + '.000Z' : value;
  const n = Date.parse(canonical); return Number.isFinite(n) && new Date(n).toISOString() === canonical ? n : null;
}
function owned(file: BigIntStats): boolean { return typeof process.getuid === 'function' && file.uid === BigInt(process.getuid()); }
function regular(file: BigIntStats): boolean { return file.isFile() && !file.isSymbolicLink() && file.nlink === 1n && owned(file) && (file.mode & 0o777n) === 0o600n; }
function same(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function optionalStat(path: string): BigIntStats | null { try { return lstatSync(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
function noExtendedAcl(path: string): void {
  if (process.platform !== 'darwin') return;
  // POSIX 0600/0700 alone does not exclude macOS extended ACL grants. Inspect
  // metadata only, never contents; no shell, inherited environment or raw
  // command output reaches state/errors. Reject even deny-only ACLs rather
  // than attempt incomplete evaluation of inherited/effective permissions.
  const result = spawnSync('/bin/ls', ['-lde', '--', path], { encoding: 'utf8', timeout: 1500, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = typeof result.stdout === 'string' ? result.stdout.trimEnd().split(/\r?\n/u) : [];
  const mode = lines[0]?.match(/^[d-][rwxstST-]{9}([+@ ])/u);
  if (result.error || result.status !== 0 || result.signal || !mode || mode[1] === '+' || lines.length !== 1) throw failure('ISSUER_PERMISSIONS', 'Owner-only ACL verification failed. The macOS issuer requires key, ledger and directory paths without extended ACL entries.');
}
function rethrowPermission(error: unknown): void { if (error instanceof LicenseIssuerError && error.code === 'ISSUER_PERMISSIONS') throw error; }
function canonicalPath(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw failure('ISSUER_CONFIG', 'Issuer paths must be absolute local paths.');
  return resolve(value);
}

/** Administrator-only signer. The client contains only public keys; neither
 * tokens nor local state can replace the pinned verification key. There is no
 * reset, delete, revoke or reissue operation. Keep and back up this one ledger. */
export class LicenseIssuer {
  private readonly directory: string;
  private readonly directoryIdentity: BigIntStats;
  private readonly path: string;
  private readonly markerPath: string;
  private readonly fileIdentity: BigIntStats;
  private readonly kid: string;
  private readonly publicKey: KeyObject;
  private privateKey: KeyObject | null;
  private readonly fingerprint: string;
  private readonly now: () => number;
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(options: LicenseIssuerOptions) {
    if (process.platform === 'win32') throw failure('ISSUER_PERMISSIONS', 'Windows issuer signing is unavailable until owner-only ACL verification is qualified. Use the local macOS issuer.');
    if (!options || !KID.test(options.kid)) throw failure('ISSUER_CONFIG', 'A pinned issuer key identifier is required.');
    this.kid = options.kid; this.now = options.now ?? Date.now;
    const requestedDirectory = canonicalPath(options.directory), privatePath = canonicalPath(options.privateKeyPath);
    let privateKey: KeyObject, publicKey: KeyObject;
    try {
      const expected = options.expectedPublicKeys?.[this.kid];
      if (typeof expected !== 'string' || Buffer.byteLength(expected) > 2048 || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/u.test(expected)) throw keyError();
      publicKey = createPublicKey(expected); if (publicKey.asymmetricKeyType !== 'ed25519') throw keyError();
      const before = lstatSync(privatePath, { bigint: true }); if (!regular(before) || before.size < 1n || before.size > 2048n) throw keyError();
      noExtendedAcl(privatePath);
      const fd = openSync(privatePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const bytes = Buffer.alloc(Number(before.size) + 1);
      try {
        const pinned = fstatSync(fd, { bigint: true }); if (!regular(pinned) || !same(before, pinned) || before.size !== pinned.size) throw keyError();
        let count = 0; while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, count); if (!n) break; count += n; }
        const after = fstatSync(fd, { bigint: true }), final = lstatSync(privatePath, { bigint: true });
        if (count !== Number(before.size) || !same(before, after) || !same(after, final) || !regular(final) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || final.mtimeNs !== after.mtimeNs || final.ctimeNs !== after.ctimeNs) throw keyError();
        const pem = bytes.subarray(0, count).toString('utf8'); if (!privatePemPattern.test(pem)) throw keyError();
        privateKey = createPrivateKey(pem); if (privateKey.asymmetricKeyType !== 'ed25519') throw keyError();
      } finally { bytes.fill(0); closeSync(fd); }
      if (!createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) throw keyError();
    } catch (error) { rethrowPermission(error); throw keyError(); }
    this.publicKey = publicKey; this.privateKey = privateKey;
    this.fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    let db: DatabaseSync | undefined;
    try {
      if (!existsSync(requestedDirectory)) mkdirSync(requestedDirectory, { recursive: true, mode: 0o700 });
      const directory = lstatSync(requestedDirectory, { bigint: true });
      if (!directory.isDirectory() || directory.isSymbolicLink() || !owned(directory) || (directory.mode & 0o077n) !== 0n) throw ledgerError();
      noExtendedAcl(requestedDirectory);
      this.directory = realpathSync(requestedDirectory); this.directoryIdentity = directory;
      this.path = join(this.directory, 'licenses.sqlite'); this.markerPath = join(this.directory, 'issuer-identity.json');
      const previous = optionalStat(this.path), marker = optionalStat(this.markerPath);
      // A missing half of an existing issuer is an incomplete/lost ledger,
      // never permission to silently issue another 100 trials.
      if (Boolean(previous) !== Boolean(marker)) throw ledgerError();
      const created = !previous;
      if (created) {
        // Reserve the identity first. A crash at any subsequent stage leaves
        // an incomplete issuer which must be inspected, not reset on restart.
        const identity = openSync(this.markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { writeFileSync(identity, JSON.stringify({ version: 1, keyId: this.kid, publicKeySha256: this.fingerprint }) + '\n'); fsyncSync(identity); } finally { closeSync(identity); }
        const fd = openSync(this.path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); closeSync(fd);
      }
      this.fileIdentity = lstatSync(this.path, { bigint: true }); this.guard();
      if (!created && this.fileIdentity.size === 0n) throw ledgerError();
      db = new DatabaseSync(this.path, { allowExtension: false, enableForeignKeyConstraints: true }); this.db = db;
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (created) {
          if (db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()!.n !== 0) throw ledgerError();
          db.exec(META_SQL); db.exec(LICENSE_SQL); db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;`);
          db.prepare('INSERT INTO issuer_meta(id,version,kid,public_key_sha256) VALUES(1,1,?,?)').run(this.kid, this.fingerprint);
        }
        this.records(); this.guard(); db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    } catch (error) { try { db?.close(); } catch {} this.privateKey = null; rethrowPermission(error); throw ledgerError(); }
  }
  private guard(): void {
    const directory = lstatSync(this.directory, { bigint: true }), file = lstatSync(this.path, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink() || !owned(directory) || (directory.mode & 0o077n) !== 0n || !same(directory, this.directoryIdentity) || realpathSync(this.directory) !== this.directory || !regular(file) || !same(file, this.fileIdentity) || file.size > BigInt(MAX_DB_BYTES)) throw ledgerError();
    noExtendedAcl(this.directory); noExtendedAcl(this.path);
    this.checkMarker();
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { const sidecar = lstatSync(this.path + suffix, { bigint: true }); if (!regular(sidecar) || sidecar.size > BigInt(MAX_DB_BYTES)) throw ledgerError(); noExtendedAcl(this.path + suffix); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private checkMarker(): void {
    const before = lstatSync(this.markerPath, { bigint: true });
    if (!regular(before) || before.size < 1n || before.size > 1024n) throw ledgerError();
    noExtendedAcl(this.markerPath);
    const fd = openSync(this.markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const bytes = Buffer.alloc(Number(before.size) + 1);
    try {
      const pinned = fstatSync(fd, { bigint: true }); if (!regular(pinned) || !same(before, pinned) || before.size !== pinned.size) throw ledgerError();
      let count = 0; while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, count); if (!n) break; count += n; }
      const after = fstatSync(fd, { bigint: true }), final = lstatSync(this.markerPath, { bigint: true });
      if (count !== Number(before.size) || !regular(final) || !same(before, after) || !same(after, final) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || final.mtimeNs !== after.mtimeNs || final.ctimeNs !== after.ctimeNs) throw ledgerError();
      const identity = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
      if (!identity || typeof identity !== 'object' || Array.isArray(identity) || Object.keys(identity).sort().join(',') !== 'keyId,publicKeySha256,version' || identity.version !== 1 || identity.keyId !== this.kid || identity.publicKeySha256 !== this.fingerprint) throw ledgerError();
    } finally { closeSync(fd); }
  }
  private ensureOpen() { if (this.closed) throw failure('ISSUER_CLOSED', 'The license issuer has been closed.'); }
  private records(): Array<IssuerLicenseSummary & { token: string }> {
    const schema = this.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (schema.length !== 2 || schema[0].type !== 'table' || schema[0].name !== 'issuer_meta' || schema[0].sql !== META_SQL || schema[1].type !== 'table' || schema[1].name !== 'licenses' || schema[1].sql !== LICENSE_SQL || this.db.prepare('PRAGMA application_id').get()!.application_id !== APP_ID || this.db.prepare('PRAGMA user_version').get()!.user_version !== 1) throw ledgerError();
    const meta = this.db.prepare('SELECT id,version,kid,public_key_sha256 FROM issuer_meta').all();
    if (meta.length !== 1 || meta[0].id !== 1 || meta[0].version !== 1 || meta[0].kid !== this.kid || meta[0].public_key_sha256 !== this.fingerprint) throw ledgerError();
    const rows = this.db.prepare('SELECT * FROM licenses ORDER BY seat LIMIT 101').all(); if (rows.length > 100) throw ledgerError();
    return rows.map((row, index) => {
      const summary: IssuerLicenseSummary = { licenseId: String(row.license_id), seat: Number(row.seat), deviceCode: String(row.device_code), issuedAt: String(row.issued_at), startsAt: String(row.starts_at), expiresAt: String(row.expires_at) };
      if (!UUID.test(summary.licenseId) || summary.seat !== index + 1 || !LICENSE_DEVICE_PATTERN.test(summary.deviceCode) || utc(summary.issuedAt) === null || utc(summary.startsAt) === null || utc(summary.expiresAt) === null || utc(summary.issuedAt)! > utc(summary.startsAt)! || utc(summary.expiresAt)! - utc(summary.startsAt)! !== LICENSE_TRIAL_MILLISECONDS) throw ledgerError();
      const token = String(row.token); if (Buffer.byteLength(token) > LICENSE_TOKEN_MAX_BYTES) throw ledgerError(); const parts = token.split('.');
      if (parts.length !== 4 || parts[0] !== 'LAW1' || parts[1] !== this.kid || !/^[A-Za-z0-9_-]+$/u.test(parts[2]) || !/^[A-Za-z0-9_-]+$/u.test(parts[3])) throw ledgerError();
      const bytes = Buffer.from(parts[2], 'base64url'), signature = Buffer.from(parts[3], 'base64url');
      if (bytes.length > 2048 || bytes.toString('base64url') !== parts[2] || signature.length !== 64 || signature.toString('base64url') !== parts[3] || !verify(null, Buffer.from(parts.slice(0, 3).join('.')), this.publicKey, signature)) throw ledgerError();
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== payloadKeys || payload.version !== 1 || payload.product !== 'law-agent' || Object.entries(summary).some(([key, value]) => payload[key] !== value)) throw ledgerError();
      return { ...summary, token };
    });
  }
  state(): LicenseIssuerState {
    this.ensureOpen();
    try { this.guard(); const licenses = this.records().map(({ token: _token, ...summary }) => summary); return { limit: 100, issued: licenses.length, remaining: 100 - licenses.length, keyId: this.kid, publicKeySha256: this.fingerprint, licenses }; }
    catch (error) { rethrowPermission(error); throw ledgerError(); }
  }
  issue(input: { deviceCode: string; startsAt?: string }): IssuerLicenseSummary & { token: string } {
    this.ensureOpen(); let now: number;
    try { now = this.now(); } catch { throw inputError(); }
    if (!Number.isSafeInteger(now) || now < 0 || now + MAX_FUTURE + LICENSE_TRIAL_MILLISECONDS > 253402300799999 || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['deviceCode', 'startsAt'].includes(key)) || typeof input.deviceCode !== 'string' || !LICENSE_DEVICE_PATTERN.test(input.deviceCode)) throw inputError();
    const starts = input.startsAt === undefined ? now : utc(input.startsAt);
    if (starts === null || starts < now || starts - now > MAX_FUTURE) throw inputError();
    let transaction = false;
    try {
      this.guard(); this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      const existing = this.records();
      if (existing.some(value => value.deviceCode === input.deviceCode)) throw failure('ISSUER_DUPLICATE_DEVICE', 'This device already has a trial. Retrieve its existing license instead of issuing another.');
      if (existing.length >= 100) throw failure('ISSUER_LIMIT', 'All 100 trial licenses have been issued. The ledger cannot be reset or expanded.');
      const summary: IssuerLicenseSummary = { licenseId: randomUUID(), seat: existing.length + 1, deviceCode: input.deviceCode, issuedAt: new Date(now).toISOString(), startsAt: new Date(starts).toISOString(), expiresAt: new Date(starts + LICENSE_TRIAL_MILLISECONDS).toISOString() };
      const payload: LicensePayload = { version: 1, product: 'law-agent', ...summary };
      const prefix = `LAW1.${this.kid}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
      const signature = sign(null, Buffer.from(prefix), this.privateKey!); if (!verify(null, Buffer.from(prefix), this.publicKey, signature)) throw keyError();
      const token = `${prefix}.${signature.toString('base64url')}`; if (Buffer.byteLength(token) > LICENSE_TOKEN_MAX_BYTES) throw keyError();
      this.db.prepare('INSERT INTO licenses(license_id,seat,device_code,issued_at,starts_at,expires_at,token) VALUES(?,?,?,?,?,?,?)').run(summary.licenseId, summary.seat, summary.deviceCode, summary.issuedAt, summary.startsAt, summary.expiresAt, token);
      this.guard(); this.db.exec('COMMIT'); transaction = false;
      return { ...summary, token };
    } catch (error) {
      if (transaction) try { this.db.exec('ROLLBACK'); } catch {}
      if (error instanceof LicenseIssuerError) throw error; throw ledgerError();
    }
  }
  getToken(licenseId: string): string {
    this.ensureOpen(); if (typeof licenseId !== 'string' || !UUID.test(licenseId)) throw failure('ISSUER_NOT_FOUND', 'The requested license does not exist in this ledger.');
    try { this.guard(); const license = this.records().find(value => value.licenseId === licenseId); if (!license) throw failure('ISSUER_NOT_FOUND', 'The requested license does not exist in this ledger.'); return license.token; }
    catch (error) { if (error instanceof LicenseIssuerError) throw error; throw ledgerError(); }
  }
  close(): void { if (!this.closed) { this.closed = true; this.privateKey = null; try { this.db.close(); } catch { throw ledgerError(); } } }
}
