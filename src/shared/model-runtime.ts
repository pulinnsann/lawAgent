export type ModelCapability = 'unknown' | 'supported' | 'unsupported';
export interface ModelRuntimeSettings {
  capabilities: { streaming: ModelCapability; jsonSchema: ModelCapability; jsonObject: ModelCapability; usage: ModelCapability; contextWindowTokens: number | null };
  streaming: boolean;
  retry: { enabled: boolean; maxAttempts: number; statuses: number[]; baseDelayMs: number; maxDelayMs: number };
  budget: { maxCalls: number; maxTokens: number | null; maxCost: number | null };
  pricing: { currency: string; inputPerMillion: number | null; outputPerMillion: number | null };
}
export const defaultModelRuntimeSettings = (): ModelRuntimeSettings => ({
  capabilities: { streaming: 'unknown', jsonSchema: 'unknown', jsonObject: 'unknown', usage: 'unknown', contextWindowTokens: null }, streaming: false,
  retry: { enabled: false, maxAttempts: 1, statuses: [429, 503], baseDelayMs: 1000, maxDelayMs: 30000 },
  budget: { maxCalls: 128, maxTokens: null, maxCost: null }, pricing: { currency: 'CNY', inputPerMillion: null, outputPerMillion: null },
});
export interface PromptFingerprint {
  name: string; version: string; templateSha256: string; schemaSha256: string; inputSha256: string; requestSha256: string; inputBytes: number;
}
export interface ModelCallRecord {
  id: string; number: number; attempt: number; purpose: string; prompt: PromptFingerprint;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string; finishedAt: string | null; durationMs: number | null; httpStatus: number | null; errorCode: string | null;
  estimatedInputTokens: number; outputLimit: number; inputTokens: number | null; outputTokens: number | null;
  reservedTokens: number; accountedTokens: number; cost: number | null; reservedCost: number | null; retryDelayMs: number | null;
}
export interface ModelRunLedger {
  taskId: string; operation: string; documentId: string | null; reviewId: string | null; binding: string; model: string;
  configSnapshot?: { provider: string; endpoint: string; responseFormat: string; tokenParameter: string; maxOutputTokens: number; contextWindowTokens: number; timeoutSeconds: number };
  settings: ModelRuntimeSettings; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; startedAt: string; finishedAt: string | null;
  calls: ModelCallRecord[]; stages: Array<{ name: string; startedAt: string; durationMs: number }>;
  totals: { calls: number; inputTokens: number | null; outputTokens: number | null; accountedTokens: number; cost: number | null; currency: string; unknownUsageCalls: number };
  errorCode: string | null;
}
export interface ModelRuntimeProgress { phase: string; modelRuntime: { taskId: string; call: number; attempt: number; characters: number; preview: string; state: 'requesting' | 'streaming' | 'retry_wait' | 'completed'; retryDelayMs?: number } }
export interface ModelRuntimeSavedSettings { id: string | null; revision: number; binding: string; model: string; body: ModelRuntimeSettings }
