import type { ConnectionTestResult, ModelConfigInput } from '../shared/contracts';
import { executeTrackedCompletion, getModelRuntimeSettings, modelRuntimePreview, retryAfterMilliseconds } from './model-runtime';

export const MAX_MODEL_RESPONSE_BYTES = 2 * 1024 * 1024;

export class ModelRequestError extends Error {
  readonly httpStatus?: number;
  readonly retryAfterMs?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  constructor(public readonly code: string, message: string, details?: { httpStatus?: number; retryAfterMs?: number | null; inputTokens?: number | null; outputTokens?: number | null }) {
    super(message);
    this.name = code === 'CANCELLED' ? 'AbortError' : 'ModelRequestError';
    Object.assign(this, details);
  }
}

export interface CompletionRequest {
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  jsonSchema: { name: string; schema: Record<string, unknown> };
  maxOutputTokens?: number;
  /** Template version is independent of provider/model configuration. Only hashes are journaled. */
  promptVersion?: string;
  purpose?: string;
}

export interface CompletionResult {
  content: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

function invalidConfig(message: string): never {
  throw new ModelRequestError('VALIDATION_ERROR', message);
}

/** Validate without making a request or returning apiKey/clearApiKey. */
export function validateModelConfig(input: ModelConfigInput): ModelConfigInput {
  if (!input || typeof input !== 'object') invalidConfig('请先配置模型服务。');
  if (input.provider !== undefined && !['chat-completions', 'codex-cli'].includes(input.provider)) invalidConfig('模型连接方式无效。');
  const codex = input.provider === 'codex-cli';
  if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048) invalidConfig('模型服务地址无效。');
  const baseUrl = input.baseUrl.trim();
  let url: URL;
  try { url = new URL(baseUrl); } catch { invalidConfig('请输入完整的模型服务地址。'); }
  if (codex && baseUrl !== 'codex://local') invalidConfig('本机 Codex 连接入口无效。');
  if (url.username || url.password || baseUrl.includes('#')) invalidConfig('服务地址不能包含用户名、密码或片段。');
  for (const key of url.searchParams.keys()) {
    if (/key|token|secret|password|authorization|credential/i.test(key)) {
      invalidConfig('服务地址不能通过查询参数携带凭据，请使用独立的 API Key 设置。');
    }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!codex && url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    invalidConfig('远端模型服务必须使用 HTTPS；HTTP 仅允许本机回环地址。');
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) invalidConfig('请输入有效的配置名称。');
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200) invalidConfig('请输入有效的模型名称。');
  if (codex && !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(input.model.trim())) invalidConfig('Codex 模型名称只能包含字母、数字、点、冒号、下划线、斜杠和连字符。');
  if (codex && (input.apiKey?.trim() || input.clearApiKey)) invalidConfig('本机 Codex 使用自己的登录状态，请勿传入或清除 API 密钥。');
  if (!['json_schema', 'json_object', 'text'].includes(input.responseFormat)) invalidConfig('结构化输出设置无效。');
  if (!['max_tokens', 'max_completion_tokens'].includes(input.tokenParameter)) invalidConfig('Token 参数设置无效。');
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 262144) invalidConfig('输出 Token 上限无效。');
  if (!Number.isSafeInteger(input.contextWindowTokens) || input.contextWindowTokens < 256 || input.contextWindowTokens > 2000000 || input.maxOutputTokens >= input.contextWindowTokens) invalidConfig('上下文上限必须大于输出 Token 上限。');
  if (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds < 0.05 || input.timeoutSeconds > 600) invalidConfig('请求超时应在 0.05 到 600 秒之间。');
  return {
    ...(input.provider ? { provider: input.provider } : {}),
    name: input.name.trim(), baseUrl: url.toString(), model: input.model.trim(),
    responseFormat: codex ? 'json_schema' : input.responseFormat, tokenParameter: codex ? 'max_tokens' : input.tokenParameter,
    maxOutputTokens: input.maxOutputTokens, contextWindowTokens: input.contextWindowTokens,
    timeoutSeconds: input.timeoutSeconds,
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return url.toString();
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_MODEL_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ModelRequestError('RESPONSE_TOO_LARGE', '模型响应超过大小上限，请减少输出内容。');
  }
  if (!response.body) throw new ModelRequestError('MODEL_RESPONSE_INVALID', '模型服务未返回有效响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_MODEL_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ModelRequestError('RESPONSE_TOO_LARGE', '模型响应超过大小上限，请减少输出内容。');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

/** Default remains one request. Explicit runtime policy is required for bounded HTTP retries. */
export async function requestCompletion(
  input: ModelConfigInput,
  apiKey: string | null,
  request: CompletionRequest,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const config = validateModelConfig(input);
  return executeTrackedCompletion(config, request, apiKey, signal, () => requestCompletionOnce(config, apiKey, request, signal));
}

/** Bounded SSE parser. A valid final marker is required; partial content never becomes a success. */
export async function readModelEventStream(response: Response): Promise<CompletionResult> {
  if (!response.body) throw new ModelRequestError('MODEL_RESPONSE_INVALID', '流式服务未返回响应正文。');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let pending = ''; let searchFrom = 0; let bytes = 0; let content = ''; let model = ''; let done = false; let finish: string | null = null;
  let inputTokens: number | null = null; let outputTokens: number | null = null; let lastPreview = 0;
  const fail = (code: string, message: string): never => { throw new ModelRequestError(code, message, { inputTokens, outputTokens }); };
  const event = (block: string) => {
    if (Buffer.byteLength(block) > 256 * 1024) fail('RESPONSE_TOO_LARGE', '单个模型流式事件超过256 KiB上限。');
    const data = block.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
    if (!data) return; if (done) fail('MODEL_STREAM_INVALID', '流式结束标记后仍返回数据，未保存为成功。');
    if (data.trim() === '[DONE]') { done = true; return; }
    let parsed: any; try { parsed = JSON.parse(data); } catch { fail('MODEL_STREAM_INVALID', '模型流式事件不是有效JSON。'); }
    if (!parsed || typeof parsed !== 'object' || parsed.error) fail('MODEL_STREAM_INVALID', '模型流式服务返回错误事件。');
    if (typeof parsed.model === 'string') model = parsed.model.slice(0, 200);
    if (parsed.usage) { inputTokens = tokenCount(parsed.usage.prompt_tokens); outputTokens = tokenCount(parsed.usage.completion_tokens); }
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    if (choice?.finish_reason === 'length') fail('MODEL_OUTPUT_TRUNCATED', '模型流式输出达到上限，结果不完整。');
    if (choice?.finish_reason) finish = String(choice.finish_reason);
    if (choice?.delta?.tool_calls || choice?.delta?.function_call) fail('MODEL_STREAM_INVALID', '模型返回了未允许的工具调用。');
    if (choice?.delta?.content !== undefined && choice.delta.content !== null && typeof choice.delta.content !== 'string') fail('MODEL_STREAM_INVALID', '流式内容格式不受支持。');
    if (typeof choice?.delta?.content === 'string') {
      content += choice.delta.content;
      if (Buffer.byteLength(content) > MAX_MODEL_RESPONSE_BYTES) fail('RESPONSE_TOO_LARGE', '模型流式内容超过大小上限。');
      if (performance.now() - lastPreview >= 100) { modelRuntimePreview(content); lastPreview = performance.now(); }
    }
  };
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > MAX_MODEL_RESPONSE_BYTES) fail('RESPONSE_TOO_LARGE', '模型流式响应超过大小上限。');
      pending += decoder.decode(part.value, { stream: true });
      let boundary: RegExpExecArray | null; const separator = /\r?\n\r?\n/gu; separator.lastIndex = searchFrom;
      while ((boundary = separator.exec(pending))) { event(pending.slice(0, boundary.index)); pending = pending.slice(boundary.index + boundary[0].length); separator.lastIndex = 0; }
      searchFrom = Math.max(0, pending.length - 3);
      if (pending.length > 256 * 1024) fail('RESPONSE_TOO_LARGE', '未结束的模型流式事件超过大小上限。');
      // Some compatible services keep the HTTP body open for heartbeats after
      // [DONE]. The explicit protocol end is sufficient; release that reader.
      if (done) { await reader.cancel().catch(() => {}); break; }
    }
    pending += decoder.decode(); if (pending.trim()) event(pending);
    if (!done || finish !== 'stop' || !content.trim()) fail('MODEL_STREAM_INCOMPLETE', '模型流式响应未完整结束，未保存为成功；不会自动重复付费。');
    modelRuntimePreview(content); return { content, model, inputTokens, outputTokens };
  } catch (error) { await reader.cancel().catch(() => {}); if (error instanceof ModelRequestError) throw error; throw new ModelRequestError('MODEL_STREAM_INTERRUPTED', '模型流式连接中断，未保存为完整结果。', { inputTokens, outputTokens }); }
  finally { reader.releaseLock(); }
}

