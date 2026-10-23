import { useI18n } from './i18n';
import { useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronDown, CircleAlert, Clock3, FileText, Globe2, Info, LoaderCircle } from 'lucide-react';
import type { OfficialRetrievalCoverage, RetrievalBundle, RetrievalStatus, ReviewResult, SourceCitation, SourceEvidence } from '../../shared/contracts';
import './official-sources.css';

const statusLabels: Record<RetrievalStatus, string> = {
  not_configured: '未配置', user_disabled: '已关闭', skipped: '未执行', complete: '检索完成',
  empty: '无结果', partial: '部分完成', timeout: '超时', failed: '失败', cancelled: '已取消',
};
const kindLabels: Record<SourceEvidence['kind'], string> = {
  company_policy: '企业资料', statute: '法律法规', judicial_interpretation: '司法解释', case: '案例', commentary: '相关论述', contract_template: '合同示范文本',
};
const scopeLabels: Record<SourceEvidence['contentScope'], string> = {
  full_text: '已取正文', fragment: '资料片段', search_snippet: '搜索摘要 · 未取正文',
};
const providerLabels = { folder: '本地知识库', dify: 'Dify', standard: '标准知识库 API', brave: 'Brave Search', searxng: 'SearXNG', official_catalog: '官方目录检索', official_page: '指定官方原文', professional_mcp: '专业法律 MCP', remote_index: '远端知识库索引' };

function timeLabel(value: string | null, dateLocale: string, unknown: string) {
  if (!value) return unknown;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(dateLocale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function sourceDateLabel(value: string | null, dateLocale: string, unknown: string) {
  if (value && /^\d{4}-\d{2}-\d{2}$/u.test(value)) return value.replaceAll('-', '/');
  return timeLabel(value, dateLocale, unknown);
}

function isFutureDate(value: string | null, reference: string) {
  if (!value) return false;
  const date = Date.parse(value); const retrieved = Date.parse(reference);
  if (!Number.isFinite(date) || !Number.isFinite(retrieved)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(retrieved));
    const civilDate = ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value).join('-');
    return value > civilDate;
  }
  return date > retrieved;
}

export function RetrievalStatusBadge({ status }: { status: RetrievalStatus }) {
  const { t, translateMessage, dateLocale } = useI18n();

  return <span className={`retrieval-status ${status}`}>{t(statusLabels[status])}</span>;
}

