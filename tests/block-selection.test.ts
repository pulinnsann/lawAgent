import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBlockPageSelection, uniqueBlockOptions } from '../src/shared/block-selection';
import type { DisplayContractBlock } from '../src/shared/contracts';

test('editing one source page preserves selected source IDs on other pages and their order', () => {
  const first = mergeBlockPageSelection(['first-page', 'second-page', 'third-page'], ['second-page', 'new-second'], ['new-second']);
  assert.deepEqual(first, ['first-page', 'third-page', 'new-second']);
  const second = mergeBlockPageSelection(first, ['first-page', 'new-first'], ['first-page', 'new-first']);
  assert.deepEqual(second, ['first-page', 'third-page', 'new-second', 'new-first']);
  assert.deepEqual(mergeBlockPageSelection(second, ['third-page'], []), ['first-page', 'new-second', 'new-first']);
});

test('page selection is duplicate-free, allows deliberate deselection and ignores unknown display options', () => {
  assert.deepEqual(mergeBlockPageSelection(['off-page', 'same', 'same'], ['same', 'other'], ['same', 'same', 'other', 'unknown']), ['off-page', 'same', 'other']);
  assert.deepEqual(mergeBlockPageSelection(['off-page', 'same'], ['same'], []), ['off-page']);
  assert.deepEqual(mergeBlockPageSelection([], ['same'], ['same']), ['same']);
});

test('multiple Unicode windows of one source block produce one selectable original ID', () => {
  const block: DisplayContractBlock = { id: 'source-one', ordinal: 1, kind: 'paragraph', text: '中文😀', locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: 'body/p[2]', paragraphId: null }, textWindow: { offset: 0, length: 3, totalLength: 6, unit: 'unicode-code-point' } };
  const following: DisplayContractBlock = { ...block, text: 'ภาษาไทย', textWindow: { ...block.textWindow!, offset: 3 } };
  const other: DisplayContractBlock = { ...block, id: 'source-two', ordinal: 2 };
  assert.deepEqual(uniqueBlockOptions([block, following, other]), [block, other]);
  assert.equal(block.text, '中文😀'); assert.equal(following.textWindow?.offset, 3);
});
