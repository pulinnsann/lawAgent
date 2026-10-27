import { useEffect, useRef, useState } from 'react';
import type { ContractAssistantBridge } from '../../shared/contracts';
import type { ResourceKind, ResourceOperation, ResourcePressureLevel, ResourceSnapshot, ResourceWaitReason } from '../../shared/resources';
import { useI18n } from './i18n';

const operations: Record<ResourceOperation, string> = {
  contract_review: '合同审核', local_review: '本地规则审核', contract_generation: '描述生成合同', contract_change: '合同修改',
  reference_translation: '参考译文', report_translation: '报告译文工作区', clause_alignment: '双／三语条款对齐', model_probe: '能力探测',
  connection_test: '测试连接', knowledge_index: '知识库建库', knowledge_search: '知识库检索', document_import: '导入文档',
  document_conversion: 'PDF 文字与 OCR 转换', report_render: '报告生成', document_export: '文档导出', native_pdf: '原生 PDF 导出', maintenance: '本地数据维护',
};
const kinds: Record<ResourceKind, string> = { model: '模型任务', heavy: '文档任务', index: '索引任务' };
const levels: Record<ResourcePressureLevel, string> = { normal: '正常', warning: '内存压力偏高', critical: '内存压力紧张', unknown: '内存压力未知' };
const sources: Record<ResourceSnapshot['pressure']['source'], string> = { macos: 'macOS 系统采样', windows: 'Windows 系统采样', unavailable: '未取得系统采样', test: '合成测试采样' };
const waitReasons: Record<ResourceWaitReason, string> = { active_task: '等待当前任务释放资源', index_cleanup: '等待索引取消并清理', memory_critical: '等待系统内存压力下降', memory_warning: '内存压力偏高，暂缓文档及索引任务', priority: '等待优先任务完成' };
const LIMITATIONS = [
  '仅串行管理已接入的应用任务，不是应用 RSS、系统内存或客户模型显存的硬性上限。',
  '运行中的任务只有在实际清理并释放租约后才让出资源；未知或过期的压力信息按保守串行策略继续。',
];

interface ViewProps { snapshot: ResourceSnapshot | null; loading: boolean; error: string; onRefresh: () => void }
/** Presentation is separate so unavailable/stale system evidence can be checked
 * without a live model, native pressure signal or browser test dependency. */
export function ResourceStatusView({ snapshot, loading, error, onRefresh }: ViewProps) {
  const { t, translateMessage, formatDate, formatNumber } = useI18n();
  const bytes = (value: number | null | undefined) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 ? t('未知') : `${formatNumber(value / 1024 ** 3, { maximumFractionDigits: 2 })} GiB`;
  const level = error ? 'unknown' : snapshot?.pressure.effectiveLevel ?? 'unknown';
  const queued = snapshot?.queued.slice(0, 8) ?? [];
  return <section className="resource-status-panel" aria-label={t('资源与任务状态')}>
    <div className="resource-status-heading"><div><h3>{t('资源与任务状态')}</h3><p>{t('已接入的重任务串行运行，模型任务优先。')}</p></div><button type="button" onClick={onRefresh} disabled={loading} aria-label={t('刷新资源状态')}>{loading ? t('正在刷新') : t('刷新状态')}</button></div>
    {error && <div className="resource-status-error" role="alert"><strong>{t('资源状态更新失败')}</strong><p>{translateMessage(error)}</p>{snapshot && <small>{t('以下保留上次取得的任务信息，当前内存压力暂记未知。')}</small>}</div>}
    {!snapshot ? <p className="resource-status-empty" role="status">{loading ? t('正在读取资源状态…') : t('暂未取得资源状态。')}</p> : <>
      <div className="resource-pressure-row"><strong className={`resource-pressure resource-pressure-${level}`}>{t(levels[level])}</strong><span>{t(sources[snapshot.pressure.source] ?? '未取得系统采样')}</span>{snapshot.closed && <strong>{t('本地服务正在关闭')}</strong>}</div>
      <p className="resource-status-sample">{t('采样时间：{time}', { time: formatDate(snapshot.pressure.observedAt) })}{snapshot.pressure.stale && <strong>{t('采样已过期，按未知压力处理。')}</strong>}</p>
      <p className="resource-status-memory">{t('系统可用内存：{available}；总内存：{total}', { available: bytes(snapshot.pressure.availableBytes), total: bytes(snapshot.pressure.totalBytes) })}</p>
      <div className="resource-status-columns"><div><h4>{t('正在运行')}</h4>{snapshot.active ? <article className="resource-active-task"><strong>{t(operations[snapshot.active.operation] ?? '其他任务')}</strong><span>{t(kinds[snapshot.active.kind] ?? '其他任务')}</span><small>{t('开始于 {time}', { time: formatDate(snapshot.active.startedAt) })}</small>{snapshot.active.cancellationRequested && <p>{t('已请求取消，正在等待实际清理完成。')}</p>}</article> : <p className="resource-status-empty">{t('当前没有占用资源的任务。')}</p>}</div>
        <div><h4>{t('排队任务：{count} / {max}', { count: snapshot.queued.length, max: snapshot.maxQueue })}</h4>{queued.length ? <ol className="resource-queued-tasks">{queued.map(task => <li key={task.id}><strong>{t(operations[task.operation] ?? '其他任务')}</strong><span>{t(waitReasons[task.waitReason] ?? '等待当前任务释放资源')}</span></li>)}</ol> : <p className="resource-status-empty">{t('没有排队任务。')}</p>}{snapshot.queued.length > queued.length && <p>{t('另有 {count} 项任务等待。', { count: snapshot.queued.length - queued.length })}</p>}</div></div>
    </>}
    <div className="resource-status-policy"><p>{t('系统采样用于安排后续任务，不会调节客户模型的权重、上下文或显存配置。')}</p>{(snapshot?.limitations ?? LIMITATIONS).map((line, index) => <p key={index}>{translateMessage(line)}</p>)}</div>
  </section>;
}

export default function ResourceStatusPanel({ bridge }: { bridge: ContractAssistantBridge }) {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false; let inFlight = false;
    setSnapshot(null); setError('');
    const read = async () => {
      if (cancelled || inFlight) return; inFlight = true; setLoading(true);
      try {
        const value = await bridge.runWorkspaceCommand({ action: 'workspace.resources' }) as ResourceSnapshot;
        if (!value || value.policy !== 'serial-model-priority' || !value.pressure || !(value.pressure.effectiveLevel in levels) || !(value.pressure.source in sources) || typeof value.pressure.stale !== 'boolean' || typeof value.pressure.observedAt !== 'string' || !Array.isArray(value.queued) || !value.queued.every(task => task && typeof task.id === 'string') || !Array.isArray(value.limitations) || !value.limitations.every(line => typeof line === 'string')) throw new Error('资源状态响应无效，请刷新后重试。');
        if (!cancelled) { setSnapshot(value); setError(''); }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { inFlight = false; if (!cancelled) setLoading(false); }
    };
    refresh.current = () => { void read(); }; void read(); const timer = setInterval(() => { void read(); }, 2500);
    return () => { cancelled = true; clearInterval(timer); refresh.current = () => {}; };
  }, [bridge]);
  return <ResourceStatusView snapshot={snapshot} loading={loading} error={error} onRefresh={() => refresh.current()} />;
}
