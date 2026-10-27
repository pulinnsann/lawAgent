import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { DiagnosticLog, classifyDiagnosticError } from './diagnostic-log';
import { APP_VERSION } from '../shared/app-version';
import { Worker } from 'node:worker_threads';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { lstat, mkdir, realpath, writeFile, readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { AppState, PublicModelConfig, ModelConfigInput, PublicRetrievalConfig, RetrievalConfigInput, ReviewResult } from '../shared/contracts';
import { CredentialVault, credentialEndpoint } from './vault';
import { nativeInterfaceText, type InterfaceLanguage } from '../shared/interface-language';
import { desktopRequiresLicense } from '../shared/license-access';
import { readElectronDeviceCode } from './device-identity';
import type { KnowledgeHit } from '../shared/knowledge';
import type { ConfigureKnowledgeResult, EnvironmentReport } from '../shared/setup';
import { normalizeKnowledgePreferences } from '../shared/knowledge-preferences';
import { validateOfficialSourceUrl } from '../core/official-sources';
import { validateModelConfig } from '../core/model';
import type { ChangeWorkspace } from '../shared/changes';
import type { ContractDraft } from '../shared/generation';
import { normalizeGenerateContractInput } from '../core/contract-generation';
import { connectionBinding, normalizeConnection } from '../core/workspace-connections';
import { createWorkspaceBackup, inspectWorkspaceBackup, restoreWorkspaceBackup, clearKnowledgeIndex, undoKnowledgeClear } from '../core/workspace-maintenance';
import { acquireWorkspaceLease } from '../core/storage-backend';
import type { WorkspaceAsset } from '../core/workspace-assets';
import type { WorkspaceCommand } from '../shared/workspace-tools';
import { normalizeSaveEnterpriseStandardInput, normalizePublishEnterpriseStandardInput } from '../core/enterprise-standards';

const here = dirname(fileURLToPath(import.meta.url));
const devData = process.env.LAW_AGENT_DATA_DIR || (!app.isPackaged ? resolve('.local/data') : app.getPath('userData'));
let licenseDeviceCode:string|null=null;
let diagnostics:DiagnosticLog|undefined;
const recordDiagnostic=(event:Parameters<DiagnosticLog['record']>[0])=>{try{diagnostics?.record(event);}catch{/* Logging cannot block application work. */}};
app.setPath('userData', devData);
app.setPath('sessionData', join(devData, 'chromium'));
app.setAppLogsPath(join(devData, 'logs'));
app.setName('合同工作台');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const uuid = z.string().uuid();
const pageCursorSchema = z.object({ createdAt: z.string().datetime(), id: uuid }).strict();
const listPageSchema = z.object({ cursor: pageCursorSchema.optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const reviewPageSchema = z.object({ documentId: uuid, cursor: pageCursorSchema.optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
const blockPageSchema = z.object({ documentId: uuid, cursor: z.object({ ordinal: z.number().int().min(0), textOffset: z.number().int().min(0) }).strict().optional(), limit: z.number().int().min(1).max(100).optional(), query: z.string().max(1000).optional(), aroundBlockId: uuid.optional() }).strict();
const chunkId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const knowledgeQuerySchema = z.object({ query: z.string().trim().min(1).max(1000), limit: z.number().int().min(1).max(20).optional(), terms: z.array(z.string().max(120)).max(64).optional() }).strict();
const configSchema = z.object({
  provider: z.enum(['chat-completions', 'codex-cli']).optional(),
  name: z.string().trim().min(1).max(100), baseUrl: z.string().trim().min(1).max(2048), model: z.string().trim().min(1).max(200),
  apiKey: z.string().max(8192).optional(), clearApiKey: z.boolean().optional(),
  responseFormat: z.enum(['json_schema', 'json_object', 'text']), tokenParameter: z.enum(['max_completion_tokens', 'max_tokens']),
  maxOutputTokens: z.number().int().min(256).max(32768), contextWindowTokens: z.number().int().min(4096).max(2000000), timeoutSeconds: z.number().int().min(5).max(600),
}).strict();
const startSchema = z.object({ documentId: uuid, mode: z.enum(['model', 'local']), standardVersionId: uuid.nullable().optional(), context: z.object({ contractType: z.enum(['procurement', 'service', 'other']), ourPartyRole: z.enum(['buyer', 'seller', 'service_provider', 'service_recipient', 'other']), projectId: z.string().max(120).optional(), longContractMode: z.enum(['batch','reject']).optional(), businessContext: z.string().max(10000), strictness: z.enum(['cautious', 'balanced', 'pragmatic']), taskRequirements:z.array(z.object({id:z.string().trim().min(1).max(120),conflictKey:z.string().trim().min(1).max(100),content:z.string().trim().min(1).max(4000),effect:z.enum(['supplement','tighten','relax'])}).strict()).max(30).optional() }).strict() }).strict();
const changeRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const changeSegmentId = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/u).optional();
const saveChangeSchema = z.object({ reviewId: uuid, proposalId: uuid.optional(), findingId: uuid.nullable(), blockId: uuid, segmentId: changeSegmentId, expectedRevision: changeRevision, replacementText: z.string().max(30000) }).strict();
const generateChangeSchema = z.object({ reviewId: uuid, findingId: uuid, blockId: uuid, segmentId: changeSegmentId, expectedRevision: changeRevision }).strict();
const decideChangeSchema = z.object({ reviewId: uuid, proposalId: uuid, status: z.enum(['proposed', 'accepted', 'rejected']), expectedRevision: changeRevision }).strict();
const editableCopySchema = z.object({ reviewId: uuid, expectedRevision: changeRevision }).strict();
const exportChangesSchema = editableCopySchema.extend({ format: z.enum(['clean', 'tracked']).optional(), revisionAuthor: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u).optional() }).strict();
const exportContractDraftSchema = z.object({ draftId: uuid }).strict();
const riskDispositionSchema = z.object({ reviewId: uuid, findingId: uuid, expectedRevision: changeRevision,
  status: z.enum(['unreviewed', 'confirmed', 'needs_information', 'escalated', 'business_accepted', 'fixed', 'false_positive']),
  reason: z.string().trim().min(1).max(2000), actorLabel: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u),
}).strict();
const secretFields = { apiKey: z.string().max(8192).optional(), clearApiKey: z.boolean().optional() };
const knowledgePreferencesSchema = z.object({
  displayName: z.string().trim().min(1).max(60), fileTypes: z.array(z.enum(['txt', 'md', 'docx', 'pdf'])).min(1).max(4),
  excludeDirectories: z.array(z.string().max(512)).max(32), autoSyncEnabled: z.boolean(),
  syncIntervalMinutes: z.number().int().min(5).max(1440), maxFileSizeMb: z.number().int().min(1).max(50),
}).strict().transform(normalizeKnowledgePreferences);
const localKnowledgeSchema = z.object({ folderPath: z.string().min(1).max(4096), preferences: knowledgePreferencesSchema, buildNow: z.boolean() }).strict();
const retrievalSchema = z.object({
  knowledge: z.object({ enabled: z.boolean(), folderPath: z.string().max(4096).nullable(), preferences: knowledgePreferencesSchema.optional(), api: z.object({ enabled: z.boolean(), provider: z.enum(['dify', 'standard']), baseUrl: z.string().max(2048), collectionId: z.string().max(200), ...secretFields }) }),
  web: z.object({ enabled: z.boolean(), provider: z.enum(['brave', 'searxng']), baseUrl: z.string().max(2048), allowedDomains: z.array(z.string().max(253)).max(12), fetchPages: z.boolean(), ...secretFields }),
  official: z.object({ enabled: z.boolean(), maxCatalogPages: z.number().int().min(1).max(10), sourceUrls: z.array(z.string().trim().min(1).max(2048)).max(8),courtCatalogs:z.array(z.literal('interpretations')).max(1).optional() }).strict().optional(),
  maxResults: z.number().int().min(1).max(8), timeoutSeconds: z.number().int().min(5).max(60),
}).strict();

let interfaceLanguage: InterfaceLanguage = 'zh';
const nativeText = (source: string) => nativeInterfaceText(interfaceLanguage, source);
let window: BrowserWindow | null = null;
let core: Worker;
let vault: CredentialVault;
let knowledgeVault: CredentialVault;
let webVault: CredentialVault;
const approvedFolders = new Set<string>();
let workerReady: Promise<void>;
let workerError: Error | null = null;
let sensitiveQueue: Promise<unknown> = Promise.resolve();
// Register before entering the credential queue so cancellation also covers
// requests that have not reached the Core worker yet.
const changeDraftRequests = new Map<string, { cancelled: boolean }>();
const contractGenerationRequests = new Map<string, { cancelled: boolean }>();
const workspaceRequests = new Map<string, { cancelled: boolean }>();
const modelWorkspaceActions = new Set(['translations.generate','modelRuntime.probe','alignment.compare','reporting.translation.generate']);
const preflightWorkspaceActions = new Set([...modelWorkspaceActions,'conversion.convert']);
let maintenanceBusy = false;
const approvedBackups = new Set<string>();
const extensionVaults = new Map<string,CredentialVault>();
let connectionSaveQueue: Promise<unknown> = Promise.resolve();
const mainOperations = new Set<Promise<void>>();
let shuttingDown = false;
const pending = new Map<string, {resolve:(v:any)=>void; reject:(e:Error)=>void; timer:NodeJS.Timeout}>();

async function rpc<T>(command: string, payload: unknown = null, apiKey?: string | null, retrievalKeys?: {knowledgeApiKey:string|null;webApiKey:string|null}, connectionSecrets?:Record<string,string>): Promise<T> {
  await workerReady;
  if (workerError) throw workerError;
  return new Promise((resolve, reject) => {
    const id = randomUUID(); const timer = setTimeout(() => { pending.delete(id); reject(new Error('本地任务响应超时，请重启应用后查看任务状态。')); }, command === 'runWorkspaceCommand' ? 24 * 60 * 60 * 1000 : ['testModelConnection', 'generateChangeDraft', 'generateContract'].includes(command) ? 660000 : 360000);
    pending.set(id, { resolve, reject, timer }); core.postMessage({ id, command, payload, apiKey, retrievalKeys, connectionSecrets });
  });
}

function publicConfig(config: PublicModelConfig | null): PublicModelConfig | null {
  if (config?.provider === 'codex-cli') return { ...config, hasApiKey: false, keyStorage: 'session-only' };
  return config ? { ...config, hasApiKey: Boolean(vault.get(config.baseUrl)), keyStorage: vault.storage } : null;
}

function validateServiceUrl(value: string, required: boolean): string {
  if (!value.trim() && !required) return '';
  let url: URL; try { url = new URL(value.trim()); } catch { throw new Error('检索服务地址不是有效的 URL。'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含账号、密码、查询参数或片段。');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('远端及内网服务请使用 HTTPS；本机服务可使用 HTTP。');
  return url.toString();
}
function knowledgeBinding(config: RetrievalConfigInput): string {
  return `${config.knowledge.api.provider}:${bindingUrl(config.knowledge.api.baseUrl)}|${config.knowledge.api.collectionId.trim()}`;
}
function bindingUrl(value: string): string {
  if (!value) return '';
  const url = new URL(value); url.pathname = url.pathname.replace(/\/+$/, '') || '/'; return url.toString();
}
function webBinding(config: RetrievalConfigInput): string { return `${config.web.provider}:${bindingUrl(config.web.baseUrl)}`; }
function publicRetrieval(config: PublicRetrievalConfig | null | undefined): PublicRetrievalConfig | null {
  if (!config) return null;
  return { ...config, knowledge: { ...config.knowledge, api: { ...config.knowledge.api, hasApiKey: Boolean(knowledgeVault.get(knowledgeBinding(config))), keyStorage: knowledgeVault.storage } }, web: { ...config.web, hasApiKey: Boolean(webVault.get(webBinding(config))), keyStorage: webVault.storage } };
}
function retrievalKeys(config: PublicRetrievalConfig | null | undefined) {
  return { knowledgeApiKey: config ? knowledgeVault.get(knowledgeBinding(config)) : null, webApiKey: config ? webVault.get(webBinding(config)) : null };
}

async function execute(name: string, payload: unknown): Promise<unknown> {
  if(name==='runWorkspaceCommand'&&['maintenance.diagnosticsStatus','maintenance.exportDiagnostics'].includes(String((payload as any)?.action))){
    const input=workspaceEnvelope.parse(payload);z.object({}).strict().parse(input.payload??{});
    if(input.action==='maintenance.diagnosticsStatus')return{...diagnostics?.status(),coreReady:!workerError};
    const choice=await dialog.showSaveDialog(window!,{title:nativeText('导出问题日志'),defaultPath:`lawagent-problem-log-${new Date().toISOString().replace(/[:.]/gu,'-')}.log`,filters:[{name:nativeText('问题日志文件'),extensions:['log']}]});
    if(choice.canceled||!choice.filePath)return null;
    if(shuttingDown)throw new Error('应用正在关闭，未保存新的排查记录。');
    const text=await diagnostics!.exportText();
    if(shuttingDown)throw new Error('应用正在关闭，未保存新的排查记录。');
    const bytes=Buffer.from(text,'utf8');try{await writeFile(choice.filePath,bytes,{flag:'wx',mode:0o600});}catch{throw new Error('排查记录未保存，请选择尚不存在的新文件名，并检查保存位置权限。');}
    recordDiagnostic({event:'diagnostics.exported'});return{path:choice.filePath,fileName:choice.filePath.split(/[\\/]/u).at(-1),bytes:bytes.length};
  }
  if(desktopRequiresLicense(name,payload))await rpc('assertLicenseWritable');
  // Local document and knowledge operations do not need the OS keychain.
  // Unlock only for a user action that actually uses or changes credentials,
  // after the application window has been created.
  const usesModel=['saveModelConfig','testModelConnection','generateContract','generateChangeDraft'].includes(name)||(name==='startReview'&&(payload as any)?.mode==='model');
  if(usesModel){const provider=name==='saveModelConfig'?(payload as any)?.provider:(await rpc<AppState>('getState')).modelConfig?.provider;if(provider!=='codex-cli')await vault.unlock();}
  if(['saveRetrievalConfig','testRetrieval'].includes(name)||(name==='startReview'&&(payload as any)?.mode==='model'))await Promise.all([knowledgeVault.unlock(),webVault.unlock()]);
  switch (name) {
    case 'runWorkspaceCommand': return executeWorkspaceCommand(payload);
    case 'getState': { const state = await rpc<AppState>('getState'); return { ...state, modelConfig: publicConfig(state.modelConfig), retrievalConfig: publicRetrieval(state.retrievalConfig) }; }
    case 'importContract': {
      const selection = await dialog.showOpenDialog(window!, { title: nativeText('导入合同'), properties: ['openFile'], filters: [{ name: nativeText('合同文档'), extensions: ['docx', 'pdf'] }] });
      return selection.canceled ? null : rpc('importFile', selection.filePaths[0]);
    }
    case 'loadSample': return rpc('loadSample');
    case 'selectKnowledgeFolder': {
      const choice = await dialog.showOpenDialog(window!, { title: nativeText('选择本地知识库资料文件夹'), properties: ['openDirectory'] });
      if (choice.canceled || !choice.filePaths[0]) return null;
      const path = await realpath(choice.filePaths[0]); approvedFolders.add(path); return path;
    }
    case 'getDocument': return rpc('getDocument', uuid.parse(payload));
    case 'getDocumentView': return rpc('getDocumentView', uuid.parse(payload));
    case 'getReview': return rpc('getReview', uuid.parse(payload));
    case 'listDocumentsPage': return rpc('listDocumentsPage', listPageSchema.parse(payload ?? {}));
    case 'getDocumentBlocks': return rpc('getDocumentBlocks', blockPageSchema.parse(payload));
    case 'getDocumentReviews': return rpc('getDocumentReviews', reviewPageSchema.parse(payload));
    case 'saveModelConfig': {
      const input = configSchema.parse(payload);
      if (input.provider === 'codex-cli') {
        // Codex owns authentication. Preserve the existing HTTP provider's vault.
        const safe = validateModelConfig(input);
        return publicConfig(await rpc<PublicModelConfig>('saveModelConfig', safe));
      }
      // Validate URL before any credential mutation; Core validates the full provider configuration again.
      let url: URL; try { url = new URL(input.baseUrl); } catch { throw new Error('API 地址不是有效的 URL。'); }
      if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、密码、查询参数或片段。');
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('远端 API 请使用 HTTPS；本机服务可使用 HTTP。');
      const oldCredential = vault.snapshot(); const endpoint = credentialEndpoint(input.baseUrl);
      const checkpoint=await vault.checkpoint();const mutateCredential=Boolean(input.clearApiKey||input.apiKey?.trim());
      if (oldCredential && oldCredential.endpoint !== endpoint && !input.apiKey?.trim() && !input.clearApiKey) throw new Error('更换 API 服务地址后，请重新输入密钥，或清除旧密钥后保存。');
      const nextKey = input.clearApiKey ? null : input.apiKey?.trim() ? { endpoint, apiKey: input.apiKey.trim() } : oldCredential;
      const { apiKey: _key, clearApiKey: _clear, ...safe } = input;
      if(mutateCredential)await vault.set(nextKey);
      try { return publicConfig(await rpc<PublicModelConfig>('saveModelConfig', safe)); }
      catch (error) { if(mutateCredential)await vault.restoreCheckpoint(checkpoint); throw error; }
    }
    case 'testModelConnection': { const state = await rpc<AppState>('getState'); return rpc('testModelConnection', null, state.modelConfig?.provider !== 'codex-cli' && state.modelConfig ? vault.get(state.modelConfig.baseUrl) : null); }
    case 'saveRetrievalConfig': {
      const input = retrievalSchema.parse(payload);
      input.knowledge.api.collectionId = input.knowledge.api.collectionId.trim();
      input.knowledge.api.baseUrl = validateServiceUrl(input.knowledge.api.baseUrl, input.knowledge.enabled && input.knowledge.api.enabled);
      input.web.baseUrl = validateServiceUrl(input.web.baseUrl, input.web.enabled);
      if (input.official) input.official.sourceUrls = [...new Set(input.official.sourceUrls.map(validateOfficialSourceUrl))];
      const state = await rpc<AppState>('getState');
      if (input.knowledge.folderPath && input.knowledge.folderPath !== state.retrievalConfig?.knowledge.folderPath && !approvedFolders.has(input.knowledge.folderPath)) throw new Error('请通过“选择文件夹”授权需要检索的资料目录。');
      const oldKnowledge = knowledgeVault.snapshot(); const oldWeb = webVault.snapshot();
      const [knowledgeCheckpoint,webCheckpoint]=await Promise.all([knowledgeVault.checkpoint(),webVault.checkpoint()]);
      const mutateKnowledge=Boolean(input.knowledge.api.clearApiKey||input.knowledge.api.apiKey?.trim()),mutateWeb=Boolean(input.web.clearApiKey||input.web.apiKey?.trim());
      const prepare = (old: ReturnType<CredentialVault['snapshot']>, binding: string, key?: string, clear?: boolean) => {
        if (old && old.endpoint !== binding && !key?.trim() && !clear) throw new Error('更换检索服务或知识库集合后，请重新输入对应密钥，或清除旧密钥。');
        return clear ? null : key?.trim() ? { endpoint: binding, apiKey: key.trim() } : old;
      };
      const nextKnowledge = prepare(oldKnowledge, knowledgeBinding(input), input.knowledge.api.apiKey, input.knowledge.api.clearApiKey);
      const nextWeb = prepare(oldWeb, webBinding(input), input.web.apiKey, input.web.clearApiKey);
      const { apiKey: _k, clearApiKey: _kc, ...safeApi } = input.knowledge.api;
      const { apiKey: _w, clearApiKey: _wc, ...safeWeb } = input.web;
      try {
        if(mutateKnowledge)await knowledgeVault.set(nextKnowledge);if(mutateWeb)await webVault.set(nextWeb);
        return publicRetrieval(await rpc<PublicRetrievalConfig>('saveRetrievalConfig', { ...input, knowledge: { ...input.knowledge, api: safeApi }, web: safeWeb }));
      } catch (error) {
        if(mutateKnowledge)await knowledgeVault.restoreCheckpoint(knowledgeCheckpoint);if(mutateWeb)await webVault.restoreCheckpoint(webCheckpoint);throw error;
      }
    }
    case 'testRetrieval': { const state = await rpc<AppState>('getState'); return rpc('testRetrieval', null, null, retrievalKeys(state.retrievalConfig), await extensionSecrets()); }
    case 'testOfficialRetrieval': return rpc('testOfficialRetrieval', z.object({ query: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f]+$/u) }).strict().parse(payload));
    case 'cancelOfficialRetrieval': return rpc('cancelOfficialRetrieval');
    case 'getKnowledgeState': return rpc('getKnowledgeState');
    case 'checkEnvironment': {
      const report = await rpc<EnvironmentReport>('checkEnvironment');
      const encrypted = vault.storage==='os-encrypted';
      report.checks.push({ id: 'credentials', label: '连接密钥保存', status: encrypted ? 'passed' : 'warning', message: encrypted ? '系统加密保存可用，模型和检索密钥分别管理。' : vault.encryptionWasChecked ? '系统密钥服务当前不可用，密钥只在本次会话保留，既有密文保留；本地知识库仍可使用。' : '系统密钥将在需要时读取或保存，不影响本地知识库配置；未验证系统加密前仅使用会话内密钥。' });
      return report;
    }
    case 'configureLocalKnowledge': {
      const input = localKnowledgeSchema.parse(payload);
      if (!isAbsolute(input.folderPath) || input.folderPath.includes('\0')) throw new Error('请通过系统选择器选择有效的资料目录。');
      const state = await rpc<AppState>('getState');
      if (input.folderPath !== state.retrievalConfig?.knowledge.folderPath && !approvedFolders.has(input.folderPath)) throw new Error('请先点击“选择文件夹”授权本地知识库目录。');
      const result = await rpc<ConfigureKnowledgeResult>('configureLocalKnowledge', input);
      return { ...result, config: publicRetrieval(result.config)! };
    }
    case 'startKnowledgeSync': return rpc('startKnowledgeSync', z.enum(['incremental', 'verify']).parse(payload));
    case 'cancelKnowledgeSync': return rpc('cancelKnowledgeSync', uuid.parse(payload));
    case 'searchKnowledge': return rpc('searchKnowledge', knowledgeQuerySchema.parse(payload));
    case 'getKnowledgeChunk': return rpc('getKnowledgeChunk', chunkId.parse(payload));
    case 'openKnowledgeSource': {
      const hit = await rpc<KnowledgeHit>('getKnowledgeChunk', chunkId.parse(payload));
      const state = await rpc<AppState>('getState'); const folder = state.retrievalConfig?.knowledge.folderPath;
      if (!folder) throw new Error('知识库目录尚未保存。');
      const url = new URL(hit.sourceUri);
      if (url.protocol !== 'file:') throw new Error('本地引用没有有效的文件入口。');
      const path = fileURLToPath(url); const info = await lstat(path);
      const resolved = await realpath(path); const root = await realpath(folder); const delta = relative(root, resolved);
      if (info.isSymbolicLink() || !info.isFile() || isAbsolute(delta) || delta === '..' || delta.startsWith('../') || delta.startsWith('..\\')) throw new Error('原文已移出授权目录或不是普通文件，请更新知识库。');
      shell.showItemInFolder(resolved); return;
    }
    case 'startReview': { const input=startSchema.parse(payload);const state = await rpc<AppState>('getState'); return rpc('startReview', input, input.mode==='model'&&state.modelConfig?.provider !== 'codex-cli' && state.modelConfig ? vault.get(state.modelConfig.baseUrl) : null, input.mode==='model'?retrievalKeys(state.retrievalConfig):undefined, input.mode==='model'?await extensionSecrets():undefined); }
    case 'openEvidenceSource': {
      const ids = z.object({ reviewId: uuid, evidenceId: uuid }).strict().parse(payload);
      const review = await rpc<ReviewResult>('getReview', ids.reviewId);
      const evidence = review.retrieval?.evidence.find(item => item.id === ids.evidenceId);
      if (!evidence?.sourceUri) throw new Error('这条材料没有可直接打开的来源入口，请查看出处和定位信息。');
      const url = new URL(evidence.sourceUri);
      if (url.protocol === 'file:') {
        const attempt = review.retrieval!.attempts.find(item => item.id === evidence.attemptId);
        const folder = review.retrieval!.configSnapshot.knowledge.folderPath;
        if (attempt?.provider !== 'folder' || !folder) throw new Error('来源不属于已授权的本地资料目录。');
        const path = await realpath(fileURLToPath(url)); const root = await realpath(folder); const within = relative(root, path);
        if (isAbsolute(within) || within === '..' || within.startsWith('../') || within.startsWith('..\\')) throw new Error('来源文件已经移出原资料目录。');
        shell.showItemInFolder(path); return;
      }
      if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(key => /key|token|secret|password|authorization|credential/i.test(key))) throw new Error('来源入口不能安全打开，请根据标题及定位信息手动查找。');
      await shell.openExternal(url.toString()); return;
    }
    case 'cancelReview': return rpc('cancelReview', uuid.parse(payload));
    case 'getChanges': return rpc('getChanges', uuid.parse(payload));
    case 'listEnterpriseStandards': return rpc('listEnterpriseStandards');
    case 'getEnterpriseStandard': return rpc('getEnterpriseStandard', uuid.parse(payload));
    case 'saveEnterpriseStandard': return rpc('saveEnterpriseStandard', normalizeSaveEnterpriseStandardInput(payload));
    case 'publishEnterpriseStandard': return rpc('publishEnterpriseStandard', normalizePublishEnterpriseStandardInput(payload));
    case 'getRiskDispositions': return rpc('getRiskDispositions', uuid.parse(payload));
    case 'saveRiskDisposition': return rpc('saveRiskDisposition', riskDispositionSchema.parse(payload));
    case 'enableEditableCopy': return rpc('enableEditableCopy', editableCopySchema.parse(payload));
    case 'saveChange': return rpc('saveChange', saveChangeSchema.parse(payload));
    case 'generateChangeDraft': {
      const input = generateChangeSchema.parse(payload); const state = await rpc<AppState>('getState');
      if (changeDraftRequests.get(input.reviewId)?.cancelled) throw new Error('修改草稿生成已取消，未发送新的模型请求。');
      return rpc('generateChangeDraft', input, state.modelConfig?.provider !== 'codex-cli' && state.modelConfig ? vault.get(state.modelConfig.baseUrl) : null);
    }
    case 'cancelChangeDraft': {
      const reviewId = uuid.parse(payload); const request = changeDraftRequests.get(reviewId);
      if (request) request.cancelled = true;
      return rpc('cancelChangeDraft', reviewId);
    }
    case 'decideChange': return rpc('decideChange', decideChangeSchema.parse(payload));
    case 'listContractDrafts': return rpc('listContractDrafts');
    case 'getContractDraft': return rpc('getContractDraft', uuid.parse(payload));
    case 'generateContract': {
      const input = normalizeGenerateContractInput(payload); const state = await rpc<AppState>('getState');
      if (contractGenerationRequests.get(input.requestId)?.cancelled) throw new Error('合同生成已取消，未发送新的模型请求。');
      return rpc('generateContract', input, state.modelConfig?.provider !== 'codex-cli' && state.modelConfig ? vault.get(state.modelConfig.baseUrl) : null);
    }
    case 'cancelContractGeneration': {
      const requestId = uuid.parse(payload); const request = contractGenerationRequests.get(requestId);
      if (request) request.cancelled = true;
      return rpc('cancelContractGeneration', requestId);
    }
    case 'exportContractDraft': {
      const input = exportContractDraftSchema.parse(payload); const draft = await rpc<ContractDraft>('getContractDraft', input.draftId);
      const safeName = draft.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);
      const chosen = await dialog.showSaveDialog(window!, { title: nativeText('导出合同草稿并加入工作台（新文件）'), defaultPath: `${safeName}-草稿.docx`, filters: [{ name: nativeText('Word 合同草稿'), extensions: ['docx'] }] });
      if (chosen.canceled || !chosen.filePath) return null;
      const filePath = /\.docx$/i.test(chosen.filePath) ? chosen.filePath : `${chosen.filePath}.docx`;
      return rpc('exportContractDraft', { ...input, filePath });
    }
    case 'exportModified': {
      const input = exportChangesSchema.parse(payload);
      const workspace = await rpc<ChangeWorkspace>('getChanges', input.reviewId);
      if (!workspace.supported || !workspace.proposals.some(item => item.status === 'accepted')) throw new Error(workspace.reason ?? '请先逐项采纳需要导出的修改。');
      const review = await rpc<ReviewResult>('getReview', input.reviewId);
      const document = await rpc<{ name: string }>('getDocumentView', review.documentId);
      const safeName = document.name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);
      const chosen = await dialog.showSaveDialog(window!, { title: nativeText('导出修改稿和修改清单（新文件）'), defaultPath: `${safeName}-${input.format === 'tracked' ? '修订稿' : '修改稿'}.docx`, filters: [{ name: nativeText('Word 修改稿'), extensions: ['docx'] }] });
      if (chosen.canceled || !chosen.filePath) return null;
      const filePath = /\.docx$/i.test(chosen.filePath) ? chosen.filePath : `${chosen.filePath}.docx`;
      return rpc('exportModified', { ...input, filePath });
    }
    case 'exportReview': {
      const report = await rpc<{content:string;name:string;snapshot:unknown}>('exportReview', uuid.parse(payload));
      const safeName = report.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0,100);
      const chosen = await dialog.showSaveDialog(window!, { title: nativeText('导出基础审核报告'), defaultPath: `${safeName}-审核报告.md`, filters: [{ name: nativeText('Markdown 审核报告'), extensions: ['md'] }] });
      if (chosen.canceled || !chosen.filePath) return null;
      await writeFile(chosen.filePath, report.content, { encoding: 'utf8', mode: 0o600,flag:'wx' });
      await rpc('runWorkspaceCommand',{action:'reporting.recordExport',payload:{format:'markdown',sha256:createHash('sha256').update(report.content).digest('hex'),snapshot:report.snapshot}});
      return { path: chosen.filePath };
    }
    default: throw new Error('不支持的应用命令。');
  }
}

