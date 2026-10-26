import { useI18n } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Check, ChevronDown, CircleAlert, FilePenLine, Info, LoaderCircle, Pencil, RefreshCw, Sparkles, Square, Undo2, X } from 'lucide-react';
import type { ContractAssistantBridge, ContractDetail, ReviewResult } from '../../shared/contracts';
import type { ChangeDecision, ChangeProposal, ChangeTarget, ChangeWorkspace, ExportChangesResult } from '../../shared/changes';
import './changes.css';

type Notice = { kind: 'success' | 'error' | 'info'; text: string };
const decisionLabels: Record<ChangeDecision, string> = { proposed: '待确认', accepted: '已采纳', rejected: '已拒绝' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const dateLabel = (value: string, locale: string) => new Date(value).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const proposalSegment = (target: ChangeTarget | undefined, proposal: ChangeProposal) => target?.segments?.find(segment => segment.rangeStart === proposal.rangeStart && segment.rangeEnd === proposal.rangeEnd && segment.text === proposal.originalText);
const proposalEditable = (target: ChangeTarget | undefined, proposal: ChangeProposal) => Boolean(target?.editable && (target.editMode !== 'segments' || proposalSegment(target, proposal)?.editable));

export default function ChangesPanel({ bridge, document, review, isPreview, selectedFindingId, requestSequence, onExport }: {
  bridge: ContractAssistantBridge;
  document: ContractDetail;
  review: ReviewResult;
  isPreview: boolean;
  selectedFindingId: string | null;
  requestSequence: number;
  onExport: () => Promise<void>;
}) {
  const { t, translateMessage, dateLocale } = useI18n();

  const [workspace, setWorkspace] = useState<ChangeWorkspace | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [findingId, setFindingId] = useState('');
  const [blockId, setBlockId] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [replacement, setReplacement] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [lastExport, setLastExport] = useState<ExportChangesResult | null>(null);
  const [exportFormat, setExportFormat] = useState<'clean' | 'tracked'>('tracked');
  const [revisionAuthor, setRevisionAuthor] = useState('合同工作台');
  const alive = useRef(true);
  const generating = useRef(false);
  const cancelRequested = useRef(false);
  const lastSelectedFinding = useRef<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (generating.current) void bridge.cancelChangeDraft(review.id).catch(() => {});
    };
  }, [bridge, review.id]);

  useEffect(() => {
    if (!expanded || workspace) return;
    let current = true;
    setBusy('load'); setNotice(null);
    bridge.getChanges(review.id).then(value => { if (current && alive.current) setWorkspace(value); })
      .catch(error => { if (current && alive.current) setNotice({ kind: 'error', text: messageOf(error) }); })
      .finally(() => { if (current && alive.current) setBusy(null); });
    return () => { current = false; };
  }, [bridge, review.id, expanded]);

  useEffect(() => {
    const panel = panelRef.current;
    const setup = panel?.closest('.workspace-content')?.querySelector<HTMLElement>('.review-setup');
    if (!panel || !setup) return;
    const measure = () => panel.style.setProperty('--changes-scroll-offset', `${getComputedStyle(setup).position === 'sticky' ? setup.getBoundingClientRect().height + 12 : 16}px`);
    const observer = new ResizeObserver(measure); observer.observe(setup); measure();
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  const finding = review.findings.find(item => item.id === findingId);
  const target = workspace?.targets.find(item => item.blockId === blockId);
  const segmented = target?.editMode === 'segments';
  const segment = segmented ? target.segments?.find(item => item.id === segmentId) : undefined;
  const originalText = segmented ? segment?.text ?? '' : target?.text ?? '';
  const selectionEditable = Boolean(target?.editable && (!segmented || segment?.editable));
  const editing = workspace?.proposals.find(item => item.id === proposalId);
  const accepted = workspace?.proposals.filter(item => item.status === 'accepted') ?? [];
  const dirty = Boolean(target && (!segmented || segment) && replacement !== (editing?.replacementText ?? originalText));
  const invalidNewline = /[\u0000-\u001f\u007f]/u.test(replacement);
  const invalidAuthor = exportFormat === 'tracked' && (!revisionAuthor.trim() || revisionAuthor.trim().length > 80 || /[\u0000-\u001f\u007f]/u.test(revisionAuthor));
  const candidates = workspace?.targets.filter(item => !finding?.blockIds.length || finding.blockIds.includes(item.blockId)) ?? [];
  const availableTargets = finding?.blockIds.length && candidates.length ? candidates : workspace?.targets ?? [];

  const selectFinding = (id: string, value = workspace) => {
    setFindingId(id); setProposalId(null); setNotice(null);
    const selected = review.findings.find(item => item.id === id);
    const mapped = value?.targets.filter(item => selected?.blockIds.includes(item.blockId)) ?? [];
    const only = mapped.length === 1 ? mapped[0] : null;
    setBlockId(only?.blockId ?? ''); setSegmentId(''); setReplacement(only?.editMode === 'segments' ? '' : only?.text ?? '');
  };

  useEffect(() => {
    const key = `${selectedFindingId}:${requestSequence}`;
    if (!selectedFindingId || key === lastSelectedFinding.current) return;
    if (!review.findings.some(item => item.id === selectedFindingId)) return;
    setExpanded(true);
    if (!workspace) return;
    lastSelectedFinding.current = key;
    if (busy || dirty) {
      setNotice({ kind: 'info', text: busy ? '当前操作正在进行，原文段落和草稿已保留。请先完成或取消，再选择其他审核意见。' : '当前有未保存编辑，原文段落和草稿已保留。请先保存或撤销编辑，再选择其他审核意见。' });
      return;
    }
    selectFinding(selectedFindingId, workspace);
    requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [selectedFindingId, requestSequence, workspace, review.id, busy, dirty]);

  const reload = async () => {
    setBusy('load'); setNotice(null);
    try { const value = await bridge.getChanges(review.id); if (alive.current) setWorkspace(value); }
    catch (error) { if (alive.current) setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { if (alive.current) setBusy(null); }
  };
  const enableEditableCopy = async () => {
    if (!workspace?.editableCopy?.available || workspace.editableCopy.enabled || busy || dirty || isPreview) return;
    setBusy('editable-copy'); setNotice(null);
    try {
      const result = await bridge.enableEditableCopy({ reviewId: review.id, expectedRevision: workspace.revision });
      if (!alive.current) return;
      setWorkspace(result);
      setNotice({ kind: 'success', text: t("已启用可编辑副本。请核对修改前后文字再逐项采纳；导出时会记录副本模式，原件和历史审核保留。") });
    } catch (error) { if (alive.current) setNotice({ kind: 'error', text: t("{v0} 如记录已更新，请刷新修改记录后重试。", { v0: messageOf(error) }) }); }
    finally { if (alive.current) setBusy(null); }
  };
  const selectTarget = (id: string) => {
    const selected = workspace?.targets.find(item => item.blockId === id);
    setBlockId(id); setSegmentId(''); setProposalId(null); setReplacement(selected?.editMode === 'segments' ? '' : selected?.text ?? ''); setNotice(null);
  };
  const selectSegment = (id: string) => {
    const selected = target?.segments?.find(item => item.id === id);
    if (id && !selected?.editable) { setNotice({ kind: 'error', text: selected?.reason ?? '请选择可编辑文字片段，保留结构不能修改。' }); return; }
    setSegmentId(id); setProposalId(null); setReplacement(selected?.text ?? ''); setNotice(null);
  };
  const editProposal = (proposal: ChangeProposal) => {
    const selected = workspace?.targets.find(item => item.blockId === proposal.blockId);
    setProposalId(proposal.id); setFindingId(proposal.findingId ?? ''); setBlockId(proposal.blockId);
    setSegmentId(selected?.editMode === 'segments' ? proposalSegment(selected, proposal)?.id ?? '' : '');
    setReplacement(proposal.replacementText); setNotice(null);
    if (!proposalEditable(selected, proposal)) setNotice({ kind: 'error', text: t("这项草稿的原文范围当前不可编辑，请核对修改记录和原文定位。") });
    editorRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const save = async () => {
    if (!workspace || !selectionEditable || !dirty || busy) return;
    if (invalidNewline) { setNotice({ kind: 'error', text: t("本轮只修改单段纯文字，请移除新换行、制表符或控制字符。") }); return; }
    setBusy('save'); setNotice(null);
    try {
      const result = await bridge.saveChange({ reviewId: review.id, ...(proposalId ? { proposalId } : {}), findingId: findingId || null, blockId, ...(segmented ? { segmentId } : {}), expectedRevision: workspace.revision, replacementText: replacement });
      if (!alive.current) return;
      setWorkspace(result);
      const saved = result.proposals.find(item => item.id === proposalId) ?? result.proposals.find(item => !workspace.proposals.some(old => old.id === item.id));
      if (saved) editProposal(saved);
      setNotice({ kind: 'success', text: t("修改草稿已保存，当前为待确认。请核对修改前后文字，再逐项采纳。") });
    } catch (error) { if (alive.current) setNotice({ kind: 'error', text: t("{v0} 如记录已更新，可点击“刷新修改记录”后重试。", { v0: messageOf(error) }) }); }
    finally { if (alive.current) setBusy(null); }
  };
  const generate = async () => {
    if (!workspace || !selectionEditable || !finding || busy || dirty || isPreview) return;
    generating.current = true; cancelRequested.current = false;
    setBusy('generate'); setCancelling(false); setNotice(null);
    try {
      const result = await bridge.generateChangeDraft({ reviewId: review.id, findingId, blockId, ...(segmented ? { segmentId } : {}), expectedRevision: workspace.revision });
      if (!alive.current) return;
      setWorkspace(result);
      const saved = result.proposals.find(item => !workspace.proposals.some(old => old.id === item.id));
      if (saved) editProposal(saved);
      setNotice(cancelRequested.current ? { kind: 'info', text: t("本次改写请求已结束，已保存内容仍需逐项确认。") } : { kind: 'success', text: t("具体改写已生成，尚未采纳。请核对业务事实和原文含义，必要时编辑后保存。") });
    } catch (error) { if (alive.current) setNotice(cancelRequested.current ? { kind: 'info', text: t("本次改写已取消，原件和已保存的修改记录保留。") } : { kind: 'error', text: messageOf(error) }); }
    finally { generating.current = false; cancelRequested.current = false; if (alive.current) { setBusy(null); setCancelling(false); } }
  };
  const cancel = async () => {
    if (!generating.current || cancelling) return;
    cancelRequested.current = true; setCancelling(true);
    try { await bridge.cancelChangeDraft(review.id); }
    catch (error) { if (alive.current) { setCancelling(false); cancelRequested.current = false; setNotice({ kind: 'error', text: messageOf(error) }); } }
  };
  const decide = async (proposal: ChangeProposal, status: ChangeDecision) => {
    if (!workspace || busy || (proposal.id === proposalId && dirty)) return;
    setBusy(`decision:${proposal.id}`); setNotice(null);
    try {
      const result = await bridge.decideChange({ reviewId: review.id, proposalId: proposal.id, status, expectedRevision: workspace.revision });
      if (alive.current) { setWorkspace(result); setNotice({ kind: 'success', text: status === 'accepted' ? '已采纳这项修改，导出修改稿时会使用它。' : status === 'rejected' ? '已拒绝这项修改，导出时不采用。' : '已恢复为待确认，导出时暂不采用。' }); }
    } catch (error) { if (alive.current) setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { if (alive.current) setBusy(null); }
  };
  const exportModified = async () => {
    if (!workspace || !accepted.length || dirty || busy || invalidAuthor || isPreview) return;
    setBusy('export'); setNotice(null);
    try {
      const result = await bridge.exportModified({ reviewId: review.id, expectedRevision: workspace.revision, format: exportFormat, ...(exportFormat === 'tracked' ? { revisionAuthor: revisionAuthor.trim() } : {}) });
      if (!alive.current || !result) return;
      setLastExport(result); setWorkspace(await bridge.getChanges(review.id)); await onExport();
      if (alive.current) setNotice({ kind: 'success', text: t("修改稿 v{v0} 和变更清单已导出。原件及原审核保留，修改稿可在合同列表中重新审核。", { v0: result.export.versionNo }) });
    } catch (error) { if (alive.current) setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { if (alive.current) setBusy(null); }
  };
  const canEdit = workspace?.supported && selectionEditable && !busy;
  return <details ref={panelRef} className="card changes-panel" id={`changes-${review.id}`} open={expanded} onToggle={event => {
    const open = event.currentTarget.open; setExpanded(open);
    // Saved drafts remain in SQLite. Retain only genuinely unsaved edits or an
    // active generation when collapsing; the complete XML target map is lazy.
    if (!open && !dirty && !generating.current && (!busy || busy === 'load')) {
      setWorkspace(null); setBusy(null); setBlockId(''); setSegmentId(''); setProposalId(null); setReplacement('');
    }
  }}>
    <summary className="pane-heading"><div className="section-heading-left"><FilePenLine size={17} /><h2>{t("合同修改")}</h2>{workspace && <span className="count-badge">{accepted.length}{t("项已采纳")}</span>}</div><span className="changes-heading-note">{t("预览后逐项确认")}</span><ChevronDown size={14} /></summary>
    <div className="changes-body">
      <p className="changes-intro">{t("修改基于本次审核的原文版本。先核对修改前后文字，再采纳需要的条款；修改稿单独保存，原件和原审核记录保留。")}</p>
      {isPreview && <p className="changes-scope-note"><Info size={14} />{t("当前为界面预览：只能体验内存中的手动草稿与采纳，不调用模型，也不导出真实修改稿。")}</p>}
      {busy === 'load' && <p className="changes-loading" role="status"><LoaderCircle size={15} className="spin" />{t("正在读取修改范围与记录…")}</p>}
      {notice && <div className={`notice changes-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'error' ? <CircleAlert size={15} /> : notice.kind === 'success' ? <Check size={15} /> : <Info size={15} />}<span>{translateMessage(notice.text)}</span></div>}
      {!workspace && busy !== 'load' && <button className="button secondary small" onClick={() => void reload()}><RefreshCw size={14} />{t("重新读取修改记录")}</button>}
      {workspace && <>
        {!workspace.supported && <p className="changes-scope-note"><Info size={14} />{workspace.reason ?? t("本文件暂不支持定点修改。")}</p>}
        {workspace.editableCopy && (workspace.editableCopy.available || workspace.editableCopy.enabled || workspace.editableCopy.reason) && <section className={`changes-editable-copy ${workspace.editableCopy.enabled ? 'enabled' : ''}`} aria-label={t("可编辑副本模式")}>
          <div className="changes-editable-copy-heading"><FilePenLine size={16} /><h3>{workspace.editableCopy.enabled ? t("已启用可编辑副本") : t("原件包含编辑限制")}</h3></div>
          {workspace.editableCopy.reason && <p>{workspace.editableCopy.reason}</p>}
          {workspace.editableCopy.enabled ? <>
            <p>{t("当前使用可编辑工作副本拟定修改。仅导出的新副本会移除 Word 的只读限制，并在修改清单中记录；原件与历史审核保留，复杂段落仍按安全范围处理。")}</p>
            {workspace.editableCopy.enabledAt && <span className="changes-editable-copy-time">{t("启用于")}{dateLabel(workspace.editableCopy.enabledAt, dateLocale)}</span>}
          </> : workspace.editableCopy.available ? <>
            <p>{t("启用后可基于工作副本拟定修改；带密码校验的 Word 只读限制仅在导出的新副本中移除，不破解或恢复密码。原件与历史审核保留。")}</p>
            <button className="button primary small" disabled={Boolean(busy) || dirty || isPreview} onClick={() => void enableEditableCopy()}>{busy === 'editable-copy' ? <LoaderCircle size={14} className="spin" /> : <FilePenLine size={14} />}{busy === 'editable-copy' ? t("正在启用副本…") : t("启用可编辑副本")}</button>
            {isPreview && <p className="field-help">{t("界面预览不执行真实副本操作。")}</p>}
          </> : null}
        </section>}
        {workspace.warnings.length > 0 && <ul className="changes-warning-list">{workspace.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        {workspace.supported && <div className="change-editor" ref={editorRef}>
          <div className="changes-subheading"><h3>{editing ? t("编辑修改草稿") : t("拟定一项修改")}</h3><button className="text-button" disabled={!!busy || dirty} onClick={() => selectFinding(findingId)}><Pencil size={12} />{t("新建修改")}</button></div>
          <div className="change-selection-grid">
            <label className="field"><span>{t("关联审核意见")}</span><select aria-label={t("关联审核意见")} value={findingId} disabled={!!busy || dirty || Boolean(editing)} onChange={event => selectFinding(event.target.value)}><option value="">{t("手动拟定修改（不关联意见）")}</option>{review.findings.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.title}</option>)}</select></label>
            <label className="field"><span>{t("修改原文段落")}</span><select aria-label={t("修改原文段落")} value={blockId} disabled={!!busy || dirty || Boolean(editing)} onChange={event => selectTarget(event.target.value)}><option value="">{t("请选择要修改的段落")}</option>{availableTargets.map(item => <option key={item.blockId} value={item.blockId}>{item.label}{item.editable ? '' : t("（暂不支持修改）")}</option>)}</select></label>
          </div>
          {finding && <p className="change-finding-note"><strong>{finding.title}</strong><span>{finding.suggestion}</span>{finding.blockIds.length !== 1 && <small>{t("此意见没有唯一段落定位，请自行选择对应原文。缺失条款需人工确定放置位置，本轮不自动新增段落。")}</small>}</p>}
          {target && !target.editable && <p className="changes-scope-note"><CircleAlert size={14} />{target.reason ?? t("此段包含暂不支持的复杂结构，请在 Word 中人工处理。")}</p>}
          {target && segmented && <div className="change-segment-context">
            <div className="change-text-label">{t("完整段落上下文 · 只读")}</div><p className="change-original" data-testid="change-paragraph-context">{target.text}</p>
            <p className="change-segment-note">{t("此段按文字片段修改。书签、权限边界、原有修订和换行分页等结构保留；只能改写所选的可编辑文字片段。")}</p>
            <label className="field"><span>{t("修改文字片段")}</span><select aria-label={t("修改文字片段")} value={segmentId} disabled={!!busy || dirty || Boolean(editing) || !target.editable} onChange={event => selectSegment(event.target.value)}><option value="">{t("请选择可编辑文字片段")}</option>{target.segments?.map((item, index) => <option key={item.id} value={item.id} disabled={!item.editable}>{item.editable ? t("文字片段 {v0} · 第 {v1}–{v2} 位 · {v3}", { v0: index + 1, v1: item.rangeStart + 1, v2: item.rangeEnd, v3: item.text.slice(0, 35) }) : t("保留结构 {v0} · {v1}", { v0: index + 1, v1: item.reason ?? '不可编辑' })}</option>)}</select></label>
          </div>}
          {target?.warnings && target.warnings.length > 0 && <ul className="changes-warning-list">{target.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          {target && (!segmented || segment) && <div className="change-comparison editor-comparison">
            <div><div className="change-text-label">{t("修改前 ·")}{segmented ? t("所选片段只读") : t("原文只读")}</div><p className="change-original" data-testid="change-editor-original">{originalText}</p></div>
            <label className="field"><span>{t("修改后 ·")}{segmented ? t("片段草稿") : t("可编辑草稿")}</span><textarea aria-label={t("修改后文字")} value={replacement} onChange={event => { setReplacement(event.target.value); setNotice(null); }} disabled={!canEdit} rows={6} maxLength={30000} spellCheck={false} /><span className="field-help">{segmented ? t("仅修改所选片段的文字，其余文字和结构保留。") : t("单段纯文字，段落结构保留。")}{t("不新增段落、换行或制表符，最多 30,000 字。清空可删除")}{segmented ? t("该片段") : t("该段")}{t("文字。")}</span></label>
          </div>}
          {invalidNewline && target?.editable && <p className="changes-inline-warning">{t("草稿含换行、制表符或控制字符，请移除后保存。")}</p>}
          {dirty && <p className="changes-inline-warning">{editing?.status === 'accepted' ? t("保存编辑后，这项修改会恢复为待确认，需要重新采纳。") : t("有未保存编辑，请先保存或撤销编辑，再切换段落或生成新的改写。")}</p>}
          <div className="change-editor-actions"><button className="button secondary small" disabled={!canEdit || !finding || dirty || isPreview} onClick={() => void generate()}>{busy === 'generate' ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}{busy === 'generate' ? t("正在生成改写…") : t("生成具体改写")}</button>{busy === 'generate' && <button className="button secondary small" disabled={cancelling} onClick={() => void cancel()}><Square size={11} />{cancelling ? t("正在取消…") : t("取消本次改写")}</button>}<button className="button primary small" disabled={!canEdit || !dirty || invalidNewline || replacement === originalText} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{t("保存修改草稿")}</button>{dirty && <button className="text-button" disabled={!!busy} onClick={() => setReplacement(editing?.replacementText ?? originalText)}><Undo2 size={12} />{t("撤销未保存编辑")}</button>}</div>
          {!finding && <p className="field-help">{t("可直接手动修改；选择审核意见后，可调用已配置模型生成具体改写。")}</p>}
        </div>}
        <div className="changes-list-heading"><h3>{t("修改前后预览")}<span>{workspace.proposals.length}{t("项草稿")}</span></h3><button className="text-button" disabled={!!busy} onClick={() => void reload()}><RefreshCw size={12} />{t("刷新修改记录")}</button></div>
        {workspace.proposals.length ? <div className="change-proposals">{workspace.proposals.map((proposal, index) => <ProposalCard key={proposal.id} proposal={proposal} index={index} target={workspace.targets.find(item => item.blockId === proposal.blockId)} disabled={Boolean(busy) || dirty} busy={busy === `decision:${proposal.id}`} dirty={proposal.id === proposalId && dirty} onEdit={() => editProposal(proposal)} onDecide={status => void decide(proposal, status)} />)}</div> : <div className="changes-empty"><FilePenLine size={22} /><p>{t("还没有修改草稿")}</p><span>{t("选择原文段落，手动编辑或生成改写后，修改前后内容会出现在这里。")}</span></div>}
        <div className="changes-export-options"><label className="field"><span>{t("修改稿格式")}</span><select aria-label={t("修改稿格式")} value={exportFormat} disabled={Boolean(busy)} onChange={event => setExportFormat(event.target.value as typeof exportFormat)}><option value="tracked">{t("带修订痕迹（可在 Word 接受或拒绝）")}</option><option value="clean">{t("普通修改稿（无新增痕迹）")}</option></select></label>{exportFormat === 'tracked' && <label className="field"><span>{t("修订作者")}</span><input aria-label={t("修订作者")} value={revisionAuthor} onChange={event => setRevisionAuthor(event.target.value)} disabled={Boolean(busy)} maxLength={80} /><span className="field-help">{t("1–80 字，不含换行或控制字符。")}</span></label>}<p>{exportFormat === 'tracked' ? t("仅将已采纳项作为新增插入/删除修订写入新 DOCX，可在 Word 中逐项接受或拒绝。原有修订继续保留。") : t("仅将已采纳项写入普通修改稿，不新增修订痕迹；原有修订仍保留。")}</p>{invalidAuthor && <p className="changes-inline-warning">{t("请填写有效的修订作者。")}</p>}</div>
        <div className="changes-export"><div><strong>{t("已采纳")}{accepted.length}{t("项修改")}</strong><p>{dirty ? t("当前有未保存编辑，请先保存并确认，或撤销编辑。") : t("仅将已采纳的修改写入新 DOCX，同时导出变更清单。原件不覆盖。")}</p></div><button className="button primary" disabled={!workspace.supported || !accepted.length || dirty || Boolean(busy) || invalidAuthor || isPreview} onClick={() => void exportModified()}>{busy === 'export' ? <LoaderCircle size={14} className="spin" /> : <ArrowDownToLine size={14} />}{busy === 'export' ? t("正在导出…") : t("导出修改稿与清单")}</button></div>
        {lastExport && <dl className="changes-export-paths"><div><dt>{t("修改稿")}</dt><dd>{lastExport.documentPath}</dd></div><div><dt>{t("变更清单")}</dt><dd>{lastExport.changeListPath}</dd></div></dl>}
        {workspace.exports.length > 0 && <details className="changes-history"><summary>{t("已生成的修改版本")}<span>{workspace.exports.length}{t("份")}</span><ChevronDown size={12} /></summary><ul>{workspace.exports.map(item => <li key={item.id}><strong>{t("修改稿 v")}{item.versionNo}</strong><span>{dateLabel(item.createdAt, dateLocale)} · {item.proposalIds.length}{t("项修改 ·")}{item.format === 'tracked' ? t("带修订痕迹{v0}", { v0: item.revisionAuthor ? ` · ${item.revisionAuthor}` : '' }) : t("普通修改稿（无新增痕迹）")}</span></li>)}</ul></details>}
      </>}
    </div>
  </details>;
}

function ProposalCard({ proposal, index, target, disabled, busy, dirty, onEdit, onDecide }: {
  proposal: ChangeProposal; index: number; target?: ChangeTarget; disabled: boolean; busy: boolean; dirty: boolean;
  onEdit: () => void; onDecide: (status: ChangeDecision) => void;
}) {
  const { t, translateMessage, dateLocale } = useI18n();

  const fragment = target?.editMode === 'segments' || proposal.rangeStart !== 0 || (target && proposal.rangeEnd !== target.text.length);
  return <article className={`change-proposal ${proposal.status}`} data-proposal-id={proposal.id}>
    <div className="change-proposal-heading"><strong>{String(index + 1).padStart(2, '0')} · {target?.label ?? t("原文段落")}</strong><span className={`change-decision ${proposal.status}`}>{t(decisionLabels[proposal.status])}</span></div>
    {fragment && <p className="change-range-note">{t("仅修改文字片段 · 原文第")}{proposal.rangeStart + 1}–{proposal.rangeEnd}{t("位，其余文字与结构保留")}</p>}
    <div className="change-comparison"><div><div className="change-text-label">{t("修改前")}{fragment ? t(" · 片段") : ''}</div><p className="change-original">{proposal.originalText}</p></div><div><div className="change-text-label">{t("修改后")}{fragment ? t(" · 片段") : ''}</div><p className={`change-replacement ${proposal.replacementText ? '' : 'empty'}`}>{proposal.replacementText || t("删除该{v0}文字，保留段落结构", { v0: fragment ? '片段' : '段' })}</p></div></div>
    {proposal.explanation && <p className="change-explanation">{proposal.explanation}</p>}
    {proposal.warnings.length > 0 && <ul className="changes-warning-list">{proposal.warnings.map((warning, warningIndex) => <li key={warningIndex}>{warning}</li>)}</ul>}
    <p className="change-origin-note">{proposal.modelId ? t("模型生成 · 请核对业务事实与法律含义") : t("手动编辑")}{t("· 基于本次审核原文版本")}</p>
    {dirty && <p className="changes-inline-warning">{t("正在编辑这项修改，请先保存或撤销编辑。")}</p>}
    <div className="change-proposal-actions"><button className="text-button" disabled={disabled} onClick={onEdit}><Pencil size={12} />{t("编辑草稿")}</button><span />{proposal.status !== 'accepted' && <button className="button primary small" disabled={disabled || !proposalEditable(target, proposal)} onClick={() => onDecide('accepted')}>{busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}{t("采纳这项修改")}</button>}{proposal.status !== 'rejected' && <button className="button secondary small" disabled={disabled} onClick={() => onDecide('rejected')}><X size={13} />{t("拒绝")}</button>}{proposal.status !== 'proposed' && <button className="button secondary small" disabled={disabled} onClick={() => onDecide('proposed')}><Undo2 size={13} />{proposal.status === 'accepted' ? t("撤销采纳") : t("恢复待确认")}</button>}</div>
  </article>;
}
