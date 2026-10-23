import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { interfaceMessages } from './i18n-messages';

export type InterfaceLocale = 'zh' | 'en' | 'th';
export type TranslationParams = Record<string, string | number | boolean | null | undefined>;
export const INTERFACE_LOCALE_STORAGE_KEY = 'law-agent.interface-locale.v1';
export const interfaceLocales: readonly InterfaceLocale[] = ['zh', 'en', 'th'];
export const dateLocales: Record<InterfaceLocale, string> = { zh: 'zh-CN-u-ca-gregory-nu-latn', en: 'en-GB-u-ca-gregory-nu-latn', th: 'th-TH-u-ca-gregory-nu-latn' };
export function isInterfaceLocale(value: unknown): value is InterfaceLocale { return value === 'zh' || value === 'en' || value === 'th'; }
export function translate(locale: InterfaceLocale, key: string, params: TranslationParams = {}): string {
  const message = locale === 'zh' ? key : interfaceMessages[key]?.[locale] ?? key;
  return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name] ?? '') : placeholder);
}
type KnownMessagePattern = { key: string; names: string[]; pattern: RegExp };
let knownReverse: Map<string, string> | undefined;
let knownPatterns: KnownMessagePattern[] | undefined;
function initializeKnownMessages(): void {
  if (knownReverse) return;
  knownReverse = new Map(); knownPatterns = [];
  for (const [key, translations] of Object.entries(interfaceMessages)) {
    for (const text of [key, translations.en, translations.th]) {
      if (!knownReverse.has(text)) knownReverse.set(text, key);
      const names: string[] = []; let expression = ''; let offset = 0;
      for (const match of text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
        expression += text.slice(offset, match.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\\S]*?)';
        names.push(match[1]); offset = match.index! + match[0].length;
      }
      if (names.length && text.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, '').length >= 4) {
        expression += text.slice(offset).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        knownPatterns.push({ key, names, pattern: new RegExp(`^${expression}$`, 'u') });
      }
    }
  }
}
/** Translate only known interface notifications. Unrecognized server text remains verbatim.
 * Exact reverse matches also update a previous notification after a locale change.
 * Parameters are carried unchanged: no model, source text or user field is sent for translation.
 */
export function translateKnownMessage(locale: InterfaceLocale, value: string | null | undefined): string {
  if (!value) return '';
  initializeKnownMessages();
  const key = knownReverse!.get(value);
  if (key !== undefined) return translate(locale, key);
  if (value.length <= 8000) for (const entry of knownPatterns!) {
    const match = entry.pattern.exec(value);
    if (match) return translate(locale, entry.key, Object.fromEntries(entry.names.map((name, index) => [name, match[index + 1]])));
  }
  return value;
}
export function formatInterfaceDate(locale: InterfaceLocale, value: string | number | Date, options: Intl.DateTimeFormatOptions = {}): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(dateLocales[locale], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...options }).format(date);
}
export function formatInterfaceNumber(locale: InterfaceLocale, value: number, options: Intl.NumberFormatOptions = {}): string { return new Intl.NumberFormat(dateLocales[locale], options).format(value); }
export function readInterfaceLocale(storage?: Pick<Storage, 'getItem'>): InterfaceLocale {
  try { const value = (storage ?? (typeof window === 'undefined' ? undefined : window.localStorage))?.getItem(INTERFACE_LOCALE_STORAGE_KEY); return isInterfaceLocale(value) ? value : 'zh'; } catch { return 'zh'; }
}
const defaultValue = {
  locale: 'zh' as InterfaceLocale,
  setLocale: (_locale: InterfaceLocale): void => {},
  t: (key: string, params?: TranslationParams) => translate('zh', key, params),
  translateMessage: (value: string | null | undefined) => translateKnownMessage('zh', value),
  dateLocale: dateLocales.zh,
  formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => formatInterfaceDate('zh', value, options),
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => formatInterfaceNumber('zh', value, options),
};
const I18nContext = createContext(defaultValue);
export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: InterfaceLocale }) {
  const [locale, updateLocale] = useState<InterfaceLocale>(() => initialLocale ?? readInterfaceLocale());
  const setLocale = useCallback((value: InterfaceLocale) => { if (isInterfaceLocale(value)) updateLocale(value); }, []);
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : locale;
    try { localStorage.setItem(INTERFACE_LOCALE_STORAGE_KEY, locale); } catch { /* Interface preference remains usable for this session. */ }
  }, [locale]);
  const value = useMemo(() => ({ locale, setLocale, dateLocale: dateLocales[locale], t: (key: string, params?: TranslationParams) => translate(locale, key, params), translateMessage: (message: string | null | undefined) => translateKnownMessage(locale, message), formatDate: (date: string | number | Date, options?: Intl.DateTimeFormatOptions) => formatInterfaceDate(locale, date, options), formatNumber: (number: number, options?: Intl.NumberFormatOptions) => formatInterfaceNumber(locale, number, options) }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function useI18n() { return useContext(I18nContext); }
