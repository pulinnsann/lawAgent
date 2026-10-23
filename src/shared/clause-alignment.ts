import type { ContractBlock } from './contracts';

export type AlignmentLanguage = 'zh' | 'en' | 'th';
export type AlignmentState = 'candidate' | 'confirmed' | 'disputed' | 'disabled';
export interface AlignmentBlock extends ContractBlock { textSha256: string; detectedLanguage: AlignmentLanguage | null }
export interface AlignmentDocument { id: string; name: string; versionNo: number; sourceFileSha256: string; blocks: AlignmentBlock[] }
/** All strings are original source snapshots, never translations replacing the source. */
export interface AlignmentSegment {
  language: AlignmentLanguage; documentId: string; documentName: string; versionNo: number;
  sourceFileSha256: string; blocks: Array<{ blockId: string; ordinal: number; text: string; textSha256: string; range: { start: number; end: number }; locator: ContractBlock['locator'] }>;
}
export interface AlignmentSegmentInput {
  language: AlignmentLanguage; documentId: string; sourceFileSha256: string;
  blocks: Array<{ blockId: string; textSha256: string; range?: { start: number; end: number } }>;
}
export interface PriorityTextSource { documentId: string; blockId: string; sourceFileSha256: string; textSha256: string; text: string; locator: ContractBlock['locator'] }
export interface PriorityTextAgreement {
  state: 'unspecified' | 'pending' | 'confirmed'; language: AlignmentLanguage | null;
  basis: string; blockRefs: Array<{ documentId: string; blockId: string }>;
}
export interface AlignmentProgramFlag {
  kind: 'number_tokens' | 'obligation_markers'; languages: AlignmentLanguage[];
  detail: string; values: Partial<Record<AlignmentLanguage, string[]>>;
  legalConclusion: false;
}
export interface AlignmentComparisonRequest { contractId: string; label: string; segments: AlignmentSegment[]; priority: PriorityTextAgreement; prioritySources: PriorityTextSource[]; inputSha256: string }
export interface AlignmentComparisonOutput {
  modelId: string; summary: string; differences: Array<{ category: 'amount_date' | 'rights_obligations' | 'omission' | 'terminology' | 'other'; description: string; blockRefs: Array<{ documentId: string; blockId: string }> }>;
  warnings: string[];
}
export interface AlignmentComparison extends AlignmentComparisonOutput { inputSha256: string; generatedAt: string; candidateOnly: true }
export interface ClauseAlignmentBody {
  contractId: string; label: string; segments: AlignmentSegment[]; state: AlignmentState;
  priority: PriorityTextAgreement; prioritySources: PriorityTextSource[]; candidateMethod: 'manual' | 'numbering' | 'sequence';
  contractVersionIds: string[]; programFlags: AlignmentProgramFlag[];
  comparison: AlignmentComparison | null;
  comparisonReview: { state: 'pending' | 'reviewed' | 'disputed'; reason: string };
  actorLabel: string; reason: string; legalCorrectnessCertified: false;
}
export interface ClauseAlignmentAsset { id: string; revision: number; kind: string; body: ClauseAlignmentBody; deleted: boolean; updatedAt: string; contentSha256: string }
export interface ClauseAlignmentView extends ClauseAlignmentAsset { stale: boolean; staleReasons: string[]; newVersionIds: string[] }
export interface UnmatchedAlignmentBlock { documentId: string; documentName: string; blockId: string; ordinal: number; range: { start: number; end: number }; text: string; language: AlignmentLanguage | null; reason: string }
export interface ClauseAlignmentWorkspace { contractId: string; contractTitle: string; documents: AlignmentDocument[]; groups: ClauseAlignmentView[]; unmatched: UnmatchedAlignmentBlock[]; warnings: string[] }
export interface ClauseAlignmentSuggestion { label: string; segments: AlignmentSegmentInput[]; method: 'numbering' | 'sequence'; reason: string }
export interface ClauseAlignmentSuggestions { candidates: ClauseAlignmentSuggestion[]; warnings: string[] }
/** Frozen for reviews/reports; checkedAt is not part of the content hash. */
export interface ClauseAlignmentSnapshot {
  version: 'clause-alignment-v1'; contractId: string; documentId: string | null;
  groups: ClauseAlignmentView[]; unmatched: UnmatchedAlignmentBlock[];
  totalGroups: number; totalUnmatched: number; truncated: boolean; limitations: string[];
  sourceStateSha256: string;
  contentSha256: string; legalCorrectnessCertified: false;
}
