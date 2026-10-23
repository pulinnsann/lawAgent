import { randomUUID, createHash } from 'node:crypto';
import { APP_VERSION } from '../shared/app-version';
import { mkdir, readFile, writeFile, stat, rm, realpath, lstat, open } from 'node:fs/promises';
import { join, basename, extname, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { defaultRetrievalConfig } from '../shared/contracts';
import type { AppState, ContractDetail, ModelConfigInput, PublicRetrievalConfig, RetrievalBundle, RetrievalConfigInput, ReviewResult, ReviewTask, StartReviewInput } from '../shared/contracts';
import { AppStore } from './storage';
import { parseContract } from './documents';
import { createSampleContract } from './sample';
import { reviewContract } from './review';
import { reviewWithBatches } from './batched-review';
import { testConnection, validateModelConfig } from './model';
import { retrieveContext, retrieveOfficialContext, validateRetrievalConfig } from './retrieval';
import type { OfficialPageReader } from './official-sources';
import { LocalKnowledgeIndex } from './knowledge-index';
import type { KnowledgePort, KnowledgePreferences, KnowledgeSearchInput, KnowledgeSyncMode, KnowledgeSyncJob } from '../shared/knowledge';
import type { ConfigureKnowledgeInput, ConfigureKnowledgeResult, EnvironmentReport } from '../shared/setup';
import { defaultKnowledgePreferences, intersectKnowledgePreferences, normalizeKnowledgePreferences } from '../shared/knowledge-preferences';
import { runEnvironmentProbe } from './setup-environment';
import type { ChangeWorkspace, ChangeProposal, ChangeTarget, SaveChangeInput, GenerateChangeInput, DecideChangeInput, ExportChangesInput, ExportChangesResult, EnableEditableCopyInput } from '../shared/changes';
import { inspectDocxTargets, inspectDocxEditProtection, createDocxEditableCopy, applyDocxPatches, applyDocxTrackedPatches, type DocxTextPatch } from './docx-patcher';
import { CHANGE_TEXT_LIMIT, draftContractChange } from './change-drafting';
import type { ContractDraft, GenerateContractInput, ExportContractDraftInput, ExportContractDraftResult } from '../shared/generation';
import { normalizeGenerateContractInput, generateContractDraft, buildGeneratedContractDocx } from './contract-generation';
import { WorkspaceAssets } from './workspace-assets';
import { runDocumentWorkspaceCommand, visibleDocuments, assertDocumentActive } from './workspace-documents';
import { generateReferenceTranslation } from './reference-translation';
import { clauseAlignmentSnapshot, runClauseAlignmentCommand, requestAlignmentComparison } from './workspace-clause-alignment';
import { inspectContractPurge, purgeContract } from './document-purge';
import { runLibraryCommand, getExperienceResolution } from './workspace-library';
import { getApplicableAdvisorPackages } from './workspace-advisor';
import { runAuthoringCommand, assertAuthoringExport } from './workspace-authoring-completion';
import { runReviewCompletionCommand, getWorkflowBeforeReview, getWorkflowAfterReview } from './workspace-review-completion';
import { runModelRuntimeCommand, withModelRuntime, recordModelStage, recoverModelRuntimeRuns } from './model-runtime';
import { runReportingCommand } from './reporting';
import { generateReportTranslation } from './report-translation';
import { runConnectionCommand, retrieveConnectionEvidence, crossCheckSources, type ConnectionSecrets } from './workspace-connections';
import { retrievalTopics } from './retrieval';
import type { ExperienceSnapshot } from '../shared/library';
import type { WorkspaceCommand } from '../shared/workspace-tools';
import type { WorkspaceAsset } from './workspace-assets';
import type { EnterpriseStandardSnapshot, SaveEnterpriseStandardInput, PublishEnterpriseStandardInput, SaveRiskDispositionInput, RiskDispositionWorkspace } from '../shared/assurance';

export type RetrievalKeys = { knowledgeApiKey: string | null; webApiKey: string | null };
const noRetrievalKeys = (): RetrievalKeys => ({ knowledgeApiKey: null, webApiKey: null });
class KnowledgeScopeChangedError extends Error {
  constructor() { super('知识库资料范围已更改，本次审核已取消，请按新配置重新开始。'); }
}
function localKnowledgeScope(config: PublicRetrievalConfig | null): string {
  const preferences = config?.knowledge.preferences ?? defaultKnowledgePreferences();
  return JSON.stringify({ enabled: config?.knowledge.enabled ?? false, folderPath: config?.knowledge.folderPath ?? null, fileTypes: [...preferences.fileTypes].sort(), excludeDirectories: [...preferences.excludeDirectories].sort(), maxFileSizeMb: preferences.maxFileSizeMb });
}

function redactSecrets<T>(value: T, secrets: Array<string | null>): T {
  const keys = [...new Set(secrets.filter((key): key is string => Boolean(key?.trim())).map(key => key.trim()))];
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return keys.reduce((text, key) => text.split(key).join('[REDACTED]'), item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, data]) => [key, visit(data)]));
    return item;
  };
  return visit(value) as T;
}

function safeBundle(bundle: RetrievalBundle, secrets: Array<string | null>): RetrievalBundle {
  const safe = redactSecrets(bundle, secrets);
  safe.evidence = safe.evidence.map((source, index) => ({ ...source,
    excerptSha256: createHash('sha256').update(source.excerpt).digest('hex'),
    warnings: source.excerpt !== bundle.evidence[index]?.excerpt ? [...source.warnings, '摘录中的连接凭据已隐去。'] : source.warnings,
  }));
  return safe;
}

export class ContractService {
  readonly assets: WorkspaceAssets;
  private extensionJobs = new Map<string,AbortController>();
  private extensionDone = new Map<string,Promise<void>>();
  private extensionProgress = new Map<string,unknown>();
  private active = new Map<string, { controller: AbortController; runId: string; task: ReviewTask; done: Promise<void>; mode: StartReviewInput['mode'] }>();
  private starting = new Set<string>();
  private importing = 0;
  private startingDone = new Map<string, Promise<void>>();
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private runtimeReady: Promise<void>;
  private officialTests = new Set<AbortController>();
  private changeDrafts = new Map<string, { controller: AbortController; done: Promise<ChangeWorkspace> }>();
  private contractGenerations = new Map<string, { controller: AbortController; done: Promise<ContractDraft> }>();
  private knowledge: KnowledgePort;
  private knowledgeTask: { id: string; folderPath: string; controller: AbortController; done: Promise<void>; job: KnowledgeSyncJob | null } | null = null;
  private knowledgeTimer: ReturnType<typeof setInterval> | null = null;
  private knowledgeSettingsRevision = 0;
  private knowledgeScopeRevision = 0;
  constructor(private store: AppStore, private dataDir: string, private emit: (task: ReviewTask) => void = () => {}, knowledge?: KnowledgePort, private officialReader?: OfficialPageReader) {
    this.assets = new WorkspaceAssets(store, operation => this.write(operation));
    this.runtimeReady = recoverModelRuntimeRuns(this.assets).then(()=>{});
    void this.runtimeReady.catch(()=>{});
    this.knowledge = knowledge ?? new LocalKnowledgeIndex(dataDir);
    this.scheduleKnowledge();
    void this.refreshKnowledge().catch(() => {});
  }

  private knowledgePreferences(): KnowledgePreferences {
    return this.store.getRetrievalConfig()?.knowledge.preferences ?? defaultKnowledgePreferences();
  }
  private scheduleKnowledge(): void {
    if (this.knowledgeTimer) clearInterval(this.knowledgeTimer);
    this.knowledgeTimer = null;
    const preferences = this.knowledgePreferences();
    const config = this.store.getRetrievalConfig();
    if (this.closing || !preferences.autoSyncEnabled || !config?.knowledge.enabled || !config.knowledge.folderPath) return;
    this.knowledgeTimer = setInterval(() => { void this.refreshKnowledge().catch(() => {}); }, preferences.syncIntervalMinutes * 60 * 1000);
    this.knowledgeTimer.unref();
  }
  private applyKnowledgeSettings(previous: PublicRetrievalConfig | null, next: PublicRetrievalConfig): void {
    this.knowledgeSettingsRevision++;
    if (localKnowledgeScope(previous) !== localKnowledgeScope(next)) {
      this.knowledgeScopeRevision++;
      for (const task of this.active.values()) if (task.mode === 'model') task.controller.abort(new KnowledgeScopeChangedError());
    }
    this.scheduleKnowledge();
  }
  async checkEnvironment(): Promise<EnvironmentReport> {
    try {
      if (this.knowledge.checkEnvironment) return await this.knowledge.checkEnvironment();
      const result = await runEnvironmentProbe(this.dataDir);
      await this.knowledge.getState(null);
      result.checks.push({ id: 'index_worker', label: '后台索引服务', status: 'passed', message: '本地索引端口响应正常。' });
      return result;
    } catch {
      return { checkedAt: new Date().toISOString(), ready: false, isPreview: false, checks: [{ id: 'index_worker', label: '后台索引服务', status: 'failed', message: '后台环境检查未能完成，请重启软件后重试。' }] };
    }
  }
  async configureLocalKnowledge(input: ConfigureKnowledgeInput): Promise<ConfigureKnowledgeResult> {
    const preferences = normalizeKnowledgePreferences(input.preferences);
    const config = await this.write(async () => {
      if (this.closing) throw new Error('应用正在关闭，无法保存配置。');
      if (this.knowledgeTask) throw new Error('知识库正在同步，请先取消或等待完成后再保存个性化配置。');
      const current = this.store.getRetrievalConfig() ?? defaultRetrievalConfig();
      const next = validateRetrievalConfig({ ...current, knowledge: { ...current.knowledge, enabled: true, folderPath: input.folderPath, preferences } });
      const saved = await this.store.saveRetrievalConfig(next);
      this.applyKnowledgeSettings(current, saved);
      return saved;
    });
    if (!input.buildNow) return { config, jobId: null, buildError: null };
    try { const { jobId } = await this.startKnowledgeSync(); return { config, jobId, buildError: null }; }
    catch (error) { return { config, jobId: null, buildError: error instanceof Error ? error.message : '配置已保存，但建库未能启动。' }; }
  }

