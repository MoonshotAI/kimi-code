import { createI18n, type I18n } from 'vue-i18n';
import en from './locales/en';
import zh from './locales/zh';

export const messages = { en, zh };

// Mirrors `STORAGE_KEYS.locale` in apps/web so the persisted choice is read
// back on boot without app-i18n taking a dependency on the host app.
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

// Composition-mode (`legacy: false`) i18n instance carrying our messages. Kept
// precise (a subtype of the bare `I18n`) so `.global` is a `Composer` — settable
// `locale.value` and callable `t` — instead of the `Composer | VueI18n` union
// the default-`Legacy` `I18n` would expose.
export type KimiI18n = I18n<typeof messages, {}, {}, string, false>;

export function createKimiI18n(opts: { locale?: string }): KimiI18n {
  const locale = opts.locale ?? detect();
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en',
    messages,
  });
}
