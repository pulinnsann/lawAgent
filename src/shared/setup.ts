import type { KnowledgePreferences } from './knowledge';
import type { PublicRetrievalConfig } from './contracts';

export interface EnvironmentCheck {
  id: 'runtime' | 'storage' | 'fts5' | 'languages' | 'index_worker' | 'credentials';
  label: string;
  status: 'passed' | 'warning' | 'failed' | 'unavailable';
  message: string;
}
export interface EnvironmentReport {
  checkedAt: string;
  ready: boolean;
  isPreview: boolean;
  checks: EnvironmentCheck[];
}
export interface ConfigureKnowledgeInput {
  folderPath: string;
  preferences: KnowledgePreferences;
  buildNow: boolean;
}
export interface ConfigureKnowledgeResult {
  config: PublicRetrievalConfig;
  jobId: string | null;
  buildError: string | null;
}
