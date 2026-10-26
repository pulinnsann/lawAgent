import type { SqlValue } from 'sql.js';
import { acquireWorkspaceLease, openLegacyDatabase, type StorageDatabase, type StorageBackend } from './storage-backend';
import { BusinessDatabaseOpening } from './storage-migration';
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../shared/workspace-schema';
import { defaultRetrievalConfig } from '../shared/contracts';
import type { ContractBlock, ContractDetail, ContractSummary, ModelConfigInput, ParsedContract, PublicModelConfig, PublicRetrievalConfig, RetrievalAttempt, RetrievalBundle, ReviewContext, ReviewResult, ReviewTask, SourceEvidence } from '../shared/contracts';
import type { ChangeDecision, ChangeExport, ChangeProposal } from '../shared/changes';
import type { EnterpriseStandardContent, EnterpriseStandardProfile, EnterpriseStandardSnapshot, EnterpriseStandardSummary, PublishEnterpriseStandardInput, RiskDispositionEvent, RiskDispositionWorkspace, SaveEnterpriseStandardInput, SaveRiskDispositionInput } from '../shared/assurance';
import { normalizeEnterpriseStandardContent, normalizePublishEnterpriseStandardInput, normalizeSaveEnterpriseStandardInput, normalizeSaveRiskDispositionInput } from './enterprise-standards';
import type { ContractDraft, ContractDraftSummary } from '../shared/generation';
import { detectLanguage } from './documents';
import { defaultKnowledgePreferences, normalizeKnowledgePreferences } from '../shared/knowledge-preferences';

type Row = Record<string, SqlValue>;
const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v);
const hash = (v: unknown) => createHash('sha256').update(json(v)).digest('hex');
const parse = <T>(v: SqlValue | undefined): T => JSON.parse(String(v)) as T;
/** Numbering metadata shares the immutable block locator envelope; original_text
 * and its SHA-256 remain byte-for-byte independent from display numbering. */
const blockLocatorJson = (block: ContractBlock): string => json({ ...block.locator, ...(block.numberingLabel ? { numberingLabel: block.numberingLabel } : {}) });
function storedBlock(row: Row): ContractBlock {
  const envelope = parse<ContractBlock['locator'] & { numberingLabel?: unknown }>(row.locator_json);
  const { numberingLabel, ...locator } = envelope;
  return { id: String(row.id), ordinal: Number(row.ordinal), kind: row.kind as ContractBlock['kind'], text: String(row.original_text), locator: locator as ContractBlock['locator'], ...(typeof numberingLabel === 'string' && numberingLabel.length <= 250 ? { numberingLabel } : {}) };
}
type ProviderIds = Partial<Record<RetrievalAttempt['provider'], string>>;
type RetrievalAudit = Pick<RetrievalBundle, 'knowledgeStatus' | 'webStatus' | 'officialStatus' | 'searchStatus' | 'limitations'>;
type TaskCheckpoint = ReviewTask & { retrievalAudit?: RetrievalAudit };
type RetrievalSnapshot = { mode: 'model' | 'local'; config: PublicRetrievalConfig | null; providerProfileIds: ProviderIds; connectionSnapshots?: unknown[] };

/** Explicit allow-list: even a caller bypassing Service cannot persist apiKey/clearApiKey. */
function safeRetrievalConfig(config: PublicRetrievalConfig): PublicRetrievalConfig {
  return {
    knowledge: { enabled: config.knowledge.enabled, folderPath: config.knowledge.folderPath,
      preferences: config.knowledge.preferences === undefined ? defaultKnowledgePreferences() : normalizeKnowledgePreferences(config.knowledge.preferences),
      api: { enabled: config.knowledge.api.enabled, provider: config.knowledge.api.provider,
        baseUrl: config.knowledge.api.baseUrl, collectionId: config.knowledge.api.collectionId,
        hasApiKey: false, keyStorage: 'session-only' } },
    web: { enabled: config.web.enabled, provider: config.web.provider, baseUrl: config.web.baseUrl,
      allowedDomains: [...config.web.allowedDomains], fetchPages: config.web.fetchPages,
      hasApiKey: false, keyStorage: 'session-only' },
    official: { enabled: config.official?.enabled ?? false, maxCatalogPages: config.official?.maxCatalogPages ?? 3, sourceUrls: [...config.official?.sourceUrls ?? []],...(config.official?.courtCatalogs===undefined?{}:{courtCatalogs:[...config.official.courtCatalogs]}) },
    maxResults: config.maxResults, timeoutSeconds: config.timeoutSeconds,
  };
}

function dateOnly(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const date = value.slice(0, 10);
  const milliseconds = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === date ? date : null;
}

function normalizeQuote(value: string): string { return value.normalize('NFC').replace(/\s+/gu, ' ').trim(); }

/** One Core worker owns the native SQLite connection. Legacy WASM is an explicit regression reference only. */
export class AppStore {
  private closed = false;
  private transactionQueue: Promise<unknown> = Promise.resolve();
  private closingPromise: Promise<void> | null = null;
  private constructor(private db: StorageDatabase, private path: string, readonly workspaceId: string, private releaseLease: () => Promise<void>) {}
  get storageBackend(): StorageBackend { return this.db.backend; }

  static async open(dataDir: string): Promise<AppStore> {
    const release = await acquireWorkspaceLease(dataDir);
    let opening: BusinessDatabaseOpening | undefined;
    try {
      opening = await BusinessDatabaseOpening.prepare(dataDir);
      return await AppStore.finishOpen(dataDir, opening, release);
    } catch (error) {
      try { await opening?.abort(); } finally { await release(); }
      throw error;
    }
  }

