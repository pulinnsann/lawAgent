import { useI18n } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CircleAlert, Database, FileSearch, FolderOpen, Info, LoaderCircle, RefreshCw, Search, ShieldCheck, Square, X } from 'lucide-react';
import type { ContractAssistantBridge } from '../../shared/contracts';
import type { KnowledgeHit, KnowledgePreferences, KnowledgeSearchResult, KnowledgeState, KnowledgeSyncMode } from '../../shared/knowledge';
import { defaultKnowledgePreferences } from '../../shared/knowledge-preferences';

const jobLabels: Record<NonNullable<KnowledgeState['job']>['status'], string> = {
  running: '同步中', completed: '已完成', partial: '部分完成', cancelled: '已取消', failed: '失败', interrupted: '上次任务中断',
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const timeLabel = (value: string | null, locale: string, fallback: string) => value ? new Date(value).toLocaleString(locale, { hour12: false }) : fallback;

export default function LocalKnowledgePanel({ bridge, folderPath, saved, isPreview, preferences, startedJobId, onRunningChange }: {
  bridge: ContractAssistantBridge;
  folderPath: string | null;
  saved: boolean;
  isPreview: boolean;
  preferences?: KnowledgePreferences;
  startedJobId?: string | null;
  onRunningChange?: (running: boolean) => void;
}) {
  const { t, translateMessage, dateLocale } = useI18n();

  const [state, setState] = useState<KnowledgeState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [action, setAction] = useState<'incremental' | 'verify' | 'cancel' | null>(null);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const currentFolder = useRef(folderPath);
  const runningCallback = useRef(onRunningChange);
  runningCallback.current = onRunningChange;
  currentFolder.current = folderPath;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let running = false;
      try {
        const next = await bridge.getKnowledgeState();
        if (stopped) return;
        setState(next); setStateError(null);
        running = next.job?.status === 'running';
        if (next.job && next.job.status !== 'running') setPendingJobId((id) => id === next.job?.id ? null : id);
      } catch (error) { if (!stopped) setStateError(errorText(error)); }
      if (!stopped) timer = setTimeout(poll, running || pendingJobId ? 1000 : 5000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [bridge, folderPath, saved, refresh, pendingJobId]);

  useEffect(() => { generation.current += 1; setResult(null); setFeedback(null); setSearching(false); }, [folderPath, saved]);
  useEffect(() => { if (startedJobId) { setPendingJobId(startedJobId); setRefresh((value) => value + 1); } }, [startedJobId]);

  const current = Boolean(folderPath && saved && state?.folderPath === folderPath);
  const activeJob = state?.job?.status === 'running' ? state.job : null;
  const running = Boolean(activeJob || pendingJobId);
  const canUse = Boolean(folderPath && saved && !isPreview);
  const savedPreferences = preferences ?? defaultKnowledgePreferences();
  useEffect(() => { runningCallback.current?.(running); }, [running]);

  const sync = async (mode: KnowledgeSyncMode) => {
    if (!canUse || running || action) return;
    setAction(mode); setFeedback(null);
    try {
      const { jobId } = await bridge.startKnowledgeSync(mode);
      if (!mounted.current) return;
      setPendingJobId(jobId); setRefresh((value) => value + 1);
      setFeedback({ error: false, text: t("同步任务已启动。下方显示实际阶段和文件计数。") });
    } catch (error) { if (mounted.current) setFeedback({ error: true, text: errorText(error) }); }
    finally { if (mounted.current) setAction(null); }
  };
  const cancel = async () => {
    const jobId = activeJob?.id ?? pendingJobId;
    if (!jobId || action) return;
    setAction('cancel'); setFeedback(null);
    try {
      await bridge.cancelKnowledgeSync(jobId);
      if (mounted.current) { setRefresh((value) => value + 1); setFeedback({ error: false, text: t("已请求取消，正在等待当前处理安全结束。") }); }
    } catch (error) { if (mounted.current) setFeedback({ error: true, text: errorText(error) }); }
    finally { if (mounted.current) setAction(null); }
  };
  const search = async () => {
    if (!canUse || searching || !query.trim()) return;
    const requestGeneration = ++generation.current;
    setSearching(true); setResult(null); setFeedback(null);
    try {
      const next = await bridge.searchKnowledge({ query: query.trim(), limit: 6 });
      if (mounted.current && generation.current === requestGeneration) { setResult(next); setState(next.state); }
    } catch (error) { if (mounted.current && generation.current === requestGeneration) setFeedback({ error: true, text: errorText(error) }); }
    finally { if (mounted.current && generation.current === requestGeneration) setSearching(false); }
  };
  const readChunk = async (hit: KnowledgeHit) => {
    if (readingId) return;
    const selectedFolder = folderPath;
    setReadingId(hit.chunkId); setFeedback(null);
    try {
      const next = await bridge.getKnowledgeChunk(hit.chunkId);
      if (mounted.current && currentFolder.current === selectedFolder) setResult((value) => value ? { ...value, hits: value.hits.map((item) => item.chunkId === hit.chunkId ? next : item) } : value);
    } catch (error) { if (mounted.current) setFeedback({ error: true, text: errorText(error) }); }
    finally { if (mounted.current) setReadingId(null); }
  };
  const openSource = async (hit: KnowledgeHit) => {
    if (openingId) return;
    setOpeningId(hit.chunkId); setFeedback(null);
    try { await bridge.openKnowledgeSource(hit.chunkId); }
    catch (error) { if (mounted.current) setFeedback({ error: true, text: errorText(error) }); }
    finally { if (mounted.current) setOpeningId(null); }
  };

  return <section className="local-knowledge-panel" aria-labelledby="local-knowledge-title">
    <div className="local-knowledge-heading"><div><Database size={15} /><h3 id="local-knowledge-title">{t("本地资料索引")}</h3></div><button className="icon-button" type="button" aria-label={t("刷新本地知识库状态")} onClick={() => setRefresh((value) => value + 1)} disabled={!!action}><RefreshCw size={13} /></button></div>
    <p className="field-help">{savedPreferences.autoSyncEnabled ? t("首次手动建库完成后，应用空闲时每 {v0} 分钟增量同步；重启时自动增量核对，并恢复中断任务。", { v0: savedPreferences.syncIntervalMinutes }) : t("自动同步已关闭。可按需手动增量更新或完整核验。")}{t("下方展示最近一轮状态，源文件保持只读。")}</p>
    {isPreview ? <p className="knowledge-inline-note"><Info size={13} />{t("浏览器界面预览未读取文件，不能建立索引或执行真实检索。")}</p>
      : !folderPath ? <p className="knowledge-inline-note"><FolderOpen size={13} />{t("选择资料文件夹并保存配置后，即可建立本地索引。")}</p>
        : !saved ? <p className="knowledge-inline-note"><Info size={13} />{t("当前目录或个性化设置尚未保存。请先保存配置，再建立或更新索引。")}</p> : null}
    <div className="knowledge-sync-actions"><button className="button secondary small" type="button" onClick={() => void sync('incremental')} disabled={!canUse || running || !!action}>{action === 'incremental' ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{current && state?.indexedFiles ? t("增量更新") : t("建立 / 增量更新")}</button><button className="button secondary small" type="button" onClick={() => void sync('verify')} disabled={!canUse || running || !!action}>{action === 'verify' ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}{t("完整核验")}</button>{running && <button className="button secondary small knowledge-cancel" type="button" onClick={() => void cancel()} disabled={!!action}>{action === 'cancel' ? <LoaderCircle className="spin" size={12} /> : <Square size={11} />}{t("取消同步")}</button>}</div>
    {stateError && <p className="knowledge-inline-note error" role="alert"><CircleAlert size={13} />{t("读取索引状态失败：")}{stateError}</p>}
    {current && state ? <><div className="knowledge-metrics"><div><strong>{state.indexedFiles}</strong><span>{t("已存储文件")}</span></div><div><strong>{state.chunks}</strong><span>{t("已存储片段")}</span></div><div className={state.staleFiles ? 'attention' : ''}><strong>{state.staleFiles}</strong><span>{t("待更新文件")}</span></div></div><p className="knowledge-last-sync">{t("最近同步：")}{timeLabel(state.lastSyncedAt, dateLocale, t("尚未同步"))}{t("。存储计数可能包含已被当前规则排除的历史版本，不等于本次可检索范围。")}</p>{state.needsSync && <p className="knowledge-inline-note"><Info size={13} />{t("资料范围或个性化设置已变更，需要同步后才能补齐当前范围的索引。")}</p>}</>
      : !stateError && !isPreview && saved && folderPath && <p className="knowledge-inline-note"><LoaderCircle className="spin" size={13} />{t("正在读取已保存文件夹的索引状态…")}</p>}
    {state?.job && (current || activeJob) && <div className={`knowledge-job ${state.job.status}`} role={state.job.status === 'running' ? 'status' : undefined}>
      <div className="knowledge-job-heading"><strong>{t(jobLabels[state.job.status])}</strong><span>{state.job.phase}</span>{state.job.status === 'running' && <LoaderCircle className="spin" size={13} />}</div>
      {!current && <p className="field-help">{t("此任务属于此前保存的文件夹：")}{state.job.folderPath}</p>}
      <div className="knowledge-job-counts"><span>{t("扫描")}<b>{state.job.scanned}</b></span><span>{t("入库")}<b>{state.job.indexed}</b></span><span>{t("未变更")}<b>{state.job.unchanged}</b></span><span>{t("删除")}<b>{state.job.deleted}</b></span><span>{t("跳过")}<b>{state.job.skipped}</b></span><span>{t("失败")}<b>{state.job.failed}</b></span></div>
      <p className="field-help">{state.job.mode === 'verify' ? t("完整核验") : t("增量同步")} · {state.job.fullScan ? t("目录遍历已完成") : state.job.status === 'running' ? t("目录遍历尚未完成") : t("目录遍历未完成")}{t("· 开始于")}{timeLabel(state.job.startedAt, dateLocale, t("尚未同步"))}{state.job.finishedAt ? t(" · 结束于 {v0}", { v0: timeLabel(state.job.finishedAt, dateLocale, t("尚未同步")) }) : ''}</p>
      {!!state.job.errors.length && <details className="knowledge-errors"><summary>{t("查看")}{state.job.errors.length}{t("项文件问题")}</summary><ul>{state.job.errors.map((error, index) => <li key={`${error.path}-${index}`}><strong>{error.path}</strong><span>{error.message}</span></li>)}</ul></details>}
    </div>}
    {!!state?.limitations.length && <details className="knowledge-limitations"><summary><Info size={12} />{t("索引覆盖与限制")}</summary><ul>{state.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>{current && <p className="field-help">{t("索引引擎")}{state.engine}{t("· 分词版本")}{state.tokenizerVersion}</p>}</details>}
    <div className="knowledge-search"><label className="field" htmlFor="knowledge-search-query"><span><FileSearch size={13} />{t("测试本地资料检索")}</span><span className="field-help">{t("自由输入关键词，只查本地索引，不联网、不调用模型。")}</span></label><div className="knowledge-search-input"><input id="knowledge-search-query" value={query} maxLength={500} placeholder={t("例如：验收 付款 保密")} disabled={!canUse || searching} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} /><button className="button secondary small" type="button" onClick={() => void search()} disabled={!canUse || searching || !query.trim()}>{searching ? <LoaderCircle className="spin" size={13} /> : <Search size={13} />}{t("检索")}</button></div></div>
    {feedback && <div className={`knowledge-feedback ${feedback.error ? 'error' : ''}`} role={feedback.error ? 'alert' : 'status'}>{feedback.error ? <CircleAlert size={13} /> : <Info size={13} />}<span>{translateMessage(feedback.text)}</span><button type="button" className="icon-button" aria-label={t("清除知识库提示")} onClick={() => setFeedback(null)}><X size={12} /></button></div>}
    {result && <div className="knowledge-search-results"><div className="knowledge-results-heading"><strong>{t("返回")}{result.hits.length}{t("项片段")}</strong><span>{result.elapsedMs} ms</span></div><p className="knowledge-search-terms">{t("查询：")}{result.query}{result.expandedTerms.length > 0 && t(" · 检索词：{v0}", { v0: result.expandedTerms.join('、') })}</p>{result.hits.length === 0 && <p className="knowledge-no-results">{t("本次没有匹配片段。可调整关键词，并查看索引覆盖范围和同步状态。")}</p>}{result.hits.map((hit) => <article className="knowledge-hit" key={hit.chunkId}><div className="knowledge-hit-heading"><strong>{hit.title}</strong><button type="button" className="source-open-button" title={t("在系统中显示来源文件")} aria-label={t("显示来源文件：{v0}", { v0: hit.title })} disabled={!!openingId} onClick={() => void openSource(hit)}>{openingId === hit.chunkId ? <LoaderCircle className="spin" size={13} /> : <ArrowUpRight size={13} />}</button></div><p className="knowledge-hit-path">{hit.relativePath}</p><p className="knowledge-hit-locator">{hit.locator}</p><details className="knowledge-hit-text" open><summary>{t("原文片段全文")}</summary><p>{hit.excerpt}</p><button className="text-button" type="button" disabled={!!readingId} onClick={() => void readChunk(hit)}>{readingId === hit.chunkId ? <LoaderCircle className="spin" size={11} /> : <RefreshCw size={11} />}{t("重新读取已索引片段")}</button></details><details className="knowledge-hit-proof"><summary>{t("来源、版本与校验值")}</summary><dl><div><dt>{t("来源")}</dt><dd>{hit.sourceUri}</dd></div><div><dt>{t("版本 ID")}</dt><dd>{hit.versionId}</dd></div><div><dt>{t("文件 SHA-256")}</dt><dd>{hit.fileSha256}</dd></div><div><dt>{t("片段 SHA-256")}</dt><dd>{hit.excerptSha256}</dd></div><div><dt>{t("索引时间")}</dt><dd>{timeLabel(hit.indexedAt, dateLocale, t("尚未同步"))}</dd></div></dl></details>{hit.warnings.length > 0 && <ul className="knowledge-hit-warnings">{hit.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</article>)}</div>}
  </section>;
}
