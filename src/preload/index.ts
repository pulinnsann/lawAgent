import { contextBridge, ipcRenderer } from 'electron';
import type { ContractAssistantBridge, ReviewTask } from '../shared/contracts';

async function command<T>(name: string, payload?: unknown): Promise<T> {
  const response = await ipcRenderer.invoke('contract-assistant:command', { name, payload });
  if (!response.ok) throw new Error(response.error || '操作失败。');
  return response.data as T;
}

const bridge: ContractAssistantBridge = {
  runWorkspaceCommand: input => command('runWorkspaceCommand', input),
  getState: () => command('getState'),
  importContract: () => command('importContract'),
  loadSample: () => command('loadSample'),
  getDocument: id => command('getDocument', id),
  saveModelConfig: input => command('saveModelConfig', input),
  testModelConnection: () => command('testModelConnection'),
  selectKnowledgeFolder: () => command('selectKnowledgeFolder'),
  saveRetrievalConfig: input => command('saveRetrievalConfig', input),
  testRetrieval: () => command('testRetrieval'),
  testOfficialRetrieval: input => command('testOfficialRetrieval', input),
  cancelOfficialRetrieval: () => command('cancelOfficialRetrieval'),
  getKnowledgeState: () => command('getKnowledgeState'),
  checkEnvironment: () => command('checkEnvironment'),
  configureLocalKnowledge: input => command('configureLocalKnowledge', input),
  startKnowledgeSync: mode => command('startKnowledgeSync', mode ?? 'incremental'),
  cancelKnowledgeSync: jobId => command('cancelKnowledgeSync', jobId),
  searchKnowledge: input => command('searchKnowledge', input),
  getKnowledgeChunk: chunkId => command('getKnowledgeChunk', chunkId),
  openKnowledgeSource: chunkId => command('openKnowledgeSource', chunkId),
  openEvidenceSource: (reviewId, evidenceId) => command('openEvidenceSource', { reviewId, evidenceId }),
  startReview: input => command('startReview', input),
  cancelReview: taskId => command('cancelReview', taskId),
  exportReview: reviewId => command('exportReview', reviewId),
  getChanges: reviewId => command('getChanges', reviewId),
  enableEditableCopy: input => command('enableEditableCopy', input),
  saveChange: input => command('saveChange', input),
  generateChangeDraft: input => command('generateChangeDraft', input),
  cancelChangeDraft: reviewId => command('cancelChangeDraft', reviewId),
  decideChange: input => command('decideChange', input),
  exportModified: input => command('exportModified', input),
  listContractDrafts: () => command('listContractDrafts'),
  getContractDraft: id => command('getContractDraft', id),
  generateContract: input => command('generateContract', input),
  cancelContractGeneration: requestId => command('cancelContractGeneration', requestId),
  exportContractDraft: input => command('exportContractDraft', input),
  listEnterpriseStandards: () => command('listEnterpriseStandards'),
  getEnterpriseStandard: id => command('getEnterpriseStandard', id),
  saveEnterpriseStandard: input => command('saveEnterpriseStandard', input),
  publishEnterpriseStandard: input => command('publishEnterpriseStandard', input),
  getRiskDispositions: reviewId => command('getRiskDispositions', reviewId),
  saveRiskDisposition: input => command('saveRiskDisposition', input),
  onTaskUpdate: callback => {
    const handler = (_event: Electron.IpcRendererEvent, task: ReviewTask) => callback(task);
    ipcRenderer.on('contract-assistant:task', handler);
    return () => ipcRenderer.removeListener('contract-assistant:task', handler);
  },
};
contextBridge.exposeInMainWorld('contractAssistant', bridge);