  private static async finishOpen(dataDir: string, opening: BusinessDatabaseOpening, release: () => Promise<void>): Promise<AppStore> {
    let db = opening.db;
    const path = opening.path;
    db.run('PRAGMA foreign_keys=ON');
    if (!opening.existed) {
      const schema = await readFile(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8');
      db.run(schema);
      db.run('UPDATE schema_version SET applied_at=?', [now()]);
    }
    const version = Number(db.exec('SELECT MAX(version) FROM schema_version')[0]?.values[0]?.[0] ?? 0);
    opening.setInitialVersion(version);
    if(!Number.isInteger(version)||version>CURRENT_WORKSPACE_SCHEMA_VERSION){db.close();throw new Error('业务数据库来自更新的软件版本，当前版本不能打开。');}
    if (version < 2) {
      await opening.retainVersion(1);
      db.run('PRAGMA foreign_keys=OFF'); db.run('BEGIN');
      try {
        db.run(await readFile(new URL('./migrations/002-official-sources.sql', import.meta.url), 'utf8'));
        if (db.exec('PRAGMA foreign_key_check').some(result => result.values.length)) throw new Error('升级来源存储时关系校验失败，原数据库已保留。');
        db.run('INSERT INTO schema_version(version,applied_at) VALUES(2,?)', [now()]); db.run('COMMIT');
      } catch (error) { db.run('ROLLBACK'); db.close(); throw error; }
      db.run('PRAGMA foreign_keys=ON');
    }
    if (version < 3) {
      await opening.retainVersion(2);
      db.run('BEGIN');
      try {
        db.run(await readFile(new URL('./migrations/003-document-changes.sql', import.meta.url), 'utf8'));
        if (db.exec('PRAGMA foreign_key_check').some(result => result.values.length)) throw new Error('升级改稿存储时关系校验失败，原数据库已保留。');
        db.run('INSERT INTO schema_version(version,applied_at) VALUES(3,?)', [now()]); db.run('COMMIT');
      } catch (error) { db.run('ROLLBACK'); db.close(); throw error; }
      db.run('PRAGMA foreign_keys=ON');
    }
    if (version < 4) {
      await opening.retainVersion(3);
      db.run('BEGIN');
      try {
        db.run(await readFile(new URL('./migrations/004-editable-copy.sql', import.meta.url), 'utf8'));
        if (db.exec('PRAGMA foreign_key_check').some(result => result.values.length)) throw new Error('升级可编辑副本存储时关系校验失败，原数据库已保留。');
        db.run('INSERT INTO schema_version(version,applied_at) VALUES(4,?)', [now()]); db.run('COMMIT');
      } catch (error) { db.run('ROLLBACK'); db.close(); throw error; }
      db.run('PRAGMA foreign_keys=ON');
    }
    if (version < 5) {
      await opening.retainVersion(4);
      db.run('BEGIN');
      try {
        db.run(await readFile(new URL('./migrations/005-contract-generation.sql', import.meta.url), 'utf8'));
        if (db.exec('PRAGMA foreign_key_check').some(result => result.values.length)) throw new Error('升级合同生成存储时关系校验失败，原数据库已保留。');
        db.run('INSERT INTO schema_version(version,applied_at) VALUES(5,?)', [now()]); db.run('COMMIT');
      } catch (error) { db.run('ROLLBACK'); db.close(); throw error; }
      db.run('PRAGMA foreign_keys=ON');
    }
    if (version < 6) {
      await opening.retainVersion(5);
      db.run('BEGIN');
      try {
        db.run(await readFile(new URL('./migrations/006-enterprise-assurance.sql', import.meta.url), 'utf8'));
        if (db.exec('PRAGMA foreign_key_check').some(result => result.values.length)) throw new Error('升级企业审核存储时关系校验失败，原数据库已保留。');
        db.run('INSERT INTO schema_version(version,applied_at) VALUES(6,?)', [now()]); db.run('COMMIT');
      } catch (error) { db.run('ROLLBACK'); db.close(); throw error; }
      db.run('PRAGMA foreign_keys=ON');
    }
    if (version < 7) {
      await opening.retainVersion(6);
      db.run('BEGIN');
      try {
        db.run(await readFile(new URL('./migrations/007-document-lifecycle.sql', import.meta.url), 'utf8'));
        if (db.exec('PRAGMA foreign_key_check').some(result => result.values.length)) throw new Error('升级合同版本管理时关系校验失败，原数据库已保留。');
        db.run('INSERT INTO schema_version(version,applied_at) VALUES(7,?)', [now()]); db.run('COMMIT');
      } catch (error) { db.run('ROLLBACK'); db.close(); throw error; }
      db.run('PRAGMA foreign_keys=ON');
    }
    db = await opening.publish();
    const existing = db.exec('SELECT id FROM workspaces ORDER BY created_at,id LIMIT 1')[0]?.values[0]?.[0];
    const store = new AppStore(db, path, existing ? String(existing) : randomUUID(), release);
    // WASM previously published startup mutations together in one file image.
    // Native autocommit must not leave a seed rule without its version when an
    // insert fails or the process stops between statements.
    if (db.backend === 'rust') db.run('BEGIN IMMEDIATE');
    try {
      if (!existing) store.insert('workspaces', { id: store.workspaceId, name: '我的工作空间', company_name: null, created_at: now(), updated_at: now() });
      store.ensureSeed();
      // Interrupted runs stay recoverable, never silently marked completed.
      db.run("UPDATE tasks SET status='failed', error_code='INTERRUPTED', error_message='应用上次关闭时任务尚未完成，请重新审核。', updated_at=? WHERE status IN ('queued','running','waiting')", [now()]);
      db.run("UPDATE analysis_runs SET status='partial', finished_at=? WHERE status IN ('queued','running')", [now()]);
      if (db.backend === 'rust') db.run('COMMIT');
    } catch (error) { if (db.backend === 'rust') { try { db.run('ROLLBACK'); } catch { /* SQLite may have recovered an I/O failure. */ } } throw error; }
    await store.flush();
    const { recoverContractPurges } = await import('./document-purge');
    await recoverContractPurges(store,dataDir);
    return store;
  }

  rows(sql: string, values: SqlValue[] = []): Row[] {
    return this.db.all(sql, values);
  }

  private insert(table: string, row: Row): void {
    const fields = Object.keys(row);
    this.db.run(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, Object.values(row));
  }

  private ensureSeed(): void {
    if (!this.rows('SELECT id FROM rule_sets WHERE workspace_id=?', [this.workspaceId]).length) {
      const id = randomUUID(); const rules = [{ ruleSchemaVersion: '1', ruleKey: 'basic-review', title: '基础合同检查', category: 'operational', contractTypes: [], partyRoles: [], trigger: {}, exceptions: {}, severityPolicy: {}, recommendedActions: [], rationale: '工程初始检查流程；尚未经专业顾问验证。', authorityReferences: [] }];
      this.insert('rule_sets', { id, workspace_id: this.workspaceId, name: '基础检查 · 待顾问完善', archived_at: null, created_at: now() });
      this.insert('rule_set_versions', { id: randomUUID(), rule_set_id: id, version_no: 1, jurisdiction: 'PRC', rules_json: json(rules), workflow_config_json: '{}', business_thresholds_json: '{}', presentation_preferences_json: '{}', content_sha256: hash(rules), approved_by_label: '工程初始配置（非法律顾问结论）', published_at: now() });
    }
    if (!this.rows("SELECT id FROM provider_profiles WHERE adapter_id='local-rules' AND workspace_id=?", [this.workspaceId]).length) {
      this.insert('provider_profiles', { id: randomUUID(), workspace_id: this.workspaceId, kind: 'model', name: '本地基础规则', adapter_id: 'local-rules', endpoint: 'app://local-rules', model_id: null, credential_ref: null, capabilities_json: '{}', settings_json: '{}', enabled: 1, created_at: now(), updated_at: now() });
    }
  }

  async flush(): Promise<void> {
    if (this.db.backend === 'rust') return; // SQLite commits synchronously; no whole-file export.
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { const bytes = this.db.export(); this.db.run('PRAGMA foreign_keys=ON'); await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, this.path); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  async transaction<T>(fn: () => T): Promise<T> {
    if (this.closed || this.closingPromise) throw new Error('业务数据库已关闭或正在关闭。');
    const work = this.transactionQueue.then(() => this.runTransaction(fn));
    this.transactionQueue = work.catch(() => {});
    return work;
  }

  private async runTransaction<T>(fn: () => T): Promise<T> {
    if (this.closed) throw new Error('业务数据库已关闭。');
    if (this.db.backend === 'rust') {
      this.db.run('BEGIN IMMEDIATE');
      try {
        const result = fn();
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('数据库事务回调必须同步执行。');
        // Preserve the pre-commit failure boundary used by artifact operations and
        // tests. Native flush allocates no image; durable COMMIT is the last step.
        await this.flush();
        this.db.run('COMMIT');
        return result;
      } catch (error) { try { this.db.run('ROLLBACK'); } catch { /* SQLite may have already rolled back an I/O failure. */ } throw error; }
    }
    const before = this.db.export(); this.db.run('PRAGMA foreign_keys=ON');
    this.db.run('BEGIN');
    try { const result = fn(); this.db.run('COMMIT'); await this.flush(); return result; }
    catch (error) { try { this.db.run('ROLLBACK'); } catch { /* already committed in memory */ } this.db.close(); this.db = await openLegacyDatabase(before); this.db.run('PRAGMA foreign_keys=ON'); throw error; }
  }

  listEnterpriseStandards(): EnterpriseStandardSummary[] {
    return this.rows('SELECT d.standard_id FROM enterprise_standard_drafts d JOIN rule_sets r ON r.id=d.standard_id WHERE d.workspace_id=? AND r.workspace_id=? ORDER BY d.updated_at DESC,d.standard_id', [this.workspaceId, this.workspaceId]).map(row => {
      const profile = this.getEnterpriseStandard(String(row.standard_id));
      return { id: profile.id, name: profile.draft.name, revision: profile.revision, versions: profile.versions.map(({ content: _content, ...version }) => version) };
    });
  }

  getEnterpriseStandard(id: string): EnterpriseStandardProfile {
    const row = this.rows('SELECT d.* FROM enterprise_standard_drafts d JOIN rule_sets r ON r.id=d.standard_id WHERE d.standard_id=? AND d.workspace_id=? AND r.workspace_id=?', [id, this.workspaceId, this.workspaceId])[0];
    if (!row) throw new Error('企业审核标准不存在或不属于当前工作空间。');
    const draft = normalizeEnterpriseStandardContent(parse<unknown>(row.content_json));
    if (hash(draft) !== row.content_sha256 || draft.name !== row.name) throw new Error('企业审核标准草稿校验失败。');
    const versions = this.rows('SELECT v.version_id FROM enterprise_standard_versions v JOIN rule_set_versions r ON r.id=v.version_id WHERE v.standard_id=? ORDER BY r.version_no', [id]).map(version => this.getEnterpriseStandardVersion(String(version.version_id)));
    return { id, revision: Number(row.revision), draft, versions };
  }

  async saveEnterpriseStandard(input: SaveEnterpriseStandardInput): Promise<EnterpriseStandardProfile> {
    input = normalizeSaveEnterpriseStandardInput(input);
    const id = input.standardId ?? randomUUID();
    await this.transaction(() => {
      const previous = input.standardId ? this.getEnterpriseStandard(id) : null;
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new Error('企业审核标准已发生变化，请刷新后重试。');
      if (!previous && Number(this.rows('SELECT COUNT(*) AS n FROM enterprise_standard_drafts WHERE workspace_id=?', [this.workspaceId])[0].n) >= 100) throw new Error('企业审核标准最多保存100个，请复用已有标准。');
      if (this.rows('SELECT id FROM rule_sets WHERE workspace_id=? AND name=? COLLATE NOCASE AND id<>?', [this.workspaceId, input.content.name, id]).length) throw new Error('企业审核标准名称已存在，请使用其他名称。');
      const stamp = now();
      if (previous) {
        this.db.run('UPDATE rule_sets SET name=? WHERE id=?', [input.content.name, id]);
        this.db.run('UPDATE enterprise_standard_drafts SET name=?,revision=revision+1,content_json=?,content_sha256=?,updated_at=? WHERE standard_id=?', [input.content.name, json(input.content), hash(input.content), stamp, id]);
      } else {
        this.insert('rule_sets', { id, workspace_id: this.workspaceId, name: input.content.name, archived_at: null, created_at: stamp });
        this.insert('enterprise_standard_drafts', { standard_id: id, workspace_id: this.workspaceId, name: input.content.name, revision: 1, content_json: json(input.content), content_sha256: hash(input.content), updated_at: stamp });
      }
    });
    return this.getEnterpriseStandard(id);
  }

  async publishEnterpriseStandard(input: PublishEnterpriseStandardInput): Promise<EnterpriseStandardProfile> {
    input = normalizePublishEnterpriseStandardInput(input);
    await this.transaction(() => {
      const profile = this.getEnterpriseStandard(input.standardId);
      if (profile.revision !== input.expectedRevision) throw new Error('企业审核标准已发生变化，请刷新后重试。');
      const id = randomUUID(); const stamp = now(); const content = profile.draft; const sha256 = hash(content);
      const versionNo = Number(this.rows('SELECT COALESCE(MAX(version_no),0) AS n FROM rule_set_versions WHERE rule_set_id=?', [profile.id])[0].n) + 1;
      this.insert('rule_set_versions', { id, rule_set_id: profile.id, version_no: versionNo, jurisdiction: 'PRC', rules_json: json(content.rules), workflow_config_json: json({ ...content.workflow, checks: content.checks }), business_thresholds_json: json(content.thresholds), presentation_preferences_json: json({ name: content.name, description: content.description, contractTypes: content.contractTypes, partyRoles: content.partyRoles }), content_sha256: sha256, approved_by_label: input.publishedBy, published_at: stamp });
      this.insert('enterprise_standard_versions', { version_id: id, standard_id: profile.id, content_json: json(content), content_sha256: sha256 });
      this.db.run('UPDATE enterprise_standard_drafts SET revision=revision+1,updated_at=? WHERE standard_id=?', [stamp, profile.id]);
    });
    return this.getEnterpriseStandard(input.standardId);
  }

  getEnterpriseStandardVersion(id: string): EnterpriseStandardSnapshot {
    const row = this.rows('SELECT v.*,r.version_no,r.published_at,r.approved_by_label FROM enterprise_standard_versions v JOIN rule_set_versions r ON r.id=v.version_id AND r.rule_set_id=v.standard_id JOIN enterprise_standard_drafts d ON d.standard_id=v.standard_id JOIN rule_sets s ON s.id=d.standard_id WHERE v.version_id=? AND d.workspace_id=? AND s.workspace_id=?', [id, this.workspaceId, this.workspaceId])[0];
    if (!row) throw new Error('已发布企业标准版本不存在或不属于当前工作空间。');
    const content = normalizeEnterpriseStandardContent(parse<unknown>(row.content_json));
    if (hash(content) !== row.content_sha256) throw new Error('已发布企业标准版本校验失败。');
    return { id, standardId: String(row.standard_id), versionNo: Number(row.version_no), content, contentSha256: String(row.content_sha256), publishedAt: String(row.published_at), publishedBy: String(row.approved_by_label) };
  }

  private checkedEnterpriseSnapshot(input: EnterpriseStandardSnapshot): EnterpriseStandardSnapshot {
    const stored = this.getEnterpriseStandardVersion(input.id);
    if (input.standardId !== stored.standardId || input.versionNo !== stored.versionNo || input.contentSha256 !== stored.contentSha256 || input.publishedAt !== stored.publishedAt || input.publishedBy !== stored.publishedBy || hash(normalizeEnterpriseStandardContent(input.content)) !== stored.contentSha256) throw new Error('企业标准快照与已发布版本不匹配。');
    return stored;
  }

  getRiskDispositions(reviewId: string): RiskDispositionWorkspace {
    this.changeSource(reviewId);
    const row = this.rows('SELECT revision FROM risk_disposition_workspaces WHERE review_id=?', [reviewId])[0];
    const events = this.rows('SELECT * FROM risk_disposition_events WHERE review_id=? ORDER BY revision', [reviewId]).map(event => ({ id: String(event.id), reviewId, findingId: String(event.finding_id), status: event.status as RiskDispositionEvent['status'], reason: String(event.reason), actorLabel: String(event.actor_label), createdAt: String(event.created_at) }));
    return { reviewId, revision: row ? Number(row.revision) : 0, events };
  }

  async saveRiskDisposition(input: SaveRiskDispositionInput): Promise<RiskDispositionWorkspace> {
    input = normalizeSaveRiskDispositionInput(input);
    await this.transaction(() => {
      const source = this.changeSource(input.reviewId); const workspace = this.getRiskDispositions(input.reviewId);
      if (workspace.revision !== input.expectedRevision) throw new Error('风险处置记录已发生变化，请刷新后重试。');
      const review = this.getReview(input.reviewId);
      if (!review.findings.some(finding => finding.id === input.findingId) || !this.rows('SELECT id FROM findings WHERE id=? AND analysis_run_id=?', [input.findingId, source.run_id]).length) throw new Error('风险意见不属于本次不可变审核。');
      if (workspace.events.length >= 1000) throw new Error('本次审核已达到1000条处置历史上限，现有历史保留。');
      const stamp = now();
      if (!this.rows('SELECT review_id FROM risk_disposition_workspaces WHERE review_id=?', [input.reviewId]).length) this.insert('risk_disposition_workspaces', { review_id: input.reviewId, revision: 0, created_at: stamp, updated_at: stamp });
      this.insert('risk_disposition_events', { id: randomUUID(), review_id: input.reviewId, finding_id: input.findingId, revision: workspace.revision + 1, status: input.status, reason: input.reason, actor_label: input.actorLabel, created_at: stamp });
      this.db.run('UPDATE risk_disposition_workspaces SET revision=revision+1,updated_at=? WHERE review_id=?', [stamp, input.reviewId]);
    });
    return this.getRiskDispositions(input.reviewId);
  }

  getConfig(): PublicModelConfig | null {
    const row = this.rows("SELECT adapter_id,settings_json FROM provider_profiles WHERE workspace_id=? AND kind='model' AND adapter_id IN ('chat-completions','codex-cli') AND enabled=1 ORDER BY updated_at DESC,id LIMIT 1", [this.workspaceId])[0];
    if (!row) return null;
    const saved = parse<ModelConfigInput>(row.settings_json);
    // Legacy API settings omitted provider. Keep that shape while treating the
    // actual profile adapter as authoritative for all new provider settings.
    return { ...saved, ...(saved.provider !== undefined || row.adapter_id === 'codex-cli' ? { provider: row.adapter_id as 'chat-completions' | 'codex-cli' } : {}), hasApiKey: false, keyStorage: 'session-only' };
  }

  async saveConfig(config: ModelConfigInput): Promise<PublicModelConfig> {
    const adapter = config.provider ?? 'chat-completions';
    if (!['chat-completions', 'codex-cli'].includes(adapter)) throw new Error('模型连接类型无效。');
    // Explicit allow-list: authentication material belongs to the credential
    // owner (or Codex itself), even if a caller bypasses Service validation.
    const safe: Omit<ModelConfigInput, 'apiKey' | 'clearApiKey'> = {
      name: config.name, baseUrl: config.baseUrl, model: config.model,
      responseFormat: config.responseFormat, tokenParameter: config.tokenParameter,
      maxOutputTokens: config.maxOutputTokens, contextWindowTokens: config.contextWindowTokens,
      timeoutSeconds: config.timeoutSeconds,
      ...(config.provider === undefined ? {} : { provider: adapter }),
    };
    await this.transaction(() => {
      const old = this.rows("SELECT id FROM provider_profiles WHERE workspace_id=? AND kind='model' AND adapter_id=?", [this.workspaceId, adapter])[0];
      this.db.run("UPDATE provider_profiles SET enabled=0 WHERE workspace_id=? AND kind='model' AND adapter_id IN ('chat-completions','codex-cli') AND adapter_id<>?", [this.workspaceId, adapter]);
      if (old) {
        this.db.run('UPDATE provider_profiles SET name=?,endpoint=?,model_id=?,settings_json=?,enabled=1,updated_at=? WHERE id=?', [safe.name, safe.baseUrl, safe.model, json(safe), now(), old.id]);
        if (adapter === 'codex-cli') this.db.run('UPDATE provider_profiles SET credential_ref=NULL WHERE id=?', [old.id]);
      } else this.insert('provider_profiles', { id: randomUUID(), workspace_id: this.workspaceId, kind: 'model', name: safe.name, adapter_id: adapter, endpoint: safe.baseUrl, model_id: safe.model, credential_ref: adapter === 'codex-cli' ? null : 'default-model', capabilities_json: '{}', settings_json: json(safe), enabled: 1, created_at: now(), updated_at: now() });
    });
    return this.getConfig()!;
  }

  getRetrievalConfig(): PublicRetrievalConfig | null {
    const row = this.rows("SELECT settings_json FROM provider_profiles WHERE workspace_id=? AND adapter_id='retrieval-config' LIMIT 1", [this.workspaceId])[0];
    return row ? safeRetrievalConfig(parse<PublicRetrievalConfig>(row.settings_json)) : null;
  }

  async saveRetrievalConfig(config: PublicRetrievalConfig): Promise<PublicRetrievalConfig> {
    const safe = safeRetrievalConfig(config);
    await this.transaction(() => {
      const existing = this.rows("SELECT id FROM provider_profiles WHERE workspace_id=? AND adapter_id='retrieval-config'", [this.workspaceId])[0];
      if (existing) this.db.run('UPDATE provider_profiles SET settings_json=?,updated_at=? WHERE id=?', [json(safe), now(), existing.id]);
      else this.insert('provider_profiles', { id: randomUUID(), workspace_id: this.workspaceId, kind: 'knowledge', name: '检索设置', adapter_id: 'retrieval-config', endpoint: 'app://retrieval-config', model_id: null, credential_ref: null, capabilities_json: '{}', settings_json: json(safe), enabled: 1, created_at: now(), updated_at: now() });
      this.ensureRetrievalProviders(safe);
    });
    return this.getRetrievalConfig()!;
  }

  /** Connection identity includes the endpoint/collection/folder; old records remain valid after reconfiguration. */
  private ensureRetrievalProviders(config: PublicRetrievalConfig | null, connections: unknown[] = []): ProviderIds {
    if (!config && !connections.length) return {};
    config ??= defaultRetrievalConfig();
    const ids: ProviderIds = {};
    const ensure = (provider: RetrievalAttempt['provider'], kind: 'knowledge' | 'web', endpoint: string, settings: object, credentialRef: string | null): void => {
      const name = `检索 · ${provider} · ${hash({ provider, endpoint, settings }).slice(0, 16)}`;
      let row = this.rows('SELECT id FROM provider_profiles WHERE workspace_id=? AND kind=? AND name=? AND adapter_id=?', [this.workspaceId, kind, name, provider])[0];
      if (!row) {
        const id = randomUUID();
        this.insert('provider_profiles', { id, workspace_id: this.workspaceId, kind, name, adapter_id: provider, endpoint, model_id: null, credential_ref: credentialRef, capabilities_json: '{}', settings_json: json(settings), enabled: 1, created_at: now(), updated_at: now() });
        row = { id };
      }
      ids[provider] = String(row.id);
    };
    if (config.knowledge.folderPath) ensure('folder', 'knowledge', config.knowledge.folderPath, { folderPath: config.knowledge.folderPath, preferences: config.knowledge.preferences }, null);
    if (config.knowledge.api.baseUrl) ensure(config.knowledge.api.provider, 'knowledge', config.knowledge.api.baseUrl,
      { provider: config.knowledge.api.provider, baseUrl: config.knowledge.api.baseUrl, collectionId: config.knowledge.api.collectionId }, 'retrieval-knowledge');
    if (config.web.baseUrl) ensure(config.web.provider, 'web', config.web.baseUrl,
      { provider: config.web.provider, baseUrl: config.web.baseUrl, allowedDomains: config.web.allowedDomains, fetchPages: config.web.fetchPages }, 'retrieval-web');
    if (config.official?.enabled) ensure('official_catalog', 'web', 'https://xzfg.moj.gov.cn/search2.html', config.official, null);
    if (connections.length) { ensure('professional_mcp', 'web', 'app://configured-mcp', { connections }, 'extensions'); ensure('remote_index', 'knowledge', 'app://configured-index', { connections }, 'extensions'); }
    return ids;
  }

  findByHash(sha256: string): ContractDetail | null {
    const row = this.rows('SELECT d.id FROM document_versions d JOIN contracts c ON c.id=d.contract_id WHERE c.workspace_id=? AND d.file_sha256=? LIMIT 1', [this.workspaceId, sha256])[0];
    return row ? this.getDocument(String(row.id)) : null;
  }

  async addDocument(id: string, name: string, artifactUri: string, byteSize: number, sha256: string, parsed: ParsedContract, generationDraftId?: string, versionInput?: import('../shared/document-workspace').ImportVersionInput): Promise<ContractDetail> {
    let contractId: string = randomUUID(); const created = now();
    await this.transaction(() => {
      if (generationDraftId) this.getContractDraft(generationDraftId);
      let versionNo = 1;
      if (versionInput) {
        const parent = this.getDocument(versionInput.parentDocumentId);
        contractId = parent.contractId!;
        const contract = this.rows('SELECT lifecycle_status,project_id FROM contracts WHERE id=? AND workspace_id=?', [contractId, this.workspaceId])[0];
        if (contract.lifecycle_status !== 'active') throw new Error('请先恢复或取消归档合同，再导入新版本。');
        if (contract.project_id && this.rows('SELECT lifecycle_status FROM projects WHERE id=?', [contract.project_id])[0]?.lifecycle_status !== 'active') throw new Error('请先恢复合同所属项目。');
        const latest = this.rows('SELECT id,version_no FROM document_versions WHERE contract_id=? ORDER BY version_no DESC LIMIT 1', [contractId])[0];
        if (latest.id !== versionInput.expectedLatestDocumentId) throw new Error('合同已有更新版本，请刷新后重新选择关联关系。');
        versionNo = Number(latest.version_no) + 1;
        this.db.run('UPDATE contracts SET revision=revision+1,updated_at=? WHERE id=?', [created, contractId]);
      } else this.insert('contracts', { id: contractId, workspace_id: this.workspaceId, project_id: null, title: name, contract_type: 'other', our_party_role: null, governing_law_status: 'unknown', governing_law_text: null, transaction_context_json: '{}', created_at: created, updated_at: created });
      this.insert('document_versions', { id, contract_id: contractId, version_no: versionNo, parent_version_id: versionInput?.parentDocumentId ?? null, kind: versionInput ? 'revised' : 'original', source_name: name, source_format: parsed.format, artifact_uri: artifactUri, file_sha256: sha256, byte_size: byteSize, language: parsed.language, parse_status: parsed.partial ? 'partial' : 'ready', parse_issues_json: json(parsed.warnings.map(message => ({ code: 'PARSE_WARNING', severity: 'warning', message, locator: null }))), parser_snapshot_json: json({ parserVersion: '0.1.0', pageCount: parsed.pageCount, origin: versionInput ? 'external_version' : 'import' }), created_at: created });
      for (const b of parsed.blocks) this.insert('document_blocks', { id: b.id, document_version_id: id, block_key: String(b.ordinal), ordinal: b.ordinal, kind: b.kind, language: parsed.language, original_text: b.text, text_sha256: createHash('sha256').update(b.text).digest('hex'), locator_json: blockLocatorJson(b), created_at: created });
      if (generationDraftId) this.insert('contract_draft_exports', { id: randomUUID(), draft_id: generationDraftId, document_version_id: id, file_sha256: sha256, created_at: created });
    });
    return this.getDocument(id);
  }

  listContractDrafts(): ContractDraftSummary[] {
    return this.rows('SELECT id,title,language,model_id,created_at FROM contract_drafts WHERE workspace_id=? ORDER BY created_at DESC,id LIMIT 100', [this.workspaceId]).map(row => ({
      id: String(row.id), title: String(row.title), language: row.language as ContractDraftSummary['language'], modelId: String(row.model_id), createdAt: String(row.created_at),
    }));
  }
  findContractDraft(id: string): ContractDraft | null {
    const row = this.rows('SELECT content_json FROM contract_drafts WHERE id=? AND workspace_id=?', [id, this.workspaceId])[0];
    return row ? parse<ContractDraft>(row.content_json) : null;
  }
  getContractDraft(id: string): ContractDraft {
    const draft = this.findContractDraft(id);
    if (!draft) throw new Error('合同草稿不存在或不属于当前工作空间。');
    return draft;
  }
  async saveContractDraft(draft: ContractDraft): Promise<void> {
    // Persist only explicit generation fields; model settings and credentials
    // are never copied into the generated contract record.
    const safe: ContractDraft = { id: draft.id, title: draft.title, language: draft.language, createdAt: draft.createdAt, modelId: draft.modelId,
      request: { requestId: draft.request.requestId, description: draft.request.description, language: draft.request.language, contractType: draft.request.contractType, ourPartyRole: draft.request.ourPartyRole },
      clauses: draft.clauses.map(clause => ({ heading: clause.heading, paragraphs: [...clause.paragraphs] })), missingInformation: [...draft.missingInformation], warnings: [...draft.warnings], inputTokens: draft.inputTokens, outputTokens: draft.outputTokens };
    if (safe.id !== safe.request.requestId || safe.language !== safe.request.language || !safe.clauses.length) throw new Error('合同草稿的来源或内容无效。');
    await this.transaction(() => {
      this.insert('contract_drafts', { id: safe.id, workspace_id: this.workspaceId, title: safe.title, language: safe.language, model_id: safe.modelId, request_json: json(safe.request), content_json: json(safe), created_at: safe.createdAt });
    });
  }

  listDocuments(): ContractSummary[] {
    return this.rows('SELECT d.*, c.title FROM document_versions d JOIN contracts c ON c.id=d.contract_id WHERE c.workspace_id=? ORDER BY d.created_at DESC', [this.workspaceId]).map(row => this.summary(row));
  }

  private summary(row: Row): ContractSummary {
    const latest = this.rows("SELECT r.id FROM reports r JOIN analysis_runs a ON a.id=json_extract(r.input_manifest_json,'$.analysisRunIds[0]') WHERE a.document_version_id=? AND r.workspace_id=? AND r.kind='risk' ORDER BY r.created_at DESC LIMIT 1", [row.id, this.workspaceId])[0];
    const name = row.source_name ? String(row.source_name) : row.kind === 'revised' ? `${String(row.title).replace(/\.[^.]+$/, '')} · 修改稿 v${row.version_no}.docx` : String(row.title);
    const contract = this.rows('SELECT project_id,lifecycle_status,revision FROM contracts WHERE id=?', [row.contract_id])[0];
    return { id: String(row.id), contractId: String(row.contract_id), versionNo: Number(row.version_no), parentVersionId: row.parent_version_id ? String(row.parent_version_id) : null, versionKind: String(row.kind), projectId: contract?.project_id ? String(contract.project_id) : null, lifecycleStatus: contract?.lifecycle_status as ContractSummary['lifecycleStatus'], contractRevision: Number(contract?.revision ?? 1), name, format: row.source_format as 'docx' | 'pdf', language: row.language as ContractSummary['language'], byteSize: Number(row.byte_size), blockCount: Number(this.rows('SELECT COUNT(*) AS n FROM document_blocks WHERE document_version_id=?', [row.id])[0].n), importedAt: String(row.created_at), warnings: parse<Array<{message:string}>>(row.parse_issues_json).map(p => p.message), partial: row.parse_status === 'partial', latestReviewId: latest ? String(latest.id) : null };
  }

  getDocument(id: string): ContractDetail {
    const row = this.rows('SELECT d.*,c.title FROM document_versions d JOIN contracts c ON c.id=d.contract_id WHERE d.id=? AND c.workspace_id=?', [id, this.workspaceId])[0];
    if (!row) throw new Error('合同不存在或不属于当前工作空间。');
    const blocks = this.rows('SELECT * FROM document_blocks WHERE document_version_id=? ORDER BY ordinal', [id]).map(storedBlock);
    const reviews = this.rows("SELECT r.id FROM reports r JOIN analysis_runs a ON a.id=json_extract(r.input_manifest_json,'$.analysisRunIds[0]') WHERE a.document_version_id=? AND r.workspace_id=? AND r.kind='risk' ORDER BY r.created_at DESC", [id, this.workspaceId]).map(r => this.getReview(String(r.id)));
    return { ...this.summary(row), blocks, reviews };
  }

  /** Review/edit operations need the source once, never every historical report. */
  getDocumentForReview(id: string): ContractDetail {
    const row = this.rows('SELECT d.*,c.title FROM document_versions d JOIN contracts c ON c.id=d.contract_id WHERE d.id=? AND c.workspace_id=?', [id, this.workspaceId])[0];
    if (!row) throw new Error('合同不存在或不属于当前工作空间。');
    const blocks = this.rows('SELECT * FROM document_blocks WHERE document_version_id=? ORDER BY ordinal', [id]).map(storedBlock);
    return { ...this.summary(row), blocks, reviews: [] };
  }

  getDocumentArtifact(documentId: string): { artifactUri: string; sha256: string; byteSize: number; format: 'docx' | 'pdf' } {
    const row = this.rows('SELECT d.* FROM document_versions d JOIN contracts c ON c.id=d.contract_id WHERE d.id=? AND c.workspace_id=?', [documentId, this.workspaceId])[0];
    if (!row) throw new Error('合同不存在或不属于当前工作空间。');
    return { artifactUri: String(row.artifact_uri), sha256: String(row.file_sha256), byteSize: Number(row.byte_size), format: row.source_format as 'docx' | 'pdf' };
  }

  /** Resolve a review through its frozen run, never through renderer IDs alone. */
  private changeSource(reviewId: string): Row {
    const row = this.rows("SELECT r.content_json,a.id AS run_id,a.document_version_id,d.contract_id,d.file_sha256,d.source_format FROM reports r JOIN analysis_runs a ON a.id=json_extract(r.input_manifest_json,'$.analysisRunIds[0]') JOIN document_versions d ON d.id=a.document_version_id JOIN contracts c ON c.id=d.contract_id WHERE r.id=? AND r.kind='risk' AND r.workspace_id=? AND c.workspace_id=?", [reviewId, this.workspaceId, this.workspaceId])[0];
    if (!row) throw new Error('审核结果不存在或不属于当前工作空间。');
    const review = parse<{review?:ReviewResult}>(row.content_json).review;
    if (!review || review.id !== reviewId || review.documentId !== row.document_version_id) throw new Error('审核与原文版本不匹配。');
    return row;
  }

  getChangeRevision(reviewId: string): number {
    const source = this.changeSource(reviewId);
    const row = this.rows('SELECT * FROM change_workspaces WHERE review_id=?', [reviewId])[0];
    if (row && (row.source_document_version_id !== source.document_version_id || row.source_file_sha256 !== source.file_sha256)) throw new Error('改稿工作区的来源版本已失效，请重新审核。');
    return row ? Number(row.revision) : 0;
  }

  getEditableCopyAuthorization(reviewId: string): { enabled: boolean; enabledAt: string | null } {
    this.getChangeRevision(reviewId);
    const row = this.rows('SELECT editable_copy_enabled,editable_copy_enabled_at FROM change_workspaces WHERE review_id=?', [reviewId])[0];
    return { enabled: row?.editable_copy_enabled === 1, enabledAt: row?.editable_copy_enabled_at == null ? null : String(row.editable_copy_enabled_at) };
  }

  async enableEditableCopy(reviewId: string, expectedRevision: number): Promise<void> {
    await this.transaction(() => {
      const source = this.lockChangeRevision(reviewId, expectedRevision);
      if (source.source_format !== 'docx') throw new Error('仅DOCX支持启用可编辑副本。');
      // A retry is idempotent only after the caller's revision and immutable
      // source have been checked; a stale retry must still fail.
      if (this.getEditableCopyAuthorization(reviewId).enabled) return;
      const stamp = now();
      this.db.run('UPDATE change_workspaces SET editable_copy_enabled=1,editable_copy_enabled_at=? WHERE review_id=?', [stamp, reviewId]);
      this.insert('change_editable_copy_events', { id: randomUUID(), review_id: reviewId, source_document_version_id: source.document_version_id, source_file_sha256: source.file_sha256, enabled_at: stamp });
      this.bumpChangeRevision(reviewId);
    });
  }

  private lockChangeRevision(reviewId: string, expectedRevision: number): Row {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || this.getChangeRevision(reviewId) !== expectedRevision) throw new Error('修改清单已发生变化，请刷新后重试。');
    const source = this.changeSource(reviewId);
    if (!this.rows('SELECT review_id FROM change_workspaces WHERE review_id=?', [reviewId]).length) {
      const stamp = now();
      this.insert('change_workspaces', { review_id: reviewId, source_document_version_id: source.document_version_id, source_file_sha256: source.file_sha256, revision: 0, created_at: stamp, updated_at: stamp });
    }
    return source;
  }

  private bumpChangeRevision(reviewId: string): void {
    this.db.run('UPDATE change_workspaces SET revision=revision+1,updated_at=? WHERE review_id=?', [now(), reviewId]);
  }

  getChangeProposals(reviewId: string): ChangeProposal[] {
    this.changeSource(reviewId);
    return this.rows('SELECT p.*,m.review_id,m.source_file_sha256,m.explanation,m.warnings_json,m.model_id FROM change_proposals p JOIN change_proposal_meta m ON m.proposal_id=p.id WHERE m.review_id=? ORDER BY p.created_at,p.id', [reviewId]).map(row => ({
      id: String(row.id), reviewId: String(row.review_id), documentId: String(row.source_document_version_id), findingId: row.finding_id === null ? null : String(row.finding_id), blockId: String(row.document_block_id),
      rangeStart: Number(row.range_start), rangeEnd: Number(row.range_end), originalText: String(row.expected_original_text), replacementText: String(row.replacement_text),
      sourceFileSha256: String(row.source_file_sha256), originalTextSha256: String(row.expected_original_text_sha256), status: row.status as ChangeDecision,
      explanation: String(row.explanation), warnings: parse<string[]>(row.warnings_json), modelId: row.model_id === null ? null : String(row.model_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  getChangeExports(reviewId: string): ChangeExport[] {
    this.changeSource(reviewId);
    return this.rows('SELECT e.*,d.version_no FROM change_exports e JOIN document_versions d ON d.id=e.resulting_document_version_id WHERE e.review_id=? ORDER BY d.version_no', [reviewId]).map(row => ({
      id: String(row.id), reviewId: String(row.review_id), sourceDocumentId: String(row.source_document_version_id), documentId: String(row.resulting_document_version_id), versionNo: Number(row.version_no),
      createdAt: String(row.created_at), fileSha256: String(row.result_file_sha256), proposalIds: parse<{proposals:ChangeProposal[]}>(row.snapshot_json).proposals.map(proposal => proposal.id),
      format: parse<{format?:'clean'|'tracked'}>(row.snapshot_json).format ?? 'clean', revisionAuthor: parse<{revisionAuthor?:string|null}>(row.snapshot_json).revisionAuthor ?? null,
    }));
  }

  async saveChangeProposal(proposal: ChangeProposal, expectedRevision: number): Promise<void> {
    await this.transaction(() => {
      const source = this.lockChangeRevision(proposal.reviewId, expectedRevision);
      if (source.source_format !== 'docx' || proposal.documentId !== source.document_version_id || proposal.sourceFileSha256 !== source.file_sha256) throw new Error('修改建议与DOCX原文版本不匹配。');
      const block = this.rows('SELECT * FROM document_blocks WHERE id=? AND document_version_id=?', [proposal.blockId, proposal.documentId])[0];
      const original = block && String(block.original_text);
      const splitSurrogate = (offset: number) => Boolean(original && offset > 0 && offset < original.length && /[\uD800-\uDBFF]/.test(original[offset - 1]) && /[\uDC00-\uDFFF]/.test(original[offset]));
      if (!block || !Number.isSafeInteger(proposal.rangeStart) || !Number.isSafeInteger(proposal.rangeEnd) || proposal.rangeStart < 0 || proposal.rangeEnd <= proposal.rangeStart || proposal.rangeEnd > original!.length || splitSurrogate(proposal.rangeStart) || splitSurrogate(proposal.rangeEnd) || original!.slice(proposal.rangeStart, proposal.rangeEnd) !== proposal.originalText || createHash('sha256').update(proposal.originalText).digest('hex') !== proposal.originalTextSha256) throw new Error('修改建议的原文位置或校验值不匹配。');
      if (typeof proposal.replacementText !== 'string' || proposal.replacementText.length > 100000 || typeof proposal.explanation !== 'string' || !Array.isArray(proposal.warnings) || proposal.warnings.some(warning => typeof warning !== 'string')) throw new Error('修改建议内容无效。');
      if (proposal.findingId !== null && !this.rows('SELECT id FROM findings WHERE id=? AND analysis_run_id=?', [proposal.findingId, source.run_id]).length) throw new Error('关联意见不属于本次审核。');
      const existing = this.rows('SELECT * FROM change_proposals WHERE id=?', [proposal.id])[0];
      const previous = this.getChangeProposals(proposal.reviewId).find(item => item.id === proposal.id);
      const stamp = now();
      if (existing) {
        if (!previous || existing.analysis_run_id !== source.run_id || previous.documentId !== proposal.documentId || previous.findingId !== proposal.findingId || previous.blockId !== proposal.blockId || previous.rangeStart !== proposal.rangeStart || previous.rangeEnd !== proposal.rangeEnd || previous.originalText !== proposal.originalText || previous.originalTextSha256 !== proposal.originalTextSha256 || previous.sourceFileSha256 !== proposal.sourceFileSha256) throw new Error('修改建议的来源锚点不可更改，请新建建议。');
        this.db.run("UPDATE change_proposals SET replacement_text=?,status='proposed',updated_at=? WHERE id=?", [proposal.replacementText, stamp, proposal.id]);
        this.db.run('UPDATE change_proposal_meta SET explanation=?,warnings_json=?,model_id=? WHERE proposal_id=?', [proposal.explanation, json(proposal.warnings), proposal.modelId, proposal.id]);
      } else {
        const language = detectLanguage(proposal.originalText);
        this.insert('change_proposals', { id: proposal.id, analysis_run_id: source.run_id, finding_id: proposal.findingId, source_document_version_id: proposal.documentId, document_block_id: proposal.blockId,
          operation: 'replace', range_start: proposal.rangeStart, range_end: proposal.rangeEnd, expected_original_text: proposal.originalText, expected_original_text_sha256: proposal.originalTextSha256,
          replacement_text: proposal.replacementText, language: ['zh','en','th'].includes(language) ? language : 'zh', status: 'proposed', resulting_document_version_id: null, created_at: stamp, updated_at: stamp });
        this.insert('change_proposal_meta', { proposal_id: proposal.id, review_id: proposal.reviewId, source_file_sha256: source.file_sha256, explanation: proposal.explanation, warnings_json: json(proposal.warnings), model_id: proposal.modelId });
      }
      const after = this.getChangeProposals(proposal.reviewId).find(item => item.id === proposal.id)!;
      this.insert('change_proposal_events', { id: randomUUID(), review_id: proposal.reviewId, proposal_id: proposal.id, kind: previous ? 'edited' : 'created', before_json: previous ? json(previous) : null, after_json: json(after), created_at: stamp });
      this.bumpChangeRevision(proposal.reviewId);
    });
  }

  async decideChangeProposal(reviewId: string, proposalId: string, status: ChangeDecision, expectedRevision: number): Promise<void> {
    await this.transaction(() => {
      this.lockChangeRevision(reviewId, expectedRevision);
      if (!['proposed','accepted','rejected'].includes(status)) throw new Error('修改处理状态无效。');
      const previous = this.getChangeProposals(reviewId).find(proposal => proposal.id === proposalId);
      if (!previous) throw new Error('修改建议不存在或不属于本次审核。');
      if (status === 'accepted' && this.getChangeProposals(reviewId).some(proposal => proposal.id !== proposalId && proposal.status === 'accepted' && proposal.blockId === previous.blockId && proposal.rangeStart < previous.rangeEnd && previous.rangeStart < proposal.rangeEnd)) throw new Error('同一原文范围已有采纳的修改，请先撤回冲突建议。');
      const stamp = now(); this.db.run('UPDATE change_proposals SET status=?,updated_at=? WHERE id=?', [status, stamp, proposalId]);
      this.insert('change_proposal_events', { id: randomUUID(), review_id: reviewId, proposal_id: proposalId, kind: 'decision', before_json: json(previous), after_json: json({ ...previous, status, updatedAt: stamp }), created_at: stamp });
      this.bumpChangeRevision(reviewId);
    });
  }

  async addChangeExport(input: { id: string; reviewId: string; expectedRevision: number; documentId: string; artifactUri: string; sha256: string; byteSize: number; parsed: ParsedContract; proposals: ChangeProposal[]; changeList: string; format?: 'clean'|'tracked'; revisionAuthor?:string|null; revisionDate?:string|null }): Promise<ChangeExport> {
    let result!: ChangeExport;
    await this.transaction(() => {
      const source = this.lockChangeRevision(input.reviewId, input.expectedRevision);
      if (source.source_format !== 'docx' || input.parsed.format !== 'docx' || !/^[a-f0-9]{64}$/i.test(input.sha256) || !Number.isSafeInteger(input.byteSize) || input.byteSize <= 0 || !/^documents\//.test(input.artifactUri) || input.artifactUri.split('/').some(part => part === '..' || part === '.') || input.artifactUri.includes('\\') || input.artifactUri.includes('\0')) throw new Error('修改稿文件元数据无效。');
      const accepted = this.getChangeProposals(input.reviewId).filter(proposal => proposal.status === 'accepted');
      const stable = (proposals: ChangeProposal[]) => json([...proposals].sort((a,b) => a.id.localeCompare(b.id)).map(proposal => ({ id: proposal.id, reviewId: proposal.reviewId, documentId: proposal.documentId, findingId: proposal.findingId, blockId: proposal.blockId, rangeStart: proposal.rangeStart, rangeEnd: proposal.rangeEnd, originalText: proposal.originalText, replacementText: proposal.replacementText, sourceFileSha256: proposal.sourceFileSha256, originalTextSha256: proposal.originalTextSha256, status: proposal.status })));
      if (!accepted.length || stable(accepted) !== stable(input.proposals)) throw new Error('导出清单与当前采纳的修改不一致，请刷新后重试。');
      const versionNo = Number(this.rows('SELECT MAX(version_no) AS n FROM document_versions WHERE contract_id=?', [source.contract_id])[0].n) + 1;
      const stamp = now();
      this.db.run('UPDATE contracts SET revision=revision+1,updated_at=? WHERE id=?', [stamp,source.contract_id]);
      this.insert('document_versions', { id: input.documentId, contract_id: source.contract_id, version_no: versionNo, parent_version_id: source.document_version_id, kind: 'revised', source_format: 'docx', artifact_uri: input.artifactUri, file_sha256: input.sha256, byte_size: input.byteSize, language: input.parsed.language, parse_status: input.parsed.partial ? 'partial' : 'ready', parse_issues_json: json(input.parsed.warnings.map(message => ({ code: 'PARSE_WARNING', severity: 'warning', message, locator: null }))), parser_snapshot_json: json({ parserVersion: '0.1.0', pageCount: input.parsed.pageCount }), created_at: stamp });
      for (const block of input.parsed.blocks) this.insert('document_blocks', { id: block.id, document_version_id: input.documentId, block_key: String(block.ordinal), ordinal: block.ordinal, kind: block.kind, language: input.parsed.language, original_text: block.text, text_sha256: createHash('sha256').update(block.text).digest('hex'), locator_json: blockLocatorJson(block), created_at: stamp });
      this.insert('change_exports', { id: input.id, review_id: input.reviewId, source_document_version_id: source.document_version_id, resulting_document_version_id: input.documentId, source_file_sha256: source.file_sha256, result_file_sha256: input.sha256, snapshot_json: json({ revision: input.expectedRevision, proposals: accepted, sourceFileSha256: source.file_sha256, resultFileSha256: input.sha256, editableCopyAuthorization: this.getEditableCopyAuthorization(input.reviewId), format: input.format ?? 'clean', revisionAuthor: input.revisionAuthor ?? null, revisionDate: input.revisionDate ?? null }), change_list: input.changeList, created_at: stamp });
      this.bumpChangeRevision(input.reviewId);
      result = { id: input.id, reviewId: input.reviewId, sourceDocumentId: String(source.document_version_id), documentId: input.documentId, versionNo, createdAt: stamp, fileSha256: input.sha256, proposalIds: accepted.map(proposal => proposal.id), format: input.format ?? 'clean', revisionAuthor: input.revisionAuthor ?? null };
    });
    return result;
  }

  async createTask(task: ReviewTask, context: ReviewContext, mode: 'model' | 'local', retrievalConfig: PublicRetrievalConfig | null = this.getRetrievalConfig(), modelConfig: PublicModelConfig | null = this.getConfig(), standardSnapshot?: EnterpriseStandardSnapshot, extensions?: { experienceSnapshot: unknown[]; connections: unknown[] }): Promise<string> {
    const doc = this.rows('SELECT d.contract_id,d.file_sha256 FROM document_versions d JOIN contracts c ON c.id=d.contract_id WHERE d.id=? AND c.workspace_id=?', [task.documentId, this.workspaceId])[0];
    if (!doc) throw new Error('合同不存在。');
    const standard = standardSnapshot ? this.checkedEnterpriseSnapshot(standardSnapshot) : undefined;
    if (standard && (!standard.content.contractTypes.includes(context.contractType) || !standard.content.partyRoles.includes(context.ourPartyRole))) throw new Error('所选企业审核标准不适用于当前合同类型或我方立场。');
    const rule = standard ? { id: standard.id } : this.rows('SELECT v.id FROM rule_set_versions v JOIN rule_sets r ON r.id=v.rule_set_id WHERE r.workspace_id=? AND NOT EXISTS(SELECT 1 FROM enterprise_standard_versions e WHERE e.version_id=v.id) LIMIT 1', [this.workspaceId])[0];
    if (!rule) throw new Error('基础审核规则版本不存在。');
    const adapter = mode === 'local' ? 'local-rules' : modelConfig?.provider ?? 'chat-completions';
    // Use the captured run configuration rather than the currently active
    // provider: saving another connection must not rebind an already-starting run.
    const provider = this.rows("SELECT id FROM provider_profiles WHERE workspace_id=? AND kind='model' AND adapter_id=? LIMIT 1", [this.workspaceId, adapter])[0];
    if (!provider) throw new Error('请先保存模型连接配置。');
    const runId = randomUUID();
    const retrieval = retrievalConfig ? safeRetrievalConfig(retrievalConfig) : null;
    await this.transaction(() => {
      const retrievalSnapshot: RetrievalSnapshot = { mode, config: retrieval, providerProfileIds: this.ensureRetrievalProviders(retrieval, extensions?.connections), ...(extensions ? { connectionSnapshots: extensions.connections } : {}) };
      this.insert('analysis_runs', { id: runId, contract_id: doc.contract_id, kind: 'review', document_version_id: task.documentId, template_version_id: null, output_document_version_id: null, rule_set_version_id: rule.id, model_provider_profile_id: provider.id, status: 'queued', jurisdiction: 'PRC', our_party_role: context.ourPartyRole, report_language: 'zh', input_snapshot_json: json({ context, mode, documentHash: doc.file_sha256, ...(extensions ? { experienceSnapshot: extensions.experienceSnapshot } : {}), ...(standard ? { standardSnapshot: standard } : {}) }), model_snapshot_json: json(mode === 'model' ? modelConfig : { adapter: 'local-rules' }), prompt_snapshot_json: json({ schemaVersion: 1, capturePolicy: 'actual-request-sha256-in-model-runtime-ledger', modelRuntimeTaskId: task.id, ...(standard ? { standardSnapshot: standard } : {}) }), retrieval_policy_snapshot_json: json(retrievalSnapshot), applied_memory_revision_ids_json: json(extensions?.experienceSnapshot ?? []), input_fingerprint: hash({ doc: doc.file_sha256, context, config: modelConfig, retrieval, ...(standard ? { standardSnapshot: standard } : {}) }), supersedes_run_id: null, created_at: task.startedAt, started_at: null, finished_at: null });
      this.insert('tasks', { id: task.id, workspace_id: this.workspaceId, analysis_run_id: runId, kind: 'review', status: 'queued', stage: task.stage, progress: null, attempt_no: 0, max_attempts: 1, idempotency_key: task.id, checkpoint_json: json(task), error_code: null, error_message: null, input_tokens: null, output_tokens: null, estimated_cost_json: null, created_at: task.startedAt, updated_at: now() });
    });
    return runId;
  }

  async updateTask(task: ReviewTask, runId: string): Promise<void> {
    this.requireRun(runId);
    await this.transaction(() => {
      const current = this.rows('SELECT checkpoint_json FROM tasks WHERE id=? AND analysis_run_id=? AND workspace_id=?', [task.id, runId, this.workspaceId])[0];
      if (!current) throw new Error('审核任务与批次不匹配。');
      const checkpoint = { ...parse<TaskCheckpoint>(current.checkpoint_json), ...task };
      this.db.run('UPDATE tasks SET status=?,stage=?,checkpoint_json=?,error_message=?,updated_at=? WHERE id=? AND workspace_id=?', [task.status === 'completed' ? 'succeeded' : task.status, task.stage, json(checkpoint), task.error, now(), task.id, this.workspaceId]);
      this.db.run('UPDATE analysis_runs SET status=?,finished_at=? WHERE id=?', [task.status === 'completed' ? 'awaiting_review' : task.status, task.finishedAt, runId]);
    });
  }

  listTasks(): ReviewTask[] {
    return this.rows("SELECT * FROM tasks WHERE workspace_id=? AND kind='review' ORDER BY created_at DESC LIMIT 30", [this.workspaceId]).map(row => {
      const { retrievalAudit: _audit, ...task } = parse<TaskCheckpoint>(row.checkpoint_json);
      if (row.error_code === 'INTERRUPTED') return { ...task, status: 'failed', stage: '任务中断', error: String(row.error_message), finishedAt: String(row.updated_at) };
      return task;
    });
  }

  private requireRun(runId: string): Row {
    const run = this.rows('SELECT a.* FROM analysis_runs a JOIN contracts c ON c.id=a.contract_id WHERE a.id=? AND c.workspace_id=?', [runId, this.workspaceId])[0];
    if (!run) throw new Error('审核批次不存在或不属于当前工作空间。');
    return run;
  }

  async saveRetrievalBundle(runId: string, bundle: RetrievalBundle): Promise<void> {
    this.requireRun(runId);
    await this.transaction(() => this.persistRetrievalBundle(runId, bundle));
  }

  private persistRetrievalBundle(runId: string, bundle: RetrievalBundle): void {
    const run = this.requireRun(runId);
    const snapshot = parse<RetrievalSnapshot>(run.retrieval_policy_snapshot_json);
    const expected = safeRetrievalConfig(snapshot.config ?? defaultRetrievalConfig());
    if (snapshot.mode !== 'model' || hash(expected) !== hash(safeRetrievalConfig(bundle.configSnapshot))) {
      throw new Error('检索结果与审核开始时的配置快照不一致，未保存来源。');
    }
    const attemptIds = new Set<string>();
    for (const attempt of bundle.attempts) {
      if (attemptIds.has(attempt.id)) throw new Error('检索结果包含重复任务标识。');
      attemptIds.add(attempt.id);
      const providerId = snapshot.providerProfileIds[attempt.provider];
      const provider = providerId && this.rows('SELECT kind,adapter_id FROM provider_profiles WHERE id=? AND workspace_id=?', [providerId, this.workspaceId])[0];
      if (!provider || provider.kind !== attempt.channel || provider.adapter_id !== attempt.provider) throw new Error('检索任务与固定的连接器配置不匹配。');
      const old = this.rows('SELECT analysis_run_id,query,status,result_count FROM retrieval_attempts WHERE id=?', [attempt.id])[0];
      if (old) {
        if (old.analysis_run_id !== runId || old.query !== attempt.query || old.status !== attempt.status || Number(old.result_count) !== attempt.resultCount) throw new Error('检索记录标识冲突。');
        continue;
      }
      this.insert('retrieval_attempts', { id: attempt.id, analysis_run_id: runId, question_id: null, provider_profile_id: providerId, channel: attempt.channel, query: attempt.query, query_language: detectLanguage(attempt.query) === 'en' ? 'en' : detectLanguage(attempt.query) === 'th' ? 'th' : 'zh', filters_json: json({ provider: attempt.provider, warnings: attempt.warnings, error: attempt.error, coverage: attempt.coverage, connectionId: attempt.connectionId }), status: attempt.status, result_count: attempt.resultCount, error_code: attempt.error ? `RETRIEVAL_${attempt.status.toUpperCase()}` : null, started_at: attempt.startedAt, finished_at: attempt.finishedAt, created_at: attempt.startedAt });
    }
    const evidenceIds = new Set<string>();
    for (const evidence of bundle.evidence) {
      if (evidenceIds.has(evidence.id)) throw new Error('检索结果包含重复来源标识。');
      evidenceIds.add(evidence.id);
      const attempt = bundle.attempts.find(item => item.id === evidence.attemptId);
      if (!attempt || attempt.channel !== evidence.channel) throw new Error('来源没有属于本次检索的有效任务。');
      const excerptSha256 = createHash('sha256').update(evidence.excerpt).digest('hex');
      if (excerptSha256 !== evidence.excerptSha256) throw new Error('来源摘录校验和不一致。');
      const old = this.rows('SELECT analysis_run_id,excerpt_sha256 FROM evidence WHERE id=?', [evidence.id])[0];
      if (old) {
        if (old.analysis_run_id !== runId || old.excerpt_sha256 !== excerptSha256) throw new Error('来源记录标识冲突。');
        continue;
      }
      this.insert('evidence', { id: evidence.id, analysis_run_id: runId, retrieval_attempt_id: evidence.attemptId,
        kind: evidence.kind, origin: evidence.channel, external_source_id: evidence.sourceUri,
        title: evidence.title, source_url: evidence.sourceUri, source_locator_json: json({ locator: evidence.locator, contentScope: evidence.contentScope }),
        original_excerpt: evidence.excerpt, excerpt_sha256: excerptSha256, language: detectLanguage(evidence.excerpt),
        source_version: evidence.localIndex?.versionId ?? evidence.officialMetadata?.versionLabel ?? null, jurisdiction: evidence.officialMetadata ? 'PRC' : null, issued_on: dateOnly(evidence.publishedAt), effective_from: dateOnly(evidence.effectiveAt), effective_to: null,
        retrieved_at: evidence.retrievedAt, currentness: 'unknown', verification_status: 'unverified',
        verification_notes: '仅记录取回文本；来源真实性、法律效力、适用性和时效均需法务核验。', conflict_group_id: null,
        metadata_json: json({ contentScope: evidence.contentScope, isOfficial: evidence.isOfficial, warnings: evidence.warnings,
          publishedAt: evidence.publishedAt, effectiveAt: evidence.effectiveAt, localIndex: evidence.localIndex, officialMetadata: evidence.officialMetadata, connection: evidence.connection }) });
    }
    const task = this.rows('SELECT id,checkpoint_json FROM tasks WHERE analysis_run_id=? AND workspace_id=?', [runId, this.workspaceId])[0];
    if (task) {
      const checkpoint = parse<TaskCheckpoint>(task.checkpoint_json);
      checkpoint.retrievalAudit = { knowledgeStatus: bundle.knowledgeStatus, webStatus: bundle.webStatus, officialStatus: bundle.officialStatus, searchStatus: bundle.searchStatus, limitations: [...bundle.limitations] };
      this.db.run('UPDATE tasks SET checkpoint_json=?,updated_at=? WHERE id=?', [json(checkpoint), now(), task.id]);
    }
  }

  getRetrievalBundle(runId: string): RetrievalBundle | null {
    const run = this.requireRun(runId);
    const snapshot = parse<RetrievalSnapshot>(run.retrieval_policy_snapshot_json);
    const task = this.rows('SELECT checkpoint_json FROM tasks WHERE analysis_run_id=? AND workspace_id=? LIMIT 1', [runId, this.workspaceId])[0];
    const audit = task ? parse<TaskCheckpoint>(task.checkpoint_json).retrievalAudit : undefined;
    if (!audit) return null;
    const attempts: RetrievalAttempt[] = this.rows('SELECT a.*,p.adapter_id FROM retrieval_attempts a JOIN provider_profiles p ON p.id=a.provider_profile_id WHERE a.analysis_run_id=? ORDER BY a.started_at,a.id', [runId]).map(row => {
      const details = parse<{ provider: RetrievalAttempt['provider']; warnings: string[]; error: string | null; coverage?: RetrievalAttempt['coverage']; connectionId?: string }>(row.filters_json);
      return { id: String(row.id), channel: row.channel as RetrievalAttempt['channel'], provider: row.adapter_id as RetrievalAttempt['provider'], query: String(row.query), status: row.status as RetrievalAttempt['status'], startedAt: String(row.started_at), finishedAt: String(row.finished_at), resultCount: Number(row.result_count), error: details.error, warnings: details.warnings, ...(details.coverage ? { coverage: details.coverage } : {}), ...(details.connectionId ? { connectionId: details.connectionId } : {}) };
    });
    const evidence: SourceEvidence[] = this.rows('SELECT * FROM evidence WHERE analysis_run_id=? ORDER BY retrieved_at,id', [runId]).map(row => {
      const locator = parse<{ locator: string; contentScope: SourceEvidence['contentScope'] }>(row.source_locator_json);
      const details = parse<{ isOfficial: boolean; warnings: string[]; publishedAt: string | null; effectiveAt: string | null; localIndex?: SourceEvidence['localIndex']; officialMetadata?: SourceEvidence['officialMetadata']; connection?: SourceEvidence['connection'] }>(row.metadata_json);
      return { id: String(row.id), attemptId: String(row.retrieval_attempt_id), channel: row.origin as SourceEvidence['channel'], kind: row.kind as SourceEvidence['kind'], title: String(row.title), sourceUri: row.source_url === null ? null : String(row.source_url), locator: locator.locator, excerpt: String(row.original_excerpt), excerptSha256: String(row.excerpt_sha256), contentScope: locator.contentScope, retrievedAt: String(row.retrieved_at), publishedAt: details.publishedAt, effectiveAt: details.effectiveAt, currentness: 'unknown', isOfficial: details.isOfficial, warnings: details.warnings, ...(details.localIndex ? { localIndex: details.localIndex } : {}), ...(details.officialMetadata ? { officialMetadata: details.officialMetadata } : {}), ...(details.connection ? { connection: details.connection } : {}) };
    });
    return { configSnapshot: safeRetrievalConfig(snapshot.config ?? defaultRetrievalConfig()), ...audit, attempts, evidence };
  }

  async saveReview(result: ReviewResult, runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (run.document_version_id !== result.documentId) throw new Error('审核结果与原文版本不匹配。');
    const frozenStandard = parse<{ standardSnapshot?: EnterpriseStandardSnapshot }>(run.input_snapshot_json).standardSnapshot;
    if (Boolean(frozenStandard) !== Boolean(result.standardSnapshot) || (frozenStandard && result.standardSnapshot && json(this.checkedEnterpriseSnapshot(result.standardSnapshot)) !== json(frozenStandard))) throw new Error('审核结果的企业标准与冻结版本不匹配。');
    await this.transaction(() => {
      if (result.retrieval) this.persistRetrievalBundle(runId, result.retrieval);
      const sources = this.rows('SELECT * FROM evidence WHERE analysis_run_id=?', [runId]);
      const sourceMap = new Map(sources.map(source => [String(source.id), source]));
      for (const f of result.findings) {
        this.insert('findings', { id: f.id, analysis_run_id: runId, rule_key: f.source === 'rule' ? f.checkKey ?? f.title : null, category: f.category, severity: f.severity, legal_review_status: 'unreviewed', title: f.title, description: f.description, triggering_facts_json: json([f.quote]), assumptions_json: '[]', recommendation: f.suggestion, unresolved_questions_json: json(f.legalBasis ? [`待核实依据：${f.legalBasis}`] : []), document_block_ids_json: json(f.blockIds), created_at: result.createdAt, updated_at: result.createdAt });
        const grouped = new Map<string, Array<{ quote: string; matched: boolean; originalTextRead: boolean }>>();
        for (const citation of f.citations ?? []) {
          const source = sourceMap.get(citation.evidenceId);
          if (!source) continue; // Unresolved model IDs remain visibly unmatched in the report, never become invented rows.
          const quote = normalizeQuote(citation.quote);
          const matched = citation.matchStatus === 'matched' && quote.length > 0 && normalizeQuote(String(source.original_excerpt)).includes(quote);
          const locator = parse<{ contentScope: SourceEvidence['contentScope'] }>(source.source_locator_json);
          grouped.set(citation.evidenceId, [...grouped.get(citation.evidenceId) ?? [], { quote: citation.quote, matched, originalTextRead: locator.contentScope !== 'search_snippet' }]);
        }
        for (const [evidenceId, citations] of grouped) this.insert('finding_evidence', { finding_id: f.id, evidence_id: evidenceId, relation: citations.some(citation => citation.matched && citation.originalTextRead) ? 'supports' : 'context', explanation: json({ citations, limitation: '引文文字匹配不代表法律效力、时效或适用性已经核验。' }) });
      }
      const modelEvidenceIds = (result.retrieval as (RetrievalBundle & { modelEvidenceIds?: string[] }) | undefined)?.modelEvidenceIds ?? null;
      const manifest = { analysisRunIds: [runId], documentVersionIds: [result.documentId], evidenceIds: sources.map(source => source.id), ruleSetVersionIds: [run.rule_set_version_id], findingSnapshots: result.findings,
        evidenceVerificationSnapshots: sources.map(source => ({ evidenceId: source.id, excerptSha256: source.excerpt_sha256, verificationStatus: source.verification_status, currentness: source.currentness })), changeProposalSnapshots: [],
        scopeDescription: result.retrieval ? '合同相关审核；各检索通道和来源范围另列，法律适用、效力及时效均待人工核验。' : '基础审核；未接知识库与互联网，法律依据尚待人工核验。',
        unavailableSources: (['knowledge', 'web'] as const).flatMap(channel => result.coverage[`${channel}Status`] === 'complete' ? [] : [{ channel, reason: result.coverage[`${channel}Status`] }]),
        retrievalConfigSnapshot: parse<unknown>(run.retrieval_policy_snapshot_json), ...(result.standardSnapshot ? { standardSnapshot: result.standardSnapshot } : {}), ...(result.programChecks ? { programChecks: result.programChecks } : {}),
        retrievalAttempts: result.retrieval?.attempts.map(attempt => ({ attemptId: attempt.id, channel: attempt.channel, provider: attempt.provider, query: attempt.query, status: attempt.status, resultCount: attempt.resultCount })) ?? [],
        modelEvidenceIds, calculationDefinitions: { findings: '本次审核意见条数，不等于合同违法事项数量', elapsedMs: '本次检索和模型/本地审核总耗时，不包含导入和用户操作' },
        calculationResults: { findings: result.findings.length, elapsedMs: result.elapsedMs }, generatedBySnapshot: { modelId: result.modelId, mode: result.mode } };
      this.insert('reports', { id: result.id, workspace_id: this.workspaceId, report_key: runId, version_no: 1, kind: 'risk', language: 'zh', status: 'draft', input_manifest_json: json(manifest), content_json: json({ review: result }), artifact_uri: null, file_sha256: null, created_at: result.createdAt });
      this.insert('report_sources', { id: randomUUID(), report_id: result.id, analysis_run_id: runId, evidence_id: null, document_version_id: null, purpose: '审核批次及配置快照' });
      this.insert('report_sources', { id: randomUUID(), report_id: result.id, analysis_run_id: null, evidence_id: null, document_version_id: result.documentId, purpose: '合同原文版本' });
      for (const source of sources) this.insert('report_sources', { id: randomUUID(), report_id: result.id, analysis_run_id: null, evidence_id: source.id, document_version_id: null, purpose: modelEvidenceIds?.includes(String(source.id)) ? '本次模型输入来源；引文关系另行核对' : '检索候选来源；未声明已发送给模型或已核验法律效力' });
      this.db.run('UPDATE tasks SET input_tokens=?,output_tokens=? WHERE analysis_run_id=?', [result.inputTokens, result.outputTokens, runId]);
    });
  }

  getReview(id: string): ReviewResult {
    const row = this.rows('SELECT content_json,input_manifest_json FROM reports WHERE id=? AND workspace_id=?', [id, this.workspaceId])[0];
    if (!row) throw new Error('审核结果不存在。');
    const review = parse<{review:ReviewResult}>(row.content_json).review;
    if (!review.retrieval) return review; // Existing reports without retrieval remain readable.
    const manifest = parse<{ analysisRunIds: string[] }>(row.input_manifest_json);
    const retrieval = this.getRetrievalBundle(manifest.analysisRunIds[0]);
    return retrieval ? { ...review, retrieval: { ...review.retrieval, ...retrieval } } : review;
  }

  async close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closingPromise = (async () => {
      await this.transactionQueue;
      if (this.closed) return;
      try { await this.flush(); } finally { try { this.db.close(); this.closed = true; } finally { await this.releaseLease(); } }
    })();
    return this.closingPromise;
  }
}
