/** Admission is cooperative and serial; these types do not describe an RSS cap. */
export type ResourceKind = 'model' | 'heavy' | 'index';
export type ResourceOperation =
  | 'contract_review' | 'local_review' | 'contract_generation' | 'contract_change'
  | 'reference_translation' | 'report_translation' | 'clause_alignment'
  | 'model_probe' | 'connection_test' | 'knowledge_index' | 'knowledge_search'
  | 'document_import' | 'document_conversion' | 'report_render' | 'document_export'
  | 'native_pdf' | 'maintenance';
export type ResourcePressureLevel = 'normal' | 'warning' | 'critical' | 'unknown';
export interface ResourcePressure {
  level: ResourcePressureLevel;
  observedAt: string;
  source: 'macos' | 'windows' | 'unavailable' | 'test';
  availableBytes?: number | null;
  totalBytes?: number | null;
}
export interface ResourceTask {
  id: string;
  kind: ResourceKind;
  operation: ResourceOperation;
  queuedAt: string;
  startedAt: string;
  cancellationRequested: boolean;
}
export type ResourceWaitReason = 'active_task' | 'index_cleanup' | 'memory_critical' | 'memory_warning' | 'priority';
export interface ResourceQueuedTask {
  id: string;
  kind: ResourceKind;
  operation: ResourceOperation;
  queuedAt: string;
  waitReason: ResourceWaitReason;
}
export interface ResourceSnapshot {
  policy: 'serial-model-priority';
  closed: boolean;
  active: ResourceTask | null;
  queued: ResourceQueuedTask[];
  maxQueue: number;
  pressure: ResourcePressure & { effectiveLevel: ResourcePressureLevel; stale: boolean };
  limitations: string[];
}
