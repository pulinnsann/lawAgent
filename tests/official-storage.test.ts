import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import initSqlJs, { type Database } from 'sql.js';
import { AppStore } from '../src/core/storage';
import { defaultRetrievalConfig, type ParsedContract, type PublicRetrievalConfig, type RetrievalBundle, type ReviewContext, type ReviewResult, type ReviewTask, type SourceEvidence } from '../src/shared/contracts';

const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '合成资料，仅检查持久化与迁移。' };
const timestamp = '2026-10-22T08:00:00Z';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function evidence(attemptId: string, kind: SourceEvidence['kind'], isOfficial = true): SourceEvidence {
  const excerpt = kind === 'contract_template' ? '虚构示范文本：验收后支付服务费用。' : '虚构参考材料：验收与付款需要结合合同约定核验。';
  return { id: randomUUID(), attemptId, channel: 'web', kind, title: `合成${kind}资料`, sourceUri: `https://www.court.gov.cn/test-only/${randomUUID()}.html`,
    locator: '第1段', excerpt, excerptSha256: sha(excerpt), contentScope: 'fragment', retrievedAt: timestamp,
    publishedAt: '2026-10-01', effectiveAt: null, currentness: 'unknown', isOfficial, warnings: ['工程检查样本，不是真实法律材料。'],
    ...(isOfficial ? { officialMetadata: { publisher: '合成发布机关', documentNumber: '工程样本〔2026〕1号', versionLabel: '合成版本',
      discoveredVia: 'catalog' as const, catalogUrl: 'https://xzfg.moj.gov.cn/search2.html', article: '第一条', relevantTextOffset: excerpt.indexOf('验收'), validityNote: '效力及时效未核验。' } } : {}) };
}