const workspaceEnvelope = z.object({ action: z.string().min(1).max(100).regex(/^(?:documents|translations|alignment|reviewCompletion|modelRuntime|reporting|library|connections|conversion|maintenance|workspace)\.[a-zA-Z.]+$/u), payload: z.unknown().optional(), requestId: uuid.optional() }).strict();
async function extensionVault(id:string):Promise<CredentialVault> {uuid.parse(id);let value=extensionVaults.get(id);if(!value){value=new CredentialVault(join(devData,'credentials/extensions',id),safeStorage,value=>value);await value.init();extensionVaults.set(id,value);}return value;}
async function extensionSecrets(includeId?:string):Promise<Record<string,string>> {
 await connectionSaveQueue;
 const assets=await rpc<WorkspaceAsset[]>('runWorkspaceCommand',{action:'connections.list'});const result:Record<string,string>={};for(const asset of assets.filter(a=>a.body.enabled||a.id===includeId).slice(0,16)){const value=(await extensionVault(asset.id)).get(connectionBinding(asset));if(value)result[asset.id]=value;}return result;
}
async function renderPdf(html:string):Promise<Buffer>{
 const leaseId=randomUUID();
 try{await rpc('acquireResource',{id:leaseId});if(shuttingDown)throw new Error('应用正在关闭，未开始 PDF 导出。');
 if(Buffer.byteLength(html)>10*1024**2)throw new Error('报告内容超过PDF导出上限。');
 const renderer=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:false,partition:`report-${randomUUID()}`}});
 renderer.webContents.setWindowOpenHandler(()=>({action:'deny'}));renderer.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('data:')&&!details.url.startsWith('about:')}));
 try{await renderer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);return await renderer.webContents.printToPDF({pageSize:'A4',printBackground:true,preferCSSPageSize:true});}finally{renderer.destroy();}

 }finally{await rpc('releaseResource',{id:leaseId}).catch(()=>{});}
}
async function executeWorkspaceCommand(value:unknown):Promise<unknown>{
 const input=workspaceEnvelope.parse(value);if(Buffer.byteLength(JSON.stringify(input.payload??null))>2*1024**2)throw new Error('工作台输入超过2 MiB。');const p=(input.payload??{}) as any;
 const checkCancelled=()=>{if(shuttingDown||input.requestId&&workspaceRequests.get(input.requestId)?.cancelled)throw new Error('工作台任务已取消，未开始新的处理。');};
 if(preflightWorkspaceActions.has(input.action))checkCancelled();
 if(input.action==='workspace.interfaceLocale'){const selected=z.object({locale:z.enum(['zh','en','th'])}).strict().parse(p);interfaceLanguage=selected.locale;window?.setTitle(nativeText('合同工作台'));return{locale:interfaceLanguage};}
 if(input.action==='workspace.cancel'){
  const cancel=z.object({requestId:uuid}).strict().parse(p);const request=workspaceRequests.get(cancel.requestId);if(request)request.cancelled=true;
  return rpc('runWorkspaceCommand',input);
 }
 if(input.action.startsWith('maintenance.'))return executeMaintenance(input);
 if(input.action==='documents.importVersion'){
  const version=z.object({parentDocumentId:uuid,expectedLatestDocumentId:uuid}).strict().parse(p);
  const selection=await dialog.showOpenDialog(window!,{title:nativeText('导入该合同的下一版本（保留原件）'),properties:['openFile'],filters:[{name:nativeText('合同文档'),extensions:['docx','pdf']}]});
  return selection.canceled?null:rpc('importVersionFile',{...version,path:selection.filePaths[0]});
 }
 if(modelWorkspaceActions.has(input.action)){
  const state=await rpc<AppState>('getState');checkCancelled();if(state.modelConfig?.provider!=='codex-cli')await vault.unlock();checkCancelled();
  return rpc('runWorkspaceCommand',input,state.modelConfig?.provider!=='codex-cli'&&state.modelConfig?vault.get(state.modelConfig.baseUrl):null);
 }
 if(input.action==='connections.chooseDirectory'){const selected=await dialog.showOpenDialog(window!,{title:nativeText('选择共享盘或挂载目录'),properties:['openDirectory']});if(selected.canceled)return null;const path=await realpath(selected.filePaths[0]);approvedFolders.add(path);return path;}
 if(input.action==='connections.save'){
  const saving = connectionSaveQueue.then(async () => {
  const parsed=z.object({id:uuid.optional(),expectedRevision:changeRevision,body:z.unknown(),actorLabel:z.string().max(80).optional(),secret:z.string().max(131072).optional(),clearSecret:z.boolean().optional()}).strict().parse(p);
  const body=normalizeConnection(parsed.body);const id=parsed.id??randomUUID();
  if(body.type==='directory'){const all=await rpc<WorkspaceAsset[]>('runWorkspaceCommand',{action:'connections.list'});if(!approvedFolders.has(body.root)&&!all.some(a=>a.id===id&&a.body.root===body.root))throw new Error('请通过选择目录按钮授权共享盘。');}
  const credential=await extensionVault(id);const old=credential.snapshot();const binding=connectionBinding({id,body});const checkpoint=await credential.checkpoint();const mutateCredential=Boolean(parsed.clearSecret||parsed.secret?.trim());
  const secretToStore = parsed.clearSecret ? null : parsed.secret?.trim() || old?.apiKey;
  if (secretToStore && JSON.stringify(body).includes(secretToStore)) throw new Error('连接公开配置含有与凭据相同的内容，请将凭据仅填写在凭据输入框。');
  if(old&&old.endpoint!==binding&&!parsed.secret?.trim()&&!parsed.clearSecret)throw new Error('连接目标已改变，请重新输入凭据，或清除旧凭据后保存。');
  if(mutateCredential)await credential.set(parsed.clearSecret?null:parsed.secret?.trim()?{endpoint:binding,apiKey:parsed.secret.trim()}:old);
  try{return await rpc('runWorkspaceCommand',{...input,payload:{id,expectedRevision:parsed.expectedRevision,body,actorLabel:parsed.actorLabel}});}catch(error){if(mutateCredential)await credential.restoreCheckpoint(checkpoint);throw error;}
  }); connectionSaveQueue = saving.catch(() => {}); return saving;
 }
 if(input.action==='connections.useKnowledge'){
  const assets=await rpc<WorkspaceAsset[]>('runWorkspaceCommand',{action:'connections.list'});const asset=assets.find(a=>a.id===uuid.parse(p.id));if(!asset)throw new Error('连接不存在。');const body=normalizeConnection(asset.body);const folder=body.type==='directory'?body.root:body.type==='sftp'?join(devData,'remote-cache',asset.id):null;if(!folder)throw new Error('此连接使用远端检索，不需要本地建库。');const path=await realpath(folder);approvedFolders.add(path);
  const state=await rpc<AppState>('getState');const preferences=normalizeKnowledgePreferences({...state.retrievalConfig?.knowledge.preferences,displayName:body.name});return rpc('configureLocalKnowledge',{folderPath:path,preferences,buildNow:Boolean(p.buildNow)});
 }
 if(input.action==='reporting.export'){
  const format=z.enum(['docx','pdf','markdown','html','csv']).parse(p.format);const ext=format==='markdown'?'md':format;
  const choice=await dialog.showSaveDialog(window!,{title:nativeText('导出报告'),defaultPath:`${nativeInterfaceText(['zh','en','th'].includes(p.settings?.language)?p.settings.language:interfaceLanguage,'合同工作报告')}.${ext}`,filters:[{name:format.toUpperCase(),extensions:[ext]}]});if(choice.canceled||!choice.filePath)return null;
  const {format:_format,...query}=p;const result=await rpc<any>('runWorkspaceCommand',{...input,action:'reporting.render',payload:query});
  const bytes=format==='docx'?Buffer.from(result.docxBase64,'base64'):format==='pdf'?await renderPdf(result.html):Buffer.from(result[format==='markdown'?'markdown':format]??'','utf8');await writeFile(choice.filePath,bytes,{flag:'wx',mode:0o600});
  await rpc('runWorkspaceCommand',{action:'reporting.recordExport',payload:{format,sha256:createHash('sha256').update(bytes).digest('hex'),snapshot:result.snapshot}});return{path:choice.filePath};
 }
 if(input.action==='library.authoring.export'){
  const p=z.object({id:uuid,expectedRevision:changeRevision,actorLabel:z.string().trim().min(1).max(80)}).strict().parse(input.payload);
  const rendered=await rpc<any>('runWorkspaceCommand',{action:'library.authoring.renderConfirmed',payload:{id:p.id,expectedRevision:p.expectedRevision}});
  const choice=await dialog.showSaveDialog(window!,{title:nativeText('导出已确认合同'),defaultPath:rendered.filename,filters:[{name:nativeText('Word合同'),extensions:['docx']}]});if(choice.canceled||!choice.filePath)return null;
  const bytes=Buffer.from(rendered.docxBase64,'base64');await writeFile(choice.filePath,bytes,{flag:'wx',mode:0o600});
  try{await rpc('runWorkspaceCommand',{action:'library.authoring.recordExport',payload:{...p,sha256:createHash('sha256').update(bytes).digest('hex')}});}catch(error){throw new Error(`合同已导出，导出记录保存失败：${error instanceof Error?error.message:'本地服务异常'}`);}
  return{path:choice.filePath,document:rendered.document};
 }
 if(input.action==='library.template.export')throw new Error('请先通过模板的“核验与审核”完成逐项确认，再导出。');
 if(input.action==='conversion.convert'){
  const choice=await dialog.showSaveDialog(window!,{title:nativeText('导出并加入合同工作台'),defaultPath:input.action==='conversion.convert'?'PDF文字副本.docx':'企业模板合同.docx',filters:[{name:nativeText('Word合同'),extensions:['docx']}]});checkCancelled();if(choice.canceled||!choice.filePath)return null;
  const rendered=await rpc<any>('runWorkspaceCommand',input);checkCancelled();
  const bytes=Buffer.from(rendered.docxBase64,'base64');await writeFile(choice.filePath,bytes,{flag:'wx',mode:0o600});
  try{const document=await rpc('importDerivedBytes',{name:rendered.filename,base64:rendered.docxBase64,source:rendered.sourceSnapshot,draft:rendered.draft,partial:rendered.partial,warnings:rendered.warnings});return{path:choice.filePath,document,missingInformation:rendered.missingInformation,warnings:rendered.warnings,partial:Boolean(rendered.partial)};}catch(error){throw new Error(`文件已导出，但加入工作台未完成，请手动导入：${error instanceof Error?error.message:'本地存储异常'}`);}
 }
 if(['reporting.render','library.template.render','reporting.recordExport','library.authoring.renderConfirmed','library.authoring.recordExport'].includes(input.action))throw new Error('请使用前端导出按钮选择保存位置。');
 if(input.action.startsWith('workspace.')) return rpc('runWorkspaceCommand',input);
 return rpc('runWorkspaceCommand',input,null,undefined,input.action.startsWith('connections.')?await extensionSecrets(p.id):undefined);
}
async function executeMaintenance(input:WorkspaceCommand):Promise<unknown>{
 const p=(input.payload??{}) as any;
 if(input.action==='maintenance.status'){const counts=await rpc<any>('runWorkspaceCommand',{action:'workspace.status'});const index=await stat(join(devData,'local-knowledge/index.sqlite')).catch(()=>null);return{dataDir:devData,...counts,index:{byteSize:index?.size??0},canUndoClear:Boolean(await stat(join(devData,'recovery/latest-knowledge.json')).catch(()=>null))};}
 if(input.action==='maintenance.inspectBackup'){const selected=await dialog.showOpenDialog(window!,{title:nativeText('选择备份目录'),properties:['openDirectory']});if(selected.canceled)return null;const result=await inspectWorkspaceBackup(selected.filePaths[0]);approvedBackups.add(result.path);return result;}
 let backupParent:string|undefined;
 if(input.action==='maintenance.backup'){const selected=await dialog.showOpenDialog(window!,{title:nativeText('选择备份保存位置'),properties:['openDirectory','createDirectory']});if(selected.canceled)return null;backupParent=selected.filePaths[0];}
 if(!['maintenance.backup','maintenance.restore','maintenance.clearKnowledge','maintenance.undoClear'].includes(input.action))throw new Error('不支持的维护操作。');
 if(maintenanceBusy)throw new Error('已有数据维护操作运行，请等待收尾。');
 if(pending.size)throw new Error('仍有本地操作运行，请先等待或取消后再维护数据。');
 if(mainOperations.size)throw new Error('仍有配置、导出或文件操作运行，请先等待完成后再维护数据。');
 if(input.action==='maintenance.restore'&&!p.confirmed||input.action==='maintenance.clearKnowledge'&&!p.confirmed)throw new Error('请先在界面确认恢复或清理操作。');
 maintenanceBusy=true;let stopped=false;let releaseMaintenance:(()=>Promise<void>)|undefined;
 try{
  if(input.action==='maintenance.restore'){const path=await realpath(z.string().min(1).max(4096).parse(p.backupPath));if(!approvedBackups.has(path))throw new Error('请先通过界面选择并核验备份。');await inspectWorkspaceBackup(path);}
  await connectionSaveQueue;
  await sensitiveQueue;
  const state=await rpc<AppState>('getState');
  if (state.tasks.some(task => task.status === 'queued' || task.status === 'running')) throw new Error('仍有合同审核运行，请先等待或取消审核后再维护数据。');
  const knowledge = await rpc<import('../shared/knowledge').KnowledgeState>('getKnowledgeState');
  if (knowledge.job?.status === 'running') throw new Error('知识库仍在同步，请先等待或取消同步后再维护数据。');
  if(input.action==='maintenance.clearKnowledge'&&state.retrievalConfig)await rpc('saveRetrievalConfig',{...state.retrievalConfig,knowledge:{...state.retrievalConfig.knowledge,enabled:false,preferences:{...state.retrievalConfig.knowledge.preferences,autoSyncEnabled:false}}});
  await rpc('close');await core.terminate();stopped=true;
  releaseMaintenance=await acquireWorkspaceLease(devData);
  if(input.action==='maintenance.backup')return await createWorkspaceBackup(devData,backupParent!,Boolean(p.includeKnowledge));
  if(input.action==='maintenance.restore'){const result=await restoreWorkspaceBackup(devData,p.backupPath);return{...result,message:'备份已恢复，恢复前数据保留在恢复目录；请关闭并重新打开功能面板。'};}
  if(input.action==='maintenance.clearKnowledge')return{...await clearKnowledgeIndex(devData,state.retrievalConfig),message:'索引已移至恢复目录，原资料与历史报告保留，资料连接已停用。'};
  const restored=await undoKnowledgeClear(devData);return{...restored,message:'已恢复清理前索引，资料连接可在设置中重新启用。'};
 }finally{try{await releaseMaintenance?.();if(stopped){startCore();await workerReady;}}finally{maintenanceBusy=false;if(!BrowserWindow.getAllWindows().length)app.quit();}}
}

