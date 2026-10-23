import type { ContractDetail, FindingCategory, ReviewContext, Severity } from './contracts';
import type { ReviewWorkflowDefinition } from './review-completion';

export interface ProgramCheckOptions { amounts: boolean; dates: boolean; references: boolean; parties?: boolean }
export interface BusinessCalendar {
  name: string; validFrom: string; validTo: string;
  weekendDays: number[]; holidays: string[]; workingDays: string[];
}
export interface EnterpriseRule {
  key: string; name: string; enabled: boolean;
  kind: 'required_topic' | 'flag_phrase'; terms: string[];
  category: FindingCategory; severity: Severity; guidance: string;
  conditions?: {
    contractTypes?: ReviewContext['contractType'][]; partyRoles?: ReviewContext['ourPartyRole'][];
    triggerMode?: 'any' | 'all'; triggerTerms?: string[]; excludeTerms?: string[];
    validFrom?: string; validTo?: string;
  };
  basis?: { title: string; source: string; description: string };
}
export interface EnterpriseStandardContent {
  name: string; description: string;
  contractTypes: ReviewContext['contractType'][];
  partyRoles: ReviewContext['ourPartyRole'][];
  rules: EnterpriseRule[];
  checks: ProgramCheckOptions;
  thresholds: { maxPrepaymentPercent: number | null; maxPaymentDays: number | null };
  workflow: { runEnterpriseRules: boolean; highRiskHandling: 'manual_review' | 'escalate'; plan?: ReviewWorkflowDefinition };
  calendar?: BusinessCalendar;
}
export interface EnterpriseStandardSnapshot {
  id: string; standardId: string; versionNo: number; content: EnterpriseStandardContent;
  contentSha256: string; publishedAt: string; publishedBy: string;
}
export interface EnterpriseStandardSummary {
  id: string; name: string; revision: number;
  versions: Array<Omit<EnterpriseStandardSnapshot, 'content'>>;
}
export interface EnterpriseStandardProfile {
  id: string; revision: number; draft: EnterpriseStandardContent; versions: EnterpriseStandardSnapshot[];
}
export interface SaveEnterpriseStandardInput { standardId?: string; expectedRevision: number; content: EnterpriseStandardContent }
export interface PublishEnterpriseStandardInput { standardId: string; expectedRevision: number; publishedBy: string }

export type ProgramCheckKind = 'amounts' | 'dates' | 'references' | 'parties';
export interface ProgramCheckIssue {
  id: string; key: string; kind: ProgramCheckKind;
  blockIds: string[]; quote: string; title: string; description: string; suggestion: string;
  severity: Severity; calculation: string | null;
}
export interface ProgramCheckReport {
  engineVersion: string;
  checks: Array<{ kind: ProgramCheckKind; status: 'completed' | 'partial' | 'disabled'; checkedCount: number; limitations: string[] }>;
  issues: ProgramCheckIssue[];
}
export interface ProgramCheckInput {
  checks: ProgramCheckOptions;
  thresholds: EnterpriseStandardContent['thresholds'];
  calendar?: BusinessCalendar;
}
export type ProgramCheckRunner = (document: Pick<ContractDetail, 'blocks' | 'partial'>, input: ProgramCheckInput, signal?: AbortSignal) => ProgramCheckReport;

export type RiskDispositionStatus = 'unreviewed' | 'confirmed' | 'needs_information' | 'escalated' | 'business_accepted' | 'fixed' | 'false_positive';
export interface RiskDispositionEvent {
  id: string; reviewId: string; findingId: string; status: RiskDispositionStatus;
  reason: string; actorLabel: string; createdAt: string;
}
export interface RiskDispositionWorkspace {
  reviewId: string; revision: number; events: RiskDispositionEvent[];
}
export interface SaveRiskDispositionInput {
  reviewId: string; findingId: string; expectedRevision: number;
  status: RiskDispositionStatus; reason: string; actorLabel: string;
}

export function defaultEnterpriseStandard(): EnterpriseStandardContent {
  return { name: '', description: '', contractTypes: ['procurement', 'service', 'other'],
    partyRoles: ['buyer', 'seller', 'service_provider', 'service_recipient', 'other'], rules: [],
    checks: { amounts: true, dates: true, references: true, parties: true },
    thresholds: { maxPrepaymentPercent: null, maxPaymentDays: null },
    workflow: { runEnterpriseRules: true, highRiskHandling: 'manual_review' } };
}

/** Model input contains only the enabled company attention rules. The hash
 * identifies the full frozen version stored with the review, not this view. */
export function enterpriseStandardModelContext(snapshot?: EnterpriseStandardSnapshot) {
  if (!snapshot) return null;
  const content = snapshot.content;
  return { versionId: snapshot.id, standardId: snapshot.standardId, versionNo: snapshot.versionNo,
    name: content.name, description: content.description, contentSha256: snapshot.contentSha256,
    applicableContractTypes: content.contractTypes, applicablePartyRoles: content.partyRoles,
    enabledRules: content.workflow.runEnterpriseRules ? content.rules.filter(rule => rule.enabled) : [],
    programChecks: content.checks,
    ...(content.calendar && content.checks.dates ? { businessCalendar: content.calendar } : {}),
    businessThresholds: {
      maxPrepaymentPercent: content.checks.amounts ? content.thresholds.maxPrepaymentPercent : null,
      maxPaymentDays: content.checks.dates ? content.thresholds.maxPaymentDays : null,
    },
    highRiskHandling: content.workflow.highRiskHandling,
  };
}
