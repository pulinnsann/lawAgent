import panels from './i18n-panels.json';
import app from './i18n-app.json';
import reporting from './i18n-reporting.json';
import alignment from './i18n-alignment.json';
/** UI text only. Contract text, templates, knowledge, source excerpts and model output are never translated here. */
export const interfaceMessages: Record<string, { en: string; th: string }> = { ...panels, ...app, ...reporting, ...alignment };
