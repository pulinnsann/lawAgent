import { useI18n } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown, CircleAlert, CircleCheck, FlaskConical, FolderOpen, Globe2, Info, Landmark, LoaderCircle, LockKeyhole, Search, Settings2, X } from 'lucide-react';
import { defaultRetrievalConfig } from '../../shared/contracts';
import type { ContractAssistantBridge, PublicRetrievalConfig, RetrievalBundle, RetrievalConfigInput, OfficialSourceConfig } from '../../shared/contracts';
import { RetrievalAttempts, RetrievalChannelSummary, SourceEvidenceCard } from './RetrievalSources';
import LocalKnowledgePanel from './LocalKnowledgePanel';
import { defaultKnowledgePreferences } from '../../shared/knowledge-preferences';
import { courtCatalogOptions } from '../../shared/official-discovery';
import './official-sources.css';

type Feedback = { kind: 'success' | 'error' | 'info'; text: string };
const officialDefaults = (): OfficialSourceConfig => ({ enabled: false, maxCatalogPages: 3, sourceUrls: [] as string[] });
const sourceUrlsFromText = (text: string) => [...new Set(text.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean))];

function hasFailedRetrieval(bundle: RetrievalBundle) {
  const failures = ['failed', 'timeout', 'cancelled'];
  return [bundle.knowledgeStatus, bundle.webStatus, bundle.officialStatus, bundle.searchStatus].some((status) => status !== undefined && failures.includes(status)) || bundle.attempts.some((attempt) => failures.includes(attempt.status) || Boolean(attempt.error) || (attempt.coverage?.failedReads ?? 0) > 0);
}

function hasOnlyLimitedOfficialCoverage(bundle: RetrievalBundle) {
  if (hasFailedRetrieval(bundle) || bundle.knowledgeStatus === 'partial' || bundle.searchStatus === 'partial') return false;
  const officialAttempts = bundle.attempts.filter((attempt) => ['official_catalog', 'official_page'].includes(attempt.provider));
  if (!officialAttempts.length || !officialAttempts.every((attempt) => attempt.coverage?.failedReads === 0)) return false;
  if (bundle.attempts.some((attempt) => !['official_catalog', 'official_page'].includes(attempt.provider) && attempt.status === 'partial')) return false;
  const officialIds = new Set(officialAttempts.map((attempt) => attempt.id));
  const hasRead = officialAttempts.some((attempt) => Boolean(attempt.coverage && (attempt.coverage.catalogPagesRead > 0 || attempt.coverage.userUrlsRead > 0))) || bundle.evidence.some((source) => officialIds.has(source.attemptId));
  return hasRead && (bundle.officialStatus === 'partial' || officialAttempts.some((attempt) => attempt.status === 'partial'));
}

function toInput(config: PublicRetrievalConfig | null | undefined): RetrievalConfigInput {
  const source = config ?? defaultRetrievalConfig();
  return {
    knowledge: {
      enabled: source.knowledge.enabled, folderPath: source.knowledge.folderPath,
      preferences: structuredClone(source.knowledge.preferences ?? defaultKnowledgePreferences()),
      api: { enabled: source.knowledge.api.enabled, provider: source.knowledge.api.provider, baseUrl: source.knowledge.api.baseUrl, collectionId: source.knowledge.api.collectionId, apiKey: '', clearApiKey: false },
    },
    web: { enabled: source.web.provider === 'brave' ? false : source.web.enabled, provider: 'searxng', baseUrl: source.web.provider === 'brave' ? '' : source.web.baseUrl, apiKey: '', clearApiKey: source.web.provider === 'brave', allowedDomains: [...source.web.allowedDomains], fetchPages: source.web.fetchPages },
    official: { ...officialDefaults(), ...source.official, sourceUrls: [...(source.official?.sourceUrls ?? [])] },
    maxResults: source.maxResults, timeoutSeconds: source.timeoutSeconds,
  };
}

