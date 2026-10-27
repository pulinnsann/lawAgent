const get = id => document.getElementById(id);
let csrfToken = '', current = null, busy = false;
function message(text, error = false) { const node = get('message'); node.textContent = text; node.className = error ? 'error' : ''; node.setAttribute('role', error ? 'alert' : 'status'); }
function controls() { get('issue-button').disabled = busy || !csrfToken || !current || current.remaining <= 0; get('refresh-button').disabled = busy; get('copy-token').disabled = busy || !get('license-token').value; document.querySelectorAll('[data-license-token]').forEach(button => { button.disabled = busy; }); }
function date(value) { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(value)); }
async function api(path, input) {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...(input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-License-CSRF': csrfToken }, body: JSON.stringify(input) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : '本机请求未完成。');
  return value;
}
function showToken(value, license) { get('license-token').value = value; get('token-summary').textContent = license ? `许可序号 ${license.seat} · ${date(license.startsAt)} 至 ${date(license.expiresAt)}` : '已取回原激活码，请交给对应设备的使用者。'; controls(); }
function render(value) {
  current = value; for (const field of ['limit', 'issued', 'remaining']) get(field).textContent = String(value[field]);
  get('key-info').textContent = `签发标识：${value.keyId} · 校验指纹：${value.publicKeySha256}`;
  const rows = get('license-rows'); rows.replaceChildren();
  for (const license of value.licenses) {
    const row = document.createElement('tr');
    for (const text of [String(license.seat), license.deviceCode, date(license.startsAt), date(license.expiresAt)]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
    const cell = document.createElement('td'); const button = document.createElement('button'); button.type = 'button'; button.textContent = '取回原激活码'; button.disabled = busy; button.dataset.licenseToken = 'true';
    button.addEventListener('click', async () => {
      if (busy) return; busy = true; controls();
      try { const value = await api('/api/token', { licenseId: license.licenseId }); showToken(value.token, license); message('已取回原激活码，未新增签发。'); }
      catch (error) { message(error.message, true); }
      finally { busy = false; controls(); }
    }); cell.append(button); row.append(cell); rows.append(row);
  }
  if (!value.licenses.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = '尚未签发许可。'; row.append(cell); rows.append(row); }
  controls();
}
async function refresh() { const value = await api('/api/state'); render(value); }
get('issue-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !current || current.remaining <= 0) return;
  const deviceCode = get('device-code').value.trim();
  if (!/^LAWDEV1-[a-f0-9]{64}$/.test(deviceCode)) { message('请粘贴完整、有效的客户设备码。', true); return; }
  const selected = get('starts-at').value; let startsAt;
  if (selected) { const time = new Date(selected); if (!Number.isFinite(time.getTime())) { message('请选择有效的开始时间。', true); return; } startsAt = time.toISOString(); }
  busy = true; controls();
  try {
    const result = await api('/api/issue', { deviceCode, ...(startsAt ? { startsAt } : {}) });
    showToken(result.token, result.license); await refresh(); message('签发成功。请复制激活码交给对应设备的使用者。');
  } catch (error) { message(error.message, true); try { await refresh(); } catch { current = null; } }
  finally { busy = false; controls(); }
});
get('refresh-button').addEventListener('click', async () => {
  if (busy) return; busy = true; controls();
  try { await refresh(); message('已刷新本机签发记录。'); } catch (error) { current = null; message(error.message, true); }
  finally { busy = false; controls(); }
});
get('copy-token').addEventListener('click', async () => {
  const value = get('license-token').value; if (!value) return;
  try { await navigator.clipboard.writeText(value); message('激活码已复制。'); }
  catch { get('license-token').focus(); get('license-token').select(); message('请使用系统复制快捷键复制已选中的激活码。'); }
});
try { const session = await api('/api/session'); csrfToken = session.csrfToken; await refresh(); message('本机签发记录已就绪。'); }
catch (error) { message(error.message, true); }
controls();
