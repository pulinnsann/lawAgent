import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

export class RetrievalError extends Error {
  constructor(public readonly code: 'failed' | 'timeout' | 'cancelled', message: string) { super(message); this.name = 'RetrievalError'; }
}
export interface ResolvedAddress { address: string; family: number }
export interface HttpResult { body: Buffer; contentType: string; fetchedAt: string; headers?: Record<string, string> }
export interface PinnedRequest {
  address: ResolvedAddress; method: 'GET' | 'POST'; headers: Record<string, string>;
  body: string | null; signal: AbortSignal; maxBytes: number;
}
export interface HttpDependencies {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  transport(url: URL, request: PinnedRequest): Promise<HttpResult>;
}

const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as Array<[string, number]>) denied.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::',32],['2001:2::',48],['2001:db8::',32],['2001:10::',28],['2001:20::',28],['2002::',16],['3fff::',20]] as Array<[string, number]>) denied.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !denied.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}

export function parseNetworkUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RetrievalError('failed', '检索地址不是有效的 URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new RetrievalError('failed', '检索地址仅允许无内嵌凭据的 HTTP/HTTPS 地址。');
  for (const key of url.searchParams.keys()) if (/key|token|secret|password|authorization|credential/i.test(key)) throw new RetrievalError('failed', '来源地址不能在查询参数中携带凭据。');
  return url;
}

function abortError(signal: AbortSignal): RetrievalError {
  return signal.reason instanceof RetrievalError ? signal.reason : new RetrievalError('cancelled', '检索已取消。');
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(abortError(signal)); signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([work, cancelled]); } finally { signal.removeEventListener('abort', cancel); }
}

/** Connect to the already-validated address. No second DNS lookup, proxy, redirect or cookie jar. */
async function transport(url: URL, input: PinnedRequest): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: input.method, headers: input.headers, agent: false, signal: input.signal,
      family: input.address.family,
      lookup: (_host, _options, callback) => callback(null, input.address.address, input.address.family),
    }, response => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume(); response.destroy();
        reject(new RetrievalError('failed', response.statusCode && response.statusCode >= 300 && response.statusCode < 400 ? '检索服务或来源返回重定向，未跟随。' : `检索请求失败（HTTP ${response.statusCode ?? '未知'}），未读取错误正文。`));
        return;
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.destroy(); reject(new RetrievalError('failed', '来源未遵守 identity 编码要求，未读取压缩正文。')); return;
      }
      if (Number(response.headers['content-length']) > input.maxBytes) {
        response.destroy(); reject(new RetrievalError('failed', '检索响应超过资源上限。')); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > input.maxBytes) { response.destroy(); reject(new RetrievalError('failed', '检索响应超过资源上限。')); }
        else chunks.push(chunk);
      });
      response.on('error', () => reject(input.signal.aborted ? abortError(input.signal) : new RetrievalError('failed', '检索响应中断，未取得完整内容。')));
      response.on('end', () => resolve({ body: Buffer.concat(chunks), contentType: String(response.headers['content-type'] ?? ''), fetchedAt: new Date().toISOString(), headers: Object.fromEntries(Object.entries(response.headers).map(([key,value]) => [key, String(value ?? '')])) }));
    });
    request.on('error', () => reject(input.signal.aborted ? abortError(input.signal) : new RetrievalError('failed', '无法连接检索服务或来源；未回显服务响应或认证信息。')));
    if (input.body !== null) request.write(input.body);
    request.end();
  });
}

/** Dependency injection is for isolated transport tests; production always uses the defaults. Address checks cannot be disabled. */
export function createRetrievalHttp(overrides: Partial<HttpDependencies> = {}) {
  const dependencies: HttpDependencies = { resolve: hostname => lookup(hostname, { all: true, verbatim: true }), transport, ...overrides };
  async function send(urlString: string, input: { publicPage: boolean; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; signal: AbortSignal; timeoutSeconds: number }): Promise<HttpResult> {
    const url = parseNetworkUrl(urlString);
    if (input.publicPage && url.protocol !== 'https:') throw new RetrievalError('failed', '公开网页仅允许 HTTPS。');
    const controller = new AbortController();
    const cancel = () => controller.abort(new RetrievalError('cancelled', '检索已取消。'));
    input.signal.addEventListener('abort', cancel, { once: true });
    if (input.signal.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new RetrievalError('timeout', '检索超时，未自动重试。')), input.timeoutSeconds * 1000);
    try {
      if (controller.signal.aborted) throw abortError(controller.signal);
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = await abortable(isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : dependencies.resolve(hostname), controller.signal);
      if (!addresses.length) throw new RetrievalError('failed', '来源 DNS 未返回可连接地址。');
      if (input.publicPage && addresses.some(item => !isPublicAddress(item.address))) throw new RetrievalError('failed', '公开网页指向本机、内网或保留地址，已阻止访问。');
      if (!input.publicPage && url.protocol === 'http:' && addresses.some(item => isPublicAddress(item.address))) throw new RetrievalError('failed', '公网检索端点必须使用 HTTPS；HTTP 仅允许显式配置的本机/内网服务。');
      // Public sources never receive user credentials, Referer, cookies or API headers.
      const headers: Record<string, string> = input.publicPage
        ? { Accept: 'text/html,text/plain,application/xhtml+xml', 'Accept-Encoding': 'identity', 'User-Agent': 'LawAgent-SourceReader/0.1' }
        : { Accept: 'application/json', 'Accept-Encoding': 'identity', ...input.headers };
      return await abortable(dependencies.transport(url, { address: addresses[0], method: input.method ?? 'GET', headers,
        body: input.publicPage ? null : input.body ?? null, signal: controller.signal, maxBytes: 2 * 1024 * 1024 }), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw abortError(controller.signal);
      if (error instanceof RetrievalError) throw error;
      throw new RetrievalError('failed', '检索或来源读取失败，未回显敏感信息。');
    } finally { clearTimeout(timer); input.signal.removeEventListener('abort', cancel); }
  }
  return {
    raw(url: string, input: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; signal: AbortSignal; timeoutSeconds: number }): Promise<HttpResult> {
      return send(url, { ...input, body: input.body === undefined ? undefined : JSON.stringify(input.body), publicPage: false });
    },
    async json(url: string, input: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; signal: AbortSignal; timeoutSeconds: number }): Promise<{ data: unknown; fetchedAt: string }> {
      const result = await send(url, { ...input, body: input.body === undefined ? undefined : JSON.stringify(input.body), publicPage: false });
      try { return { data: JSON.parse(result.body.toString('utf8')), fetchedAt: result.fetchedAt }; }
      catch { throw new RetrievalError('failed', '检索服务未返回有效 JSON。'); }
    },
    page(url: string, signal: AbortSignal, timeoutSeconds: number): Promise<HttpResult> { return send(url, { publicPage: true, signal, timeoutSeconds }); },
  };
}