async function requestCompletionOnce(config: ModelConfigInput, apiKey: string | null, request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
  if (signal?.aborted) throw new ModelRequestError('CANCELLED', '请求已取消。');
  if (config.provider === 'codex-cli') {
    const { requestCodexCompletion } = await import('./codex-model');
    return requestCodexCompletion(config, request, signal);
  }
  const controller = new AbortController();
  let timedOut = false;
  const cancel = (): void => { controller.abort(); };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutSeconds * 1000);
  const runtime = getModelRuntimeSettings();
  const streaming = runtime?.streaming === true && runtime.capabilities.streaming === 'supported';
  const body: Record<string, unknown> = {
    model: config.model, messages: request.messages, stream: streaming,
    [config.tokenParameter]: Math.min(request.maxOutputTokens ?? config.maxOutputTokens, config.maxOutputTokens),
  };
  if (streaming && runtime?.capabilities.usage === 'supported') body.stream_options = { include_usage: true };
  if (config.responseFormat === 'json_object') body.response_format = { type: 'json_object' };
  if (config.responseFormat === 'json_schema') body.response_format = {
    type: 'json_schema', json_schema: { name: request.jsonSchema.name, strict: true, schema: request.jsonSchema.schema },
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: streaming ? 'text/event-stream' : 'application/json' };
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  try {
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      const description = response.status === 401 || response.status === 403
        ? '模型服务拒绝认证，请检查 API Key 与访问权限。'
        : response.status === 429 ? '模型服务当前限流，请稍后手动重试。' : `模型服务请求失败（HTTP ${response.status}）。`;
      throw new ModelRequestError('MODEL_HTTP_ERROR', description, { httpStatus: response.status, retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')) });
    }
    if (streaming) {
      if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) { await response.body?.cancel(); throw new ModelRequestError('MODEL_STREAM_UNSUPPORTED', '服务没有返回所声明的SSE流式响应；请关闭流式后手动重跑，未自动回退重复调用。'); }
      const result = await readModelEventStream(response); return { ...result, model: result.model || config.model };
    }
    const raw = await readBoundedResponse(response);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new ModelRequestError('MODEL_RESPONSE_INVALID', '模型服务返回的响应不是有效 JSON。'); }
    const envelope = object(parsed);
    const choices = envelope?.choices;
    const choice = Array.isArray(choices) ? object(choices[0]) : null;
    const usage = object(envelope?.usage);
    const knownUsage = { inputTokens: tokenCount(usage?.prompt_tokens), outputTokens: tokenCount(usage?.completion_tokens) };
    const message = object(choice?.message);
    if (choice?.finish_reason === 'length') throw new ModelRequestError('MODEL_OUTPUT_TRUNCATED', '模型输出达到上限，审核结果不完整；请调整输出上限后手动重试。', knownUsage);
    if (typeof message?.content !== 'string' || !message.content.trim()) throw new ModelRequestError('MODEL_RESPONSE_INVALID', '模型未返回可用文本，可能拒绝了请求或接口不兼容。', knownUsage);
    return {
      content: message.content,
      model: typeof envelope?.model === 'string' && envelope.model.length <= 200 ? envelope.model : config.model,
      ...knownUsage,
    };
  } catch (error) {
    const knownUsage = error instanceof ModelRequestError ? { inputTokens: error.inputTokens, outputTokens: error.outputTokens } : {};
    if (signal?.aborted) throw new ModelRequestError('CANCELLED', '请求已取消。', knownUsage);
    if (timedOut) throw new ModelRequestError('TIMEOUT', '模型请求超时，未自动重试。', knownUsage);
    if (error instanceof ModelRequestError) throw error;
    throw new ModelRequestError('MODEL_NETWORK_ERROR', '无法连接模型服务；请检查地址、网络及重定向设置。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function testConnection(config: ModelConfigInput, apiKey: string | null, signal?: AbortSignal): Promise<ConnectionTestResult> {
  const started = performance.now();
  const result = await requestCompletion(config, apiKey, {
    messages: [
      { role: 'system', content: 'Perform a minimal API connectivity test. Return JSON only: {"ok":true}.' },
      { role: 'user', content: 'Return the JSON object {"ok":true}.' },
    ],
    jsonSchema: { name: 'connection_test', schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
    maxOutputTokens: Math.min(256, config.maxOutputTokens),
  }, signal);
  let output: Record<string, unknown> | null;
  try {
    const content = config.responseFormat === 'text'
      ? result.content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1') : result.content;
    output = object(JSON.parse(content));
  } catch { throw new ModelRequestError('MODEL_OUTPUT_INVALID', 'API 已响应，但最小 JSON 输出测试未通过；未自动切换格式或重试。'); }
  if (output?.ok !== true) throw new ModelRequestError('MODEL_OUTPUT_INVALID', 'API 已响应，但最小 JSON 输出测试未通过；请检查模型与输出设置。');
  return { model: result.model, latencyMs: Math.round(performance.now() - started), message: config.provider === 'codex-cli' ? 'Codex 已完成真实连接测试；合同审核质量仍需法务复核。' : 'API 调用成功；此测试不代表合同审核质量已验证。' };
}
