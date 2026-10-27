const DEVICE = /^LAWDEV1-[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const TRIAL = 90 * 24 * 60 * 60 * 1000;
const BAD_RESPONSE = '签发程序返回的记录无效，已暂停签发。请检查原有签发资料。';
const BAD_DEVICE_INPUT = '请粘贴完整、有效的客户设备码，或从 LawAgent 复制的签发信息。';
const REQUEST_FIELDS = ['appVersion', 'deviceCode', 'product'];

function checkedDeviceInput(value) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > 2048) throw new Error(BAD_DEVICE_INPUT);
  const text = value.trim();
  if (DEVICE.test(text)) return text;
  let request;
  try { request = JSON.parse(text); } catch { throw new Error(BAD_DEVICE_INPUT); }
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).sort().join(',') !== REQUEST_FIELDS.join(',')
    || request.product !== 'law-agent' || typeof request.appVersion !== 'string' || request.appVersion.length > 80
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(request.appVersion)
    || typeof request.deviceCode !== 'string' || !DEVICE.test(request.deviceCode)) throw new Error(BAD_DEVICE_INPUT);
  return request.deviceCode;
}

function validLicense(license, seat) {
  if (!Number.isInteger(seat) || seat < 1 || seat > 100 || !license || typeof license !== 'object' || !UUID.test(license.licenseId) || license.seat !== seat || !DEVICE.test(license.deviceCode)) return false;
  const dates = ['issuedAt', 'startsAt', 'expiresAt'].map(field => typeof license[field] === 'string' ? Date.parse(license[field]) : NaN);
  return dates.every(Number.isFinite) && dates[0] <= dates[1] && dates[2] - dates[1] === TRIAL;
}

export function checkedState(envelope) {
  if (!envelope || typeof envelope !== 'object' || typeof envelope.configured !== 'boolean') throw new Error(BAD_RESPONSE);
  if (envelope.directory !== undefined && (typeof envelope.directory !== 'string' || envelope.directory.length > 32768)) throw new Error(BAD_RESPONSE);
  if (envelope.error !== undefined && (typeof envelope.error !== 'string' || envelope.error.length > 1024)) throw new Error(BAD_RESPONSE);
  if (!envelope.configured) return envelope;
  const state = envelope.state;
  if (!state || state.limit !== 100 || !Number.isInteger(state.issued) || state.issued < 0 || state.issued > 100 || state.remaining !== 100 - state.issued
    || typeof state.keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u.test(state.keyId)
    || !/^[a-f0-9]{64}$/u.test(state.publicKeySha256) || !Array.isArray(state.licenses) || state.licenses.length !== state.issued
    || !state.licenses.every((license, index) => validLicense(license, index + 1))
    || new Set(state.licenses.map(license => license.deviceCode)).size !== state.issued
    || new Set(state.licenses.map(license => license.licenseId)).size !== state.issued) throw new Error(BAD_RESPONSE);
  return envelope;
}

export function checkedIssueInput(deviceValue, startsValue) {
  const deviceCode = checkedDeviceInput(deviceValue);
  if (!startsValue) return { deviceCode };
  const time = new Date(startsValue);
  if (!Number.isFinite(time.getTime())) throw new Error('请选择有效的许可开始时间。');
  return { deviceCode, startsAt: time.toISOString() };
}

function safeError(error) {
  const value = typeof error === 'string' ? error : error?.message;
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : '签发操作未能完成，请检查本机签发资料。';
}
function checkedToken(value) {
  if (typeof value !== 'string' || !/^LAW1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value) || value.length > 4096) throw new Error(BAD_RESPONSE);
  return value;
}
function date(value) { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(value)); }

