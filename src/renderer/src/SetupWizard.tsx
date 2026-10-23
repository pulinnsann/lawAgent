import { useI18n } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Check, CircleAlert, CircleCheck, FolderOpen, Info, LoaderCircle, MonitorCheck, Settings2, ShieldCheck, X } from 'lucide-react';
import type { ContractAssistantBridge, PublicRetrievalConfig } from '../../shared/contracts';
import type { EnvironmentReport } from '../../shared/setup';
import type { KnowledgePreferences } from '../../shared/knowledge';
import { defaultKnowledgePreferences, normalizeKnowledgePreferences } from '../../shared/knowledge-preferences';
import LocalKnowledgePanel from './LocalKnowledgePanel';

type Feedback = { kind: 'success' | 'error' | 'info'; text: string };
const statusLabels = { passed: '通过', warning: '有提示', failed: '失败', unavailable: '未检测' };
const fileTypeLabels: Array<{ value: KnowledgePreferences['fileTypes'][number]; label: string }> = [
  { value: 'txt', label: 'TXT 文本' }, { value: 'md', label: 'Markdown' }, { value: 'docx', label: 'Word 文档' }, { value: 'pdf', label: 'PDF 文档' },
];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function SetupWizard({ bridge, config, isPreview, onClose, onSaved, onModelSettings, onAdvanced }: {
  bridge: ContractAssistantBridge;
  config: PublicRetrievalConfig | null | undefined;
  isPreview: boolean;
  onClose: () => void;
  onSaved: (config: PublicRetrievalConfig) => void;
  onModelSettings: () => void;
  onAdvanced: () => void;
}) {
  const { t, translateMessage, dateLocale } = useI18n();

  const [preferences, setPreferences] = useState<KnowledgePreferences>(() => structuredClone(config?.knowledge.preferences ?? defaultKnowledgePreferences()));
  const [folderPath, setFolderPath] = useState(config?.knowledge.folderPath ?? '');
  const [excludeText, setExcludeText] = useState(() => (config?.knowledge.preferences?.excludeDirectories ?? []).join('\n'));
  const [report, setReport] = useState<EnvironmentReport | null>(null);
  const [busy, setBusy] = useState<'environment' | 'folder' | 'save' | 'build' | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [knowledgeRunning, setKnowledgeRunning] = useState(false);
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const environmentRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  const mounted = useRef(true);
  closeRef.current = onClose; busyRef.current = busy;

  useEffect(() => {
    mounted.current = true;
    const focused = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.querySelector<HTMLButtonElement>('.environment-check-button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) closeRef.current();
      if (event.key !== 'Tab') return;
      const elements = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button,input,textarea,select,summary') ?? [])
        .filter((element) => !element.matches(':disabled') && element.getClientRects().length > 0);
      const first = elements[0]; const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { mounted.current = false; document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); focused?.focus(); };
  }, []);

  const savedPreferences = config?.knowledge.preferences ?? defaultKnowledgePreferences();
  let normalizedDraft: KnowledgePreferences | null = null;
  try { normalizedDraft = normalizeKnowledgePreferences({ ...preferences, excludeDirectories: excludeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) }); } catch { /* Draft validation appears when the user saves. */ }
  const saved = Boolean(folderPath && folderPath === config?.knowledge.folderPath && normalizedDraft
    && JSON.stringify(normalizedDraft) === JSON.stringify(normalizeKnowledgePreferences(savedPreferences)));
  const fieldsDisabled = Boolean(busy || knowledgeRunning);
  const change = (patch: Partial<KnowledgePreferences>) => { setPreferences((value) => ({ ...value, ...patch })); setFeedback(null); };

  const checkEnvironment = async () => {
    setBusy('environment'); setFeedback(null); setReport(null);
    try {
      const next = await bridge.checkEnvironment();
      if (!mounted.current) return;
      setReport(next);
      if (next.isPreview) setFeedback({ kind: 'info', text: t("浏览器只展示配置界面，尚未检查或初始化本机环境。请在桌面应用中操作。") });
      else if (next.ready) setFeedback({ kind: 'success', text: t("本机环境已就绪。可以选择资料目录并保存知识库设置。") });
      else setFeedback({ kind: 'error', text: t("环境尚未就绪。请查看检查结果，处理失败项后再次检查；也可以先保存知识库设置。") });
    } catch (error) { if (mounted.current) setFeedback({ kind: 'error', text: message(error) }); }
    finally { if (mounted.current) setBusy(null); }
  };
  const selectFolder = async () => {
    setBusy('folder'); setFeedback(null);
    try { const folder = await bridge.selectKnowledgeFolder(); if (mounted.current && folder) setFolderPath(folder); }
    catch (error) { if (mounted.current) setFeedback({ kind: 'error', text: message(error) }); }
    finally { if (mounted.current) setBusy(null); }
  };
  const save = async (buildNow: boolean) => {
    if (isPreview || fieldsDisabled) return;
    if (formRef.current && !formRef.current.reportValidity()) return;
    if (!folderPath) { setFeedback({ kind: 'error', text: t("请通过“选择资料目录”授权需要读取的本地文件夹。") }); return; }
    if (buildNow && (!report?.ready || report.isPreview)) {
      setFeedback({ kind: 'info', text: t("请先点击“检查并初始化环境”，通过后再建立知识库。") });
      environmentRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return;
    }
    let normalized: KnowledgePreferences;
    try { normalized = normalizeKnowledgePreferences({ ...preferences, excludeDirectories: excludeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) }); }
    catch (error) { setFeedback({ kind: 'error', text: message(error) }); return; }
    setBusy(buildNow ? 'build' : 'save'); setFeedback(null);
    try {
      const result = await bridge.configureLocalKnowledge({ folderPath, preferences: normalized, buildNow });
      if (!mounted.current) return;
      onSaved(result.config);
      const next = structuredClone(result.config.knowledge.preferences ?? defaultKnowledgePreferences());
      setPreferences(next); setExcludeText(next.excludeDirectories.join('\n')); setFolderPath(result.config.knowledge.folderPath ?? folderPath);
      if (result.jobId) { setStartedJobId(result.jobId); setKnowledgeRunning(true); }
      if (result.buildError) setFeedback({ kind: 'error', text: t("配置已保存，建库未启动：{v0}。可处理后重试。", { v0: result.buildError }) });
      else if (result.jobId) setFeedback({ kind: 'success', text: t("配置已保存，知识库同步任务已启动。下方显示实际阶段、计数和取消入口。") });
      else setFeedback({ kind: 'success', text: buildNow ? '配置已保存。本次未返回新的建库任务，请查看知识库状态。' : '个性化配置已保存。首次使用请建立知识库；范围变更后请更新索引。' });
      setTimeout(() => statusRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0);
    } catch (error) { if (mounted.current) setFeedback({ kind: 'error', text: message(error) }); }
    finally { if (mounted.current) setBusy(null); }
  };

  return <div className="settings-overlay setup-wizard-overlay">
    <button className="settings-scrim" aria-label={t("关闭环境与知识库配置")} onClick={onClose} disabled={!!busy} />
    <div className="settings-panel setup-wizard-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="setup-wizard-title">
      <div className="settings-heading"><div><span className="eyebrow">{t("WORKSPACE SETUP")}</span><h2 id="setup-wizard-title">{t("环境与知识库配置")}</h2></div><button type="button" className="icon-button" aria-label={t("关闭环境与知识库配置")} onClick={onClose} disabled={!!busy}><X size={21} /></button></div>
      <div className="settings-body setup-wizard-body">
        <div className="setup-intro"><div><MonitorCheck size={23} /></div><section><h3>{t("打开软件，按步骤完成配置")}</h3><p>{t("桌面版自带所需运行环境。打开软件后，点击检查即可初始化本机存储和检索组件，再选择你自己的资料目录。")}</p><span><ShieldCheck size={12} />{t("本地建库和检索无需模型 API")}</span></section></div>
        {isPreview && <div className="settings-preview"><Info size={15} />{t("浏览器界面预览不检查本机运行环境、不读取资料，也不能保存或建立真实知识库。请在桌面应用中使用这些按钮。")}</div>}
        <section className="setup-section" ref={environmentRef} aria-labelledby="setup-environment-title"><div className="setup-section-heading"><span className="setup-step-number">1</span><div><h3 id="setup-environment-title">{t("检查本机环境")}</h3><p>{t("结果来自桌面服务的实际检测；失败项可以修复后重试。")}</p></div></div><button type="button" className="button secondary environment-check-button" disabled={fieldsDisabled} onClick={() => void checkEnvironment()}>{busy === 'environment' ? <LoaderCircle className="spin" size={15} /> : <MonitorCheck size={15} />}{busy === 'environment' ? t("正在检查与初始化…") : t("检查并初始化环境")}</button>
          {report ? <div className="environment-report" role="status"><div className="environment-report-heading"><strong>{report.isPreview ? t("浏览器预览 · 未执行本机检测") : report.ready ? t("环境已就绪") : t("环境尚未就绪")}</strong><span>{new Date(report.checkedAt).toLocaleString(dateLocale, { hour12: false })}</span></div><ul>{report.checks.map((check) => <li key={check.id} className={`environment-check ${check.status}`}><div className="environment-check-icon">{check.status === 'passed' ? <CircleCheck size={15} /> : check.status === 'failed' ? <CircleAlert size={15} /> : <Info size={15} />}</div><div><strong>{translateMessage(check.label)}<span>{t(statusLabels[check.status])}</span></strong><p>{translateMessage(check.message)}</p></div></li>)}</ul></div> : <p className="setup-check-pending">{t("尚未执行检查。点击上方按钮开始。")}</p>}
        </section>
        <section className="setup-section" aria-labelledby="setup-preferences-title"><div className="setup-section-heading"><span className="setup-step-number">2</span><div><h3 id="setup-preferences-title">{t("配置自己的知识库")}</h3><p>{t("这些设置控制本机资料的读取范围和自动更新方式。")}</p></div></div>
          <form ref={formRef} className="setup-preferences-form" onSubmit={(event) => { event.preventDefault(); void save(true); }}><fieldset className="setup-fields" disabled={fieldsDisabled}>
            <label className="field"><span>{t("知识库名称")}</span><input aria-label={t("知识库名称")} required maxLength={60} value={preferences.displayName} onChange={(event) => change({ displayName: event.target.value })} placeholder={t("例如：公司合同与合规资料库")} /></label>
            <label className="field"><span>{t("资料目录")}</span><div className="folder-selector"><input aria-label={t("资料目录")} readOnly value={folderPath} placeholder={t("选择存放本地资料的文件夹")} title={folderPath} /><button type="button" className="button secondary small" onClick={() => void selectFolder()} disabled={isPreview}><FolderOpen size={14} />{t("选择资料目录")}</button></div><span className="field-help">{t("通过系统窗口授权目录。只读读取资料，保留源文件。")}</span></label>
            <fieldset className="setup-file-types"><legend>{t("读取的文件类型")}</legend><div>{fileTypeLabels.map(({ value, label }) => <label key={value}><input type="checkbox" checked={preferences.fileTypes.includes(value)} onChange={(event) => change({ fileTypes: event.target.checked ? [...preferences.fileTypes, value] : preferences.fileTypes.filter((type) => type !== value) })} />{t(label)}</label>)}</div><p>{t("至少选择一种。扫描型 PDF 仍需要先提供可提取文字的版本。")}</p></fieldset>
            <label className="field"><span>{t("排除目录（相对路径，一行一项）")}</span><textarea aria-label={t("排除目录（相对路径，一行一项）")} value={excludeText} maxLength={16416} rows={3} placeholder={t("归档\n人事/敏感资料")} onChange={(event) => { setExcludeText(event.target.value); setFeedback(null); }} spellCheck={false} /><span className="field-help">{t("相对于上方资料目录，最多 32 项；不支持绝对路径、上级路径或通配符。")}</span></label>
            <p className="field-help">{t("更改资料目录、格式、排除目录或大小上限，会取消正在进行的模型审核；请按新范围重新开始。")}</p>
            <label className="setup-auto-sync"><input aria-label={t("启用自动同步")} type="checkbox" checked={preferences.autoSyncEnabled} onChange={(event) => change({ autoSyncEnabled: event.target.checked })} /><span>{t("启用自动同步")}<small>{t("首次手动建库后，应用空闲时按设定间隔增量更新。")}</small></span></label>
            <div className="setup-number-fields"><label className="field"><span>{t("同步间隔（分钟）")}</span><input aria-label={t("同步间隔（分钟）")} required type="number" min={5} max={1440} step={1} disabled={!preferences.autoSyncEnabled} value={preferences.syncIntervalMinutes || ''} onChange={(event) => change({ syncIntervalMinutes: Number(event.target.value) })} /><span className="field-help">{t("5–1440 分钟")}</span></label><label className="field"><span>{t("单文件上限（MiB）")}</span><input aria-label={t("单文件上限（MiB）")} required type="number" min={1} max={50} step={1} value={preferences.maxFileSizeMb || ''} onChange={(event) => change({ maxFileSizeMb: Number(event.target.value) })} /><span className="field-help">{t("1–50 MiB，超过上限会跳过并记录")}</span></label></div>
          </fieldset></form>
          {knowledgeRunning && <p className="knowledge-inline-note"><LoaderCircle className="spin" size={13} />{t("知识库正在同步，配置字段已暂时锁定；可以在下方取消同步。")}</p>}
        </section>
        <section className="setup-section setup-index-section" ref={statusRef} aria-labelledby="setup-index-title"><div className="setup-section-heading"><span className="setup-step-number">3</span><div><h3 id="setup-index-title">{t("查看知识库状态")}</h3><p>{t("此处显示已保存知识库的真实状态，可取消任务或测试关键词。")}</p></div></div><LocalKnowledgePanel bridge={bridge} folderPath={folderPath || null} saved={saved} isPreview={isPreview} preferences={savedPreferences} startedJobId={startedJobId} onRunningChange={setKnowledgeRunning} /></section>
        <div className="setup-other-connections"><h3>{t("继续配置其他连接")}</h3><p>{t("需要模型审核时，再接入你自己的模型 API；外部知识库和互联网检索可在高级设置中管理。")}</p><div><button type="button" className="text-button" onClick={onModelSettings} disabled={!!busy}><Settings2 size={13} />{t("模型设置")}<ArrowRight size={12} /></button><button type="button" className="text-button" onClick={onAdvanced} disabled={fieldsDisabled}><BookOpen size={13} />{t("外部知识库与搜索高级设置")}<ArrowRight size={12} /></button></div></div>
      </div>
      <div className="settings-footer setup-wizard-footer">{feedback && <div className={`notice settings-notice ${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.kind === 'error' ? <CircleAlert size={15} /> : feedback.kind === 'success' ? <CircleCheck size={15} /> : <Info size={15} />}<span>{translateMessage(feedback.text)}</span></div>}{!feedback && <p className="setup-footer-help">{isPreview ? t("当前是浏览器预览，真实初始化和建库请在桌面应用中执行。") : knowledgeRunning ? t("同步会在后台继续；下方状态面板可查看进度和取消。") : !report?.ready ? t("先检查环境，再保存并建立知识库。") : t("保存配置时保留已有的模型、外部知识库和搜索连接。")}</p>}<div className="settings-footer-actions"><button type="button" className="button secondary" onClick={() => void save(false)} disabled={isPreview || fieldsDisabled}>{busy === 'save' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{t("仅保存配置")}</button><button type="button" className="button primary" onClick={() => void save(true)} disabled={isPreview || fieldsDisabled || !report?.ready || report.isPreview}>{busy === 'build' || knowledgeRunning ? <LoaderCircle className="spin" size={14} /> : <BookOpen size={14} />}{knowledgeRunning ? t("知识库正在同步") : t("保存并建立知识库")}</button></div></div>
    </div>
  </div>;
}
