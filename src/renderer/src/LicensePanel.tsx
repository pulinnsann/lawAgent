import { useEffect, useRef, useState } from 'react';
import { Copy, KeyRound, RefreshCw, X } from 'lucide-react';
import type { ContractAssistantBridge } from '../../shared/contracts';
import { LICENSE_DEVICE_PATTERN, LICENSE_TOKEN_MAX_BYTES, type LicenseState } from '../../shared/licensing';
import { APP_VERSION } from '../../shared/app-version';
import { useI18n } from './i18n';

export const LICENSE_ACTIVATION_INPUT_LIMIT = LICENSE_TOKEN_MAX_BYTES;
export const licenseStatusLabels: Record<LicenseState['status'], string> = {
  development: '开发与界面预览', missing: '尚未激活', active: '许可有效', not_started: '许可尚未开始', expired: '许可已到期',
  invalid: '许可无效', device_unavailable: '无法取得设备码', clock_rollback: '需要核对系统时间', storage_error: '许可保存异常',
};
function checkedState(value: unknown): LicenseState {
  if (!value || typeof value !== 'object') throw new Error('许可状态响应无效，请刷新后重试。');
  const state = value as LicenseState;
  if (!['development', 'required'].includes(state.mode) || !Object.hasOwn(licenseStatusLabels, state.status)
    || typeof state.canCreate !== 'boolean' || state.canViewExport !== true || typeof state.checkedAt !== 'string' || !Number.isFinite(Date.parse(state.checkedAt))
    || typeof state.message !== 'string' || state.deviceCode !== null && (typeof state.deviceCode !== 'string' || !LICENSE_DEVICE_PATTERN.test(state.deviceCode))) throw new Error('许可状态响应无效，请刷新后重试。');
  if (state.mode === 'required' && state.canCreate !== (state.status === 'active')
    || state.mode === 'development' && (state.status !== 'development' || !state.canCreate)
    || state.status === 'active' && state.license === null) throw new Error('许可状态响应无效，请刷新后重试。');
  if (state.license !== null && (!state.license || typeof state.license.licenseId !== 'string'
    || !Number.isSafeInteger(state.license.seat) || state.license.seat < 1 || state.license.seat > 100
    || [state.license.issuedAt, state.license.startsAt, state.license.expiresAt].some(item => typeof item !== 'string' || !Number.isFinite(Date.parse(item))))) throw new Error('许可状态响应无效，请刷新后重试。');
  return state;
}
export async function readLicenseState(bridge: Pick<ContractAssistantBridge, 'runWorkspaceCommand'>): Promise<LicenseState> {
  return checkedState(await bridge.runWorkspaceCommand({ action: 'workspace.licenseState', payload: {} }));
}
export async function activateLicenseToken(bridge: Pick<ContractAssistantBridge, 'runWorkspaceCommand'>, rawToken: string): Promise<LicenseState> {
  const token = rawToken.trim();
  if (!token) throw new Error('请先粘贴取得的激活码。');
  if (new TextEncoder().encode(token).length > LICENSE_ACTIVATION_INPUT_LIMIT) throw new Error('激活码过长，请检查是否混入其他内容。');
  return checkedState(await bridge.runWorkspaceCommand({ action: 'workspace.licenseActivate', payload: { token } }));
}

/** An explicit allowlist keeps activation tokens and raw machine identifiers
 * out of the information a customer sends to the license issuer. */
export function createLicenseRequestInfo(state: LicenseState | null, appVersion = APP_VERSION, unavailable = false): string | null {
  if (unavailable || !state || state.mode !== 'required' || typeof state.deviceCode !== 'string' || !LICENSE_DEVICE_PATTERN.test(state.deviceCode)
    || typeof appVersion !== 'string' || appVersion.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(appVersion)) return null;
  return JSON.stringify({ product: 'law-agent', appVersion, deviceCode: state.deviceCode }, null, 2);
}

export async function copyLicenseInfo(value: string | null, clipboard: Pick<Clipboard, 'writeText'> | undefined, selectFallback: () => void): Promise<'copied' | 'selected' | 'unavailable'> {
  if (!value) return 'unavailable';
  try {
    if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('Clipboard unavailable.');
    await clipboard.writeText(value); return 'copied';
  } catch { selectFallback(); return 'selected'; }
}

/** Reveal the optional raw request only when manual copying is needed. */
export function selectLicenseCopyFallback(container: Pick<HTMLElement, 'querySelector'> | null, kind: 'device' | 'request'): void {
  if (kind === 'request') {
    const details = container?.querySelector<HTMLDetailsElement>('#license-request-details');
    if (details) details.open = true;
  }
  const field = container?.querySelector<HTMLTextAreaElement>(kind === 'device' ? '#license-device-code' : '#license-request-info');
  field?.focus(); field?.select();
}

