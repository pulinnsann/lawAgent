import { useI18n } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Check, CircleAlert, FilePlus2, FileText, Info, LoaderCircle, RefreshCw, Settings2, Sparkles, Square, X } from 'lucide-react';
import type { ContractAssistantBridge, ContractDetail, PublicModelConfig } from '../../shared/contracts';
import type { ContractDraft, ContractDraftSummary, GenerateContractInput } from '../../shared/generation';
import './generation.css';
import AuthoringReviewPanel from './AuthoringReviewPanel';
import type { AuthoringCaseView } from '../../shared/generation';

type Notice = { kind: 'success' | 'error' | 'info'; text: string };
const languages = { zh: '中文', en: '英文', th: '泰文' };
const types = { procurement: '采购合同', service: '服务合同', other: '其他业务合同' };
const roles = { buyer: '采购方 / 买方', seller: '供应方 / 卖方', service_provider: '服务提供方', service_recipient: '服务接受方', other: '其他立场' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const dateLabel = (value: string, locale: string) => new Date(value).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function ContractGenerationPanel({ bridge, open, isPreview, modelConfig, onClose, onModelSettings, onImported }: {
  bridge: ContractAssistantBridge; open: boolean; isPreview: boolean; modelConfig?: PublicModelConfig | null;
  onClose: () => void; onModelSettings: () => void; onImported: (document: ContractDetail) => Promise<void>;
}) {
  const { t, translateMessage, dateLocale } = useI18n();

  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState<GenerateContractInput['language']>('zh');
  const [contractType, setContractType] = useState<GenerateContractInput['contractType']>('service');
  const [ourPartyRole, setOurPartyRole] = useState<GenerateContractInput['ourPartyRole']>('service_recipient');
  const [drafts, setDrafts] = useState<ContractDraftSummary[]>([]);
  const [draft, setDraft] = useState<ContractDraft | null>(null);
  const [authoring,setAuthoring] = useState<AuthoringCaseView|null>(null);
  const [busy, setBusy] = useState<'generate' | 'cancel' | 'export' | 'history' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const alive = useRef(true);
  const isOpen = useRef(open); isOpen.current = open;
  const operation = useRef(0);
  const activeRequest = useRef<{ id: string; cancelled: boolean } | null>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; const ticket = activeRequest.current; if (ticket) { ticket.cancelled = true; void bridge.cancelContractGeneration(ticket.id).catch(() => {}); } };
  }, [bridge]);

  const refreshHistory = async () => {
    if (activeRequest.current || busy === 'export') return;
    const sequence = ++operation.current; setBusy('history');
    try {
      const values = await bridge.listContractDrafts();
      if (!alive.current || !isOpen.current || sequence !== operation.current) return;
      setDrafts(values);
      const id = values.some(item => item.id === draftRef.current?.id) ? draftRef.current!.id : values[0]?.id;
      const value = id ? await bridge.getContractDraft(id) : null;
      if (alive.current && isOpen.current && sequence === operation.current) setDraft(value);
    } catch (error) { if (alive.current && isOpen.current && sequence === operation.current) setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { if (alive.current && sequence === operation.current) setBusy(null); }
  };

  useEffect(() => {
    if (open) { void refreshHistory(); return; }
    ++operation.current;
    const ticket = activeRequest.current;
    if (ticket) { const wasCancelled = ticket.cancelled; ticket.cancelled = true; activeRequest.current = null; if (!wasCancelled) void bridge.cancelContractGeneration(ticket.id).catch(() => {}); }
    setBusy(null);
  }, [open, bridge]);

  const cancelGeneration = async (closing = false) => {
    const ticket = activeRequest.current;
    if (!ticket || ticket.cancelled) return;
    ticket.cancelled = true;
    if (!closing) setBusy('cancel');
    try {
      await bridge.cancelContractGeneration(ticket.id);
      if (alive.current && activeRequest.current === ticket) setNotice({ kind: 'info', text: t("本次生成已取消，输入保留。此前的合同草稿仍可查看。") });
    } catch (error) { if (alive.current && activeRequest.current === ticket) setNotice({ kind: 'error', text: t("取消请求未成功：{v0}。界面不会采用本次迟到结果，请刷新草稿记录核对状态。", { v0: messageOf(error) }) }); }
    finally { if (activeRequest.current === ticket) { activeRequest.current = null; if (alive.current) setBusy(null); } }
  };

  const close = () => {
    if (busy === 'export') return;
    ++operation.current; void cancelGeneration(true); isOpen.current = false; onClose();
  };
  useEffect(() => {
    if (!open) return;
    const previous = window.document.activeElement;
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus());
    return () => { cancelAnimationFrame(frame); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);
  useEffect(() => {
    if (!open || authoring) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const controls = [...panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), select:not(:disabled), input:not(:disabled)') ?? []];
        const first = controls[0]; const last = controls.at(-1); const current = window.document.activeElement;
        if (event.shiftKey && (current === first || !panelRef.current?.contains(current))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (current === last || !panelRef.current?.contains(current))) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [open, busy, authoring]);

  const generate = async () => {
    const text = description.trim();
    if (activeRequest.current || busy || isPreview || !modelConfig || text.length < 20 || text.length > 12000) return;
    const ticket = { id: crypto.randomUUID(), cancelled: false }; activeRequest.current = ticket;
    ++operation.current; setBusy('generate'); setNotice(null);
    try {
      const value = await bridge.generateContract({ requestId: ticket.id, description: text, language, contractType, ourPartyRole });
      if (!alive.current || !isOpen.current || activeRequest.current !== ticket || ticket.cancelled) return;
      setDraft(value); setDrafts(values => [value, ...values.filter(item => item.id !== value.id)]);
      setNotice({ kind: 'success', text: t("合同草稿已保存。下一步完成程序核验、现有管线审核和逐项人工确认，再导出。") });
    } catch (error) { if (alive.current && isOpen.current && activeRequest.current === ticket && !ticket.cancelled) setNotice({ kind: 'error', text: t("{v0} 输入已保留，可调整后重试。", { v0: messageOf(error) }) }); }
    finally { if (activeRequest.current === ticket) { activeRequest.current = null; if (alive.current) setBusy(null); } }
  };

  const chooseDraft = async (id: string) => {
    if (busy) return;
    const sequence = ++operation.current; setBusy('history'); setNotice(null);
    try { const value = await bridge.getContractDraft(id); if (alive.current && isOpen.current && sequence === operation.current) setDraft(value); }
    catch (error) { if (alive.current && isOpen.current && sequence === operation.current) setNotice({ kind: 'error', text: messageOf(error) }); }
    finally { if (alive.current && sequence === operation.current) setBusy(null); }
  };
  const exportDraft = async () => {
    if (!draft || busy || isPreview) return;
    setBusy('export'); setNotice(null);
    try { const view=await bridge.runWorkspaceCommand({action:'library.authoring.prepareDescription',payload:{draftId:draft.id,actorLabel:'法务'}}) as AuthoringCaseView; if(alive.current&&isOpen.current)setAuthoring(view); }
    catch(error){if(alive.current)setNotice({kind:'error',text:messageOf(error)});}
    finally{if(alive.current)setBusy(null);}
  };

  if (!open) return null;
  if(authoring)return <AuthoringReviewPanel bridge={bridge} initial={authoring} onClose={()=>setAuthoring(null)} onImported={onImported}/>;
  return <div className="generation-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={panelRef} className="generation-panel" role="dialog" aria-modal="true" aria-labelledby="generation-title">
      <header className="generation-heading"><div><span>{t("CONTRACT DRAFT")}</span><h2 id="generation-title"><FilePlus2 size={20} />{t("描述生成合同")}</h2><p>{t("把交易安排写清楚，生成一份独立合同草稿。")}</p></div><button className="icon-button" aria-label={t("关闭生成合同")} disabled={busy === 'export'} onClick={close}><X size={19} /></button></header>
      <div className="generation-body">
        {isPreview && <p className="generation-note"><Info size={15} />{t("当前是界面预览：历史中仅有固定演示草稿，不调用模型、不生成或导出真实文件。")}</p>}
        <div className="generation-layout"><div className="generation-input-column">
          <div className="generation-section-heading"><h3>{t("描述交易需求")}</h3><button className="text-button" disabled={Boolean(busy)} onClick={() => { close(); onModelSettings(); }}><Settings2 size={13} />{t("模型设置")}</button></div>
          <label className="field"><span>{t("合同需求描述")}</span><textarea aria-label={t("合同需求描述")} value={description} onChange={event => setDescription(event.target.value)} disabled={Boolean(busy)} maxLength={12000} rows={8} placeholder={t("例如：我方委托服务商提供一年的系统维护服务，需约定服务范围、响应时间、按验收付款、保密、违约和退出安排。尚未确定的信息请保留待填写。")} /><span className="field-help">{t("20–12,000 字；说明双方角色、交易内容、交付验收、付款和特别关注事项。")}{description.trim().length.toLocaleString()} / 12,000</span></label>
          <div className="generation-form-grid"><label className="field"><span>{t("合同语言")}</span><select aria-label={t("合同语言")} value={language} disabled={Boolean(busy)} onChange={event => setLanguage(event.target.value as typeof language)}>{Object.entries(languages).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label><label className="field"><span>{t("生成合同类型")}</span><select aria-label={t("生成合同类型")} value={contractType} disabled={Boolean(busy)} onChange={event => setContractType(event.target.value as typeof contractType)}>{Object.entries(types).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label><label className="field generation-role"><span>{t("生成合同我方立场")}</span><select aria-label={t("生成合同我方立场")} value={ourPartyRole} disabled={Boolean(busy)} onChange={event => setOurPartyRole(event.target.value as typeof ourPartyRole)}>{Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label></div>
          <p className="generation-scope">{t("以中国大陆法律为范围，按所选语言起草；缺少的主体、金额和日期需人工补充。生成草稿须经人工审核，法律依据及时效仍需核验。")}</p>
          {!isPreview && !modelConfig && <p className="generation-note"><Info size={15} />{t("请先在模型设置中配置可用连接，再生成合同。")}</p>}
          {modelConfig && <p className="generation-model">{t("当前模型：")}{modelConfig.name} · {modelConfig.model}</p>}
          <div className="generation-actions"><button className="button primary" disabled={Boolean(busy) || isPreview || !modelConfig || description.trim().length < 20 || description.trim().length > 12000} onClick={() => void generate()}>{busy === 'generate' || busy === 'cancel' ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{busy === 'generate' || busy === 'cancel' ? t("正在生成合同…") : t("生成合同草稿")}</button>{(busy === 'generate' || busy === 'cancel') && <button className="button secondary" disabled={busy === 'cancel'} onClick={() => void cancelGeneration()}><Square size={12} />{busy === 'cancel' ? t("正在取消…") : t("取消本次生成")}</button>}</div>
          <div className="generation-section-heading generation-history-heading"><h3>{t("已保存的合同草稿")}<span>{drafts.length}</span></h3><button className="text-button" aria-label={t("刷新合同草稿")} disabled={Boolean(busy)} onClick={() => void refreshHistory()}><RefreshCw size={13} />{t("刷新")}</button></div>
          <div className="generation-history" aria-label={t("合同草稿历史")}>{drafts.length ? drafts.map(item => <button key={item.id} className={`generation-history-item ${draft?.id === item.id ? 'active' : ''}`} disabled={Boolean(busy)} onClick={() => void chooseDraft(item.id)}><FileText size={16} /><span><strong>{item.title}</strong><small>{t(languages[item.language])} · {dateLabel(item.createdAt, dateLocale)}</small></span></button>) : <p>{busy === 'history' ? t("正在读取草稿…") : t("尚未生成合同草稿。")}</p>}</div>
        </div><div className="generation-preview-column">
          {draft ? <article className="generation-draft" data-draft-id={draft.id}><div className="generation-draft-meta"><span>{isPreview ? t("固定演示草稿") : t("待审核草稿")}</span><span>{t(languages[draft.language])} · {dateLabel(draft.createdAt, dateLocale)}</span></div><h3>{draft.title}</h3><div className="generation-checks"><section><h4>{t("待补信息")}</h4>{draft.missingInformation.length ? <ul>{draft.missingInformation.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>{t("模型未列出待补信息，仍需逐项核对交易事实。")}</p>}</section><section><h4>{t("风险提醒与限制")}</h4>{draft.warnings.length ? <ul>{draft.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>{t("请人工审核条款与业务安排，不能据此认为不存在风险。")}</p>}</section></div><div className="generation-clauses">{draft.clauses.map((clause, index) => <section key={index}><h4>{clause.heading}</h4>{clause.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}</section>)}</div><p className="generation-model">{t("使用模型：")}{draft.modelId}{draft.inputTokens !== null ? t(" · 输入 {v0} tokens", { v0: draft.inputTokens.toLocaleString() }) : ''}{draft.outputTokens !== null ? t(" · 输出 {v0} tokens", { v0: draft.outputTokens.toLocaleString() }) : ''}</p></article> : <div className="generation-empty"><FilePlus2 size={34} strokeWidth={1.4} /><h3>{t("合同草稿将在这里预览")}</h3><p>{t("生成后核验交易信息与占位，审核当前原稿并逐项确认后导出 DOCX。")}</p></div>}
        </div></div>
      </div>
      <footer className="generation-footer">{notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'error' ? <CircleAlert size={15} /> : notice.kind === 'success' ? <Check size={15} /> : <Info size={15} />}<span>{translateMessage(notice.text)}</span></div>}<div><p>{t("生成后先建立审核原稿；完成核验、审核及人工确认，才可最终导出。")}</p><button className="button primary" disabled={!draft || Boolean(busy) || isPreview} onClick={() => void exportDraft()}>{busy === 'export' ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}{busy === 'export' ? t("正在准备审核原稿…") : t("核验、审核并确认")}</button></div></footer>
    </section>
  </div>;
}