export function SourceEvidenceCard({ evidence, onOpen, citation, compact = false }: {
  evidence: SourceEvidence;
  onOpen?: (evidenceId: string) => Promise<void>;
  citation?: SourceCitation;
  compact?: boolean;
}) {
  const { t, translateMessage, dateLocale } = useI18n();

  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const metadata = evidence.officialMetadata;
  const futureEffectiveDate = isFutureDate(evidence.effectiveAt, evidence.retrievedAt);
  const futurePublishedDate = isFutureDate(evidence.publishedAt, evidence.retrievedAt);
  const openSource = async () => {
    if (!onOpen) return;
    setOpening(true); setOpenError(null);
    try { await onOpen(evidence.id); }
    catch (error) { setOpenError(error instanceof Error ? error.message : String(error)); }
    finally { setOpening(false); }
  };
  return <article className={`source-evidence-card ${compact ? 'compact' : ''}`}>
    <div className="source-evidence-heading">
      {evidence.channel === 'knowledge' ? <BookOpen size={14} /> : <Globe2 size={14} />}
      <strong>{evidence.title || t("未命名资料")}</strong>
      {onOpen && evidence.sourceUri && <button className="source-open-button" disabled={opening} onClick={openSource} title={evidence.sourceUri.startsWith('file:') ? t("在文件管理器中显示来源文件") : t("使用系统浏览器打开来源")} aria-label={t("打开来源：{v0}", { v0: evidence.title || '未命名资料' })}>{opening ? <LoaderCircle className="spin" size={14} /> : <ArrowUpRight size={14} />}</button>}
    </div>
    <div className="source-badges"><span>{t(kindLabels[evidence.kind])}</span><span className={evidence.contentScope === 'search_snippet' ? 'limited' : ''}>{t(scopeLabels[evidence.contentScope])}</span>{evidence.isOfficial && <span title={t("仅根据来源地址判断域名归属；不代表页面真实性、内容时效或法律效力已核实")}>{t("官方域名")}</span>}<span className="unknown">{t("效力 / 时效未确认")}</span>{futureEffectiveDate && <span className="limited">{t("检索时尚未到生效日")}</span>}{futurePublishedDate && <span className="limited">{t("发布日期晚于检索时间")}</span>}</div>
    {citation && <div className={`citation-match ${citation.matchStatus}`}><span />{citation.matchStatus === 'matched' ? t("引用文字已匹配资料片段") : t("引用文字未匹配资料片段")}<small>{t("不代表法律适用已核验")}</small></div>}
    {citation?.quote && <blockquote className="citation-quote">{citation.quote}</blockquote>}
    <details className="source-excerpt-details" open={!compact}>
      <summary><FileText size={12} />{t("查看取回片段")}<ChevronDown size={12} /></summary>
      <p className="source-excerpt">{evidence.excerpt || t("此来源未返回可展示的正文片段。")}</p>
    </details>
    <dl className="source-metadata"><div><dt>{t("定位")}</dt><dd>{evidence.locator || t("未提供具体位置")}</dd></div><div><dt>{t("检索时间")}</dt><dd>{timeLabel(evidence.retrievedAt, dateLocale, t("未知"))}</dd></div>{(!compact || metadata) && <><div><dt>{t("发布日期")}</dt><dd>{sourceDateLabel(evidence.publishedAt, dateLocale, t("未知"))}</dd></div><div><dt>{t("生效日期")}</dt><dd>{sourceDateLabel(evidence.effectiveAt, dateLocale, t("未知"))}</dd></div></>}{metadata && <><div><dt>{t("发布机关")}</dt><dd>{metadata.publisher || t("未知")}</dd></div><div><dt>{t("文号")}</dt><dd>{metadata.documentNumber || t("未知")}</dd></div><div><dt>{t("版本")}</dt><dd>{metadata.versionLabel || t("未知")}</dd></div>{metadata.article && <div><dt>{t("相关条文")}</dt><dd>{metadata.article}</dd></div>}<div><dt>{t("取得方式")}</dt><dd>{metadata.discoveredVia === 'catalog' ? t("公开目录标题匹配") : metadata.discoveredVia === 'search' ? t("搜索服务发现地址，站点原文解析") : t("用户指定的官方原文链接")}</dd></div>{metadata.catalogUrl && <div><dt>{t("目录入口")}</dt><dd>{metadata.catalogUrl}</dd></div>}{metadata.validityNote && <div><dt>{t("时效说明")}</dt><dd>{metadata.validityNote}</dd></div>}</>}</dl>
    {evidence.localIndex && <details className="source-excerpt-details"><summary><FileText size={12} />{t("引用版本与校验值")}<ChevronDown size={12} /></summary><dl className="source-metadata"><div><dt>{t("索引版本")}</dt><dd>{evidence.localIndex.versionId}</dd></div><div><dt>{t("文件 SHA-256")}</dt><dd>{evidence.localIndex.fileSha256}</dd></div><div><dt>{t("片段 SHA-256")}</dt><dd>{evidence.excerptSha256}</dd></div><div><dt>{t("索引时间")}</dt><dd>{timeLabel(evidence.localIndex.indexedAt, dateLocale, t("未知"))}</dd></div></dl></details>}
    <div className="source-uri">{evidence.sourceUri || t("来源未提供可打开的地址")}</div>
    {openError && <p className="source-open-error" role="alert"><CircleAlert size={12} />{openError}</p>}
    {evidence.warnings.length > 0 && <ul className="source-warning-list">{evidence.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
  </article>;
}

export function RetrievalChannelSummary({ bundle }: { bundle: RetrievalBundle }) {
  const { t, translateMessage, dateLocale } = useI18n();

  const hasDetailedWebStatus = bundle.officialStatus !== undefined || bundle.searchStatus !== undefined;
  const sections: Array<{ id: string; label: string; status: RetrievalStatus; attemptIds: Set<string>; knowledge: boolean }> = [{ id: 'knowledge', label: '企业知识库', status: bundle.knowledgeStatus, attemptIds: new Set(bundle.attempts.filter((attempt) => attempt.channel === 'knowledge').map((attempt) => attempt.id)), knowledge: true }];
  if (hasDetailedWebStatus) {
    sections.push({ id: 'official', label: '官方公开来源', status: bundle.officialStatus ?? 'not_configured', attemptIds: new Set(bundle.attempts.filter((attempt) => ['official_catalog', 'official_page'].includes(attempt.provider)).map((attempt) => attempt.id)), knowledge: false });
    sections.push({ id: 'search', label: '通用搜索服务', status: bundle.searchStatus ?? 'not_configured', attemptIds: new Set(bundle.attempts.filter((attempt) => attempt.channel === 'web' && !['official_catalog', 'official_page'].includes(attempt.provider)).map((attempt) => attempt.id)), knowledge: false });
  } else sections.push({ id: 'web', label: '互联网检索', status: bundle.webStatus, attemptIds: new Set(bundle.attempts.filter((attempt) => attempt.channel === 'web').map((attempt) => attempt.id)), knowledge: false });
  return <div className="retrieval-channel-summary">{sections.map((section) => <div className="retrieval-channel" key={section.id}><div>{section.knowledge ? <BookOpen size={15} /> : <Globe2 size={15} />}<strong>{t(section.label)}</strong><RetrievalStatusBadge status={section.status} /></div><span>{t("取回")}<b>{bundle.evidence.filter((item) => section.attemptIds.has(item.attemptId)).length}</b>{t("项材料 ·")}{section.attemptIds.size}{t("次查询")}</span></div>)}</div>;
}

function OfficialCoverage({ coverage }: { coverage: OfficialRetrievalCoverage }) {
  const { t, translateMessage, dateLocale } = useI18n();

  return <div className="official-coverage"><strong>{t("本次读取覆盖")}</strong><dl className="source-metadata"><div><dt>{t("行政法规目录")}</dt><dd>{t("成功读取")}{coverage.catalogPagesRead}{t("/ 请求")}{coverage.catalogPagesRequested}{t("页；上限")}{coverage.pagesLimit}{t("页")}</dd></div><div><dt>{t("目录总页")}</dt><dd>{coverage.totalPages === null ? t("未知") : coverage.totalPages}</dd></div><div><dt>{t("目录候选")}</dt><dd>{coverage.catalogCandidates}{t("项；标题匹配")}{coverage.matchedCandidates}{t("项")}</dd></div><div><dt>{t("指定链接")}</dt><dd>{t("成功读取")}{coverage.userUrlsRead}{t("/ 请求")}{coverage.userUrlsRequested}{t("个")}</dd></div><div><dt>{t("读取失败")}</dt><dd>{coverage.failedReads}{t("次")}</dd></div></dl>{coverage.courtCatalogs?.map(catalog => <div key={catalog.catalog}><strong>{translateMessage(catalog.label)}</strong><dl className="source-metadata"><div><dt>{t("栏目页数")}</dt><dd>{t("成功")}{catalog.pagesRead}{t("/ 请求")}{catalog.pagesRequested}{t("；共")}{catalog.totalPages ?? t("未知")}{t("页")}</dd></div><div><dt>{t("栏目候选")}</dt><dd>{catalog.candidates}{t("项，标题匹配")}{catalog.matchedCandidates}{t("项")}</dd></div><div><dt>{t("原文")}</dt><dd>{t("取得")}{catalog.documentsRead}{t("项；失败")}{catalog.failedReads}{t("次")}</dd></div></dl><p>{catalog.truncated ? t("栏目或结果覆盖不完整，仍需补查。") : catalog.exhausted ? t("已到此栏目末页，未代表法规或案例全库检索。") : t("尚未确认栏目末页。")}</p></div>)}<p>{coverage.truncated ? t("本次达到读取或结果上限，覆盖不完整。") : coverage.catalogPagesRequested === 0 ? t("本分支未读取目录。") : coverage.catalogExhausted ? t("已到本次目录的末页；不代表覆盖所有法律资料。") : t("本次未确认已读到目录末页。")}{t("无匹配结果不代表相关规定不存在。")}</p></div>;
}

export function RetrievalAttempts({ bundle }: { bundle: RetrievalBundle }) {
  const { t, translateMessage, dateLocale } = useI18n();

  if (!bundle.attempts.length) return <p className="retrieval-no-attempts">{t("本次没有已执行的检索请求记录。")}</p>;
  return <div className="retrieval-attempts">{bundle.attempts.map((attempt) => <details className="retrieval-attempt" key={attempt.id} open={Boolean(attempt.coverage)}>
    <summary><span className="attempt-channel">{t(providerLabels[attempt.provider])}</span><span className="attempt-query">{attempt.query}</span><span className="attempt-count">{attempt.resultCount}{t("项")}</span><RetrievalStatusBadge status={attempt.status} /><ChevronDown size={12} /></summary>
    <div className="attempt-body"><dl className="source-metadata"><div><dt>{t("查询内容")}</dt><dd>{attempt.query}</dd></div><div><dt>{t("开始")}</dt><dd>{timeLabel(attempt.startedAt, dateLocale, t("未知"))}</dd></div><div><dt>{t("结束")}</dt><dd>{timeLabel(attempt.finishedAt, dateLocale, t("未知"))}</dd></div></dl>{attempt.coverage && <OfficialCoverage coverage={attempt.coverage} />}{attempt.error && <p className="attempt-error"><CircleAlert size={12} />{attempt.error}</p>}{attempt.warnings.length > 0 && <ul className="source-warning-list">{attempt.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</div>
  </details>)}</div>;
}

export function ReviewSources({ review, onOpen }: { review: ReviewResult; onOpen: (evidenceId: string) => Promise<void> }) {
  const { t, translateMessage, dateLocale } = useI18n();

  const bundle = review.retrieval;
  return <details className="card review-sources" aria-labelledby="review-sources-title"><summary className="pane-heading"><div className="section-heading-left"><BookOpen size={17} /><h2 id="review-sources-title">{t("本次资料与检索记录")}</h2>{bundle && <span className="count-badge">{bundle.evidence.length}</span>}</div><span className="source-snapshot-label"><Clock3 size={12} />{t("审核时的检索快照")}</span><ChevronDown className="source-panel-chevron" size={14} /></summary><div className="review-sources-body">
    {bundle ? <><RetrievalChannelSummary bundle={bundle} /><p className="retrieval-explanation"><Info size={13} />{t("检索完成表示材料已经取回。引文匹配、资料效力和法律适用需要分别判断。")}</p><details className="retrieval-queries" open={bundle.attempts.some((attempt) => ['failed', 'timeout', 'cancelled'].includes(attempt.status))}><summary>{t("查看查询与各路结果")}<span>{bundle.attempts.length}{t("次请求")}</span><ChevronDown size={13} /></summary><RetrievalAttempts bundle={bundle} /></details>{bundle.limitations.length > 0 && <ul className="retrieval-limitations">{bundle.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>}{bundle.evidence.length ? <div className="source-evidence-grid">{bundle.evidence.map((evidence) => <SourceEvidenceCard key={evidence.id} evidence={evidence} onOpen={onOpen} />)}</div> : <div className="source-empty"><FileText size={21} /><p>{t("本次没有可展示的来源材料")}</p><span>{t("请结合上方检索状态和限制阅读审核结果。")}</span></div>}</> : <><div className="legacy-coverage"><span><BookOpen size={14} />{t("企业知识库")}<RetrievalStatusBadge status={review.coverage.knowledgeStatus} /></span><span><Globe2 size={14} />{t("互联网检索")}<RetrievalStatusBadge status={review.coverage.webStatus} /></span></div><p className="retrieval-explanation"><Info size={13} />{review.mode === 'local' ? t("本地规则检查不执行知识库或互联网检索。") : t("该历史审核未保存检索来源记录，请以当时报告中的范围和限制为准。")}</p></>}
  </div></details>;
}
