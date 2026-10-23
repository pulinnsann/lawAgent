import type { ContractDetail, ReviewContext } from './contracts';

export interface GenerateContractInput {
  requestId: string;
  description: string;
  language: 'zh' | 'en' | 'th';
  contractType: ReviewContext['contractType'];
  ourPartyRole: ReviewContext['ourPartyRole'];
}
export interface GeneratedClause { heading: string; paragraphs: string[] }
export interface ContractDraftSummary {
  id: string; title: string; language: GenerateContractInput['language'];
  createdAt: string; modelId: string;
}
export interface ContractDraft extends ContractDraftSummary {
  request: GenerateContractInput;
  clauses: GeneratedClause[];
  missingInformation: string[];
  warnings: string[];
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface ExportContractDraftInput { draftId: string }
export interface ExportContractDraftResult { path: string; document: ContractDetail }

export interface AuthoringIssue {
  key: string; source: 'program' | 'placeholder' | 'review' | 'coverage';
  title: string; detail: string; blocking: boolean;
}
export interface AuthoringDecision { key: string; status: 'resolved' | 'accepted'; reason: string }
export interface AuthoringCaseBody {
  draft: ContractDraft;
  origin: { kind: 'description' | 'template'; draftId: string; projectId?: string; templateSnapshot?: import('./library').TemplateSourceSnapshot };
  contentSha256: string; documentId: string; artifactSha256: string;
  checks: import('./assurance').ProgramCheckReport;
  taskId: string | null;
  confirmation: { contentSha256: string; artifactSha256: string; reviewId: string; reviewSha256: string; reviewAugmentationSha256: string; decisions: AuthoringDecision[]; actorLabel: string; reason: string; confirmedAt: string } | null;
  actorLabel: string; reason: string;
}
export type AuthoringCaseAsset = import('./library').LibraryAsset<AuthoringCaseBody>;
export interface AuthoringCaseView {
  asset: AuthoringCaseAsset; document: ContractDetail; review: import('./contracts').ReviewResult | null;
  reviewStatus: string; issues: AuthoringIssue[]; canConfirm: boolean; canExport: boolean;
  reviewAugmentationSha256: string | null; freshness: import('./review-completion').ReviewFreshness | null;
}
