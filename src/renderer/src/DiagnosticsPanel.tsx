import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, FileText, Info, LoaderCircle, X } from 'lucide-react';
import type { ContractAssistantBridge } from '../../shared/contracts';
import { useI18n } from './i18n';

export interface DiagnosticsExportResult { path: string; fileName?: string; bytes?: number }
export type DiagnosticsExportFeedback = 'idle' | 'saving' | 'cancelled' | 'saved' | 'failed';
const INVALID_EXPORT = '日志未能保存，请重新选择保存位置后重试。';

/** Only a confirmed native save is success. Closing the system picker is not
 * evidence that a file was created, and preview pages cannot export logs. */
export async function requestDiagnosticsExport(bridge: Pick<ContractAssistantBridge, 'runWorkspaceCommand'>, isPreview = false): Promise<DiagnosticsExportResult | null> {
  if (isPreview) throw new Error('请在已安装的软件中导出问题日志。');
  const result: unknown = await bridge.runWorkspaceCommand({ action: 'maintenance.exportDiagnostics', payload: {} });
  if (result === null) return null;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(INVALID_EXPORT);
  const value = result as Record<string, unknown>;
  if (typeof value.path !== 'string' || !value.path || value.path.length > 32_768 || /[\u0000-\u001f]/u.test(value.path)
    || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(value.path)
    || value.fileName !== undefined && (typeof value.fileName !== 'string' || !value.fileName.trim() || value.fileName.length > 1024 || /[\u0000-\u001f]/u.test(value.fileName))
    || value.bytes !== undefined && (typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0)) throw new Error(INVALID_EXPORT);
  return { path: value.path, ...(typeof value.fileName === 'string' ? { fileName: value.fileName } : {}), ...(typeof value.bytes === 'number' ? { bytes: value.bytes } : {}) };
}

interface DiagnosticsContentProps {
  isPreview: boolean;
  feedback: DiagnosticsExportFeedback;
  result: DiagnosticsExportResult | null;
  onExport: () => void;
}
export function DiagnosticsContentView({ isPreview, feedback, result, onExport }: DiagnosticsContentProps) {
  const { t } = useI18n();
  const busy = feedback === 'saving';
  const fileName = result?.fileName ?? result?.path.split(/[\\/]/u).at(-1);
  return <div className="diagnostics-content" aria-busy={busy}>
    <div className="diagnostics-intro"><FileText size={23} /><div><h3>{t('遇到问题时，把日志文件交给支持人员')}</h3><p>{t('保存一份软件运行记录，帮助排查打不开、卡住或操作失败等问题。')}</p></div></div>
    <section className="diagnostics-privacy" aria-labelledby="diagnostics-privacy-title"><h3 id="diagnostics-privacy-title"><Info size={16} />{t('文件中会记录什么')}</h3><p>{t('记录软件版本、启动和任务状态等排查信息，不包含合同正文、激活码或服务密钥。')}</p><p>{t('日志只在本机保存，不会自动上传。是否提供给支持人员，由您决定。')}</p></section>
    {isPreview && <p className="diagnostics-note" role="status">{t('当前是界面预览，请在已安装的软件中导出问题日志。')}</p>}
    {!isPreview && <><p className="diagnostics-note">{t('即使授权已到期，或当前无法打开合同，也可以尝试保存日志。')}</p><p className="diagnostics-note">{t('启动异常时，可能只有启动记录；日志不一定包含全部操作过程。')}</p></>}
    <button type="button" className="button primary diagnostics-export" disabled={busy || isPreview} onClick={onExport}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}{busy ? t('正在保存日志…') : t('保存日志文件')}</button>
    {feedback === 'saving' && <p className="diagnostics-feedback" role="status">{t('请在弹出的窗口中选择保存位置，也可以取消。')}</p>}
    {feedback === 'cancelled' && <p className="diagnostics-feedback" role="status">{t('已取消保存，没有生成新的日志文件。')}</p>}
    {feedback === 'failed' && <p className="diagnostics-feedback error" role="alert">{t('日志未能保存。请换一个保存位置后重试；若仍失败，请重启软件后再试。')}</p>}
    {feedback === 'saved' && result && <div className="diagnostics-feedback success" role="status"><strong>{t('日志已保存，可将文件提供给支持人员。')}</strong><p>{fileName}</p><details><summary>{t('查看保存位置')}</summary><code>{result.path}</code></details></div>}
  </div>;
}

export default function DiagnosticsPanel({ bridge, isPreview, onClose }: { bridge: ContractAssistantBridge; isPreview: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [feedback, setFeedback] = useState<DiagnosticsExportFeedback>('idle');
  const [result, setResult] = useState<DiagnosticsExportResult | null>(null);
  const panel = useRef<HTMLElement>(null), alive = useRef(false), running = useRef(false);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    alive.current = true;
    const previous = window.document.activeElement;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary') ?? []];
      const first = controls[0], last = controls.at(-1), current = window.document.activeElement;
      if (event.shiftKey && (current === first || !panel.current?.contains(current))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (current === last || !panel.current?.contains(current))) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', keydown);
    return () => { alive.current = false; cancelAnimationFrame(frame); window.removeEventListener('keydown', keydown); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const save = async () => {
    if (running.current || isPreview) return;
    running.current = true; setResult(null); setFeedback('saving');
    try {
      const value = await requestDiagnosticsExport(bridge);
      if (alive.current) { setResult(value); setFeedback(value === null ? 'cancelled' : 'saved'); }
    } catch {
      // Connector/system messages may include sensitive strings. Keep those
      // out of the interface and offer an ordinary retry instruction instead.
      if (alive.current) setFeedback('failed');
    } finally { running.current = false; }
  };
  return <div className="diagnostics-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close.current(); }}><section className="diagnostics-panel" ref={panel} role="dialog" aria-modal="true" aria-labelledby="diagnostics-title"><header><div><h2 id="diagnostics-title"><FileText size={21} />{t('导出问题日志')}</h2><p>{t('保存排查文件，方便联系支持人员。')}</p></div><button type="button" className="icon-button" aria-label={t('关闭问题日志窗口')} onClick={() => close.current()}><X size={20} /></button></header><DiagnosticsContentView isPreview={isPreview} feedback={feedback} result={result} onExport={() => void save()} /></section></div>;
}