  private knowledgeFolder(): string {
    const folderPath = this.store.getRetrievalConfig()?.knowledge.folderPath;
    if (!folderPath) throw new Error('请先选择并保存本地知识库目录。');
    return folderPath;
  }
  async getKnowledgeState() {
    const folder = this.store.getRetrievalConfig()?.knowledge.folderPath ?? null;
    const state = await this.knowledge.getState(folder, this.knowledgePreferences());
    if (this.knowledgeTask?.folderPath === folder && this.knowledgeTask.job) state.job = structuredClone(this.knowledgeTask.job);
    return state;
  }
  async startKnowledgeSync(mode: KnowledgeSyncMode = 'incremental'): Promise<{ jobId: string }> {
    if (this.closing) throw new Error('应用正在关闭，无法开始建库。');
    if (this.knowledgeTask) throw new Error('本地知识库正在更新，请等待或取消当前任务。');
    const folderPath = this.knowledgeFolder(); const id = randomUUID(); const controller = new AbortController();
    const task = { id, folderPath, controller, done: Promise.resolve(), job: null as KnowledgeSyncJob | null };
    this.knowledgeTask = task;
    task.done = this.knowledge.syncFolder({ folderPath, jobId: id, mode, preferences: structuredClone(this.knowledgePreferences()) }, controller.signal, job => { task.job = job; })
      .then(job => { task.job = job; })
      .catch(error => {
        // The index normally persists failed jobs itself. A crashed worker is surfaced by getState.
        if (task.job) task.job = { ...task.job, status: 'failed', phase: error instanceof Error ? error.message : '索引任务失败', finishedAt: new Date().toISOString() };
      }).finally(() => { if (this.knowledgeTask?.id === id) this.knowledgeTask = null; });
    return { jobId: id };
  }
  async cancelKnowledgeSync(jobId: string): Promise<void> {
    if (this.knowledgeTask?.id === jobId) this.knowledgeTask.controller.abort();
  }
  searchKnowledge(input: KnowledgeSearchInput) { return this.knowledge.search({ ...input, folderPath: this.knowledgeFolder(), preferences: this.knowledgePreferences() }); }
  getKnowledgeChunk(chunkId: string) { return this.knowledge.readChunk({ folderPath: this.knowledgeFolder(), chunkId, preferences: this.knowledgePreferences() }); }
  private searchReviewKnowledge(input: KnowledgeSearchInput & { folderPath: string }, signal: AbortSignal) {
    const current = this.store.getRetrievalConfig();
    const previous = input.preferences ?? defaultKnowledgePreferences();
    const preferences = current?.knowledge.folderPath === input.folderPath ? intersectKnowledgePreferences(previous, current.knowledge.preferences ?? defaultKnowledgePreferences()) : previous;
    return this.knowledge.search({ ...input, preferences }, signal);
  }
  private async refreshKnowledge(): Promise<void> {
    if (this.closing || this.knowledgeTask || this.active.size || this.starting.size) return;
    const config = this.store.getRetrievalConfig();
    if (!config?.knowledge.enabled || !config.knowledge.folderPath || !this.knowledgePreferences().autoSyncEnabled) return;
    const revision = this.knowledgeSettingsRevision;
    const state = await this.knowledge.getState(config.knowledge.folderPath, config.knowledge.preferences);
    const current = this.store.getRetrievalConfig();
    if (this.closing || this.knowledgeTask || this.active.size || this.starting.size || revision !== this.knowledgeSettingsRevision || !this.knowledgePreferences().autoSyncEnabled || !current?.knowledge.enabled || current.knowledge.folderPath !== config.knowledge.folderPath) return;
    if (state.lastSyncedAt || state.job?.status === 'interrupted') await this.startKnowledgeSync('incremental');
  }

