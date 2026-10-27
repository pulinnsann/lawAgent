import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export const DIAGNOSTIC_LOG_MAX_FILES = 4;
export const DIAGNOSTIC_LOG_MAX_FILE_BYTES = 512 * 1024;
export const DIAGNOSTIC_LOG_MAX_QUEUE = 128;
export const DIAGNOSTIC_LOG_MAX_RECORD_BYTES = 2048;
const MAX_RETAINED_BYTES = DIAGNOSTIC_LOG_MAX_FILES * DIAGNOSTIC_LOG_MAX_FILE_BYTES;
const names = ['app.jsonl', 'app.1.jsonl', 'app.2.jsonl', 'app.3.jsonl'] as const;
const events = new Set([
  'app_start', 'app_ready', 'app_close', 'command_start', 'command_complete', 'command_failed',
  'core_ready', 'core_error', 'core_exit', 'task_progress', 'task_complete', 'task_failed', 'protocol_error', 'unhandled_error',
  'desktop.starting', 'desktop.ready', 'desktop.startup_failed', 'desktop.closing', 'desktop.closed', 'core.ready', 'core.error', 'core.exit',
  'command.started', 'command.completed', 'command.failed', 'task.progress', 'task.completed', 'task.failed',
  'diagnostics.exported', 'protocol.starting', 'protocol.ready', 'protocol.closed', 'protocol.failed', 'backend.uncaught_exception',
]);
const commands = new Set(`cancelChangeDraft cancelContractGeneration cancelKnowledgeSync cancelOfficialRetrieval cancelReview checkEnvironment configureLocalKnowledge decideChange enableEditableCopy exportContractDraft exportModified exportReview generateChangeDraft generateContract getChanges getContractDraft getDocument getDocumentBlocks getDocumentReviews getDocumentView getEnterpriseStandard getKnowledgeChunk getKnowledgeState getReview getRiskDispositions getState importContract listContractDrafts listDocumentsPage listEnterpriseStandards loadSample openEvidenceSource openKnowledgeSource publishEnterpriseStandard runWorkspaceCommand saveChange saveEnterpriseStandard saveModelConfig saveRetrievalConfig saveRiskDisposition searchKnowledge selectKnowledgeFolder startKnowledgeSync startReview testModelConnection testOfficialRetrieval testRetrieval assertLicenseWritable updateResourcePressure shutdown`.split(' '));
const actions = new Set(`alignment.candidates alignment.compare alignment.get alignment.history alignment.save connections.chooseDirectory connections.list connections.remove connections.save connections.search connections.sync connections.test connections.tools connections.useKnowledge conversion.convert conversion.download conversion.settings documents.catalog documents.contract.assign documents.contract.status documents.importVersion documents.inspectPurge documents.project.save documents.project.status documents.purge library.advisor.history library.advisor.list library.advisor.regression.review library.advisor.regression.run library.advisor.regressions library.advisor.rollback library.advisor.sample.remove library.advisor.sample.save library.advisor.samples library.advisor.save library.annotation.effective library.annotation.list library.annotation.save library.asset.history library.asset.remove library.asset.rollback library.authoring.attachReview library.authoring.confirm library.authoring.export library.authoring.get library.authoring.history library.authoring.list library.authoring.prepareDescription library.authoring.prepareTemplate library.authoring.recordExport library.authoring.renderConfirmed library.authoring.update library.experience.list library.experience.resolve library.experience.save library.experience.suggest library.template.createFromDocument library.template.export library.template.list library.template.render library.template.save maintenance.backup maintenance.clearKnowledge maintenance.diagnosticsStatus maintenance.exportDiagnostics maintenance.inspectBackup maintenance.restore maintenance.status maintenance.undoClear modelRuntime.probe reporting.export reporting.recordExport reporting.render reporting.translation.generate reviewCompletion.facts.save reviewCompletion.freshness reviewCompletion.get reviewCompletion.source.save reviewCompletion.workflow.prepare reviewCompletion.workflow.refresh translations.generate translations.get translations.history translations.save workspace.cancel workspace.interfaceLocale workspace.licenseActivate workspace.licenseState workspace.progress workspace.resources workspace.sqlite workspace.status`.split(' '));
const stages = new Set(`queued preparing analyzing validating saving completed local_rules model_request parsing cancelled failed batch_prepare batch_review synthesizing cleanup starting closing indexing importing exporting ready`.split(' '));
const statuses = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'ready', 'stopped', 'partial', 'timeout', 'complete', 'empty']);
const errorCodes = new Set(`UNEXPECTED_ERROR CANCELLED TIMEOUT INVALID_INPUT INVALID_RESPONSE CONFIGURATION_REQUIRED PERMISSION_DENIED RATE_LIMIT AUTH_REJECTED SERVICE_UNAVAILABLE ENOENT EACCES EPERM ENOSPC EIO EROFS EBUSY ETIMEDOUT ECONNRESET ECONNREFUSED EHOSTUNREACH ENETUNREACH ENOTFOUND EPIPE EMFILE ENFILE ENOMEM SQLITE_BUSY SQLITE_LOCKED SQLITE_CORRUPT SQLITE_FULL SQLITE_READONLY ERR_WORKER_OUT_OF_MEMORY ERR_WORKER_NOT_RUNNING ERR_INVALID_ARG_TYPE ERR_INVALID_ARG_VALUE ERR_HTTP_HEADERS_TIMEOUT UND_ERR_CONNECT_TIMEOUT UND_ERR_HEADERS_TIMEOUT LICENSE_INVALID LICENSE_DEVICE_UNAVAILABLE LICENSE_WRONG_DEVICE LICENSE_NOT_STARTED LICENSE_EXPIRED LICENSE_CLOCK_ROLLBACK LICENSE_STORAGE_UNAVAILABLE LICENSE_READ_ONLY LICENSE_CLOSED`.split(' '));
const metadataEnums = [
  ['platform', new Set(['darwin', 'win32', 'linux'])], ['arch', new Set(['arm64', 'x64', 'ia32', 'arm'])],
  ['storageBackend', new Set(['rust', 'sqljs', 'unknown'])], ['mode', new Set(['required', 'development'])], ['runtime', new Set(['tauri', 'electron'])],
] as const;
const recordEnums = [['command', commands], ['action', actions], ['stage', stages], ['status', statuses], ['errorCode', errorCodes], ['reviewMode', new Set(['local', 'model'])]] as const;

