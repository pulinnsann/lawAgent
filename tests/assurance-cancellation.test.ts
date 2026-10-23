import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { defaultEnterpriseStandard } from '../src/shared/assurance';
import type { ReviewTask } from '../src/shared/contracts';
import { createDocx } from './fixtures-documents';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// This timer only fails a broken test; ordering is entirely controlled by the
// final-stage event and queue gates, with no sleep/polling race assumptions.
function guarded<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Controlled review queue did not reach the expected boundary.')), 5000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

test('最终stage后的标准写入占用队列时取消审核，排到提交仍拒绝保存成功报告', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'law-assurance-cancel-')); const dataDir = join(folder, 'data');
  const file = join(folder, 'synthetic.docx'); const original = await createDocx({ paragraphs: ['甲方采购技术服务，双方确认付款和验收安排。'] });
  await writeFile(file, original);
  const store = await AppStore.open(dataDir);
  const releaseStandardWrite = deferred(); const standardWriteStarted = deferred(); const reviewSaveQueued = deferred(); const terminal = deferred<ReviewTask>();
  type QueuePort = { write<T>(fn: () => Promise<T>): Promise<T> };
  let queuePort!: QueuePort; let originalWrite!: QueuePort['write']; let waitingForReportSave = false;
  let blockingWrite: Promise<unknown> | undefined; let enqueueStandardWrite!: () => void;
  const service = new ContractService(store, dataDir, task => {
    if (task.stage === '整理审核结果与未核实事项' && !blockingWrite) enqueueStandardWrite();
    if (['completed', 'failed', 'cancelled'].includes(task.status)) terminal.resolve({ ...task });
  });
  queuePort = service as unknown as QueuePort; originalWrite = queuePort.write.bind(service);
  queuePort.write = function <T>(fn: () => Promise<T>): Promise<T> {
    const next = originalWrite(fn);
    if (waitingForReportSave) { waitingForReportSave = false; reviewSaveQueued.resolve(); }
    return next;
  };
  try {
    const draft = await service.saveEnterpriseStandard({ expectedRevision: 0, content: { ...defaultEnterpriseStandard(), name: '取消窗口工程标准', rules: [] } });
    const published = await service.publishEnterpriseStandard({ standardId: draft.id, expectedRevision: draft.revision, publishedBy: '测试法务' });
    const version = published.versions[0];
    enqueueStandardWrite = () => {
      // This simulates a slow independent company-standard write already queued
      // behind the final stage update, before performReview can queue saveReview.
      blockingWrite = originalWrite(async () => {
        standardWriteStarted.resolve(); await releaseStandardWrite.promise;
        return store.saveEnterpriseStandard({ standardId: published.id, expectedRevision: published.revision, content: { ...published.draft, description: '并发保存的新草稿，不改已发布版本。' } });
      });
      waitingForReportSave = true;
    };
    const document = await service.importFile(file);
    const started = await service.startReview({ documentId: document.id, mode: 'local', standardVersionId: version.id,
      context: { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '只执行本地规则，不调用模型。' } }, null);
    await guarded(standardWriteStarted.promise); await guarded(reviewSaveQueued.promise);
    assert.equal(store.rows("SELECT COUNT(*) AS n FROM reports WHERE kind='risk'")[0].n, 0);
    await service.cancelReview(started.taskId);
    releaseStandardWrite.resolve(); await guarded(blockingWrite!);
    const finished = await guarded(terminal.promise);
    assert.equal(finished.id, started.taskId); assert.equal(finished.status, 'cancelled'); assert.equal(finished.resultId, null);
    assert.equal(store.rows("SELECT COUNT(*) AS n FROM reports WHERE kind='risk'")[0].n, 0);
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM findings')[0].n, 0);
    assert.equal(service.getEnterpriseStandard(published.id).revision, published.revision + 1);
    assert.deepEqual(store.getEnterpriseStandardVersion(version.id), version);
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), createHash('sha256').update(original).digest('hex'));
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  } finally {
    releaseStandardWrite.resolve(); queuePort.write = originalWrite;
    await blockingWrite?.catch(() => {}); await service.close(); await rm(folder, { recursive: true, force: true });
  }
});
