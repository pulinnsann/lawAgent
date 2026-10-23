export type ChangeDecision = 'proposed' | 'accepted' | 'rejected';
export interface ChangeProposal {
  id: string; reviewId: string; documentId: string; findingId: string | null; blockId: string;
  rangeStart: number; rangeEnd: number; originalText: string; replacementText: string;
  sourceFileSha256: string; originalTextSha256: string; status: ChangeDecision;
  explanation: string; warnings: string[]; modelId: string | null;
  createdAt: string; updatedAt: string;
}
export interface ChangeTarget {
  blockId: string; label: string; text: string; editable: boolean; reason: string | null;
  editMode?: 'paragraph' | 'segments';
  warnings?: string[];
  segments?: ChangeTextSegment[];
}
export interface ChangeTextSegment {
  id: string; rangeStart: number; rangeEnd: number; text: string; editable: boolean; reason: string | null;
}
export interface ChangeExport {
  id: string; reviewId: string; sourceDocumentId: string; documentId: string; versionNo: number;
  createdAt: string; fileSha256: string; proposalIds: string[];
  format?: 'clean' | 'tracked';
  revisionAuthor?: string | null;
}
export interface ChangeWorkspace {
  reviewId: string; documentId: string; sourceFileSha256: string; revision: number;
  supported: boolean; reason: string | null; targets: ChangeTarget[];
  proposals: ChangeProposal[]; exports: ChangeExport[]; warnings: string[];
  editableCopy?: { available: boolean; enabled: boolean; reason: string | null; enabledAt: string | null };
}
export interface EnableEditableCopyInput { reviewId: string; expectedRevision: number }
export interface SaveChangeInput {
  reviewId: string; proposalId?: string; findingId: string | null; blockId: string;
  segmentId?: string;
  /** This increment must still match at save/decision/export time. */
  expectedRevision: number; replacementText: string;
}
export interface GenerateChangeInput {
  reviewId: string; findingId: string; blockId: string; expectedRevision: number;
  segmentId?: string;
}
export interface DecideChangeInput {
  reviewId: string; proposalId: string; status: ChangeDecision; expectedRevision: number;
}
export interface ExportChangesInput {
  reviewId: string; expectedRevision: number;
  format?: 'clean' | 'tracked';
  revisionAuthor?: string;
}
export interface ExportChangesResult { documentPath: string; changeListPath: string; export: ChangeExport }
