export type CourtCatalogKind = 'interpretations';
export interface CourtCatalogCoverage {
  catalog: CourtCatalogKind; label: string; entryUrl: string;
  pagesRequested: number; pagesRead: number; totalPages: number | null;
  candidates: number; matchedCandidates: number; documentsRead: number; failedReads: number;
  exhausted: boolean; truncated: boolean;
}
export const courtCatalogOptions: Array<{ key: CourtCatalogKind; label: string; url: string }> = [
  { key: 'interpretations', label: '最高法司法解释公开栏目', url: 'https://www.court.gov.cn/fabu/gengduo/16.html' },
];