  // Serializing local writes makes every SQLite snapshot commit coherent even while network requests overlap.
  private write<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn); this.mutationQueue = next.catch(() => {}); return next;
  }

  private publicTask(task:ReviewTask):ReviewTask {
    const progress=this.extensionProgress.get(task.id) as import('../shared/model-runtime').ModelRuntimeProgress|undefined;
    return (task.status==='queued'||task.status==='running')&&progress?.modelRuntime?{...task,runtimeProgress:structuredClone(progress.modelRuntime)}:{...task};
  }
  getState(): AppState { return { documents: visibleDocuments(this.store), modelConfig: this.store.getConfig(), retrievalConfig: this.store.getRetrievalConfig(), tasks: this.store.listTasks().map(task=>this.publicTask(task)), isPreview: false, appVersion: APP_VERSION }; }
  getDocument(id: string): ContractDetail { return this.store.getDocument(id); }
  saveConfig(input: ModelConfigInput) { const config = validateModelConfig(input); return this.write(() => this.store.saveConfig(config)); }
  async testConnection(apiKey: string | null) { await this.runtimeReady;const config = this.store.getConfig(); if (!config) throw new Error('请先保存模型 API 配置。'); return withModelRuntime({assets:this.assets,config,taskId:randomUUID(),operation:'connection_test',secrets:[apiKey??'']},()=>testConnection(config, apiKey)); }
  saveRetrievalConfig(input: RetrievalConfigInput) {
    const config = validateRetrievalConfig({ ...input, knowledge: { ...input.knowledge, preferences: input.knowledge.preferences ?? this.knowledgePreferences() } });
    if (this.knowledgeTask && config.knowledge.folderPath !== this.knowledgeTask.folderPath) throw new Error('请先取消或等待当前建库任务完成，再更换知识库目录。');
    return this.write(async () => {
      if (this.knowledgeTask && config.knowledge.folderPath !== this.knowledgeTask.folderPath) throw new Error('请先取消或等待当前建库任务完成，再更换知识库目录。');
      if (this.knowledgeTask && JSON.stringify(config.knowledge.preferences) !== JSON.stringify(this.knowledgePreferences())) throw new Error('知识库正在同步，请先取消或等待完成后再更改个性化配置。');
      const previous = this.store.getRetrievalConfig();
      const saved = await this.store.saveRetrievalConfig(config);
      this.applyKnowledgeSettings(previous, saved);
      return saved;
    });
  }

  async testRetrieval(keys: RetrievalKeys = noRetrievalKeys()): Promise<RetrievalBundle> {
    const config = this.store.getRetrievalConfig();
    if (!config) throw new Error('请先保存检索配置。');
    const stamp = new Date().toISOString();
    const document: ContractDetail = { id: randomUUID(), name: '连接测试 · 明确虚构的服务采购背景', format: 'docx', language: 'zh', byteSize: 0, blockCount: 1, importedAt: stamp, warnings: ['仅用于检索连接测试，不是真实合同或案例。'], partial: false, latestReviewId: null, reviews: [],
      blocks: [{ id: randomUUID(), ordinal: 0, kind: 'paragraph', text: '这是明确虚构的检索连接测试背景：企业采购一项服务，需要了解验收标准、交付要求与付款前提之间的关系。没有真实交易主体、金额或案件事实。', locator: { kind: 'docx', partName: 'connection-test', structuralPath: '/test[1]', paragraphId: null } }] };
    const context = { contractType: 'service', ourPartyRole: 'service_recipient', businessContext: '检索连接测试，虚构业务背景，不形成合同审核或法律意见。', strictness: 'balanced' } as const;
    const bundle = await retrieveContext(document, context, config, keys, new AbortController().signal, () => {}, (input, signal) => this.searchReviewKnowledge(input, signal), this.officialReader);
    return safeBundle(bundle, [keys.knowledgeApiKey, keys.webApiKey]);
  }

  async testOfficialRetrieval(input: { query: string }): Promise<RetrievalBundle> {
    if (this.closing) throw new Error('应用正在关闭，无法测试官方目录。');
    const config = this.store.getRetrievalConfig();
    if (!config?.official?.enabled) throw new Error('请先启用并保存官方来源配置。');
    const controller = new AbortController(); this.officialTests.add(controller);
    try { return await retrieveOfficialContext(input.query, structuredClone(config), controller.signal, this.officialReader); }
    finally { this.officialTests.delete(controller); }
  }
  async cancelOfficialRetrieval(): Promise<void> {
    for (const controller of this.officialTests) controller.abort();
  }

  async importFile(sourcePath: string): Promise<ContractDetail> {
    const info = await stat(sourcePath);
    if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error('请选择不超过50 MB的 DOCX 或 PDF 文件。');
    return this.importBytes(basename(sourcePath), await readFile(sourcePath));
  }

  async importVersionFile(sourcePath: string, input: import('../shared/document-workspace').ImportVersionInput): Promise<ContractDetail> {
    if (this.closing) throw new Error('应用正在关闭。');
    assertDocumentActive(this.store, input.parentDocumentId);
    const parent = this.store.getDocument(input.parentDocumentId);
    if ([...this.active.values()].some(t=>this.store.getDocument(t.task.documentId).contractId===parent.contractId)) throw new Error('此合同仍在审核，请等待完成或取消。');
    const info=await stat(sourcePath); if(!info.isFile()||info.size>50*1024*1024)throw new Error('请选择不超过50 MB的 DOCX 或 PDF 文件。');
    return this.importBytes(basename(sourcePath),await readFile(sourcePath),undefined,input);
  }

  loadSample() { return createSampleContract().then(bytes => this.importBytes('示例 · 服务采购合同.docx', bytes)); }

  private async importBytes(name: string, bytes: Buffer, derivation?: { warnings?: string[]; partial?: boolean }, versionInput?: import('../shared/document-workspace').ImportVersionInput): Promise<ContractDetail> {
    if(this.closing)throw new Error('应用正在关闭，无法导入。');
    this.importing++;
    try{return await this.importDocumentBytes(name,bytes,derivation,versionInput);}finally{this.importing--;}
  }
  private async importDocumentBytes(name: string, bytes: Buffer, derivation?: { warnings?: string[]; partial?: boolean }, versionInput?: import('../shared/document-workspace').ImportVersionInput): Promise<ContractDetail> {
    const extension = extname(name).toLowerCase();
    if (!['.docx', '.pdf'].includes(extension)) throw new Error('当前支持 DOCX 和 PDF；旧式 DOC 请先另存为 DOCX。');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const parent = versionInput ? this.store.getDocument(versionInput.parentDocumentId) : null;
    const findDuplicate = () => versionInput ? this.store.rows('SELECT d.id FROM document_versions d WHERE d.contract_id=? AND d.file_sha256=? LIMIT 1',[parent!.contractId!,sha256])[0]?.id : this.store.findByHash(sha256)?.id;
    const duplicate = findDuplicate(); if (duplicate) { assertDocumentActive(this.store,String(duplicate)); return this.store.getDocument(String(duplicate)); }
    const id = randomUUID(); const dir = join(this.dataDir, 'documents', id); await mkdir(dir, { recursive: true });
    const path = join(dir, `original${extension}`);
    try {
      await writeFile(path, bytes, { mode: 0o600 });
      const parsed = await parseContract(path);
      if (derivation?.partial) parsed.partial = true;
      if (derivation?.warnings?.length) parsed.warnings.push(...derivation.warnings);
      return await this.write(async () => {
        const existing = findDuplicate(); if (existing) { assertDocumentActive(this.store,String(existing)); await rm(dir, { recursive: true, force: true }); return this.store.getDocument(String(existing)); }
        return this.store.addDocument(id, name, `documents/${id}/original${extension}`, bytes.length, sha256, parsed,undefined,versionInput);
      });
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  }

  async startReview(input: StartReviewInput, apiKey: string | null, keys: RetrievalKeys = noRetrievalKeys(), connectionSecrets: ConnectionSecrets = {}): Promise<{taskId:string}> {
    if (this.closing) throw new Error('应用正在关闭，请稍后重新打开后再审核。');
    input = structuredClone(input);
    const runningReviews = [...this.active.values()].filter(item => item.task.status === 'queued' || item.task.status === 'running');
    if (this.starting.has(input.documentId) || runningReviews.some(item => item.task.documentId === input.documentId)) throw new Error('这份合同正在审核，请等待或取消当前任务。');
    if (runningReviews.length + this.starting.size >= 2) throw new Error('已有两个审核任务运行中，请稍后再试。');
    const document = this.store.getDocument(input.documentId);
    assertDocumentActive(this.store,document.id);
    const standard = input.standardVersionId ? this.store.getEnterpriseStandardVersion(input.standardVersionId) : undefined;
    const allSecrets = [apiKey, keys.knowledgeApiKey, keys.webApiKey, ...Object.values(connectionSecrets)];
    if (standard && JSON.stringify(standard) !== JSON.stringify(redactSecrets(standard, allSecrets))) throw new Error('所选企业标准内容与当前连接凭据包含相同字符串。为避免凭据进入模型或报告且保留已发布版本，已在创建任务前阻止审核；请检查标准内容或更换测试凭据后重试。');
    input.context.businessContext = redactSecrets(input.context.businessContext, allSecrets);
    if (standard && (!standard.content.contractTypes.includes(input.context.contractType) || !standard.content.partyRoles.includes(input.context.ourPartyRole))) throw new Error('所选企业审核标准不适用于当前合同类型或我方立场，请重新选择。');
    if (!document.blocks.some(block => block.text.trim())) throw new Error('合同没有可审核文字；扫描件请先进行 OCR 或提供文字版。');
    const config = this.store.getConfig();
    // Client-supplied snapshots are never authoritative. Resolve and pin the
    // workspace's actual versions before any model call.
    const experienceResolution = getExperienceResolution({assets:this.assets},input.context);
    const experienceSnapshot = experienceResolution.selected;
    const advisorPackages = getApplicableAdvisorPackages({assets:this.assets},input.context);
    const alignmentSnapshot = document.contractId && this.assets.list('clause_alignment').some(asset => asset.body.contractId === document.contractId && asset.body.state !== 'disabled')
      ? clauseAlignmentSnapshot({store:this.store,assets:this.assets},document.contractId,document.id) : undefined;
    const referenceAssets={experienceResolution,advisorPackages,alignmentSnapshot,taskRequirements:input.context.taskRequirements??[]};
    if(Buffer.byteLength(JSON.stringify(referenceAssets))>384*1024)throw new Error('适用经验、冲突记录、任务要求和顾问资料超过384 KiB，请缩小范围后重试。');
    if(JSON.stringify(referenceAssets)!==JSON.stringify(redactSecrets(referenceAssets,allSecrets)))throw new Error('本次参考资料含有与连接凭据相同的内容，已阻止发送，请检查资料。');
    delete input.context.completionSnapshot; delete input.context.experienceResolution; delete input.context.advisorPackages; delete input.context.alignmentSnapshot;
    input.context.experienceResolution = experienceResolution;
    input.context.advisorPackages = advisorPackages;
    if (alignmentSnapshot) input.context.alignmentSnapshot = alignmentSnapshot;
    if (experienceSnapshot.length > 100 || Buffer.byteLength(JSON.stringify(experienceSnapshot)) > 256 * 1024) throw new Error('适用的已确认经验超过本次上下文预算，请缩小作用范围或停用部分经验。');
    if (JSON.stringify(experienceSnapshot) !== JSON.stringify(redactSecrets(experienceSnapshot, [apiKey, keys.knowledgeApiKey, keys.webApiKey, ...Object.values(connectionSecrets)]))) throw new Error('适用经验含有与连接凭据相同的字符串，已在建立任务前阻止发送，请检查经验内容或测试凭据。');
    const connections = input.mode === 'model' ? this.assets.list('connection').filter(asset => asset.body.enabled && ['mcp', 'index_api'].includes(asset.body.type)).slice(0, 8) : [];
    const retrievalConfig = this.store.getRetrievalConfig();
    const scopeRevision = this.knowledgeScopeRevision;
    if (input.mode === 'model' && !config) throw new Error('请先配置并保存模型 API。');
    const task: ReviewTask = { id: randomUUID(), documentId: document.id, status: 'queued', stage: '准备审核', startedAt: new Date().toISOString(), finishedAt: null, error: null, resultId: null };
    this.starting.add(input.documentId);
    let finishStarting!: () => void;
    this.startingDone.set(input.documentId, new Promise<void>(resolve => { finishStarting = resolve; }));
    try {
      await this.runtimeReady;
      const workflow = await getWorkflowBeforeReview({store:this.store,assets:this.assets},document.id,standard);
      if (workflow.paused) throw new Error(`审核暂停，先在“审核资料与核验”中补充或确认资料：${workflow.reasons.join('；')}`);
      input.context.completionSnapshot = workflow.snapshot;
      if(JSON.stringify(workflow.snapshot)!==JSON.stringify(redactSecrets(workflow.snapshot,allSecrets)))throw new Error('审核资料含有与连接凭据相同的内容，已阻止发送，请检查资料。');
      const runId = await this.write(() => this.store.createTask(task, input.context, input.mode, retrievalConfig, config, standard, { experienceSnapshot, connections }));
      const controller = new AbortController();
      if (this.closing) controller.abort();
      if (input.mode === 'model' && scopeRevision !== this.knowledgeScopeRevision) controller.abort(new KnowledgeScopeChangedError());
      const active = { controller, runId, task, mode: input.mode, done: Promise.resolve() };
      this.active.set(task.id, active); this.emit({ ...task });
      active.done = this.performReview(task, runId, document, input, config, apiKey, controller, retrievalConfig, { ...keys }, standard, experienceSnapshot, connections, { ...connectionSecrets });
      return { taskId: task.id };
    } finally { this.starting.delete(input.documentId); this.startingDone.delete(input.documentId); finishStarting(); }
  }

  private async performReview(task: ReviewTask, runId: string, document: ContractDetail, input: StartReviewInput, config: ModelConfigInput | null, apiKey: string | null, controller: AbortController, retrievalConfig: PublicRetrievalConfig | null, keys: RetrievalKeys, standard?: EnterpriseStandardSnapshot, experienceSnapshot: ExperienceSnapshot[] = [], connections: WorkspaceAsset[] = [], connectionSecrets: ConnectionSecrets = {}): Promise<void> {
    const started = performance.now();
    const secrets = [apiKey, keys.knowledgeApiKey, keys.webApiKey, ...Object.values(connectionSecrets)];
    let stages = Promise.resolve();
    let retrieval: RetrievalBundle | undefined;
    let retrievalSaved = false;
    const update = async () => { await this.write(() => this.store.updateTask({ ...task }, runId)); this.emit(this.publicTask(task)); };
    const onStage = (stage: string): void => {
      recordModelStage(stage);
      stages = stages.then(async () => { if (controller.signal.aborted) return; task.stage = redactSecrets(stage, secrets); await update(); });
    };
    try {
      const operation = async () => {
      task.status = 'running'; await update();
      if(input.mode==='model' && !input.context.completionSnapshot?.workflow.nodes.some(node=>node.kind==='retrieve_sources'&&(node.when==='always'||node.when==='has_pending_information'&&Boolean(input.context.completionSnapshot?.facts?.body.items.some(item=>item.status==='pending'))))) {
        retrieval={configSnapshot:retrievalConfig??defaultRetrievalConfig(),knowledgeStatus:'skipped',webStatus:'skipped',officialStatus:'skipped',searchStatus:'skipped',attempts:[],evidence:[],limitations:['本次审核流程跳过资料检索，未查询本地知识库、互联网和专业连接资料。']};
      }
      if (input.mode === 'model' && input.context.completionSnapshot?.workflow.nodes.some(node=>node.kind==='retrieve_sources'&&(node.when==='always'||node.when==='has_pending_information'&&Boolean(input.context.completionSnapshot?.facts?.body.items.some(item=>item.status==='pending'))))) {
        const [ordinary, additional] = await Promise.all([
          retrieveContext(document, input.context, retrievalConfig ?? defaultRetrievalConfig(), keys, controller.signal, onStage, (search, signal) => this.searchReviewKnowledge(search, signal), this.officialReader),
          retrieveConnectionEvidence(connections, connectionSecrets, retrievalTopics(document, input.context).query, controller.signal),
        ]);
        ordinary.attempts.push(...additional.attempts); ordinary.evidence.push(...additional.evidence);
        for (const channel of ['web', 'knowledge'] as const) {
          if (!additional.attempts.some(a => a.channel === channel)) continue;
          const attempts = ordinary.attempts.filter(a => a.channel === channel);
          const successes = attempts.some(a => a.status === 'complete');
          const allSuccessful = attempts.every(a => a.status === 'complete' || a.status === 'empty');
          const status = allSuccessful ? successes ? 'complete' : 'empty' : successes || attempts.some(a => a.status === 'empty') ? 'partial' : controller.signal.aborted ? 'cancelled' : 'failed';
          if (channel === 'web') ordinary.webStatus = status; else ordinary.knowledgeStatus = status;
        }
        ordinary.limitations.push(...crossCheckSources(ordinary.evidence));
        for (const attempt of additional.attempts) if (attempt.error) ordinary.limitations.push(attempt.error);
        retrieval = safeBundle(ordinary, secrets);
        await this.write(() => this.store.saveRetrievalBundle(runId, retrieval!));
        retrievalSaved = true;
        controller.signal.throwIfAborted();
      }
      const rawResult = await (input.mode === 'model' && input.context.longContractMode === 'batch' ? reviewWithBatches : reviewContract)(document, input.context, config, apiKey, input.mode, controller.signal, onStage, retrieval, standard, experienceSnapshot);
      const result = redactSecrets(rawResult, secrets);
      result.completionSnapshot=input.context.completionSnapshot;
      result.experienceResolution=input.context.experienceResolution;
      result.advisorPackages=input.context.advisorPackages;
      result.alignmentSnapshot=input.context.alignmentSnapshot;
      result.coverage.limitations=[...new Set([...result.coverage.limitations,...(input.context.completionSnapshot?.limitations??[]),...(input.context.experienceResolution?.conflicts.map(c=>`经验冲突待人工处置：${c.conflictKey}；${c.reason}`)??[])])];
      if (result.retrieval) result.retrieval = safeBundle(result.retrieval, secrets);
      const sourceMap = new Map(result.retrieval?.evidence.map(source => [source.id, source]) ?? []);
      for (const finding of result.findings) {
        finding.citations = finding.citations?.map(citation => {
          const source = sourceMap.get(citation.evidenceId);
          const quote = citation.quote.normalize('NFC').replace(/\s+/gu, ' ').trim();
          const matched = citation.matchStatus === 'matched' && Boolean(source) && quote.length > 0 && source!.excerpt.normalize('NFC').replace(/\s+/gu, ' ').includes(quote);
          return { ...citation, matchStatus: matched ? 'matched' as const : 'unmatched' as const };
        });
        if (finding.basisStatus === 'source_matched' && !finding.citations?.some(citation => citation.matchStatus === 'matched' && sourceMap.get(citation.evidenceId)?.contentScope !== 'search_snippet')) finding.basisStatus = 'unverified';
      }
      result.elapsedMs = Math.round(performance.now() - started);
      await stages; controller.signal.throwIfAborted();
      await this.write(() => { controller.signal.throwIfAborted(); return this.store.saveReview(result, runId); });
      await getWorkflowAfterReview({store:this.store,assets:this.assets},result,input.context.completionSnapshot);
      task.status = 'completed'; task.stage = '审核结果已生成 · 待人工复核'; task.resultId = result.id;
      };
      if (input.mode==='model' && config) await withModelRuntime({assets:this.assets,config,taskId:task.id,operation:'contract_review',documentId:document.id,signal:controller.signal,secrets:secrets.filter((s):s is string=>Boolean(s)),onProgress:value=>{this.extensionProgress.set(task.id,redactSecrets(value,secrets));this.emit(this.publicTask(task));}},operation);
      else await operation();
    } catch (error) {
      await stages.catch(() => {});
      task.status = controller.signal.aborted ? 'cancelled' : 'failed';
      task.stage = task.status === 'cancelled' ? '已取消' : '审核未完成';
      task.error = task.status === 'cancelled' ? controller.signal.reason instanceof KnowledgeScopeChangedError ? controller.signal.reason.message : null : redactSecrets(error instanceof Error ? error.message : '审核失败，请重试。', secrets);
    } finally {
      if (retrieval && !retrievalSaved) {
        try { await this.write(() => this.store.saveRetrievalBundle(runId, retrieval!)); }
        catch { task.status = 'failed'; task.error = '检索记录保存失败，请检查磁盘空间后重试。'; }
      }
      task.finishedAt = new Date().toISOString(); await update().catch(() => { task.status = 'failed'; task.error = '审核结果保存失败，请检查磁盘空间后重试。'; this.emit({ ...task }); }); this.active.delete(task.id);
      this.extensionProgress.delete(task.id);
    }
  }

  async runWorkspaceCommand(input: WorkspaceCommand, secrets: ConnectionSecrets = {}, apiKey: string | null = null): Promise<any> {
    await this.runtimeReady;
    if (input.action === 'workspace.status') return { documentCount: Number(this.store.rows('SELECT COUNT(*) n FROM document_versions d JOIN contracts c ON c.id=d.contract_id WHERE c.workspace_id=?',[this.store.workspaceId])[0].n), reportCount: Number(this.store.rows('SELECT COUNT(*) n FROM reports WHERE workspace_id=?',[this.store.workspaceId])[0].n) };
    if (input.action === 'workspace.progress') return this.extensionProgress.get(String((input.payload as any)?.requestId)) ?? { phase: '等待处理或已完成' };
    if (input.action === 'workspace.cancel') { this.extensionJobs.get(String((input.payload as any)?.requestId))?.abort(); return { cancelled: true }; }
    if (this.closing) throw new Error('应用正在关闭，无法开始工作台操作。');
    const id = input.requestId ?? randomUUID();
    if (this.extensionJobs.has(id)) throw new Error('此操作正在执行。');
    const controller = new AbortController(); this.extensionJobs.set(id, controller); this.extensionProgress.set(id, { phase: '开始处理' });
    let finish!: () => void;
    this.extensionDone.set(id, new Promise<void>(resolve => { finish = resolve; }));
    const deps = { store: this.store, service: this, assets: this.assets,dataDir:this.dataDir };
    try {
      if (input.action==='documents.inspectPurge') return inspectContractPurge(this.store,String((input.payload as any)?.contractId));
      if (input.action==='documents.purge') {
        if(this.importing||this.active.size||this.starting.size||this.changeDrafts.size||this.contractGenerations.size||this.extensionJobs.size>1)throw new Error('请等待其他合同或工作台任务完成，再永久清理。');
        return this.write(()=>purgeContract(this.store,this.dataDir,input.payload));
      }
      if (input.action.startsWith('reviewCompletion.')) return runReviewCompletionCommand(input.action,input.payload,deps);
      if (input.action.startsWith('alignment.')) return await runClauseAlignmentCommand(input.action,input.payload,{...deps,compare: async comparison => {
        const config=this.store.getConfig();if(!config)throw new Error('请先配置模型 API。');
        if(JSON.stringify(comparison)!==JSON.stringify(redactSecrets(comparison,[apiKey,...Object.values(secrets)])))throw new Error('对齐资料含有与连接凭据相同的内容，已阻止发送，请检查资料。');
        return redactSecrets(await withModelRuntime({assets:this.assets,config,taskId:id,operation:'clause_alignment',signal:controller.signal,secrets:[apiKey??''],onProgress:value=>this.extensionProgress.set(id,value)},()=>requestAlignmentComparison(this.store,comparison,apiKey,controller.signal)),[apiKey,...Object.values(secrets)]);
      }});
      if (input.action.startsWith('modelRuntime.')) return runModelRuntimeCommand(input.action,input.payload,{assets:this.assets,config:this.store.getConfig(),apiKey,signal:controller.signal,onProgress:value=>this.extensionProgress.set(id,value)});
      if (input.action === 'translations.generate') { const config=this.store.getConfig();if(!config)throw new Error('请先配置模型 API。');return redactSecrets(await withModelRuntime({assets:this.assets,config,taskId:id,operation:'reference_translation',documentId:(input.payload as any)?.documentId,signal:controller.signal,secrets:[apiKey??''],onProgress:value=>this.extensionProgress.set(id,value)},()=>generateReferenceTranslation(this.store,input.payload,apiKey,controller.signal)),[apiKey,...Object.values(secrets)]); }
      if (input.action.startsWith('documents.') || input.action.startsWith('translations.')) return await runDocumentWorkspaceCommand(input.action,input.payload,{...deps,enqueue:operation=>this.write(operation),assertIdle:ids=>{if(this.importing||ids.some(docId=>this.starting.has(docId)||[...this.active.values()].some(t=>t.task.documentId===docId))||this.changeDrafts.size||this.contractGenerations.size)throw new Error('相关合同仍有任务运行，请先等待或取消任务。');}});
      if (input.action.startsWith('library.authoring.')) return await runAuthoringCommand(input.action,input.payload,{...deps,dataDir:this.dataDir});
      if (input.action.startsWith('library.')) return await runLibraryCommand(input.action, input.payload, deps);
      if (input.action==='reporting.translation.generate') {
        const config=this.store.getConfig();if(!config)throw new Error('请先配置模型 API。');
        const translation=this.assets.get(String((input.payload as any)?.id));
        if(translation.kind!=='report_translation'||translation.deleted)throw new Error('报告译文不存在。');
        if(JSON.stringify(translation.body)!==JSON.stringify(redactSecrets(translation.body,[apiKey,...Object.values(secrets)])))throw new Error('报告资料含有与连接凭据相同的内容，已阻止发送，请检查资料。');
        return redactSecrets(await withModelRuntime({assets:this.assets,config,taskId:id,operation:'report_translation',signal:controller.signal,secrets:[apiKey??''],onProgress:value=>this.extensionProgress.set(id,value)},()=>generateReportTranslation(deps,input.payload,apiKey,controller.signal)),[apiKey,...Object.values(secrets)]);
      }
      if (input.action.startsWith('reporting.')) return await runReportingCommand(input.action, input.payload, deps);
      if (input.action.startsWith('connections.')) return redactSecrets(await runConnectionCommand(input.action, input.payload, { assets: this.assets, dataDir: this.dataDir, secrets, knowledge: this.knowledge, signal: controller.signal, onProgress: value => this.extensionProgress.set(id, value) }), Object.values(secrets));
      if (input.action.startsWith('conversion.')) { const { runConversionCommand } = await import('./document-conversion'); return await runConversionCommand(input.action, input.payload, { ...deps, dataDir: this.dataDir, signal: controller.signal, onProgress: value => this.extensionProgress.set(id, value) }); }
      throw new Error('不支持的工作台操作。');
    } finally { this.extensionJobs.delete(id); this.extensionProgress.delete(id); this.extensionDone.delete(id); finish(); }
  }

  async importDerivedBytes(input: { name: string; base64: string; source: unknown; draft?: ContractDraft; warnings?: string[]; partial?: boolean }): Promise<ContractDetail> {
    if (this.closing) throw new Error('应用正在关闭。');
    const bytes = Buffer.from(input.base64, 'base64');
    if (bytes.length > 50 * 1024 * 1024) throw new Error('派生文档超过50 MiB。');
    const detail = await this.importBytes(input.name, bytes, input);
    await this.assets.save({ kind: 'document_derivation', expectedRevision: 0, body: { documentId: detail.id, source: input.source } });
    return detail;
  }

  async cancelReview(taskId: string): Promise<void> { this.active.get(taskId)?.controller.abort(); }
  getReview(id: string): ReviewResult { return this.store.getReview(id); }
  listEnterpriseStandards() { return this.store.listEnterpriseStandards(); }
  getEnterpriseStandard(id: string) { return this.store.getEnterpriseStandard(id); }
  saveEnterpriseStandard(input: SaveEnterpriseStandardInput) {
    return this.write(() => { if (this.closing) throw new Error('应用正在关闭，无法保存审核标准。'); return this.store.saveEnterpriseStandard(structuredClone(input)); });
  }
  publishEnterpriseStandard(input: PublishEnterpriseStandardInput) {
    return this.write(() => { if (this.closing) throw new Error('应用正在关闭，无法发布审核标准。'); return this.store.publishEnterpriseStandard(structuredClone(input)); });
  }
  getRiskDispositions(reviewId: string) { return this.store.getRiskDispositions(reviewId); }
  async saveRiskDisposition(input: SaveRiskDispositionInput) {
    const result=await this.write(() => { if (this.closing) throw new Error('应用正在关闭，无法保存风险处置。'); return this.store.saveRiskDisposition(structuredClone(input)); });
    await getWorkflowAfterReview({store:this.store,assets:this.assets},this.store.getReview(input.reviewId));
    return result;
  }

  private assertChangeRevision(reviewId: string, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0 || this.store.getChangeRevision(reviewId) !== revision) throw new Error('修改列表已更新，请刷新后重新确认，未覆盖最新修改。');
  }
  private async changeSource(documentId: string): Promise<Buffer> {
    const artifact = this.store.getDocumentArtifact(documentId);
    const root = await realpath(this.dataDir);
    const path = resolve(root, artifact.artifactUri);
    const delta = relative(root, path);
    if (!delta || isAbsolute(delta) || delta === '..' || delta.startsWith(`..${sep}`)) throw new Error('合同原件不在受管目录中。');
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.size > 50 * 1024 * 1024) throw new Error('合同原件已变化或不可读取，无法安全生成修改稿。');
    const canonical = await realpath(path); const canonicalDelta = relative(root, canonical);
    if (isAbsolute(canonicalDelta) || canonicalDelta === '..' || canonicalDelta.startsWith(`..${sep}`)) throw new Error('合同原件已移出受管目录。');
    const bytes = await readFile(canonical);
    if (bytes.length !== artifact.byteSize || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('合同原件与审核版本不一致，已阻止修改。请重新导入并审核。');
    return bytes;
  }
  private async changeEditingSource(reviewId: string, documentId: string): Promise<{ bytes: Buffer; warnings: string[] }> {
    const bytes = await this.changeSource(documentId);
    return this.store.getEditableCopyAuthorization(reviewId).enabled ? createDocxEditableCopy(bytes) : { bytes, warnings: [] };
  }
  async getChanges(reviewId: string): Promise<ChangeWorkspace> {
    const review = this.store.getReview(reviewId); const document = this.store.getDocument(review.documentId);
    const artifact = this.store.getDocumentArtifact(document.id);
    const basic = { reviewId, documentId: document.id, sourceFileSha256: artifact.sha256, revision: this.store.getChangeRevision(reviewId),
      proposals: this.store.getChangeProposals(reviewId), exports: this.store.getChangeExports(reviewId) };
    if (document.format !== 'docx') return { ...basic, supported: false, reason: '本轮修改稿先支持DOCX；PDF仍可审核，修改稿格式需后续单独验证。', targets: [], warnings: [] };
    const source = await this.changeSource(document.id);
    const protection = await inspectDocxEditProtection(source);
    const authorization = this.store.getEditableCopyAuthorization(reviewId);
    const working = authorization.enabled ? await createDocxEditableCopy(source) : { bytes: source, warnings: [] };
    const inspected = await inspectDocxTargets(working.bytes);
    const targets = document.blocks.map(block => {
      const locator = block.locator;
      const target = locator.kind === 'docx' ? inspected.find(item => item.partName === locator.partName && item.structuralPath === locator.structuralPath) : undefined;
      const match = target?.text === block.text;
      return { blockId: block.id, label: `${block.kind === 'table_cell' ? '表格段落' : block.kind === 'header' ? '页眉' : block.kind === 'footer' ? '页脚' : '段落'} ${block.ordinal + 1}`, text: block.text,
        editable: Boolean(match && target?.editable), reason: !match ? '原文与已保存定位不一致，需重新导入审核。' : target!.reason,
        ...(match && target ? { editMode: target.editMode ?? 'paragraph', warnings: target.warnings ?? [], ...(target.segments ? { segments: target.segments } : {}) } : {}) };
    });
    // Enabling a copy is monotonic and can finish while a read is inspecting XML.
    if (this.store.getEditableCopyAuthorization(reviewId).enabled !== authorization.enabled) return this.getChanges(reviewId);
    const supported = targets.some(target => target.editable);
    return { ...basic, revision: this.store.getChangeRevision(reviewId), proposals: this.store.getChangeProposals(reviewId), exports: this.store.getChangeExports(reviewId),
      supported, reason: supported ? null : protection.reason ?? '没有可安全定点修改的普通段落，请在Word中处理复杂结构后重新导入。', targets,
      editableCopy: { available: protection.canCreateEditableCopy, enabled: authorization.enabled, enabledAt: authorization.enabledAt, reason: protection.reason },
      warnings: ['修改稿仅包含已采纳的修改；采纳不等于法律判断已经确认。', ...working.warnings, ...(document.partial ? ['文档解析存在覆盖提示；未修改的图片、修订或其他对象保持原样，导出后仍需核对。'] : [])] };
  }
  enableEditableCopy(input: EnableEditableCopyInput): Promise<ChangeWorkspace> {
    return this.write(async () => {
      if (this.closing) throw new Error('应用正在关闭，无法启用可编辑副本。');
      this.assertChangeRevision(input.reviewId, input.expectedRevision);
      const review = this.store.getReview(input.reviewId); const document = this.store.getDocument(review.documentId);
      if (document.format !== 'docx') throw new Error('只有DOCX可启用可编辑副本。');
      const source = await this.changeSource(document.id); const protection = await inspectDocxEditProtection(source);
      if (!protection.canCreateEditableCopy) throw new Error(protection.reason ?? '此合同未启用支持的Word只读限制，无需启用可编辑副本。');
      const copy = await createDocxEditableCopy(source);
      if (!(await inspectDocxTargets(copy.bytes)).some(target => target.editable)) throw new Error('工作副本仍没有可安全修改的普通段落，请在Word中处理复杂结构。');
      await this.store.enableEditableCopy(input.reviewId, input.expectedRevision);
      return this.getChanges(input.reviewId);
    });
  }
  private changePatch(proposal: ChangeProposal, document: ContractDetail): DocxTextPatch {
    const block = document.blocks.find(item => item.id === proposal.blockId);
    if (!block || block.locator.kind !== 'docx') throw new Error('修改目标不属于当前DOCX原文。');
    return { id: proposal.id, blockId: block.id, partName: block.locator.partName, structuralPath: block.locator.structuralPath,
      rangeStart: proposal.rangeStart, rangeEnd: proposal.rangeEnd, expectedOriginalText: proposal.originalText, replacementText: proposal.replacementText };
  }
  private changeScope(target: ChangeTarget, segmentId?: string): { text: string; rangeStart: number; rangeEnd: number } {
    if (target.editMode === 'segments') {
      const segment = target.segments?.find(item => item.id === segmentId);
      if (!segmentId || !segment?.editable || segment.rangeStart < 0 || segment.rangeEnd <= segment.rangeStart || target.text.slice(segment.rangeStart, segment.rangeEnd) !== segment.text) {
        throw new Error(segment?.reason ?? '此段含需保留的结构，请先选择一个可修改的文字片段。');
      }
      return { text: segment.text, rangeStart: segment.rangeStart, rangeEnd: segment.rangeEnd };
    }
    if (segmentId !== undefined) throw new Error('该段落没有对应的文字片段，请刷新后重新选择。');
    return { text: target.text, rangeStart: 0, rangeEnd: target.text.length };
  }
  private async persistChange(input: SaveChangeInput, generated?: { explanation: string; warnings: string[]; modelId: string | null }, signal?: AbortSignal): Promise<ChangeWorkspace> {
    if (this.closing) throw new Error('应用正在关闭，无法保存修改。');
    this.assertChangeRevision(input.reviewId, input.expectedRevision);
    const workspace = await this.getChanges(input.reviewId);
    const review = this.store.getReview(input.reviewId); const document = this.store.getDocument(review.documentId);
    assertDocumentActive(this.store,document.id);
    const target = workspace.targets.find(item => item.blockId === input.blockId);
    if (!workspace.supported || !target?.editable) throw new Error(target?.reason ?? workspace.reason ?? '该位置暂不支持修改。');
    const scope = this.changeScope(target, input.segmentId);
    if (typeof input.replacementText !== 'string' || input.replacementText.length > CHANGE_TEXT_LIMIT) throw new Error('修改文字超过本轮上限。');
    if (input.replacementText === scope.text) throw new Error('修改后文字与原文相同，请先编辑具体内容。');
    if (input.findingId !== null && !review.findings.some(item => item.id === input.findingId)) throw new Error('审核意见不属于本次报告。');
    const previous = input.proposalId ? workspace.proposals.find(item => item.id === input.proposalId) : undefined;
    if (input.proposalId && (!previous || previous.blockId !== input.blockId || previous.findingId !== input.findingId || previous.rangeStart !== scope.rangeStart || previous.rangeEnd !== scope.rangeEnd)) throw new Error('修改建议或原文位置已失效，请重新选择。');
    const stamp = new Date().toISOString();
    const proposal: ChangeProposal = { id: previous?.id ?? randomUUID(), reviewId: review.id, documentId: document.id, findingId: input.findingId, blockId: input.blockId,
      rangeStart: scope.rangeStart, rangeEnd: scope.rangeEnd, originalText: scope.text, replacementText: input.replacementText,
      sourceFileSha256: workspace.sourceFileSha256, originalTextSha256: createHash('sha256').update(scope.text).digest('hex'), status: 'proposed',
      explanation: generated?.explanation ?? (previous ? '用户已编辑修改草稿，需重新采纳。' : '用户手动拟定的修改草稿。'), warnings: generated?.warnings ?? [],
      modelId: generated?.modelId ?? previous?.modelId ?? null, createdAt: previous?.createdAt ?? stamp, updatedAt: stamp };
    const working = await this.changeEditingSource(input.reviewId, document.id);
    const validated = await applyDocxPatches(working.bytes, [this.changePatch(proposal, document)]);
    proposal.warnings = [...new Set([...proposal.warnings, ...working.warnings, ...validated.warnings])];
    if (signal?.aborted) throw new Error('修改草稿生成已取消，未保存修改。');
    await this.store.saveChangeProposal(proposal, input.expectedRevision);
    return this.getChanges(review.id);
  }
  saveChange(input: SaveChangeInput): Promise<ChangeWorkspace> { return this.write(() => this.persistChange(structuredClone(input))); }
  generateChangeDraft(input: GenerateChangeInput, apiKey: string | null): Promise<ChangeWorkspace> {
    if (this.closing) return Promise.reject(new Error('应用正在关闭，无法生成修改草稿。'));
    if (this.changeDrafts.has(input.reviewId)) return Promise.reject(new Error('本次审核正在生成修改草稿，请等待或取消。'));
    if (this.changeDrafts.size >= 2) return Promise.reject(new Error('已有两个修改草稿正在生成，请稍后重试。'));
    input = structuredClone(input); const controller = new AbortController();
    const done = this.runChangeDraft(input, apiKey, controller.signal).finally(() => this.changeDrafts.delete(input.reviewId));
    this.changeDrafts.set(input.reviewId, { controller, done }); return done;
  }
  private async runChangeDraft(input: GenerateChangeInput, apiKey: string | null, signal: AbortSignal): Promise<ChangeWorkspace> {
    this.assertChangeRevision(input.reviewId, input.expectedRevision);
    const workspace = await this.getChanges(input.reviewId);
    const review = this.store.getReview(input.reviewId); const document = this.store.getDocument(review.documentId);
    const finding = review.findings.find(item => item.id === input.findingId); const block = document.blocks.find(item => item.id === input.blockId);
    const target = workspace.targets.find(item => item.blockId === block?.id && item.editable);
    if (!finding || !block || !target) throw new Error('请选择本次报告中的意见和可修改的原文段落。');
    const scope = this.changeScope(target, input.segmentId);
    if (finding.blockIds.length && !finding.blockIds.includes(block.id)) throw new Error('该段落不属于审核意见的原文定位，请重新选择。');
    const config = this.store.getConfig(); if (!config) throw new Error('请先配置模型；也可手动编辑修改草稿。');
    if (signal.aborted) throw new Error('修改草稿生成已取消。');
    const generated = redactSecrets(await withModelRuntime({assets:this.assets,config,taskId:randomUUID(),operation:'contract_change',documentId:document.id,reviewId:review.id,signal,secrets:[apiKey??'']},()=>draftContractChange(document, review, finding, block, config, apiKey, signal, target.editMode === 'segments' ? scope : undefined)), [apiKey]);
    if (signal.aborted) throw new Error('修改草稿生成已取消，未保存修改。');
    return this.write(async () => {
      if (signal.aborted) throw new Error('修改草稿生成已取消，未保存修改。');
      return this.persistChange({ ...input, replacementText: generated.replacementText }, generated, signal);
    });
  }
  async cancelChangeDraft(reviewId: string): Promise<void> { this.changeDrafts.get(reviewId)?.controller.abort(); }

  listContractDrafts() { return this.store.listContractDrafts(); }
  getContractDraft(id: string): ContractDraft { return this.store.getContractDraft(id); }
  generateContract(raw: GenerateContractInput, apiKey: string | null): Promise<ContractDraft> {
    if (this.closing) return Promise.reject(new Error('应用正在关闭，无法生成合同。'));
    const input = normalizeGenerateContractInput(raw);
    const previous = this.store.findContractDraft(input.requestId);
    if (previous) {
      if ((Object.keys(input) as Array<keyof GenerateContractInput>).some(key => previous.request[key] !== input[key])) return Promise.reject(new Error('该生成请求已有不同内容的结果，请新建一次生成。'));
      return Promise.resolve(previous);
    }
    if (this.contractGenerations.size) return Promise.reject(new Error('已有合同正在生成，请等待或取消后重试。'));
    const controller = new AbortController();
    const done = this.runContractGeneration(input, apiKey, controller.signal).finally(() => this.contractGenerations.delete(input.requestId));
    this.contractGenerations.set(input.requestId, { controller, done }); return done;
  }
  private async runContractGeneration(input: GenerateContractInput, apiKey: string | null, signal: AbortSignal): Promise<ContractDraft> {
    const config = this.store.getConfig();
    if (!config) throw new Error('请先配置并测试模型连接，再根据描述生成合同。');
    if (signal.aborted) throw new Error('合同生成已取消。');
    const draft = redactSecrets(await withModelRuntime({assets:this.assets,config,taskId:input.requestId,operation:'contract_generation',signal,secrets:[apiKey??''],onProgress:value=>this.extensionProgress.set(input.requestId,value)},()=>generateContractDraft(input, config, apiKey, signal)), [apiKey]);
    if (signal.aborted) throw new Error('合同生成已取消，未保存草稿。');
    return this.write(async () => {
      if (this.closing || signal.aborted) throw new Error('合同生成已取消，未保存草稿。');
      await this.store.saveContractDraft(draft); return draft;
    });
  }
  async cancelContractGeneration(requestId: string): Promise<void> { this.contractGenerations.get(requestId)?.controller.abort(); }
  exportContractDraft(input: ExportContractDraftInput & { filePath: string }): Promise<ExportContractDraftResult> {
    return this.write(async () => {
      if (this.closing) throw new Error('应用正在关闭，无法导出合同草稿。');
      const checked=await assertAuthoringExport({store:this.store,assets:this.assets,service:this,dataDir:this.dataDir},{draftId:input.draftId});
      const bytes=checked.bytes;
      assertDocumentActive(this.store,checked.view.document.id);
      if (!isAbsolute(input.filePath) || extname(input.filePath).toLowerCase() !== '.docx' || input.filePath.includes('\0')) throw new Error('请选择新的DOCX导出文件名。');
      const parent = await realpath(dirname(input.filePath)); const outputPath = join(parent, basename(input.filePath));
      const dataRoot = await realpath(this.dataDir); const delta = relative(dataRoot, outputPath);
      if (!delta || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`))) throw new Error('请将合同草稿导出到应用数据目录以外的位置。');
      let written = false;
      try {
        const file = await open(outputPath, 'wx', 0o600); written = true;
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await this.store.transaction(()=>{this.store.rows('INSERT INTO audit_events(id,workspace_id,entity_type,entity_id,action,actor_kind,actor_label,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[randomUUID(),this.store.workspaceId,'authoring_export',checked.view.asset.id,'exported','user',checked.view.asset.body.actorLabel,JSON.stringify({caseId:checked.view.asset.id,caseRevision:checked.view.asset.revision,documentId:checked.view.document.id,sha256:createHash('sha256').update(bytes).digest('hex'),confirmation:checked.view.asset.body.confirmation}),new Date().toISOString()]);});
        return { path: outputPath, document:checked.view.document };
      } catch (error) {
        if (written) await rm(outputPath, { force: true }).catch(() => {});
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目标文件已存在，未覆盖已有文件，请换一个新文件名导出。');
        throw error;
      }
    });
  }
  decideChange(input: DecideChangeInput): Promise<ChangeWorkspace> {
    return this.write(async () => {
      if (this.closing) throw new Error('应用正在关闭，无法确认修改。');
      assertDocumentActive(this.store,this.store.getReview(input.reviewId).documentId);
      this.assertChangeRevision(input.reviewId, input.expectedRevision);
      const workspace = await this.getChanges(input.reviewId);
      const proposal = workspace.proposals.find(item => item.id === input.proposalId);
      if (!proposal) throw new Error('修改建议不存在或不属于本次审核。');
      const document = this.store.getDocument(workspace.documentId);
      if (proposal.sourceFileSha256 !== workspace.sourceFileSha256) throw new Error('修改建议已不适用于当前原文。');
      const working = await this.changeEditingSource(input.reviewId, document.id);
      await applyDocxPatches(working.bytes, [this.changePatch(proposal, document)]);
      await this.store.decideChangeProposal(input.reviewId, input.proposalId, input.status, input.expectedRevision);
      return this.getChanges(input.reviewId);
    });
  }
  exportModified(input: ExportChangesInput & { filePath: string }): Promise<ExportChangesResult> {
    return this.write(async () => {
      assertDocumentActive(this.store,this.store.getReview(input.reviewId).documentId);
      if (this.closing) throw new Error('应用正在关闭，无法导出修改稿。');
      this.assertChangeRevision(input.reviewId, input.expectedRevision);
      const workspace = await this.getChanges(input.reviewId);
      if (!workspace.supported) throw new Error(workspace.reason ?? '当前文档暂不支持导出修改稿。');
      const accepted = workspace.proposals.filter(item => item.status === 'accepted');
      if (!accepted.length) throw new Error('请先逐项采纳需要写入修改稿的建议。');
      if (accepted.some(item => item.sourceFileSha256 !== workspace.sourceFileSha256)) throw new Error('已采纳建议的原文版本不一致，已阻止导出。');
      const document = this.store.getDocument(workspace.documentId);
      const working = await this.changeEditingSource(input.reviewId, document.id);
      const format = input.format ?? 'clean';
      if (!['clean', 'tracked'].includes(format)) throw new Error('请选择有效的修改稿导出格式。');
      const revisionAuthor = format === 'tracked' ? (input.revisionAuthor ?? '合同工作台').trim() : null;
      if (revisionAuthor !== null && (!revisionAuthor || revisionAuthor.length > 80 || /[\u0000-\u001f\u007f]/u.test(revisionAuthor))) throw new Error('修订作者须为1至80字，不能包含换行或控制字符。');
      const revisionDate = format === 'tracked' ? new Date().toISOString() : null;
      const patches = accepted.map(item => this.changePatch(item, document));
      const patched = format === 'tracked' ? await applyDocxTrackedPatches(working.bytes, patches, { author: revisionAuthor!, date: revisionDate! }) : await applyDocxPatches(working.bytes, patches);
      patched.warnings = [...new Set([...working.warnings, ...patched.warnings])];
      if (!isAbsolute(input.filePath) || extname(input.filePath).toLowerCase() !== '.docx' || input.filePath.includes('\0')) throw new Error('请选择新的DOCX导出文件名。');
      const parent = await realpath(dirname(input.filePath)); const documentPath = join(parent, basename(input.filePath));
      const dataRoot = await realpath(this.dataDir); const delta = relative(dataRoot, documentPath);
      if (!delta || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`))) throw new Error('请将修改稿导出到应用数据目录以外的位置。');
      const changeListPath = join(parent, `${basename(documentPath, extname(documentPath))}.修改清单.md`);
      const id = randomUUID(); const documentId = randomUUID(); const managedDir = join(this.dataDir, 'documents', documentId);
      const managedPath = join(managedDir, 'revised.docx'); let documentWritten = false; let listWritten = false;
      try {
        await mkdir(managedDir, { recursive: true, mode: 0o700 });
        await writeFile(managedPath, patched.bytes, { mode: 0o600, flag: 'wx' });
        const parsed = await parseContract(managedPath);
        const sha256 = createHash('sha256').update(patched.bytes).digest('hex');
        const changeList = renderChangeList(document, workspace, accepted, sha256, patched.warnings, { format, revisionAuthor, revisionDate });
        // Never overwrite an existing user file, including an imported original.
        const documentFile = await open(documentPath, 'wx', 0o600); documentWritten = true;
        try { await documentFile.writeFile(patched.bytes); await documentFile.sync(); } finally { await documentFile.close(); }
        const listFile = await open(changeListPath, 'wx', 0o600); listWritten = true;
        try { await listFile.writeFile(changeList); await listFile.sync(); } finally { await listFile.close(); }
        const exported = await this.store.addChangeExport({ id, reviewId: input.reviewId, expectedRevision: input.expectedRevision, documentId,
          artifactUri: `documents/${documentId}/revised.docx`, sha256, byteSize: patched.bytes.length, parsed, proposals: accepted, changeList, format, revisionAuthor, revisionDate });
        return { documentPath, changeListPath, export: exported };
      } catch (error) {
        if (documentWritten) await rm(documentPath, { force: true }).catch(() => {});
        if (listWritten) await rm(changeListPath, { force: true }).catch(() => {});
        await rm(managedDir, { recursive: true, force: true }).catch(() => {});
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目标文件或修改清单已存在，未覆盖任何已有文件。请换一个新文件名导出。');
        throw error;
      }
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.runtimeReady.catch(()=>{});
    for (const controller of this.extensionJobs.values()) controller.abort();
    await Promise.allSettled([...this.extensionDone.values()]);
    for (const controller of this.officialTests) controller.abort();
    const drafts = [...this.changeDrafts.values()];
    for (const draft of drafts) draft.controller.abort();
    const generations = [...this.contractGenerations.values()];
    for (const generation of generations) generation.controller.abort();
    if (this.knowledgeTimer) clearInterval(this.knowledgeTimer);
    const knowledgeTask = this.knowledgeTask;
    knowledgeTask?.controller.abort();
    await Promise.allSettled([...this.startingDone.values()]);
    const running = [...this.active.values()];
    for (const item of running) item.controller.abort();
    await Promise.allSettled(running.map(item => item.done));
    await Promise.allSettled(drafts.map(item => item.done));
    await Promise.allSettled(generations.map(item => item.done));
    await knowledgeTask?.done;
    await this.mutationQueue;
    await this.knowledge.close();
    await this.store.close();
  }
}

