import { useI18n } from './i18n';
import { Calculator, ChevronDown, Info } from 'lucide-react';
import type { ReviewFinding, ReviewResult } from '../../shared/contracts';
import './program-checks.css';

const kinds = { amounts: '金额与付款比例', dates: '日期与付款期限', references: '条款与附件引用', parties: '主体名称与编号一致性' };
const statuses = { completed: '已完成扫描', partial: '部分完成', disabled: '当时已关闭' };
export default function ProgramChecksPanel({ review, onLocate }: { review: ReviewResult; onLocate: (finding: ReviewFinding) => void }) {
  const { t, translateMessage, dateLocale } = useI18n();

  const report = review.programChecks;
  const locateIssue = (issue: NonNullable<ReviewResult['programChecks']>['issues'][number]) => onLocate({ id: issue.id, blockIds: issue.blockIds, quote: issue.quote, title: issue.title, description: issue.description, suggestion: issue.suggestion, category: 'operational', severity: issue.severity, source: 'rule', legalBasis: null, basisStatus: 'unverified', locationStatus: 'matched', citations: [], origin: 'program', checkKey: issue.key, calculation: issue.calculation });
  return <details className="card program-checks-panel" id={`program-checks-${review.id}`}><summary className="pane-heading"><div className="section-heading-left"><Calculator size={17} /><h2>{t("程序核验")}</h2><span className="count-badge">{report ? t("{v0} 项提示", { v0: report.issues.length }) : t("当时未执行")}</span></div><ChevronDown size={14} /></summary><div className="program-checks-body">
    {report ? <><p>{t("以下为本次审核保存的程序核验快照，独立于模型分析。扫描计数不代表合同已通过法律审核。")}</p><div className="program-check-kind-list">{report.checks.map(check => <section key={check.kind}><h3>{t(kinds[check.kind])}</h3><span className={`program-check-status ${check.status}`}>{t(statuses[check.status])}</span><strong>{t("扫描计数")}{check.checkedCount}</strong><ul>{check.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></section>)}</div>{report.issues.length > 0 && <div className="program-check-issues">{report.issues.map(issue => <article key={issue.id}><div><h3>{issue.title}</h3><span>{t("程序核验 ·")}{t(kinds[issue.kind])}</span></div><p>{issue.description}</p>{issue.calculation && <p className="program-calculation"><strong>{t("计算或核对式")}</strong><code>{issue.calculation}</code></p>}{issue.blockIds.length > 0 && <button className="text-button" onClick={() => locateIssue(issue)}>{t("定位核验原文")}</button>}</article>)}</div>}<p className="program-check-engine">{t("执行引擎：")}{report.engineVersion}{t("。程序命中与模型判断分别保留，均需结合原文复核。")}</p></> : <p className="program-check-absent"><Info size={15} />{t("本次历史审核未保存程序核验结果，标记为当时未执行；不会用当前设置补写旧报告。")}</p>}
  </div></details>;
}
