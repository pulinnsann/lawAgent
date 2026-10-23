import type { ContractDraft } from './generation';
import type { FindingCategory, ReviewContext, ReviewFinding, Severity } from './contracts';

export type LibraryState = 'candidate' | 'approved' | 'disabled';
export interface LibraryScope {
  level: 'personal' | 'enterprise' | 'project';
  /** Project IDs must be supplied by the caller and match exactly. */
  projectId: string | null;
  contractTypes: ReviewContext['contractType'][];
  partyRoles: ReviewContext['ourPartyRole'][];
}
export interface LibrarySource {
  kind: 'manual' | 'review' | 'finding' | 'change';
  reviewId: string | null; findingId: string | null; changeId: string | null;
  documentId: string | null; contentSha256: string; excerpt: string;
}
export interface ExperienceBody {
  name: string; kind: 'preference' | 'rule' | 'clause'; content: string;
  scope: LibraryScope; state: LibraryState; source: LibrarySource;
  reason: string; actorLabel: string; approvedAt: string | null;
  /** Deterministic identifier for repeated accepted edits; never grants approval. */
  suggestionKey?: string;
  /** Absent on legacy records: independent supplementary business material. */
  policy?: ExperiencePolicy;
}
export interface LibraryAsset<T = unknown> {
  id: string; kind: string; revision: number; body: T; deleted: boolean; createdAt: string; updatedAt: string;
}
export type ExperienceAsset = LibraryAsset<ExperienceBody>;
export interface ExperienceSnapshot { id: string; revision: number; body: ExperienceBody; contentSha256: string }
export interface TemplateField { key: string; label: string; required: boolean }
export interface TemplateBody {
  name: string; language: 'zh' | 'en' | 'th'; scope: LibraryScope;
  title: string; paragraphs: string[]; fields: TemplateField[];
  state: LibraryState; reason: string; actorLabel: string; approvedAt: string | null;
  source: { documentId: string; fileSha256: string; paragraphsSha256: string; name: string; importedAt: string };
}
export type TemplateAsset = LibraryAsset<TemplateBody>;
export interface TemplateRenderInput {
  templateId: string; expectedRevision: number; fields: Record<string, string>;
  clauseIds: string[]; projectId?: string | null; actorLabel: string;
  contractType?: ReviewContext['contractType']; ourPartyRole?: ReviewContext['ourPartyRole'];
}
export interface TemplateSourceSnapshot {
  templateId: string; revision: number; contentSha256: string; source: TemplateBody['source'];
  clauses: ExperienceSnapshot[]; fieldValuesSha256: string; assembledAt: string;
}
export interface TemplateRenderResult {
  docxBase64: string; filename: string; sourceSnapshot: TemplateSourceSnapshot;
  missingInformation: string[]; draft: ContractDraft;
}
export interface AnnotationBody {
  reviewId: string; documentId: string; findingId: string | null;
  title: string; category: FindingCategory; severity: Severity; description: string; suggestion: string;
  blockIds: string[]; quote: string; reason: string; actorLabel: string;
  state: 'active' | 'disabled'; originalReviewSha256: string;
}
export type AnnotationAsset = LibraryAsset<AnnotationBody>;
export interface EffectiveReviewFinding {
  finding: ReviewFinding; originalFinding: ReviewFinding | null;
  annotation: AnnotationAsset | null;
}
export const defaultLibraryScope = (): LibraryScope => ({ level: 'personal', projectId: null, contractTypes: ['procurement', 'service', 'other'], partyRoles: ['buyer', 'seller', 'service_provider', 'service_recipient', 'other'] });

/** These are human supplied business constraints, never privileged instructions. */
export interface TaskExperienceRequirement { id: string; conflictKey: string; content: string; effect: 'supplement' | 'tighten' | 'relax' }
export interface ExperiencePolicy {
  conflictKey: string;
  domain: 'business' | 'legal_guardrail';
  effect: 'supplement' | 'tighten' | 'relax';
  override: { targetIds: string[]; reason: string; targetRevisions?: Record<string,number> };
}
export interface ExperienceSuppression { experience: ExperienceSnapshot; reason: string; overriddenBy: string[] }
export interface ExperienceConflict { conflictKey: string; ids: string[]; reason: string; requiresHumanReview: true }
export interface ExperienceResolution {
  policyVersion: string; selected: ExperienceSnapshot[]; suppressed: ExperienceSuppression[];
  conflicts: ExperienceConflict[]; taskRequirements: TaskExperienceRequirement[]; contentSha256: string;
}
export interface AdvisorPromptBody {
  name: string; content: string; scope: LibraryScope; state: LibraryState;
  reason: string; actorLabel: string; approvedAt: string | null;
  /** Human written source label, not a claim of verified professional identity. */
  advisorLabel: string;
  regressionId: string | null;
}
export type AdvisorPromptAsset = LibraryAsset<AdvisorPromptBody>;
export interface ExpectedAdvisorRisk { key: string; terms: string[]; category: FindingCategory; severity: Severity }
export interface AdvisorSampleBody {
  name: string; packageId: string; packageRevision: number; packageContentSha256: string;
  text: string; expectedRisks: ExpectedAdvisorRisk[];
  observedRisks: Array<{ title: string; description: string; category: FindingCategory; severity: Severity }>;
  actorLabel: string; reason: string; source: string;
}
export type AdvisorSampleAsset = LibraryAsset<AdvisorSampleBody>;
export interface AdvisorRegressionBody {
  packageId: string; packageRevision: number; packageContentSha256: string;
  samples: Array<{ id: string; revision: number; contentSha256: string; checks: Array<{ key: string; passed: boolean; reason: string }>; programReport: import('./assurance').ProgramCheckReport }>;
  passed: boolean; legalCorrectnessCertified: false; createdAt: string; actorLabel: string;
  humanReview: { status: 'pending' | 'accepted' | 'rejected'; reason: string; actorLabel: string; reviewedAt: string | null };
}
export type AdvisorRegressionAsset = LibraryAsset<AdvisorRegressionBody>;
export interface AdvisorPromptSnapshot { id: string; revision: number; body: AdvisorPromptBody; contentSha256: string; regression: AdvisorRegressionBody }
