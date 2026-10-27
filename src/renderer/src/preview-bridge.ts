import { APP_VERSION } from '../../shared/app-version';
import type { LicenseState } from '../../shared/licensing';
import type {
  AppState, ContractAssistantBridge, ContractBlock, ContractDetail, DocumentBlocksInput, DocumentReviewsInput, DocumentListInput, ModelConfigInput,
  PublicModelConfig, PublicRetrievalConfig, RetrievalBundle, ReviewFinding, ReviewResult, ReviewTask,
} from '../../shared/contracts';
import { defaultRetrievalConfig } from '../../shared/contracts';
import { defaultKnowledgePreferences } from '../../shared/knowledge-preferences';
import type { EnvironmentReport } from '../../shared/setup';
import type { ChangeProposal, ChangeTarget, ChangeWorkspace } from '../../shared/changes';
import type { ContractDraft } from '../../shared/generation';
import { defaultEnterpriseStandard } from '../../shared/assurance';
import type { EnterpriseStandardContent, EnterpriseStandardProfile, EnterpriseStandardSnapshot, RiskDispositionWorkspace } from '../../shared/assurance';

const sampleParagraphs = [
  '技术服务合同（界面预览样例）',
  '本文件仅用于体验原文定位与本地检查，不构成法律意见，也不是已经完成审核的合同。',
  '第一条 合同主体\n甲方（服务接受方）：[待填写]\n乙方（服务提供方）：[待填写]',
  '第二条 服务内容\n乙方按照双方确认的需求说明提供系统维护服务。具体服务范围及交付清单由双方在附件中约定。',
  '第三条 合同价款与付款\n合同总价为人民币 [待填写] 元。双方应补充付款时间、开票要求和结算条件。',
  '第四条 交付与验收\n乙方提交服务成果后，甲方按照双方书面确认的验收标准进行验收。',
  '第五条 保密\n双方应对履约中获悉的商业秘密和未公开的业务资料承担保密义务。',
  'Reference text / 参考文本\nThe scope of services and acceptance criteria shall be confirmed in writing by both parties.',
  'ข้อความตัวอย่าง / 泰文参考文本\nคู่สัญญาจะตกลงขอบเขตการให้บริการและหลักเกณฑ์การตรวจรับเป็นลายลักษณ์อักษร',
  '第六条 适用法律\n本合同适用中华人民共和国法律。中英文及泰文内容在本样例中仅用于展示多语言文本。',
];

const copy = <T,>(value: T): T => structuredClone(value);
const previewChangeTarget = (block: ContractBlock): ChangeTarget => {
  const base = { blockId: block.id, label: `段落 ${block.ordinal + 1} · ${block.text.slice(0,40)}`, text: block.text };
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(block.text)) return { ...base, editable: false, reason: '此预览段落包含不支持的控制字符。' };
  if (!/[\n\t]/u.test(block.text)) return { ...base, editable: true, reason: null, editMode: 'paragraph' };
  const segments = [...block.text.matchAll(/[^\n\t]+|[\n\t]/gu)].map(match => ({ id: `${block.id}:${match.index}:${match.index + match[0].length}`, rangeStart: match.index, rangeEnd: match.index + match[0].length, text: match[0], editable: !/[\n\t]/u.test(match[0]), reason: /[\n\t]/u.test(match[0]) ? '保留的原有换行或制表符，不可编辑。' : null }));
  return { ...base, editable: segments.some(item => item.editable), reason: null, editMode: 'segments', segments, warnings: ['预览仅在内存模拟文字片段修改；原有换行和制表符保留。'] };
};