function renderChangeList(document: ContractDetail, workspace: ChangeWorkspace, proposals: ChangeProposal[], outputHash: string, warnings: string[], options?: { format: 'clean'|'tracked'; revisionAuthor:string|null; revisionDate:string|null }): string {
  const safe = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const quote = (value: string) => safe(value).split(/\r?\n/).map(line => `> ${line}`).join('\n');
  const lines = ['# 合同修改清单', '', `来源合同：${safe(document.name)}`, '', `原文版本：${document.id}`, '', `原件 SHA-256：${workspace.sourceFileSha256}`, '', `修改稿 SHA-256：${outputHash}`, '', `本次仅写入已采纳的 ${proposals.length} 项修改；未采纳、拒绝或尚未生成的建议不在修改稿中。`, '', '采纳记录不等于法律判断已确认，导出后请核对全文、编号和版式。', ''];
  lines.push(options?.format === 'tracked' ? `导出格式：Word原生修订稿。新增修改带插入/删除痕迹；原有修订记录保留，未自动接受或拒绝。修订作者：${safe(options.revisionAuthor!)}；时间：${options.revisionDate}。可在Word的审阅视图中查看并接受或拒绝新增修订。` : '导出格式：普通修改稿，不新增Word原生修订；原有修订记录仍保留。', '');
  if (workspace.editableCopy?.enabled) lines.push('## 可编辑副本', '', '原件含Word只读编辑限制。本次经用户启用，仅在导出的新副本中移除该限制；受保护原件和原审核记录保留，未破解或验证原保护密码。', '', `启用时间：${workspace.editableCopy.enabledAt ?? '未知'}`, '');
  for (const [index, proposal] of proposals.entries()) {
    const target = workspace.targets.find(item => item.blockId === proposal.blockId);
    const scope = target?.editMode === 'segments' ? `文字片段，字符范围 ${proposal.rangeStart}–${proposal.rangeEnd}（从0计数，不包含结束位置）` : '完整段落';
    lines.push(`## 修改 ${index + 1}`, '', `建议编号：${proposal.id}`, '', `原文位置：${target?.label ?? proposal.blockId}`, '', `修改范围：${scope}`, '', '修改前：', '', quote(proposal.originalText), '', '修改后：', '', quote(proposal.replacementText || '（删除所选文字，保留段落结构）'), '', `说明：${safe(proposal.explanation)}`, '', ...proposal.warnings.map(value => `- ${safe(value)}`), '');
  }
  lines.push('## 导出范围与限制', '', ...[...new Set([...workspace.warnings, ...warnings])].map(value => `- ${safe(value)}`));
  return lines.join('\n');
}

