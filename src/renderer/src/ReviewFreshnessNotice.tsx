import { useI18n } from './i18n';
import type { ReviewFreshness } from '../../shared/review-completion';
export default function ReviewFreshnessNotice({ value }: { value: ReviewFreshness }) {
  const { t, translateMessage, dateLocale } = useI18n();

  return <div className={`notice ${value.status === 'updates_available' ? 'info' : ''}`} role="status"><div><strong>{value.status === 'updates_available' ? t("依赖记录已有更新，建议核对并重审") : value.status === 'unknown' ? t("部分依赖版本未知，不能确认报告仍适用") : t("本工作区暂未发现依赖更新")}</strong>
    {value.reasons.map((reason, index) => <p key={index}>{translateMessage(reason.message)}</p>)}
    <details><summary>{t("比较范围 ·")}{new Date(value.checkedAt).toLocaleString(dateLocale)}</summary>{value.limitations.map((item, index) => <p key={index}>{item}</p>)}</details></div></div>;
}
