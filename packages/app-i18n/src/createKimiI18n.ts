import { createI18n, type I18n } from 'vue-i18n';
import en from './locales/en';
import zh from './locales/zh';

export const messages = { en, zh };

const LOCALE_STORAGE_KEY = 'kimi-locale';

export function detect(): 'en' | 'zh' {
  let stored: string | null = null;
  try {
    stored = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  if (stored === 'en' || stored === 'zh') return stored;
  return globalThis.navigator?.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export type KimiI18n = I18n<typeof messages, {}, {}, string, false>;

export function createKimiI18n(opts: { locale?: string }): KimiI18n {
  const locale = opts.locale ?? detect();
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en',
    messages,
    warnHtmlMessage: false,
  });
}
