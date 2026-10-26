import type { ContractAssistantBridge, ReviewTask } from '../../shared/contracts';

export interface DesktopCommandResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Narrow transport: the renderer cannot invoke arbitrary filesystem or shell APIs. */
export interface TauriBridgeTransport {
  invoke(name: 'desktop_invoke', input: { name: string; payload?: unknown }): Promise<DesktopCommandResponse>;
  listen(name: 'desktop-task', callback: (event: { payload: ReviewTask }) => void): Promise<() => void>;
}

function desktopError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.trim()) return new Error(error);
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return new Error(error.message);
  return new Error('Desktop operation failed.');
}

/** Subscribe before exposing the bridge so an immediately started task cannot lose its first update. */
export async function createTauriBridgeSession(transport: TauriBridgeTransport): Promise<{ bridge: ContractAssistantBridge; dispose(): void }> {
  const subscribers = new Map<symbol, (task: ReviewTask) => void>();
  let disposed = false;
  const unlisten = await transport.listen('desktop-task', event => {
    if (disposed) return;
    for (const callback of [...subscribers.values()]) {
      // One component's exception must not prevent other mounted views receiving progress.
      try { callback(event.payload); } catch (error) { console.error('Task subscriber failed.', error); }
    }
  });
  async function command<T>(name: string, payload?: unknown): Promise<T> {
    if (disposed) throw new Error('Desktop connection is closed.');
    try {
      const response = await transport.invoke('desktop_invoke', { name, ...(payload === undefined ? {} : { payload }) });
      if (!response || typeof response.ok !== 'boolean') throw new Error('Invalid desktop response.');
      if (!response.ok) throw new Error(response.error || 'Desktop operation failed.');
      return response.data as T;
    } catch (error) { throw desktopError(error); }
  }
  const bridge: ContractAssistantBridge = {
    runWorkspaceCommand: input => command('runWorkspaceCommand', input),
    getState: () => command('getState'),
    importContract: () => command('importContract'),
    loadSample: () => command('loadSample'),
    getDocument: id => command('getDocument', id),
    getDocumentView: id => command('getDocumentView', id),
    listDocumentsPage: input => command('listDocumentsPage', input ?? {}),
    getDocumentBlocks: input => command('getDocumentBlocks', input),
    getDocumentReviews: input => command('getDocumentReviews', input),
    getReview: id => command('getReview', id),
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
      if (disposed) return () => {};
      const token = Symbol('task subscription');
      subscribers.set(token, callback);
      return () => { subscribers.delete(token); };
    },
  };
  return { bridge, dispose() { if (!disposed) { disposed = true; subscribers.clear(); unlisten(); } } };
}

export function isTauriDesktop(target: Window = window): boolean {
  return '__TAURI_INTERNALS__' in target;
}

/** Browser preview and the retained Electron reference keep their existing bridges. */
export async function installTauriBridge(target: Window = window): Promise<void> {
  if (!isTauriDesktop(target) || target.contractAssistant) return;
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  const session = await createTauriBridgeSession({
    invoke: (name, input) => invoke<DesktopCommandResponse>(name, input),
    listen: (name, callback) => listen<ReviewTask>(name, callback),
  });
  target.contractAssistant = session.bridge;
  target.addEventListener('pagehide', () => session.dispose(), { once: true });
}