interface LicenseViewProps {
  state: LicenseState | null;
  loading: boolean;
  activating: boolean;
  error: string;
  stateUnavailable?: boolean;
  notice: string;
  token: string;
  appVersion?: string;
  onTokenChange: (value: string) => void;
  onRefresh: () => void;
  onActivate: () => void;
  onCopy: () => void;
  onCopyRequest?: () => void;
}
/** Display the host's decision; the browser clock and a pasted token never
 * grant permission. Existing material remains readable/exportable. */
export function LicenseStatusView({ state, loading, activating, error, stateUnavailable, notice, token, appVersion = APP_VERSION, onTokenChange, onRefresh, onActivate, onCopy, onCopyRequest = () => {} }: LicenseViewProps) {
  const { t, translateMessage, formatDate } = useI18n();
  const busy = loading || activating;
  const unavailable = stateUnavailable ?? Boolean(error);
  const requestInfo = createLicenseRequestInfo(state, appVersion, unavailable);
  const deviceCode = !unavailable && state?.mode === 'required' && state.deviceCode && LICENSE_DEVICE_PATTERN.test(state.deviceCode) ? state.deviceCode : '';
  return <div className="license-content" aria-busy={busy}>
    <div className="license-status-heading"><div><span>{t('当前许可状态')}</span><strong className={`license-status license-status-${unavailable ? 'unavailable' : state?.status ?? 'unavailable'}`} role="status">{unavailable ? t('许可状态暂不可用') : state ? t(licenseStatusLabels[state.status]) : t('正在检查许可…')}</strong></div><button type="button" className="button secondary small" disabled={busy} onClick={onRefresh}><RefreshCw size={14} />{t('刷新许可状态')}</button></div>
    {error && <p className="license-error" role="alert">{translateMessage(error)}</p>}
    {notice && <p className="license-notice" role="status">{translateMessage(notice)}</p>}
    {state && !unavailable && <p className="license-message">{translateMessage(state.message)}</p>}
    {state?.mode !== 'development' && <section className="license-device" aria-labelledby="license-device-title"><h3 id="license-device-title">{t('签发所需本机信息')}</h3><p>{t('将本机设备码交给许可提供方，或复制整份签发信息以便核对产品与版本。')}</p><dl className="license-machine-meta"><div><dt>{t('产品名称')}</dt><dd>LawAgent</dd></div><div><dt>{t('应用版本')}</dt><dd>{appVersion}</dd></div></dl><label htmlFor="license-device-code">{t('本机设备码')}</label><div className="license-copy-row"><textarea id="license-device-code" aria-label={t('本机设备码')} readOnly value={deviceCode} placeholder={t('暂未取得设备码')} rows={2} onFocus={event => event.currentTarget.select()} spellCheck={false} autoCapitalize="off" /><button type="button" className="button secondary small" disabled={!deviceCode || busy} onClick={onCopy}><Copy size={14} />{t('复制设备码')}</button></div><button type="button" className="button secondary small license-request-copy" disabled={!requestInfo || busy} onClick={onCopyRequest}><Copy size={14} />{t('复制签发信息')}</button><p className="license-info-help">{t('签发信息仅包含产品、应用版本和设备码。')}</p><details id="license-request-details" className="license-request-details"><summary>{t('查看申请信息内容（可选）')}</summary><label htmlFor="license-request-info">{t('本机签发信息')}</label><textarea id="license-request-info" aria-label={t('本机签发信息')} readOnly value={requestInfo ?? ''} placeholder={t('取得有效设备码后显示签发信息')} rows={6} onFocus={event => event.currentTarget.select()} spellCheck={false} autoCapitalize="off" /></details></section>}
    <div className="license-access-note"><strong>{t('已有资料仍可查看与导出。')}</strong><p>{t('没有有效许可时，不能新建导入、审核或合同生成任务。')}</p></div>
    {state?.license && <dl className="license-dates"><div><dt>{t('许可编号')}</dt><dd>{state.license.licenseId}</dd></div><div><dt>{t('许可序号')}</dt><dd>{String(state.license.seat)}</dd></div><div><dt>{t('签发时间')}</dt><dd>{formatDate(state.license.issuedAt)}</dd></div><div><dt>{t('许可开始时间')}</dt><dd>{formatDate(state.license.startsAt)}</dd></div><div><dt>{t('许可到期时间')}</dt><dd>{formatDate(state.license.expiresAt)}</dd></div></dl>}
    {state?.mode === 'development' ? <p className="license-development">{t('开发与浏览器预览不使用真实激活码，也不会创建正式许可。')}</p> : <>
      <form className="license-activation" onSubmit={event => { event.preventDefault(); onActivate(); }}><label htmlFor="license-activation-token">{t('粘贴激活码')}</label><textarea id="license-activation-token" value={token} onChange={event => onTokenChange(event.target.value)} rows={4} maxLength={LICENSE_ACTIVATION_INPUT_LIMIT} spellCheck={false} autoCapitalize="off" autoComplete="off" disabled={activating} aria-describedby="license-token-help" /><p id="license-token-help">{t('激活码仅在本机提交，不需要在此输入模型 API 密钥。')}</p><button type="submit" className="button primary" disabled={busy || !state?.deviceCode || !token.trim()}><KeyRound size={15} />{activating ? t('正在激活…') : t('激活本机许可')}</button></form>
    </>}
    <details className="license-plan"><summary>{t('离线体验许可')}</summary><p>{t('本次体验计划最多签发 100 份许可，每份绑定 1 台设备。')}</p><p>{t('每份许可自载明的开始时间起有效 90 天，以显示的到期时间为准。')}</p><p>{t('此页面只显示本机许可状态，不显示全部许可的剩余名额。')}</p><p>{t('体验许可不改变项目源代码的 Apache-2.0 开源授权。')}</p></details>
    {state && <p className="license-checked-at">{t('许可检查时间：{time}', { time: formatDate(state.checkedAt) })}</p>}
  </div>;
}

