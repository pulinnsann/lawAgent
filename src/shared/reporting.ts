import type { ReviewFinding, ReviewResult } from './contracts';
import type { RiskDispositionStatus, RiskDispositionWorkspace } from './assurance';
import type { AnnotationAsset } from './library';
import type { ReviewCompletionReport, ReviewFreshness } from './review-completion';
import type { ReportLanguage, ReportTranslationRender } from './report-translation';

export type ReportStyle = 'risk' | 'management' | 'summary';
export type ReportFormat = 'docx' | 'pdf' | 'markdown' | 'html' | 'csv';
export interface ReportSettings {
  /** Missing in legacy settings means Chinese. Independent of the UI locale. */
  language?: ReportLanguage;
  organization: string;
  authorLabel: string;
  recipientLabel: string;
  includeContractQuotes: boolean;
  includeDispositionHistory: boolean;
}
export const defaultReportSettings = (): ReportSettings => ({ language: 'zh', organization: '', authorLabel: '法务', recipientLabel: '内部汇报', includeContractQuotes: true, includeDispositionHistory: true });
export interface ReportRequest {
  scope: 'current' | 'workspace';
  reviewId?: string;
  from?: string;
  to?: string;
  style: ReportStyle;
  settings?: ReportSettings;
  translationId?: string;
}
export interface ReportingDocument {
  contractId: string;
  documentId: string;
  versionNo: number;
  kind: string;
  name: string;
  importedAt: string;
  sha256: string;
  partial: boolean;
}
export interface ReportingReview {
  document: ReportingDocument;
  review: ReviewResult;
  dispositions: RiskDispositionWorkspace;
  /** A separate human opinion may be supplied by an integration. Original findings remain frozen. */
  annotations?: AnnotationAsset[];
  completion?: ReviewCompletionReport;
  freshness?: ReviewFreshness;
}
export interface ReportSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  snapshotSha256: string;
  scope: 'current' | 'workspace';
  style: ReportStyle;
  settings: ReportSettings;
  period: { from: string | null; to: string | null; timezone: 'Asia/Shanghai' };
  metrics: {
    contracts: number;
    documentVersions: number;
    importedVersions: number;
    reviewRounds: number;
    riskItems: number;
    latestVersionRiskItems: number;
    severities: Record<ReviewFinding['severity'], number>;
    dispositions: Record<RiskDispositionStatus, number>;
    pendingDecisions: number;
    activeManualOpinions: number;
  };
  documents: ReportingDocument[];
  reviews: ReportingReview[];
  standardGroups: Array<{ key: string; label: string; reviewRounds: number; contentSha256: string | null }>;
  limitations: string[];
  /** A separately approved translation. Original reviews and evidence stay intact. */
  translation?: ReportTranslationRender;
}
export interface ReportingRenderResult {
  filename: string;
  html: string;
  docxBase64: string;
  markdown: string;
  csv: string;
  snapshot: ReportSnapshot;
}
export interface SavedReportSettings { id: string | null; revision: number; body: ReportSettings }
