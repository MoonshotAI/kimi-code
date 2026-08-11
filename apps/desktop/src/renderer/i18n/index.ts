import { createKimiI18n, detect } from '@moonshot-ai/app-i18n';
import { safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';

export const availableLocales = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '简体中文' },
] as const;

export type LocaleCode = (typeof availableLocales)[number]['code'];

// Single app-wide i18n instance, created through the shared app-i18n factory so
// the locale/messages live in one place. Consumers (`useKimiWebClient`, tool
// meta, event projectors, …) import this same instance, so `setLocale` mutates
// the translator the whole tree reads from.
export const i18n = createKimiI18n({ locale: detect() });

export function setLocale(l: LocaleCode): void {
  i18n.global.locale.value = l;
  safeSetString(STORAGE_KEYS.locale, l);
}

export default i18n;
