import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { ModelConfigInput } from '../shared/contracts';
import { MAX_MODEL_RESPONSE_BYTES, ModelRequestError, type CompletionRequest, type CompletionResult } from './model';
import { executeTrackedCompletion, modelRuntimePreview } from './model-runtime';

/** An explicit test seam; desktop callers always use the installed CLI. */
export interface CodexRuntime { executable?: string; prefixArgs?: string[]; env?: NodeJS.ProcessEnv }
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'computer_use', 'multi_agent', 'multi_agent_v2', 'view_image',
  'image_generation', 'code_mode_host', 'code_mode', 'tool_suggest', 'skill_search', 'sleep_tool',
  'goals', 'workspace_dependencies', 'remote_plugin', 'auth_elicitation', 'daemon_auto_start',
  'unbounded_connection_retries',
] as const;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;

/** GUI launches frequently have a smaller PATH than terminal launches. */
export async function resolveCodexExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const windows = process.platform === 'win32';
  const paths = [...new Set((env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean))];
  if (!windows) paths.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  else if (env.LOCALAPPDATA) paths.push(join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
  const candidates = paths.map(path => join(path, windows ? 'codex.exe' : 'codex'));
  // npm's Windows .cmd shim cannot be executed without a shell. Prefer its
  // native binary; never interpolate a command into cmd.exe or PowerShell.
  if (windows) {
    const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const packageName = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
    for (const path of [...paths, ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : [])]) {
      const pkg = join(path, 'node_modules', '@openai', 'codex');
      candidates.push(join(pkg, 'vendor', target, 'codex', 'codex.exe'), join(pkg, 'node_modules', '@openai', packageName, 'vendor', target, 'codex', 'codex.exe'));
    }
  }
  for (const candidate of candidates) {
    try { await access(candidate, windows ? constants.F_OK : constants.X_OK); return await realpath(candidate); }
    catch { /* Keep looking without exposing host paths in errors. */ }
  }
  throw new ModelRequestError('CODEX_NOT_FOUND', '未找到本机 Codex CLI。请先安装官方 Codex CLI，并在本机完成 codex login，然后重试。');
}

function cliEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'home', 'userprofile', 'appdata', 'localappdata', 'systemroot', 'windir', 'comspec', 'pathext', 'tmp', 'temp', 'tmpdir', 'user', 'logname', 'lang', 'lc_all', 'ssl_cert_file', 'ssl_cert_dir', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'codex_home']);
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toLowerCase())));
  if (process.platform !== 'win32') env.PATH = [...new Set([...(env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].filter(Boolean).join(delimiter);
  return { ...env, RUST_LOG: 'off', NO_COLOR: '1' };
}

export function codexArguments(config: ModelConfigInput, folder: string): string[] {
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
    '-c', 'model_provider="openai"',
    '-c', 'history.persistence="none"', '-c', 'analytics.enabled=false',
    '-c', `log_dir=${JSON.stringify(join(folder, 'logs'))}`,
    '-c', `model_instructions_file=${JSON.stringify(join(folder, 'instructions.txt'))}`,
    '--output-schema', join(folder, 'schema.json')];
  for (const name of DISABLED_FEATURES) args.push('--disable', name);
  args.push('--enable', 'skip_host_skill_discovery');
  if (config.model !== 'default') args.push('--model', config.model);
  args.push('-');
  return args;
}

function safeCliFailure(stderr: string): ModelRequestError {
  if (/login|log in|sign in|unauthorized|not authenticated|401|refresh.*token/i.test(stderr)) return new ModelRequestError('CODEX_AUTH_REQUIRED', 'Codex 登录已失效或未登录，请在本机运行 codex login 后重试。');
  if (/429|rate.?limit|usage.?limit|quota|credits|usage_limit_reached/i.test(stderr)) return new ModelRequestError('CODEX_RATE_LIMIT', 'Codex 当前额度不足或被限流，请检查账户额度后手动重试。');
  if (/unexpected argument|unknown (?:feature|variant)|unrecognized|invalid.*config|failed to load config/i.test(stderr)) return new ModelRequestError('CODEX_VERSION_UNSUPPORTED', '当前 Codex CLI 不支持所需的隔离或结构化输出配置，请更新官方 CLI 后重试。');
  return new ModelRequestError('CODEX_REQUEST_FAILED', 'Codex 未完成请求，请检查 CLI 登录、模型权限及网络后手动重试。');
}

/** One ephemeral text-only invocation. No credential extraction or local proxy. */
export async function requestCodexCompletion(config: ModelConfigInput, request: CompletionRequest, signal?: AbortSignal, runtime: CodexRuntime = {}): Promise<CompletionResult> {
  return executeTrackedCompletion(config, request, null, signal, () => requestCodexCompletionOnce(config, request, signal, runtime));
}
async function requestCodexCompletionOnce(config: ModelConfigInput, request: CompletionRequest, signal?: AbortSignal, runtime: CodexRuntime = {}): Promise<CompletionResult> {
  if (signal?.aborted) throw new ModelRequestError('CANCELLED', '请求已取消。');
  const sourceEnv = runtime.env ?? process.env;
  const executable = runtime.executable ?? await resolveCodexExecutable(sourceEnv);
  const folder = await mkdtemp(join(tmpdir(), 'law-agent-codex-'));
  let child: ChildProcessWithoutNullStreams | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let stopError: ModelRequestError | undefined;
  const stop = (error: ModelRequestError) => {
    if (stopError) return;
    stopError = error;
    if (!child?.pid) return;
    const kill = (force: boolean) => {
      if (!child?.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        else child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch { /* Process already exited. */ }
    };
    kill(false); killTimer = setTimeout(() => kill(true), 1000); killTimer.unref();
  };
  const cancel = () => stop(new ModelRequestError('CANCELLED', 'Codex 审核已取消。'));
  try {
    const system = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    await writeFile(join(folder, 'instructions.txt'), `${system}\n\n只依据本次输入资料输出符合Schema的JSON。不要使用工具、读取文件、浏览网页或执行命令。`, { mode: 0o600 });
    await writeFile(join(folder, 'schema.json'), JSON.stringify(request.jsonSchema.schema), { mode: 0o600 });
    if (signal?.aborted) throw new ModelRequestError('CANCELLED', '请求已取消。');
    child = spawn(executable, [...(runtime.prefixArgs ?? []), ...codexArguments(config, folder)], { cwd: folder, env: cliEnvironment(sourceEnv), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    timeout = setTimeout(() => stop(new ModelRequestError('TIMEOUT', 'Codex 请求超时，已停止本次进程；可手动重试。')), config.timeoutSeconds * 1000);
    let stdoutBytes = 0; let stderr = ''; let buffer = ''; let content = ''; let completed = false; let failed = false;
    let inputTokens: number | null = null; let outputTokens: number | null = null;
    const parseLine = (line: string) => {
      if (!line.trim() || stopError) return;
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { stop(new ModelRequestError('CODEX_RESPONSE_INVALID', 'Codex 返回了无法识别的事件格式，请更新 CLI 后重试。')); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
        stop(new ModelRequestError('CODEX_RESPONSE_INVALID', 'Codex 返回了无效的事件结构，请更新 CLI 后重试。')); return;
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        if (typeof event.item.text === 'string') { content = event.item.text; modelRuntimePreview(content); }
      } else if (event.type === 'turn.completed') {
        completed = true;
        const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
        inputTokens = count(event.usage?.input_tokens); outputTokens = count(event.usage?.output_tokens);
      } else if (event.type === 'error' || event.type === 'turn.failed') {
        failed = true;
        // Only classify; raw CLI/server diagnostics never reach the UI/logs.
        stderr = `${stderr}\n${JSON.stringify(event)}`.slice(-65536);
      } else if (event.type === 'item.completed' && event.item?.type === 'error') {
        // The CLI can emit nonfatal startup diagnostics as error items and
        // subsequently complete the turn. Only turn.failed/exit status is fatal.
        stderr = `${stderr}\n${JSON.stringify(event.item)}`.slice(-65536);
      } else if (event.type.startsWith('item.') && !['reasoning', 'agent_message', 'plan', 'error'].includes(event.item?.type)) {
        stop(new ModelRequestError('CODEX_UNEXPECTED_TOOL', 'Codex 请求了审核范围之外的工具操作，已停止本次请求。请更新 CLI 后重试。'));
      }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_EVENT_BYTES) { stop(new ModelRequestError('RESPONSE_TOO_LARGE', 'Codex 响应超过大小上限，已停止请求。')); return; }
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { parseLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-65536); });
    const result = new Promise<CompletionResult>((resolve, reject) => {
      child!.on('error', () => reject(new ModelRequestError('CODEX_START_FAILED', '无法启动本机 Codex CLI，请检查安装和执行权限。')));
      child!.on('close', code => {
        parseLine(buffer);
        const knownUsage = { inputTokens, outputTokens };
        if (stopError) { reject(new ModelRequestError(stopError.code, stopError.message, knownUsage)); return; }
        if (code !== 0 || failed || !completed) { const safe = safeCliFailure(stderr); reject(new ModelRequestError(safe.code, safe.message, knownUsage)); return; }
        if (!content.trim()) { reject(new ModelRequestError('CODEX_RESPONSE_INVALID', 'Codex 未返回可用的最终 JSON。', knownUsage)); return; }
        if (Buffer.byteLength(content) > MAX_MODEL_RESPONSE_BYTES) { reject(new ModelRequestError('RESPONSE_TOO_LARGE', 'Codex 最终响应超过大小上限。', knownUsage)); return; }
        resolve({ content, model: config.model === 'default' ? 'codex:default' : config.model, inputTokens, outputTokens });
      });
    });
    child.stdin.on('error', () => { /* A failed CLI can close stdin before reading it. */ });
    // Contract data is never included in process arguments or temporary files.
    if (!stopError) child.stdin.end(request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n\n'));
    else child.stdin.end();
    return await result;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener('abort', cancel);
    await rm(folder, { recursive: true, force: true });
  }
}
