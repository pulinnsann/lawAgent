import { parentPort, workerData } from 'node:worker_threads';
import { AppStore } from '../core/storage';
import { ContractService } from '../core/service';
import type { ModelConfigInput, RetrievalConfigInput, StartReviewInput } from '../shared/contracts';
import type { KnowledgeSearchInput, KnowledgeSyncMode } from '../shared/knowledge';
import { KnowledgeWorkerClient } from '../core/knowledge-client';
import type { ConfigureKnowledgeInput } from '../shared/setup';
import type { SaveChangeInput, GenerateChangeInput, DecideChangeInput, ExportChangesInput, EnableEditableCopyInput } from '../shared/changes';
import type { GenerateContractInput, ExportContractDraftInput } from '../shared/generation';
import type { SaveEnterpriseStandardInput, PublishEnterpriseStandardInput, SaveRiskDispositionInput } from '../shared/assurance';

if (!parentPort) throw new Error('Core worker requires a parent port.');
const port = parentPort;
const store = await AppStore.open(workerData.dataDir as string);
const service = new ContractService(store, workerData.dataDir, task => port.postMessage({ type: 'task', task }), new KnowledgeWorkerClient(workerData.dataDir, new URL('./knowledge-worker.js', import.meta.url)));

port.on('message', async (message: {id:string; command:string; payload:unknown; apiKey?:string|null; retrievalKeys?:{knowledgeApiKey:string|null;webApiKey:string|null};connectionSecrets?:Record<string,string>}) => {
  try {
    let data: unknown;
    switch (message.command) {
      case 'runWorkspaceCommand': data = await service.runWorkspaceCommand(message.payload as import('../shared/workspace-tools').WorkspaceCommand, message.connectionSecrets, message.apiKey ?? null); break;
      case 'importDerivedBytes': data = await service.importDerivedBytes(message.payload as Parameters<typeof service.importDerivedBytes>[0]); break;
      case 'getState': data = service.getState(); break;
      case 'importFile': data = await service.importFile(message.payload as string); break;
      case 'importVersionFile': { const p=message.payload as {path:string;parentDocumentId:string;expectedLatestDocumentId:string}; data=await service.importVersionFile(p.path,{parentDocumentId:p.parentDocumentId,expectedLatestDocumentId:p.expectedLatestDocumentId}); break; }
      case 'loadSample': data = await service.loadSample(); break;
      case 'getDocument': data = service.getDocument(message.payload as string); break;
      case 'getDocumentView': data = service.getDocumentView(message.payload as string); break;
      case 'listDocumentsPage': data = service.listDocumentsPage(message.payload as import('../shared/contracts').DocumentListInput); break;
      case 'getDocumentBlocks': data = service.getDocumentBlocks(message.payload as import('../shared/contracts').DocumentBlocksInput); break;
      case 'getDocumentReviews': data = service.getDocumentReviews(message.payload as import('../shared/contracts').DocumentReviewsInput); break;
      case 'saveModelConfig': data = await service.saveConfig(message.payload as ModelConfigInput); break;
      case 'testModelConnection': data = await service.testConnection(message.apiKey ?? null); break;
      case 'saveRetrievalConfig': data = await service.saveRetrievalConfig(message.payload as RetrievalConfigInput); break;
      case 'testRetrieval': data = await service.testRetrieval(message.retrievalKeys); break;
      case 'testOfficialRetrieval': data = await service.testOfficialRetrieval(message.payload as { query: string }); break;
      case 'cancelOfficialRetrieval': data = await service.cancelOfficialRetrieval(); break;
      case 'getKnowledgeState': data = await service.getKnowledgeState(); break;
      case 'checkEnvironment': data = await service.checkEnvironment(); break;
      case 'configureLocalKnowledge': data = await service.configureLocalKnowledge(message.payload as ConfigureKnowledgeInput); break;
      case 'startKnowledgeSync': data = await service.startKnowledgeSync(message.payload as KnowledgeSyncMode); break;
      case 'cancelKnowledgeSync': data = await service.cancelKnowledgeSync(message.payload as string); break;
      case 'searchKnowledge': data = await service.searchKnowledge(message.payload as KnowledgeSearchInput); break;
      case 'getKnowledgeChunk': data = await service.getKnowledgeChunk(message.payload as string); break;
      case 'getReview': data = service.getReview(message.payload as string); break;
      case 'startReview': data = await service.startReview(message.payload as StartReviewInput, message.apiKey ?? null, message.retrievalKeys, message.connectionSecrets); break;
      case 'cancelReview': data = await service.cancelReview(message.payload as string); break;
      case 'getChanges': data = await service.getChanges(message.payload as string); break;
      case 'enableEditableCopy': data = await service.enableEditableCopy(message.payload as EnableEditableCopyInput); break;
      case 'saveChange': data = await service.saveChange(message.payload as SaveChangeInput); break;
      case 'generateChangeDraft': data = await service.generateChangeDraft(message.payload as GenerateChangeInput, message.apiKey ?? null); break;
      case 'cancelChangeDraft': data = await service.cancelChangeDraft(message.payload as string); break;
      case 'decideChange': data = await service.decideChange(message.payload as DecideChangeInput); break;
      case 'exportModified': data = await service.exportModified(message.payload as ExportChangesInput & { filePath: string }); break;
      case 'listContractDrafts': data = service.listContractDrafts(); break;
      case 'getContractDraft': data = service.getContractDraft(message.payload as string); break;
      case 'generateContract': data = await service.generateContract(message.payload as GenerateContractInput, message.apiKey ?? null); break;
      case 'cancelContractGeneration': data = await service.cancelContractGeneration(message.payload as string); break;
      case 'exportContractDraft': data = await service.exportContractDraft(message.payload as ExportContractDraftInput & { filePath: string }); break;
      case 'listEnterpriseStandards': data = service.listEnterpriseStandards(); break;
      case 'getEnterpriseStandard': data = service.getEnterpriseStandard(message.payload as string); break;
      case 'saveEnterpriseStandard': data = await service.saveEnterpriseStandard(message.payload as SaveEnterpriseStandardInput); break;
      case 'publishEnterpriseStandard': data = await service.publishEnterpriseStandard(message.payload as PublishEnterpriseStandardInput); break;
      case 'getRiskDispositions': data = service.getRiskDispositions(message.payload as string); break;
      case 'saveRiskDisposition': data = await service.saveRiskDisposition(message.payload as SaveRiskDispositionInput); break;
      case 'exportReview': {
        const review = service.getReview(message.payload as string);
        const document = service.getDocumentView(review.documentId);
        const rendered=await service.runWorkspaceCommand({action:'reporting.render',payload:{scope:'current',reviewId:review.id,style:'risk'}});
        data = { content: rendered.markdown, snapshot:rendered.snapshot, name: document.name.replace(/\.[^.]+$/, '') };
        break;
      }
      case 'close': await service.close(); data = null; break;
      default: throw new Error('不支持的应用命令。');
    }
    port.postMessage({ type: 'response', id: message.id, data });
  } catch (error) {
    port.postMessage({ type: 'response', id: message.id, error: error instanceof Error ? error.message : '本地服务执行失败。' });
  }
});
port.postMessage({ type: 'ready' });
