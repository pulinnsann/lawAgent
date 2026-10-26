// Executed inside the actual WKWebView/WebView2 or the Electron reference window.
// Only the feature-gated test build receives this script. It uses ordinary,
// allowlisted desktop bridge methods and synthetic fixture data.
export async function desktopSmokeFlow(config, report) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (value, message) => { if (!value) throw new Error(message); };
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const equivalent = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  async function wait(read, good, label, timeout = 60000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const value = await read(); if (good(value)) return value; await sleep(50); }
    throw new Error(`Timed out: ${label}`);
  }
  const errors = []; const tasks = []; const stages = [];
  let bridge; let unsubscribe = () => {};
  const onError = event => errors.push(String(event.message ?? event.reason ?? 'Renderer error'));
  window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onError);
  let stageName = 'startup';
  async function stage(name, action = async () => null) {
    stageName = name;
    await report({ final: false, passed: false, phase: name, state: 'started', stages });
    const start = performance.now();
    const result = await action();
    const operationMs = performance.now() - start;
    await sleep(Math.max(0, config.windowMs - operationMs));
    stages.push({ name, operationMs, observedWindowMs: performance.now() - start, result });
    await report({ final: false, passed: false, phase: name, state: 'completed', stages });
    return result;
  }
  const button = (label, within = document) => [...within.querySelectorAll('button')].find(item => item.textContent.trim() === label);
  async function click(label, within = document) {
    const item = await wait(() => button(label, within), value => value && !value.disabled, `enabled button ${label}`);
    item.click();
  }
  async function completedReview(before) {
    return wait(async () => (await bridge.getState()).tasks.find(task => !before.includes(task.id) && ['completed', 'failed', 'cancelled'].includes(task.status)), Boolean, 'review completion').then(task => { check(task.status === 'completed', task.error ?? `Review status ${task.status}`); return task; });
  }
  try {
    bridge = await wait(() => window.contractAssistant, Boolean, 'desktop bridge');
    await wait(() => document.querySelector('h1'), Boolean, 'rendered application');
    const initial = await bridge.getState();
    check(initial.isPreview === false && initial.storageBackend === 'rust', 'A real native-storage desktop workspace is required.');
    unsubscribe = bridge.onTaskUpdate(task => tasks.push({ id: task.id, status: task.status, stage: task.stage }));
    await stage('idle-existing-history', async () => ({ documents: initial.documents.length, title: document.title, rendered: Boolean(document.querySelector('.workspace')) }));
    if (config.restart) {
      const retained = await stage('restart-data-preservation', async () => {
        const expected = config.previous;
        const review = await bridge.getReview(expected.review.id);
        check(equivalent(review, expected.review), 'The full saved review changed across restart.');
        const changes = await bridge.getChanges(review.id);
        check(changes.proposals.find(item => item.id === expected.acceptedId)?.status === 'accepted', 'Accepted change missing after restart.');
        check(changes.proposals.find(item => item.id === expected.rejectedId)?.status === 'rejected', 'Rejected change missing after restart.');
        check(changes.exports.some(item => item.documentId === expected.exported.export.documentId && item.format === 'tracked'), 'Tracked export history missing after restart.');
        const historical = await bridge.getReview(config.fixture.reviewId);
        check(equivalent(historical, config.fixture.review), 'Original historical review changed.');
        // Credential unlock is deliberately deferred until a model operation.
        await bridge.testModelConnection();
        const state = await bridge.getState(); check(state.modelConfig.hasApiKey === true, 'OS-encrypted model key was not retained.');
        return { reviews: true, decisions: true, exports: true, modelCredential: true, documentIds: state.documents.map(item => item.id) };
      });
      check(errors.length === 0, JSON.stringify(errors));
      await report({ final: true, passed: true, phase: 'done', restart: true, cleanupCredential: true, stages, retained, errors, tasks });
      return;
    }
    await stage('paged-contracts-and-original', async () => {
      const ids = []; let cursor;
      do { const page = await bridge.listDocumentsPage({ limit: 37, ...(cursor ? { cursor } : {}) }); ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor; } while (cursor);
      check(ids.length === config.fixture.documentCount && new Set(ids).size === ids.length, 'Contract pagination lost or duplicated documents.');
      const blocks = []; cursor = undefined;
      do { const page = await bridge.getDocumentBlocks({ documentId: config.fixture.documentId, limit: 2, ...(cursor ? { cursor } : {}) }); blocks.push(...page.items); cursor = page.nextCursor; } while (cursor);
      check(equivalent(blocks.map(({ textWindow: _window, ...item }) => item), config.fixture.document.blocks), 'Original source blocks changed.');
      const historical = await bridge.getReview(config.fixture.reviewId);
      check(equivalent(historical, config.fixture.review), 'Historical review changed.');
      return { traversedDocuments: ids.length, blocks: blocks.length, historicalReviewPreserved: true };
    });
    const imported = await stage('import-new-docx', async () => {
      const item = await wait(() => document.querySelector('.import-button'), value => value && !value.disabled, 'import button'); item.click();
      const state = await wait(() => bridge.getState(), value => value.documents.some(item => item.name === config.inputName), 'native dialog import');
      const summary = state.documents.find(item => item.name === config.inputName);
      await wait(() => document.querySelector('.document-meta strong')?.textContent, value => value === config.inputName, 'imported source rendered');
      return { id: summary.id, blocks: summary.blockCount, selectedAndRendered: true };
    });
    await stage('configure-model-and-local-index', async () => {
      await bridge.saveModelConfig({ name: 'Synthetic Tauri API', baseUrl: config.endpoint, model: 'synthetic-shell-review', responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: 4096, contextWindowTokens: 65536, timeoutSeconds: 30, apiKey: config.apiKey });
      check((await bridge.getState()).modelConfig.hasApiKey === true, 'Model credential was not saved.');
      await bridge.testModelConnection();
      check(await bridge.selectKnowledgeFolder() === config.knowledgeFolder, 'Knowledge folder authority differs from the selected directory.');
      await bridge.saveRetrievalConfig(config.retrieval);
      const { jobId } = await bridge.startKnowledgeSync('incremental');
      const knowledge = await wait(() => bridge.getKnowledgeState(), value => value.job?.id === jobId && value.job.status !== 'running', 'local index');
      check(knowledge.job.status === 'completed' && knowledge.job.failed === 0 && knowledge.indexedFiles === 1, JSON.stringify(knowledge.job));
      return { indexedFiles: knowledge.indexedFiles, encryptedCredential: true };
    });
    await stage('local-review', async () => {
      const before = (await bridge.getState()).tasks.map(item => item.id);
      await click('本地规则检查'); const task = await completedReview(before);
      return { reviewId: task.resultId, status: task.status };
    });
    const review = await stage('mock-model-review-with-local-citation', async () => {
      const before = (await bridge.getState()).tasks.map(item => item.id);
      await click('开始模型审核'); const task = await completedReview(before);
      const result = await bridge.getReview(task.resultId);
      check(result.findings[0]?.citations[0]?.matchStatus === 'matched' && result.findings[0].basisStatus === 'source_matched', 'The model citation did not match saved source text.');
      check(result.retrieval.evidence.some(item => item.localIndex?.fileSha256 && item.sourceUri.startsWith('file:')), 'Local source provenance missing.');
      await wait(() => document.querySelector('.review-summary')?.textContent, value => value?.includes('Synthetic cited contract review.'), 'cited review rendered');
      return result;
    });
    const decisions = await stage('propose-and-adopt-one-item', async () => {
      await click('拟定修改');
      const panel = await wait(() => document.getElementById(`changes-${review.id}`), Boolean, 'changes panel');
      await wait(() => button('刷新修改记录', panel), Boolean, 'changes loaded');
      let changes = await bridge.getChanges(review.id);
      const targets = changes.targets.filter(item => item.editable && (!item.segments || item.segments.every(segment => segment.editable)));
      check(targets.length >= 2, 'Synthetic fixture must contain two editable paragraphs.');
      let acceptedId, rejectedId;
      for (const [target, replacementText, status] of [[targets[0], '服务付款应在双方书面确认后办理。', 'accepted'], [targets[1], 'This rejected text must not appear.', 'rejected']]) {
        changes = await bridge.saveChange({ reviewId: review.id, findingId: null, blockId: target.blockId, expectedRevision: changes.revision, replacementText });
        const proposal = changes.proposals.find(item => item.blockId === target.blockId);
        changes = await bridge.decideChange({ reviewId: review.id, proposalId: proposal.id, expectedRevision: changes.revision, status });
        if (status === 'accepted') acceptedId = proposal.id; else rejectedId = proposal.id;
      }
      await click('刷新修改记录', panel);
      await wait(() => panel.querySelectorAll('.change-proposal').length, value => value === 2, 'proposal decisions rendered');
      return { acceptedId, rejectedId, accepted: 1, rejected: 1 };
    });
    const exported = await stage('tracked-docx-and-cited-report-export', async () => {
      const changes = await bridge.getChanges(review.id);
      const result = await bridge.exportModified({ reviewId: review.id, expectedRevision: changes.revision, format: 'tracked', revisionAuthor: 'Native shell QA' });
      check(result?.export.format === 'tracked', 'Tracked DOCX export did not complete.');
      check((await bridge.exportReview(review.id))?.path, 'Cited Markdown report did not export.');
      return result;
    });
    await stage('native-multilingual-pdf-export', async () => {
      const paths = [];
      for (const language of ['zh', 'en', 'th']) {
        const request = { scope: 'current', reviewId: review.id, style: 'management', settings: { language, organization: '合成测试单位 / Synthetic organization / องค์กรตัวอย่าง', authorLabel: '测试法务 / Legal QA / ทดสอบ', recipientLabel: '内部 / Internal / ภายใน', includeContractQuotes: true, includeDispositionHistory: true } };
        let translationId;
        if (language !== 'zh') {
          // Explicit synthetic approval exercises the production approval gate.
          // These literal test translations carry no linguistic or legal claim.
          let translation = await bridge.runWorkspaceCommand({ action: 'reporting.translation.prepare', payload: { request, actorLabel: 'Synthetic engineering fixture' } });
          const edits = translation.asset.body.units.filter(unit => !unit.target).map(unit => ({ id: unit.id, target: `${language === 'en' ? 'Synthetic translated report: written acceptance check.' : 'ข้อมูลรายงานสมมติเพื่อทดสอบการตรวจรับบริการ'} ${unit.protectedValues.map(value => value.token).join(' ')}`.trim() }));
          if (edits.length) translation = await bridge.runWorkspaceCommand({ action: 'reporting.translation.save', payload: { id: translation.asset.id, expectedRevision: translation.asset.revision, actorLabel: 'Synthetic engineering fixture', edits } });
          translation = await bridge.runWorkspaceCommand({ action: 'reporting.translation.confirm', payload: { id: translation.asset.id, expectedRevision: translation.asset.revision, actorLabel: 'Synthetic engineering fixture', reason: 'Synthetic mappings only; legal and language correctness are outside this engineering smoke.', confirmed: true } });
          translationId = translation.asset.id;
        }
        const result = await bridge.runWorkspaceCommand({ action: 'reporting.export', payload: { ...request, ...(translationId ? { translationId } : {}), format: 'pdf' } });
        check(result?.path, `Native ${language} PDF export failed.`); paths.push(result.path);
      }
      return { paths };
    });
    await stage('import-trilingual-pdf', async () => {
      const item = document.querySelector('.import-button'); check(item && !item.disabled, 'Import button unavailable.'); item.click();
      const state = await wait(() => bridge.getState(), value => value.documents.some(item => item.name === config.pdfName), 'trilingual PDF import');
      const pdf = state.documents.find(item => item.name === config.pdfName); const detail = await bridge.getDocument(pdf.id);
      check(detail.blocks.some(item => item.text.includes('合同付款')) && detail.blocks.some(item => item.text.includes('ข้อความภาษาไทย')), 'Trilingual PDF source text was not preserved.');
      return { id: pdf.id, blocks: pdf.blockCount };
    });
    await stage('idle-after-full-review');
    check(tasks.some(item => item.status === 'completed') && tasks.some(item => item.status === 'running'), 'Task events did not reach the renderer.');
    check(errors.length === 0, JSON.stringify(errors));
    await report({ final: true, passed: true, phase: 'done', stages, review, acceptedId: decisions.acceptedId, rejectedId: decisions.rejectedId, exported, errors, tasks, body: document.body.innerText.slice(-8000) });
  } catch (error) {
    await report({ final: true, passed: false, phase: stageName, stages, errors, tasks, error: `${error?.message ?? String(error)}\n${error?.stack ?? ''}`, body: document.body?.innerText.slice(-12000) ?? '' });
  } finally { unsubscribe(); window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onError); }
}
