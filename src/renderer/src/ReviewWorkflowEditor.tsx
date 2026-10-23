import { useI18n } from './i18n';
import { defaultReviewWorkflow, workflowNodeLabels, type ReviewWorkflowDefinition, type ReviewWorkflowNode } from '../../shared/review-completion';

export default function ReviewWorkflowEditor({ value, onChange }: { value?: ReviewWorkflowDefinition; onChange: (value?: ReviewWorkflowDefinition) => void }) {
  const { t, translateMessage, dateLocale } = useI18n();

  const defaults = defaultReviewWorkflow();
  const update = (kind: ReviewWorkflowNode['kind'], patch: Partial<ReviewWorkflowNode>) => onChange({ nodes: value!.nodes.map(node => node.kind === kind ? { ...node, ...patch } : node) });
  return <section className="enterprise-rule" aria-label={t("有限审核流程配置")}><h3>{t("有限审核流程")}</h3>
    <label><input type="checkbox" checked={Boolean(value)} onChange={event => onChange(event.target.checked ? defaults : undefined)} />{t("为此标准发布独立流程")}</label>
    <p>{t("按资料收集 → 程序核验 → 检索 → 审核 → 人工处置串联。条件不满足的节点跳过；资料不足可暂停，补充并重新准备后继续。没有自定义流程时使用软件默认流程。")}</p>
    {value && defaults.nodes.map(base => { const node = value.nodes.find(item => item.kind === base.kind); return <div key={base.kind} className="enterprise-form-grid"><label><input type="checkbox" aria-label={t("启用{v0}节点", { v0: t(workflowNodeLabels[base.kind]) })} checked={Boolean(node)} disabled={base.kind === 'review'} onChange={event => onChange({ nodes: defaults.nodes.flatMap(item => item.kind === base.kind ? event.target.checked ? [base] : [] : value.nodes.filter(existing => existing.kind === item.kind)) })} />{t(workflowNodeLabels[base.kind])}</label>
      {node && (node.kind === 'collect_information' ? <label className="field"><span>{t("必需信息未确认")}</span><select aria-label={t("资料缺口处理")} value={node.onMissing ?? 'pause'} onChange={event => update(node.kind, { onMissing: event.target.value as 'pause' | 'continue_limited' })}><option value="pause">{t("暂停，补资料后继续")}</option><option value="continue_limited">{t("保留局限继续审核")}</option></select></label> : node.kind !== 'review' ? <label className="field"><span>{t("执行条件")}</span><select aria-label={t("{v0}条件", { v0: t(workflowNodeLabels[node.kind]) })} value={node.when} onChange={event => update(node.kind, { when: event.target.value as ReviewWorkflowNode['when'] })}><option value="always">{t("始终执行")}</option>{node.kind === 'human_risk_disposition' ? <option value="has_high_risk">{t("出现高风险时执行")}</option> : <option value="has_pending_information">{t("存在待确认信息时执行")}</option>}</select></label> : <small>{t("审核节点始终保留。流程完成不表示合同获准签署。")}</small>)}
    </div>; })}
  </section>;
}
