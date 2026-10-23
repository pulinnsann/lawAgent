import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { ModelConfigInput } from '../shared/contracts';
import { defaultModelRuntimeSettings, type ModelRuntimeSettings, type ModelRuntimeSavedSettings, type ModelRunLedger, type ModelCallRecord, type PromptFingerprint, type ModelRuntimeProgress } from '../shared/model-runtime';
import type { WorkspaceAsset, WorkspaceAssets } from './workspace-assets';
import type { CompletionRequest, CompletionResult } from './model';

const cap = z.enum(['unknown', 'supported', 'unsupported']);
const nullablePrice = z.number().finite().min(0).max(1000000).nullable();
const settingsSchema = z.object({
  capabilities: z.object({ streaming: cap, jsonSchema: cap, jsonObject: cap, usage: cap, contextWindowTokens: z.number().int().min(256).max(2000000).nullable() }).strict(),
  streaming: z.boolean(), retry: z.object({ enabled: z.boolean(), maxAttempts: z.number().int().min(1).max(4), statuses: z.array(z.union([z.literal(429), z.literal(502), z.literal(503), z.literal(504)])).max(4), baseDelayMs: z.number().int().min(10).max(60000), maxDelayMs: z.number().int().min(10).max(60000) }).strict(),
  budget: z.object({ maxCalls: z.number().int().min(1).max(256), maxTokens: z.number().int().min(1).max(100000000).nullable(), maxCost: z.number().finite().positive().max(1000000).nullable() }).strict(),
  pricing: z.object({ currency: z.string().regex(/^[A-Z]{3}$/u), inputPerMillion: nullablePrice, outputPerMillion: nullablePrice }).strict(),
}).strict().refine(s => s.retry.baseDelayMs <= s.retry.maxDelayMs, '重试初始等待不得超过最大等待。').refine(s => !s.streaming || s.capabilities.streaming === 'supported', '启用流式前请声明或探测该能力。').refine(s => s.budget.maxCost === null || s.pricing.inputPerMillion !== null && s.pricing.outputPerMillion !== null, '设置金额预算前请填写两种Token单位价格；未知价格不能当作零。');
export const normalizeModelRuntimeSettings = (input: unknown): ModelRuntimeSettings => settingsSchema.parse(input);
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const textKey = (value: string, fallback: string) => /^[a-zA-Z0-9_.:-]{1,120}$/u.test(value) ? value : fallback;
export const modelRuntimeBinding = (config: ModelConfigInput) => hash({ provider: config.provider ?? 'chat-completions', baseUrl: config.baseUrl.replace(/\/+$/u, ''), model: config.model });
export class ModelRuntimeError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = code === 'CANCELLED' ? 'AbortError' : 'ModelRuntimeError'; } }