function startCore(): void {
  workerError = null;
  workerReady = new Promise<void>((resolve, reject) => {
    core = new Worker(new URL('./core-worker.js', import.meta.url), { workerData: { dataDir: devData, licensing: {mode:app.isPackaged?'required':'development',deviceCode:licenseDeviceCode} },stdout:true,stderr:true });
    core.stdout?.resume();core.stderr?.resume();
    const fail = (error?:unknown) => {
      if(!shuttingDown&&!maintenanceBusy)recordDiagnostic({event:'core.error',...classifyDiagnosticError(error)});
      workerError = new Error('本地服务已停止，请重启应用。已保存的合同会在重新启动后恢复。');
      reject(workerError); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(workerError); } pending.clear();
    };
    core.on('message', message => {
      if (message.type === 'ready') {recordDiagnostic({event:'core.ready'});resolve();}
      else if (message.type === 'task') window?.webContents.send('contract-assistant:task', message.task);
      else if (message.type === 'response') { const p = pending.get(message.id); if (!p) return; clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(new Error(message.error)) : p.resolve(message.data); }
    });
    core.on('error', fail); core.on('exit', code => {recordDiagnostic({event:'core.exit',exitCode:code}); if (code !== 0) fail(); });
  });
  // A rejected startup is surfaced to every command without an unhandled rejection.
  void workerReady.catch(() => {});

}

