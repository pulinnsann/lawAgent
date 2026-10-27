import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { createPublicKey, randomUUID, verify, type KeyObject } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { LICENSE_DEVICE_PATTERN, LICENSE_TOKEN_MAX_BYTES, LICENSE_TRIAL_MILLISECONDS, type LicenseMode, type LicensePayload, type LicenseState, type LicenseStatus } from '../shared/licensing';

export type LicenseErrorCode = 'LICENSE_INVALID' | 'LICENSE_DEVICE_UNAVAILABLE' | 'LICENSE_WRONG_DEVICE'
  | 'LICENSE_NOT_STARTED' | 'LICENSE_EXPIRED' | 'LICENSE_CLOCK_ROLLBACK' | 'LICENSE_STORAGE_UNAVAILABLE' | 'LICENSE_READ_ONLY' | 'LICENSE_CLOSED';
export class LicenseActivationError extends Error {
  constructor(readonly code: LicenseErrorCode, message: string) { super(message); this.name = 'LicenseActivationError'; }
}
export interface LicenseManagerOptions {
  mode: LicenseMode; deviceCode: string | null; publicKeys: Record<string, string>; now?: () => number;
}
interface SavedActivation { token: string; observedAt: string }
interface Directory { root: string; path: string; stat: BigIntStats }
interface Evaluation { state: LicenseState; saved?: SavedActivation; observedAt?: number }
const KID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;
const B64 = /^[A-Za-z0-9_-]+$/u;
const MAX_PAYLOAD_BYTES = 2048;
const MAX_FILE_BYTES = 8192;
// A small NTP correction is tolerated. This is a local best-effort observation,
// not trusted time or protection against an administrator restoring old files.
const ROLLBACK_TOLERANCE_MS = 60_000;
const CHECKPOINT_INTERVAL_MS = 60_000;
const messages: Record<LicenseStatus, string> = {
  development: '开发版本可使用全部功能；正式发行版需要有效授权。',
  missing: '尚未激活本机授权；可以查看和导出已有数据。',
  active: '本机试用授权有效。',
  not_started: '试用授权尚未开始；可以查看和导出已有数据。',
  expired: '90 天试用授权已到期；可以查看和导出已有数据，不能创建新的审核或生成任务。',
  invalid: '授权无法核验；可以查看和导出已有数据，请重新提供有效授权。',
  device_unavailable: '无法取得有效的本机设备码；可以查看和导出已有数据。',
  clock_rollback: '检测到本机时间明显早于已记录时间；请核对时间后重试。已有数据仍可查看和导出。',
  storage_error: '无法安全读取授权记录；可以查看和导出已有数据。',
};
const utc = z.string().max(24).refine(value => utcMilliseconds(value) !== null);
const payloadSchema = z.object({
  version: z.literal(1), product: z.literal('law-agent'), licenseId: z.string().uuid(),
  seat: z.number().int().min(1).max(100), deviceCode: z.string().regex(LICENSE_DEVICE_PATTERN),
  issuedAt: utc, startsAt: utc, expiresAt: utc,
}).strict();
const savedSchema = z.object({ token: z.string().min(1).max(LICENSE_TOKEN_MAX_BYTES), observedAt: utc }).strict();
const invalid = () => new LicenseActivationError('LICENSE_INVALID', messages.invalid);
const storageError = () => new LicenseActivationError('LICENSE_STORAGE_UNAVAILABLE', messages.storage_error);
function utcMilliseconds(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return null;
  const canonical = value.length === 20 ? value.slice(0, -1) + '.000Z' : value;
  const result = Date.parse(canonical);
  return Number.isFinite(result) && new Date(result).toISOString() === canonical ? result : null;
}
function sameDirectory(first: BigIntStats, next: BigIntStats) { return first.dev === next.dev && first.ino === next.ino; }
function ordinaryDirectory(file: BigIntStats) { return file.isDirectory() && !file.isSymbolicLink(); }

/** Verification keys are copied and pinned at construction. The token, UI and
 * activation file cannot introduce a key, an endpoint or a build mode. */
