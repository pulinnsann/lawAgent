import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppStore } from './storage';
import type { WorkspaceAssets } from './workspace-assets';
import type { ContractDetail } from '../shared/contracts';
import type { ContractRecord, DocumentCatalog, LifecycleStatus, ProjectRecord, ReferenceTranslation, TranslationRecord, TranslationWorkspace } from '../shared/document-workspace';

type Enqueue = <T>(fn: () => Promise<T>) => Promise<T>;
export interface DocumentWorkspaceDeps { store: AppStore; assets: WorkspaceAssets; enqueue: Enqueue; assertIdle: (documentIds: string[]) => void }
const id = z.string().uuid();
const line = (max: number) => z.string().trim().min(1).max(max).refine(s => !/[\u0000-\u001f\u007f]/u.test(s));
const state = z.enum(['active', 'archived', 'trashed']);
const revision = z.number().int().min(1);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const projectRow = (deps: DocumentWorkspaceDeps, key: string) => {
  const row = deps.store.rows('SELECT * FROM projects WHERE id=? AND workspace_id=?', [id.parse(key), deps.store.workspaceId])[0];
  if (!row) throw new Error('项目不存在或不属于当前工作空间。'); return row;
};
const contractRow = (deps: DocumentWorkspaceDeps, key: string) => {
  const row = deps.store.rows('SELECT * FROM contracts WHERE id=? AND workspace_id=?', [id.parse(key), deps.store.workspaceId])[0];
  if (!row) throw new Error('合同不存在或不属于当前工作空间。'); return row;
};
export function assertDocumentActive(store: AppStore, documentId: string): void {
  const row = store.rows('SELECT c.lifecycle_status,p.lifecycle_status project_status FROM document_versions d JOIN contracts c ON c.id=d.contract_id LEFT JOIN projects p ON p.id=c.project_id WHERE d.id=? AND c.workspace_id=?', [documentId, store.workspaceId])[0];
  if (!row) throw new Error('合同不存在或已清理。');
  if (row.lifecycle_status !== 'active' || row.project_status && row.project_status !== 'active') throw new Error('合同或项目已归档／移入回收站，请先恢复后再操作。');
}
export function visibleDocuments(store: AppStore) {
  const active = new Set(store.rows("SELECT c.id FROM contracts c LEFT JOIN projects p ON p.id=c.project_id WHERE c.workspace_id=? AND c.lifecycle_status='active' AND (p.id IS NULL OR p.lifecycle_status='active')", [store.workspaceId]).map(r => String(r.id)));
  return store.listDocuments().filter(d => d.contractId && active.has(d.contractId));
}
export function documentCatalog(deps: DocumentWorkspaceDeps): DocumentCatalog {
  const documents = deps.store.listDocuments();
  const projects: ProjectRecord[] = deps.store.rows('SELECT * FROM projects WHERE workspace_id=? ORDER BY updated_at DESC,id', [deps.store.workspaceId]).map(r => ({ id: String(r.id), name: String(r.name), revision: Number(r.revision), status: r.lifecycle_status as LifecycleStatus, deletedAt: r.deleted_at ? String(r.deleted_at) : null, contractCount: Number(deps.store.rows('SELECT COUNT(*) n FROM contracts WHERE project_id=?', [r.id])[0].n) }));
  const contracts: ContractRecord[] = deps.store.rows('SELECT * FROM contracts WHERE workspace_id=? ORDER BY updated_at DESC,id', [deps.store.workspaceId]).map(r => ({ id: String(r.id), title: String(r.title), projectId: r.project_id ? String(r.project_id) : null, projectName: projects.find(p => p.id === r.project_id)?.name ?? null, revision: Number(r.revision), status: r.lifecycle_status as LifecycleStatus, deletedAt: r.deleted_at ? String(r.deleted_at) : null, versions: documents.filter(d => d.contractId === r.id).sort((a,b) => (b.versionNo ?? 1) - (a.versionNo ?? 1)) }));
  return { projects, contracts };
}
function audit(deps: DocumentWorkspaceDeps, entity: string, entityId: string, action: string, actor: string, detail: unknown) {
  deps.store.rows('INSERT INTO audit_events(id,workspace_id,entity_type,entity_id,action,actor_kind,actor_label,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [randomUUID(), deps.store.workspaceId, entity, entityId, action, 'user', actor, JSON.stringify(detail), new Date().toISOString()]);
}
function versions(deps: DocumentWorkspaceDeps, contractId: string): string[] { return deps.store.rows('SELECT id FROM document_versions WHERE contract_id=?', [contractId]).map(r => String(r.id)); }

export async function runDocumentWorkspaceCommand(action: string, payload: unknown, deps: DocumentWorkspaceDeps): Promise<unknown> {
  if (action === 'documents.catalog') return documentCatalog(deps);
  if (action === 'documents.project.save') {
    const p = z.object({ id: id.optional(), expectedRevision: z.number().int().min(0), name: line(160), actorLabel: line(80) }).strict().parse(payload);
    return deps.enqueue(() => deps.store.transaction(() => {
      const previous = p.id ? projectRow(deps, p.id) : null;
      if (Number(previous?.revision ?? 0) !== p.expectedRevision) throw new Error('项目已更新，请刷新后重试。');
      if (previous?.lifecycle_status === 'trashed') throw new Error('请先恢复项目再编辑。');
      if (deps.store.rows('SELECT id FROM projects WHERE workspace_id=? AND name=? COLLATE NOCASE AND id<>?', [deps.store.workspaceId, p.name, p.id ?? '']).length) throw new Error('项目名称已存在。');
      const key = p.id ?? randomUUID(); const stamp = new Date().toISOString();
      if (previous) deps.store.rows('UPDATE projects SET name=?,revision=revision+1,updated_at=? WHERE id=?', [p.name,stamp,key]);
      else deps.store.rows('INSERT INTO projects(id,workspace_id,name,created_at,updated_at) VALUES(?,?,?,?,?)', [key,deps.store.workspaceId,p.name,stamp,stamp]);
      audit(deps,'project',key,'saved',p.actorLabel,{name:p.name,revision:p.expectedRevision+1});
      return key;
    }));
  }
  if (action === 'documents.contract.assign') {
    const p = z.object({ contractId: id, projectId: id.nullable(), expectedRevision: revision, title: line(200).optional(), actorLabel: line(80) }).strict().parse(payload);
    return deps.enqueue(() => deps.store.transaction(() => {
      const row = contractRow(deps,p.contractId); deps.assertIdle(versions(deps,p.contractId));
      if (Number(row.revision) !== p.expectedRevision) throw new Error('合同版本或所属项目已更新，请刷新。');
      if (row.lifecycle_status !== 'active') throw new Error('请先恢复合同再编辑。');
      if (p.projectId && projectRow(deps,p.projectId).lifecycle_status !== 'active') throw new Error('目标项目需要处于使用中状态。');
      deps.store.rows('UPDATE contracts SET project_id=?,title=?,revision=revision+1,updated_at=? WHERE id=?', [p.projectId,p.title ?? row.title,new Date().toISOString(),p.contractId]);
      audit(deps,'contract',p.contractId,'assigned',p.actorLabel,{projectId:p.projectId,title:p.title ?? row.title});
      return true;
    }));
  }
  if (action === 'documents.contract.status' || action === 'documents.project.status') {
    const p = z.object({ id, expectedRevision: revision, status: state, actorLabel: line(80), reason: line(1000) }).strict().parse(payload);
    return deps.enqueue(() => deps.store.transaction(() => {
      const project = action === 'documents.project.status';
      const row = project ? projectRow(deps,p.id) : contractRow(deps,p.id);
      if (Number(row.revision) !== p.expectedRevision) throw new Error('记录已更新，请刷新后重试。');
      const docIds = project ? deps.store.rows('SELECT d.id FROM document_versions d JOIN contracts c ON c.id=d.contract_id WHERE c.project_id=?', [p.id]).map(r=>String(r.id)) : versions(deps,p.id);
      deps.assertIdle(docIds);
      const table = project ? 'projects' : 'contracts';
      if (!project && p.status === 'active' && row.project_id && projectRow(deps,String(row.project_id)).lifecycle_status !== 'active') throw new Error('请先恢复合同所属项目。');
      const stamp = new Date().toISOString();
      deps.store.rows(`UPDATE ${table} SET lifecycle_status=?,previous_status=?,deleted_at=?,revision=revision+1,updated_at=? WHERE id=?`, [p.status,row.lifecycle_status === 'trashed' ? row.previous_status : row.lifecycle_status,p.status === 'trashed' ? stamp : null,stamp,p.id]);
      audit(deps,project?'project':'contract',p.id,'status_changed',p.actorLabel,{before:row.lifecycle_status,after:p.status,reason:p.reason,retention:'manual_restore_no_auto_purge'});
      return true;
    }));
  }
  if (action === 'translations.get') {
    const p = z.object({ documentId: id }).strict().parse(payload); return translationWorkspace(deps,p.documentId);
  }
  if (action === 'translations.history') {
    const p = z.object({ id }).strict().parse(payload); const asset = deps.assets.get(p.id);
    if (asset.kind !== 'reference_translation') throw new Error('不是参考译文记录。');
    deps.store.getDocument(asset.body.documentId);
    return deps.assets.history(p.id);
  }
  if (action === 'translations.save') {
    const p = z.object({ id: id.optional(), expectedRevision: z.number().int().min(0), documentId:id, blockId:id, sourceTextSha256:z.string().regex(/^[a-f0-9]{64}$/), sourceFileSha256:z.string().regex(/^[a-f0-9]{64}$/), targetLanguage:z.enum(['zh','en','th']),text:z.string().trim().min(1).max(30000).refine(s=>!/[\u0000\u000b\u000c\u007f]/u.test(s)),status:z.enum(['unreviewed','reviewed','disputed']),actorLabel:line(80),reason:line(2000),origin:z.enum(['manual','model']).default('manual'),modelId:line(200).nullable().default(null),confirmed:z.boolean().optional() }).strict().parse(payload);
    const validate = () => {
    assertDocumentActive(deps.store,p.documentId);
    const document = deps.store.getDocument(p.documentId); const block = document.blocks.find(b=>b.id===p.blockId);
    if (!block || hash(block.text) !== p.sourceTextSha256 || deps.store.getDocumentArtifact(document.id).sha256 !== p.sourceFileSha256) throw new Error('译文对应原文已变化或定位不一致，不能保存到其他版本。');
    const previous = p.id ? deps.assets.get(p.id) : null;
    if (previous && (previous.kind !== 'reference_translation' || previous.body.documentId !== p.documentId || previous.body.blockId !== p.blockId || previous.body.targetLanguage !== p.targetLanguage)) throw new Error('译文来源、语言和定位不可更改，请另建关联。');
    if (p.status === 'reviewed' && !p.confirmed) throw new Error('标为已复核需要人工确认。');
    const existing = deps.assets.list('reference_translation').find(a=>a.body.documentId===p.documentId&&a.body.blockId===p.blockId&&a.body.targetLanguage===p.targetLanguage);
    if (existing && existing.id !== p.id) throw new Error('该段已有此语言译文，请编辑现有记录以保留历史。');
    };
    const body:ReferenceTranslation = {documentId:p.documentId,blockId:p.blockId,sourceTextSha256:p.sourceTextSha256,sourceFileSha256:p.sourceFileSha256,targetLanguage:p.targetLanguage,text:p.text,status:p.status,actorLabel:p.actorLabel,reason:p.reason,origin:p.origin,modelId:p.origin==='model'?p.modelId:null,previousTranslationId:p.id??null};
    return deps.assets.save({id:p.id,kind:'reference_translation',expectedRevision:p.expectedRevision,body,actorLabel:p.actorLabel},validate);
  }
  throw new Error('不支持的合同资料操作。');
}
export function translationWorkspace(deps: Pick<DocumentWorkspaceDeps,'store'|'assets'>, documentId: string): TranslationWorkspace {
  const d = deps.store.getDocument(documentId);
  return {documentId:d.id,sourceLanguage:d.language,sourceFileSha256:deps.store.getDocumentArtifact(d.id).sha256,blocks:d.blocks.map(b=>({...b,sourceTextSha256:hash(b.text)})),translations:deps.assets.list('reference_translation').filter(a=>a.body.documentId===d.id) as TranslationRecord[]};
}
export function translationSource(store: AppStore, document: ContractDetail, blockId: string) {
  const block=document.blocks.find(b=>b.id===blockId); if(!block)throw new Error('原文段落不存在。');
  return {sourceTextSha256:hash(block.text),sourceFileSha256:store.getDocumentArtifact(document.id).sha256};
}