// Let the ESM entry finish loading before waiting for Electron readiness.
// Awaiting whenReady at module scope can block the ready event itself.
async function bootstrap(): Promise<void> {
  await app.whenReady();
  await mkdir(devData, { recursive: true });
  diagnostics=await DiagnosticLog.open(resolve(devData),{appVersion:APP_VERSION,platform:process.platform,arch:process.arch,nodeVersion:process.versions.node,runtime:'electron',mode:app.isPackaged?'required':'development'});
  recordDiagnostic({event:'desktop.starting'});
  licenseDeviceCode=await readElectronDeviceCode();
  vault = new CredentialVault(join(devData, 'credentials'), safeStorage); await vault.init({deferUnlock:true});
  knowledgeVault = new CredentialVault(join(devData, 'credentials/knowledge'), safeStorage, value => value); await knowledgeVault.init({deferUnlock:true});
  webVault = new CredentialVault(join(devData, 'credentials/web'), safeStorage, value => value); await webVault.init({deferUnlock:true});
  startCore();

  const handleCommand=async (event:Electron.IpcMainInvokeEvent, envelope: unknown) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: '无法识别的应用请求。' };
    let operation: Promise<void> | undefined;
    let finishOperation: (() => void) | undefined;
    try {
      if (shuttingDown) throw new Error('应用正在关闭，请等待文件操作收尾。');
      const { name, payload } = z.object({ name: z.string().min(1).max(100), payload: z.unknown().optional() }).strict().parse(envelope);
      if(name==='runWorkspaceCommand'&&['maintenance.diagnosticsStatus','maintenance.exportDiagnostics'].includes(String((payload as any)?.action))){
        operation=new Promise<void>(resolve=>{finishOperation=resolve;});mainOperations.add(operation);
        return{ok:true,data:await execute(name,payload)};
      }
      if (maintenanceBusy) throw new Error('正在备份、恢复或维护数据，请稍后操作。');
      if (!(name === 'runWorkspaceCommand' && String((payload as any)?.action).startsWith('maintenance.'))) {
        operation = new Promise<void>(resolve => { finishOperation = resolve; }); mainOperations.add(operation);
      }
      if (name === 'runWorkspaceCommand' && preflightWorkspaceActions.has(String((payload as any)?.action))) {
        const input = workspaceEnvelope.parse(payload); const requestId = input.requestId ?? randomUUID();
        if (workspaceRequests.has(requestId)) throw new Error('此工作台任务正在执行，请勿重复提交。');
        if (workspaceRequests.size >= 32) throw new Error('准备中的工作台任务过多，请等待或取消后重试。');
        const request = { cancelled: false }; workspaceRequests.set(requestId, request);
        const next = sensitiveQueue.then(() => {
          if (request.cancelled || shuttingDown) throw new Error('工作台任务已取消，未开始新的处理。');
          return execute(name, { ...input, requestId });
        }); sensitiveQueue = next.catch(() => {});
        try { return { ok: true, data: await next }; }
        finally { if (workspaceRequests.get(requestId) === request) workspaceRequests.delete(requestId); }
      }
      if (name === 'generateContract') {
        const input = normalizeGenerateContractInput(payload);
        if (contractGenerationRequests.size) throw new Error('已有合同正在生成或排队，请等待或取消。');
        const request = { cancelled: false }; contractGenerationRequests.set(input.requestId, request);
        const next = sensitiveQueue.then(() => {
          if (request.cancelled) throw new Error('合同生成已取消，未发送新的模型请求。');
          return execute(name, input);
        });
        sensitiveQueue = next.catch(() => {});
        try { return { ok: true, data: await next }; }
        finally { if (contractGenerationRequests.get(input.requestId) === request) contractGenerationRequests.delete(input.requestId); }
      }
      if (name === 'generateChangeDraft') {
        const input = generateChangeSchema.parse(payload);
        if (changeDraftRequests.has(input.reviewId)) throw new Error('本次审核已有修改草稿正在生成或排队，请等待或取消。');
        const request = { cancelled: false }; changeDraftRequests.set(input.reviewId, request);
        const next = sensitiveQueue.then(() => {
          if (request.cancelled) throw new Error('修改草稿生成已取消，未发送新的模型请求。');
          return execute(name, input);
        });
        sensitiveQueue = next.catch(() => {});
        try { return { ok: true, data: await next }; }
        finally { if (changeDraftRequests.get(input.reviewId) === request) changeDraftRequests.delete(input.reviewId); }
      }
      if (['saveModelConfig','testModelConnection','saveRetrievalConfig','testRetrieval','testOfficialRetrieval','startReview','configureLocalKnowledge'].includes(name)) {
        const next = sensitiveQueue.then(() => execute(name, payload)); sensitiveQueue = next.catch(() => {});
        return { ok: true, data: await next };
      }
      return { ok: true, data: await execute(name, payload) };
    } catch (error) {
      return { ok: false, error: error instanceof z.ZodError ? '输入格式或数值范围不正确，请检查设置。' : error instanceof Error ? error.message : '操作失败，请重试。' };
    } finally {
      if (operation) mainOperations.delete(operation); finishOperation?.();
    }
  };
  ipcMain.handle('contract-assistant:command',async(event,envelope:unknown)=>{
    const started=performance.now();const parsed=z.object({name:z.string().min(1).max(100),payload:z.unknown().optional()}).strict().safeParse(envelope);
    const command=parsed.success?parsed.data.name:undefined;const action=parsed.success&&command==='runWorkspaceCommand'&&typeof(parsed.data.payload as any)?.action==='string'?(parsed.data.payload as any).action:undefined;
    recordDiagnostic({event:'command.started',command,action});const result=await handleCommand(event,envelope);
    recordDiagnostic({event:result.ok?'command.completed':'command.failed',command,action,durationMs:Math.round(performance.now()-started),...(result.ok?{}:classifyDiagnosticError(new Error(result.error)))});return result;
  });

  function createWindow(): void {
    window = new BrowserWindow({ width: 1480, height: 980, minWidth: 760, minHeight: 560, backgroundColor: '#f4f5f2', title: nativeText('合同工作台'), webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void window.loadFile(join(here, '../renderer/index.html'));
    window.on('closed', () => { window = null; });
  }
  createWindow();
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.on('activate', () => { if (!window) createWindow(); });
  app.on('window-all-closed', () => app.quit());
  let closing = false;
  let shutdownComplete = false;
  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (maintenanceBusy) return;
    if (closing) return;
    closing = true;
    recordDiagnostic({event:'desktop.closing'});
    shuttingDown = true;
    for (const request of workspaceRequests.values()) request.cancelled = true;
    const finish = () => {
      if (shutdownComplete) return;
      shutdownComplete = true;
      clearTimeout(deadline);
      void core?.terminate();
      recordDiagnostic({event:'desktop.closed'});void diagnostics?.close().finally(()=>app.quit());
      if(!diagnostics)app.quit();
    };
    // Cancel pending network work and persist completed retrieval branches before
    // releasing the worker. Forced termination still recovers as interrupted.
    const deadline = setTimeout(finish, 30000);
    void Promise.allSettled([rpc('close'), sensitiveQueue, connectionSaveQueue, ...mainOperations]).finally(finish);
  });
}

void bootstrap().catch(async error => {
  recordDiagnostic({event:'desktop.startup_failed',...classifyDiagnosticError(error)});await diagnostics?.close();
  dialog.showErrorBox('合同工作台启动失败', '本地服务未能启动。请检查应用数据目录权限，关闭后重新启动；已保存的合同不会因此删除。');
  app.quit();
});
