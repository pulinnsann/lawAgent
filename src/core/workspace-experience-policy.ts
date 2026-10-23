import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ReviewContext } from '../shared/contracts';
import type { ExperienceAsset, ExperiencePolicy, ExperienceResolution, ExperienceSnapshot, TaskExperienceRequirement } from '../shared/library';

export const EXPERIENCE_POLICY_VERSION = 'experience-precedence-v1';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const experiencePolicySchema = z.object({
  conflictKey: z.string().trim().max(100).regex(/^[\p{L}\p{N}_.:/-]*$/u),
  domain: z.enum(['business', 'legal_guardrail']), effect: z.enum(['supplement', 'tighten', 'relax']),
  override: z.object({ targetIds: z.array(z.string().uuid()).max(30), reason: z.string().trim().max(2000), targetRevisions: z.record(z.string().uuid(),z.number().int().min(1)).optional() }).strict(),
}).strict().refine(value => value.domain !== 'legal_guardrail' || value.effect !== 'relax', '法律约束不能配置为放宽')
  .refine(value => !value.override.targetIds.length || Boolean(value.conflictKey && value.override.reason), '明确覆盖需填写冲突键和原因')
  .refine(value => new Set(value.override.targetIds).size === value.override.targetIds.length, '覆盖目标不能重复');
export const defaultExperiencePolicy = (): ExperiencePolicy => ({ conflictKey: '', domain: 'business', effect: 'supplement', override: { targetIds: [], reason: '' } });
const rank = { personal: 1, enterprise: 2, project: 3 };
export const applicableLibraryScope = (scope: ExperienceAsset['body']['scope'], context: Pick<ReviewContext, 'contractType' | 'ourPartyRole'> & { projectId?: string | null }) => scope.contractTypes.includes(context.contractType) && scope.partyRoles.includes(context.ourPartyRole) && (scope.level !== 'project' || Boolean(context.projectId) && scope.projectId === context.projectId);
export function resolveExperiencePolicy(assets: ExperienceAsset[], context: Pick<ReviewContext, 'contractType' | 'ourPartyRole'> & { projectId?: string | null; taskRequirements?: TaskExperienceRequirement[] }): ExperienceResolution {
  const requirements = z.array(z.object({ id: z.string().trim().min(1).max(120), conflictKey: z.string().trim().min(1).max(100), content: z.string().trim().min(1).max(4000), effect: z.enum(['supplement', 'tighten', 'relax']) }).strict()).max(30).parse(context.taskRequirements ?? []);
  if (new Set(requirements.map(item => item.id)).size !== requirements.length) throw new Error('任务要求标识不能重复。');
  const candidates: ExperienceSnapshot[] = assets.filter(value => !value.deleted && value.body.state === 'approved' && applicableLibraryScope(value.body.scope, context)).sort((a, b) => a.id.localeCompare(b.id)).map(value => ({ id: value.id, revision: value.revision, body: structuredClone(value.body), contentSha256: digest(value.body) }));
  const result: Omit<ExperienceResolution, 'contentSha256'> = { policyVersion: EXPERIENCE_POLICY_VERSION, selected: [], suppressed: [], conflicts: [], taskRequirements: structuredClone(requirements) };
  const policy = (value: ExperienceSnapshot) => value.body.policy ?? defaultExperiencePolicy();
  const suppress = (value: ExperienceSnapshot, reason: string, ids: string[]) => result.suppressed.push({ experience: value, reason, overriddenBy: ids });
  for(const key of new Set(requirements.map(value=>value.conflictKey))){const tasks=requirements.filter(value=>value.conflictKey===key);if(new Set(tasks.map(value=>`${value.effect}:${value.content}`)).size>1)result.conflicts.push({conflictKey:key,ids:tasks.map(value=>`task:${value.id}`),reason:'同一任务存在多个不同要求，须人工消除矛盾后使用。',requiresHumanReview:true});}
  const groups = new Map<string, ExperienceSnapshot[]>();
  for (const value of candidates) { const key = policy(value).conflictKey; if (!key) result.selected.push(value); else groups.set(key, [...(groups.get(key) ?? []), value]); }
  for (const [key, group] of groups) {
    const guards = group.filter(value => policy(value).domain === 'legal_guardrail');
    const businesses = group.filter(value => policy(value).domain !== 'legal_guardrail');
    result.selected.push(...guards);
    if(guards.length>1&&new Set(guards.map(value=>value.body.content)).size>1)result.conflicts.push({conflictKey:key,ids:guards.map(value=>value.id),reason:'同一冲突键有多份人工标记法律约束；全部保留并交由法律顾问核对，不自动判断哪份具有优先效力。',requiresHumanReview:true});
    const tasks = requirements.filter(value => value.conflictKey === key);
    if (guards.length && (businesses.some(value => policy(value).effect === 'relax') || tasks.some(value => value.effect === 'relax'))) result.conflicts.push({ conflictKey: key, ids: [...guards.map(value => value.id), ...tasks.filter(value => value.effect === 'relax').map(value => `task:${value.id}`)], reason: '存在放宽请求与人工标记法律约束的冲突；法律约束保留，放宽请求须法律顾问独立核验，不能自动据此降低法定义务。', requiresHumanReview: true });
    const eligible = businesses.filter(value => { if (guards.length && policy(value).effect === 'relax') { suppress(value, '放宽经验不能覆盖人工标记的法律约束。', guards.map(item => item.id)); return false; } return true; });
    if (tasks.length) { for (const value of eligible) suppress(value, '同冲突键采用本次任务明确要求；仍须遵守保留的法律约束。', tasks.map(value => `task:${value.id}`)); continue; }
    if (!eligible.length) continue;
    const topRank = Math.max(...eligible.map(value => rank[value.body.scope.level]));
    const top = eligible.filter(value => rank[value.body.scope.level] === topRank);
    for (const value of eligible.filter(value => rank[value.body.scope.level] < topRank)) suppress(value, '同冲突键按项目 > 企业 > 个人的明确范围优先级取用。', top.map(value => value.id));
    if (top.length === 1) { result.selected.push(top[0]); continue; }
    const winners = top.filter(value => top.every(other => other.id === value.id || (policy(value).override.targetIds.includes(other.id)&&policy(value).override.targetRevisions?.[other.id]===other.revision)) && !top.some(other => other.id !== value.id && (policy(other).override.targetIds.includes(value.id)&&policy(other).override.targetRevisions?.[value.id]===value.revision)));
    if (winners.length === 1) { result.selected.push(winners[0]); for (const value of top.filter(value => value.id !== winners[0].id)) suppress(value, `同范围采用人工明确覆盖：${policy(winners[0]).override.reason}`, [winners[0].id]); }
    else { result.conflicts.push({ conflictKey: key, ids: top.map(value => value.id), reason: '同一优先范围的经验存在竞争或循环覆盖；未自动选取，须人工明确覆盖关系或停用冲突版本。', requiresHumanReview: true }); for (const value of top) suppress(value, '同范围冲突尚未解决，不作为生效经验发送。', []); }
  }
  return { ...result, contentSha256: digest(result) };
}
