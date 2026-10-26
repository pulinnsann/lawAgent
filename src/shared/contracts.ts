import type { KnowledgeHit, KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeState, KnowledgeSyncMode } from './knowledge';
import type { KnowledgePreferences } from './knowledge';
import { defaultKnowledgePreferences } from './knowledge-preferences';
import type { ConfigureKnowledgeInput, ConfigureKnowledgeResult, EnvironmentReport } from './setup';
import type { ChangeWorkspace, SaveChangeInput, GenerateChangeInput, DecideChangeInput, ExportChangesInput, ExportChangesResult, EnableEditableCopyInput } from './changes';
import type { ContractDraft, ContractDraftSummary, GenerateContractInput, ExportContractDraftInput, ExportContractDraftResult } from './generation';
import type { EnterpriseStandardSnapshot, EnterpriseStandardSummary, EnterpriseStandardProfile, SaveEnterpriseStandardInput, PublishEnterpriseStandardInput, ProgramCheckReport, RiskDispositionWorkspace, SaveRiskDispositionInput } from './assurance';

export type Language = 'zh' | 'en' | 'th' | 'mixed' | 'unknown';
export type Severity = 'high' | 'medium' | 'low' | 'unrated';
export type FindingCategory = 'legal' | 'commercial' | 'operational';

export interface ContractBlock {
  id: string;
  ordinal: number;
  kind: 'paragraph' | 'table_cell' | 'header' | 'footer' | 'other';
  text: string;
  numberingLabel?: string;
  locator: { kind: 'docx'; partName: string; structuralPath: string; paragraphId: string | null }
    | { kind: 'pdf'; pageIndex: number; pageWidth: number; pageHeight: number; boxes: Array<{ x: number; y: number; width: number; height: number }> };
}

export interface ParsedContract {
  format: 'docx' | 'pdf';
  language: Language;
  blocks: ContractBlock[];
  warnings: string[];
  pageCount: number | null;
  partial: boolean;
}

export interface ContractSummary {
  id: string;
  contractId?: string;
  versionNo?: number;
  parentVersionId?: string | null;
  versionKind?: string;
  projectId?: string | null;
  lifecycleStatus?: import('./document-workspace').LifecycleStatus;
  contractRevision?: number;
  name: string;
  format: 'docx' | 'pdf';
  language: Language;
  byteSize: number;
  blockCount: number;
  importedAt: string;
  warnings: string[];
  partial: boolean;
  latestReviewId: string | null;
}

export interface ContractDetail extends ContractSummary { blocks: ContractBlock[]; reviews: ReviewResult[] }

/** Cursors are scoped to the requested immutable document version. Text offsets
 * count Unicode code points (SQLite substr), never DOCX edit/UTF-16 offsets. */
export interface DocumentListCursor { createdAt: string; id: string }
export interface DocumentListInput { cursor?: DocumentListCursor; limit?: number }
export interface DocumentListPage { items: ContractSummary[]; nextCursor: DocumentListCursor | null; hasMore: boolean; totalCount: number }
export interface BlockPageCursor { ordinal: number; textOffset: number }
export interface DocumentBlocksInput { documentId: string; cursor?: BlockPageCursor; limit?: number; query?: string; aroundBlockId?: string }
export interface DisplayContractBlock extends ContractBlock { textWindow?: { offset: number; length: number; totalLength: number; unit: 'unicode-code-point' } }
export interface DocumentBlockPage { items: DisplayContractBlock[]; nextCursor: BlockPageCursor | null; hasMore: boolean; totalCount: number; matchedCount: number; byteSize: number; maxBytes: number }
export interface ReviewSummary { id: string; documentId: string; createdAt: string; mode: ReviewResult['mode']; findingCount: number }
export interface DocumentReviewsInput { documentId: string; cursor?: DocumentListCursor; limit?: number }
export interface ReviewSummaryPage { items: ReviewSummary[]; nextCursor: DocumentListCursor | null; hasMore: boolean; totalCount: number }
export interface ContractView extends ContractDetail { blockPage: DocumentBlockPage; reviewPage: ReviewSummaryPage }

export interface ModelConfigInput {
  /** Missing on existing configurations: continue using Chat Completions. */
  provider?: 'chat-completions' | 'codex-cli';
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
  responseFormat: 'json_schema' | 'json_object' | 'text';
  tokenParameter: 'max_completion_tokens' | 'max_tokens';
  maxOutputTokens: number;
  contextWindowTokens: number;
  timeoutSeconds: number;
}

