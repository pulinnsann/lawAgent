import { useEffect, useRef, useState } from 'react';
import type { BlockPageCursor, ContractAssistantBridge, DocumentBlockPage } from '../../shared/contracts';
import { mergeBlockPageSelection, uniqueBlockOptions } from '../../shared/block-selection';
import { useI18n } from './i18n';

/** Fetch its own source pages. App's active display page is never assumed to
 * contain every block, and preview text is never submitted as source content. */
export default function SourceBlockMultiSelect({ bridge, documentId, selectedIds, onChange }: {
  bridge: ContractAssistantBridge; documentId: string; selectedIds: string[]; onChange: (ids: string[]) => void;
}) {
  const { t, translateMessage } = useI18n();
  const [page, setPage] = useState<DocumentBlockPage | null>(null);
  const [cursor, setCursor] = useState<BlockPageCursor | undefined>();
  const [history, setHistory] = useState<Array<BlockPageCursor | undefined>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const options = uniqueBlockOptions(page?.items ?? []);
  useEffect(() => {
    const ticket = ++request.current;
    setPage(null); setCursor(undefined); setHistory([]); setBusy(true); setError('');
    bridge.getDocumentBlocks({ documentId, limit: 100 }).then(value => { if (ticket === request.current) setPage(value); })
      .catch(cause => { if (ticket === request.current) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (ticket === request.current) setBusy(false); });
    return () => { ++request.current; };
  }, [bridge, documentId]);
  const move = async (direction: 'next' | 'previous') => {
    const next = direction === 'next' ? page?.nextCursor ?? undefined : history.at(-1);
    if (busy || direction === 'next' && !next || direction === 'previous' && !history.length) return;
    const ticket = ++request.current; setBusy(true); setError('');
    try {
      const value = await bridge.getDocumentBlocks({ documentId, cursor: next, limit: 100 });
      if (ticket !== request.current) return;
      setPage(value); setHistory(previous => direction === 'next' ? [...previous, cursor] : previous.slice(0, -1)); setCursor(next);
    } catch (cause) { if (ticket === request.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (ticket === request.current) setBusy(false); }
  };
  return <section className="source-block-multiselect">
    <label className="field"><span>{t('关联原文段落（可多选）')}</span>
      <select multiple size={5} aria-label={t('关联原文段落（可多选）')} value={selectedIds} disabled={busy || !page}
        onChange={event => onChange(mergeBlockPageSelection(selectedIds, options.map(block => block.id), [...event.target.selectedOptions].map(option => option.value)))}>
        {options.map(block => <option key={block.id} value={block.id}>{block.ordinal + 1}. {block.text.slice(0, 90)}</option>)}
      </select>
      <small>{t('已选 {count} 个原文段落；翻页不会清除已有选择。', { count: selectedIds.length })}</small>
    </label>
    <div className="page-controls">
      <button type="button" disabled={busy || !history.length} onClick={() => void move('previous')}>{t('上一页原文')}</button>
      <span>{t('本页 {v0} 个片段，共匹配 {v1} 个原文块', { v0: page?.items.length ?? 0, v1: page?.matchedCount ?? 0 })}</span>
      <button type="button" disabled={busy || !page?.hasMore} onClick={() => void move('next')}>{t('下一页原文')}</button>
      <button type="button" disabled={busy || !selectedIds.length} onClick={() => onChange([])}>{t('清除全部关联段落')}</button>
    </div>
    {error && <p className="notice error" role="alert">{translateMessage(error)}</p>}
  </section>;
}
