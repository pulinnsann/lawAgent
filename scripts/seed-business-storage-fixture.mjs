#!/usr/bin/env node
// Explicitly synthetic, empty-directory-only workspace used by compatibility
// tests and the desktop memory comparison. Never opens an existing workspace.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppStore } from '../src/core/storage.ts';
import { parseContract } from '../src/core/documents.ts';
import { createDocx } from '../tests/fixtures-documents.ts';

const options = { historyMiB: 0, documents: 1 };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]; const value = process.argv[i + 1];
  if (key === '--data-dir' && value) options.dataDir = resolve(value);
  else if (key === '--history-mib' && value) options.historyMiB = Number(value);
  else if (key === '--documents' && value) options.documents = Number(value);
  else throw new Error(`Unknown or missing argument: ${key}`);
}
assert.ok(options.dataDir, '--data-dir is required');
assert.ok(Number.isSafeInteger(options.historyMiB) && options.historyMiB >= 0 && options.historyMiB <= 256);
assert.ok(Number.isSafeInteger(options.documents) && options.documents >= 1 && options.documents <= 1000);
await mkdir(options.dataDir, { recursive: true });
assert.deepEqual(await readdir(options.dataDir), [], 'Fixture creation requires an empty directory');
const sha = value => createHash('sha256').update(value).digest('hex');
const original = await createDocx({
  paragraphs: ['服务付款应在验收后办理。', 'Payment follows acceptance.', 'ชำระเงินหลังตรวจรับบริการ'],
  rawBody: '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Preserve bold formatting.</w:t></w:r></w:p><w:p><w:ins w:id="37" w:author="Original Author" w:date="2025-01-01T00:00:00Z"><w:r><w:t>Preserve original revision.</w:t></w:r></w:ins></w:p>',
  header: 'Synthetic original header',
});
const originalRelativePath = 'documents/synthetic-compatibility/original.docx';
await mkdir(join(options.dataDir, 'documents/synthetic-compatibility'), { recursive: true });
await writeFile(join(options.dataDir, originalRelativePath), original);
let store;
try {
  store = await AppStore.open(options.dataDir);
  const parsed = await parseContract(join(options.dataDir, originalRelativePath));
  const document = await store.addDocument(randomUUID(), 'Synthetic compatibility contract.docx', originalRelativePath, original.length, sha(original), parsed);
  const context = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: 'Synthetic storage compatibility fixture; no legal advice.' };
  const task = { id: randomUUID(), documentId: document.id, status: 'queued', stage: 'Synthetic compatibility', startedAt: new Date().toISOString(), finishedAt: null, error: null, resultId: null };
  const runId = await store.createTask(task, context, 'local');
  const review = { id: randomUUID(), documentId: document.id, createdAt: new Date().toISOString(), mode: 'local', modelId: null, summary: 'Synthetic pre-migration review.', context,
    findings: [{ id: randomUUID(), blockIds: [parsed.blocks[0].id], quote: parsed.blocks[0].text, title: 'Synthetic acceptance check', category: 'commercial', severity: 'unrated', description: 'Storage compatibility fixture.', suggestion: 'Confirm acceptance in writing.', legalBasis: null, basisStatus: 'unverified', source: 'rule', locationStatus: 'matched' }],
    coverage: { reviewedBlockIds: parsed.blocks.map(block => block.id), totalBlockCount: parsed.blocks.length, knowledgeStatus: 'user_disabled', webStatus: 'user_disabled', limitations: ['Synthetic engineering data.'] }, inputTokens: null, outputTokens: null, elapsedMs: 1 };
  await store.saveReview(review, runId);
  await store.updateTask({ ...task, status: 'completed', stage: 'Completed', finishedAt: new Date().toISOString(), resultId: review.id }, runId);
  const block = parsed.blocks[0]; const stamp = new Date().toISOString();
  const proposal = { id: randomUUID(), reviewId: review.id, documentId: document.id, findingId: review.findings[0].id, blockId: block.id, rangeStart: 0, rangeEnd: block.text.length, originalText: block.text,
    replacementText: '服务付款应在双方书面确认后办理。', sourceFileSha256: sha(original), originalTextSha256: sha(block.text), status: 'proposed', explanation: 'Synthetic previously approved proposal.', warnings: ['Engineering data.'], modelId: null, createdAt: stamp, updatedAt: stamp };
  await store.saveChangeProposal(proposal, 0);
  await store.decideChangeProposal(review.id, proposal.id, 'accepted', 1);
  const sourceContract = store.rows('SELECT * FROM contracts WHERE id=?', [document.contractId])[0];
  const sourceVersion = store.rows('SELECT * FROM document_versions WHERE id=?', [document.id])[0];
  const sourceBlock = store.rows('SELECT * FROM document_blocks WHERE id=?', [block.id])[0];
  const insert = (table, row) => {
    const fields = Object.keys(row);
    store.rows(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, Object.values(row));
  };
  const payload = JSON.stringify({ synthetic: true, text: 'S'.repeat(16300) });
  const historyRows = Math.ceil(options.historyMiB * 1024 * 1024 / Buffer.byteLength(payload));
  await store.transaction(() => {
    for (let i = 1; i < options.documents; i += 1) {
      const contractId = randomUUID(); const id = randomUUID();
      insert('contracts', { ...sourceContract, id: contractId, title: `Synthetic historical contract ${String(i).padStart(5, '0')}.docx` });
      insert('document_versions', { ...sourceVersion, id, contract_id: contractId, source_name: `Synthetic historical contract ${String(i).padStart(5, '0')}.docx` });
      insert('document_blocks', { ...sourceBlock, id: randomUUID(), document_version_id: id });
    }
    for (let i = 0; i < historyRows; i += 1) insert('audit_events', {
      id: randomUUID(), workspace_id: store.workspaceId, entity_type: 'synthetic-memory-fixture', entity_id: document.id,
      action: 'synthetic-fixture', actor_kind: 'system', actor_label: 'Synthetic benchmark', detail_json: payload, created_at: stamp,
    });
  });
  assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
  const snapshot = { format: 'law-agent-synthetic-business-fixture-v1', workspaceId: store.workspaceId,
    documentId: document.id, reviewId: review.id, document: store.getDocument(document.id), review: store.getReview(review.id),
    proposals: store.getChangeProposals(review.id), changeRevision: store.getChangeRevision(review.id),
    originalRelativePath, originalSha256: sha(original), historyRows, historyPayloadBytes: historyRows * Buffer.byteLength(payload), documentCount: options.documents,
    schemaVersion: Number(store.rows('SELECT MAX(version) AS n FROM schema_version')[0].n) };
  await store.close(); store = undefined;
  console.log(JSON.stringify(snapshot));
} finally { await store?.close(); }