export default function RetrievalSettings({ bridge, config, isPreview, onClose, onSaved }: {
  bridge: ContractAssistantBridge;
  config: PublicRetrievalConfig | null | undefined;
  isPreview: boolean;
  onClose: () => void;
  onSaved: (config: PublicRetrievalConfig) => void;
}) {
  const { t, translateMessage, dateLocale } = useI18n();

  const [form, setForm] = useState<RetrievalConfigInput>(() => toInput(config));
  const [domainText, setDomainText] = useState(() => (config ?? defaultRetrievalConfig()).web.allowedDomains.join('\n'));
  const [officialUrlText, setOfficialUrlText] = useState(() => config?.official?.sourceUrls.join('\n') ?? '');
  const [officialQuery, setOfficialQuery] = useState('数据');
  const [officialResult, setOfficialResult] = useState<RetrievalBundle | null>(null);
  const [officialCancelling, setOfficialCancelling] = useState(false);
  const officialCancelRequested = useRef(false);
  const [busy, setBusy] = useState<'save' | 'test' | 'folder' | 'officialTest' | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [testResult, setTestResult] = useState<RetrievalBundle | null>(null);
  const [knowledgeRunning, setKnowledgeRunning] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose; busyRef.current = busy;

  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) closeRef.current();
      if (event.key === 'Tab') {
        const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary') ?? []).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0]; const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); focused?.focus(); };
  }, []);

  const official = form.official ?? officialDefaults();
  const savedOfficial = config?.official ?? officialDefaults();
  const officialChanged = official.enabled !== savedOfficial.enabled || official.maxCatalogPages !== savedOfficial.maxCatalogPages || JSON.stringify(sourceUrlsFromText(officialUrlText)) !== JSON.stringify(savedOfficial.sourceUrls) || JSON.stringify(official.courtCatalogs ?? []) !== JSON.stringify(savedOfficial.courtCatalogs ?? []);
  const changed = () => { setFeedback(null); setTestResult(null); setOfficialResult(null); };
  const updateKnowledge = (patch: Partial<RetrievalConfigInput['knowledge']>) => { setForm((value) => ({ ...value, knowledge: { ...value.knowledge, ...patch } })); changed(); };
  const updateKnowledgeApi = (patch: Partial<RetrievalConfigInput['knowledge']['api']>) => { setForm((value) => ({ ...value, knowledge: { ...value.knowledge, api: { ...value.knowledge.api, ...patch } } })); changed(); };
  const updateWeb = (patch: Partial<RetrievalConfigInput['web']>) => { setForm((value) => ({ ...value, web: { ...value.web, ...patch } })); changed(); };
  const updateOfficial = (patch: Partial<NonNullable<RetrievalConfigInput['official']>>) => { setForm((value) => ({ ...value, official: { ...officialDefaults(), ...value.official, ...patch } })); changed(); };

  const cancelOfficialTest = async () => {
    if (busyRef.current !== 'officialTest' || officialCancelling) return;
    if (typeof bridge.cancelOfficialRetrieval !== 'function') { setFeedback({ kind: 'error', text: t("当前桌面服务尚未提供取消官方测试，请更新并重启软件。") }); return; }
    officialCancelRequested.current = true; setOfficialCancelling(true);
    try { await bridge.cancelOfficialRetrieval(); }
    catch (error) { officialCancelRequested.current = false; setOfficialCancelling(false); setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) }); }
  };

  const testOfficial = async () => {
    if (isPreview) { setFeedback({ kind: 'info', text: t("浏览器预览未联网，无法测试官方来源。请在桌面应用中执行。") }); return; }
    if (officialChanged || !savedOfficial.enabled) { setFeedback({ kind: 'info', text: t("请先启用官方公开来源并保存配置，再测试已保存的读取范围。") }); return; }
    const query = officialQuery.trim();
    if (!query || query.length > 120) { setFeedback({ kind: 'error', text: t("请输入 1–120 个字符的目录标题关键词。") }); return; }
    if (typeof bridge.testOfficialRetrieval !== 'function') { setFeedback({ kind: 'error', text: t("当前桌面服务尚未提供官方来源检索，请更新并重启软件。") }); return; }
    officialCancelRequested.current = false; setOfficialCancelling(false);
    setBusy('officialTest'); setFeedback(null); setOfficialResult(null);
    try {
      const result = await bridge.testOfficialRetrieval({ query }); setOfficialResult(result);
      if (officialCancelRequested.current || result.officialStatus === 'cancelled' || result.webStatus === 'cancelled') setFeedback({ kind: 'info', text: t("本次官方来源测试已结束，保留已取得的 {v0} 项资料。取消后未完成的范围不作已检索，配置没有更改。", { v0: result.evidence.length }) });
      else if (hasOnlyLimitedOfficialCoverage(result)) setFeedback({ kind: 'info', text: t("本次取回 {v0} 项资料；目录覆盖有限，请查看实际读取范围。没有调用模型，无匹配结果不代表相关规定不存在。", { v0: result.evidence.length }) });
      else if (hasFailedRetrieval(result) || result.webStatus === 'partial') setFeedback({ kind: 'error', text: t("官方来源测试有失败或未完成的读取。已取得的资料仍保留，请查看覆盖范围和错误记录。") });
      else if (!result.evidence.length) setFeedback({ kind: 'info', text: t("本次读取范围内没有取得匹配资料。请查看目录覆盖与读取记录；不代表相关规定不存在。") });
      else setFeedback({ kind: 'success', text: t("官方来源测试取回 {v0} 项资料。没有调用模型；资料效力及适用性尚需核实。", { v0: result.evidence.length }) });
    } catch (error) { setFeedback(officialCancelRequested.current ? { kind: 'info', text: t("本次官方来源测试已停止，配置没有更改。未完整读取的范围不作已检索。") } : { kind: 'error', text: error instanceof Error ? error.message : String(error) }); }
    finally { officialCancelRequested.current = false; setOfficialCancelling(false); setBusy(null); }
  };

  const selectFolder = async () => {
    setBusy('folder'); setFeedback(null);
    try { const folderPath = await bridge.selectKnowledgeFolder(); if (folderPath) updateKnowledge({ folderPath }); }
    catch (error) { setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(null); }
  };

  const save = async (test = false) => {
    if (knowledgeRunning) { setFeedback({ kind: 'info', text: t("本地知识库正在同步，请等待或取消任务后再保存配置。") }); return; }
    const element = panelRef.current?.querySelector<HTMLFormElement>('form');
    if (element && !element.reportValidity()) return;
    if (!Number.isInteger(form.maxResults) || form.maxResults < 1 || form.maxResults > 8 || !Number.isInteger(form.timeoutSeconds) || form.timeoutSeconds < 5 || form.timeoutSeconds > 60) {
      setFeedback({ kind: 'error', text: t("每路结果上限为 1–8，超时时间为 5–60 秒，均须填写整数。") }); return;
    }
    if (!Number.isInteger(official.maxCatalogPages) || official.maxCatalogPages < 1 || official.maxCatalogPages > 10 || sourceUrlsFromText(officialUrlText).length > 8) { setFeedback({ kind: 'error', text: t("官方目录读取上限为 1–10 页，指定原文链接最多 8 个。") }); return; }
    setBusy(test ? 'test' : 'save'); setFeedback(null); setTestResult(null);
    try {
      const input: RetrievalConfigInput = {
        knowledge: { enabled: form.knowledge.enabled, folderPath: form.knowledge.folderPath, preferences: structuredClone(form.knowledge.preferences ?? defaultKnowledgePreferences()), api: { ...form.knowledge.api, baseUrl: form.knowledge.api.baseUrl.trim(), collectionId: form.knowledge.api.collectionId.trim(), apiKey: form.knowledge.api.apiKey?.trim() || undefined } },
        web: { ...form.web, baseUrl: form.web.baseUrl.trim(), apiKey: form.web.apiKey?.trim() || undefined, allowedDomains: [...new Set(domainText.split(/[\s,;，；]+/).map((item) => item.trim()).filter(Boolean))] },
        official: { ...official, sourceUrls: sourceUrlsFromText(officialUrlText) },
        maxResults: form.maxResults, timeoutSeconds: form.timeoutSeconds,
      };
      const saved = await bridge.saveRetrievalConfig(input);
      onSaved(saved); setForm(toInput(saved)); setDomainText(saved.web.allowedDomains.join('\n')); setOfficialUrlText(saved.official?.sourceUrls.join('\n') ?? '');
      if (test) {
        const result = await bridge.testRetrieval(); setTestResult(result);
        setTimeout(() => panelRef.current?.querySelector('.retrieval-test-result')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0);
        const statuses = [result.knowledgeStatus, result.webStatus];
        if (isPreview) setFeedback({ kind: 'info', text: t("配置已暂存。本次是界面预览：未联网、未读取文件，也没有取回真实材料。") });
        else if (hasOnlyLimitedOfficialCoverage(result)) setFeedback({ kind: 'info', text: t("配置已保存，本次取回 {v0} 项资料。官方目录覆盖有限，实际读取范围见下方；资料效力与适用性尚需核实。", { v0: result.evidence.length }) });
        else if (hasFailedRetrieval(result) || statuses.includes('partial')) setFeedback({ kind: 'error', text: t("配置已保存，检索存在失败或未完成的分支。请查看各路状态、错误和限制。") });
        else if (!statuses.includes('complete')) setFeedback({ kind: 'info', text: t("配置已保存。本次没有取回材料，请查看是否关闭检索、尚未配置或查询无结果。") });
        else setFeedback({ kind: 'success', text: t("检索测试已返回 {v0} 项材料。各路状态见下方；资料效力与法律适用尚需核验。", { v0: result.evidence.length }) });
      } else setFeedback({ kind: 'success', text: isPreview ? '资料连接配置仅保存在本次页面内存中。没有联网或读取本地文件。' : '资料连接配置已保存，密钥输入已清空。下一次模型审核将使用此配置。' });
    } catch (error) { setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) }); }
    finally {
      setForm((value) => ({ ...value, knowledge: { ...value.knowledge, api: { ...value.knowledge.api, apiKey: '' } }, web: { ...value.web, apiKey: '' } }));
      setBusy(null);
    }
  };

  return <div className="settings-overlay"><button className="settings-scrim" aria-label={t("关闭资料连接设置")} onClick={onClose} disabled={!!busy} /><div className="settings-panel retrieval-settings-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="retrieval-settings-title">
    <div className="settings-heading"><div><span className="eyebrow">{t("KNOWLEDGE & WEB")}</span><h2 id="retrieval-settings-title">{t("资料连接设置")}</h2></div><button className="icon-button" aria-label={t("关闭资料连接设置")} onClick={onClose} disabled={!!busy}><X size={21} /></button></div>
    <div className="settings-body"><div className="settings-intro"><div className="settings-intro-icon"><BookOpen size={20} /></div><div><strong>{t("让审核连接到真实资料")}</strong><p>{t("客户维护知识内容，工作台只读检索。文件夹与知识库 API 可以同时启用。")}</p></div></div>
      <div className="retrieval-data-note"><Info size={15} /><p>{t("搜索服务只接收固定的法律主题查询；官方目录关键词在本机匹配，不发送合同原文。审核时，取回的资料片段将与合同内容一起交给你配置的模型分析。")}</p></div>
      {isPreview && <div className="settings-preview"><FlaskConical size={15} />{t("浏览器只预览配置界面，不联网、不读取文件。真实连接请在桌面应用中测试。")}</div>}
      <form id="retrieval-settings-form" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
        <div className="retrieval-group-heading"><div><BookOpen size={17} /><strong>{t("企业知识库")}</strong></div><label className="switch-field"><input type="checkbox" aria-label={t("启用企业知识库检索")} checked={form.knowledge.enabled} disabled={!!busy || knowledgeRunning} onChange={(event) => updateKnowledge({ enabled: event.target.checked })} /><span className="switch-track" /><span>{form.knowledge.enabled ? t("已启用") : t("已关闭")}</span></label></div>
        <fieldset className="retrieval-fieldset" disabled={!form.knowledge.enabled || !!busy}>
          <fieldset className="retrieval-fieldset" disabled={knowledgeRunning}><label className="field"><span>{t("本地资料文件夹")}</span><div className="folder-selector"><input readOnly value={form.knowledge.folderPath ?? ''} placeholder={t("尚未选择文件夹")} title={form.knowledge.folderPath ?? ''} /><button className="button secondary small" type="button" onClick={selectFolder}><FolderOpen size={14} />{busy === 'folder' ? t("选择中…") : t("选择文件夹")}</button>{form.knowledge.folderPath && <button className="icon-button" type="button" aria-label={t("移除知识库文件夹")} onClick={() => updateKnowledge({ folderPath: null })}><X size={15} /></button>}</div><span className="field-help">{t("只读检索 DOCX、PDF、TXT、MD 文件，不修改源文件。")}</span></label></fieldset>
          <LocalKnowledgePanel bridge={bridge} folderPath={form.knowledge.folderPath} saved={Boolean(form.knowledge.folderPath && form.knowledge.folderPath === config?.knowledge.folderPath)} isPreview={isPreview} preferences={config?.knowledge.preferences} onRunningChange={setKnowledgeRunning} />
          <label className="checkbox-field knowledge-api-toggle"><input type="checkbox" checked={form.knowledge.api.enabled} disabled={knowledgeRunning} onChange={(event) => updateKnowledgeApi({ enabled: event.target.checked })} />{t("启用外部知识库 API")}</label>
          {form.knowledge.api.enabled && <fieldset className="retrieval-fieldset knowledge-api-fields" disabled={!form.knowledge.enabled || !!busy || knowledgeRunning}>
            <label className="field"><span>{t("知识库服务类型")}</span><div className="select-wrap"><select value={form.knowledge.api.provider} onChange={(event) => updateKnowledgeApi({ provider: event.target.value as 'dify' | 'standard' })}><option value="dify">{t("Dify 知识库")}</option><option value="standard">{t("标准检索 API")}</option></select><ChevronDown size={14} /></div></label>
            <label className="field"><span>{t("知识库 API 地址")}</span><input type="url" required={form.knowledge.enabled && form.knowledge.api.enabled} value={form.knowledge.api.baseUrl} onChange={(event) => updateKnowledgeApi({ baseUrl: event.target.value })} placeholder="https://knowledge.example.com/v1" autoComplete="url" spellCheck={false} /><span className="field-help">{t("远端及内网服务使用 HTTPS；本机服务可使用 HTTP。")}</span></label>
            <label className="field"><span>{t("知识库 / 集合 ID")}</span><input required={form.knowledge.enabled && form.knowledge.api.enabled} value={form.knowledge.api.collectionId} onChange={(event) => updateKnowledgeApi({ collectionId: event.target.value })} placeholder="collection / dataset ID" autoComplete="off" spellCheck={false} /></label>
            <label className="field"><span>{t("知识库 API 密钥")}{config?.knowledge.api.hasApiKey && <span className="saved-key"><Check size={11} />{t("已有密钥")}</span>}</span><input type="password" value={form.knowledge.api.apiKey ?? ''} onChange={(event) => updateKnowledgeApi({ apiKey: event.target.value, ...(event.target.value ? { clearApiKey: false } : {}) })} placeholder={config?.knowledge.api.hasApiKey ? t("留空保留已保存的密钥") : t("按服务要求填写")} autoComplete="new-password" spellCheck={false} /><span className="field-help">{t("保存后不回显；留空保持原有密钥。")}</span></label>
            {config?.knowledge.api.hasApiKey && <label className="checkbox-field"><input type="checkbox" checked={form.knowledge.api.clearApiKey ?? false} onChange={(event) => updateKnowledgeApi({ clearApiKey: event.target.checked })} />{t("保存时移除知识库密钥")}</label>}
          </fieldset>}
        </fieldset>

        <div className="settings-divider" />
        <section className="official-source-settings" aria-labelledby="official-source-title">
          <div className="retrieval-group-heading"><div><Landmark size={17} /><strong id="official-source-title">{t("官方公开来源")}</strong><span className="official-free-label">{t("无需密钥")}</span></div><label className="switch-field"><input type="checkbox" aria-label={t("启用官方公开来源检索")} checked={official.enabled} disabled={!!busy || knowledgeRunning} onChange={(event) => updateOfficial({ enabled: event.target.checked })} /><span className="switch-track" /><span>{official.enabled ? t("已启用") : t("已关闭")}</span></label></div>
          <p className="official-source-intro">{t("读取国家行政法规库及已选择最高法栏目的公开目录，在本机匹配标题，再读取命中的原文。合同示范文本可指定链接；搜索服务命中受支持的官方详情地址时优先用站点正文解析。")}</p>
          <fieldset className="retrieval-fieldset" disabled={!official.enabled || !!busy || knowledgeRunning}>
            <label className="field"><span>{t("每类目录页数上限")}</span><input type="number" min="1" max="10" step="1" required={official.enabled} value={official.maxCatalogPages || ''} onChange={(event) => updateOfficial({ maxCatalogPages: Number(event.target.value) })} /><span className="field-help">{t("每类目录 1–10 页，共享结果及原文读取预算。仅匹配已读标题，不代表全文检索或覆盖整个数据库。")}</span></label>
            <div className="field"><span>{t("追加官方栏目（可选）")}</span>{courtCatalogOptions.map(option => <label key={option.key} className="settings-checkbox"><input type="checkbox" aria-label={t(option.label)} checked={Boolean(official.courtCatalogs?.includes(option.key))} onChange={event => updateOfficial({ courtCatalogs: event.target.checked ? [...(official.courtCatalogs ?? []), option.key] : (official.courtCatalogs ?? []).filter(value => value !== option.key) })} />{t(option.label)}</label>)}<small>{t("公开栏目包含历史、修改和废止材料，不自动认定现行有效。案例仍通过指定链接或已配置专业服务／SearXNG发现。")}</small></div>
            <label className="field official-url-field"><span>{t("指定官方原文链接（可选，一行一个）")}</span><textarea rows={4} maxLength={32768} value={officialUrlText} onChange={(event) => { setOfficialUrlText(event.target.value); changed(); }} placeholder={'https://xzfg.moj.gov.cn/front/law/detail?LawID=…\nhttps://www.court.gov.cn/fabu/xiangqing/….html\nhttps://htsfwb.samr.gov.cn/View?id=…'} spellCheck={false} autoComplete="off" /><span className="field-help">{t("最多 8 个 HTTPS 原文链接。支持国家行政法规库详情、最高法公开发布页、合同示范文本库详情；保存时校验地址。")}</span></label>
          </fieldset>
          <div className="official-source-test">
            <label className="field"><span>{t("目录标题关键词（本机匹配）")}</span><input value={officialQuery} maxLength={120} onChange={(event) => { setOfficialQuery(event.target.value); setOfficialResult(null); setFeedback(null); }} placeholder={t("例如：数据、保密、仲裁")} disabled={!!busy} /><span className="field-help">{t("请填写具体主题；通用“合同、服务、采购”不用于扩大匹配。测试不查企业资料、不调用模型。")}</span></label>
            <p className="field-help">{t("国家法律法规数据库本次公开入口存在访问限制，尚未接通稳定开放API；可用授权专业MCP／知识库连接器或导入合法取得的原文。本软件不绕过登录或验证码。")}</p><div className="official-test-actions"><button type="button" className="button secondary" onClick={() => void testOfficial()} disabled={!!busy || isPreview || !savedOfficial.enabled || officialChanged}>{busy === 'officialTest' ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}{busy === 'officialTest' ? t("正在读取官方来源…") : t("测试已保存的官方来源")}</button>{busy === 'officialTest' && <button type="button" className="button secondary" onClick={() => void cancelOfficialTest()} disabled={officialCancelling}>{officialCancelling && <LoaderCircle className="spin" size={14} />}{officialCancelling ? t("正在取消…") : t("取消本次测试")}</button>}</div>
            {isPreview ? <p className="field-help official-test-note">{t("界面预览未联网，官方来源测试仅在桌面应用中可用。")}</p> : officialChanged ? <p className="field-help official-test-note">{t("官方来源配置尚未保存，请先点击底部“保存配置”。")}</p> : !savedOfficial.enabled ? <p className="field-help official-test-note">{t("先启用官方公开来源，再保存配置即可测试。")}</p> : null}
          </div>
        </section>

        <div className="settings-divider" />
        <div className="retrieval-group-heading"><div><Globe2 size={17} /><strong>{t("通用搜索服务")}</strong></div><label className="switch-field"><input type="checkbox" aria-label={t("启用互联网检索")} checked={form.web.enabled} disabled={!!busy || knowledgeRunning} onChange={(event) => updateWeb({ enabled: event.target.checked })} /><span className="switch-track" /><span>{form.web.enabled ? t("已启用") : t("已关闭")}</span></label></div>
        {config?.web.provider === 'brave' && <div className="settings-preview"><Info size={15} />{t("Brave 已暂缓。旧搜索连接不会启用；请配置 SearXNG 后重新保存，旧密钥不会沿用。")}</div>}
        {form.web.enabled ? <fieldset className="retrieval-fieldset" disabled={!!busy || knowledgeRunning}>
          <label className="field"><span>{t("搜索服务")}</span><div className="select-wrap"><select value="searxng" onChange={() => updateWeb({ provider: 'searxng' })}><option value="searxng">SearXNG</option></select><ChevronDown size={14} /></div></label>
          <label className="field"><span>{t("搜索 API 地址")}</span><input type="url" required={form.web.enabled} value={form.web.baseUrl} onChange={(event) => updateWeb({ baseUrl: event.target.value })} placeholder="https://search.example.com/search" autoComplete="url" spellCheck={false} /></label>
          <label className="field"><span>{t("搜索 API 密钥")}{config?.web.hasApiKey && config.web.provider === form.web.provider && <span className="saved-key"><Check size={11} />{t("已有密钥")}</span>}</span><input type="password" value={form.web.apiKey ?? ''} onChange={(event) => updateWeb({ apiKey: event.target.value, ...(event.target.value ? { clearApiKey: false } : {}) })} placeholder={config?.web.hasApiKey && config.web.provider === form.web.provider ? t("留空保留已保存的密钥") : t("服务无密钥时可留空")} autoComplete="new-password" spellCheck={false} /><span className="field-help">{t("密钥保存后不回显，留空保持原有值。")}</span></label>
          {config?.web.hasApiKey && config.web.provider === form.web.provider && <label className="checkbox-field"><input type="checkbox" checked={form.web.clearApiKey ?? false} onChange={(event) => updateWeb({ clearApiKey: event.target.checked })} />{t("保存时移除搜索密钥")}</label>}
          <label className="field domain-field"><span>{t("来源域名白名单")}</span><textarea rows={3} value={domainText} onChange={(event) => { setDomainText(event.target.value); changed(); }} placeholder={'gov.cn\nnpc.gov.cn\ncourt.gov.cn'} spellCheck={false} /><span className="field-help">{t("每行一个域名，不含协议或路径；也可用逗号分隔。")}</span></label>
          <label className="checkbox-field fetch-pages-field"><input type="checkbox" checked={form.web.fetchPages} onChange={(event) => updateWeb({ fetchPages: event.target.checked })} />{t("获取搜索结果的原始正文")}</label><p className="field-help">{t("未取回正文的材料会标为“搜索摘要”，不会显示为已核验法律依据。")}</p>
        </fieldset> : <p className="field-help">{t("与官方公开来源独立开关。需要通用搜索时，可连接自己的 SearXNG 服务并设置来源域名范围。")}</p>}

        <div className="settings-divider" /><div className="advanced-title"><Settings2 size={15} /><strong>{t("检索限制")}</strong><span>{t("分别应用于每一路请求")}</span></div><div className="settings-numbers"><label className="field"><span>{t("每路结果上限")}</span><input required type="number" min="1" max="8" step="1" disabled={!!busy || knowledgeRunning} value={form.maxResults || ''} onChange={(event) => { setForm((value) => ({ ...value, maxResults: Number(event.target.value) })); changed(); }} /></label><label className="field"><span>{t("请求超时（秒）")}</span><input required type="number" min="5" max="60" step="1" disabled={!!busy || knowledgeRunning} value={form.timeoutSeconds || ''} onChange={(event) => { setForm((value) => ({ ...value, timeoutSeconds: Number(event.target.value) })); changed(); }} /></label></div>
      </form>
      {officialResult && <section className="retrieval-test-result official-test-result" aria-labelledby="official-test-result-title"><h3 id="official-test-result-title">{t("本次官方来源测试")}</h3><p className="official-source-intro">{t("以下是本次实际读取的范围与原文片段；未覆盖的目录不能视为已检索。")}</p><RetrievalChannelSummary bundle={officialResult} /><RetrievalAttempts bundle={officialResult} />{officialResult.limitations.length > 0 && <ul className="retrieval-limitations">{officialResult.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>}{officialResult.evidence.length > 0 && <div className="source-evidence-grid">{officialResult.evidence.map((evidence) => <SourceEvidenceCard key={evidence.id} evidence={evidence} />)}</div>}</section>}
      {testResult && <section className="retrieval-test-result" aria-labelledby="retrieval-test-title"><h3 id="retrieval-test-title">{t("本次检索测试")}</h3><RetrievalChannelSummary bundle={testResult} /><RetrievalAttempts bundle={testResult} />{testResult.limitations.length > 0 && <ul className="retrieval-limitations">{testResult.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>}</section>}
      <div className="key-storage-note"><LockKeyhole size={14} /><p>{isPreview ? t("设置仅暂存在页面内存，刷新后清空。") : t("知识库密钥与搜索密钥单独保存，不写入检索查询、报告或普通日志。")}</p></div>
    </div>
    <div className="settings-footer">{feedback && <div className={`notice settings-notice ${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.kind === 'error' ? <CircleAlert size={16} /> : feedback.kind === 'success' ? <CircleCheck size={16} /> : <Info size={16} />}<span>{translateMessage(feedback.text)}</span></div>}<div className="settings-footer-actions"><button className="button secondary" type="button" onClick={() => save(true)} disabled={!!busy || knowledgeRunning}>{busy === 'test' ? <LoaderCircle className="spin" size={15} /> : <Globe2 size={15} />}{busy === 'test' ? t("正在检索…") : t("保存并测试检索")}</button><button className="button primary" type="submit" form="retrieval-settings-form" disabled={!!busy || knowledgeRunning}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{busy === 'save' ? t("保存中…") : t("保存配置")}</button></div></div>
  </div></div>;
}