export default function LicensePanel({ bridge, initialState, initialError = '', appVersion = APP_VERSION, onClose, onStateChange }: {
  bridge: ContractAssistantBridge; initialState: LicenseState | null; initialError?: string;
  appVersion?: string;
  onClose: () => void; onStateChange: (value: LicenseState) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState(initialState); const [error, setError] = useState(initialError);
  const [stateUnavailable, setStateUnavailable] = useState(Boolean(initialError));
  const [loading, setLoading] = useState(false); const [activating, setActivating] = useState(false);
  const [token, setToken] = useState(''); const [notice, setNotice] = useState('');
  const panel = useRef<HTMLElement>(null); const alive = useRef(false); const operation = useRef(0);
  const read = async () => {
    const sequence = ++operation.current; setLoading(true); setError(''); setNotice('');
    try { const value = await readLicenseState(bridge); if (alive.current && sequence === operation.current) { setState(value); setStateUnavailable(false); onStateChange(value); } }
    catch (cause) { if (alive.current && sequence === operation.current) { setError(cause instanceof Error ? cause.message : String(cause)); setStateUnavailable(true); } }
    finally { if (alive.current && sequence === operation.current) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true; void read();
    const previous = window.document.activeElement;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('button')?.focus());
    return () => { alive.current = false; ++operation.current; cancelAnimationFrame(frame); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [bridge]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const controls = [...panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), summary') ?? []].filter(control => {
        const closed = control.closest('details:not([open])');
        return !closed || closed.querySelector('summary') === control;
      });
      const first = controls[0], last = controls.at(-1), current = window.document.activeElement;
      if (event.shiftKey && (current === first || !panel.current?.contains(current))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (current === last || !panel.current?.contains(current))) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);
  const activate = async () => {
    if (loading || activating) return;
    const sequence = ++operation.current; setActivating(true); setError(''); setNotice('');
    try {
      const value = await activateLicenseToken(bridge, token);
      if (alive.current && sequence === operation.current) { setState(value); setStateUnavailable(false); setToken(''); onStateChange(value); setNotice(value.canCreate ? '许可已激活，可继续新建任务。' : '许可状态已更新，请核对有效期和本机状态。'); }
    } catch (cause) { if (alive.current && sequence === operation.current) setError((cause instanceof Error ? cause.message : String(cause)).replaceAll(token.trim() || '\0', t('已隐藏的激活码'))); }
    finally { if (alive.current && sequence === operation.current) setActivating(false); }
  };
  const copy = async (kind: 'device' | 'request') => {
    if (loading || activating || stateUnavailable) return;
    const info = createLicenseRequestInfo(state, appVersion, stateUnavailable);
    const device = state?.mode === 'required' && state.deviceCode && LICENSE_DEVICE_PATTERN.test(state.deviceCode) ? state.deviceCode : null;
    const sequence = operation.current;
    const result = await copyLicenseInfo(kind === 'device' ? device : info, navigator.clipboard, () => {
      selectLicenseCopyFallback(panel.current, kind);
    });
    if (alive.current && sequence === operation.current && result !== 'unavailable') {
      setNotice(result === 'copied' ? kind === 'device' ? '设备码已复制。' : '签发信息已复制。' : kind === 'device' ? '无法自动复制，请选择设备码后手动复制。' : '无法自动复制，已选中签发信息，请使用系统复制快捷键。');
    }
  };
  return <div className="license-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={panel} className="license-panel" role="dialog" aria-modal="true" aria-labelledby="license-title"><header><div><h2 id="license-title"><KeyRound size={21} />{t('授权与体验许可')}</h2><p>{t('查看本机许可、设备码与有效期，或激活离线许可。')}</p></div><button type="button" className="icon-button" aria-label={t('关闭许可窗口')} onClick={onClose}><X size={20} /></button></header><LicenseStatusView state={state} loading={loading} activating={activating} error={error} stateUnavailable={stateUnavailable} notice={notice} token={token} appVersion={appVersion} onTokenChange={setToken} onRefresh={() => void read()} onActivate={() => void activate()} onCopy={() => void copy('device')} onCopyRequest={() => void copy('request')} /></section></div>;
}
