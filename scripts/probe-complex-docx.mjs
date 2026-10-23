import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { AppStore } from '../src/core/storage.ts';
import { ContractService } from '../src/core/service.ts';
import { parseContract } from '../src/core/documents.ts';

// Explicit offline diagnostic. Only private temp copies and a fresh local-rule
// workspace are used. No real model, search service or client index is loaded.
if (!process.argv[2]) throw new Error('Usage: node --import tsx scripts/probe-complex-docx.mjs /absolute/input.docx');
const sourcePath = resolve(process.argv[2]); const original = await readFile(sourcePath);
const folder = await mkdtemp(join(tmpdir(), 'law-agent-complex-docx-')); const dataDir = join(folder, 'data'); const outputDir = join(folder, 'export');
await mkdir(outputDir); const originalPath = join(folder, 'original.docx'); await writeFile(originalPath, original, { flag: 'wx', mode: 0o600 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const testText = text => [...graphemes.segment(text)].map((item, index) => index === 0 ? /\d/u.test(item.segment) ? item.segment === '1' ? '2' : '1' : /[A-Za-z]/u.test(item.segment) ? item.segment === 'X' ? 'Y' : 'X' : item.segment === '测' ? '试' : '测' : item.segment).join('');
let store = await AppStore.open(dataDir); let service = new ContractService(store, dataDir);
try {
  const document = await service.importFile(originalPath);
  const started = await service.startReview({ documentId: document.id, mode: 'local', context: { contractType: 'other', ourPartyRole: 'other', strictness: 'balanced', businessContext: '本地结构与操作验证；替换文字不作为合同修改建议。' } }, null);
  const deadline = Date.now() + 15000;
  while (service.getState().tasks.find(task => task.id === started.taskId)?.status !== 'completed') {
    if (Date.now() >= deadline) throw new Error('Local fixture review did not complete');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const review = service.getDocument(document.id).reviews[0]; const originalReview = structuredClone(review);
  let workspace = await service.getChanges(review.id);
  if (workspace.editableCopy?.available) workspace = await service.enableEditableCopy({ reviewId: review.id, expectedRevision: workspace.revision });
  const targets = workspace.targets.filter(target => target.editMode === 'segments'); assert.ok(targets.length);
  const expected = new Map(document.blocks.map(block => [block.id, block.text])); const changes = [];
  for (const target of targets) {
    const segment = target.segments.filter(item => item.editable && item.text.trim()).sort((a, b) => b.text.length - a.text.length)[0]; assert.ok(segment, 'Each segmented target must offer a writable text span');
    const replacementText = testText(segment.text); assert.notEqual(replacementText, segment.text);
    workspace = await service.saveChange({ reviewId: review.id, findingId: null, blockId: target.blockId, segmentId: segment.id, expectedRevision: workspace.revision, replacementText });
    const proposal = workspace.proposals.find(item => item.blockId === target.blockId); assert.equal(proposal.originalText, segment.text);
    workspace = await service.decideChange({ reviewId: review.id, proposalId: proposal.id, status: 'accepted', expectedRevision: workspace.revision });
    expected.set(target.blockId, target.text.slice(0, segment.rangeStart) + replacementText + target.text.slice(segment.rangeEnd));
    changes.push({ ordinal: document.blocks.find(block => block.id === target.blockId).ordinal + 1, segmentId: segment.id, rangeStart: segment.rangeStart, rangeEnd: segment.rangeEnd });
  }
  const rejectedTarget = targets[0]; const rejectedSegment = rejectedTarget.segments.find(item => item.editable && item.text.trim());
  workspace = await service.saveChange({ reviewId: review.id, findingId: null, blockId: rejectedTarget.blockId, segmentId: rejectedSegment.id, expectedRevision: workspace.revision, replacementText: `${rejectedSegment.text}（未采纳测试）` });
  const rejected = workspace.proposals.find(item => item.status === 'proposed'); assert.ok(rejected);
  workspace = await service.decideChange({ reviewId: review.id, proposalId: rejected.id, status: 'rejected', expectedRevision: workspace.revision });
  const exported = await service.exportModified({ reviewId: review.id, expectedRevision: workspace.revision, filePath: join(outputDir, 'modified.docx') });
  const modified = await readFile(exported.documentPath); const parsed = await parseContract(exported.documentPath); assert.equal(parsed.blocks.length, document.blocks.length);
  const byLocator = new Map(parsed.blocks.map(block => [JSON.stringify(block.locator), block.text]));
  for (const block of document.blocks) assert.equal(byLocator.get(JSON.stringify(block.locator)), expected.get(block.id));
  const beforeZip = await JSZip.loadAsync(original); const afterZip = await JSZip.loadAsync(modified);
  const beforeXml = await beforeZip.file('word/document.xml').async('string'); const afterXml = await afterZip.file('word/document.xml').async('string');
  const stripText = xml => xml.replace(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/gu, '<w:t/>'); assert.equal(stripText(afterXml), stripText(beforeXml));
  const revisionXml = xml => xml.match(/<w:(?:ins|del|moveFrom|moveTo)\b[^>]*(?:\/>|>[\s\S]*?<\/w:(?:ins|del|moveFrom|moveTo)>)/gu) ?? [];
  assert.deepEqual(revisionXml(afterXml), revisionXml(beforeXml));
  const anchors = xml => xml.match(/<w:(?:permStart|permEnd|bookmarkStart|bookmarkEnd|br)\b[^>]*\/>/gu) ?? [];
  assert.deepEqual(anchors(afterXml), anchors(beforeXml));
  let preservedParts = 0;
  for (const [name, file] of Object.entries(beforeZip.files)) if (!file.dir && !['word/document.xml', 'word/settings.xml'].includes(name)) {
    assert.deepEqual(await afterZip.file(name).async('nodebuffer'), await file.async('nodebuffer')); preservedParts++;
  }
  assert.equal(sha(await readFile(sourcePath)), sha(original)); assert.equal(sha(await readFile(join(dataDir, store.getDocumentArtifact(document.id).artifactUri))), sha(original));
  assert.deepEqual(service.getReview(review.id), originalReview); assert.equal(exported.export.proposalIds.length, targets.length);
  await service.close(); store = await AppStore.open(dataDir); service = new ContractService(store, dataDir);
  const restored = await service.getChanges(review.id); assert.equal(restored.proposals.filter(item => item.status === 'accepted').length, targets.length); assert.equal(restored.exports.length, 1);
  const result = { passed: true, localOnly: true, modelCalls: 0, folder, originalPath, modifiedPath: exported.documentPath, sourceBlocks: document.blocks.length,
    editableBlocks: workspace.targets.filter(item => item.editable).length, segmentedBlocks: targets.length, accepted: targets.length, rejected: 1, changes,
    originalPreserved: true, originalReviewPreserved: true, onlyAcceptedWritten: true, restartRestored: true,
    structurePreserved: true, oldRevisionXmlPreserved: true, anchorXmlPreserved: true, preservedParts, originalSha256: sha(original), modifiedSha256: sha(modified), visualQa: 'pending-render' };
  await writeFile(join(folder, 'validation.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await service.close(); }
