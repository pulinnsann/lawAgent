import { z } from 'zod';
import type { AppStore } from './storage';
import type { ContractSummary, ContractView, DocumentBlockPage, DocumentBlocksInput, DocumentListInput, DocumentListPage, DocumentReviewsInput, ReviewSummaryPage, DisplayContractBlock } from '../shared/contracts';

const id = z.string().uuid();
const listCursor = z.object({ createdAt: z.string().datetime(), id }).strict();
const listInput = z.object({ cursor: listCursor.optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const blockInput = z.object({ documentId: id, cursor: z.object({ ordinal: z.number().int().min(0), textOffset: z.number().int().min(0) }).strict().optional(), limit: z.number().int().min(1).max(100).optional(), query: z.string().max(1000).optional(), aroundBlockId: id.optional() }).strict();
const reviewInput = z.object({ documentId: id, cursor: listCursor.optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
export const BLOCK_PAGE_MAX_BYTES = 512 * 1024;
const TEXT_WINDOW_CHARACTERS = 16 * 1024;
type Row = ReturnType<AppStore['rows']>[number];

function documentRow(store: AppStore, documentId: string): Row {
  id.parse(documentId);
  const row = store.rows('SELECT d.*,c.title,c.project_id,c.lifecycle_status,c.revision AS contract_revision FROM document_versions d JOIN contracts c ON c.id=d.contract_id WHERE d.id=? AND c.workspace_id=?', [documentId, store.workspaceId])[0];
  if (!row) throw new Error('合同不存在或不属于当前工作空间。');
  return row;
}
function summary(store: AppStore, row: Row): ContractSummary {
  const latest = store.rows("SELECT r.id FROM reports r JOIN analysis_runs a ON a.id=r.report_key WHERE a.document_version_id=? AND r.workspace_id=? AND r.kind='risk' ORDER BY r.created_at DESC,r.id DESC LIMIT 1", [row.id, store.workspaceId])[0];
  const name = row.source_name ? String(row.source_name) : row.kind === 'revised' ? `${String(row.title).replace(/\.[^.]+$/, '')} · 修改稿 v${row.version_no}.docx` : String(row.title);
  return { id: String(row.id), contractId: String(row.contract_id), versionNo: Number(row.version_no), parentVersionId: row.parent_version_id ? String(row.parent_version_id) : null, versionKind: String(row.kind), projectId: row.project_id ? String(row.project_id) : null, lifecycleStatus: row.lifecycle_status as ContractSummary['lifecycleStatus'], contractRevision: Number(row.contract_revision ?? 1), name, format: row.source_format as ContractSummary['format'], language: row.language as ContractSummary['language'], byteSize: Number(row.byte_size), blockCount: Number(store.rows('SELECT COUNT(*) AS n FROM document_blocks WHERE document_version_id=?', [row.id])[0].n), importedAt: String(row.created_at), warnings: (JSON.parse(String(row.parse_issues_json)) as Array<{ message: string }>).map(p => p.message), partial: row.parse_status === 'partial', latestReviewId: latest ? String(latest.id) : null };
}

/** Native SQLite applies cursors before crossing IPC. Risk report_key is its
 * immutable run ID; use normalized metadata instead of parsing report snapshots. */
export function listDocumentsPage(store: AppStore, raw: DocumentListInput = {}): DocumentListPage {
  const input = listInput.parse(raw); const limit = input.limit ?? 50;
  const base = "FROM document_versions d JOIN contracts c ON c.id=d.contract_id LEFT JOIN projects p ON p.id=c.project_id WHERE c.workspace_id=? AND c.lifecycle_status='active' AND (p.id IS NULL OR p.lifecycle_status='active')";
  if (input.cursor && !store.rows(`SELECT d.id ${base} AND d.id=? AND d.created_at=?`, [store.workspaceId, input.cursor.id, input.cursor.createdAt]).length) throw new Error('合同分页位置已失效，请刷新列表。');
  const params = input.cursor ? [store.workspaceId, input.cursor.createdAt, input.cursor.createdAt, input.cursor.id, limit + 1] : [store.workspaceId, limit + 1];
  const rows = store.rows(`SELECT d.*,c.title,c.project_id,c.lifecycle_status,c.revision AS contract_revision ${base}${input.cursor ? ' AND (d.created_at<? OR (d.created_at=? AND d.id<?))' : ''} ORDER BY d.created_at DESC,d.id DESC LIMIT ?`, params);
  const hasMore = rows.length > limit; const shown = rows.slice(0, limit); const last = shown.at(-1);
  return { items: shown.map(row => summary(store, row)), hasMore, nextCursor: hasMore && last ? { createdAt: String(last.created_at), id: String(last.id) } : null, totalCount: Number(store.rows(`SELECT COUNT(*) AS n ${base}`, [store.workspaceId])[0].n) };
}

export function getDocumentBlocks(store: AppStore, raw: DocumentBlocksInput): DocumentBlockPage {
  const input = blockInput.parse(raw); documentRow(store, input.documentId);
  if (input.cursor && input.aroundBlockId) throw new Error('不能同时指定分页位置与定位段落。');
  let ordinal = input.cursor?.ordinal ?? 0; let offset = input.cursor?.textOffset ?? 0;
  if (input.aroundBlockId) {
    const target = store.rows('SELECT ordinal FROM document_blocks WHERE document_version_id=? AND id=?', [input.documentId, input.aroundBlockId])[0];
    if (!target) throw new Error('原文段落不存在或不属于此合同。');
    ordinal = Number(target.ordinal);
  }
  if (input.cursor) {
    const target = store.rows('SELECT length(original_text) AS n FROM document_blocks WHERE document_version_id=? AND ordinal=?', [input.documentId, ordinal])[0];
    if (!target || offset > Number(target.n) || offset === Number(target.n) && offset > 0) throw new Error('原文分页位置无效，请重新打开合同。');
  }
  const query = input.query?.trim() ?? '';
  const filter = query ? " AND instr(lower(coalesce(json_extract(locator_json,'$.numberingLabel'),'') || ' ' || original_text),lower(?))>0" : '';
  const queryParams = query ? [query] : [];
  const totalCount = Number(store.rows('SELECT COUNT(*) AS n FROM document_blocks WHERE document_version_id=?', [input.documentId])[0].n);
  const matchedCount = Number(store.rows(`SELECT COUNT(*) AS n FROM document_blocks WHERE document_version_id=?${filter}`, [input.documentId, ...queryParams])[0].n);
  const items: DisplayContractBlock[] = []; let byteSize = 0; let nextCursor: DocumentBlockPage['nextCursor'] = null;
  const limit = input.limit ?? 50;
  while (items.length < limit) {
    // Fetch metadata and bounded text only; even a single huge paragraph cannot
    // force a full-document/paragraph allocation into Node or the renderer.
    const row = store.rows(`SELECT id,ordinal,kind,substr(original_text,?,?) AS original_text,length(original_text) AS total_length,CASE WHEN length(locator_json)<=65536 THEN locator_json ELSE NULL END AS locator_json FROM document_blocks WHERE document_version_id=? AND ordinal>=?${filter} ORDER BY ordinal LIMIT 1`, [offset + 1, TEXT_WINDOW_CHARACTERS, input.documentId, ordinal, ...queryParams])[0];
    if (!row) { nextCursor = null; break; }
    // A query may skip the cursor's block. Never apply its text offset to a
    // later matching block: repeat that bounded projection from character zero.
    if (Number(row.ordinal) !== ordinal && offset > 0) { ordinal = Number(row.ordinal); offset = 0; continue; }
    if (row.locator_json == null) throw new Error('此原文段落的位置数据过大，请使用原始文档查看。');
    const { numberingLabel, ...locator } = JSON.parse(String(row.locator_json));
    const text = String(row.original_text); let length = 0; for (const _character of text) length++; const totalLength = Number(row.total_length);
    const block: DisplayContractBlock = { id: String(row.id), ordinal: Number(row.ordinal), kind: row.kind as DisplayContractBlock['kind'], text, locator, ...(typeof numberingLabel === 'string' && numberingLabel.length <= 250 ? { numberingLabel } : {}), ...(offset > 0 || length < totalLength ? { textWindow: { offset, length, totalLength, unit: 'unicode-code-point' as const } } : {}) };
    const bytes = Buffer.byteLength(JSON.stringify(block));
    if (bytes > BLOCK_PAGE_MAX_BYTES) throw new Error('此原文段落的位置数据过大，请使用原始文档查看。');
    if (byteSize + bytes > BLOCK_PAGE_MAX_BYTES - 2048) { nextCursor = { ordinal: Number(row.ordinal), textOffset: offset }; break; }
    items.push(block); byteSize += bytes;
    if (offset + length < totalLength) { ordinal = Number(row.ordinal); offset += length; }
    else { ordinal = Number(row.ordinal) + 1; offset = 0; }
    const following = store.rows(`SELECT ordinal FROM document_blocks WHERE document_version_id=? AND ordinal>=?${filter} ORDER BY ordinal LIMIT 1`, [input.documentId, ordinal, ...queryParams])[0];
    nextCursor = following ? { ordinal: Number(following.ordinal), textOffset: Number(following.ordinal) === ordinal ? offset : 0 } : null;
    if (!nextCursor) break;
  }
  const page = { items, nextCursor, hasMore: nextCursor !== null, totalCount, matchedCount, byteSize: 0, maxBytes: BLOCK_PAGE_MAX_BYTES };
  page.byteSize = Buffer.byteLength(JSON.stringify(page));
  page.byteSize = Buffer.byteLength(JSON.stringify(page));
  return page;
}

export function getDocumentReviews(store: AppStore, raw: DocumentReviewsInput): ReviewSummaryPage {
  const input = reviewInput.parse(raw); documentRow(store, input.documentId); const limit = input.limit ?? 25;
  const base = "FROM reports r JOIN analysis_runs a ON a.id=r.report_key WHERE a.document_version_id=? AND r.workspace_id=? AND r.kind='risk'";
  if (input.cursor && !store.rows(`SELECT r.id ${base} AND r.id=? AND r.created_at=?`, [input.documentId, store.workspaceId, input.cursor.id, input.cursor.createdAt]).length) throw new Error('审核分页位置无效，请刷新审核记录。');
  const rows = store.rows(`SELECT r.id,r.created_at,json_extract(a.input_snapshot_json,'$.mode') AS mode,(SELECT COUNT(*) FROM findings f WHERE f.analysis_run_id=a.id) AS finding_count ${base}${input.cursor ? ' AND (r.created_at<? OR (r.created_at=? AND r.id<?))' : ''} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`, [input.documentId, store.workspaceId, ...(input.cursor ? [input.cursor.createdAt, input.cursor.createdAt, input.cursor.id] : []), limit + 1]);
  const hasMore = rows.length > limit; const items = rows.slice(0, limit).map(row => ({ id: String(row.id), documentId: input.documentId, createdAt: String(row.created_at), mode: row.mode === 'model' ? 'model' as const : 'local' as const, findingCount: Number(row.finding_count ?? 0) })); const last = items.at(-1);
  return { items, hasMore, nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null, totalCount: Number(store.rows(`SELECT COUNT(*) AS n ${base}`, [input.documentId, store.workspaceId])[0].n) };
}

export function getDocumentView(store: AppStore, documentId: string): ContractView {
  const row = documentRow(store, documentId); const blockPage = getDocumentBlocks(store, { documentId }); const reviewPage = getDocumentReviews(store, { documentId });
  return { ...summary(store, row), blocks: blockPage.items, reviews: [], blockPage, reviewPage };
}
