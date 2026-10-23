import { useI18n } from './i18n';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Check, CheckCheck, ChevronDown,
  ChevronRight, CircleAlert, CircleCheck, CircleHelp, Clock3, FileCheck2, FilePlus2,
  FileSearch, FileText, FlaskConical, FolderClosed, Globe2, Info, KeyRound, Layers3,
  LoaderCircle, LockKeyhole, MonitorCheck, PanelLeftClose, Search, Settings2, ShieldCheck, Sparkles,
  Square, Upload, X,
} from 'lucide-react';
import type {
  AppState, ContractAssistantBridge, ContractDetail, ModelConfigInput, PublicModelConfig,
  ReviewContext, ReviewFinding, ReviewResult, ReviewTask, Severity, SourceEvidence,
} from '../../shared/contracts';
import { defaultRetrievalConfig } from '../../shared/contracts';
import { createPreviewBridge } from './preview-bridge';
import RetrievalSettings from './RetrievalSettings';
import SetupWizard from './SetupWizard';
import { RetrievalStatusBadge, ReviewSources, SourceEvidenceCard } from './RetrievalSources';
import ChangesPanel from './ChangesPanel';
import ContractGenerationPanel from './ContractGenerationPanel';
import EnterpriseStandardsPanel from './EnterpriseStandardsPanel';
import RiskDispositionPanel from './RiskDispositionPanel';
import ProgramChecksPanel from './ProgramChecksPanel';
import ReportingPanel from './ReportingPanel';
import LibraryPanel from './LibraryPanel';
import ConnectionsPanel from './ConnectionsPanel';
import MaintenancePanel from './MaintenancePanel';
import DocumentConversionPanel from './DocumentConversionPanel';
import DocumentWorkspacePanel from './DocumentWorkspacePanel';
import ClauseAlignmentPanel from './ClauseAlignmentPanel';
import ReviewCompletionPanel from './ReviewCompletionPanel';
import ModelRuntimePanel from './ModelRuntimePanel';
import TaskRequirementsEditor from './TaskRequirementsEditor';
import { APP_VERSION } from '../../shared/app-version';
import ReviewFreshnessNotice from './ReviewFreshnessNotice';
import type { ReviewFreshness } from '../../shared/review-completion';
import './workspace-tools.css';
import './interface-shell.css';
import type { EnterpriseStandardSummary, EnterpriseStandardSnapshot } from '../../shared/assurance';
import './model-settings.css';