/** Hash actual templates and inputs separately. No prompt text, key or model output is persisted. */
export function capturePrompt(request: CompletionRequest): PromptFingerprint {
  const name = textKey(request.jsonSchema.name, 'model_request'); const version = textKey(request.promptVersion ?? `${name}:v1`, `${name}:v1`);
  const template = request.messages.filter(message => message.role === 'system'); const input = request.messages.filter(message => message.role !== 'system');
  return { name, version, templateSha256: hash(template), schemaSha256: hash(request.jsonSchema.schema), inputSha256: hash(input), requestSha256: hash({ messages: request.messages, schema: request.jsonSchema }), inputBytes: Buffer.byteLength(JSON.stringify({ messages: request.messages, schema: request.jsonSchema })) };
}
export const recordPrompt = capturePrompt;
export const estimateCompletionInputTokens = (request: Pick<CompletionRequest, 'messages' | 'jsonSchema'>) => Buffer.byteLength(JSON.stringify({ messages: request.messages, schema: request.jsonSchema })) + 512;
export const effectiveModelContextLimit = (config: ModelConfigInput) => Math.min(config.contextWindowTokens, scope.getStore()?.body.settings.capabilities.contextWindowTokens ?? config.contextWindowTokens);
function readSettings(assets: WorkspaceAssets, config: ModelConfigInput): ModelRuntimeSavedSettings {
  const binding = modelRuntimeBinding(config); const current = assets.list('model_runtime_settings').find(asset => asset.body.binding === binding);
  return { id: current?.id ?? null, revision: current?.revision ?? 0, binding, model: config.model, body: current ? normalizeModelRuntimeSettings(current.body.settings) : defaultModelRuntimeSettings() };
}
export interface ModelRuntimeOptions { assets: WorkspaceAssets; config: ModelConfigInput; taskId: string; operation: string; documentId?: string | null; reviewId?: string | null; signal?: AbortSignal; onProgress?: (progress: ModelRuntimeProgress) => void; secrets?: string[]; settings?: ModelRuntimeSettings }
interface RuntimeContext { options: ModelRuntimeOptions; body: ModelRunLedger; asset: WorkspaceAsset; queue: Promise<unknown>; stageStart: number; stage: string; secrets: Set<string> }
const scope = new AsyncLocalStorage<RuntimeContext>();
const callScope = new AsyncLocalStorage<boolean>();
const activeRuns = new Set<string>();
function clean(value: string, secrets: Iterable<string>): string { let safe = value; for (const secret of secrets) if (secret) safe = safe.split(secret).join('[已隐藏凭据]'); return safe; }
function totals(body: ModelRunLedger) {
  const calls = body.calls; const count = (field: 'inputTokens' | 'outputTokens') => calls.every(call => call[field] !== null) ? calls.reduce((n, call) => n + call[field]!, 0) : null;
  body.totals = { calls: calls.length, inputTokens: count('inputTokens'), outputTokens: count('outputTokens'), accountedTokens: calls.reduce((n, call) => n + call.accountedTokens, 0), cost: calls.every(call => call.cost !== null) ? calls.reduce((n, call) => n + call.cost!, 0) : null, currency: body.settings.pricing.currency, unknownUsageCalls: calls.filter(call => call.inputTokens === null || call.outputTokens === null).length };
}
async function persist(ctx: RuntimeContext) { totals(ctx.body); ctx.asset = await ctx.options.assets.save({ id: ctx.asset.id, kind: 'model_runtime_run', expectedRevision: ctx.asset.revision, body: ctx.body, actorLabel: '模型运行记录' }); }
function serial<T>(ctx: RuntimeContext, fn: () => Promise<T>): Promise<T> { const work = ctx.queue.then(fn, fn); ctx.queue = work.catch(() => {}); return work; }
export function recordModelStage(name: string): void {
  const ctx = scope.getStore(); if (!ctx) return;
  const now = performance.now(); ctx.body.stages.push({ name: ctx.stage, startedAt: new Date(Date.now() - (now - ctx.stageStart)).toISOString(), durationMs: Math.max(0, Math.round(now - ctx.stageStart)) });
  ctx.body.stages = ctx.body.stages.slice(-500); ctx.stageStart = now; ctx.stage = clean(name, ctx.secrets).replace(/[\u0000-\u001f]/gu, '').slice(0, 120) || '处理';
}
export async function withModelRuntime<T>(options: ModelRuntimeOptions, operation: () => Promise<T>): Promise<T> {
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/u.test(options.taskId)) throw new ModelRuntimeError('RUNTIME_TASK_INVALID', '模型任务标识无效。');
  const settings = normalizeModelRuntimeSettings(options.settings ?? readSettings(options.assets, options.config).body);
  const providedSecrets = options.secrets?.filter(Boolean) ?? [];
  const body: ModelRunLedger = { taskId: clean(options.taskId, providedSecrets), operation: textKey(options.operation, 'model'), documentId: options.documentId ? clean(options.documentId, providedSecrets) : null, reviewId: options.reviewId ? clean(options.reviewId, providedSecrets) : null, binding: modelRuntimeBinding(options.config), model: clean(options.config.model, providedSecrets), settings, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, calls: [], stages: [], totals: { calls: 0, inputTokens: 0, outputTokens: 0, accountedTokens: 0, cost: null, currency: settings.pricing.currency, unknownUsageCalls: 0 }, errorCode: null };
  const endpoint = new URL(options.config.baseUrl); endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = '';
  body.configSnapshot = { provider: options.config.provider ?? 'chat-completions', endpoint: clean(endpoint.toString(), providedSecrets), responseFormat: options.config.responseFormat, tokenParameter: options.config.tokenParameter, maxOutputTokens: options.config.maxOutputTokens, contextWindowTokens: options.config.contextWindowTokens, timeoutSeconds: options.config.timeoutSeconds };
  const asset = await options.assets.save({ kind: 'model_runtime_run', expectedRevision: 0, body, actorLabel: '模型运行记录' });
  activeRuns.add(asset.id);
  const ctx: RuntimeContext = { options, body, asset, queue: Promise.resolve(), stageStart: performance.now(), stage: '准备', secrets: new Set(options.secrets?.filter(Boolean) ?? []) };
  return scope.run(ctx, async () => {
    try { options.signal?.throwIfAborted(); const result = await operation(); options.signal?.throwIfAborted(); body.status = 'completed'; return result; }
    catch (error) { const aborted = options.signal?.aborted || (error as any)?.code === 'CANCELLED' || (error as any)?.name === 'AbortError'; body.status = aborted ? 'cancelled' : 'failed'; body.errorCode = textKey(String((error as any)?.code ?? (aborted ? 'CANCELLED' : 'TASK_FAILED')), 'TASK_FAILED'); throw error; }
    finally { recordModelStage('完成'); body.finishedAt = new Date().toISOString(); try { await serial(ctx, () => persist(ctx)); } finally { activeRuns.delete(asset.id); } }
  });
}
export function getModelRuntimeSettings(): ModelRuntimeSettings | null { return scope.getStore()?.body.settings ?? null; }
export function modelRuntimePreview(content: string, characters = content.length): void {
  const ctx = scope.getStore(); const call = ctx?.body.calls.at(-1); if (!ctx || !call) return;
  let preview = clean(content.slice(0, 800), ctx.secrets);
  for (const secret of ctx.secrets) { for (let length = Math.min(secret.length - 1, preview.length); length >= 3; length--) { if (preview.endsWith(secret.slice(0, length))) { preview = `${preview.slice(0, -length)}[凭据片段已隐藏]`; break; } } }
  ctx.options.onProgress?.({ phase: '正在接收模型输出（尚未校验）', modelRuntime: { taskId: ctx.body.taskId, call: call.number, attempt: call.attempt, characters, preview, state: 'streaming' } });
}
function price(settings: ModelRuntimeSettings, input: number, output: number): number | null { const p = settings.pricing; return p.inputPerMillion === null || p.outputPerMillion === null ? null : (input * p.inputPerMillion + output * p.outputPerMillion) / 1000000; }
export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | null { if (!value) return null; if (/^\d+(?:\.\d+)?$/u.test(value.trim())) return Math.ceil(Number(value) * 1000); const parsed = Date.parse(value); return Number.isFinite(parsed) ? Math.max(0, parsed - now) : null; }

