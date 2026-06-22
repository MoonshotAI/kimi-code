import { createI18n } from 'vue-i18n';
import { messages } from './locales';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../lib/storage';

export const availableLocales = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
] as const;

export type LocaleCode = (typeof availableLocales)[number]['code'];

function detect(): LocaleCode {
  const stored = safeGetString(STORAGE_KEYS.locale);
  if (stored === 'en' || stored === 'zh') return stored;
  return globalThis.navigator?.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export const i18n = createI18n({
  legacy: false,
  locale: detect(),
  fallbackLocale: 'en',
  messages,
});

export function setLocale(l: LocaleCode): void {
  i18n.global.locale.value = l;
  safeSetString(STORAGE_KEYS.locale, l);
}

export default i18n;
