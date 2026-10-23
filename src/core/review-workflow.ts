import { z } from 'zod';
import type { ReviewWorkflowDefinition } from '../shared/review-completion';

const kinds = ['collect_information', 'program_checks', 'retrieve_sources', 'review', 'human_risk_disposition'] as const;
/** Finite ordered branches: no executable expressions, cycles, or user scripts.
 * Absence is significant: legacy published standards must retain their hash. */
export const reviewWorkflowSchema = z.object({ nodes: z.array(z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/u), kind: z.enum(kinds),
  when: z.enum(['always', 'has_pending_information', 'has_high_risk']),
  onMissing: z.enum(['pause', 'continue_limited']).optional(),
}).strict()).min(1).max(5) }).strict().superRefine((plan, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message });
  if (new Set(plan.nodes.map(node => node.id)).size !== plan.nodes.length || new Set(plan.nodes.map(node => node.kind)).size !== plan.nodes.length) invalid('节点标识和类型均不可重复。');
  if (plan.nodes.filter(node => node.kind === 'review').length !== 1) invalid('必须恰好包含一个合同审核节点。');
  if (plan.nodes.some((node, i) => i > 0 && kinds.indexOf(node.kind) <= kinds.indexOf(plan.nodes[i - 1].kind))) invalid('节点必须按资料、程序核验、检索、审核、人工处置顺序排列。');
  for (const node of plan.nodes) {
    if (node.kind === 'collect_information' || node.kind === 'review') { if (node.when !== 'always') invalid('资料收集和审核节点不能设置条件跳过。'); }
    else if (node.kind === 'human_risk_disposition') { if (node.when === 'has_pending_information') invalid('人工处置条件仅支持始终执行或出现高风险。'); }
    else if (node.when === 'has_high_risk') invalid('审核前的节点不能按尚未生成的高风险判断。');
    if (node.onMissing && node.kind !== 'collect_information') invalid('仅资料收集节点接受缺资料处理方式。');
  }
});
export function normalizeReviewWorkflow(payload: unknown): ReviewWorkflowDefinition {
  const result = reviewWorkflowSchema.safeParse(payload);
  if (!result.success) throw new Error(`审核流程无效：${result.error.issues.map(issue => issue.message).slice(0, 4).join('；')}`);
  return result.data;
}
