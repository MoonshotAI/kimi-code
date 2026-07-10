import { createKimiI18n, detect } from '@moonshot-ai/web-i18n';
import { safeSetString, STORAGE_KEYS } from '../lib/storage';

export const availableLocales = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
] as const;

export type LocaleCode = (typeof availableLocales)[number]['code'];

// Single app-wide i18n instance, created through the shared web-i18n factory so
// the locale/messages live in one place. Consumers (`useKimiWebClient`, tool
// meta, event projectors, …) import this same instance, so `setLocale` mutates
// the translator the whole tree reads from.
export const i18n = createKimiI18n({ locale: detect() });

export function setLocale(l: LocaleCode): void {
  i18n.global.locale.value = l;
  safeSetString(STORAGE_KEYS.locale, l);
}

export default i18n;
