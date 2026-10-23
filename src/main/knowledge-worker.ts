import { parentPort, workerData } from 'node:worker_threads';
import { LocalKnowledgeIndex } from '../core/knowledge-index';
import type { KnowledgePreferences, KnowledgeSearchInput, KnowledgeSyncMode } from '../shared/knowledge';
import { runEnvironmentProbe } from '../core/setup-environment';

if (!parentPort) throw new Error('Knowledge worker requires a parent port.');
const port = parentPort;
const index = new LocalKnowledgeIndex(workerData.dataDir as string);
const controllers = new Map<string, AbortController>();
const inFlight = new Set<Promise<void>>();
let closing = false;
type Message = { id: string; command: string; payload: any };
async function dispatch(message: Message): Promise<void> {
  try {
    let data: unknown;
    switch (message.command) {
      case 'getState': data = await index.getState(message.payload.folderPath as string | null, message.payload.preferences as KnowledgePreferences | undefined); break;
      case 'checkEnvironment': {
        data = await runEnvironmentProbe(workerData.dataDir as string);
        await index.getState(null);
        (data as Awaited<ReturnType<typeof runEnvironmentProbe>>).checks.push({ id: 'index_worker', label: '后台索引服务', status: 'passed', message: '独立索引进程运行正常。' });
        break;
      }
      case 'search': {
        const controller = new AbortController(); controllers.set(message.id, controller);
        try { data = await index.search(message.payload as KnowledgeSearchInput & { folderPath: string }, controller.signal); }
        finally { controllers.delete(message.id); }
        break;
      }
      case 'readChunk': data = await index.readChunk(message.payload as { folderPath: string; chunkId: string; preferences?: KnowledgePreferences }); break;
      case 'syncFolder': {
        const controller = new AbortController(); controllers.set(message.id, controller);
        try { data = await index.syncFolder(message.payload as { folderPath: string; jobId: string; mode: KnowledgeSyncMode; preferences?: KnowledgePreferences }, controller.signal, job => port.postMessage({ type: 'progress', id: message.id, job })); }
        finally { controllers.delete(message.id); }
        break;
      }
      default: throw new Error('不支持的知识库命令。');
    }
    port.postMessage({ id: message.id, data });
  } catch (error) { port.postMessage({ id: message.id, error: error instanceof Error ? error.message : '知识库任务失败。' }); }
}
port.on('message', (message: Message) => {
  if (message.command === 'cancel') { controllers.get(message.id)?.abort(); return; }
  if (message.command === 'close') {
    closing = true;
    for (const controller of controllers.values()) controller.abort();
    void Promise.allSettled([...inFlight]).then(() => index.close()).then(
      () => port.postMessage({ id: message.id, data: null }),
      error => port.postMessage({ id: message.id, error: error instanceof Error ? error.message : '知识库关闭失败。' }),
    );
    return;
  }
  if (closing) { port.postMessage({ id: message.id, error: '知识库正在关闭。' }); return; }
  const operation = dispatch(message);
  inFlight.add(operation);
  void operation.finally(() => inFlight.delete(operation));
});
