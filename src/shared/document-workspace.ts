import type { ContractBlock, ContractSummary, Language } from './contracts';
export type LifecycleStatus = 'active' | 'archived' | 'trashed';
export interface ProjectRecord { id: string; name: string; revision: number; status: LifecycleStatus; contractCount: number; deletedAt: string | null }
export interface ContractRecord { id: string; title: string; projectId: string | null; projectName: string | null; revision: number; status: LifecycleStatus; deletedAt: string | null; versions: ContractSummary[] }
export interface DocumentCatalog { projects: ProjectRecord[]; contracts: ContractRecord[] }
export interface ImportVersionInput { parentDocumentId: string; expectedLatestDocumentId: string }
export interface ReferenceTranslation {
  documentId: string; blockId: string; sourceTextSha256: string; sourceFileSha256: string;
  targetLanguage: 'zh' | 'en' | 'th'; text: string; status: 'unreviewed' | 'reviewed' | 'disputed';
  actorLabel: string; reason: string; previousTranslationId: string | null;
  origin: 'manual' | 'model'; modelId: string | null;
}
export interface TranslationRecord { id: string; revision: number; body: ReferenceTranslation; updatedAt: string; deleted: boolean }
export interface TranslationWorkspace { documentId: string; sourceLanguage: Language; sourceFileSha256: string; blocks: Array<ContractBlock & { sourceTextSha256: string }>; translations: TranslationRecord[] }
