import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEVICE = /^LAWDEV1-[a-f0-9]{64}$/u;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function headers(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', CSP);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'clipboard-write=(self)');
}
function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}
function summary(value) {
  return { licenseId: value.licenseId, seat: value.seat, deviceCode: value.deviceCode, issuedAt: value.issuedAt, startsAt: value.startsAt, expiresAt: value.expiresAt };
}
function publicState(value) {
  return { limit: value.limit, issued: value.issued, remaining: value.remaining, keyId: value.keyId, publicKeySha256: value.publicKeySha256, licenses: value.licenses.map(summary) };
}
function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
}
function headerCount(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index].toLowerCase() === name) count++;
  return count;
}
function sameSecret(value, expected) {
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value), wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function issueFailure(error) {
  if (error?.code === 'ISSUER_DUPLICATE_DEVICE') return new HttpError(409, '此设备已签发体验许可，请在历史记录中取回原激活码。');
  if (error?.code === 'ISSUER_LIMIT') return new HttpError(409, '100 份体验许可已全部签发，请保留本机签发记录。');
  if (error?.code === 'ISSUER_INPUT') return new HttpError(400, '请核对设备码，并将开始时间留空或选择当前时间之后的未来 365 天以内。');
  return new HttpError(422, '无法签发，请核对设备码、开始时间、签发记录和剩余名额。');
}
async function body(request) {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) { request.resume(); throw new HttpError(413, '请求内容超过 4 KiB 上限。'); }
  const bytes = await new Promise((complete, reject) => {
    const chunks = []; let size = 0;
    const clean = () => { request.off('data', data); request.off('end', end); request.off('aborted', abort); request.off('error', abort); };
    const abort = () => { clean(); reject(new HttpError(400, '请求未完整接收。')); };
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { clean(); request.resume(); reject(new HttpError(413, '请求内容超过 4 KiB 上限。')); return; }
      chunks.push(chunk);
    };
    const end = () => { clean(); complete(Buffer.concat(chunks, size)); };
    request.on('data', data); request.once('end', end); request.once('aborted', abort); request.once('error', abort);
  });
  if (!bytes.length || !isUtf8(bytes)) throw new HttpError(400, '请提交有效的 JSON 内容。');
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new HttpError(400, '请提交有效的 JSON 内容。'); }
}

/** The issuer is injected so HTTP tests never load a real signing key. The
 * server owns only this loopback listener and the issuer passed to it. */
export async function startLicenseIssuer({ issuer, port = 0 }) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local issuer port.');
  const directory = join(dirname(fileURLToPath(import.meta.url)), 'public');
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html; charset=utf-8'], ['/index.html', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ].map(async ([route, file, contentType]) => [route, { bytes: await readFile(join(directory, file)), contentType }])));
  const nonce = randomBytes(32).toString('base64url');
  const operations = new Set();
  let origin = '', host = '', closing = false;
  async function route(request, response) {
    headers(response);
    if (closing) throw new HttpError(503, '工具正在关闭。');
    if (headerCount(request, 'host') !== 1 || request.headers.host !== host) throw new HttpError(403, '仅允许使用本机工具地址。');
    if (headerCount(request, 'origin') > 1 || request.headers.origin !== undefined && request.headers.origin !== origin) throw new HttpError(403, '请求来源不受支持。');
    const path = request.url ?? '';
    if (request.method === 'GET') {
      if (assets.has(path)) { const asset = assets.get(path); response.writeHead(200, { 'Content-Type': asset.contentType }); response.end(asset.bytes); return; }
      if (path === '/api/session') { json(response, 200, { csrfToken: nonce }); return; }
      if (path === '/api/state') { json(response, 200, publicState(await issuer.state())); return; }
      throw new HttpError(404, '没有找到此入口。');
    }
    if (request.method !== 'POST') throw new HttpError(405, '请求方法不受支持。');
    if (request.headers.origin !== origin || !sameSecret(request.headers['x-license-csrf'], nonce)) throw new HttpError(403, '请从本机工具页面提交。');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? '')) throw new HttpError(415, '请使用 JSON 提交。');
    if (!['/api/issue', '/api/token'].includes(path)) throw new HttpError(404, '没有找到此入口。');
    const input = await body(request);
    if (path === '/api/issue') {
      if (!exactKeys(input, ['deviceCode', 'startsAt']) || typeof input.deviceCode !== 'string' || !DEVICE.test(input.deviceCode)
        || Object.hasOwn(input, 'startsAt') && (typeof input.startsAt !== 'string' || input.startsAt.length > 40 || !Number.isFinite(Date.parse(input.startsAt)))) throw new HttpError(400, '请填写有效的设备码和可选开始时间。');
      try {
        const result = await issuer.issue(input);
        json(response, 200, { license: summary(result), token: result.token });
      } catch (error) { throw issueFailure(error); }
      return;
    }
    if (!exactKeys(input, ['licenseId']) || typeof input.licenseId !== 'string' || !UUID.test(input.licenseId)) throw new HttpError(400, '请选择已签发的许可。');
    try {
      const result = await issuer.getToken(input.licenseId);
      const token = typeof result === 'string' ? result : result?.token;
      if (typeof token !== 'string' || !token) throw new Error('Missing issuer token.');
      json(response, 200, { licenseId: input.licenseId, token });
    } catch { throw new HttpError(404, '未取得此许可的激活码，请核对本机签发记录。'); }
  }
  const server = createServer((request, response) => {
    // A browser closing a tab or an oversized request being discarded is an
    // ordinary transport failure, including after body listeners are removed.
    request.on('error', () => {}); response.on('error', () => {});
    const operation = route(request, response).catch(error => {
      if (!response.destroyed && !response.writableEnded) {
        if (response.headersSent) { response.destroy(); return; }
        headers(response); json(response, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : '本机签发服务未能完成请求，请检查本机签发配置。' });
      }
    });
    operations.add(operation); void operation.finally(() => operations.delete(operation));
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 2_000;
  try {
    await new Promise((complete, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.off('error', reject); complete(); }); });
  } catch (error) { await issuer.close(); throw error; }
  const address = server.address();
  host = `127.0.0.1:${address.port}`; origin = `http://${host}`;
  let closed;
  const close = () => closed ??= (async () => {
    closing = true;
    await new Promise((complete, reject) => { server.close(error => error ? reject(error) : complete()); server.closeAllConnections(); });
    await Promise.allSettled([...operations]);
    await issuer.close();
  })();
  return { url: origin, close };
}

const direct = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  try {
    const [{ LicenseIssuer }, { OFFICIAL_LICENSE_PUBLIC_KEYS }] = await Promise.all([import('./issuer.ts'), import('../../src/core/license-trusted-keys.ts')]);
    const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../../.local/license-issuer');
    const issuer = new LicenseIssuer({ directory, privateKeyPath: join(directory, 'issuer-private.pem'), expectedPublicKeys: OFFICIAL_LICENSE_PUBLIC_KEYS, kid: 'lawagent-trial-v1' });
    const running = await startLicenseIssuer({ issuer });
    process.stdout.write(`许可签发工具已启动：${running.url}\n请在本机浏览器打开此地址；关闭工具请按 Ctrl+C。\n`);
    const stop = () => { void running.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch { process.stderr.write('许可签发工具无法启动，请检查本机签发配置与目录权限。\n'); process.exitCode = 1; }
}
