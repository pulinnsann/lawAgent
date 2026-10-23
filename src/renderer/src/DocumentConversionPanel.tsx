import { useI18n } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Download, FileScan, LoaderCircle, Save, Square, X } from 'lucide-react';
import type { ContractAssistantBridge, ContractDetail } from '../../shared/contracts';
import { defaultConversionSettings, type ConversionProgress, type ConversionSettings, type ConversionStatus, type OcrLanguage } from '../../shared/document-conversion';
import './document-conversion.css';

const names: Record<OcrLanguage, string> = { chi_sim: '简体中文', eng: '英文', tha: '泰文' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
export default function DocumentConversionPanel({ bridge, document, onClose, onImported }: { bridge: ContractAssistantBridge; document: ContractDetail | null; onClose: () => void; onImported?: (document: ContractDetail) => void }) {
  const { t, translateMessage, dateLocale } = useI18n();

  const [status, setStatus] = useState<ConversionStatus | null>(null);
  const [settings, setSettings] = useState<ConversionSettings>(defaultConversionSettings());
  const [busy, setBusy] = useState<string | null>('load');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ConversionProgress | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [closeWarning, setCloseWarning] = useState(false);
  const alive = useRef(true); const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const dirty = Boolean(status) && JSON.stringify(settings) !== JSON.stringify(status!.settings.body);
  const call = (action: string, payload: unknown, id?: string) => bridge.runWorkspaceCommand({ action, payload, ...(id ? { requestId: id } : {}) });
  useEffect(() => { alive.current = true; void call('conversion.status', {}).then(value => { if (alive.current) { setStatus(value as ConversionStatus); setSettings((value as ConversionStatus).settings.body); } }).catch(error => { if (alive.current) setNotice({ kind: 'error', text: messageOf(error) }); }).finally(() => { if (alive.current) setBusy(null); }); return () => { alive.current = false; if (timer.current) clearInterval(timer.current); }; }, [bridge]);
  const startProgress = (id: string) => {
    setRequestId(id); setProgress(null);
    if (timer.current) clearInterval(timer.current);
    let pending = false;
    timer.current = setInterval(() => { if (pending) return; pending = true; void call('workspace.progress', { requestId: id }).then(value => { if (!alive.current || !value) return; const object = value as { progress?: ConversionProgress }; const next = object.progress ?? value as ConversionProgress; if (next && typeof next.message === 'string') setProgress(next); }).catch(() => {}).finally(() => { pending = false; }); }, 700);
  };
  const stopProgress = () => { if (timer.current) clearInterval(timer.current); timer.current = null; setRequestId(null); };
  const save = async () => {
    if (busy || !status || !settings.languages.length) return; setBusy('save'); setNotice(null);
    try { const value = await call('conversion.settings.save', { ...(status.settings.id ? { id: status.settings.id } : {}), expectedRevision: status.settings.revision, body: settings, actorLabel: '法务' }) as ConversionStatus; if (alive.current) { setStatus(value); setSettings(value.settings.body); setNotice({ kind: 'success', text: t("本机 PDF 转换配置已保存。") }); } }
    catch (error) { if (alive.current) setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { if (alive.current) setBusy(null); }
  };
  const download = async () => {
    if (busy || !settings.languages.length) return; setBusy('download'); setNotice(null); const id = crypto.randomUUID(); startProgress(id);
    try { const value = await call('conversion.download', { languages: settings.languages, confirmed: true }, id) as ConversionStatus; if (alive.current) { setStatus(value); setNotice({ kind: 'success', text: t("所选 OCR 语言包已安装到本机，之后识别不需要联网。") }); } }
    catch (error) { if (alive.current) setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { stopProgress(); if (alive.current) setBusy(null); }
  };
  const convert = async () => {
    if (busy || !document || document.format !== 'pdf' || !settings.languages.length) return;
    setBusy('convert'); setNotice(null); const id = crypto.randomUUID(); startProgress(id);
    try {
      const result = await call('conversion.convert', { documentId: document.id, settings, confirmed: true }, id) as { document?: ContractDetail; path?: string; warnings?: string[]; partial?: boolean; cancelled?: boolean } | null;
      if (alive.current) { if (!result || result.cancelled) setNotice({ kind: 'info', text: t("已取消转换或保存。") }); else { if (result.document) onImported?.(result.document); setNotice({ kind: 'success', text: t("转换稿已生成{v0}。{v1}{v2}", { v0: result.document ? '并作为独立合同导入' : '', v1: result.partial ? '包含未识别页，请先对照 PDF 补齐。' : '请逐页核对金额、日期、主体、表格和签章内容后使用。', v2: result.path ? ` 文件：${result.path}` : '' }) }); } }
    } catch (error) { if (alive.current) setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { stopProgress(); if (alive.current) setBusy(null); }
  };
  const cancel = async () => { if (!requestId) return; try { await call('workspace.cancel', { requestId }); if (alive.current) setNotice({ kind: 'info', text: t("已请求停止，正在释放本机识别资源。") }); } catch (error) { if (alive.current) setNotice({ kind: 'error', text: messageOf(error) }); } };
  const update = <K extends keyof ConversionSettings>(key: K, value: ConversionSettings[K]) => { setSettings(previous => ({ ...previous, [key]: value })); setCloseWarning(false); };
  const close = () => { if (dirty && !closeWarning) { setCloseWarning(true); setNotice({ kind: 'info', text: t("当前转换配置尚未保存。可先保存配置；再次点击关闭将放弃本次配置修改。") }); return; } onClose(); };
  return <section className="card conversion-panel" aria-label={t("PDF 转换与本机 OCR")}><header className="conversion-heading"><div><FileScan size={20} /><h2>{t("PDF 转换与本机 OCR")}</h2></div><button className="text-button" disabled={Boolean(busy)} onClick={close}><X size={16} />{t("关闭")}</button></header>
    <p className="conversion-intro">{t("将 PDF 文字或本机识别结果生成独立 DOCX，之后可审核、逐项修改和导出。转换稿保留原 PDF 页码来源，原 PDF 单独保留；表格、签章、图片和版式需要对照原件检查。")}</p>
    {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`notice ${notice.kind}`}>{translateMessage(notice.text)}</p>}
    <div className="conversion-layout"><div className="conversion-form">
      <p className="conversion-document"><strong>{t("当前文件")}</strong><span>{document?.name ?? t("尚未选择 PDF")}</span>{document && document.format !== 'pdf' && <small>{t("请返回合同列表选择 PDF 文件后使用转换功能。")}</small>}</p>
      <label className="field"><span>{t("转换方式")}</span><select aria-label={t("PDF 转换方式")} value={settings.mode} disabled={Boolean(busy)} onChange={event => update('mode', event.target.value as ConversionSettings['mode'])}><option value="auto">{t("优先文字层，无文字页使用本机 OCR")}</option><option value="text">{t("仅提取保存的文字层")}</option><option value="ocr">{t("全部页重新使用本机 OCR")}</option></select><small>{t("自动模式不会识别已有文字页中的图片；若正文扫描图叠加了页眉文字，可选择全部页 OCR。")}</small></label>
      <fieldset disabled={Boolean(busy)}><legend>{t("OCR 识别语言")}</legend>{Object.entries(names).map(([language, name]) => <label className="conversion-check" key={language}><input type="checkbox" checked={settings.languages.includes(language as OcrLanguage)} onChange={event => update('languages', event.target.checked ? [...settings.languages, language as OcrLanguage] : settings.languages.filter(value => value !== language))} />{t(name)}</label>)}</fieldset>
      <div className="conversion-budget-grid"><label className="field"><span>{t("最大页数")}</span><input aria-label={t("PDF 最大页数")} type="number" min={1} max={100} value={settings.maxPages} disabled={Boolean(busy)} onChange={event => update('maxPages', Number(event.target.value))} /></label><label className="field"><span>{t("识别 DPI")}</span><input aria-label="OCR DPI" type="number" min={120} max={240} value={settings.dpi} disabled={Boolean(busy)} onChange={event => update('dpi', Number(event.target.value))} /></label><label className="field"><span>{t("单步骤秒数预算")}</span><input aria-label={t("OCR 单页时间预算")} type="number" min={15} max={180} value={settings.pageTimeoutSeconds} disabled={Boolean(busy)} onChange={event => update('pageTimeoutSeconds', Number(event.target.value))} /></label></div>
      <label className="conversion-check"><input type="checkbox" checked={settings.allowPartial} disabled={Boolean(busy)} onChange={event => update('allowPartial', event.target.checked)} />{t("允许保留未识别页提示并生成部分转换稿")}</label>
      {settings.allowPartial && <p className="conversion-note">{t("未识别页不会补造文字，转换稿会标出原 PDF 页码；整份没有识别出文字时仍停止。部分转换稿应人工补齐后再审核。")}</p>}
      <div className="conversion-actions"><button className="button secondary" disabled={Boolean(busy) || !status || !dirty || !settings.languages.length} onClick={() => void save()}><Save size={15} />{t("保存转换配置")}</button><button className="button primary" disabled={Boolean(busy) || !document || document.format !== 'pdf' || !settings.languages.length} onClick={() => void convert()}>{busy === 'convert' ? <LoaderCircle size={15} className="spin" /> : <FileScan size={15} />}{t("生成并导入 DOCX")}</button></div>
    </div><aside className="conversion-models"><h3>{t("本机离线识别环境")}</h3><p>{t("仅点击下面的下载按钮时访问 Tesseract 官方模型仓库，下载所选语言包。合同内容留在本机，转换时不会自动下载模型。")}</p><p className="conversion-path">{t("模型目录")}{status?.modelDirectory ?? t("正在读取")}</p>{status?.models.map(model => <div className="conversion-model" key={model.language}><strong>{t(names[model.language])}</strong><span>{model.ready ? t("已就绪 · {v0} MiB", { v0: (model.byteSize / 1024 / 1024).toFixed(1) }) : t("未安装或文件无效")}</span>{model.sha256 && <small>SHA256 {model.sha256}</small>}</div>)}<button className="button secondary" disabled={Boolean(busy) || !settings.languages.length} onClick={() => void download()}>{busy === 'download' ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{t("下载所选离线语言包")}</button>
      <p className="conversion-note">{t("识别质量受原件清晰度、语言和阅读顺序影响。金额、日期、主体名称及手写内容需人工校对，识别置信度不表示法律判断正确。")}</p>
    </aside></div>
    {requestId && <div className="conversion-progress" role="status"><div><LoaderCircle size={16} className="spin" /><span>{progress?.message ?? t("本机任务准备中")}</span></div>{progress && <progress aria-label={t("PDF 转换进度")} max={1} value={progress.pageCount > 0 ? Math.min(1, ((progress.pageNumber - 1) + progress.progress) / progress.pageCount) : progress.progress} />}<button className="button secondary small" onClick={() => void cancel()}><Square size={13} />{t("停止任务")}</button></div>}
  </section>;
}
