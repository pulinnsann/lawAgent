import type { ContractBlock, Language } from './contracts';
import type { EnvironmentReport } from './setup';

export type KnowledgeSyncMode = 'incremental' | 'verify';
export interface KnowledgePreferences {
  displayName: string;
  fileTypes: Array<'txt' | 'md' | 'docx' | 'pdf'>;
  excludeDirectories: string[];
  autoSyncEnabled: boolean;
  syncIntervalMinutes: number;
  maxFileSizeMb: number;
}
export interface KnowledgeSyncJob {
  id: string;
  folderPath: string;
  mode?: KnowledgeSyncMode;
  preferences?: KnowledgePreferences;
  status: 'running' | 'completed' | 'partial' | 'cancelled' | 'failed' | 'interrupted';
  phase: string;
  startedAt: string;
  finishedAt: string | null;
  scanned: number;
  indexed: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  failed: number;
  fullScan: boolean;
  errors: Array<{ path: string; message: string }>;
}
export interface KnowledgeState {
  folderPath: string | null;
  engine: 'sqlite-fts5';
  tokenizerVersion: string;
  indexedFiles: number;
  chunks: number;
  staleFiles: number;
  lastSyncedAt: string | null;
  job: KnowledgeSyncJob | null;
  limitations: string[];
  needsSync?: boolean;
}
export interface KnowledgeHit {
  chunkId: string;
  sourceFileId: string;
  versionId: string;
  title: string;
  relativePath: string;
  sourceUri: string;
  locator: string;
  location: ContractBlock['locator'] | { kind: 'text'; lineStart: number; lineEnd: number };
  excerpt: string;
  excerptSha256: string;
  fileSha256: string;
  language: Language;
  indexedAt: string;
  score: number;
  warnings: string[];
}
export interface KnowledgeSearchInput { query: string; limit?: number; terms?: string[]; preferences?: KnowledgePreferences }
export interface KnowledgeSearchResult {
  query: string;
  expandedTerms: string[];
  hits: KnowledgeHit[];
  state: KnowledgeState;
  elapsedMs: number;
}
export interface KnowledgePort {
  checkEnvironment?(): Promise<EnvironmentReport>;
  getState(folderPath: string | null, preferences?: KnowledgePreferences): Promise<KnowledgeState>;
  syncFolder(input: { folderPath: string; jobId: string; mode: KnowledgeSyncMode; preferences?: KnowledgePreferences }, signal: AbortSignal, onProgress?: (job: KnowledgeSyncJob) => void): Promise<KnowledgeSyncJob>;
  search(input: KnowledgeSearchInput & { folderPath: string }, signal?: AbortSignal): Promise<KnowledgeSearchResult>;
  readChunk(input: { folderPath: string; chunkId: string; preferences?: KnowledgePreferences }): Promise<KnowledgeHit>;
  /** Drain a snapshot of admitted worker operations, including caller-cancelled
   * searches whose actual cleanup has not yet been acknowledged. */
  waitForIdle?(): Promise<void>;
  close(): Promise<void>;
}
