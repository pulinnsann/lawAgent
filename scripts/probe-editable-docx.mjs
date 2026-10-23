import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { AppStore } from '../src/core/storage.ts';
import { ContractService } from '../src/core/service.ts';
import { inspectDocxEditProtection } from '../src/core/docx-patcher.ts';
import { parseContract } from '../src/core/documents.ts';

// Explicit local-only diagnostic for a user-supplied protected DOCX. The source
// is read, never modified; fixtures, SQLite and exports live in a private temp
// directory. No model configuration, website or knowledge source is loaded.
if (!process.argv[2]) throw new Error('Usage: node --import tsx scripts/probe-editable-docx.mjs /absolute/input.docx');
const sourcePath = resolve(process.argv[2]); const source = await readFile(sourcePath);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const folder = await mkdtemp(join(tmpdir(), 'law-agent-editable-docx-'));
const dataDir = join(folder, 'data'); const exportDir = join(folder, 'export'); await mkdir(exportDir);
const input = join(folder, 'original.docx'); await writeFile(input, source, { mode: 0o600, flag: 'wx' });
const store = await AppStore.open(dataDir); let service = new ContractService(store, dataDir);
try {
  const document = await service.importFile(input);
  const started = await service.startReview({ documentId: document.id, mode: 'local', context: { contractType: 'other', ourPartyRole: 'other', strictness: 'balanced', businessContext: '本地工程流程验证，不拟定法律意见。' } }, null);
  const deadline = Date.now() + 15000;
  while (service.getState().tasks.find(task => task.id === started.taskId)?.status !== 'completed') {
    if (Date.now() >= deadline) throw new Error('Local fixture review did not complete');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const review = service.getDocument(document.id).reviews[0]; const beforeReview = structuredClone(review);
  let workspace = await service.getChanges(review.id); assert.equal(workspace.supported, false); assert.equal(workspace.editableCopy?.available, true);
  workspace = await service.enableEditableCopy({ reviewId: review.id, expectedRevision: workspace.revision });
  const editable = workspace.targets.filter(target => target.editable); assert.ok(editable.length >= 2);
  const first = editable[0];
  const second = editable.find(target => target.blockId !== first.blockId);
  const acceptedText = `${first.text}（流程测试）`; const rejectedText = `${second.text}（未采纳测试）`;
  workspace = await service.saveChange({ reviewId: review.id, findingId: null, blockId: first.blockId, expectedRevision: workspace.revision, replacementText: acceptedText });
  const accepted = workspace.proposals[0];
  workspace = await service.decideChange({ reviewId: review.id, proposalId: accepted.id, status: 'accepted', expectedRevision: workspace.revision });
  workspace = await service.saveChange({ reviewId: review.id, findingId: null, blockId: second.blockId, expectedRevision: workspace.revision, replacementText: rejectedText });
  const rejected = workspace.proposals.find(proposal => proposal.id !== accepted.id);
  workspace = await service.decideChange({ reviewId: review.id, proposalId: rejected.id, status: 'rejected', expectedRevision: workspace.revision });
  const exported = await service.exportModified({ reviewId: review.id, expectedRevision: workspace.revision, filePath: join(exportDir, 'modified.docx') });
  const modified = await readFile(exported.documentPath); const parsed = await parseContract(exported.documentPath);
  const byPath = new Map(parsed.blocks.map(block => [JSON.stringify(block.locator), block.text]));
  for (const block of document.blocks) assert.equal(byPath.get(JSON.stringify(block.locator)), block.id === first.blockId ? acceptedText : block.text);
  assert.equal(parsed.blocks.length, document.blocks.length);
  assert.equal((await inspectDocxEditProtection(modified)).kind, 'none');
  assert.equal((await inspectDocxEditProtection(source)).kind, 'readOnly');
  const originalZip = await JSZip.loadAsync(source); const modifiedZip = await JSZip.loadAsync(modified); let preservedParts = 0;
  for (const [name, file] of Object.entries(originalZip.files)) if (!file.dir && !['word/document.xml', 'word/settings.xml'].includes(name)) {
    assert.deepEqual(await modifiedZip.file(name).async('nodebuffer'), await file.async('nodebuffer')); preservedParts++;
  }
  assert.equal(sha(await readFile(sourcePath)), sha(source));
  assert.equal(sha(await readFile(join(dataDir, store.getDocumentArtifact(document.id).artifactUri))), sha(source));
  assert.deepEqual(service.getReview(review.id), beforeReview);
  assert.match(await readFile(exported.changeListPath, 'utf8'), /可编辑副本/);
  await service.close(); service = new ContractService(await AppStore.open(dataDir), dataDir);
  const restored = await service.getChanges(review.id); assert.equal(restored.editableCopy.enabled, true); assert.equal(restored.exports.length, 1);
  const result = { passed: true, localOnly: true, modelCalls: 0, folder, originalPath: input, modifiedPath: exported.documentPath, sourceBlocks: document.blocks.length,
    editableBlocks: editable.length, complexBlocks: workspace.targets.length - editable.length, accepted: 1, rejected: 1, unchangedParts: preservedParts,
    originalPreserved: true, originalReviewPreserved: true, onlyAcceptedWritten: true, restartRestored: true, originalSha256: sha(source), modifiedSha256: sha(modified), visualQa: 'pending-render' };
  await writeFile(join(folder, 'validation.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await service.close(); }