async function fixture(store: AppStore, official: boolean) {
  const parsed: ParsedContract = { format: 'docx', language: 'zh', warnings: [], partial: false, pageCount: null,
    blocks: [{ id: randomUUID(), ordinal: 0, kind: 'paragraph', text: '乙方完成服务后，甲方支付服务费用。',
      locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/p[1]', paragraphId: null } }] };
  const document = await store.addDocument(randomUUID(), '合成持久化合同.docx', 'documents/test-only/original.docx', 100, sha('合成持久化合同'), parsed);
  await store.saveConfig({ name: '本机合成模型配置', baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture-only', responseFormat: 'json_object',
    tokenParameter: 'max_tokens', maxOutputTokens: 1000, contextWindowTokens: 64000, timeoutSeconds: 5 });
  const config = defaultRetrievalConfig();
  config.official = { enabled: official, maxCatalogPages: 2, sourceUrls: official ? ['https://www.court.gov.cn/zixun/xiangqing/419382.html'] : [] };
  if (!official) config.web = { ...config.web, enabled: true, baseUrl: 'https://search.example.test/' };
  const savedConfig = await store.saveRetrievalConfig(config);
  const task: ReviewTask = { id: randomUUID(), documentId: document.id, status: 'queued', stage: '合成检查', startedAt: timestamp, finishedAt: null, error: null, resultId: null };
  const runId = await store.createTask(task, context, 'model', savedConfig);
  const attemptId = randomUUID();
  const sources = official ? [evidence(attemptId, 'judicial_interpretation'), evidence(attemptId, 'contract_template')] : [evidence(attemptId, 'case', false)];
  const bundle: RetrievalBundle = { configSnapshot: savedConfig, knowledgeStatus: 'user_disabled', webStatus: official ? 'partial' : 'complete',
    officialStatus: official ? 'partial' : 'user_disabled', searchStatus: official ? 'user_disabled' : 'complete',
    attempts: [{ id: attemptId, provider: official ? 'official_catalog' : 'searxng', channel: 'web', query: '验收 付款', status: official ? 'partial' : 'complete',
      startedAt: timestamp, finishedAt: timestamp, resultCount: sources.length, error: null, warnings: official ? ['目录覆盖有限。'] : [],
      ...(official ? { coverage: { catalogPagesRequested: 2, catalogPagesRead: 1, catalogCandidates: 3, matchedCandidates: 2, userUrlsRequested: 1,
        userUrlsRead: 1, failedReads: 1, catalogExhausted: false, truncated: true, totalPages: 10, pagesLimit: 2 } } : {}) }],
    evidence: sources, limitations: ['仅验证持久化，未核验法律效力。'], modelEvidenceIds: sources.map(source => source.id) };
  const review: ReviewResult = { id: randomUUID(), documentId: document.id, createdAt: timestamp, mode: 'model', modelId: 'fixture-only', summary: '工程检查报告。', context,
    findings: [{ id: randomUUID(), blockIds: [parsed.blocks[0].id], quote: parsed.blocks[0].text, title: '合成验收提示', category: 'commercial', severity: 'unrated',
      description: '合成工程意见。', suggestion: '请人工核验。', legalBasis: null, basisStatus: 'source_matched', source: 'model', locationStatus: 'matched',
      citations: sources.map(source => ({ evidenceId: source.id, quote: source.excerpt, matchStatus: 'matched' })) }],
    coverage: { reviewedBlockIds: parsed.blocks.map(block => block.id), totalBlockCount: 1, knowledgeStatus: 'user_disabled', webStatus: bundle.webStatus, limitations: [...bundle.limitations] },
    inputTokens: 10, outputTokens: 10, elapsedMs: 1, retrieval: bundle };
  await store.saveReview(review, runId);
  await store.updateTask({ ...task, status: 'completed', stage: '合成检查完成', finishedAt: timestamp, resultId: review.id }, runId);
  return { document, runId, review, bundle, config: savedConfig };
}

test('官方配置、partial覆盖、模板类别和元数据关系持久化，重启仍保持引用及固定配置快照', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-official-store-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir);
    const saved = await fixture(store, true);
    const originalConfig = structuredClone(saved.config.official);
    await store.saveRetrievalConfig({ ...saved.config, official: { enabled: false, maxCatalogPages: 1, sourceUrls: [] } });
    const persisted = store.getReview(saved.review.id);
    assert.deepEqual(persisted.retrieval?.configSnapshot.official, originalConfig);
    assert.equal(store.getRetrievalConfig()?.official?.enabled, false);
    assert.deepEqual(persisted.retrieval?.attempts[0].coverage, saved.bundle.attempts[0].coverage);
    assert.equal(persisted.retrieval?.attempts[0].status, 'partial');
    assert.equal(persisted.retrieval?.officialStatus, 'partial');
    assert.equal(persisted.retrieval?.searchStatus, 'user_disabled');
    for (const source of saved.bundle.evidence) {
      const restored: SourceEvidence | undefined = persisted.retrieval?.evidence.find(item => item.id === source.id);
      assert.deepEqual(restored?.officialMetadata, source.officialMetadata);
      assert.equal(restored?.kind, source.kind);
      assert.equal(restored?.excerptSha256, source.excerptSha256);
    }
    assert.ok(store.rows('SELECT kind FROM evidence').some(row => row.kind === 'contract_template'));
    assert.ok(store.rows('SELECT * FROM evidence').every(row => row.verification_status === 'unverified' && row.currentness === 'unknown' && row.jurisdiction === 'PRC'));
    assert.equal(store.rows('SELECT * FROM finding_evidence').length, 2);
    assert.equal(store.rows('SELECT * FROM report_sources WHERE evidence_id IS NOT NULL').length, 2);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
    assert.equal(store.rows('PRAGMA foreign_keys')[0].foreign_keys, 1);
    const template = saved.bundle.evidence.find(source => source.kind === 'contract_template')!;
    assert.throws(() => store!.rows('UPDATE evidence SET original_excerpt=? WHERE id=?', ['覆盖历史原文', template.id]), /immutable/);
    assert.throws(() => store!.rows('UPDATE evidence SET source_url=? WHERE id=?', ['https://www.court.gov.cn/changed', template.id]), /immutable/);
    await store.close(); store = await AppStore.open(dir);
    const restarted = store.getReview(saved.review.id);
    assert.deepEqual(restarted.findings[0].citations, saved.review.findings[0].citations);
    assert.deepEqual(restarted.retrieval?.modelEvidenceIds, saved.review.retrieval?.modelEvidenceIds);
    assert.deepEqual(restarted.retrieval?.attempts[0].coverage, saved.bundle.attempts[0].coverage);
    assert.deepEqual(restarted.retrieval?.evidence.find(source => source.id === template.id)?.officialMetadata, template.officialMetadata);
    assert.equal(store.getDocument(saved.document.id).reviews[0].id, saved.review.id);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

function sqlRows(db: Database, sql: string) {
  return db.exec(sql).flatMap(result => result.values.map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index]]))));
}
function sortedRows<T extends object>(rows: T[]): T[] {
  return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Build an actual v1 schema, copying only v1-compatible fixtures. JSON fields
 * omit official configuration as they did before this feature existed. */
async function legacyDatabase(store: AppStore) {
  const SQL = await initSqlJs(); const db = new SQL.Database();
  db.run(await readFile(new URL('../src/core/migrations/001-initial.sql', import.meta.url), 'utf8'));
  db.run('PRAGMA foreign_keys=OFF');
  const tables = sqlRows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name <> 'schema_version'").map(row => String(row.name));
  for (const table of tables) {
    for (const raw of store.rows(`SELECT * FROM "${table}"`)) {
      const row = { ...raw };
      if (table === 'provider_profiles' && row.adapter_id === 'retrieval-config') {
        const value = JSON.parse(String(row.settings_json)) as PublicRetrievalConfig; delete value.official; row.settings_json = JSON.stringify(value);
      }
      if (table === 'analysis_runs') {
        const value = JSON.parse(String(row.retrieval_policy_snapshot_json)); delete value.config?.official; row.retrieval_policy_snapshot_json = JSON.stringify(value);
      }
      if (table === 'reports') {
        const content = JSON.parse(String(row.content_json)); delete content.review?.retrieval?.configSnapshot?.official; row.content_json = JSON.stringify(content);
        const manifest = JSON.parse(String(row.input_manifest_json)); delete manifest.retrievalConfigSnapshot?.config?.official; row.input_manifest_json = JSON.stringify(manifest);
      }
      const columns = new Set(sqlRows(db,`PRAGMA table_info("${table}")`).map(column=>String(column.name)));
      const fields = Object.keys(row).filter(key=>columns.has(key)); db.run(`INSERT INTO "${table}" (${fields.map(field => `"${field}"`).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(key=>row[key]));
    }
  }
  assert.deepEqual(sqlRows(db, 'PRAGMA foreign_key_check'), []);
  const expected = Object.fromEntries(tables.map(table => [table, sortedRows(sqlRows(db, `SELECT * FROM "${table}"`))]));
  return { db, expected };
}

test('真实v1库迁移保留原始数据、引用关系和不可变触发器，并保留原始字节备份', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-official-v1-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); const saved = await fixture(store, false);
    const legacy = await legacyDatabase(store); const originalBytes = Buffer.from(legacy.db.export()); legacy.db.close();
    await store.close(); store = undefined; await writeFile(join(dir, 'workspace.sqlite'), originalBytes);
    store = await AppStore.open(dir);
    assert.equal(Number(store.rows('SELECT MAX(version) AS version FROM schema_version')[0].version), 7);
    for (const [table, expected] of Object.entries(legacy.expected)) {
      const oldColumns=expected[0]?Object.keys(expected[0]):[];
      const actual: Record<string, any>[]=store.rows(`SELECT * FROM "${table}"`).map(row=>oldColumns.length?Object.fromEntries(oldColumns.map(key=>[key,row[key]])):row);
      assert.deepEqual(sortedRows(actual), expected, `v1 rows changed in ${table}`);
    }
    assert.deepEqual(store.getReview(saved.review.id).findings[0].citations, saved.review.findings[0].citations);
    assert.equal(store.getReview(saved.review.id).retrieval?.evidence[0].kind, 'case');
    assert.equal(store.getRetrievalConfig()?.official?.enabled, false);
    assert.equal(store.rows('PRAGMA foreign_keys')[0].foreign_keys, 1);
    assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
    const sourceId = saved.bundle.evidence[0].id;
    assert.throws(() => store!.rows('UPDATE evidence SET original_excerpt=? WHERE id=?', ['覆盖迁移前原文', sourceId]), /immutable/);
    assert.throws(() => store!.rows('UPDATE analysis_runs SET input_snapshot_json=? WHERE id=?', ['{}', saved.runId]), /immutable/);
    assert.throws(() => store!.rows('UPDATE document_blocks SET original_text=? WHERE id=?', ['覆盖合同', saved.document.blocks[0].id]), /immutable/);
    assert.throws(() => store!.rows('DELETE FROM evidence WHERE id=?', [sourceId]), /FOREIGN KEY/);
    const backupPath = join(dir, 'workspace.sqlite.v1-backup');
    assert.deepEqual(await readFile(backupPath), originalBytes);
    if (process.platform !== 'win32') assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    await store.close(); store = await AppStore.open(dir);
    assert.deepEqual(await readFile(backupPath), originalBytes);
    assert.deepEqual(store.getReview(saved.review.id).findings[0].citations, saved.review.findings[0].citations);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('v1关系损坏时迁移失败不覆盖原库，备份仍保留失败前的原始内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-official-migration-failure-')); let store: AppStore | undefined;
  try {
    store = await AppStore.open(dir); await fixture(store, false);
    const legacy = await legacyDatabase(store);
    legacy.db.run("UPDATE report_sources SET evidence_id='missing-source' WHERE evidence_id IS NOT NULL");
    const originalBytes = Buffer.from(legacy.db.export()); legacy.db.close();
    await store.close(); store = undefined; await writeFile(join(dir, 'workspace.sqlite'), originalBytes);
    await assert.rejects(AppStore.open(dir), /关系校验失败/);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite')), originalBytes);
    assert.deepEqual(await readFile(join(dir, 'workspace.sqlite.v1-backup')), originalBytes);
  } finally { await store?.close(); await rm(dir, { recursive: true, force: true }); }
});
