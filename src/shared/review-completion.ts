/** Human records are separate from model findings and never establish legal validity. */
export type ReviewWorkflowNodeKind = 'collect_information' | 'program_checks' | 'retrieve_sources' | 'review' | 'human_risk_disposition';
export interface ReviewWorkflowNode {
  id: string;
  kind: ReviewWorkflowNodeKind;
  when: 'always' | 'has_pending_information' | 'has_high_risk';
  onMissing?: 'pause' | 'continue_limited';
}
export interface ReviewWorkflowDefinition { nodes: ReviewWorkflowNode[] }
export const workflowNodeLabels: Record<ReviewWorkflowNodeKind, string> = {
  collect_information: '资料收集', program_checks: '程序核验', retrieve_sources: '资料检索', review: '合同审核', human_risk_disposition: '风险人工处置',
};
export function defaultReviewWorkflow(): ReviewWorkflowDefinition {
  return { nodes: [
    { id: 'information', kind: 'collect_information', when: 'always', onMissing: 'pause' },
    { id: 'checks', kind: 'program_checks', when: 'always' },
    { id: 'sources', kind: 'retrieve_sources', when: 'always' },
    { id: 'review', kind: 'review', when: 'always' },
    { id: 'human', kind: 'human_risk_disposition', when: 'has_high_risk' },
  ] };
}
export interface ReviewInformationItem {
  id: string; kind: 'fact' | 'assumption' | 'question'; label: string; detail: string;
  status: 'pending' | 'confirmed' | 'not_applicable'; required: boolean;
  scopes: string[]; blockIds: string[]; quote: string; reason: string;
}
export interface ReviewFactsBody { documentId: string; documentSha256: string; items: ReviewInformationItem[]; reason: string }
export interface CompletionAsset<T> {
  id: string; kind: string; revision: number; body: T; deleted: boolean;
  createdAt: string; updatedAt: string; actorLabel: string; contentSha256: string;
}
export type ReviewFactsAsset = CompletionAsset<ReviewFactsBody>;
export interface ReviewCompletionSnapshot {
  schemaVersion: 1; capturedAt: string; documentId: string; documentSha256: string;
  facts: ReviewFactsAsset | null; workflow: ReviewWorkflowDefinition;
  workflowRunId: string | null; standardVersionId: string | null; standardSha256: string | null;
  limitations: string[];
}
export interface ReviewWorkflowRunBody {
  documentId: string; reviewId: string | null; snapshot: ReviewCompletionSnapshot;
  state: 'paused_information' | 'ready' | 'awaiting_human' | 'completed';
  nodes: Array<{ id: string; kind: ReviewWorkflowNodeKind; state: 'pending' | 'paused' | 'completed' | 'skipped'; reason: string }>;
  reason: string;
}
export type ReviewWorkflowRunAsset = CompletionAsset<ReviewWorkflowRunBody>;
export interface SourceVerificationBody {
  reviewId: string; documentId: string; evidenceId: string; evidenceSha256: string; evidenceIdentity: string;
  status: 'not_verified' | 'pending' | 'verified';
  authenticity: string; legalEffect: string; applicableFrom: string | null; applicableTo: string | null;
  applicableScope: string; conflictReason: string; reason: string;
}
export type SourceVerificationAsset = CompletionAsset<SourceVerificationBody>;
export interface SourceVerificationHistory { evidenceId: string; current: SourceVerificationAsset; history: SourceVerificationAsset[] }
export interface ReviewFreshness {
  checkedAt: string; status: 'updates_available' | 'no_known_updates' | 'unknown';
  reasons: Array<{ kind: 'document' | 'standard' | 'source' | 'information' | 'verification' | 'alignment'; message: string; previous: string | null; current: string | null }>;
  limitations: string[];
}
export interface ReviewCompletionWorkspace {
  facts: ReviewFactsAsset | null; factsHistory: ReviewFactsAsset[];
  workflow: ReviewWorkflowDefinition; runs: ReviewWorkflowRunAsset[];
  sourceVerifications: SourceVerificationHistory[]; freshness: ReviewFreshness | null;
}
export interface ReviewCompletionReport {
  frozen: ReviewCompletionSnapshot | null;
  currentFacts: ReviewFactsAsset | null;
  workflowRuns: ReviewWorkflowRunAsset[];
  sourceVerifications: SourceVerificationHistory[];
}