export interface PublicModelConfig extends Omit<ModelConfigInput, 'apiKey' | 'clearApiKey'> {
  hasApiKey: boolean;
  keyStorage: 'os-encrypted' | 'session-only';
}

export type RetrievalStatus = 'not_configured' | 'user_disabled' | 'skipped' | 'complete' | 'empty' | 'partial' | 'timeout' | 'failed' | 'cancelled';
export interface KnowledgeApiConfig {
  enabled: boolean;
  provider: 'dify' | 'standard';
  baseUrl: string;
  collectionId: string;
  apiKey?: string;
  clearApiKey?: boolean;
}
export interface WebSearchConfig {
  enabled: boolean;
  provider: 'brave' | 'searxng';
  baseUrl: string;
  apiKey?: string;
  clearApiKey?: boolean;
  allowedDomains: string[];
  fetchPages: boolean;
}
export interface OfficialSourceConfig {
  enabled: boolean;
  maxCatalogPages: number;
  sourceUrls: string[];
  courtCatalogs?: import('./official-discovery').CourtCatalogKind[];
}
export interface OfficialRetrievalCoverage {
  courtCatalogs?: import('./official-discovery').CourtCatalogCoverage[];
  catalogPagesRequested: number;
  catalogPagesRead: number;
  catalogCandidates: number;
  matchedCandidates: number;
  userUrlsRequested: number;
  userUrlsRead: number;
  failedReads: number;
  catalogExhausted: boolean;
  truncated: boolean;
  totalPages: number | null;
  pagesLimit: number;
}
export interface OfficialSourceMetadata {
  publisher: string;
  documentNumber: string | null;
  versionLabel: string | null;
  discoveredVia: 'catalog' | 'user_url' | 'search';
  catalogUrl?: string;
  article?: string;
  /** First controlled-topic match in the saved excerpt (UTF-16 character offset). */
  relevantTextOffset?: number;
  validityNote: string;
}
export interface RetrievalConfigInput {
  knowledge: { enabled: boolean; folderPath: string | null; api: KnowledgeApiConfig; preferences?: KnowledgePreferences };
  web: WebSearchConfig;
  official?: OfficialSourceConfig;
  maxResults: number;
  timeoutSeconds: number;
}
export interface PublicRetrievalConfig extends Omit<RetrievalConfigInput, 'knowledge' | 'web'> {
  knowledge: Omit<RetrievalConfigInput['knowledge'], 'api'> & { api: Omit<KnowledgeApiConfig, 'apiKey' | 'clearApiKey'> & { hasApiKey: boolean; keyStorage: 'os-encrypted' | 'session-only' } };
  web: Omit<WebSearchConfig, 'apiKey' | 'clearApiKey'> & { hasApiKey: boolean; keyStorage: 'os-encrypted' | 'session-only' };
}
export interface RetrievalAttempt {
  id: string;
  channel: 'knowledge' | 'web';
  provider: 'folder' | 'dify' | 'standard' | 'brave' | 'searxng' | 'official_catalog' | 'official_page' | 'professional_mcp' | 'remote_index';
  connectionId?: string;
  query: string;
  status: 'complete' | 'empty' | 'partial' | 'timeout' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string;
  resultCount: number;
  error: string | null;
  warnings: string[];
  coverage?: OfficialRetrievalCoverage;
}
export interface SourceEvidence {
  id: string;
  attemptId: string;
  channel: 'knowledge' | 'web';
  kind: 'company_policy' | 'statute' | 'judicial_interpretation' | 'case' | 'commentary' | 'contract_template';
  title: string;
  sourceUri: string | null;
  locator: string;
  excerpt: string;
  excerptSha256: string;
  contentScope: 'full_text' | 'fragment' | 'search_snippet';
  retrievedAt: string;
  publishedAt: string | null;
  effectiveAt: string | null;
  currentness: 'unknown';
  isOfficial: boolean;
  warnings: string[];
  officialMetadata?: OfficialSourceMetadata;
  localIndex?: Pick<KnowledgeHit, 'chunkId' | 'sourceFileId' | 'versionId' | 'fileSha256' | 'indexedAt' | 'location'>;
  connection?: { id: string; revision: number; provider: string; documentId: string; version: string; documentNumber: string; crossCheck: 'not_attempted'|'consistent'|'different'|'version_unknown'; relatedEvidenceIds: string[] };
}
export interface SourceCitation { evidenceId: string; quote: string; matchStatus: 'matched' | 'unmatched' }
export interface RetrievalBundle {
  configSnapshot: PublicRetrievalConfig;
  knowledgeStatus: RetrievalStatus;
  webStatus: RetrievalStatus;
  officialStatus?: RetrievalStatus;
  searchStatus?: RetrievalStatus;
  attempts: RetrievalAttempt[];
  evidence: SourceEvidence[];
  limitations: string[];
  modelEvidenceIds?: string[];
}