/** Every dispatched attempt is durably reserved first. Unknown usage retains a conservative reservation, never zero. */
export async function executeTrackedCompletion(config: ModelConfigInput, request: CompletionRequest, apiKey: string | null, signal: AbortSignal | undefined, once: () => Promise<CompletionResult>): Promise<CompletionResult> {
  const ctx = scope.getStore(); if (!ctx || callScope.getStore()) return once(); if (apiKey?.trim()) { ctx.secrets.add(apiKey.trim()); ctx.body.model = clean(ctx.body.model, ctx.secrets); if (ctx.body.configSnapshot) ctx.body.configSnapshot.endpoint = clean(ctx.body.configSnapshot.endpoint, ctx.secrets); }
  if (ctx.body.binding !== modelRuntimeBinding(config)) throw new ModelRuntimeError('MODEL_BINDING_CHANGED', '任务使用的模型与冻结运行策略不一致，未发送请求。');
  const settings = ctx.body.settings; const fingerprint = capturePrompt(request); const estimatedInput = estimateCompletionInputTokens(request); const outputLimit = Math.min(request.maxOutputTokens ?? config.maxOutputTokens, config.maxOutputTokens);
  const contextLimit = Math.min(config.contextWindowTokens, settings.capabilities.contextWindowTokens ?? config.contextWindowTokens);
  if (estimatedInput + outputLimit > contextLimit) throw new ModelRuntimeError('RUNTIME_CONTEXT_LIMIT', '请求超过已声明服务上下文，未发送模型请求。');
  if (config.provider !== 'codex-cli' && settings.capabilities[config.responseFormat === 'json_schema' ? 'jsonSchema' : 'jsonObject'] === 'unsupported' && config.responseFormat !== 'text') throw new ModelRuntimeError('MODEL_CAPABILITY_UNSUPPORTED', '当前模型声明不支持所选结构化格式，请调整配置后重试。');
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted(); ctx.options.signal?.throwIfAborted();
    const call = await serial(ctx, async () => {
      const usedTokens = ctx.body.calls.reduce((n, item) => n + item.accountedTokens, 0); const reservedTokens = estimatedInput + outputLimit; const costBound = price(settings, estimatedInput, outputLimit);
      const spentBound = ctx.body.calls.reduce((n, item) => n + (item.cost ?? item.reservedCost ?? 0), 0);
      if (ctx.body.calls.length >= settings.budget.maxCalls || settings.budget.maxTokens !== null && usedTokens + reservedTokens > settings.budget.maxTokens || settings.budget.maxCost !== null && (costBound === null || spentBound + costBound > settings.budget.maxCost)) throw new ModelRuntimeError('TASK_BUDGET_EXCEEDED', '本次任务调用／Token／费用预算不足，已在下一次请求前停止；已完成调用记录保留。');
      const item: ModelCallRecord = { id: randomUUID(), number: ctx.body.calls.length + 1, attempt, purpose: textKey(request.purpose ?? request.jsonSchema.name, 'model'), prompt: fingerprint, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, httpStatus: null, errorCode: null, estimatedInputTokens: estimatedInput, outputLimit, inputTokens: null, outputTokens: null, reservedTokens, accountedTokens: reservedTokens, cost: null, reservedCost: costBound, retryDelayMs: null };
      ctx.body.calls.push(item); await persist(ctx); return item;
    });
    const start = performance.now(); let failure: any;
    ctx.options.onProgress?.({ phase: '正在请求模型', modelRuntime: { taskId: ctx.body.taskId, call: call.number, attempt, characters: 0, preview: '', state: 'requesting' } });
    try { const result = await callScope.run(true, once); call.inputTokens = result.inputTokens; call.outputTokens = result.outputTokens; signal?.throwIfAborted(); ctx.options.signal?.throwIfAborted(); await serial(ctx, async () => { call.status = 'succeeded'; }); return result; }
    catch (error) { failure = error; call.status = signal?.aborted || ctx.options.signal?.aborted || (error as any)?.code === 'CANCELLED' || (error as any)?.name === 'AbortError' ? 'cancelled' : 'failed'; call.errorCode = textKey(String((error as any)?.code ?? 'MODEL_REQUEST_FAILED'), 'MODEL_REQUEST_FAILED'); call.httpStatus = Number.isInteger((error as any)?.httpStatus) ? (error as any).httpStatus : null; if (Number.isSafeInteger((error as any)?.inputTokens)) call.inputTokens = (error as any).inputTokens; if (Number.isSafeInteger((error as any)?.outputTokens)) call.outputTokens = (error as any).outputTokens; }
    finally { await serial(ctx, async () => { call.finishedAt = new Date().toISOString(); call.durationMs = Math.round(performance.now() - start); call.accountedTokens = call.inputTokens !== null && call.outputTokens !== null ? call.inputTokens + call.outputTokens : call.reservedTokens; call.cost = call.inputTokens !== null && call.outputTokens !== null ? price(settings, call.inputTokens, call.outputTokens) : null; await persist(ctx); }); }
    const retry = settings.retry;
    if (call.status === 'cancelled' || !retry.enabled || attempt >= retry.maxAttempts || call.httpStatus === null || !retry.statuses.includes(call.httpStatus) || config.provider === 'codex-cli') throw failure;
    const after = typeof failure.retryAfterMs === 'number' && Number.isFinite(failure.retryAfterMs) ? failure.retryAfterMs : null;
    const wait = Math.max(retry.baseDelayMs * 2 ** (attempt - 1), after ?? 0);
    if (wait > retry.maxDelayMs) throw new ModelRuntimeError('RETRY_AFTER_EXCEEDS_LIMIT', '服务要求的重试等待超过用户上限，未提前重试；请稍后手动重跑。');
    call.retryDelayMs = wait; await serial(ctx, () => persist(ctx));
    ctx.options.onProgress?.({ phase: '按用户策略等待后重试', modelRuntime: { taskId: ctx.body.taskId, call: call.number, attempt, characters: 0, preview: '', state: 'retry_wait', retryDelayMs: wait } });
    try { await delay(wait, undefined, { signal: signal ?? ctx.options.signal }); } catch { throw new ModelRuntimeError('CANCELLED', '等待重试时已取消，未派发新请求。'); }
  }
}

