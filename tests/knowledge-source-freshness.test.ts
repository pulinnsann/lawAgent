import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { AppStore } from '../src/core/storage';
import { WorkspaceAssets } from '../src/core/workspace-assets';
import { LocalKnowledgeIndex } from '../src/core/knowledge-index';
import { readKnowledgeSourceMetadata } from '../src/core/knowledge-source-metadata';
import { getWorkflowBeforeReview, getReviewFreshness, runReviewCompletionCommand } from '../src/core/workspace-review-completion';
import { buildReportSnapshot } from '../src/core/reporting';
import { defaultReportSettings } from '../src/shared/reporting';
import { defaultRetrievalConfig, type ReviewResult, type ReviewContext, type ReviewTask, type SourceEvidence } from '../src/shared/contracts';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '合成本地源版本验证' };
test('报告直接比较当前索引hash与解析版本，不依赖后续审核；删除/缺索引/不可读/过期标记保留unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'law-index-freshness-')); const dataDir = join(root, 'data'); const folder = join(root, 'sources'); await mkdir(folder);
  const path = join(folder, '合成制度.txt'); const initial = '合成制度：验收付款应核对授权，只用于工程测试。'; await writeFile(path, initial);
  const index = new LocalKnowledgeIndex(dataDir); const store = await AppStore.open(dataDir); const deps = { store, assets: new WorkspaceAssets(store), dataDir };
  const sync = () => index.syncFolder({ folderPath: folder, jobId: randomUUID(), mode: 'verify' }, new AbortController().signal);
  try {
    await sync(); const hit = (await index.search({ folderPath: folder, query: '验收付款' })).hits[0]; assert.ok(hit);
    const document = await store.addDocument(randomUUID(), '合成合同.docx', `synthetic/${randomUUID()}.docx`, 100, sha('合成合同'), { format: 'docx', language: 'zh', pageCount: null, partial: false, warnings: [], blocks: [{ id: randomUUID(), ordinal: 0, kind: 'paragraph', text: '甲方验收后付款。', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/p[1]', paragraphId: null } }] });
    await store.saveConfig({ name: '合成未调用模型配置', baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture-only', responseFormat: 'json_object', tokenParameter: 'max_tokens', maxOutputTokens: 1000, contextWindowTokens: 64000, timeoutSeconds: 5 });
    const configuration = defaultRetrievalConfig(); configuration.knowledge.enabled = true; configuration.knowledge.folderPath = folder; await store.saveRetrievalConfig(configuration);
    const before = await getWorkflowBeforeReview(deps, document.id); const timestamp = new Date().toISOString(); const task: ReviewTask = { id: randomUUID(), documentId: document.id, status: 'queued', stage: '合成', startedAt: timestamp, finishedAt: null, resultId: null, error: null }; const runId = await store.createTask(task, context, 'model', configuration);
    const attemptId = randomUUID(); const evidence: SourceEvidence = { id: randomUUID(), attemptId, channel: 'knowledge', kind: 'company_policy', title: hit.title, sourceUri: hit.sourceUri, locator: hit.locator, excerpt: hit.excerpt, excerptSha256: hit.excerptSha256, contentScope: 'fragment', retrievedAt: timestamp, publishedAt: null, effectiveAt: null, currentness: 'unknown', isOfficial: false, warnings: [], localIndex: { chunkId: hit.chunkId, sourceFileId: hit.sourceFileId, versionId: hit.versionId, fileSha256: hit.fileSha256, indexedAt: hit.indexedAt, location: hit.location } };
    const review: ReviewResult = { id: randomUUID(), documentId: document.id, createdAt: timestamp, mode: 'model', modelId: 'fixture-only', summary: '合成无模型调用', findings: [], context, completionSnapshot: before.snapshot, coverage: { reviewedBlockIds: document.blocks.map(block => block.id), totalBlockCount: 1, knowledgeStatus: 'complete', webStatus: 'user_disabled', limitations: [] }, elapsedMs: 1, inputTokens: null, outputTokens: null, retrieval: { configSnapshot: configuration, knowledgeStatus: 'complete', webStatus: 'user_disabled', evidence: [evidence], attempts: [{ id: attemptId, provider: 'folder', channel: 'knowledge', query: '验收付款', status: 'complete', startedAt: timestamp, finishedAt: timestamp, resultCount: 1, error: null, warnings: [] }], limitations: [] } };
    await store.saveReview(review, runId); const original = store.getReview(review.id);
    assert.equal(getReviewFreshness(deps, original).status, 'no_known_updates'); assert.equal(getReviewFreshness({ store, assets: deps.assets }, original).status, 'unknown');
    const updated = `${initial}\n新增内容：付款需补充审批。`; await writeFile(path, updated); await sync();
    const current = readKnowledgeSourceMetadata(dataDir, [hit.sourceFileId]); assert.equal(current.sources.get(hit.sourceFileId)?.fileSha256, sha(updated)); const freshness = getReviewFreshness(deps, original); assert.equal(freshness.status, 'updates_available'); assert.ok(freshness.reasons.some(reason => reason.kind === 'source' && reason.message.includes('本地知识来源'))); assert.equal(store.rows('SELECT COUNT(*) n FROM reports')[0].n, 1);
    const report = buildReportSnapshot({ scope: 'current', reviewId: review.id, style: 'management' }, store, defaultReportSettings(), new Date().toISOString(), deps.assets, dataDir); assert.equal(report.reviews[0].freshness?.status, 'updates_available'); assert.deepEqual(store.getReview(review.id), original);
    // A parser-only published version update is also observable, without
    // pretending that a different metadata hash proves a substantive change.
    const sql = new DatabaseSync(join(dataDir, 'local-knowledge/index.sqlite')); try { sql.prepare('UPDATE source_files SET file_sha256=?,version_id=? WHERE id=?').run(hit.fileSha256, 'd'.repeat(64), hit.sourceFileId); } finally { sql.close(); }
    assert.ok(getReviewFreshness(deps, original).reasons.some(reason => reason.current === `${hit.fileSha256}/${'d'.repeat(64)}`));
    const sql2 = new DatabaseSync(join(dataDir, 'local-knowledge/index.sqlite')); try { sql2.prepare('UPDATE source_files SET stale=1,stale_reason=? WHERE id=?').run('合成过期状态', hit.sourceFileId); } finally { sql2.close(); }
    assert.equal(getReviewFreshness(deps, original).status, 'unknown');
    await rm(path); await sync(); const missing = await runReviewCompletionCommand('reviewCompletion.freshness', { reviewId: review.id }, deps) as { status: string; limitations: string[] }; assert.equal(missing.status, 'unknown'); assert.ok(missing.limitations.some(value => value.includes('可能已删除')));
    assert.equal(readKnowledgeSourceMetadata(join(root, 'does-not-exist'), [hit.sourceFileId]).sources.get(hit.sourceFileId)?.status, 'unavailable'); assert.deepEqual(store.getReview(review.id), original);
  } finally { await index.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('来源元数据读取不创建索引、不读取原件；拒绝索引目录或文件外链，损坏库为unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'law-index-metadata-boundary-')); const data = join(root, 'data'); const outside = join(root, 'outside'); await mkdir(data); await mkdir(outside); const sourceFileId = randomUUID();
  try {
    assert.equal(readKnowledgeSourceMetadata(data, [sourceFileId]).complete, false);
    await symlink(outside, join(data, 'local-knowledge')); assert.equal(readKnowledgeSourceMetadata(data, [sourceFileId]).sources.get(sourceFileId)?.status, 'unavailable'); await rm(join(data, 'local-knowledge'));
    await mkdir(join(data, 'local-knowledge')); const bytes = Buffer.from('not-a-sqlite-database'); await writeFile(join(outside, 'index.sqlite'), bytes); await symlink(join(outside, 'index.sqlite'), join(data, 'local-knowledge/index.sqlite')); const linked = readKnowledgeSourceMetadata(data, [sourceFileId]); assert.equal(linked.complete, false); assert.match(linked.limitations.join('；'), /普通受管/); assert.deepEqual(await readFile(join(outside, 'index.sqlite')), bytes);
    await rm(join(data, 'local-knowledge/index.sqlite')); await writeFile(join(data, 'local-knowledge/index.sqlite'), bytes); assert.equal(readKnowledgeSourceMetadata(data, [sourceFileId]).sources.get(sourceFileId)?.status, 'unavailable'); assert.deepEqual(await readFile(join(data, 'local-knowledge/index.sqlite')), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