export function defaultRetrievalConfig(): PublicRetrievalConfig {
  return {
    knowledge: { enabled: false, folderPath: null, preferences: defaultKnowledgePreferences(), api: { enabled: false, provider: 'dify', baseUrl: '', collectionId: '', hasApiKey: false, keyStorage: 'session-only' } },
    web: { enabled: false, provider: 'searxng', baseUrl: '', allowedDomains: ['gov.cn', 'npc.gov.cn', 'court.gov.cn'], fetchPages: true, hasApiKey: false, keyStorage: 'session-only' },
    official: { enabled: false, maxCatalogPages: 3, sourceUrls: [] },
    maxResults: 4, timeoutSeconds: 20,
  };
}

export interface ReviewContext {
  contractType: 'procurement' | 'service' | 'other';
  ourPartyRole: 'buyer' | 'seller' | 'service_provider' | 'service_recipient' | 'other';
  businessContext: string;
  strictness: 'cautious' | 'balanced' | 'pragmatic';
  projectId?: string;
  longContractMode?: 'batch' | 'reject';
  taskRequirements?: import('./library').TaskExperienceRequirement[];
  completionSnapshot?: import('./review-completion').ReviewCompletionSnapshot;
  experienceResolution?: import('./library').ExperienceResolution;
  advisorPackages?: import('./library').AdvisorPromptSnapshot[];
  /** Rebuilt by the service from source-bound, local multilingual records. */
  alignmentSnapshot?: import('./clause-alignment').ClauseAlignmentSnapshot;
}

export interface ReviewFinding {
  id: string;
  blockIds: string[];
  quote: string;
  title: string;
  category: FindingCategory;
  severity: Severity;
  description: string;
  suggestion: string;
  legalBasis: string | null;
  basisStatus: 'unverified' | 'source_matched';
  citations?: SourceCitation[];
  source: 'model' | 'rule';
  origin?: 'model' | 'keyword' | 'enterprise' | 'program';
  checkKey?: string;
  calculation?: string | null;
  locationStatus: 'matched' | 'unmatched';
}

export interface ReviewResult {
  id: string;
  documentId: string;
  createdAt: string;
  mode: 'model' | 'local';
  modelId: string | null;
  summary: string;
  findings: ReviewFinding[];
  context: ReviewContext;
  coverage: {
    reviewedBlockIds: string[];
    totalBlockCount: number;
    knowledgeStatus: RetrievalStatus;
    webStatus: RetrievalStatus;
    limitations: string[];
  };
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number;
  retrieval?: RetrievalBundle;
  standardSnapshot?: EnterpriseStandardSnapshot;
  programChecks?: ProgramCheckReport;
  experienceSnapshot?: Array<{ id: string; revision: number; body: unknown; contentSha256: string }>;
  batchCoverage?: { batchCount: number; crossBatchSynthesis: boolean; limitations: string[] };
  completionSnapshot?: import('./review-completion').ReviewCompletionSnapshot;
  experienceResolution?: import('./library').ExperienceResolution;
  advisorPackages?: import('./library').AdvisorPromptSnapshot[];
  alignmentSnapshot?: import('./clause-alignment').ClauseAlignmentSnapshot;
}

export interface ReviewTask {
  id: string;
  documentId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  stage: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  resultId: string | null;
  /** Session-only stream progress; partial output is never written to task checkpoints. */
  runtimeProgress?: import('./model-runtime').ModelRuntimeProgress['modelRuntime'];
}

export interface AppState {
  documents: ContractSummary[];
  /** Electron-encrypted files are retained until users re-enter their keys in the native shell. */
  credentialMigration?: { legacyCredentialFiles: number };
  storageBackend?: 'rust' | 'sqljs';
  documentsPage?: Omit<DocumentListPage, 'items'>;
  modelConfig: PublicModelConfig | null;
  retrievalConfig?: PublicRetrievalConfig | null;
  tasks: ReviewTask[];
  isPreview: boolean;
  appVersion: string;
}

