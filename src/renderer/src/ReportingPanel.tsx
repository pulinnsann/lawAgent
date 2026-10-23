import { useEffect, useRef, useState } from 'react';
import { Download, FileBarChart2, Languages, LoaderCircle, RefreshCw, Save, X } from 'lucide-react';
import type { ContractAssistantBridge, ReviewResult } from '../../shared/contracts';
import { defaultReportSettings, type ReportFormat, type ReportRequest, type ReportSettings, type ReportSnapshot, type SavedReportSettings } from '../../shared/reporting';
import type { ReportLanguage, ReportTranslationWorkspace } from '../../shared/report-translation';
import { useI18n } from './i18n';
import ReviewFreshnessNotice from './ReviewFreshnessNotice';
import './reporting.css';

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const severityLabels = { high: '高风险', medium: '中风险', low: '低风险', unrated: '待判断' };
const dispositionLabels = { unreviewed: '待处理', confirmed: '人工确认关注', needs_information: '待补资料', escalated: '升级决策', business_accepted: '业务接受', fixed: '人工标记已整改', false_positive: '人工标记误报' };
type TranslationSummary={id:string;revision:number;updatedAt:string;language:ReportLanguage;state:string;stale:boolean;missingUnits:number};

export default function ReportingPanel({ bridge, review, onClose }: { bridge: ContractAssistantBridge; review: ReviewResult | null; onClose: () => void }) {
  const {t,formatDate,translateMessage}=useI18n();
  const [scope, setScope] = useState<ReportRequest['scope']>(review ? 'current' : 'workspace');
  const [style, setStyle] = useState<ReportRequest['style']>('management');
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [settings, setSettings] = useState<ReportSettings>(defaultReportSettings());
  const [saved, setSaved] = useState<SavedReportSettings>({ id: null, revision: 0, body: defaultReportSettings() });
  const [format, setFormat] = useState<ReportFormat>('docx');
  const [snapshot, setSnapshot] = useState<ReportSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>('load');
  const [notice, setNotice] = useState<{ kind: 'error' | 'info' | 'success'; text: string } | null>(null);
  const [closeWarning, setCloseWarning] = useState(false);
  const [translation,setTranslation]=useState<ReportTranslationWorkspace|null>(null);
  const [translations,setTranslations]=useState<TranslationSummary[]>([]);
  const [selectedUnit,setSelectedUnit]=useState(''); const [target,setTarget]=useState('');
  const [onlyMissing,setOnlyMissing]=useState(true); const [allowModel,setAllowModel]=useState(false);
  const [approve,setApprove]=useState(false);const [approvalReason,setApprovalReason]=useState('');
  const [translationProgress,setTranslationProgress]=useState<{phase?:string;modelRuntime?:{call?:number;characters?:number}}|null>(null);
  const translationRequest=useRef<string|null>(null);
  const alive = useRef(true); const initialReviewId = useRef(review?.id);
  const language=settings.language??'zh';
  const request = (): ReportRequest => ({ scope, style, ...(scope === 'current' ? { reviewId: review?.id } : { ...(from ? { from } : {}), ...(to ? { to } : {}) }), settings, ...(translation?{translationId:translation.asset.id}:{}) });
  const invalid = scope === 'current' && !review || scope === 'workspace' && from && to && from > to;
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved.body);
  const currentUnit=translation?.asset.body.units.find(unit=>unit.id===selectedUnit);
  const translationDirty=Boolean(currentUnit&&target!==currentUnit.target);
  const translatedReady=language==='zh'||Boolean(translation&&!translation.stale&&translation.asset.body.state==='approved'&&!translationDirty);
  const units=translation?.asset.body.units.filter(unit=>!onlyMissing||!unit.target)||[];
  const resetTranslation=()=>{setTranslation(null);setTranslations([]);setSelectedUnit('');setTarget('');setApprove(false);setAllowModel(false);};
  const acceptTranslation=(value:ReportTranslationWorkspace)=>{setTranslation(value);setApprove(false);const selected=value.asset.body.units.find(unit=>unit.id===selectedUnit)??value.asset.body.units.find(unit=>!unit.target)??value.asset.body.units[0];setSelectedUnit(selected?.id??'');setTarget(selected?.target??'');};
  const errorNotice=(error:unknown)=>setNotice({kind:'error',text:translateMessage(messageOf(error))});
  const listTranslations=async(value:ReportRequest)=>{const result=await bridge.runWorkspaceCommand({action:'reporting.translation.list',payload:{request:value}}) as TranslationSummary[];if(alive.current)setTranslations(result);};
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const result = await bridge.runWorkspaceCommand({ action: 'reporting.settings.get', payload: {} }) as SavedReportSettings;
        if (!alive.current) return;
        setSettings(result.body); setSaved(result);
        const query:ReportRequest={ scope: initialReviewId.current ? 'current' : 'workspace', ...(initialReviewId.current ? { reviewId: initialReviewId.current } : {}), style: 'management', settings: result.body };
        const value = await bridge.runWorkspaceCommand({ action: 'reporting.query', payload: query }) as ReportSnapshot;
        if (alive.current) setSnapshot(value);
        if((result.body.language??'zh')!=='zh')await listTranslations(query);
      } catch (error) { if (alive.current) errorNotice(error); }
      finally { if (alive.current) setBusy(null); }
    })();
    return () => { alive.current = false; };
  }, [bridge]);
  useEffect(()=>{
    if(busy!=='reporting.translation.generate'||!translationRequest.current)return;
    const requestId=translationRequest.current;let live=true;let reading=false;
    const timer=setInterval(()=>{if(reading)return;reading=true;void bridge.runWorkspaceCommand({action:'workspace.progress',payload:{requestId}}).then(value=>{if(live&&alive.current)setTranslationProgress(value);}).catch(()=>{}).finally(()=>{reading=false;});},400);
    return()=>{live=false;clearInterval(timer);};
  },[bridge,busy]);
  const preview = async () => {
    if (busy || invalid) return; setBusy('preview'); setNotice(null);
    try { const value = await bridge.runWorkspaceCommand({ action: 'reporting.query', payload: request() }) as ReportSnapshot; if (alive.current) { setSnapshot(value); if(translation){const current=await bridge.runWorkspaceCommand({action:'reporting.translation.get',payload:{id:translation.asset.id}}) as ReportTranslationWorkspace;acceptTranslation(current);} if(language!=='zh')await listTranslations(request());setNotice({ kind: 'success', text: t('预览已按当前范围和最新人工记录刷新。') }); } }
    catch (error) { if (alive.current) errorNotice(error); }
    finally { if (alive.current) setBusy(null); }
  };
  const save = async () => {
    if (busy) return; setBusy('save'); setNotice(null);
    try {
      const value = await bridge.runWorkspaceCommand({ action: 'reporting.settings.save', payload: { ...(saved.id ? { id: saved.id } : {}), expectedRevision: saved.revision, body: settings, actorLabel: settings.authorLabel.trim() || '法务' } }) as SavedReportSettings;
      if (alive.current) { setSaved(value); setSettings(value.body); setNotice({ kind: 'success', text: t('报告个性化配置已保存在本地，历史修订保留。') }); }
    } catch (error) { if (alive.current) errorNotice(error); }
    finally { if (alive.current) setBusy(null); }
  };
  const exportReport = async () => {
    if (busy || invalid||!translatedReady) return; setBusy('export'); setNotice(null);
    try {
      const result = await bridge.runWorkspaceCommand({ action: 'reporting.export', payload: { ...request(), format } }) as { path?: string; filePath?: string; cancelled?: boolean } | null;
      if (alive.current) setNotice({ kind: !result||result.cancelled?'info':'success', text: !result || result.cancelled ? t('已取消导出。') : t('报告已导出至 {path}。导出未调用模型。',{path:result.path??result.filePath??''}) });
    } catch (error) { if (alive.current) errorNotice(error); }
    finally { if (alive.current) setBusy(null); }
  };
  const translationCommand=async(action:string,payload:unknown)=>{
    if(busy)return;const requestId=crypto.randomUUID();translationRequest.current=requestId;setTranslationProgress(null);setBusy(action);setNotice(null);
    try{const value=await bridge.runWorkspaceCommand({action,payload,requestId}) as ReportTranslationWorkspace;if(alive.current){acceptTranslation(value);await listTranslations(request());setNotice({kind:'success',text:t('报告译文已保存在本地。请逐项核对，确认后再导出。')});}}
    catch(error){if(alive.current)errorNotice(error);}finally{translationRequest.current=null;if(alive.current){setBusy(null);setTranslationProgress(null);}}
  };
  const cancelTranslation=async()=>{const requestId=translationRequest.current;if(!requestId)return;try{await bridge.runWorkspaceCommand({action:'workspace.cancel',payload:{requestId}});}catch(error){if(alive.current)errorNotice(error);}};
  const actorLabel=settings.authorLabel.trim()||'法务';
  const update = <K extends keyof ReportSettings>(key: K, value: ReportSettings[K]) => { setSettings(previous => ({ ...previous, [key]: value })); setCloseWarning(false);resetTranslation(); };
  const close = () => { if ((dirty||translationDirty) && !closeWarning) { setCloseWarning(true); setNotice({ kind: 'info', text: t('报告配置或译文有未保存的修改；再次点击关闭将放弃本次输入。') }); return; } onClose(); };
  return <section className="reporting-panel card" aria-label={t('报告与工作汇总')}><header className="reporting-heading"><div><FileBarChart2 size={20} /><h2>{t('报告与工作汇总')}</h2></div><button type="button" className="text-button" disabled={Boolean(busy)} onClick={close}><X size={16} />{t('关闭')}</button></header>
    <p className="reporting-intro">{t('将已保存的审核、引用依据和人工处置整理为内部报告。英泰报告使用独立译文，人工确认后导出；原合同和来源引文保持原文。')}</p>
    {notice && <p className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
    <div className="reporting-layout"><aside className="reporting-controls">
      <label className="field"><span>{t('报告范围')}</span><select aria-label={t('报告范围')} value={scope} disabled={Boolean(busy)} onChange={event => {setScope(event.target.value as ReportRequest['scope']);resetTranslation();}}><option value="current" disabled={!review}>{t('当前审核记录')}</option><option value="workspace">{t('跨合同工作汇总')}</option></select></label>
      {scope === 'current' ? <p className="reporting-note">{t('当前审核 {id}。需要其他历史审核时，请返回合同页面选择后重新打开。',{id:review?.id??t('未选择')})}</p> : <div className="reporting-date-range"><label className="field"><span>{t('开始日期')}</span><input aria-label={t('报告开始日期')} type="date" value={from} disabled={Boolean(busy)} onChange={event => {setFrom(event.target.value);resetTranslation();}} /></label><label className="field"><span>{t('结束日期')}</span><input aria-label={t('报告结束日期')} type="date" value={to} disabled={Boolean(busy)} onChange={event => {setTo(event.target.value);resetTranslation();}} /></label><small>{t('留空表示不限制，按北京时间自然日，包含起止日期。')}</small></div>}
      <label className="field"><span>{t('报告语言')}</span><select aria-label={t('报告语言')} value={language} disabled={Boolean(busy)} onChange={event=>update('language',event.target.value as ReportLanguage)}><option value="zh">中文</option><option value="en">English</option><option value="th">ภาษาไทย</option></select></label>
      <label className="field"><span>{t('报告样式')}</span><select aria-label={t('报告样式')} value={style} disabled={Boolean(busy)} onChange={event => {setStyle(event.target.value as ReportRequest['style']);resetTranslation();}}><option value="management">{t('内部管理报告')}</option><option value="risk">{t('详细风险报告')}</option><option value="summary">{t('领导摘要与依据附录')}</option></select></label>
      {([['organization','单位名称','报告单位名称',160],['authorLabel','编制人标签','报告编制人',80],['recipientLabel','接收人或汇报对象','报告接收人',160]] as const).map(([key,label,aria,max])=><label className="field" key={key}><span>{t(label)}</span><input aria-label={t(aria)} maxLength={max} value={settings[key]} disabled={Boolean(busy)} onChange={event => update(key,event.target.value)} /></label>)}
      <label className="reporting-checkbox"><input type="checkbox" checked={settings.includeContractQuotes} disabled={Boolean(busy)} onChange={event => update('includeContractQuotes', event.target.checked)} />{t('包含合同直接引文')}</label>
      <label className="reporting-checkbox"><input type="checkbox" checked={settings.includeDispositionHistory} disabled={Boolean(busy)} onChange={event => update('includeDispositionHistory', event.target.checked)} />{t('包含全部风险处置历史')}</label>
      <button type="button" className="button secondary" disabled={Boolean(busy) || !dirty} onClick={() => void save()}><Save size={15} />{t('保存报告配置')}</button>
      <label className="field"><span>{t('导出格式')}</span><select aria-label={t('报告导出格式')} value={format} disabled={Boolean(busy)} onChange={event => setFormat(event.target.value as ReportFormat)}>{([['docx','Word 文档 DOCX'],['pdf','PDF 报告'],['html','HTML 完整报告'],['markdown','Markdown 完整报告'],['csv','CSV 明细索引']] as const).map(([value,label])=><option key={value} value={value}>{t(label)}</option>)}</select></label>
      {format === 'csv' && <p className="reporting-note">{t('CSV 用于筛选和回溯索引，完整引文、处置历史和说明请导出 Word、PDF 或 HTML。')}</p>}
      {language!=='zh'&&!translatedReady&&<p className="reporting-note">{t('目标语言报告需完成译文、人工确认且未过期，才能导出。')}</p>}
      <div className="reporting-actions"><button type="button" className="button secondary" disabled={Boolean(busy) || Boolean(invalid)||translationDirty} onClick={() => void preview()}><RefreshCw size={15} />{t('刷新预览')}</button><button type="button" className="button primary" disabled={Boolean(busy) || Boolean(invalid)||!translatedReady} onClick={() => void exportReport()}>{busy === 'export' ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{t('导出报告')}</button></div>
      {invalid && <p role="alert" className="reporting-error">{t('请核对当前审核和日期范围。')}</p>}
    </aside><div className="reporting-preview" aria-live="polite">
      {language!=='zh'&&<section className="report-translation" aria-label={t('报告译文工作区')}><h3><Languages size={18}/>{t('报告译文工作区')}</h3><p className="reporting-note">{t('先准备可信原报告，再生成或手工填写候选。保护标记对应原文、金额日期和标识，必须保留；保存编辑会撤销先前确认。')}</p>
        <div className="reporting-actions"><button className="button secondary" disabled={Boolean(busy)||Boolean(invalid)||translationDirty} onClick={()=>void translationCommand('reporting.translation.prepare',{request:request(),actorLabel})}>{t('准备报告译文')}</button><button className="text-button" disabled={Boolean(busy)||translationDirty} onClick={()=>void preview()}>{t('读取已保存译文')}</button></div>
        {translations.length>0&&<label className="field"><span>{t('已保存报告译文')}</span><select aria-label={t('已保存报告译文')} value={translation?.asset.id??''} disabled={Boolean(busy)||translationDirty} onChange={event=>{if(event.target.value)void translationCommand('reporting.translation.get',{id:event.target.value});}}><option value="">{t('请选择')}</option>{translations.map(value=><option value={value.id} key={value.id}>{formatDate(value.updatedAt)} · r{value.revision} · {value.stale?t('已过期'):value.state==='approved'?t('已人工确认'):t('待人工确认')} · {t('未完成 {count} 项',{count:value.missingUnits})}</option>)}</select></label>}
        {translation&&<><p className={translation.stale?'reporting-error':'reporting-note'}>{translation.stale?t('源记录已更新，当前译文已过期，请重新准备。'):translation.asset.body.state==='approved'?t('译文已人工确认；源记录变化后将阻止导出。'):t('译文候选尚未人工确认。')} {t('完成 {done} / {total} 项',{done:translation.completeUnits,total:translation.asset.body.units.length})} · r{translation.asset.revision}</p>
          <label className="reporting-checkbox"><input type="checkbox" checked={allowModel} disabled={Boolean(busy)||translation.stale} onChange={event=>setAllowModel(event.target.checked)}/>{t('允许使用当前配置的模型生成本次报告译文候选')}</label>
          <button className="button secondary" disabled={Boolean(busy)||!allowModel||translation.stale||translationDirty||translation.missingUnits===0} onClick={()=>void translationCommand('reporting.translation.generate',{id:translation.asset.id,expectedRevision:translation.asset.revision,actorLabel,confirmed:true})}>{busy==='reporting.translation.generate'?<LoaderCircle className="spin" size={15}/>:<Languages size={15}/>} {t('生成缺失译文候选')}</button>
          {busy==='reporting.translation.generate'&&<div className="reporting-actions"><p className="reporting-note" role="status">{t('生成进度：{phase}；调用 {call}；已接收 {count} 字符',{phase:translateMessage(translationProgress?.phase??t('正在生成候选')),call:translationProgress?.modelRuntime?.call??0,count:translationProgress?.modelRuntime?.characters??0})}</p><button className="button secondary" onClick={()=>void cancelTranslation()}>{t('取消生成候选')}</button></div>}
          <label className="reporting-checkbox"><input type="checkbox" checked={onlyMissing} disabled={Boolean(busy)||translationDirty} onChange={event=>{setOnlyMissing(event.target.checked);const first=translation.asset.body.units.find(unit=>!event.target.checked||!unit.target);setSelectedUnit(first?.id??'');setTarget(first?.target??'');}}/>{t('只显示尚未填写的译文')}</label>
          <label className="field"><span>{t('翻译单元')}</span><select aria-label={t('翻译单元')} value={selectedUnit} disabled={Boolean(busy)||translationDirty} onChange={event=>{setSelectedUnit(event.target.value);setTarget(translation.asset.body.units.find(unit=>unit.id===event.target.value)?.target??'');}}>{!units.some(unit=>unit.id===selectedUnit)&&<option value={selectedUnit}>{currentUnit?currentUnit.source.slice(0,90):t('没有待填写项目')}</option>}{units.map((unit,index)=><option key={unit.id} value={unit.id}>{index+1} · {unit.source.slice(0,90)}</option>)}</select></label>
          {currentUnit&&<><label className="field"><span>{t('冻结的报告原文')}</span><textarea aria-label={t('冻结的报告原文')} readOnly value={currentUnit.source}/></label><label className="field"><span>{t('包含保护标记的待译文本')}</span><textarea aria-label={t('包含保护标记的待译文本')} readOnly value={currentUnit.protectedSource}/></label><label className="field"><span>{t('目标语言译文')}</span><textarea lang={language} aria-label={t('目标语言译文')} value={target} maxLength={60000} disabled={Boolean(busy)||translation.stale} onChange={event=>{setTarget(event.target.value);setApprove(false);}}/></label>
          {currentUnit.protectedValues.length>0&&<details><summary>{t('保护标记与原文对应')}</summary>{currentUnit.protectedValues.map(value=><p key={value.token}><code>{value.token}</code> {value.value}</p>)}</details>}
          <div className="reporting-actions"><button className="button secondary" disabled={Boolean(busy)||translation.stale||!translationDirty} onClick={()=>void translationCommand('reporting.translation.save',{id:translation.asset.id,expectedRevision:translation.asset.revision,actorLabel,edits:[{id:currentUnit.id,target}]})}><Save size={15}/>{t('保存本项译文')}</button>{!target&&<button className="text-button" disabled={Boolean(busy)||translation.stale} onClick={()=>setTarget(currentUnit.protectedSource)}>{t('复制保护标记文本到编辑框')}</button>}</div>
          {target&&<p className="reporting-note" lang={language}>{currentUnit.protectedValues.reduce((text,value)=>text.replace(value.token,()=>value.value),target)}</p>}</>}
          <label className="field"><span>{t('译文复核说明')}</span><textarea aria-label={t('译文复核说明')} maxLength={2000} value={approvalReason} disabled={Boolean(busy)||translation.stale} onChange={event=>setApprovalReason(event.target.value)}/></label>
          <label className="reporting-checkbox"><input type="checkbox" checked={approve} disabled={Boolean(busy)||translation.stale||translationDirty||translation.missingUnits>0} onChange={event=>setApprove(event.target.checked)}/>{t('我已核对全部译文和保留原文，确认本次目标语言报告')}</label>
          <button className="button primary" disabled={Boolean(busy)||translation.stale||translationDirty||translation.missingUnits>0||!approve||!approvalReason.trim()} onClick={()=>void translationCommand('reporting.translation.confirm',{id:translation.asset.id,expectedRevision:translation.asset.revision,actorLabel,reason:approvalReason,confirmed:true})}>{t('确认目标语言译文')}</button>
          <details><summary>{t('译文历史与生成说明')}</summary>{translation.asset.body.warnings.map((value,index)=><p key={index}>{value}</p>)}{translation.history.map(value=><p key={value.revision}>r{value.revision} · {value.actorLabel} · {formatDate(value.updatedAt)} · {value.body.state==='approved'?t('已人工确认'):t('候选')} · {value.body.approvalReason??''}</p>)}</details>
        </>}
      </section>}
      {busy === 'load' ? <p><LoaderCircle size={16} className="spin" />{t('正在读取本地记录')}</p> : snapshot ? <>
      <h3>{t(snapshot.scope === 'current' ? '当前审核汇报预览' : '跨合同工作汇总预览')}</h3><p className="reporting-note">{t('原记录预览生成于 {time}。修改范围或配置后请刷新；目标语言译文在上方单独核对。',{time:formatDate(snapshot.generatedAt)})}</p>
      <div className="reporting-metrics">{[['合同记录', snapshot.metrics.contracts], ['文档版本', snapshot.metrics.documentVersions], ['完成审核', snapshot.metrics.reviewRounds], ['原始意见', snapshot.metrics.riskItems], ['待跟进意见', snapshot.metrics.pendingDecisions], ['人工补录修订', snapshot.metrics.activeManualOpinions]].map(([label, value]) => <div key={label}><span>{t(String(label))}</span><strong>{value}</strong></div>)}</div>
      <h4>{t('原风险等级')}</h4><div className="reporting-status-grid">{Object.entries(severityLabels).map(([key, label]) => <span key={key}>{t(label)}<strong>{snapshot.metrics.severities[key as keyof typeof severityLabels]}</strong></span>)}</div>
      <h4>{t('导出时的人工处置')}</h4><div className="reporting-status-grid">{Object.entries(dispositionLabels).map(([key, label]) => <span key={key}>{t(label)}<strong>{snapshot.metrics.dispositions[key as keyof typeof dispositionLabels]}</strong></span>)}</div>
      <h4>{t('标准分组')}</h4>{snapshot.standardGroups.map(group => <p key={group.key}>{group.label} · {t('{count} 轮',{count:group.reviewRounds})}<span className="reporting-hash">{group.contentSha256 ?? t('未保存标准快照')}</span></p>)}
      <h4>{t('统计口径与局限')}</h4>{snapshot.limitations.map(value => <p key={value}>{value}</p>)}
      <h4>{t('审核与来源明细')}</h4>{snapshot.reviews.length ? snapshot.reviews.map(item => <details key={item.review.id}><summary>{item.document.name} · {t('{count} 项意见',{count:item.review.findings.length})}</summary><p>{item.review.summary}</p>{item.freshness && <ReviewFreshnessNotice value={item.freshness} />}{item.completion && <><p>{t('冻结资料 r{frozen} · 当前资料 r{current} · 已保存来源人工核验 {count} 条',{frozen:item.completion.frozen?.facts?.revision??0,current:item.completion.currentFacts?.revision??0,count:item.completion.sourceVerifications.length})}</p>{item.completion.sourceVerifications.map(record => <p key={record.evidenceId}>{t('来源')} {record.evidenceId} · r{record.current.revision} · {record.current.body.reason}</p>)}</>}<p>{t('审核')} {item.review.id} · {item.review.createdAt}</p><p>{t('来源 {count} 条 · 处置修订 {revision}',{count:item.review.retrieval?.evidence.length??0,revision:item.dispositions.revision})}</p>{item.review.findings.map(finding => <p key={finding.id}><strong>{finding.title}</strong> · {t(severityLabels[finding.severity])}<br />{finding.suggestion}</p>)}{item.annotations?.filter(annotation => annotation.body.state === 'active').map(annotation => <p key={annotation.id}><strong>{t('人工意见')} {annotation.body.title}</strong> · v{annotation.revision}<br />{annotation.body.description}</p>)}</details>) : <p>{t('本范围没有完成的审核报告。')}</p>}
      <p className="reporting-hash">{t('报告快照 SHA256')} {snapshot.snapshotSha256}</p>
    </> : <p>{t('请选择范围并刷新预览。')}</p>}</div></div>
  </section>;
}
