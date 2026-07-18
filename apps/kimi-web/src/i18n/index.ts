import { createI18n } from 'vue-i18n';
import { detectLocaleWeb } from '@moonshot-ai/i18n-shared';
import { messages } from './locales';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../lib/storage';

export const availableLocales = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
] as const;

export type LocaleCode = (typeof availableLocales)[number]['code'];

// Use the shared locale detection (localStorage + navigator.language),
// unified across all Kimi apps.
function detect(): LocaleCode {
  return detectLocaleWeb(STORAGE_KEYS.locale);
}

export const i18n = createI18n({
  legacy: false,
  locale: detect(),
  fallbackLocale: 'en',
  messages,
});

export function setLocale(l: LocaleCode): void {
  i18n.global.locale.value = l;
  // Persist using the same storage key the shared detector reads.
  if (l === 'en') {
    safeSetString(STORAGE_KEYS.locale, '');
  } else {
    safeSetString(STORAGE_KEYS.locale, l);
  }
}

export default i18n;