export interface ConnectionTestResult { model: string; latencyMs: number; message: string }
export interface StartReviewInput { documentId: string; context: ReviewContext; mode: 'model' | 'local'; standardVersionId?: string | null }
export interface ContractAssistantBridge {
  runWorkspaceCommand(input: import('./workspace-tools').WorkspaceCommand): Promise<any>;
  getState(): Promise<AppState>;
  importContract(): Promise<ContractDetail | null>;
  loadSample(): Promise<ContractDetail>;
  getDocument(id: string): Promise<ContractDetail>;
  getDocumentView(id: string): Promise<ContractView>;
  listDocumentsPage(input?: DocumentListInput): Promise<DocumentListPage>;
  getDocumentBlocks(input: DocumentBlocksInput): Promise<DocumentBlockPage>;
  getDocumentReviews(input: DocumentReviewsInput): Promise<ReviewSummaryPage>;
  getReview(id: string): Promise<ReviewResult>;
  saveModelConfig(input: ModelConfigInput): Promise<PublicModelConfig>;
  testModelConnection(): Promise<ConnectionTestResult>;
  selectKnowledgeFolder(): Promise<string | null>;
  saveRetrievalConfig(input: RetrievalConfigInput): Promise<PublicRetrievalConfig>;
  testRetrieval(): Promise<RetrievalBundle>;
  testOfficialRetrieval(input: { query: string }): Promise<RetrievalBundle>;
  cancelOfficialRetrieval(): Promise<void>;
  getKnowledgeState(): Promise<KnowledgeState>;
  checkEnvironment(): Promise<EnvironmentReport>;
  configureLocalKnowledge(input: ConfigureKnowledgeInput): Promise<ConfigureKnowledgeResult>;
  startKnowledgeSync(mode?: KnowledgeSyncMode): Promise<{ jobId: string }>;
  cancelKnowledgeSync(jobId: string): Promise<void>;
  searchKnowledge(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult>;
  getKnowledgeChunk(chunkId: string): Promise<KnowledgeHit>;
  openKnowledgeSource(chunkId: string): Promise<void>;
  openEvidenceSource(reviewId: string, evidenceId: string): Promise<void>;
  startReview(input: StartReviewInput): Promise<{ taskId: string }>;
  cancelReview(taskId: string): Promise<void>;
  exportReview(reviewId: string): Promise<{ path: string } | null>;
  getChanges(reviewId: string): Promise<ChangeWorkspace>;
  enableEditableCopy(input: EnableEditableCopyInput): Promise<ChangeWorkspace>;
  saveChange(input: SaveChangeInput): Promise<ChangeWorkspace>;
  generateChangeDraft(input: GenerateChangeInput): Promise<ChangeWorkspace>;
  cancelChangeDraft(reviewId: string): Promise<void>;
  decideChange(input: DecideChangeInput): Promise<ChangeWorkspace>;
  exportModified(input: ExportChangesInput): Promise<ExportChangesResult | null>;
  listContractDrafts(): Promise<ContractDraftSummary[]>;
  getContractDraft(id: string): Promise<ContractDraft>;
  generateContract(input: GenerateContractInput): Promise<ContractDraft>;
  cancelContractGeneration(requestId: string): Promise<void>;
  exportContractDraft(input: ExportContractDraftInput): Promise<ExportContractDraftResult | null>;
  listEnterpriseStandards(): Promise<EnterpriseStandardSummary[]>;
  getEnterpriseStandard(id: string): Promise<EnterpriseStandardProfile>;
  saveEnterpriseStandard(input: SaveEnterpriseStandardInput): Promise<EnterpriseStandardProfile>;
  publishEnterpriseStandard(input: PublishEnterpriseStandardInput): Promise<EnterpriseStandardProfile>;
  getRiskDispositions(reviewId: string): Promise<RiskDispositionWorkspace>;
  saveRiskDisposition(input: SaveRiskDispositionInput): Promise<RiskDispositionWorkspace>;
  onTaskUpdate(callback: (task: ReviewTask) => void): () => void;
}

declare global { interface Window { contractAssistant?: ContractAssistantBridge } }