export interface DiagnosticContext {
  appVersion?: string;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  storageBackend?: string;
  mode?: string;
  runtime?: string;
}
export interface DiagnosticLogStatus {
  available: boolean;
  queued: number;
  dropped: number;
  retainedFiles: number;
  retainedBytes: number;
  maxFiles: 4;
  maxFileBytes: number;
}
type Entry = { v: 1; time: string; event: string } & Record<string, string | number>;
type Pending = { event: string; progressKey: string; line: string };

/** Read only own data properties: callers cannot run getters while a logger
 * attempts to inspect an error, payload or unexpected object. */
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function oneOf(value: unknown, allowed: ReadonlySet<string>): value is string { return typeof value === 'string' && allowed.has(value); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max; }
function metadata(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, allowed] of metadataEnums) { const item = own(value, key); if (oneOf(item, allowed)) result[key] = item; }
  for (const key of ['appVersion', 'nodeVersion'] as const) {
    const item = own(value, key);
    // Release versions only: a free-form prerelease suffix could be a secret.
    if (typeof item === 'string' && item.length <= 32 && (key === 'nodeVersion' ? /^v?\d{1,6}\.\d{1,6}\.\d{1,6}$/u : /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u).test(item)) result[key] = item;
  }
  return result;
}
export function classifyDiagnosticError(error: unknown): { errorCode: string; httpStatus?: number } {
  try { return classifiedError(error); } catch { return { errorCode: 'UNEXPECTED_ERROR' }; }
}
function classifiedError(error: unknown): { errorCode: string; httpStatus?: number } {
  let errorCode = 'UNEXPECTED_ERROR';
  const code = own(error, 'code');
  if (oneOf(code, errorCodes)) errorCode = code;
  else {
    const name = own(error, 'name');
    if (name === 'AbortError') errorCode = 'CANCELLED';
    else if (name === 'TimeoutError') errorCode = 'TIMEOUT';
    else if (name === 'ZodError') errorCode = 'INVALID_INPUT';
    else if (error instanceof SyntaxError) errorCode = 'INVALID_RESPONSE';
  }
  let status = own(error, 'status') ?? own(error, 'statusCode');
  // Most Core failures are transported as Error(message). Categorize only a
  // small, bounded own data property; no message text or stack ever survives.
  const message = own(error, 'message');
  if (typeof message === 'string' && message.length <= 2048 && Buffer.byteLength(message) <= 2048) {
    if (!integer(status, 400, 599)) {
      const match = message.match(/(?:HTTP(?:\/[\d.]+)?(?:\s+Error)?|status(?:\s+code)?|状态码|响应状态)\s*[:：]?\s*(401|403|429|5\d\d)\b/iu);
      if (match) status = Number(match[1]);
    }
    if (errorCode === 'UNEXPECTED_ERROR') {
      if (/(?:超时|\btimed?\s*out\b|\btimeout\b)/iu.test(message)) errorCode = 'TIMEOUT';
      else if (/(?:取消|\bcancell?ed\b|\baborted\b)/iu.test(message)) errorCode = 'CANCELLED';
      else if (/(?:尚未配置|未配置.{0,30}模型|请先配置.{0,30}模型|\bmodel\b.{0,50}\bnot configured\b)/iu.test(message)) errorCode = 'CONFIGURATION_REQUIRED';
      else if (/(?:权限|\bpermission\b|\baccess denied\b)/iu.test(message)) errorCode = 'PERMISSION_DENIED';
    }
  }
  if (errorCode === 'UNEXPECTED_ERROR') {
    if (status === 401 || status === 403) errorCode = 'AUTH_REJECTED';
    else if (status === 429) errorCode = 'RATE_LIMIT';
    else if (integer(status, 500, 599)) errorCode = 'SERVICE_UNAVAILABLE';
  }
  return { errorCode, ...(integer(status, 400, 599) ? { httpStatus: status } : {}) };
}
function entry(value: unknown, context: Record<string, string>, time: string): Entry | null {
  const event = own(value, 'event');
  if (!oneOf(event, events)) return null;
  const result: Entry = { v: 1, time, event, ...context, ...metadata(value) };
  for (const [key, allowed] of recordEnums) {
    const item = own(value, key); if (oneOf(item, allowed)) result[key] = item;
  }
  for (const key of ['durationMs', 'count'] as const) { const item = own(value, key); if (integer(item)) result[key] = item; }
  const exitCode = own(value, 'exitCode'); if (integer(exitCode, -2_147_483_648, 2_147_483_647)) result.exitCode = exitCode;
  const httpStatus = own(value, 'httpStatus'); if (integer(httpStatus, 400, 599)) result.httpStatus = httpStatus;
  return result;
}
function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function owned(stat: BigIntStats): boolean { return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid()); }
function directory(stat: BigIntStats): boolean { return stat.isDirectory() && !stat.isSymbolicLink() && owned(stat) && (process.platform === 'win32' || (stat.mode & 0o777n) === 0o700n); }
function regular(stat: BigIntStats): boolean { return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && owned(stat) && (process.platform === 'win32' || (stat.mode & 0o777n) === 0o600n); }
function same(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function unchanged(a: BigIntStats, b: BigIntStats): boolean { return same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
async function maybeStat(path: string): Promise<BigIntStats | null> { try { return await lstat(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }

/** Lightweight diagnostics, deliberately separate from document/audit storage.
 * No payload, text, URL, path, identifier, token, raw error or stack is accepted.
 * Storage failure disables diagnostics without changing business behavior. */
export class DiagnosticLog {
  private readonly path: string;
  private readonly context: Record<string, string>;
  private rootIdentity: BigIntStats | null = null;
  private directoryIdentity: BigIntStats | null = null;
  private identities = new Map<string, BigIntStats>();
  private retainedBytes = 0;
  private available = false;
  private closed = false;
  private closing = false;
  private dropped = 0;
  private queue: Pending[] = [];
  private running: Promise<void> | null = null;
  private constructor(private readonly dataDir: string, context: DiagnosticContext) { this.path = join(dataDir, 'diagnostics'); this.context = metadata(context); }
  static async open(dataDir: string, context: DiagnosticContext = {}): Promise<DiagnosticLog> {
    const log = new DiagnosticLog(typeof dataDir === 'string' ? dataDir : '', context);
    try { await log.initialize(); } catch { log.disable(); }
    return log;
  }
  private async initialize(): Promise<void> {
    if (!isAbsolute(this.dataDir) || resolve(this.dataDir) !== this.dataDir || this.dataDir.includes('\0')) throw new Error('Diagnostic directory unavailable.');
    const root = await lstat(this.dataDir, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || await realpath(this.dataDir) !== this.dataDir) throw new Error('Diagnostic directory unavailable.');
    this.rootIdentity = root;
    try { await mkdir(this.path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(this.path, { bigint: true });
    if (!directory(stat) || await realpath(this.path) !== this.path) throw new Error('Diagnostic directory unavailable.');
    this.directoryIdentity = stat;
    for (const name of names) {
      const file = await maybeStat(join(this.path, name));
      if (!file) continue;
      if (!regular(file) || file.size > BigInt(DIAGNOSTIC_LOG_MAX_FILE_BYTES)) throw new Error('Diagnostic file unavailable.');
      this.identities.set(name, file); this.retainedBytes += Number(file.size);
    }
    this.available = true;
  }
  private disable(): void {
    this.available = false;
    this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + this.queue.length);
    this.queue = [];
  }
  status(): DiagnosticLogStatus {
    return { available: this.available && !this.closed, queued: this.queue.length, dropped: this.dropped,
      retainedFiles: this.identities.size, retainedBytes: this.retainedBytes, maxFiles: DIAGNOSTIC_LOG_MAX_FILES, maxFileBytes: DIAGNOSTIC_LOG_MAX_FILE_BYTES };
  }
  record(value: unknown): void {
    try {
      if (!this.available || this.closing || this.closed) return;
      const record = entry(value, this.context, new Date().toISOString());
      if (!record) return;
      const line = JSON.stringify(record) + '\n';
      if (Buffer.byteLength(line) > DIAGNOSTIC_LOG_MAX_RECORD_BYTES) return;
      const progressKey = JSON.stringify([record.command, record.action, record.stage, record.status, record.reviewMode]);
      const prior = this.queue.at(-1);
      if (prior?.event === record.event && prior.progressKey === progressKey && ['task_progress', 'task.progress'].includes(record.event)) {
        this.queue[this.queue.length - 1] = { event: record.event, progressKey, line }; this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + 1);
      } else {
        if (this.queue.length >= DIAGNOSTIC_LOG_MAX_QUEUE) { this.queue.shift(); this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + 1); }
        this.queue.push({ event: record.event, progressKey, line });
      }
      this.startDrain();
    } catch { /* Logging must never replace the original business result. */ }
  }
  private startDrain(): void {
    if (this.running || !this.available || !this.queue.length) return;
    const running = Promise.resolve().then(() => this.drain()).catch(() => this.disable());
    this.running = running;
    void running.finally(() => { if (this.running === running) this.running = null; if (this.available && this.queue.length) this.startDrain(); });
  }
  private async guard(): Promise<void> {
    const root = await lstat(this.dataDir, { bigint: true }), stat = await lstat(this.path, { bigint: true });
    if (!this.rootIdentity || !this.directoryIdentity || !root.isDirectory() || root.isSymbolicLink() || !same(root, this.rootIdentity)
      || !directory(stat) || !same(stat, this.directoryIdentity) || await realpath(this.path) !== this.path) throw new Error('Diagnostic directory unavailable.');
  }
  private async checkedFile(name: string): Promise<BigIntStats | null> {
    const stat = await maybeStat(join(this.path, name)); const known = this.identities.get(name);
    if (!stat) { if (known) throw new Error('Diagnostic file unavailable.'); return null; }
    if (!regular(stat) || stat.size > BigInt(DIAGNOSTIC_LOG_MAX_FILE_BYTES) || known && !same(known, stat)) throw new Error('Diagnostic file unavailable.');
    return stat;
  }
  private async rotate(): Promise<void> {
    await this.guard();
    for (const name of names) await this.checkedFile(name);
    const oldest = this.identities.get(names[3]);
    if (oldest) await unlink(join(this.path, names[3]));
    for (let index = 2; index >= 0; index--) if (this.identities.has(names[index])) await rename(join(this.path, names[index]), join(this.path, names[index + 1]));
    const next = new Map<string, BigIntStats>();
    for (let index = 0; index < 3; index++) { const stat = this.identities.get(names[index]); if (stat) next.set(names[index + 1], stat); }
    this.identities = next;
    this.retainedBytes -= Number(oldest?.size ?? 0n);
  }
  private async append(lines: string[]): Promise<void> {
    await this.guard();
    const bytes = Buffer.from(lines.join(''));
    let previous = await this.checkedFile(names[0]);
    if (Number(previous?.size ?? 0n) + bytes.length > DIAGNOSTIC_LOG_MAX_FILE_BYTES) { await this.rotate(); previous = null; }
    const path = join(this.path, names[0]);
    let file: FileHandle | undefined;
    try {
      file = await open(path, constants.O_WRONLY | constants.O_APPEND | (previous ? 0 : constants.O_CREAT | constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0), 0o600);
      const pinned = await file.stat({ bigint: true }); const final = await lstat(path, { bigint: true });
      if (!regular(pinned) || !regular(final) || !same(pinned, final) || previous && !same(previous, pinned)) throw new Error('Diagnostic file unavailable.');
      await file.writeFile(bytes);
      const after = await file.stat({ bigint: true }); const current = await lstat(path, { bigint: true });
      if (!regular(after) || !regular(current) || !same(after, current) || !same(after, pinned) || after.size > BigInt(DIAGNOSTIC_LOG_MAX_FILE_BYTES)) throw new Error('Diagnostic file unavailable.');
      this.identities.set(names[0], after); this.retainedBytes += Number(after.size) - Number(previous?.size ?? 0n);
    } finally { await file?.close().catch(() => {}); }
  }
  private async drain(): Promise<void> {
    while (this.available && this.queue.length) {
      // A batch is at most 64 KiB and leaves no descriptor or timer resident.
      const batch = this.queue.splice(0, 32);
      await this.append(batch.map(item => item.line));
    }
  }
  async flush(): Promise<void> {
    try { while (this.running || this.available && this.queue.length) { this.startDrain(); await this.running; } } catch { this.disable(); }
  }
  private async readFile(name: string): Promise<string | null> {
    await this.guard(); const before = await this.checkedFile(name); if (!before) return null;
    let file: FileHandle | undefined;
    try {
      file = await open(join(this.path, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const pinned = await file.stat({ bigint: true });
      if (!regular(pinned) || !unchanged(before, pinned)) throw new Error('Diagnostic file unavailable.');
      const bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { const read = await file.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
      const after = await file.stat({ bigint: true }), final = await lstat(join(this.path, name), { bigint: true });
      if (count !== Number(before.size) || !regular(final) || !unchanged(before, after) || !unchanged(after, final)) throw new Error('Diagnostic file unavailable.');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    } finally { await file?.close().catch(() => {}); }
  }
  async exportText(context: DiagnosticContext = {}): Promise<string> {
    await this.flush();
    const rows: string[] = []; let total = 0;
    if (this.available) {
      try {
        outer: for (const name of names) {
          const text = await this.readFile(name); if (text === null) continue;
          // A crash can leave a partial final line. Only complete JSONL rows
          // with this logger's schema can enter an exported troubleshooting file.
          const parts = text.split('\n'); parts.pop();
          for (let index = parts.length - 1; index >= 0; index--) {
            const raw = parts[index]; if (!raw || Buffer.byteLength(raw) > DIAGNOSTIC_LOG_MAX_RECORD_BYTES) continue;
            let parsed: unknown; try { parsed = JSON.parse(raw); } catch { continue; }
            const time = own(parsed, 'time'); if (own(parsed, 'v') !== 1 || !validTime(time)) continue;
            const safe = entry(parsed, {}, time); if (!safe) continue;
            const line = JSON.stringify(safe) + '\n'; const bytes = Buffer.byteLength(line);
            if (total + bytes > MAX_RETAINED_BYTES) break outer;
            total += bytes; rows.push(line);
          }
        }
      } catch { this.disable(); rows.length = 0; }
    }
    const info = { ...this.context, ...metadata(context) }, state = this.status();
    const header = ['LawAgent troubleshooting log', `Generated at (UTC): ${new Date().toISOString()}`,
      'Privacy: event types and allowlisted technical metadata only. No contract text, credentials, device code, identifiers, URLs, file paths, raw errors or stacks.',
      `Retention: at most ${DIAGNOSTIC_LOG_MAX_FILES} files of ${DIAGNOSTIC_LOG_MAX_FILE_BYTES} bytes each.`,
      `Diagnostics available: ${state.available ? 'yes' : 'no'}; dropped or coalesced records: ${state.dropped}.`,
      ...Object.entries(info).map(([key, value]) => `${key}: ${value}`), '--- Validated events (JSONL) ---', ''].join('\n');
    return header + rows.reverse().join('');
  }
  async close(): Promise<void> { if (this.closed) return; this.closing = true; await this.flush(); this.closed = true; }
}