const settingsQueues = new WeakMap<WorkspaceAssets, Promise<unknown>>();
/** Invoke once before accepting work after process startup; no paid call is resumed. */
export async function recoverModelRuntimeRuns(assets: WorkspaceAssets): Promise<number> {
  let recovered = 0;
  for (const asset of assets.list('model_runtime_run')) {
    if (activeRuns.has(asset.id) || asset.body.status !== 'running') continue;
    const body = structuredClone(asset.body) as ModelRunLedger; body.status = 'interrupted'; body.finishedAt = new Date().toISOString(); body.errorCode = 'INTERRUPTED';
    for (const call of body.calls) if (call.status === 'running') { call.status = 'interrupted'; call.finishedAt = body.finishedAt; call.durationMs = Math.max(0, Date.parse(body.finishedAt) - Date.parse(call.startedAt)); call.errorCode = 'INTERRUPTED'; }
    totals(body); await assets.save({ id: asset.id, kind: asset.kind, expectedRevision: asset.revision, body, actorLabel: '中断恢复' }); recovered++;
  }
  return recovered;
}
export async function runModelRuntimeCommand(action: string, payload: unknown, deps: { assets: WorkspaceAssets; config: ModelConfigInput | null; apiKey?: string | null; signal?: AbortSignal; onProgress?: (value: ModelRuntimeProgress) => void }): Promise<unknown> {
  const p = payload ?? {};
  if (action === 'modelRuntime.ledger.list') { const query = z.object({ taskId: z.string().max(160).optional(), limit: z.number().int().min(1).max(200).default(50) }).strict().parse(p); return deps.assets.list('model_runtime_run').filter(asset => !query.taskId || asset.body.taskId === query.taskId).slice(0, query.limit).map(asset => ({ ...asset, effectiveStatus: asset.body.status === 'running' && !activeRuns.has(asset.id) ? 'interrupted' : asset.body.status })); }
  if (action === 'modelRuntime.ledger.get') { const { id } = z.object({ id: z.string().uuid() }).strict().parse(p); const asset = deps.assets.get(id); if (asset.kind !== 'model_runtime_run') throw new Error('记录类型不匹配。'); return asset; }
  if (!deps.config) throw new Error('请先保存模型配置。'); const config = deps.config;
  if (action === 'modelRuntime.settings.get') { z.object({}).strict().parse(p); return readSettings(deps.assets, config); }
  if (action === 'modelRuntime.settings.save') {
    const input = z.object({ id: z.string().uuid().optional(), expectedRevision: z.number().int().min(0), body: settingsSchema }).strict().parse(p);
    const previous = settingsQueues.get(deps.assets) ?? Promise.resolve(); const work = previous.then(async () => { const current = readSettings(deps.assets, config); if (current.id !== (input.id ?? null) || current.revision !== input.expectedRevision) throw new Error('模型运行配置已更新，请刷新后重试。'); await deps.assets.save({ id: input.id, kind: 'model_runtime_settings', expectedRevision: input.expectedRevision, body: { binding: current.binding, settings: input.body }, actorLabel: '模型运行配置' }); return readSettings(deps.assets, config); }); settingsQueues.set(deps.assets, work.catch(() => {})); return work;
  }
  if (action === 'modelRuntime.probe') {
    const input = z.object({ confirmed: z.literal(true), capability: z.enum(['streaming', 'jsonSchema', 'jsonObject', 'usage']) }).strict().parse(p);
    const current = readSettings(deps.assets, config); const { requestCompletion } = await import('./model');
    if (config.provider === 'codex-cli' && input.capability === 'streaming') throw new Error('Codex使用本机事件协议，不能探测HTTP流式能力。');
    const settings = structuredClone(current.body); settings.retry = { ...settings.retry, enabled: false }; settings.budget.maxCalls = 1;
    if (input.capability === 'streaming') { settings.capabilities.streaming = 'supported'; settings.streaming = true; }
    if (input.capability === 'jsonSchema' || input.capability === 'jsonObject') settings.capabilities[input.capability] = 'unknown';
    const probeConfig = { ...config, responseFormat: input.capability === 'jsonSchema' ? 'json_schema' as const : input.capability === 'jsonObject' ? 'json_object' as const : 'text' as const, maxOutputTokens: Math.min(config.maxOutputTokens, 128) };
    const result = await withModelRuntime({ assets: deps.assets, config: probeConfig, taskId: randomUUID(), operation: 'capability_probe', settings, signal: deps.signal, onProgress: deps.onProgress, secrets: [deps.apiKey ?? ''] }, () => requestCompletion(probeConfig, deps.apiKey ?? null, { purpose: 'capability_probe', promptVersion: 'capability-probe-v1', messages: [{ role: 'system', content: 'Return only the JSON object {"ok":true}.' }, { role: 'user', content: 'Synthetic capability test. Return {"ok":true}.' }], jsonSchema: { name: 'model_capability_probe', schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] } } }, deps.signal));
    let valid = false; try { valid = JSON.parse(result.content).ok === true; } catch { /* Failed tests never silently enable capabilities. */ }
    if (!valid) throw new Error('模型已响应，但能力探测结果未通过JSON核验；调用台账已保存。');
    return { capability: input.capability, supported: input.capability === 'usage' ? result.inputTokens !== null && result.outputTokens !== null : true, testedAt: new Date().toISOString(), binding: current.binding, message: '此为一次显式最小调用，未自动更改设置；上下文最大值无法由小探测推断。' };
  }
  throw new Error('未知模型运行操作。');
}
