import { useI18n } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CircleAlert, ClipboardCheck, Info, LoaderCircle, RefreshCw, Undo2 } from 'lucide-react';
import type { ContractAssistantBridge, ReviewFinding, ReviewResult } from '../../shared/contracts';
import type { RiskDispositionStatus, RiskDispositionWorkspace } from '../../shared/assurance';
import './risk-dispositions.css';

export const dispositionLabels: Record<RiskDispositionStatus, string> = { unreviewed: '待处理', confirmed: '已确认问题', needs_information: '待补信息', escalated: '已升级处理', business_accepted: '业务接受风险', fixed: '人工标记已整改', false_positive: '人工判断误报' };
const severities = { high: '高风险', medium: '中风险', low: '低风险', unrated: '待判断' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
export default function RiskDispositionPanel({ bridge, review, isPreview, onLocate }: { bridge: ContractAssistantBridge; review: ReviewResult; isPreview: boolean; onLocate: (finding: ReviewFinding) => void }) {
  const { t, translateMessage, dateLocale } = useI18n();

  const [workspace, setWorkspace] = useState<RiskDispositionWorkspace | null>(null);
  const [findingId, setFindingId] = useState(review.findings[0]?.id ?? '');
  const [status, setStatus] = useState<RiskDispositionStatus>('unreviewed');
  const [reason, setReason] = useState(''); const [actorLabel, setActorLabel] = useState('法务');
  const [filter, setFilter] = useState<'all' | RiskDispositionStatus>('all');
  const [busy, setBusy] = useState<string | null>('load');
  const [notice, setNotice] = useState<{ kind: 'error' | 'info' | 'success'; text: string } | null>(null);
  const alive = useRef(true);
  const latest = (id: string, value = workspace) => value?.events.filter(event => event.findingId === id).at(-1);
  const selected = review.findings.find(item => item.id === findingId);
  const current = latest(findingId); const dirty = reason.length > 0 || status !== (current?.status ?? 'unreviewed');
  useEffect(() => { alive.current = true; bridge.getRiskDispositions(review.id).then(value => { if (!alive.current) return; setWorkspace(value); setStatus(latest(findingId, value)?.status ?? 'unreviewed'); }).catch(error => alive.current && setNotice({ kind: 'error', text: messageOf(error) })).finally(() => alive.current && setBusy(null)); return () => { alive.current = false; }; }, [bridge, review.id]);
  const refresh = async () => { if (busy) return; setBusy('load'); try { const value = await bridge.getRiskDispositions(review.id); if (alive.current) { setWorkspace(value); if (!dirty) setStatus(latest(findingId, value)?.status ?? 'unreviewed'); setNotice({ kind: 'info', text: t("已刷新处理记录和修订号，当前未提交的说明保留；请核对后重新提交。") }); } } catch (error) { if (alive.current) setNotice({ kind: 'error', text: messageOf(error) }); } finally { if (alive.current) setBusy(null); } };
  const choose = (id: string) => { if (busy) return; if (dirty) { setNotice({ kind: 'info', text: t("当前有未提交的处置说明，请先提交或撤销，再选择其他风险。") }); return; } setFindingId(id); setStatus(latest(id)?.status ?? 'unreviewed'); setReason(''); setNotice(null); };
  const invalid = !reason.trim() || reason.trim().length > 2000 || !actorLabel.trim() || actorLabel.trim().length > 80 || /[\u0000-\u001f\u007f]/u.test(actorLabel);
  const save = async () => {
    if (!workspace || !selected || busy || invalid) return;
    setBusy('save'); setNotice(null);
    try { const value = await bridge.saveRiskDisposition({ reviewId: review.id, findingId, expectedRevision: workspace.revision, status, reason: reason.trim(), actorLabel: actorLabel.trim() }); if (alive.current) { setWorkspace(value); setStatus(latest(findingId, value)?.status ?? status); setReason(''); setNotice({ kind: 'success', text: t("处置记录已保存。风险等级、原审核意见及修改建议的采纳状态保留。") }); } }
    catch (error) { if (alive.current) setNotice({ kind: 'error', text: t("{v0} 可刷新记录并保留说明后重试。", { v0: messageOf(error) }) }); }
    finally { if (alive.current) setBusy(null); }
  };
  const filtered = review.findings.filter(item => filter === 'all' || (latest(item.id)?.status ?? 'unreviewed') === filter);
  const counts = Object.fromEntries(Object.keys(dispositionLabels).map(value => [value, review.findings.filter(item => (latest(item.id)?.status ?? 'unreviewed') === value).length]));
  return <details className="card risk-disposition-panel" id={`dispositions-${review.id}`}><summary className="pane-heading"><div className="section-heading-left"><ClipboardCheck size={17} /><h2>{t("人工风险处置")}</h2><span className="count-badge">{review.findings.length}{t("项")}</span></div><ChevronDown size={14} /></summary><div className="disposition-body">
    <p className="disposition-intro">{t("人工处理状态与风险等级分别记录。业务接受风险不代表条款合法或已整改；采纳修改建议也不会自动改变这里的状态。")}</p>
    {isPreview && <p className="disposition-note"><Info size={14} />{t("当前为内存演示，提交不调用真实服务、不落盘，也不会将误报反馈自动学习为新规则。")}</p>}
    <div className="disposition-statistics">{Object.entries(dispositionLabels).map(([value, label]) => <span key={value}>{t(label)}<strong>{counts[value]}</strong></span>)}</div>
    <div className="disposition-toolbar"><label className="field"><span>{t("人工处理状态筛选")}</span><select aria-label={t("人工处理状态筛选")} value={filter} disabled={Boolean(busy) || dirty} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">{t("全部人工处理状态")}</option>{Object.entries(dispositionLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label><button className="text-button" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={13} />{t("刷新处理记录")}</button></div>
    {notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'error' ? <CircleAlert size={14} /> : notice.kind === 'success' ? <Check size={14} /> : <Info size={14} />}<span>{translateMessage(notice.text)}</span></div>}
    <div className="disposition-layout"><div className="disposition-findings">{filtered.length ? filtered.map(item => <button key={item.id} className={`disposition-finding ${findingId === item.id ? 'active' : ''}`} disabled={Boolean(busy)} onClick={() => choose(item.id)}><strong>{item.title}</strong><span>{t(severities[item.severity])} · {t(dispositionLabels[latest(item.id)?.status ?? 'unreviewed'])}</span></button>) : <p>{t("当前筛选下没有风险事项。")}</p>}</div><div className="disposition-editor">{selected ? <>
      <div className="disposition-selected-heading"><h3>{selected.title}</h3><span>{t("原风险等级：")}{t(severities[selected.severity])}</span>{selected.blockIds.length > 0 && <button className="text-button" onClick={() => onLocate(selected)}>{t("定位原文")}</button>}</div>
      {selected.severity === 'high' && review.standardSnapshot && <p className="disposition-note">{t("本次标准建议：")}{review.standardSnapshot.content.workflow.highRiskHandling === 'escalate' ? t("升级处理") : t("人工复核")}{t("；请人工决定，未自动改变状态。")}</p>}
      <label className="field"><span>{t("处置状态")}</span><select aria-label={t("处置状态")} value={status} disabled={Boolean(busy)} onChange={event => setStatus(event.target.value as RiskDispositionStatus)}>{Object.entries(dispositionLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
      <label className="field"><span>{t("处置理由或说明（每次必填）")}</span><textarea aria-label={t("处置理由或说明")} rows={4} value={reason} disabled={Boolean(busy)} maxLength={2000} onChange={event => setReason(event.target.value)} placeholder={t("说明判断依据、待补资料、升级对象或业务接受风险的背景。")} /></label><label className="field"><span>{t("记录人标签")}</span><input aria-label={t("风险记录人标签")} value={actorLabel} disabled={Boolean(busy)} maxLength={80} onChange={event => setActorLabel(event.target.value)} /><small>{t("仅作为记录标签，不是账号认证。")}</small></label>
      {status === 'business_accepted' && <p className="disposition-note">{t("业务接受仅记录业务决策，不等于法律合规确认，也不会降低原风险等级。")}</p>}
      <div className="disposition-actions"><button className="button primary small" disabled={!workspace || Boolean(busy) || invalid} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{t("提交处置记录")}</button>{dirty && <button className="text-button" disabled={Boolean(busy)} onClick={() => { setReason(''); setStatus(current?.status ?? 'unreviewed'); setNotice(null); }}><Undo2 size={13} />{t("撤销未提交说明")}</button>}</div>
      <details className="disposition-history"><summary>{t("这项风险的处置历史")}<span>{workspace?.events.filter(event => event.findingId === findingId).length ?? 0}{t("条")}</span></summary>{workspace?.events.filter(event => event.findingId === findingId).map(event => <article key={event.id}><strong>{t(dispositionLabels[event.status])}</strong><span>{event.actorLabel} · {new Date(event.createdAt).toLocaleString(dateLocale)}</span><p>{event.reason}</p></article>)}</details>
    </> : <p>{t("本次审核没有可处置的风险事项。")}</p>}</div></div>
  </div></details>;
}