/** Native calls are injected in tests; there is no HTTP server or web preview signer. */
export function createIssuerController({ document, invoke, clipboard }) {
  const get = id => document.getElementById(id);
  let current = null, envelope = null, busy = false, selected = null;
  function message(text, error = false) {
    const node = get('message'); node.textContent = text; node.className = error ? 'error' : '';
    node.setAttribute('role', error ? 'alert' : 'status');
  }
  function controls() {
    const ready = Boolean(current);
    get('select-directory').disabled = busy || ready;
    get('refresh-button').disabled = busy;
    get('device-code').disabled = busy || !ready || current.remaining <= 0;
    get('starts-at').disabled = get('device-code').disabled;
    get('issue-button').disabled = get('device-code').disabled;
    get('copy-token').disabled = busy || !get('license-token').value;
    get('export-token').disabled = busy || !selected || !current;
    document.querySelectorAll('[data-license-token]').forEach(button => { button.disabled = busy || !ready; });
  }
  function clearToken() { selected = null; get('license-token').value = ''; get('token-summary').textContent = '签发成功或取回历史许可后，在这里复制或保存激活码。'; }
  function render(value) {
    const next = checkedState(value);
    if (envelope?.directory !== next.directory) clearToken();
    envelope = next; current = next.configured ? next.state : null;
    get('directory-path').textContent = next.directory || '尚未选择签发资料目录。';
    get('setup-status').textContent = current ? '已连接' : '未连接';
    get('setup-status').className = current ? 'badge connected' : 'badge';
    get('setup-help').textContent = current
      ? '已连接原有签发资料。所有签发记录直接保存在此目录，不会复制或重置名额。'
      : '请选择原有签发资料目录。它应包含签发私钥、签发记录和资料标识；空目录不会创建新名额。';
    for (const field of ['limit', 'issued', 'remaining']) get(field).textContent = current ? String(current[field]) : '—';
    get('key-info').textContent = current ? `签发标识：${current.keyId} · 公钥校验指纹：${current.publicKeySha256}` : '';
    const rows = get('license-rows'); rows.replaceChildren();
    if (!current || !current.licenses.length) {
      const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5;
      cell.textContent = current ? '尚未签发许可。' : '尚未连接签发资料。'; row.append(cell); rows.append(row);
    } else for (const license of current.licenses) {
      const row = document.createElement('tr');
      for (const value of [String(license.seat), license.deviceCode, date(license.startsAt), date(license.expiresAt)]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      const cell = document.createElement('td'), button = document.createElement('button'); button.type = 'button';
      button.textContent = '取回原激活码'; button.dataset.licenseToken = 'true';
      button.addEventListener('click', () => { void retrieve(license); }); cell.append(button); row.append(cell); rows.append(row);
    }
    controls();
  }
  function unavailable(error) {
    current = null; clearToken();
    for (const field of ['limit', 'issued', 'remaining']) get(field).textContent = '—';
    get('setup-status').textContent = '连接异常'; get('setup-status').className = 'badge';
    message(safeError(error), true); controls();
  }
  function showToken(value, license) {
    get('license-token').value = checkedToken(value); selected = license;
    get('token-summary').textContent = `许可序号 ${license.seat} · ${date(license.startsAt)} 至 ${date(license.expiresAt)}`;
    controls();
  }
  async function load(command = 'issuer_state') {
    if (busy) return;
    busy = true; controls();
    try {
      const value = checkedState(await invoke(command)); render(value);
      message(value.error || (current ? '签发资料已就绪。' : '请选择已有的签发资料目录。'), Boolean(value.error));
    } catch (error) { unavailable(error); }
    finally { busy = false; controls(); }
  }
  async function issue() {
    if (busy || !current || current.remaining <= 0) return;
    let input;
    try { input = checkedIssueInput(get('device-code').value, get('starts-at').value); }
    catch (error) { message(safeError(error), true); return; }
    busy = true; clearToken(); controls();
    try {
      const result = await invoke('issuer_issue', input);
      if (!result || !validLicense(result.license, result.license?.seat) || result.license.deviceCode !== input.deviceCode) throw new Error(BAD_RESPONSE);
      showToken(result.token, result.license);
      try {
        const refreshed = checkedState(await invoke('issuer_state'));
        if (!refreshed.configured) throw new Error(refreshed.error || '未能重新连接原有签发资料。');
        render(refreshed); message('签发成功。请复制或保存激活码，交给对应设备的使用者。');
      }
      catch (error) {
        // Preserve an already committed token when only the following refresh
        // fails. Signing remains disabled until records can be read again.
        current = null;
        for (const field of ['limit', 'issued', 'remaining']) get(field).textContent = '—';
        get('setup-status').textContent = '连接异常'; get('setup-status').className = 'badge';
        message(`激活码已取得，记录刷新失败。请先复制激活码，再刷新记录。${safeError(error)}`, true);
      }
    } catch (error) {
      message(safeError(error), true);
      try { render(await invoke('issuer_state')); } catch { current = null; }
    } finally { busy = false; controls(); }
  }
  async function retrieve(license) {
    if (busy || !current || !current.licenses.some(value => value.licenseId === license.licenseId)) return;
    busy = true; clearToken(); controls();
    try { showToken(await invoke('issuer_token', { licenseId: license.licenseId }), license); message('已取回原激活码，名额和有效期保持不变。'); }
    catch (error) { message(safeError(error), true); }
    finally { busy = false; controls(); }
  }
  async function copy() {
    if (busy || !get('license-token').value) return;
    try {
      if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('Clipboard unavailable.');
      await clipboard.writeText(get('license-token').value); message('激活码已复制。');
    } catch {
      get('license-token').focus(); get('license-token').select(); message('请使用系统复制快捷键复制已选中的激活码。');
    }
  }
  async function exportToken() {
    if (busy || !selected || !current) return;
    busy = true; controls();
    try {
      const saved = await invoke('issuer_export_token', { licenseId: selected.licenseId });
      if (saved === true) message('激活码文件已保存。');
      else if (saved === false) message('已取消保存，签发记录保持不变。');
      else throw new Error(BAD_RESPONSE);
    } catch (error) { message(safeError(error), true); }
    finally { busy = false; controls(); }
  }
  get('issue-form').addEventListener('submit', event => { event.preventDefault(); void issue(); });
  get('select-directory').addEventListener('click', () => { void load('issuer_select_directory'); });
  get('refresh-button').addEventListener('click', () => { void load(); });
  get('copy-token').addEventListener('click', () => { void copy(); });
  get('export-token').addEventListener('click', () => { void exportToken(); });
  controls();
  return { refresh: () => load(), selectDirectory: () => load('issuer_select_directory'), issue, retrieve, copy, exportToken };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke === 'function') {
    const controller = createIssuerController({ document, invoke, clipboard: window.navigator.clipboard });
    void controller.refresh();
  } else {
    const node = document.getElementById('message'); node.textContent = '请从已安装的 LawAgent 许可签发器打开此界面。';
    node.className = 'error'; node.setAttribute('role', 'alert');
  }
}