const languages = { zh: '中文', en: '英文', th: '泰文', mixed: '多语言', unknown: '待识别' };
const severities: Record<Severity, string> = { high: '高风险', medium: '中风险', low: '低风险', unrated: '待判断' };
const categories = { legal: '法律问题', commercial: '商业风险', operational: '履约事项' };
const contractTypes = { procurement: '采购合同', service: '服务合同', other: '其他业务合同' };
const partyRoles = { buyer: '采购方 / 买方', seller: '供应方 / 卖方', service_provider: '服务提供方', service_recipient: '服务接受方', other: '其他立场' };
const strictnessLabels = { cautious: '审慎偏好', balanced: '平衡偏好', pragmatic: '务实偏好' };
const initialContext: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', businessContext: '', strictness: 'balanced', longContractMode: 'batch' };
const emptyState: AppState = { documents: [], modelConfig: null, tasks: [], isPreview: !window.contractAssistant, appVersion: APP_VERSION };

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function newestReview(document: ContractDetail | null): ReviewResult | null { return document ? [...document.reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null : null; }
function taskIsActive(task?: ReviewTask | null) { return task?.status === 'queued' || task?.status === 'running'; }
function stageLabel(stage: string) {
  const labels: Record<string, string> = { queued: '等待处理', preparing: '准备合同内容', analyzing: '分析合同条款', validating: '核验输出与原文定位', saving: '保存审核结果', completed: '审核完成', local_rules: '执行本地规则检查', model_request: '等待模型响应', parsing: '解析文档', cancelled: '已取消' };
  return labels[stage] ?? stage;
}

type Notice = { kind: 'success' | 'error' | 'info'; text: string };

export default function App() {
  const { t, translateMessage, dateLocale, locale, setLocale, formatDate } = useI18n();

  const bridgeRef = useRef<ContractAssistantBridge | null>(null);
  if (!bridgeRef.current) bridgeRef.current = window.contractAssistant ?? createPreviewBridge();
  const bridge = bridgeRef.current;
  useEffect(()=>{void bridge.runWorkspaceCommand({action:'workspace.interfaceLocale',payload:{locale}}).catch(()=>{});},[bridge,locale]);
  const [appState, setAppState] = useState<AppState>(emptyState);
  const [document, setDocument] = useState<ContractDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [context, setContext] = useState<ReviewContext>(initialContext);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [retrievalSettingsOpen, setRetrievalSettingsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [workspaceTool, setWorkspaceTool] = useState<'menu'|'reports'|'library'|'connections'|'conversion'|'maintenance'|'documents'|'completion'|'runtime'|'alignment'|null>(null);
  const [generationOpen, setGenerationOpen] = useState(false);
  const [standardsOpen, setStandardsOpen] = useState(false);
  const [standards, setStandards] = useState<EnterpriseStandardSummary[]>([]);
  const [standardVersionId, setStandardVersionId] = useState('');
  const [workflowStandard,setWorkflowStandard]=useState<EnterpriseStandardSnapshot|null>(null);
  const [freshness,setFreshness]=useState<ReviewFreshness|null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedFinding, setSelectedFinding] = useState<string | null>(null);
  const [activeBlockIds, setActiveBlockIds] = useState<string[]>([]);
  const [severityFilter, setSeverityFilter] = useState<'all' | Severity>('all');
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [changeRequest, setChangeRequest] = useState<{ findingId: string; sequence: number } | null>(null);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  const refreshStandards = async () => { setStandards(await bridge.listEnterpriseStandards()); };
  useEffect(() => { let alive = true; bridge.listEnterpriseStandards().then(values => { if (alive) setStandards(values); }).catch(error => alive && setNotice({ kind: 'error', text: messageOf(error) })); return () => { alive = false; }; }, [bridge]);

  useEffect(() => {
    let alive = true;
    bridge.getState().then(async (state) => {
      if (!alive) return;
      setAppState(state);
      if (state.documents[0]) {
        const first = await bridge.getDocument(state.documents[0].id);
        if (!alive) return;
        selectedIdRef.current = first.id; setSelectedId(first.id); setDocument(first); setContext(value=>({...value,projectId:first.projectId??undefined}));
        setReviewId(newestReview(first)?.id ?? null);
      }
    }).catch((error) => alive && setNotice({ kind: 'error', text: messageOf(error) })).finally(() => alive && setLoading(false));
    const unsubscribe = bridge.onTaskUpdate((task) => {
      if (!alive) return;
      setAppState((state) => ({ ...state, tasks: [task, ...state.tasks.filter((item) => item.id !== task.id)] }));
      if (task.status === 'completed') {
        bridge.getState().then((state) => { if (alive) setAppState(state); }).catch(() => {});
        if (task.documentId === selectedIdRef.current) {
          bridge.getDocument(task.documentId).then((detail) => {
            if (alive && detail.id === selectedIdRef.current) { setDocument(detail); setReviewId(task.resultId ?? newestReview(detail)?.id ?? null); }
          }).catch((error) => alive && setNotice({ kind: 'error', text: messageOf(error) }));
        }
      }
      if (task.status === 'failed') setNotice({ kind: 'error', text: task.error ?? '审核任务失败，请检查配置后重试。' });
    });
    return () => { alive = false; unsubscribe(); };
  }, [bridge]);

  useEffect(() => {
    if (!notice || notice.kind === 'error') return;
    const timer = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  const review = document?.reviews.find((item) => item.id === reviewId) ?? newestReview(document);
  useEffect(()=>{let alive=true;setWorkflowStandard(null);const profile=standards.find(s=>s.versions.some(v=>v.id===standardVersionId));if(profile)bridge.getEnterpriseStandard(profile.id).then(p=>{if(alive)setWorkflowStandard(p.versions.find(v=>v.id===standardVersionId)??null);}).catch(e=>alive&&setNotice({kind:'error',text:messageOf(e)}));return()=>{alive=false;};},[bridge,standardVersionId,standards]);
  useEffect(()=>{let alive=true;setFreshness(null);if(review)bridge.runWorkspaceCommand({action:'reviewCompletion.freshness',payload:{reviewId:review.id}}).then(value=>{if(alive)setFreshness(value);}).catch(()=>{});return()=>{alive=false;};},[bridge,review?.id,appState.documents,standards,workspaceTool]);
  useEffect(() => { setChangeRequest(null); }, [document?.id, review?.id]);
  const currentTask = appState.tasks.filter((task) => task.documentId === selectedId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const running = taskIsActive(currentTask);
  const allFindings = review?.findings ?? [];
  const filteredFindings = allFindings.filter((finding) => severityFilter === 'all' || finding.severity === severityFilter);
  const shownBlocks = document?.blocks.filter((block) => !search || `${block.numberingLabel ?? ''} ${block.text}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  const retrievalConfig = appState.retrievalConfig ?? defaultRetrievalConfig();
  const knowledgeConfigured = Boolean(retrievalConfig.knowledge.folderPath || retrievalConfig.knowledge.api.baseUrl);
  const knowledgeLabel = retrievalConfig.knowledge.enabled ? (knowledgeConfigured ? '已启用' : '待配置') : knowledgeConfigured ? '已关闭' : '未配置';
  const webConfigured = Boolean(retrievalConfig.web.hasApiKey || retrievalConfig.web.baseUrl !== defaultRetrievalConfig().web.baseUrl);
  const officialEnabled = Boolean(retrievalConfig.official?.enabled);
  const searchEnabled = retrievalConfig.web.enabled && retrievalConfig.web.provider !== 'brave';
  const webLabel = officialEnabled ? searchEnabled ? '官方＋搜索' : '官方已启用' : retrievalConfig.web.provider === 'brave' ? '已暂缓' : searchEnabled ? '已启用' : webConfigured ? '已关闭' : '未配置';
  const highCount = allFindings.filter((finding) => finding.severity === 'high').length;
  const mediumCount = allFindings.filter((finding) => finding.severity === 'medium').length;

  const openSetup = async () => {
    setBusyAction('setup');
    try { setAppState(await bridge.getState()); setSidebarOpen(false); setSetupOpen(true); }
    catch (error) { setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { setBusyAction(null); }
  };

  const useDocument = async (detail: ContractDetail) => {
    selectedIdRef.current = detail.id; setSelectedId(detail.id); setDocument(detail);
    setContext(value=>({...value,projectId:detail.projectId??undefined}));
    setReviewId(newestReview(detail)?.id ?? null); setSearch(''); setSelectedFinding(null); setActiveBlockIds([]); setSeverityFilter('all'); setSidebarOpen(false);
    const state = await bridge.getState(); setAppState(state);
  };

  const selectDocument = async (id: string) => {
    if (id === selectedId) { setSidebarOpen(false); return; }
    setBusyAction('select');
    try { await useDocument(await bridge.getDocument(id)); } catch (error) { setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { setBusyAction(null); }
  };

  const importDocument = async (sample = false) => {
    setBusyAction(sample ? 'sample' : 'import'); setNotice(null);
    try {
      const detail = sample ? await bridge.loadSample() : await bridge.importContract();
      if (detail) { await useDocument(detail); setNotice({ kind: 'success', text: sample ? '样例已加载。可先查看原文，再运行本地规则检查。' : '合同已导入，请确认审核背景后开始。' }); }
    } catch (error) { setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { setBusyAction(null); }
  };

  const startReview = async (mode: 'model' | 'local') => {
    if (!document) return;
    if (mode === 'model' && !appState.modelConfig) { setSettingsOpen(true); setNotice({ kind: 'info', text: '请先配置模型连接，再开始模型审核。' }); return; }
    setBusyAction('start'); setNotice(null); setSelectedFinding(null); setActiveBlockIds([]);
    try { await bridge.startReview({ documentId: document.id, context, mode, ...(standardVersionId ? { standardVersionId } : {}) }); setAppState(await bridge.getState()); }
    catch (error) { setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { setBusyAction(null); }
  };

  const cancelReview = async () => {
    if (!currentTask) return;
    setBusyAction('cancel');
    try { await bridge.cancelReview(currentTask.id); setAppState(await bridge.getState()); }
    catch (error) { setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { setBusyAction(null); }
  };

  const exportReport = async () => {
    if (!review) return;
    setBusyAction('export');
    try {
      const result = await bridge.exportReview(review.id);
      if (result) setNotice({ kind: 'success', text: `报告已导出：${result.path}` });
    } catch (error) { setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { setBusyAction(null); }
  };

  const openEvidence = async (evidenceId: string) => {
    if (!review) throw new Error('请先选择一份审核结果。');
    await bridge.openEvidenceSource(review.id, evidenceId);
  };

  const locateFinding = (finding: ReviewFinding) => {
    setSelectedFinding(finding.id); setActiveBlockIds(finding.blockIds); setSearch('');
    const firstId = finding.blockIds[0];
    if (firstId) setTimeout(() => {
      const element = window.document.getElementById(`block-${firstId}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' }); element?.focus({ preventScroll: true });
    }, 50);
  };
  const proposeChange = (finding: ReviewFinding) => {
    setChangeRequest(current => ({ findingId: finding.id, sequence: (current?.sequence ?? 0) + 1 }));
  };

  return (
    <div className={`app-shell ${sidebarOpen ? 'sidebar-is-open' : ''} ${document ? 'has-document' : ''} ${review ? 'has-review' : ''}`}>
      {sidebarOpen && <button className="sidebar-scrim" aria-label={t("收起合同列表")} onClick={() => setSidebarOpen(false)} />}
      <aside className="sidebar" aria-label={t("合同导航")}>
        <div className="brand"><div className="brand-symbol"><Layers3 size={22} strokeWidth={1.7} /></div><div><strong>{t("合同工作台")}</strong><span>LEGAL WORKSPACE</span></div><button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)} aria-label={t("收起导航")}><PanelLeftClose size={18} /></button></div>
        <div className="workspace-label"><span className="workspace-dot" />{t("个人工作空间")}<span className="small-chip">{t("本地")}</span></div>
        <button className="button primary import-button" onClick={() => importDocument()} disabled={!!busyAction}><Upload size={16} />{busyAction === 'import' ? t("正在导入…") : t("导入合同")}<span className="file-types">Word / PDF</span></button>
        <button className="generation-launch-button" onClick={() => { setGenerationOpen(true); setSidebarOpen(false); }}><FilePlus2 size={15} />{t("描述生成合同")}</button>
        <button className="enterprise-launch-button" onClick={() => { setStandardsOpen(true); setSidebarOpen(false); }}><ShieldCheck size={15} />{t("企业审核标准")}</button>
        <button className="enterprise-launch-button" onClick={() => { setWorkspaceTool('menu'); setSidebarOpen(false); }}><Layers3 size={15} />{t("功能中心")}</button>
        <div className="nav-section-title"><span>{t("合同文件")}</span><span>{appState.documents.length.toString().padStart(2, '0')}</span></div>
        <nav className="document-list" aria-label={t("已导入的合同")}>
          {loading ? <div className="sidebar-hint"><LoaderCircle size={15} className="spin" />{t("正在读取工作空间")}</div> : appState.documents.length ? appState.documents.map((item) => (
            <button key={item.id} className={`document-item ${selectedId === item.id ? 'active' : ''}`} onClick={() => selectDocument(item.id)} disabled={busyAction === 'select'} aria-current={selectedId === item.id ? 'page' : undefined}>
              <div className={`document-format ${item.format}`}>{item.format === 'pdf' ? 'PDF' : <FileText size={19} />}</div>
              <div className="document-item-copy"><strong title={item.name}>{item.name}</strong><span>{t(languages[item.language])}<i />{item.latestReviewId ? t("已有检查结果") : t("待审核")}</span></div>
              {selectedId === item.id && <span className="active-indicator" />}
            </button>
          )) : <div className="sidebar-empty"><FolderClosed size={24} strokeWidth={1.4} /><p>{t("还没有合同文件")}</p><span>{t("导入后，文件和审核记录")}<br />{t("会保存在当前工作空间")}</span></div>}
        </nav>
        <button className="sample-button" onClick={() => importDocument(true)} disabled={!!busyAction}><FlaskConical size={16} /><span>{t("加载演示样例")}</span><ArrowUpRight size={14} /></button>
        <div className="sidebar-bottom">
          <div className="connection-heading"><span>{t("资料连接")}</span><button type="button" onClick={() => setRetrievalSettingsOpen(true)} aria-label={t("资料连接设置")}><Settings2 size={12} />{t("设置")}</button></div>
          <button className="connection-line connection-button" onClick={() => setRetrievalSettingsOpen(true)}><BookOpen size={15} /><span>{t("企业知识库")}</span><span className={`connection-status ${retrievalConfig.knowledge.enabled ? 'enabled' : ''}`}>{t(knowledgeLabel)}</span></button>
          <button className="connection-line connection-button" onClick={() => setRetrievalSettingsOpen(true)}><Globe2 size={15} /><span>{t("互联网检索")}</span><span className={`connection-status ${officialEnabled || searchEnabled ? 'enabled' : ''}`}>{t(webLabel)}</span></button>
          <div className="local-storage-note"><LockKeyhole size={13} /><span>{appState.isPreview ? t("预览数据仅保留在本次页面") : t("合同与审核记录保存在本机")}</span></div>
          <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /><span>{t("模型设置")}</span><ChevronRight size={15} /></button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label={t("展开合同列表")} onClick={() => setSidebarOpen(true)}><Layers3 size={19} /></button><span>{t("工作空间")}</span><ChevronRight size={13} /><strong>{t("合同审核")}</strong></div><div className="topbar-right"><label className="interface-language"><Globe2 size={14}/><span className="sr-only">{t("界面语言")}</span><select aria-label={t("界面语言")} value={locale} onChange={event=>setLocale(event.target.value as 'zh'|'en'|'th')}><option value="zh">{t("简体中文")}</option><option value="en">English</option><option value="th">ภาษาไทย</option></select></label><span className={`environment-badge ${appState.isPreview ? 'preview' : ''}`}><span />{appState.isPreview ? t("浏览器界面预览") : t("本地工作台")}</span><button className="setup-launch-button" type="button" onClick={() => void openSetup()} disabled={loading || busyAction === 'setup'}><MonitorCheck size={15} /><span>{busyAction === 'setup' ? t("读取配置…") : t("环境与知识库配置")}</span></button><button className="topbar-settings" aria-label={t("模型设置")} onClick={() => setSettingsOpen(true)}><Settings2 size={15} /><span>{t("模型设置")}</span></button></div></header>

        <div className="workspace-content">
          <section className="page-heading"><div><div className="eyebrow">{t("合同审核")}</div><h1>{t("让每一次审核，有据可循。")}</h1><p>{t("阅读原文，梳理风险，把判断留给充分的信息。")}</p></div><div className="jurisdiction"><ShieldCheck size={17} /><div><strong>{t("中国大陆法律")}</strong><span>{t("中 · 英 · 泰文档")}</span></div></div></section>

          {appState.isPreview && <div className="preview-banner"><FlaskConical size={17} /><p><strong>{t("浏览器界面预览")}</strong><span>{t("此页面不调用模型、不读取本机合同。可加载样例体验界面与本地文本检查。")}</span></p></div>}
          {notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{notice.kind === 'error' ? <CircleAlert size={17} /> : notice.kind === 'success' ? <CircleCheck size={17} /> : <Info size={17} />}<span>{translateMessage(notice.text)}</span><button className="icon-button" aria-label={t("关闭提示")} onClick={() => setNotice(null)}><X size={15} /></button></div>}

          {!loading && appState.documents.length === 0 && !knowledgeConfigured && <section className="setup-welcome card"><div className="setup-welcome-icon"><MonitorCheck size={20} /></div><div><h2>{t("第一次使用，从本机配置开始")}</h2><p>{t("桌面版自带运行环境。点击即可检查环境、选择资料并建立自己的本地知识库。")}</p></div><button className="button secondary small" type="button" onClick={() => void openSetup()} disabled={busyAction === 'setup'}>{t("开始配置")}<ArrowRight size={13} /></button></section>}

          <section className="review-setup card" aria-labelledby="review-setup-title">
            <div className="section-heading"><div className="section-heading-left"><span className="step-number">01</span><h2 id="review-setup-title">{t("确认审核背景")}</h2></div><span className="muted-text">{t("背景越明确，分析越有针对性")}</span></div>
            <div className="setup-grid">
              <label className="field"><span>{t("合同类型")}</span><div className="select-wrap"><select value={context.contractType} disabled={running} onChange={(event) => setContext((value) => ({ ...value, contractType: event.target.value as ReviewContext['contractType'] }))}><option value="service">{t("服务合同")}</option><option value="procurement">{t("采购合同")}</option><option value="other">{t("其他业务合同")}</option></select><ChevronDown size={14} /></div></label>
              <label className="field"><span>{t("我方立场")}</span><div className="select-wrap"><select value={context.ourPartyRole} disabled={running} onChange={(event) => setContext((value) => ({ ...value, ourPartyRole: event.target.value as ReviewContext['ourPartyRole'] }))}><option value="service_recipient">{t("服务接受方")}</option><option value="service_provider">{t("服务提供方")}</option><option value="buyer">{t("采购方 / 买方")}</option><option value="seller">{t("供应方 / 卖方")}</option><option value="other">{t("其他立场")}</option></select><ChevronDown size={14} /></div></label>
              <label className="field"><span>{t("商业审核偏好")}<CircleHelp size={12} aria-label={t("仅调整商业关注与建议，不代表改变法律判断")} /></span><div className="select-wrap"><select value={context.strictness} disabled={running} onChange={(event) => setContext((value) => ({ ...value, strictness: event.target.value as ReviewContext['strictness'] }))}><option value="balanced">{t("平衡 · 关注主要风险")}</option><option value="cautious">{t("审慎 · 提供更多提示")}</option><option value="pragmatic">{t("务实 · 聚焦交易推进")}</option></select><ChevronDown size={14} /></div></label>
              <div className="run-actions"><button className="button primary" onClick={() => startReview('model')} disabled={!document || running || busyAction === 'start'}><Sparkles size={15} />{busyAction === 'start' ? t("提交中…") : t("开始模型审核")}<ArrowRight size={15} /></button><button className="button secondary small" onClick={() => startReview('local')} disabled={!document || running || busyAction === 'start'}><CheckCheck size={14} />{t("本地规则检查")}</button></div>
            </div>
            <div className="review-standard-field"><label><span>{t("本次审核标准")}</span><select aria-label={t("本次审核标准")} value={standardVersionId} disabled={running || busyAction === 'start'} onChange={event => setStandardVersionId(event.target.value)}><option value="">{t("基础审核标准")}</option>{standards.flatMap(profile => profile.versions.map(version => <option key={version.id} value={version.id}>{profile.name}{t("· 已发布 v")}{version.versionNo}</option>))}</select><button className="text-button" onClick={() => setStandardsOpen(true)}><ShieldCheck size={12} />{t("企业审核标准")}</button></label></div>
            <div className="workspace-review-options"><label>{t("项目标识（可选）")}<input aria-label={t("审核项目标识")} maxLength={120} value={context.projectId ?? ''} onChange={event => setContext({ ...context, projectId: event.target.value || undefined })} placeholder={t("与项目经验的标识一致")} /></label><label><input type="checkbox" checked={context.longContractMode === 'batch'} onChange={event => setContext({ ...context, longContractMode: event.target.checked ? 'batch' : 'reject' })} />{t("超长合同自动分批并尝试跨批综合")}</label></div><details className="business-details"><summary><ChevronRight size={13} />{t("补充交易背景")}<span>{t("业务目的、付款安排或特别关注事项")}</span>{context.businessContext && <span className="filled-dot" />}</summary><label className="field"><span className="sr-only">{t("交易背景")}</span><textarea value={context.businessContext} disabled={running} onChange={(event) => setContext((value) => ({ ...value, businessContext: event.target.value }))} placeholder={t("例如：我方采购年度系统维护服务，重点关注验收条件、服务中断责任及数据保密。")} rows={3} maxLength={10000} /></label><p className="field-help">{t("这是本次审核的事实背景。商业偏好不会替代法律适用判断。")}</p></details>
            <TaskRequirementsEditor value={context.taskRequirements ?? []} disabled={running} onChange={taskRequirements=>setContext(value=>({...value,taskRequirements}))} />
            <button className="text-button" disabled={!document||running} onClick={()=>setWorkspaceTool('completion')}>{t("审核资料、流程与来源核验")}</button>
          </section>

          {currentTask && <div className={`task-bar ${running ? 'running' : currentTask.status}`} role="status" aria-live="polite"><div className="task-bar-icon">{running ? <LoaderCircle size={18} className="spin" /> : currentTask.status === 'completed' ? <CircleCheck size={18} /> : <CircleAlert size={18} />}</div><div className="task-bar-copy"><strong>{running ? translateMessage(stageLabel(currentTask.stage)) : currentTask.status === 'completed' ? t("检查结果已保存") : currentTask.status === 'cancelled' ? t("任务已取消") : t("任务未完成")}</strong><span>{currentTask.error ?? (running ? t("可继续阅读原文，结果会在完成后自动更新。") : t("开始于 {v0}", { v0: formatDate(currentTask.startedAt) }))}</span></div>{running && <button className="button secondary small" onClick={cancelReview} disabled={busyAction === 'cancel'}><Square size={11} />{busyAction === 'cancel' ? t("取消中…") : t("取消任务")}</button>}</div>}

          {currentTask?.runtimeProgress && running && <details className="model-stream-preview"><summary>{t("模型输出进度 · 已收到")}{currentTask.runtimeProgress.characters}{t("字符")}</summary><p>{t("未校验的有限预览，完整审核保存后再使用。")}</p><pre>{currentTask.runtimeProgress.preview || t("等待模型输出…")}</pre></details>}
          <div className="review-workspace">
            <section className="document-pane card" aria-labelledby="document-title"><div className="pane-heading"><div className="section-heading-left"><FileText size={18} /><h2 id="document-title">{t("合同原文")}</h2></div>{document && <span className="pill neutral">{document.format.toUpperCase()}</span>}</div>
              {document ? <><div className="document-meta"><strong title={document.name}>{document.name}</strong><span>{t(languages[document.language])}<i />{document.blockCount}{t("个原文块")}<i />{formatBytes(document.byteSize)}</span></div><div className="document-search"><Search size={15} /><input aria-label={t("查找合同原文")} placeholder={t("查找原文内容…")} value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label={t("清空搜索")} onClick={() => setSearch('')}><X size={13} /></button>}<span>{search ? t("{v0} 处", { v0: shownBlocks.length }) : t("原文只读")}</span></div>{(document.partial || document.warnings.length > 0) && <details className="document-warning"><summary><CircleAlert size={14} />{document.partial ? t("文档解析不完整，请核对覆盖范围") : t("{v0} 项文档提示", { v0: document.warnings.length })}<ChevronDown size={13} /></summary><ul>{document.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}<div className="document-scroll">{shownBlocks.length ? shownBlocks.map((block) => <div key={block.id} id={`block-${block.id}`} tabIndex={-1} className={`contract-block ${activeBlockIds.includes(block.id) ? 'highlighted' : ''}`}><span className="block-number">{(block.ordinal + 1).toString().padStart(2, '0')}</span><div className="block-body"><span className="block-locator">{block.locator.kind === 'pdf' ? t("第 {v0} 页", { v0: block.locator.pageIndex + 1 }) : t("段落 {v0}", { v0: block.ordinal + 1 })}</span><p>{block.numberingLabel && <span className="original-numbering" aria-label={t("Word自动编号")}>{block.numberingLabel} </span>}{block.text}</p></div>{activeBlockIds.includes(block.id) && <span className="block-marker" />}</div>) : <div className="empty-search"><Search size={24} /><p>{t("没有找到对应内容")}</p><button className="text-button" onClick={() => setSearch('')}>{t("显示全部原文")}</button></div>}</div><div className="pane-footer"><LockKeyhole size={12} /><span>{t("原始文件保留，审核意见与原文位置关联")}</span></div></> : <div className="document-empty"><div className="empty-document-illustration"><div className="paper-corner" /><FileText size={33} strokeWidth={1.2} /><span /><span /><span /></div><h3>{t("从一份合同开始")}</h3><p>{t("导入 Word 或 PDF 文件，")}<br />{t("在这里阅读条款、定位审核意见。")}</p><button className="button secondary" onClick={() => importDocument()} disabled={!!busyAction}><FilePlus2 size={15} />{t("选择合同文件")}</button><button className="text-button" onClick={() => importDocument(true)} disabled={!!busyAction}>{t("先加载一份演示样例")}<ArrowRight size={13} /></button><div className="supported-languages">{t("中文")}<span />English<span />ภาษาไทย</div></div>}
            </section>

            <section className="results-pane card" aria-labelledby="results-title"><div className="pane-heading"><div className="section-heading-left"><FileSearch size={18} /><h2 id="results-title">{t("审核结果")}</h2>{review && <span className="count-badge">{allFindings.length}</span>}</div><button className="button ghost small export-button" onClick={exportReport} disabled={!review || busyAction === 'export'}><ArrowDownToLine size={14} />{busyAction === 'export' ? t("导出中…") : t("导出报告")}</button></div>
              {review ? <>{freshness && <ReviewFreshnessNotice value={freshness}/>}<div className="review-result-meta"><span className={`pill ${review.mode === 'model' ? 'green' : 'neutral'}`}>{review.mode === 'model' ? <Sparkles size={11} /> : <CheckCheck size={11} />}{review.mode === 'model' ? t("模型分析") : t("本地规则检查")}</span>{document && document.reviews.length > 1 ? <label className="history-select"><span className="sr-only">{t("选择历史检查结果")}</span><select value={review.id} onChange={(event) => { setReviewId(event.target.value); setSelectedFinding(null); setActiveBlockIds([]); }} aria-label={t("历史检查结果")}>{[...document.reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => <option key={item.id} value={item.id}>{formatDate(item.createdAt)} · {item.mode === 'model' ? t("模型审核") : t("本地检查")}</option>)}</select><ChevronDown size={12} /></label> : <span className="result-time">{formatDate(review.createdAt)}</span>}</div><div className="review-summary">{review.summary}</div><div className="result-context-note"><span>{t(contractTypes[review.context.contractType])}</span><span>{t(partyRoles[review.context.ourPartyRole])}</span><span>{t(strictnessLabels[review.context.strictness])}</span></div><div className="risk-overview"><div><strong>{allFindings.length.toString().padStart(2, '0')}</strong><span>{t("全部事项")}</span></div><div className="high"><strong>{highCount.toString().padStart(2, '0')}</strong><span><i />{t("高风险")}</span></div><div className="medium"><strong>{mediumCount.toString().padStart(2, '0')}</strong><span><i />{t("中风险")}</span></div><div><strong>{review.coverage.reviewedBlockIds.length}<small>/{review.coverage.totalBlockCount}</small></strong><span>{t("原文覆盖")}</span></div></div><div className="result-tabs" aria-label={t("风险等级筛选")}>{(['all', 'high', 'medium', 'low', 'unrated'] as const).map((severity) => <button key={severity} className={severityFilter === severity ? 'active' : ''} onClick={() => setSeverityFilter(severity)} aria-pressed={severityFilter === severity}>{severity === 'all' ? t("全部") : t(severities[severity])}</button>)}</div><div className="findings-scroll">{filteredFindings.length ? filteredFindings.map((finding, index) => <FindingCard key={finding.id} finding={finding} index={index} selected={selectedFinding === finding.id} onLocate={() => locateFinding(finding)} onPropose={() => proposeChange(finding)} evidence={review.retrieval?.evidence ?? []} onOpenEvidence={openEvidence} />) : <div className="no-findings"><CircleCheck size={29} strokeWidth={1.4} /><h3>{allFindings.length ? t("当前筛选下没有事项") : t("本次检查未返回风险事项")}</h3><p>{allFindings.length ? t("可以切换其他等级查看。") : t("请结合检查范围和限制判断，本结果不代表合同不存在风险。")}</p></div>}<details className="coverage-details" open={review.coverage.limitations.length > 0}><summary><Info size={14} />{t("检查范围与限制")}<ChevronDown size={13} /></summary><div className="coverage-connections"><span><BookOpen size={12} />{t("知识库")}<RetrievalStatusBadge status={review.coverage.knowledgeStatus} /></span><span><Globe2 size={12} />{t("互联网")}<RetrievalStatusBadge status={review.coverage.webStatus} /></span></div><ul>{review.coverage.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>{review.modelId && <p className="model-used">{t("使用模型：")}{review.modelId}</p>}<p className="model-used">{t("耗时")}{(review.elapsedMs / 1000).toFixed(1)}{t("秒")}{review.inputTokens !== null ? t(" · 输入 {v0} tokens", { v0: review.inputTokens.toLocaleString() }) : ''}{review.outputTokens !== null ? t(" · 输出 {v0} tokens", { v0: review.outputTokens.toLocaleString() }) : ''}</p></details></div></> : <div className="results-empty"><div className="result-illustration"><div className="illustration-line" /><FileCheck2 size={36} strokeWidth={1.3} /><div className="illustration-dot"><Check size={10} /></div></div><h3>{t("审核意见将在这里呈现")}</h3><p>{document ? t("确认我方立场和交易背景后，开始审核。") : t("导入合同并确认背景，开始第一次审核。")}</p><div className="empty-result-steps"><div><span>1</span><p>{t("定位到原文的风险事项")}</p></div><div><span>2</span><p>{t("问题分析与修改建议")}</p></div><div><span>3</span><p>{t("范围明确、可导出的审核报告")}</p></div></div><div className="result-empty-footnote"><Info size={13} /><span>{t("模型审核需要先配置 API。")}<br />{t("本地规则检查独立运行，不调用模型。")}</span></div></div>}
            </section>
          </div>
          {review?.batchCoverage && <section className="review-standard-snapshot"><strong>{t("长合同审核：")}{review.batchCoverage.batchCount}{t("批")}</strong><p>{review.batchCoverage.crossBatchSynthesis ? t("已执行跨批综合，仍需人工核对关联问题。") : t("跨批综合受预算限制，相关问题需人工补核。")}</p>{review.batchCoverage.limitations.map((note,index) => <p key={index}>{note}</p>)}</section>}
          {review?.experienceSnapshot?.length ? <section className="review-standard-snapshot"><strong>{t("本次冻结")}{review.experienceSnapshot.length}{t("项已确认经验")}</strong><p>{t("仅在对应适用范围复用；后续停用或修改不改变本次记录。")}</p></section> : null}
          {review && <><section className="review-standard-snapshot" aria-label={t("本次审核标准快照")}>{review.standardSnapshot ? <><strong>{review.standardSnapshot.content.name} · v{review.standardSnapshot.versionNo}</strong><span>{t("审核时内容摘要：")}{review.standardSnapshot.contentSha256}</span><p>{t("高风险处理建议：")}{review.standardSnapshot.content.workflow.highRiskHandling === 'escalate' ? t("升级处理") : t("人工复核")}{t("，由人工决定，未自动改变状态。历史审核按当时版本保留；上方当前选择不改变这份报告。")}</p></> : <p>{t("本次未保存企业标准版本（基础审核或旧记录）。当前标准选择不会补写此历史报告。")}</p>}</section><ProgramChecksPanel key={`program-${review.id}`} review={review} onLocate={locateFinding} /><RiskDispositionPanel key={`dispositions-${review.id}`} bridge={bridge} review={review} isPreview={appState.isPreview} onLocate={locateFinding} /></>}
          {review && document && <ChangesPanel key={review.id} bridge={bridge} document={document} review={review} isPreview={appState.isPreview} selectedFindingId={changeRequest?.findingId ?? null} requestSequence={changeRequest?.sequence ?? 0} onExport={async () => { setAppState(await bridge.getState()); }} />}
          {review && <ReviewSources review={review} onOpen={openEvidence} />}
          <footer className="workspace-footer"><span><ShieldCheck size={12} />{t("辅助分析 · 人工复核 · 保留依据")}</span><span>{t("合同工作台")}<span className="version-label">v{appState.appVersion}</span></span></footer>
        </div>
      </main>
      {setupOpen && <SetupWizard bridge={bridge} config={appState.retrievalConfig} isPreview={appState.isPreview} onClose={() => setSetupOpen(false)} onSaved={(retrievalConfig) => setAppState((state) => ({ ...state, retrievalConfig }))} onModelSettings={() => { setSetupOpen(false); setSettingsOpen(true); }} onAdvanced={() => { setSetupOpen(false); setRetrievalSettingsOpen(true); }} />}
      {retrievalSettingsOpen && <RetrievalSettings bridge={bridge} config={appState.retrievalConfig} isPreview={appState.isPreview} onClose={() => setRetrievalSettingsOpen(false)} onSaved={(retrievalConfig) => setAppState((state) => ({ ...state, retrievalConfig }))} />}
      <ContractGenerationPanel bridge={bridge} open={generationOpen} modelConfig={appState.modelConfig} isPreview={appState.isPreview} onClose={() => setGenerationOpen(false)} onModelSettings={() => setSettingsOpen(true)} onImported={async detail => { await useDocument(detail); setGenerationOpen(false); setNotice({ kind: 'success', text: '生成的合同已导出并加入工作台，可继续审核。' }); }} />
      <EnterpriseStandardsPanel bridge={bridge} open={standardsOpen} isPreview={appState.isPreview} onClose={() => setStandardsOpen(false)} onChanged={refreshStandards} />
      {workspaceTool === 'menu' && <div className="workspace-tools-overlay"><section role="dialog" aria-label={t("功能中心")} className="workspace-tools-menu"><header><h2>{t("功能中心")}</h2><button className="icon-button" aria-label={t("关闭功能中心")} onClick={() => setWorkspaceTool(null)}><X size={18} /></button></header><p>{t("合同版本、审核资料、报告、经验与本地数据管理。")}</p><div>{([['documents',t("合同、项目与参考译文"),t("版本关联、归档、回收站和译文复核历史")],['completion',t("审核资料与核验"),t("事实、假设、待确认问题、流程和来源人工核验")],['alignment',t("双／三语条款对齐"),t("对应片段、优先文本约定和不一致待复核项")],['runtime',t("模型运行与用量"),t("能力、流式输出、预算、重试和调用台账")],['reports',t("报告与工作汇总"),t("领导摘要、正式报告与跨合同统计")],['library',t("经验、模板与人工意见"),t("人工确认经验、模板起草和补充审核意见")],['connections',t("专业检索与远端知识库"),t("MCP、SFTP、共享盘和远端索引节点")],['conversion',t("扫描件与 PDF 转换"),t("本机中英泰 OCR 与可修改 DOCX 副本")],['maintenance',t("数据备份与恢复"),t("备份、还原与可撤销的知识库清理")]] as const).map(([key,title,description]) => <button key={key} disabled={(key==='completion'||key==='alignment')&&!document} onClick={() => setWorkspaceTool(key)}><strong>{title}</strong><span>{description}</span><ArrowRight size={16} /></button>)}</div></section></div>}
      {workspaceTool === 'documents' && <DocumentWorkspacePanel bridge={bridge} document={document} onClose={()=>{setWorkspaceTool(null);void bridge.getState().then(async state=>{setAppState(state);if(document&&!state.documents.some(d=>d.id===document.id)){setDocument(null);setSelectedId(null);selectedIdRef.current=null;setReviewId(null);}else if(document){const current=await bridge.getDocument(document.id);setDocument(current);setContext(value=>({...value,projectId:current.projectId??undefined}));}}).catch(error=>setNotice({kind:'error',text:messageOf(error)}));}} onSelect={async detail=>{await useDocument(detail);setWorkspaceTool(null);}} />}
      {workspaceTool === 'completion' && document && <div className="workspace-module-overlay" role="dialog" aria-modal="true" aria-label={t("审核资料与核验窗口")}><ReviewCompletionPanel bridge={bridge} document={document} review={review} standard={workflowStandard} onClose={()=>setWorkspaceTool(null)} /></div>}
      {workspaceTool === 'alignment' && document?.contractId && <ClauseAlignmentPanel bridge={bridge} contractId={document.contractId} onClose={()=>setWorkspaceTool(null)} />}
      {workspaceTool === 'runtime' && <div className="workspace-module-overlay" role="dialog" aria-modal="true" aria-label={t("模型运行配置窗口")}><ModelRuntimePanel bridge={bridge} onClose={()=>setWorkspaceTool(null)} /></div>}
      {workspaceTool === 'reports' && <div className="workspace-module-overlay" role="dialog" aria-modal="true" aria-label={t("报告与工作汇总窗口")}><ReportingPanel bridge={bridge} review={review} onClose={() => setWorkspaceTool(null)} /></div>}
      {workspaceTool === 'library' && <LibraryPanel bridge={bridge} review={review} document={document} onClose={() => setWorkspaceTool(null)} onImported={async detail => { await useDocument(detail); setWorkspaceTool(null); }} />}
      {workspaceTool === 'connections' && <ConnectionsPanel bridge={bridge} onClose={() => setWorkspaceTool(null)} />}
      {workspaceTool === 'conversion' && <div className="workspace-module-overlay" role="dialog" aria-modal="true" aria-label={t("PDF 转换窗口")}><DocumentConversionPanel bridge={bridge} document={document} onClose={() => setWorkspaceTool(null)} onImported={async detail => { await useDocument(detail); setWorkspaceTool(null); }} /></div>}
      {workspaceTool === 'maintenance' && <MaintenancePanel bridge={bridge} onClose={() => { setWorkspaceTool(null); void bridge.getState().then(async state => { setAppState(state); if (state.documents[0]) await useDocument(await bridge.getDocument(state.documents[0].id)); else { setDocument(null); setSelectedId(null); setReviewId(null); } }).catch(error => setNotice({kind:'error',text:messageOf(error)})); }} />}
      {settingsOpen && <ModelSettings bridge={bridge} config={appState.modelConfig} isPreview={appState.isPreview} onClose={() => setSettingsOpen(false)} onSaved={(modelConfig) => setAppState((state) => ({ ...state, modelConfig }))} />}
    </div>
  );
}

function FindingCard({ finding, index, selected, onLocate, onPropose, evidence, onOpenEvidence }: { finding: ReviewFinding; index: number; selected: boolean; onLocate: () => void; onPropose: () => void; evidence: SourceEvidence[]; onOpenEvidence: (evidenceId: string) => Promise<void> }) {
  const { t, translateMessage, dateLocale } = useI18n();

  const citations = finding.citations ?? [];
  const knownCitations = citations.flatMap((citation) => { const source = evidence.find((item) => item.id === citation.evidenceId); return source ? [{ citation, source }] : []; });
  const unknownCitationCount = citations.length - knownCitations.length;
  const hasBlocks = finding.blockIds.length > 0;
  const isMatched = finding.locationStatus === 'matched';
  const origin = finding.origin ?? (finding.source === 'model' ? 'model' : 'keyword');
  const originLabel = { model: '模型分析', keyword: '基础关键词提示', enterprise: '企业标准命中', program: '程序核验' }[origin];
  const locationLabel = isMatched ? '定位原文' : '查看候选原文';
  const locationTitle = hasBlocks
    ? isMatched ? '定位对应原文' : '查看候选原文；引文与原文未核验匹配'
    : '未匹配到原文位置';

  return <article className={`finding-card ${finding.severity} ${selected ? 'selected' : ''}`}>
    <div className="finding-topline"><span className={`severity-tag ${finding.severity}`}><span />{t(severities[finding.severity])}</span><span className="finding-category">{t(categories[finding.category])}</span><span className="finding-index">{(index + 1).toString().padStart(2, '0')}</span></div>
    <h3>{finding.title}</h3>
    <span className={`finding-origin ${origin}`}>{t(originLabel)}</span>
    {finding.quote && <button className="finding-quote" onClick={onLocate} disabled={!hasBlocks} title={t(locationTitle)}><span>{isMatched ? t("原文") : t("候选引文")}</span><p>{finding.quote}</p>{hasBlocks && <ArrowUpRight size={14} />}</button>}
    {!isMatched && <div className="finding-basis" role="note"><CircleAlert size={13} /><div><span>{t("引文与原文未核验匹配")}</span></div></div>}
    <p className="finding-description">{finding.description}</p>
    {finding.calculation && <p className="finding-calculation">{t("计算或核对式：")}{finding.calculation}</p>}
    {finding.suggestion && <div className="finding-suggestion"><span>{t("修改建议")}</span><p>{finding.suggestion}</p></div>}
    {finding.legalBasis && <div className="finding-basis"><BookOpen size={13} /><div><span>{t("法律依据 · 待核验")}</span><p>{finding.legalBasis}</p></div></div>}
    {knownCitations.length > 0 && <details className="finding-citations"><summary><BookOpen size={13} />{t("引用资料")}<span>{knownCitations.length}{t("项")}</span><ChevronDown size={12} /></summary>{knownCitations.map(({ citation, source }, citationIndex) => <SourceEvidenceCard key={`${source.id}-${citationIndex}`} evidence={source} citation={citation} compact onOpen={onOpenEvidence} />)}</details>}
    {unknownCitationCount > 0 && <div className="finding-basis" role="note"><CircleAlert size={13} /><div><span>{unknownCitationCount}{t("条引用未能关联到本次取回的真实资料，请人工核对。")}</span></div></div>}
    <button className="text-button finding-propose-change" onClick={onPropose}><FileCheck2 size={12} />{t("拟定修改")}</button>
    <div className="finding-footer"><span>{t(originLabel)}{t("· 请结合原文复核")}</span>{hasBlocks ? <button className="text-button" onClick={onLocate} title={t(locationTitle)}>{t(locationLabel)}<ArrowUpRight size={12} /></button> : <span className="unmatched-location">{t("原文位置未匹配")}</span>}</div>
  </article>;
}

const configToForm = (config: PublicModelConfig | null): ModelConfigInput => ({
  provider: config?.provider ?? 'chat-completions',
  name: config?.name ?? '我的模型连接', baseUrl: config?.baseUrl ?? '', model: config?.model ?? '', apiKey: '',
  responseFormat: config?.responseFormat ?? 'json_object', tokenParameter: config?.tokenParameter ?? 'max_tokens',
  maxOutputTokens: config?.maxOutputTokens ?? 4096, contextWindowTokens: config?.contextWindowTokens ?? 32768,
  timeoutSeconds: config?.timeoutSeconds ?? 120,
});

const defaultCodexForm = (): ModelConfigInput => ({
  provider: 'codex-cli', name: '本机 Codex', baseUrl: 'codex://local', model: 'default',
  responseFormat: 'json_schema', tokenParameter: 'max_tokens',
  maxOutputTokens: 4096, contextWindowTokens: 65536, timeoutSeconds: 300,
});

function ModelSettings({ bridge, config, isPreview, onClose, onSaved }: { bridge: ContractAssistantBridge; config: PublicModelConfig | null; isPreview: boolean; onClose: () => void; onSaved: (config: PublicModelConfig) => void }) {
  const { t, translateMessage, dateLocale } = useI18n();

  const [form, setForm] = useState<ModelConfigInput>(() => configToForm(config));
  const apiDraft = useRef<ModelConfigInput>(config?.provider === 'codex-cli' ? configToForm(null) : configToForm(config));
  const codexDraft = useRef<ModelConfigInput>(config?.provider === 'codex-cli' ? configToForm(config) : defaultCodexForm());
  const savedApi = useRef<PublicModelConfig | null>(config?.provider === 'codex-cli' ? null : config);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  const update = <K extends keyof ModelConfigInput>(key: K, value: ModelConfigInput[K]) => { setForm((current) => ({ ...current, [key]: value })); setNotice(null); };
  const isCodex = form.provider === 'codex-cli';
  const hasSavedApiKey = !isCodex && Boolean(savedApi.current?.hasApiKey && savedApi.current.baseUrl === form.baseUrl);
  const changeProvider = (provider: 'chat-completions' | 'codex-cli') => {
    if (busy || provider === (form.provider ?? 'chat-completions')) return;
    if (isCodex) codexDraft.current = { ...form };
    else apiDraft.current = { ...form };
    setForm({ ...(provider === 'codex-cli' ? codexDraft.current : apiDraft.current), provider });
    setNotice(null);
  };

  useEffect(() => {
    const previouslyFocused = window.document.activeElement as HTMLElement | null;
    const previousOverflow = window.document.body.style.overflow;
    window.document.body.style.overflow = 'hidden';
    panelRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) closeRef.current();
      if (event.key === 'Tab') {
        const controls = panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]');
        if (!controls?.length) return;
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.document.addEventListener('keydown', onKeyDown);
    return () => { window.document.body.style.overflow = previousOverflow; window.document.removeEventListener('keydown', onKeyDown); previouslyFocused?.focus(); };
  }, []);

  const save = async (test = false) => {
    const formElement = panelRef.current?.querySelector<HTMLFormElement>('form');
    if (formElement && !formElement.reportValidity()) return;
    if (!form.name.trim() || (!isCodex && !form.baseUrl.trim()) || !form.model.trim()) { setNotice({ kind: 'error', text: isCodex ? '请填写连接名称和模型名称；使用默认模型时填写 default。' : '请填写连接名称、API 地址和模型名称。' }); return; }
    if (!Number.isInteger(form.maxOutputTokens) || form.maxOutputTokens < 256 || form.maxOutputTokens > 32768) { setNotice({ kind: 'error', text: '最大输出 Tokens 需要是 256–32768 之间的整数。' }); return; }
    if (!Number.isInteger(form.contextWindowTokens) || form.contextWindowTokens < 4096 || form.contextWindowTokens > 2000000) { setNotice({ kind: 'error', text: '上下文窗口 Tokens 需要是 4096–2000000 之间的整数。' }); return; }
    if (!Number.isInteger(form.timeoutSeconds) || form.timeoutSeconds < 5 || form.timeoutSeconds > 600) { setNotice({ kind: 'error', text: '请求超时需要是 5–600 秒之间的整数。' }); return; }
    setBusy(test ? 'test' : 'save'); setNotice(null);
    try {
      const input: ModelConfigInput = isCodex
        ? { provider: 'codex-cli', name: form.name.trim(), baseUrl: 'codex://local', model: form.model.trim(), responseFormat: 'json_schema', tokenParameter: 'max_tokens', maxOutputTokens: form.maxOutputTokens, contextWindowTokens: form.contextWindowTokens, timeoutSeconds: form.timeoutSeconds }
        : { ...form, provider: 'chat-completions', name: form.name.trim(), baseUrl: form.baseUrl.trim(), model: form.model.trim(), apiKey: form.apiKey?.trim() || undefined };
      const saved = await bridge.saveModelConfig(input);
      onSaved(saved); setForm({ ...configToForm(saved), clearApiKey: false });
      if (isCodex) codexDraft.current = configToForm(saved);
      else { apiDraft.current = configToForm(saved); savedApi.current = saved; }
      if (test) {
        if (isPreview) setNotice({ kind: 'info', text: '配置仅暂存在界面预览中。没有检测本机 Codex、执行命令或发送模型请求；真实连接请在桌面应用中测试。' });
        else {
          const result = await bridge.testModelConnection();
          setNotice({ kind: 'success', text: `${result.message} · ${result.latencyMs.toLocaleString()} ms · ${result.model}` });
        }
      } else setNotice({ kind: 'success', text: isPreview ? '配置仅保存在本次界面预览中，没有发送模型请求。' : isCodex ? 'Codex 配置已保存。连接将使用本机 Codex CLI 的登录状态，可先测试连接再开始审核。' : '模型配置已保存。密钥不会在界面回显。' });
    } catch (error) { setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  return <div className="settings-overlay">
    <button className="settings-scrim" aria-label={t("关闭模型设置")} onClick={onClose} disabled={!!busy} />
    <div className="settings-panel model-settings-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="settings-heading"><div><span className="eyebrow">{t("模型连接")}</span><h2 id="settings-title">{t("模型连接设置")}</h2></div><button className="icon-button" onClick={onClose} aria-label={t("关闭模型设置")} disabled={!!busy}><X size={21} /></button></div>
      <div className="settings-body">
        <div className="settings-intro"><div className="settings-intro-icon"><KeyRound size={20} /></div><div><strong>{isCodex ? t("使用本机已登录的 Codex") : t("使用你自己的模型连接")}</strong><p>{isCodex ? t("复用本机 Codex CLI 登录状态，合同及取回的资料片段将发送到该账户对应的模型服务。") : t("连接云端 API、本机模型端点，或切换到本机 Codex。模型审核会发送合同和取回的资料片段。")}</p></div></div>
        {isPreview && <div className="settings-preview"><FlaskConical size={15} />{t("当前是浏览器界面预览。不会检测或执行 Codex，也不会发送真实模型请求。")}</div>}
        <form id="model-settings-form" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
          <fieldset className="model-settings-fields" disabled={!!busy}>
            <label className="field"><span>{t("连接方式")}</span><div className="select-wrap"><select aria-label={t("模型连接方式")} value={form.provider ?? 'chat-completions'} onChange={(event) => changeProvider(event.target.value as 'chat-completions' | 'codex-cli')}><option value="chat-completions">{t("模型 API（云端 / 本机）")}</option><option value="codex-cli">{t("本机 Codex（复用登录）")}</option></select><ChevronDown size={14} /></div></label>
            {!isCodex && <button className="button secondary small codex-quick-connect" type="button" onClick={() => changeProvider('codex-cli')}><Sparkles size={14} />{t("使用本机 Codex")}</button>}
            {isCodex && <div className="codex-connection-note"><Info size={15} /><div><strong>{t("需要本机已安装并登录 Codex CLI")}</strong><p>{t("不需要在这里填写 API 密钥。首次使用请先测试连接；未登录时，按提示在终端运行")}<code>codex login</code>{t("完成登录。本机接入仍会访问账户的模型服务。")}</p></div></div>}
            <label className="field"><span>{t("连接名称")}</span><input required value={form.name} onChange={(event) => update('name', event.target.value)} placeholder={isCodex ? t("例如：本机 Codex") : t("例如：公司模型服务")} autoComplete="off" /></label>
            {!isCodex && <label className="field"><span>{t("API 地址")}</span><input required type="url" value={form.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" autoComplete="url" spellCheck={false} /><span className="field-help">{t("远端及内网服务须使用 HTTPS；本机 localhost 服务允许使用 HTTP。")}</span></label>}
            <label className="field"><span>{t("模型名称")}</span><input required value={form.model} onChange={(event) => update('model', event.target.value)} placeholder={isCodex ? t("default 或可用的 Codex 模型 ID") : t("填写 API 中的模型 ID")} autoComplete="off" spellCheck={false} />{isCodex && <span className="field-help">{t("default 使用 Codex CLI 的默认模型；也可填写当前登录账户有权限使用的模型 ID。")}</span>}</label>
            {!isCodex && <>
              <label className="field"><span>{t("API 密钥")}{hasSavedApiKey && <span className="saved-key"><Check size={11} />{t("已有密钥")}</span>}</span><input type="password" value={form.apiKey ?? ''} onChange={(event) => { update('apiKey', event.target.value); if (event.target.value) update('clearApiKey', false); }} placeholder={hasSavedApiKey ? t("留空保留已保存的密钥") : t("本地服务无密钥时可留空")} autoComplete="new-password" spellCheck={false} /><span className="field-help">{t("密钥保存后不回显；留空表示保持原有密钥。")}</span></label>
              {hasSavedApiKey && <label className="checkbox-field"><input type="checkbox" checked={form.clearApiKey ?? false} onChange={(event) => update('clearApiKey', event.target.checked)} />{t("保存时移除已有密钥")}</label>}
            </>}
            <div className="settings-divider" /><div className="advanced-title"><Settings2 size={15} /><strong>{isCodex ? t("审核预算与等待时间") : t("请求参数")}</strong><span>{isCodex ? t("应用侧限制") : t("需与服务商支持能力一致")}</span></div>
            {!isCodex && <>
              <label className="field"><span>{t("响应格式")}</span><div className="select-wrap"><select value={form.responseFormat} onChange={(event) => update('responseFormat', event.target.value as ModelConfigInput['responseFormat'])}><option value="json_object">{t("JSON 对象（json_object）")}</option><option value="json_schema">JSON Schema（json_schema）</option><option value="text">{t("文本（text）")}</option></select><ChevronDown size={14} /></div></label>
              <label className="field"><span>{t("输出 Token 参数")}</span><div className="select-wrap"><select value={form.tokenParameter} onChange={(event) => update('tokenParameter', event.target.value as ModelConfigInput['tokenParameter'])}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select><ChevronDown size={14} /></div></label>
            </>}
            <div className="settings-numbers"><label className="field"><span>{isCodex ? t("输出预留 Tokens") : t("最大输出 Tokens")}</span><input required type="number" min="256" max="32768" step="1" value={form.maxOutputTokens || ''} onChange={(event) => update('maxOutputTokens', Number(event.target.value))} /></label><label className="field"><span>{t("上下文窗口 Tokens")}</span><input required type="number" min="4096" max="2000000" step="1" value={form.contextWindowTokens || ''} onChange={(event) => update('contextWindowTokens', Number(event.target.value))} /></label></div>
            {isCodex && <p className="field-help codex-budget-note">{t("输出预留用于计算应用的上下文预算；Codex CLI 无法按此值保证单次输出上限。过大的输入会在发送前被拒绝，返回内容还会经过大小、结构及引用校验。")}</p>}
            <label className="field"><span>{t("请求超时（秒）")}</span><input required type="number" min="5" max="600" step="1" value={form.timeoutSeconds || ''} onChange={(event) => update('timeoutSeconds', Number(event.target.value))} /></label>
          </fieldset>
        </form>
        <div className="key-storage-note"><LockKeyhole size={14} /><p>{isPreview ? t("预览配置仅存于页面内存，刷新后清空。") : isCodex ? t("登录凭据由 Codex 维护，本应用不读取或保存 Codex 登录令牌。切换连接方式不会删除原有 API 配置或密钥。") : savedApi.current?.keyStorage === 'session-only' ? t("当前环境仅支持会话内保存密钥，应用关闭后需重新填写。") : t("桌面端使用系统凭据保护能力。日志与导出报告不应包含 API 密钥。")}</p></div>
      </div>
      <div className="settings-footer">{notice && <div className={`notice settings-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'error' ? <CircleAlert size={16} /> : notice.kind === 'info' ? <Info size={16} /> : <CircleCheck size={16} />}<span>{translateMessage(notice.text)}</span></div>}<div className="settings-footer-actions"><button className="button secondary" type="button" onClick={() => save(true)} disabled={!!busy}>{busy === 'test' ? <LoaderCircle size={15} className="spin" /> : <Globe2 size={15} />}{busy === 'test' ? t("正在测试…") : t("保存并测试连接")}</button><button className="button primary" type="submit" form="model-settings-form" disabled={!!busy}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{busy === 'save' ? t("保存中…") : t("保存配置")}</button></div></div>
    </div>
  </div>;
}
