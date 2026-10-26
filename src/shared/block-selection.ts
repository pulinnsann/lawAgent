import type { DisplayContractBlock } from './contracts';

/** A display page can contain several windows of the same immutable block.
 * Linking always selects its source ID, never a fragment's display text. */
export function uniqueBlockOptions(blocks: readonly DisplayContractBlock[]): DisplayContractBlock[] {
  const options = new Map<string, DisplayContractBlock>();
  for (const block of blocks) if (!options.has(block.id)) options.set(block.id, block);
  return [...options.values()];
}

/** A native multi-select reports only options rendered on its current page.
 * Preserve links to every other page and retain stable source-ID ordering. */
export function mergeBlockPageSelection(current: readonly string[], visibleIds: readonly string[], selectedIds: readonly string[]): string[] {
  const visible = new Set(visibleIds);
  const selected = new Set(selectedIds.filter(id => visible.has(id)));
  return [...new Set([...current.filter(id => !visible.has(id) || selected.has(id)), ...selected])];
}
