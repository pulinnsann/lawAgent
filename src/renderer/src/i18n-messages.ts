import panels from './i18n-panels.json';
import app from './i18n-app.json';
import reporting from './i18n-reporting.json';
import alignment from './i18n-alignment.json';
import resources from './i18n-resources.json';
import licensing from './i18n-license.json';
import diagnostics from './i18n-diagnostics.json';
import lawyerMain from './copy-lawyer-main.json';
import lawyerSetup from './copy-lawyer-setup.json';
import lawyerLicense from './copy-lawyer-license.json';
import lawyerCommon from './copy-lawyer-common.json';
export type LawyerCopy = { zh: string; en: string; th: string };
/** Stable source keys remain intact. These are presentation-only wordings,
 * never replacements inside contracts, evidence, templates or saved reports. */
export const lawyerInterfaceMessages: Record<string, LawyerCopy> = { ...lawyerMain, ...lawyerSetup, ...lawyerLicense, ...lawyerCommon };
/** UI text only. Contract text, templates, knowledge, source excerpts and model output are never translated here. */
const originalMessages: Record<string, { en: string; th: string }> = { ...panels, ...app, ...reporting, ...alignment, ...resources, ...licensing, ...diagnostics };
// New disclosure headings participate in source-key coverage. Existing
// translations stay available so stored notifications can still be resolved.
export const interfaceMessages: Record<string, { en: string; th: string }> = {
  ...Object.fromEntries(Object.entries(lawyerInterfaceMessages).map(([key, value]) => [key, { en: value.en, th: value.th }])),
  ...originalMessages,
};