export class LicenseManager {
  private readonly mode: LicenseMode;
  private readonly deviceCode: string | null;
  private readonly keys = new Map<string, KeyObject>();
  private readonly now: () => number;
  private readonly dataDir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private observedFloor = 0;
  private closed = false;
  constructor(dataDir: string, options: LicenseManagerOptions) {
    if (!isAbsolute(dataDir) || dataDir.includes('\0') || !options || !['development', 'required'].includes(options.mode)) throw new Error('授权运行配置无效。');
    this.dataDir = resolve(dataDir); this.mode = options.mode; this.deviceCode = typeof options.deviceCode === 'string' && LICENSE_DEVICE_PATTERN.test(options.deviceCode) ? options.deviceCode : null; this.now = options.now ?? Date.now;
    if (!options.publicKeys || typeof options.publicKeys !== 'object' || Array.isArray(options.publicKeys) || Object.keys(options.publicKeys).length > 32) throw new Error('授权公钥配置无效。');
    for (const [kid, pem] of Object.entries(options.publicKeys)) {
      if (!KID.test(kid) || typeof pem !== 'string' || Buffer.byteLength(pem) > 2048 || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/u.test(pem)) continue;
      try { const key = createPublicKey(pem); if (key.type === 'public' && key.asymmetricKeyType === 'ed25519') this.keys.set(kid, key); } catch { /* Unusable keys never become trust anchors. */ }
    }
  }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new LicenseActivationError('LICENSE_CLOSED', '授权管理器已关闭。'));
    const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next;
  }
  private clock(): number | null {
    try { const value = this.now(); return Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime()) && value >= 0 ? value : null; } catch { return null; }
  }
  private result(status: LicenseStatus, now: number | null, payload?: LicensePayload): LicenseState {
    return { mode: this.mode, status, canCreate: this.mode === 'development' || status === 'active', canViewExport: true, deviceCode: this.deviceCode, checkedAt: new Date(now ?? 0).toISOString(), license: payload ? { licenseId: payload.licenseId, seat: payload.seat, issuedAt: payload.issuedAt, startsAt: payload.startsAt, expiresAt: payload.expiresAt } : null, message: messages[status] };
  }
  private decode(token: string): LicensePayload {
    try {
      if (typeof token !== 'string' || Buffer.byteLength(token) > LICENSE_TOKEN_MAX_BYTES || token !== token.trim()) throw invalid();
      const parts = token.split('.');
      if (parts.length !== 4 || parts[0] !== 'LAW1' || !KID.test(parts[1]) || !B64.test(parts[2]) || !B64.test(parts[3])) throw invalid();
      const key = this.keys.get(parts[1]); if (!key) throw invalid();
      const payload = Buffer.from(parts[2], 'base64url'); const signature = Buffer.from(parts[3], 'base64url');
      if (!payload.length || payload.length > MAX_PAYLOAD_BYTES || signature.length !== 64 || payload.toString('base64url') !== parts[2] || signature.toString('base64url') !== parts[3]) throw invalid();
      if (!verify(null, Buffer.from(parts.slice(0, 3).join('.'), 'utf8'), key, signature)) throw invalid();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
      const value = payloadSchema.parse(JSON.parse(text));
      const issued = utcMilliseconds(value.issuedAt)!, starts = utcMilliseconds(value.startsAt)!, expires = utcMilliseconds(value.expiresAt)!;
      if (issued > starts || expires - starts !== LICENSE_TRIAL_MILLISECONDS) throw invalid();
      return value;
    } catch { throw invalid(); }
  }
  private async directory(create: boolean): Promise<Directory | null> {
    try {
      const rootStat = await lstat(this.dataDir, { bigint: true }); if (!ordinaryDirectory(rootStat)) throw storageError();
      const root = await realpath(this.dataDir); const path = join(root, 'licensing');
      let file: BigIntStats;
      try { file = await lstat(path, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!create) return null;
        try { await mkdir(path, { mode: 0o700 }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
        file = await lstat(path, { bigint: true });
      }
      if (!ordinaryDirectory(file) || await realpath(path) !== path || await realpath(this.dataDir) !== root) throw storageError();
      return { root, path, stat: file };
    } catch { throw storageError(); }
  }
  private async recheck(directory: Directory): Promise<void> {
    const file = await lstat(directory.path, { bigint: true });
    if (!ordinaryDirectory(file) || !sameDirectory(directory.stat, file) || await realpath(directory.path) !== directory.path || await realpath(this.dataDir) !== directory.root || (await lstat(this.dataDir)).isSymbolicLink()) throw storageError();
  }
  private async read(): Promise<SavedActivation | null> {
    const directory = await this.directory(false); if (!directory) return null;
    const path = join(directory.path, 'activation.json'); let handle: FileHandle | undefined;
    try {
      const file = await lstat(path, { bigint: true });
      if (!file.isFile() || file.isSymbolicLink() || file.size > BigInt(MAX_FILE_BYTES)) throw storageError();
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const pinned = await handle.stat({ bigint: true });
      if (!pinned.isFile() || pinned.dev !== file.dev || pinned.ino !== file.ino || pinned.size !== file.size) throw storageError();
      // Read at most the pinned size plus one sentinel byte, even if another
      // process grows the file after the initial stat.
      const bounded = Buffer.allocUnsafe(Number(pinned.size) + 1); let length = 0;
      while (length < bounded.length) {
        const read = await handle.read(bounded, length, bounded.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length !== Number(pinned.size)) throw storageError();
      const bytes = bounded.subarray(0, length);
      const after = await handle.stat({ bigint: true }); const final = await lstat(path, { bigint: true });
      if (!final.isFile() || final.isSymbolicLink() || after.dev !== file.dev || after.ino !== file.ino || after.size !== file.size || after.mtimeNs !== file.mtimeNs || after.ctimeNs !== file.ctimeNs || final.dev !== after.dev || final.ino !== after.ino || final.size !== after.size || final.mtimeNs !== after.mtimeNs || final.ctimeNs !== after.ctimeNs) throw storageError();
      await this.recheck(directory);
      try { return savedSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { throw invalid(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; if (error instanceof LicenseActivationError) throw error; throw storageError(); }
    finally { await handle?.close().catch(() => {}); }
  }
  private async persist(saved: SavedActivation): Promise<void> {
    const directory = await this.directory(true); if (!directory) throw storageError();
    const destination = join(directory.path, 'activation.json'); const temporary = join(directory.path, '.' + randomUUID() + '.tmp');
    const bytes = Buffer.from(JSON.stringify(saved) + '\n'); if (bytes.length > MAX_FILE_BYTES) throw storageError();
    let handle: FileHandle | undefined;
    try {
      await this.recheck(directory);
      const previous = await lstat(destination).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
      if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw storageError();
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
      await this.recheck(directory); await rename(temporary, destination); await this.recheck(directory);
    } catch { throw storageError(); }
    finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
  }
  private async evaluate(): Promise<Evaluation> {
    const now = this.clock(); if (now === null) return { state: this.result('invalid', now) };
    let saved: SavedActivation | null;
    try { saved = await this.read(); } catch (error) { return { state: this.result(error instanceof LicenseActivationError && error.code === 'LICENSE_INVALID' ? 'invalid' : 'storage_error', now) }; }
    if (!saved) return { state: this.result(this.mode === 'development' ? 'development' : this.deviceCode ? 'missing' : 'device_unavailable', now) };
    let payload: LicensePayload; try { payload = this.decode(saved.token); } catch { return { state: this.result('invalid', now) }; }
    if (!this.deviceCode) return { state: this.result('device_unavailable', now) };
    if (payload.deviceCode !== this.deviceCode) return { state: this.result('invalid', now) };
    const observedAt = utcMilliseconds(saved.observedAt)!; const floor = Math.max(this.observedFloor, observedAt);
    if (now + ROLLBACK_TOLERANCE_MS < floor) return { state: this.result('clock_rollback', now, payload) };
    this.observedFloor = Math.max(floor, now);
    const status = now < utcMilliseconds(payload.startsAt)! ? 'not_started' : now >= utcMilliseconds(payload.expiresAt)! ? 'expired' : 'active';
    return { state: this.result(status, now, payload), saved, observedAt };
  }
  state(): Promise<LicenseState> { return this.serialize(async () => (await this.evaluate()).state); }
  activate(token: string): Promise<LicenseState> {
    return this.serialize(async () => {
      const payload = this.decode(token); const now = this.clock();
      if (!this.deviceCode) throw new LicenseActivationError('LICENSE_DEVICE_UNAVAILABLE', messages.device_unavailable);
      if (payload.deviceCode !== this.deviceCode) throw new LicenseActivationError('LICENSE_WRONG_DEVICE', '该授权不属于本机设备，未替换已有授权。');
      if (now === null) throw invalid();
      if (now < utcMilliseconds(payload.startsAt)!) throw new LicenseActivationError('LICENSE_NOT_STARTED', messages.not_started);
      if (now >= utcMilliseconds(payload.expiresAt)!) throw new LicenseActivationError('LICENSE_EXPIRED', messages.expired);
      const existing = await this.evaluate();
      if (existing.state.status === 'clock_rollback' || now + ROLLBACK_TOLERANCE_MS < this.observedFloor) throw new LicenseActivationError('LICENSE_CLOCK_ROLLBACK', messages.clock_rollback);
      const observed = Math.max(now, this.observedFloor); await this.persist({ token, observedAt: new Date(observed).toISOString() }); this.observedFloor = observed;
      return (await this.evaluate()).state;
    });
  }
  assertWritable(): Promise<void> {
    return this.serialize(async () => {
      const result = await this.evaluate();
      if (!result.state.canCreate) throw new LicenseActivationError('LICENSE_READ_ONLY', result.state.message);
      // Persist time only at creation admission, at most once a minute. Reads
      // and UI polling do not create a timer or repeatedly rewrite the file.
      const now = this.clock();
      if (result.saved && now !== null && now - (result.observedAt ?? 0) >= CHECKPOINT_INTERVAL_MS) {
        try { await this.persist({ token: result.saved.token, observedAt: new Date(Math.max(now, this.observedFloor)).toISOString() }); } catch { /* Clock checkpoints are best effort; expiry is still checked freshly above. */ }
      }
    });
  }
  async close(): Promise<void> { this.closed = true; await this.queue; }
}
