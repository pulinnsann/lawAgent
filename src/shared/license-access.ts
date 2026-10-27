/** Explicit read/export paths remain available after expiry. Unknown actions
 * require authorization rather than inheriting access from a name prefix. */
const readonlyWorkspace = new Set([
  'workspace.licenseState', 'workspace.licenseActivate', 'workspace.resources', 'workspace.status', 'workspace.progress', 'workspace.cancel', 'workspace.interfaceLocale',
  'documents.catalog', 'documents.inspectPurge', 'translations.get', 'translations.history',
  'reviewCompletion.get', 'reviewCompletion.freshness', 'alignment.get', 'alignment.candidates', 'alignment.history',
  'modelRuntime.settings.get', 'modelRuntime.ledger.list', 'modelRuntime.ledger.get',
  'reporting.query', 'reporting.render', 'reporting.export', 'reporting.recordExport', 'reporting.settings.get',
  'reporting.translation.get', 'reporting.translation.list', 'reporting.translation.history',
  'library.experience.list', 'library.experience.resolve', 'library.template.list', 'library.annotation.list', 'library.annotation.effective', 'library.asset.history',
  'library.authoring.get', 'library.authoring.list', 'library.authoring.history', 'library.authoring.renderConfirmed', 'library.authoring.recordExport', 'library.authoring.export',
  'library.advisor.list', 'library.advisor.samples', 'library.advisor.regressions', 'library.advisor.history',
  'connections.list', 'conversion.status', 'conversion.settings', 'maintenance.status', 'maintenance.inspectBackup', 'maintenance.backup',
  'maintenance.diagnosticsStatus', 'maintenance.exportDiagnostics',
]);
const readonlyDesktop = new Set([
  'getState', 'getDocument', 'getDocumentView', 'listDocumentsPage', 'getDocumentBlocks', 'getDocumentReviews', 'getReview',
  'getChanges', 'listContractDrafts', 'getContractDraft', 'listEnterpriseStandards', 'getEnterpriseStandard', 'getRiskDispositions',
  'getKnowledgeState', 'getKnowledgeChunk', 'searchKnowledge', 'checkEnvironment',
  'exportReview', 'exportModified', 'exportContractDraft', 'openKnowledgeSource', 'openEvidenceSource',
  'cancelReview', 'cancelChangeDraft', 'cancelContractGeneration', 'cancelKnowledgeSync', 'cancelOfficialRetrieval',
]);
export const workspaceRequiresLicense = (action: string): boolean => !readonlyWorkspace.has(action);
export function desktopRequiresLicense(name: string, payload?: unknown): boolean {
  if (name === 'runWorkspaceCommand') return workspaceRequiresLicense(String((payload as { action?: unknown } | null)?.action ?? ''));
  return !readonlyDesktop.has(name);
}
