import { useI18n } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Plus, RefreshCw, Save, X } from 'lucide-react';
import type { ContractAssistantBridge, ContractDetail, ReviewResult } from '../../shared/contracts';
import type { EnterpriseStandardSnapshot } from '../../shared/assurance';
import { workflowNodeLabels, type ReviewCompletionWorkspace, type ReviewInformationItem, type SourceVerificationBody } from '../../shared/review-completion';
import ReviewFreshnessNotice from './ReviewFreshnessNotice';
import { SourceEvidenceCard } from './RetrievalSources';
import './review-completion.css';

const informationLabels = { fact: '关键事实', assumption: '审核假设', question: '待确认问题' };
const statusLabels = { pending: '待确认', confirmed: '已人工确认', not_applicable: '人工标记不适用' };
const verificationLabels = { not_verified: '未核实', pending: '待核实', verified: '已人工核实（限记录范围）' };
const runLabels = { paused_information: '补资料暂停', ready: '已准备，可开始审核', awaiting_human: '等待风险人工处置', completed: '有限流程完成' };
const emptyVerification = () => ({ status: 'not_verified' as SourceVerificationBody['status'], authenticity: '', legalEffect: '', applicableFrom: null as string | null, applicableTo: null as string | null, applicableScope: '', conflictReason: '', reason: '' });
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function ReviewCompletionPanel({ bridge, document, review, standard, onClose, onChanged }: {
  bridge: ContractAssistantBridge; document: ContractDetail; review?: ReviewResult | null; standard?: EnterpriseStandardSnapshot | null;
  onClose?: () => void; onChanged?: () => void;
}) {
  const { t, translateMessage, dateLocale } = useI18n();

  const [workspace, setWorkspace] = useState<ReviewCompletionWorkspace | null>(null);
  const [items, setItems] = useState<ReviewInformationItem[]>([]);
  const [actorLabel, setActorLabel] = useState('法务'); const [reason, setReason] = useState('');
  const [sourceId, setSourceId] = useState(''); const [verification, setVerification] = useState(emptyVerification);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  const [discardWarning, setDiscardWarning] = useState(false);
  const alive = useRef(true); const generation = useRef(0);
  const evidence = review?.retrieval?.evidence ?? [];
  const selectedSource = evidence.find(item => item.id === sourceId);
  const currentVerification = workspace?.sourceVerifications.find(item => item.evidenceId === sourceId);
  const dirtyFacts = JSON.stringify(items) !== JSON.stringify(workspace?.facts?.body.items ?? []);
  const dirtySource = JSON.stringify(verification) !== JSON.stringify(currentVerification ? Object.fromEntries(Object.keys(emptyVerification()).map(key => [key, currentVerification.current.body[key as keyof SourceVerificationBody]])) : emptyVerification());
  const load = async (ticket = generation.current) => {
    const value = await bridge.runWorkspaceCommand({ action: 'reviewCompletion.get', payload: { documentId: document.id, ...(review ? { reviewId: review.id } : {}), ...(standard ? { standardVersionId: standard.id } : {}) } }) as ReviewCompletionWorkspace;
    if (alive.current && ticket === generation.current) { setWorkspace(value); setItems(structuredClone(value.facts?.body.items ?? [])); }
  };
  useEffect(() => {
    alive.current = true; const ticket = ++generation.current;
    setWorkspace(null); setItems([]); setReason(''); setSourceId(''); setVerification(emptyVerification()); setError(''); setNotice(''); setBusy(true);
    void load(ticket).catch(error => { if (alive.current && ticket === generation.current) setError(messageOf(error)); }).finally(() => { if (alive.current && ticket === generation.current) setBusy(false); });
    return () => { alive.current = false; };
  }, [bridge, document.id, review?.id, standard?.id]);
  useEffect(() => { const body = currentVerification?.current.body; setVerification(body ? { status: body.status, authenticity: body.authenticity, legalEffect: body.legalEffect, applicableFrom: body.applicableFrom, applicableTo: body.applicableTo, applicableScope: body.applicableScope, conflictReason: body.conflictReason, reason: body.reason } : emptyVerification()); }, [sourceId, currentVerification?.current.revision]);
  const run = async (operation: () => Promise<unknown>, success: string) => {
    if (busy) return; const ticket = generation.current; setBusy(true); setError(''); setNotice('');
    try { await operation(); if (!alive.current || ticket !== generation.current) return; await load(ticket); if (alive.current && ticket === generation.current) { setNotice(success); setDiscardWarning(false); onChanged?.(); } }
    catch (error) { if (alive.current && ticket === generation.current) setError(messageOf(error)); }
    finally { if (alive.current && ticket === generation.current) setBusy(false); }
  };
  const update = (index: number, patch: Partial<ReviewInformationItem>) => setItems(previous => previous.map((item, position) => position === index ? { ...item, ...patch } : item));
  const close = () => { if ((dirtyFacts || dirtySource) && !discardWarning) { setDiscardWarning(true); setNotice(t("有未保存的资料或核验输入；先保存，或再次关闭以放弃本次输入。")); return; } onClose?.(); };
  return <section className="review-completion-panel card" aria-label={t("审核资料与流程")}><header><div><h2>{t("审核资料、流程与来源核验")}</h2><p>{document.name} · v{document.versionNo ?? 1}{t("。人工记录保存在本地，并保留修订历史。")}</p></div>{onClose && <button className="text-button" disabled={busy} onClick={close}><X size={16} />{t("关闭")}</button>}</header>
    <p>{t("将业务事实、假设和待确认问题分开。确认假设表示接受它作为本轮分析前提，仍然不会把假设变成已证明的事实。")}</p>
    {error && <p className="notice error" role="alert">{translateMessage(error)}</p>}{notice && <p className="notice info" role="status">{translateMessage(notice)}</p>}
    {workspace?.freshness && <ReviewFreshnessNotice value={workspace.freshness} />}
    <label className="field"><span>{t("人工记录标签")}</span><input aria-label={t("审核补全记录人")} value={actorLabel} maxLength={80} onChange={event => setActorLabel(event.target.value)} disabled={busy} /><small>{t("本机留档标签，不代表已认证身份。")}</small></label>
    <fieldset disabled={busy || !workspace}><legend>{t("结构化审核资料")}</legend>
      <div className="completion-actions">{Object.entries(informationLabels).map(([kind, label]) => <button key={kind} className="button secondary small" onClick={() => setItems(previous => [...previous, { id: crypto.randomUUID(), kind: kind as ReviewInformationItem['kind'], label: '', detail: '', status: 'pending', required: false, scopes: [], blockIds: [], quote: '', reason: '' }])} disabled={items.length >= 200}><Plus size={14} />{t("增加")}{t(label)}</button>)}</div>
      {items.map((item, index) => <article className="completion-item" key={item.id}><div className="completion-row"><strong>{t(informationLabels[item.kind])} {index + 1}</strong><button className="text-button" onClick={() => setItems(previous => previous.filter(value => value.id !== item.id))}>{t("移除此条（保存后留历史）")}</button></div>
        <label className="field"><span>{t("事项")}</span><input aria-label={t("资料{v0}事项", { v0: index + 1 })} maxLength={160} value={item.label} onChange={event => update(index, { label: event.target.value })} /></label>
        <label className="field"><span>{t("事实内容、分析前提或待补问题")}</span><textarea maxLength={4000} value={item.detail} onChange={event => update(index, { detail: event.target.value })} /></label>
        <div className="completion-grid"><label className="field"><span>{t("确认状态")}</span><select value={item.status} aria-label={t("资料{v0}状态", { v0: index + 1 })} onChange={event => update(index, { status: event.target.value as ReviewInformationItem['status'] })}>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select></label><label><input type="checkbox" checked={item.required} onChange={event => update(index, { required: event.target.checked })} />{t("本轮必需资料")}</label></div>
        <label className="field"><span>{t("影响的审核范围（每行一项，如付款条件、主体资格）")}</span><textarea maxLength={1450} value={item.scopes.join('\n')} onChange={event => update(index, { scopes: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) })} /></label>
        <label className="field"><span>{t("关联原文段落（可选）")}</span><select value={item.blockIds[0] ?? ''} aria-label={t("资料{v0}关联段落", { v0: index + 1 })} onChange={event => update(index, { blockIds: event.target.value ? [event.target.value] : [], quote: '' })}><option value="">{t("业务资料／未关联段落")}</option>{document.blocks.map(block => <option key={block.id} value={block.id}>#{block.ordinal + 1} {block.text.slice(0, 100)}</option>)}</select></label>
        <label className="field"><span>{t("原文直接引文（选填，保存时精确核对）")}</span><textarea value={item.quote} maxLength={2000} onChange={event => update(index, { quote: event.target.value })} /></label>
        <label className="field"><span>{t("确认／不适用理由及补充材料说明")}</span><textarea value={item.reason} maxLength={2000} onChange={event => update(index, { reason: event.target.value })} /></label>
      </article>)}
      {!items.length && <p>{t("尚未登记资料。没有登记不等于资料齐全。")}</p>}
      <label className="field"><span>{t("本次资料修改说明")}</span><input aria-label={t("资料修改说明")} value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} /></label>
      <button className="button primary" disabled={!dirtyFacts || !reason.trim()} onClick={() => void run(() => bridge.runWorkspaceCommand({ action: 'reviewCompletion.facts.save', payload: { documentId: document.id, expectedRevision: workspace?.facts?.revision ?? 0, actorLabel, items, reason } }), '资料已保存。历史审核的事实快照保持原样；新审核采用新资料。')}><Save size={14} />{t("保存资料修订")}</button>
      {workspace?.factsHistory.length ? <details><summary>{t("资料历史 ·")}{workspace.factsHistory.length}{t("版")}</summary>{workspace.factsHistory.map(asset => <div key={asset.revision}><p>r{asset.revision} · {asset.updatedAt} · {asset.actorLabel} · {asset.body.reason}</p>{asset.body.items.map(item => <p key={item.id}>{t(informationLabels[item.kind])} · {item.label} · {t(statusLabels[item.status])} · {item.detail} · {item.reason}</p>)}</div>)}</details> : null}
    </fieldset>
    <section><h3>{t("本轮有限流程")}</h3><ol>{workspace?.workflow.nodes.map(node => <li key={node.id}>{t(workflowNodeLabels[node.kind])} · {node.when === 'always' ? t("始终执行") : node.when === 'has_high_risk' ? t("高风险分支") : t("待确认资料分支")}{node.kind === 'collect_information' ? node.onMissing === 'continue_limited' ? t(" · 缺必需资料时保留局限继续") : t(" · 缺必需资料时暂停") : ''}</li>)}</ol>
      <p>{t("企业标准面板可发布新的流程版本。此处准备检查点，不调用模型；资料暂停后先保存补充信息，再准备新检查点并开始审核。")}</p>
      <button className="button secondary" disabled={busy || dirtyFacts || !workspace} onClick={() => void run(() => bridge.runWorkspaceCommand({ action: 'reviewCompletion.workflow.prepare', payload: { documentId: document.id, ...(standard ? { standardVersionId: standard.id } : {}), actorLabel } }), '已重新核对并保存流程检查点。请查看状态，再开始审核。')}><RefreshCw size={14} />{t("检查资料／准备继续")}</button>
      {review?.completionSnapshot && <button className="button secondary" disabled={busy || dirtyFacts} onClick={() => void run(() => bridge.runWorkspaceCommand({ action: 'reviewCompletion.workflow.refresh', payload: { reviewId: review.id, actorLabel } }), '已按保存的风险人工处置刷新流程状态。')}><RefreshCw size={14} />{t("刷新人工处置节点")}</button>}
      <details open><summary>{t("运行记录 ·")}{workspace?.runs.length ?? 0}{t("轮")}</summary>{workspace?.runs.map(asset => <div className="completion-item" key={asset.id}><strong>{t(runLabels[asset.body.state])}</strong><p>{asset.updatedAt}{t("· 资料 r")}{asset.body.snapshot.facts?.revision ?? 0} · {asset.body.reason}</p>{asset.body.nodes.map(node => <p key={node.id}>{t(workflowNodeLabels[node.kind])} · {t(({pending:"未开始",running:"执行中",completed:"已完成",skipped:"已跳过",paused:"已暂停",waiting_human:"待人工确认",failed:"失败"} as Record<string,string>)[node.state]??node.state)} · {translateMessage(node.reason)}</p>)}</div>)}</details>
    </section>
    <fieldset disabled={busy || !review || dirtyFacts}><legend>{t("来源人工核验与采信理由")}</legend><p>{t("核验记录只适用于当前报告保存的来源版本和片段。来源文字匹配、官方标记和模型输出均不会自动完成此处核验；法律效力、适用时点与冲突采信由记录人说明。")}</p>
      <label className="field"><span>{t("选择审核来源")}</span><select aria-label={t("人工核验来源")} value={sourceId} onChange={event => { if (dirtySource) { setNotice(t("请先保存当前来源核验输入，再选择其他来源。")); return; } setSourceId(event.target.value); }}><option value="">{t("选择一个冻结来源")}</option>{evidence.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}</select></label>
      {selectedSource && <><SourceEvidenceCard evidence={selectedSource} compact />
        <label className="field"><span>{t("人工核验状态")}</span><select aria-label={t("来源人工核验状态")} value={verification.status} onChange={event => setVerification(previous => ({ ...previous, status: event.target.value as SourceVerificationBody['status'] }))}>{Object.entries(verificationLabels).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select></label>
        {([['authenticity', t("真实性核验说明")], ['legalEffect', t("效力判断及核对依据")], ['applicableScope', t("适用事项／主体／地域范围")], ['conflictReason', t("与其他材料冲突及采信理由")], ['reason', t("本次核验／变更理由")]] as const).map(([key, label]) => <label className="field" key={key}><span>{t(label)}</span><textarea aria-label={label} maxLength={2000} value={verification[key]} onChange={event => setVerification(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}
        <div className="completion-grid"><label className="field"><span>{t("人工认定适用开始日（可未知）")}</span><input type="date" value={verification.applicableFrom ?? ''} onChange={event => setVerification(previous => ({ ...previous, applicableFrom: event.target.value || null }))} /></label><label className="field"><span>{t("人工认定适用结束日（可未知）")}</span><input type="date" value={verification.applicableTo ?? ''} onChange={event => setVerification(previous => ({ ...previous, applicableTo: event.target.value || null }))} /></label></div>
        <button className="button primary" disabled={!verification.reason.trim() || !dirtySource} onClick={() => void run(() => bridge.runWorkspaceCommand({ action: 'reviewCompletion.source.save', payload: { reviewId: review!.id, evidenceId: selectedSource.id, expectedRevision: currentVerification?.current.revision ?? 0, actorLabel, ...verification } }), '来源人工核验已留档；原始来源和模型意见保持冻结。')}><Save size={14} />{t("保存来源核验")}</button>
        {currentVerification && <details><summary>{t("核验历史 ·")}{currentVerification.history.length}{t("版")}</summary>{currentVerification.history.map(asset => <div className="completion-item" key={asset.revision}><strong>r{asset.revision} · {t(verificationLabels[asset.body.status])}</strong><p>{asset.actorLabel} · {asset.updatedAt} · {asset.body.reason}</p><p>{t("真实性：")}{asset.body.authenticity || t("未说明")}{t("；效力：")}{asset.body.legalEffect || t("未说明")}{t("；适用范围：")}{asset.body.applicableScope || t("未说明")}{t("；时点：")}{asset.body.applicableFrom ?? t("未知")}{t("至")}{asset.body.applicableTo ?? t("未知")}{t("；冲突及采信：")}{asset.body.conflictReason || t("未说明")}</p></div>)}</details>}
      </>}{!evidence.length && <p>{t("当前没有已保存的检索来源，先完成带来源的审核后再登记。")}</p>}
    </fieldset>
    {busy && <p role="status"><LoaderCircle size={15} className="spin" />{t("正在读写本地记录")}</p>}
  </section>;
}