export function renderReviewMarkdown(review: ReviewResult, title: string, dispositions?: RiskDispositionWorkspace): string {
  const plain = (text: string): string => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const inline = (text: string): string => plain(text).replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]#]/g, '\\$&');
  const cell = (text: string): string => inline(text).replaceAll('|', '\\|');
  const quote = (text: string): string => plain(text).split(/\r?\n/).map(line => `> ${line}`).join('\n');
  const link = (uri: string | null): string => {
    if (!uri) return '未提供来源入口';
    try {
      const url = new URL(uri);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return `[来源页面](<${url.href.replaceAll('<', '%3C').replaceAll('>', '%3E')}>)`;
    } catch { /* Local file identifiers remain plain text, not executable Markdown links. */ }
    return inline(uri);
  };
  const retrieval = review.retrieval;
  const sources = retrieval?.evidence ?? [];
  const sourceNumbers = new Map(sources.map((source, index) => [source.id, index + 1]));
  const modelEvidenceIds = (retrieval as (RetrievalBundle & { modelEvidenceIds?: string[] }) | undefined)?.modelEvidenceIds;
  const lines = [`# ${inline(title)}：合同审核报告`, '', `生成时间：${review.createdAt}`, `审核方式：${review.mode === 'model' ? `模型 API（${inline(review.modelId ?? '未返回模型名')}）` : '本地关键词与程序检查'}`,
    `知识库状态：${review.coverage.knowledgeStatus}；互联网状态：${review.coverage.webStatus}`,
    `本次检索与审核耗时：${review.elapsedMs} ms`, '', '> 本结果待法务复核。取回来源、官方域名线索或引文文字匹配，均不等于已核验法律效力、适用性或时效。', '', '## 摘要', '', plain(review.summary), ''];
  const standard = review.standardSnapshot;
  lines.push('## 本次企业审核标准', '', ...(standard ? [
    `方案：${inline(standard.content.name)}；发布版本：v${standard.versionNo}；版本ID：${standard.id}`, '',
    `发布记录：${inline(standard.publishedBy)}；时间：${standard.publishedAt}；内容SHA-256：${standard.contentSha256}`, '',
    `企业规则：${standard.content.workflow.runEnterpriseRules ? '启用' : '停用'}；高风险处理建议：${standard.content.workflow.highRiskHandling === 'escalate' ? '升级决策（仍需用户记录决定）' : '人工复核'}。`, '',
    '企业标准仅表示内部关注、商业阈值和处理建议，不等同法律强制义务或法律依据核验。', '',
  ] : ['本次未选择已发布的企业标准；兼容历史审核，不按当前配置补写旧报告。', '']));
  lines.push('## 程序核验覆盖', '');
  if (review.programChecks) {
    const labels = { amounts: '金额与付款', dates: '日期与期间', references: '合同条款引用', parties: '主体与编号一致性' };
    const statuses = { completed: '有限语法检查完成', partial: '部分检查/需人工补核', disabled: '按本次标准停用' };
    lines.push(`引擎版本：${inline(review.programChecks.engineVersion)}；程序提示 ${review.programChecks.issues.length} 项。计数为明确可识别的比较/校验次数，不代表核对了所有金额或条款。`, '');
    for (const check of review.programChecks.checks) lines.push(`### ${labels[check.kind]}`, '', `${statuses[check.status]}；已执行 ${check.checkedCount} 次核验。`, '', ...check.limitations.map(value => `- ${plain(value)}`), '');
  } else lines.push('该历史报告未保存程序核验结果，不将当前程序检查追记为当时已执行。', '');
  if (review.experienceSnapshot?.length) lines.push('## 本次已确认经验快照', '', ...review.experienceSnapshot.map(value => `- ${inline(value.id)} r${value.revision}；SHA-256：${value.contentSha256}`), '', '经验仅供适用范围内的偏好与企业关注参考，不等于法律依据。', '');
  if (review.batchCoverage) lines.push('## 长合同分批覆盖', '', `批次：${review.batchCoverage.batchCount}；跨批综合：${review.batchCoverage.crossBatchSynthesis ? '已执行，仍需人工核对' : '受预算限制，需人工补核'}`, '', ...review.batchCoverage.limitations.map(value => `- ${plain(value)}`), '');
  lines.push('## 审核意见', '');
  for (const [index, finding] of review.findings.entries()) {
    lines.push(`### ${index + 1}. ${inline(finding.title)}`, '', `风险等级：${finding.severity}；类别：${finding.category}；原文定位：${finding.locationStatus === 'matched' ? '已匹配' : '待确认'}`, '', '合同原文：', '', quote(finding.quote || '未提供直接引文，需人工核对'), '', plain(finding.description), '', `建议：${plain(finding.suggestion)}`, '', `待法务核实的法律依据：${plain(finding.legalBasis || '未提供具体法律依据')}`, '', `依据状态：${finding.basisStatus === 'source_matched' ? '来源引文已匹配；法律适用与效力尚未核验' : '未核验'}`, '');
    lines.push(`意见来源：${finding.origin === 'program' ? '程序核验' : finding.origin === 'enterprise' ? '企业审核规则' : finding.source === 'model' ? '模型分析' : '本地关键词提示'}${finding.checkKey ? `；检查项：${inline(finding.checkKey)}` : ''}`, '', ...(finding.calculation ? [`计算或校验：${plain(finding.calculation)}`, ''] : []));
    for (const citation of finding.citations ?? []) {
      const number = sourceNumbers.get(citation.evidenceId);
      lines.push(`来源引用${number ? `[^source-${number}]` : '（来源标识未匹配）'}：${citation.matchStatus === 'matched' ? '文字匹配' : '文字未匹配，需核实'}`, '', quote(citation.quote), '');
    }
  }
  if (dispositions) {
    if (dispositions.reviewId !== review.id) throw new Error('风险处置快照不属于本次报告。');
    const labels = { unreviewed: '待处理', confirmed: '人工确认关注', needs_information: '待补资料', escalated: '升级决策', business_accepted: '业务接受', fixed: '人工标记已整改', false_positive: '人工标记误报' };
    const latest = new Map(dispositions.events.map(event => [event.findingId, event]));
    lines.push('## 导出时的风险处置快照', '', `导出时间：${new Date().toISOString()}；处置修订号：${dispositions.revision}。此节读取当前处理记录，原审核意见和风险等级保持不变。`, '', '业务接受不代表法律合法或风险消失；已整改、误报均为记录人的人工判断，未自动核验整改效果。', '', '| 意见 | 原风险等级 | 当前处理状态 | 记录人 | 原因 | 记录时间 |', '| --- | --- | --- | --- | --- | --- |');
    for (const finding of review.findings) { const event = latest.get(finding.id); lines.push(`| ${cell(finding.title)} | ${finding.severity} | ${event ? labels[event.status] : '待处理'} | ${cell(event?.actorLabel ?? '—')} | ${cell(event?.reason ?? '未记录处置')} | ${event?.createdAt ?? '—'} |`); }
    lines.push('', '### 处理历史', '');
    for (const event of dispositions.events) lines.push(`- ${event.createdAt}；意见ID ${event.findingId}；${labels[event.status]}；记录人 ${inline(event.actorLabel)}；原因：${inline(event.reason)}`);
    if (!dispositions.events.length) lines.push('尚无人工处置记录。');
    lines.push('');
  }
  lines.push('## 检索记录', '');
  if (!retrieval) lines.push('本次未保存知识库或互联网检索记录（兼容早期审核/本地关键词模式）。', '');
  else {
    lines.push('| 通道 | 连接器 | 实际查询 | 状态 | 返回数量 | 错误与覆盖提示 |', '| --- | --- | --- | --- | ---: | --- |');
    for (const attempt of retrieval.attempts) lines.push(`| ${attempt.channel} | ${attempt.provider} | ${cell(attempt.query)} | ${attempt.status} | ${attempt.resultCount} | ${cell([attempt.error, ...attempt.warnings].filter(Boolean).join('；') || '—')} |`);
    for (const attempt of retrieval.attempts) if (attempt.coverage) {
      const coverage = attempt.coverage;
      lines.push('', `官方目录覆盖：读取 ${coverage.catalogPagesRead}/${coverage.totalPages ?? '未知'} 页，本轮页数上限 ${coverage.pagesLimit}；发现 ${coverage.catalogCandidates} 个目录候选，标题命中 ${coverage.matchedCandidates} 个；补充链接读取 ${coverage.userUrlsRead}/${coverage.userUrlsRequested} 个；失败 ${coverage.failedReads} 次。${coverage.truncated ? '本轮达到覆盖或结果上限，不代表全库检索。' : ''}`, '');
    }
    if (!retrieval.attempts.length) lines.push('| — | — | 未派发查询 | 未配置或已停用 | 0 | 以通道状态为准 |');
    lines.push('', '## 来源表', '', '| 编号 | 标题 | 材料类型 | 取得范围 | 实际送入模型 | 效力与时效 |', '| --- | --- | --- | --- | --- | --- |');
    for (const source of sources) {
      const sent = modelEvidenceIds ? modelEvidenceIds.includes(source.id) ? '是' : '否（仅候选）' : '未记录发送清单';
      const scope = source.contentScope === 'search_snippet' ? '搜索摘要，未取得正文' : source.contentScope === 'fragment' ? '来源片段' : '该来源全文';
      lines.push(`| [^source-${sourceNumbers.get(source.id)}] | ${cell(source.title)} | ${source.channel} / ${source.kind} | ${scope} | ${sent} | 未核验 |`);
    }
    if (!sources.length) lines.push('| — | 未取得可用来源 | — | — | — | 不得据此推断不存在法律风险 |');
    lines.push('');
    for (const source of sources) {
      const number = sourceNumbers.get(source.id)!;
      const official = source.officialMetadata;
      lines.push(`[^source-${number}]: ${inline(source.title)}。${link(source.sourceUri)}。定位：${inline(source.locator || '未提供')}。取得时间：${source.retrievedAt}。`, '', `### 来源 ${number} 的取回记录`, '', `发布日期：${inline(source.publishedAt ?? '未知')}；生效日期：${inline(source.effectiveAt ?? '未知')}；时效状态：未知。`, '', `取得范围：${source.contentScope}；官方域名线索：${source.isOfficial ? '是（仍需核验材料性质与效力）' : '未识别'}。`, '', ...(official ? [`发布机关：${inline(official.publisher)}；文号：${inline(official.documentNumber ?? '未知')}；版本：${inline(official.versionLabel ?? '未知')}；条文/段落：${inline(official.article ?? source.locator)}。`, '', `发现方式：${official.discoveredVia === 'catalog' ? '官方目录自动发现' : '用户提供的原文链接'}；目录入口：${link(official.catalogUrl ?? null)}。`, '', plain(official.validityNote), '', ...(source.kind === 'contract_template' ? ['该资料为合同示范文本，仅用于条款结构与措辞参考，不作为法律效力结论。', ''] : [])] : []), ...(source.localIndex ? [`文件 SHA-256：${source.localIndex.fileSha256}；索引版本：${inline(source.localIndex.versionId)}；索引时间：${source.localIndex.indexedAt}。`, ''] : []), `摘录 SHA-256：${source.excerptSha256}`, '', quote(source.excerpt), '', ...source.warnings.map(warning => `- ${plain(warning)}`), '');
    }
  }
  lines.push('## 覆盖与限制', '', ...review.coverage.limitations.map(value => `- ${plain(value)}`), '', `本次覆盖 ${review.coverage.reviewedBlockIds.length}/${review.coverage.totalBlockCount} 个文本块。`);
  return lines.join('\n');
}