/** Browser-only, in-memory UI preview. It never invokes a model or reads local files. */
export function createPreviewBridge(): ContractAssistantBridge {
  const demoDraft: ContractDraft = { id: 'preview-contract-draft', title: '技术服务合同（固定界面演示）', language: 'zh', createdAt: '2026-01-01T00:00:00.000Z', modelId: '固定界面示例 · 未调用模型',
    request: { requestId: '00000000-0000-4000-8000-000000000001', description: '这是一份用于演示条款预览与待补信息的固定合同草稿，不是真实生成结果。', language: 'zh', contractType: 'service', ourPartyRole: 'service_recipient' },
    clauses: [{ heading: '第一条 合同主体与服务范围', paragraphs: ['甲方：[待填写服务接受方]；乙方：[待填写服务提供方]。', '服务范围及成果以双方书面确认的附件为准。'] }, { heading: '第二条 验收与付款', paragraphs: ['验收标准、付款节点、金额及期限：[待双方确认]。'] }], missingInformation: ['双方主体信息、服务范围、验收标准与金额待补充。'], warnings: ['仅为固定界面示例，不构成法律意见；没有调用模型或核验法律依据。'], inputTokens: null, outputTokens: null };
  const documents = new Map<string, ContractDetail>();
  const tasks: ReviewTask[] = [];
  const subscribers = new Set<(task: ReviewTask) => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let modelConfig: PublicModelConfig | null = null;
  let retrievalConfig = defaultRetrievalConfig();
  const changeWorkspaces = new Map<string, ChangeWorkspace>();
  const standards = new Map<string, EnterpriseStandardProfile>();
  const dispositions = new Map<string, RiskDispositionWorkspace>();
  let standardInitialization: Promise<void> | null = null;
  const hashText = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(value => value.toString(16).padStart(2, '0')).join('');
  const ensureStandards = () => standardInitialization ??= (async () => {
    const content = defaultEnterpriseStandard(); content.name = '企业服务审核示例（内存）'; content.description = '固定界面演示标准，不是经过专业确认的审核依据。';
    content.rules = [{ key: 'missing_fields', name: '关注未填写字段', enabled: true, kind: 'flag_phrase', terms: ['[待填写]'], category: 'operational', severity: 'medium', guidance: '补充已确认的交易资料。' }];
    const id = 'e0000000-0000-4000-8000-000000000001'; const version: EnterpriseStandardSnapshot = { id: 'e0000000-0000-4000-8000-000000000002', standardId: id, versionNo: 1, content: copy(content), contentSha256: await hashText(JSON.stringify(content)), publishedAt: '2026-01-01T00:00:00.000Z', publishedBy: '固定界面示例' };
    standards.set(id, { id, revision: 1, draft: copy(content), versions: [version] });
  })();
  const normalizeStandard = (value: EnterpriseStandardContent) => {
    const content = copy(value); content.name = content.name.trim(); content.description = content.description.trim();
    if (!content.name || content.name.length > 120 || content.description.length > 2000 || !content.contractTypes.length || !content.partyRoles.length || content.rules.length > 50) throw new Error('请检查企业方案名称、适用范围或规则数量。');
    const keys = new Set<string>();
    for (const rule of content.rules) { rule.key = rule.key.trim(); rule.name = rule.name.trim(); rule.terms = [...new Set(rule.terms.map(term => term.trim()).filter(Boolean))]; rule.guidance = rule.guidance.trim(); if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(rule.key) || keys.has(rule.key) || !rule.name || rule.name.length > 120 || !rule.terms.length || rule.terms.length > 20 || rule.terms.some(term => term.length > 120 || /[\u0000-\u001f\u007f]/u.test(term)) || rule.guidance.length > 2000) throw new Error('请检查规则标识、名称、匹配词及处理建议。'); keys.add(rule.key); }
    const { maxPrepaymentPercent, maxPaymentDays } = content.thresholds; if ((maxPrepaymentPercent !== null && (!Number.isFinite(maxPrepaymentPercent) || maxPrepaymentPercent < 0 || maxPrepaymentPercent > 100 || Math.abs(maxPrepaymentPercent * 100 - Math.round(maxPrepaymentPercent * 100)) > 1e-9)) || (maxPaymentDays !== null && (!Number.isInteger(maxPaymentDays) || maxPaymentDays < 1 || maxPaymentDays > 3650))) throw new Error('审核阈值超出范围，预付款比例最多两位小数。');
    return content;
  };
  const changeWorkspace = async (reviewId: string) => {
    const document = Array.from(documents.values()).find(item => item.reviews.some(review => review.id === reviewId));
    if (!document) throw new Error('预览审核记录不存在。');
    let workspace = changeWorkspaces.get(reviewId);
    if (!workspace) {
      workspace = { reviewId, documentId: document.id, sourceFileSha256: await hashText(document.blocks.map(block => block.text).join('\n')), revision: 0,
        supported: document.format === 'docx', reason: document.format === 'docx' ? null : 'PDF预览不支持修改稿导出。',
        targets: document.blocks.map(previewChangeTarget),
        proposals: [], exports: [], warnings: ['界面预览只在内存保存手动草稿，没有读取或修改真实 DOCX。'] };
      changeWorkspaces.set(reviewId, workspace);
    }
    return { document, workspace };
  };
  const requireRevision = (workspace: ChangeWorkspace, revision: number) => { if (workspace.revision !== revision) throw new Error('修改记录已更新，请刷新后重试。'); };

  const emit = (task: ReviewTask) => subscribers.forEach((callback) => callback(copy(task)));
  const state = (): AppState => ({
    documents: Array.from(documents.values()).map(({ blocks: _blocks, reviews: _reviews, ...summary }) => summary),
    modelConfig: copy(modelConfig), retrievalConfig: copy(retrievalConfig), tasks: copy(tasks), isPreview: true, appVersion: `${APP_VERSION}-preview`,
  });
  const skippedRetrieval = (): RetrievalBundle => ({
    configSnapshot: copy(retrievalConfig), knowledgeStatus: retrievalConfig.knowledge.enabled ? 'skipped' : 'user_disabled',
    webStatus: retrievalConfig.web.enabled || retrievalConfig.official?.enabled ? 'skipped' : 'user_disabled', officialStatus: retrievalConfig.official?.enabled ? 'skipped' : 'user_disabled', searchStatus: retrievalConfig.web.enabled ? 'skipped' : 'user_disabled', attempts: [], evidence: [],
    limitations: ['浏览器界面预览未联网、未读取本地文件，也没有执行任何真实知识库或互联网检索。'],
  });

  const blockPage = (input: DocumentBlocksInput) => {
    const document = documents.get(input.documentId); if (!document) throw new Error('预览合同不存在，请重新加载样例。');
    const target = input.aroundBlockId ? document.blocks.find(block => block.id === input.aroundBlockId)?.ordinal : input.cursor?.ordinal ?? 0;
    const matched = document.blocks.filter(block => !input.query || `${block.numberingLabel ?? ''} ${block.text}`.toLocaleLowerCase().includes(input.query.toLocaleLowerCase()));
    const candidates = matched.filter(block => block.ordinal >= (target ?? 0)); const items = candidates.slice(0, input.limit ?? 50); const next = candidates[items.length];
    return { items: copy(items), nextCursor: next ? { ordinal: next.ordinal, textOffset: 0 } : null, hasMore: Boolean(next), totalCount: document.blocks.length, matchedCount: matched.length, byteSize: new TextEncoder().encode(JSON.stringify(items)).length, maxBytes: 512 * 1024 };
  };
  const reviewPage = (input: DocumentReviewsInput) => {
    const document = documents.get(input.documentId); if (!document) throw new Error('预览合同不存在，请重新加载样例。');
    const all = [...document.reviews].sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const candidates = all.filter(review => !input.cursor || review.createdAt < input.cursor.createdAt || review.createdAt === input.cursor.createdAt && review.id < input.cursor.id);
    const items = candidates.slice(0, input.limit ?? 25).map(review => ({ id: review.id, documentId: review.documentId, createdAt: review.createdAt, mode: review.mode, findingCount: review.findings.length })); const last = items.at(-1); const hasMore = candidates.length > items.length;
    return { items, nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null, hasMore, totalCount: all.length };
  };
  const documentPage = (input: DocumentListInput = {}) => {
    const all = state().documents.sort((a,b) => b.importedAt.localeCompare(a.importedAt) || b.id.localeCompare(a.id)); const candidates = all.filter(document => !input.cursor || document.importedAt < input.cursor.createdAt || document.importedAt === input.cursor.createdAt && document.id < input.cursor.id);
    const items = candidates.slice(0, input.limit ?? 50); const last = items.at(-1); const hasMore = candidates.length > items.length;
    return { items, nextCursor: hasMore && last ? { createdAt: last.importedAt, id: last.id } : null, hasMore, totalCount: all.length };
  };
  return {
    async runWorkspaceCommand(input) {
      if(input.action==='workspace.interfaceLocale') return {locale:(input.payload as {locale?:string})?.locale??'zh'};
      if(input.action==='workspace.licenseState') return { mode:'development',status:'development',canCreate:true,canViewExport:true,deviceCode:null,license:null,checkedAt:new Date().toISOString(),message:'开发与浏览器预览不使用真实激活码，也不会创建正式许可。' } satisfies LicenseState;
      if(input.action==='workspace.licenseActivate') throw new Error('开发与浏览器预览不使用真实激活码，也不会创建正式许可。');
      throw new Error('此功能需要桌面本地工作空间；浏览器预览不会连接或写入真实资料。');
    },
    async getState() { return state(); },
    async importContract() { throw new Error('浏览器界面预览不能导入本机合同，请在桌面应用中使用真实文件导入。'); },
    async loadSample() {
      const existing = documents.get('preview-sample');
      if (existing) return copy(existing);
      const blocks: ContractBlock[] = sampleParagraphs.map((text, ordinal) => ({
        id: `preview-block-${ordinal}`, ordinal, kind: 'paragraph', text,
        locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: `body/p[${ordinal + 1}]`, paragraphId: null },
      }));
      const detail: ContractDetail = {
        id: 'preview-sample', name: '技术服务合同 · 预览样例.docx', format: 'docx', language: 'mixed',
        byteSize: new TextEncoder().encode(sampleParagraphs.join('\n')).length, blockCount: blocks.length,
        importedAt: new Date().toISOString(), warnings: ['此文件是界面预览样例，没有读取本机文件。'],
        partial: false, latestReviewId: null, blocks, reviews: [],
      };
      documents.set(detail.id, detail);
      return copy(detail);
    },
    async getDocument(id) {
      const document = documents.get(id);
      if (!document) throw new Error('预览合同不存在，请重新加载样例。');
      return copy(document);
    },
    async getDocumentView(id) { const document = documents.get(id); if (!document) throw new Error('预览合同不存在，请重新加载样例。'); const blocks = blockPage({ documentId: id }); return { ...copy(document), blocks: blocks.items, reviews: [], blockPage: blocks, reviewPage: reviewPage({ documentId: id }) }; },
    async listDocumentsPage(input) { return documentPage(input); },
    async getDocumentBlocks(input) { return blockPage(input); },
    async getDocumentReviews(input) { return reviewPage(input); },
    async getReview(id) { for (const document of documents.values()) { const review = document.reviews.find(value => value.id === id); if (review) return copy(review); } throw new Error('审核结果不存在。'); },
    async saveModelConfig(input: ModelConfigInput) {
      modelConfig = {
        ...(input.provider ? { provider: input.provider } : {}),
        name: input.name, baseUrl: input.baseUrl, model: input.model,
        responseFormat: input.responseFormat, tokenParameter: input.tokenParameter,
        maxOutputTokens: input.maxOutputTokens, contextWindowTokens: input.contextWindowTokens,
        timeoutSeconds: input.timeoutSeconds,
        hasApiKey: input.provider === 'codex-cli' ? false : input.clearApiKey ? false : Boolean(input.apiKey?.trim()) || Boolean(modelConfig?.provider !== 'codex-cli' && modelConfig?.hasApiKey),
        keyStorage: 'session-only',
      };
      return copy(modelConfig);
    },
    async testModelConnection() {
      throw new Error('浏览器仅提供界面预览，没有执行 Codex 或发送任何模型请求。请在桌面应用中保存配置并测试真实连接。');
    },
    async selectKnowledgeFolder() {
      throw new Error('浏览器预览不能打开系统文件夹选择器，也没有读取本地资料。请在桌面应用中选择知识库文件夹。');
    },
    async checkEnvironment(): Promise<EnvironmentReport> {
      return {
        checkedAt: new Date().toISOString(), ready: false, isPreview: true,
        checks: ([['runtime', '桌面运行环境'], ['storage', '本机数据存储'], ['fts5', '全文检索组件'], ['languages', '中英泰文本处理'], ['index_worker', '本地索引服务'], ['credentials', '凭据存储']] as const)
          .map(([id, label]) => ({ id, label, status: 'unavailable' as const, message: '浏览器界面预览无法执行此项本机检测或初始化，请使用桌面应用。' })),
      };
    },
    async configureLocalKnowledge() { throw new Error('浏览器界面预览不能保存本机知识库配置或建立索引，没有读取本地资料。请在桌面应用中操作。'); },
    async getKnowledgeState() {
      return {
        folderPath: retrievalConfig.knowledge.folderPath, engine: 'sqlite-fts5' as const,
        tokenizerVersion: '未初始化（浏览器预览）', indexedFiles: 0, chunks: 0, staleFiles: 0,
        lastSyncedAt: null, job: null,
        limitations: ['浏览器界面预览未读取任何本地文件，也没有建立索引。文件计数不代表本机资料覆盖情况。'],
      };
    },
    async startKnowledgeSync() { throw new Error('浏览器界面预览没有读取本地文件，不能建立或更新知识库索引。请在桌面应用中执行。'); },
    async cancelKnowledgeSync() { throw new Error('浏览器界面预览没有正在执行的真实索引任务。'); },
    async searchKnowledge() { throw new Error('浏览器界面预览没有本地资料索引，未执行真实关键词检索。请在桌面应用中测试。'); },
    async getKnowledgeChunk() { throw new Error('浏览器界面预览没有真实知识库片段可读取。'); },
    async openKnowledgeSource() { throw new Error('浏览器界面预览没有读取文件，也没有真实知识库来源可打开。'); },
    async saveRetrievalConfig(input) {
      const next: PublicRetrievalConfig = {
        knowledge: {
          enabled: input.knowledge.enabled, folderPath: input.knowledge.folderPath,
          preferences: copy(input.knowledge.preferences ?? retrievalConfig.knowledge.preferences ?? defaultKnowledgePreferences()),
          api: { enabled: input.knowledge.api.enabled, provider: input.knowledge.api.provider, baseUrl: input.knowledge.api.baseUrl, collectionId: input.knowledge.api.collectionId,
            hasApiKey: input.knowledge.api.clearApiKey ? false : Boolean(input.knowledge.api.apiKey?.trim()) || retrievalConfig.knowledge.api.hasApiKey, keyStorage: 'session-only' },
        },
        web: { enabled: input.web.enabled, provider: input.web.provider, baseUrl: input.web.baseUrl, allowedDomains: [...input.web.allowedDomains], fetchPages: input.web.fetchPages,
          hasApiKey: input.web.clearApiKey ? false : Boolean(input.web.apiKey?.trim()) || retrievalConfig.web.hasApiKey, keyStorage: 'session-only' },
        official: copy(input.official ?? retrievalConfig.official ?? { enabled: false, maxCatalogPages: 3, sourceUrls: [] }),
        maxResults: input.maxResults, timeoutSeconds: input.timeoutSeconds,
      };
      retrievalConfig = next;
      return copy(retrievalConfig);
    },
    async testRetrieval() { return skippedRetrieval(); },
    async testOfficialRetrieval() { throw new Error('浏览器界面预览未联网，不能执行真实官方目录检索。请在桌面应用中测试。'); },
    async cancelOfficialRetrieval() { throw new Error('浏览器界面预览没有真实官方检索任务。'); },
    async openEvidenceSource() {
      throw new Error('浏览器界面预览没有真实来源可打开，请在桌面应用中使用检索结果。');
    },
    async startReview(input) {
      await ensureStandards();
      if (input.mode === 'model') throw new Error('浏览器界面预览不调用模型。请使用桌面应用测试真实 API 审核，或体验本地文本检查。');
      const document = documents.get(input.documentId);
      if (!document) throw new Error('请先加载一份预览样例。');
      const selectedStandard = input.standardVersionId ? [...standards.values()].flatMap(profile => profile.versions).find(version => version.id === input.standardVersionId) : undefined;
      if (input.standardVersionId && !selectedStandard) throw new Error('请选择已发布的企业标准版本，草稿不能用于审核。');
      if (selectedStandard && (!selectedStandard.content.contractTypes.includes(input.context.contractType) || !selectedStandard.content.partyRoles.includes(input.context.ourPartyRole))) throw new Error('该版本不适用于本次合同类型或我方立场。');
      const standardSnapshot = selectedStandard ? copy(selectedStandard) : undefined;
      const task: ReviewTask = {
        id: crypto.randomUUID(), documentId: input.documentId, status: 'running', stage: '本地文本检查',
        startedAt: new Date().toISOString(), finishedAt: null, error: null, resultId: null,
      };
      tasks.unshift(task);
      emit(task);
      timers.set(task.id, setTimeout(() => {
        if (task.status === 'cancelled') return;
        const findings: ReviewFinding[] = document.blocks.filter((block) => /\[待填写\]/.test(block.text)).map((block) => ({
          id: crypto.randomUUID(), blockIds: [block.id], quote: block.text,
          title: '存在尚未填写的交易字段', category: 'operational', severity: 'unrated',
          description: '本地文本规则检测到“[待填写]”占位内容，请核对主体、金额等具体信息。',
          suggestion: '依据已确认的交易信息补充字段，并在补充后重新检查。', legalBasis: null,
          basisStatus: 'unverified', source: 'rule', origin: 'keyword', locationStatus: 'matched',
        }));
        if (standardSnapshot?.content.workflow.runEnterpriseRules) for (const rule of standardSnapshot.content.rules.filter(rule => rule.enabled)) {
          const blocks = document.blocks.filter(block => rule.terms.some(term => block.text.toLocaleLowerCase().includes(term.toLocaleLowerCase())));
          if ((rule.kind === 'flag_phrase' && blocks.length) || (rule.kind === 'required_topic' && !blocks.length)) findings.push({ id: crypto.randomUUID(), blockIds: blocks.map(block => block.id), quote: blocks[0]?.text ?? '', title: `企业标准：${rule.name}`, category: rule.category, severity: rule.severity, description: '内存预览中的企业规则匹配，不代表法律效力判断。', suggestion: rule.guidance, legalBasis: null, basisStatus: 'unverified', source: 'rule', origin: 'enterprise', checkKey: rule.key, locationStatus: blocks.length ? 'matched' : 'unmatched' });
        }
        const retrieval = skippedRetrieval();
        const result: ReviewResult = {
          id: crypto.randomUUID(), documentId: document.id, createdAt: new Date().toISOString(), mode: 'local', modelId: null,
          summary: `本地文本检查完成，检查 ${document.blocks.length} 个原文块，发现 ${findings.length} 项待确认内容。本次没有调用模型，不代表完整法律审核。`,
          findings, context: copy(input.context), ...(standardSnapshot ? { standardSnapshot } : {}),
          programChecks: { engineVersion: 'preview-memory-demo', checks: (['amounts', 'dates', 'references'] as const).map(kind => ({ kind, status: (standardSnapshot?.content.checks[kind] ?? true) ? 'partial' : 'disabled', checkedCount: 0, limitations: ['固定界面演示没有执行真实金额、日期或引用核验。'] })), issues: [] },
          coverage: {
            reviewedBlockIds: document.blocks.map((block) => block.id), totalBlockCount: document.blocks.length,
            knowledgeStatus: retrieval.knowledgeStatus, webStatus: retrieval.webStatus,
            limitations: ['浏览器界面预览，仅执行样例占位符检测。', '未调用模型，未检索知识库和互联网，法律依据未经核验。'],
          },
          inputTokens: null, outputTokens: null, elapsedMs: Date.now() - Date.parse(task.startedAt), retrieval,
        };
        document.reviews.unshift(result);
        document.latestReviewId = result.id;
        task.status = 'completed'; task.stage = '检查完成'; task.finishedAt = new Date().toISOString(); task.resultId = result.id;
        timers.delete(task.id); emit(task);
      }, 750));
      return { taskId: task.id };
    },
    async cancelReview(taskId) {
      const task = tasks.find((item) => item.id === taskId);
      if (!task || !['queued', 'running'].includes(task.status)) return;
      clearTimeout(timers.get(taskId)); timers.delete(taskId);
      task.status = 'cancelled'; task.stage = '已取消'; task.finishedAt = new Date().toISOString(); emit(task);
    },
    async exportReview(reviewId) {
      const document = Array.from(documents.values()).find((item) => item.reviews.some((review) => review.id === reviewId));
      const review = document?.reviews.find((item) => item.id === reviewId);
      if (!document || !review) throw new Error('没有可以导出的预览检查结果。');
      const body = [
        '# 合同检查报告（浏览器预览）', '', `合同：${document.name}`, `生成时间：${review.createdAt}`, '',
        review.summary, '', ...review.findings.flatMap((finding, index) => [
          `## ${index + 1}. ${finding.title}`, '', finding.description, '', `建议：${finding.suggestion}`, '',
        ]), '## 检查限制', '', ...review.coverage.limitations.map((item) => `- ${item}`),
      ].join('\n');
      const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }));
      const link = window.document.createElement('a'); link.href = url; link.download = '合同检查报告-浏览器预览.md'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { path: '浏览器下载：合同检查报告-浏览器预览.md' };
    },
    async getChanges(reviewId) { return copy((await changeWorkspace(reviewId)).workspace); },
    async enableEditableCopy() { throw new Error('界面预览不能启用真实可编辑副本，请在桌面应用中使用。'); },
    async saveChange(input) {
      const { document, workspace } = await changeWorkspace(input.reviewId); requireRevision(workspace, input.expectedRevision);
      const target = workspace.targets.find(item => item.blockId === input.blockId);
      if (!target?.editable) throw new Error('此预览段落暂不支持修改。');
      const segment = target.editMode === 'segments' ? target.segments?.find(item => item.id === input.segmentId) : undefined;
      if (target.editMode === 'segments' && (!segment?.editable || target.text.slice(segment.rangeStart, segment.rangeEnd) !== segment.text)) throw new Error('请选择有效的可编辑文字片段；缺失、伪造或只读片段不能保存。');
      if (target.editMode !== 'segments' && input.segmentId !== undefined) throw new Error('普通段落不接受文字片段编号。');
      const rangeStart = segment?.rangeStart ?? 0; const rangeEnd = segment?.rangeEnd ?? target.text.length; const originalText = segment?.text ?? target.text;
      if (typeof input.replacementText !== 'string' || input.replacementText.length > 30000 || /[\u0000-\u001f\u007f]/u.test(input.replacementText)) throw new Error('修改仅支持最多30,000字、不含新增换行或制表符的纯文字。');
      if (input.replacementText === originalText) throw new Error('修改后文字与原文相同，请先编辑具体内容。');
      const review = document.reviews.find(item => item.id === input.reviewId)!;
      const finding = review.findings.find(item => item.id === input.findingId);
      if (input.findingId && (!finding || (finding.blockIds.length > 0 && !finding.blockIds.includes(input.blockId)))) throw new Error('所选意见与原文段落不匹配。');
      const existing = input.proposalId ? workspace.proposals.find(item => item.id === input.proposalId) : undefined;
      if (input.proposalId && !existing) throw new Error('修改草稿不存在。');
      if (existing && (existing.blockId !== input.blockId || existing.findingId !== input.findingId || existing.rangeStart !== rangeStart || existing.rangeEnd !== rangeEnd || existing.originalText !== originalText)) throw new Error('已保存草稿的原文定位不能更改。');
      const stamp = new Date().toISOString();
      const proposal: ChangeProposal = existing ? { ...existing, replacementText: input.replacementText, status: 'proposed', updatedAt: stamp } : {
        id: crypto.randomUUID(), reviewId: input.reviewId, documentId: document.id, findingId: input.findingId, blockId: input.blockId,
        rangeStart, rangeEnd, originalText, replacementText: input.replacementText,
        sourceFileSha256: workspace.sourceFileSha256, originalTextSha256: await hashText(originalText), status: 'proposed',
        explanation: '界面预览中的手动修改草稿，尚未写入任何真实文件。', warnings: [], modelId: null, createdAt: stamp, updatedAt: stamp,
      };
      workspace.proposals = existing ? workspace.proposals.map(item => item.id === existing.id ? proposal : item) : [...workspace.proposals, proposal];
      workspace.revision++; return copy(workspace);
    },
    async generateChangeDraft() { throw new Error('界面预览不调用模型生成改写，请在桌面应用中使用。'); },
    async cancelChangeDraft() { /* No real model request exists in the preview. */ },
    async decideChange(input) {
      const { workspace } = await changeWorkspace(input.reviewId); requireRevision(workspace, input.expectedRevision);
      const proposal = workspace.proposals.find(item => item.id === input.proposalId);
      if (!proposal || !['proposed','accepted','rejected'].includes(input.status)) throw new Error('修改草稿或处理状态无效。');
      const target = workspace.targets.find(item => item.blockId === proposal.blockId);
      if (input.status === 'accepted' && (!target?.editable || (target.editMode === 'segments' && !target.segments?.some(item => item.editable && item.rangeStart === proposal.rangeStart && item.rangeEnd === proposal.rangeEnd && item.text === proposal.originalText)))) throw new Error('此草稿的原文范围不再可编辑。');
      if (input.status === 'accepted' && workspace.proposals.some(item => item.id !== proposal.id && item.blockId === proposal.blockId && item.status === 'accepted' && item.rangeStart < proposal.rangeEnd && proposal.rangeStart < item.rangeEnd)) throw new Error('同一原文范围已有已采纳修改，请先撤销其中一项。');
      proposal.status = input.status; proposal.updatedAt = new Date().toISOString(); workspace.revision++; return copy(workspace);
    },
    async exportModified() { throw new Error('界面预览不能导出真实修改稿；请在桌面应用中确认修改后导出。'); },
    async listContractDrafts() { const { id, title, language, createdAt, modelId } = demoDraft; return [{ id, title, language, createdAt, modelId }]; },
    async getContractDraft(id) { if (id !== demoDraft.id) throw new Error('界面演示草稿不存在。'); return copy(demoDraft); },
    async generateContract() { throw new Error('界面预览不调用模型生成真实合同，请在桌面应用中使用。'); },
    async cancelContractGeneration() { /* Preview generation never sends a model request. */ },
    async exportContractDraft() { throw new Error('界面预览不能导出真实合同草稿，请在桌面应用中使用。'); },
    async listEnterpriseStandards() { await ensureStandards(); return [...standards.values()].map(profile => ({ id: profile.id, name: profile.draft.name, revision: profile.revision, versions: profile.versions.map(({ content: _content, ...version }) => copy(version)) })); },
    async getEnterpriseStandard(id) { await ensureStandards(); const profile = standards.get(id); if (!profile) throw new Error('企业方案不存在。'); return copy(profile); },
    async saveEnterpriseStandard(input) {
      await ensureStandards(); const previous = input.standardId ? standards.get(input.standardId) : undefined;
      if ((input.standardId && !previous) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== (previous?.revision ?? 0)) throw new Error('企业方案已更新，请刷新记录后重试。');
      const content = normalizeStandard(input.content); const profile = { id: previous?.id ?? crypto.randomUUID(), revision: (previous?.revision ?? 0) + 1, draft: content, versions: previous?.versions ?? [] }; standards.set(profile.id, copy(profile)); return copy(profile);
    },
    async publishEnterpriseStandard(input) {
      await ensureStandards(); const previous = standards.get(input.standardId); if (!previous || previous.revision !== input.expectedRevision) throw new Error('企业方案已更新，请刷新记录后重试。');
      const label = input.publishedBy.trim(); if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label)) throw new Error('请填写有效的发布记录标签。');
      const content = normalizeStandard(previous.draft); const digest = await hashText(JSON.stringify(content)); if (standards.get(previous.id)?.revision !== input.expectedRevision) throw new Error('企业方案已更新，请刷新记录后重试。');
      const version: EnterpriseStandardSnapshot = { id: crypto.randomUUID(), standardId: previous.id, versionNo: previous.versions.length + 1, content: copy(content), contentSha256: digest, publishedAt: new Date().toISOString(), publishedBy: label };
      const profile = { ...previous, revision: previous.revision + 1, versions: [...previous.versions, version] }; standards.set(profile.id, copy(profile)); return copy(profile);
    },
    async getRiskDispositions(reviewId) { const { document } = await changeWorkspace(reviewId); if (!document.reviews.some(review => review.id === reviewId)) throw new Error('审核记录不存在。'); if (!dispositions.has(reviewId)) dispositions.set(reviewId, { reviewId, revision: 0, events: [] }); return copy(dispositions.get(reviewId)!); },
    async saveRiskDisposition(input) {
      const { document } = await changeWorkspace(input.reviewId); const review = document.reviews.find(review => review.id === input.reviewId)!;
      const current = dispositions.get(input.reviewId) ?? { reviewId: input.reviewId, revision: 0, events: [] };
      if (current.revision !== input.expectedRevision) throw new Error('风险处置记录已更新，请刷新后重试。');
      if (!review.findings.some(finding => finding.id === input.findingId) || !['unreviewed', 'confirmed', 'needs_information', 'escalated', 'business_accepted', 'fixed', 'false_positive'].includes(input.status) || !input.reason.trim() || input.reason.trim().length > 2000 || !input.actorLabel.trim() || input.actorLabel.trim().length > 80 || /[\u0000-\u001f\u007f]/u.test(input.actorLabel)) throw new Error('请选择本次审核的风险，并填写有效状态、理由及记录标签。');
      const result: RiskDispositionWorkspace = { reviewId: input.reviewId, revision: current.revision + 1, events: [...current.events, { id: crypto.randomUUID(), reviewId: input.reviewId, findingId: input.findingId, status: input.status, reason: input.reason.trim(), actorLabel: input.actorLabel.trim(), createdAt: new Date().toISOString() }] }; dispositions.set(input.reviewId, result); return copy(result);
    },
    onTaskUpdate(callback) { subscribers.add(callback); return () => { subscribers.delete(callback); }; },
  };
}
