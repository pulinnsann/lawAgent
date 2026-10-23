import type { ReportRequest, ReportSnapshot } from './reporting';

export type ReportLanguage = 'zh' | 'en' | 'th';
export type ReportBlock = { type: 'title' | 'heading' | 'subheading' | 'text'; text: string } | { type: 'table'; rows: string[][] };
export interface ReportTranslationUnit {
  id: string; source: string; protectedSource: string;
  protectedValues: Array<{ token: string; value: string }>;
  target: string;
  origin: 'manual' | 'model' | 'fixed';
}
export interface ReportTranslationBody {
  schemaVersion: 1; targetLanguage: Exclude<ReportLanguage, 'zh'>;
  request: ReportRequest; sourceSnapshot: ReportSnapshot; dependencySha256: string;
  units: ReportTranslationUnit[];
  state: 'draft' | 'approved'; warnings: string[];
  modelId: string | null; approvedBy: string | null; approvedAt: string | null; approvalReason: string | null;
}
export interface ReportTranslationAsset {
  id: string; kind: string; revision: number; body: ReportTranslationBody; deleted: boolean;
  createdAt: string; updatedAt: string; actorLabel: string; contentSha256: string;
}
export interface ReportTranslationRender {
  assetId: string; revision: number; targetLanguage: Exclude<ReportLanguage, 'zh'>;
  dependencySha256: string; sourceSnapshotSha256: string; approvedBy: string; approvedAt: string;
  blocks: ReportBlock[]; csvRows: string[][];
}
export interface ReportTranslationWorkspace {
  asset: ReportTranslationAsset; history: ReportTranslationAsset[];
  stale: boolean; missingUnits: number; completeUnits: number;
}
