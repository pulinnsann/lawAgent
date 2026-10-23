export type OcrLanguage = 'chi_sim' | 'eng' | 'tha';
export interface ConversionSettings {
  languages: OcrLanguage[];
  mode: 'auto' | 'text' | 'ocr';
  maxPages: number;
  dpi: number;
  pageTimeoutSeconds: number;
  allowPartial: boolean;
}
export const defaultConversionSettings = (): ConversionSettings => ({ languages: ['chi_sim', 'eng'], mode: 'auto', maxPages: 50, dpi: 180, pageTimeoutSeconds: 90, allowPartial: false });
export interface ConversionProgress { stage: 'preparing' | 'downloading' | 'rendering' | 'recognizing' | 'writing' | 'completed'; pageNumber: number; pageCount: number; progress: number; message: string }
export interface ConversionPage {
  pageNumber: number;
  method: 'text' | 'ocr' | 'unread';
  confidence: number | null;
  textSha256: string;
  warnings: string[];
}
export interface ConversionSourceSnapshot {
  sourceDocumentId: string;
  sourceFileSha256: string;
  sourceName: string;
  createdAt: string;
  pageCount: number;
  pages: ConversionPage[];
  settings: ConversionSettings;
  engine: { pdf: string; ocr: string | null };
  models: Array<{ language: OcrLanguage; sha256: string }>;
}
export interface ConversionResult { docxBase64: string; filename: string; sourceSnapshot: ConversionSourceSnapshot; warnings: string[]; partial: boolean }
export interface ConversionStatus {
  modelDirectory: string;
  models: Array<{ language: OcrLanguage; ready: boolean; byteSize: number; sha256: string | null }>;
  settings: { id: string | null; revision: number; body: ConversionSettings };
}
