/**
 * kimi-inspect i18n — backed by the shared pure-JS engine.
 *
 * Uses `createI18n` from `@moonshot-ai/i18n-shared/web`, which mirrors the
 * Rust engine's logic exactly. Includes:
 * - `navigator.language` auto-detection
 * - `localStorage` persistence (`kimi-inspect.locale`)
 * - Type-safe `TranslationKey` derived from the English locale data
 * - React `useLocale()` hook via `subscribe`
 */

import { useCallback, useEffect, useState } from 'react';
import { createI18n } from '@moonshot-ai/i18n-shared/web';
import type { Locale, TranslationKey } from '@moonshot-ai/i18n-shared';

import en from './locales/en';
import zh from './locales/zh';

export type { Locale };
export type TranslationKey = TranslationKey<typeof en>;

const i18n = createI18n(
  { en, zh },
  { storageKey: 'kimi-inspect.locale' },
);

export const t = i18n.t;
export const setLocale = i18n.setLocale;
export const getLocale = i18n.getLocale;

export function useLocale(): {
  locale: Locale;
  set: (l: Locale) => void;
} {
  const [locale, setLocaleState] = useState<Locale>(i18n.getLocale());

  const set = useCallback((l: Locale) => {
    i18n.setLocale(l);
  }, []);

  useEffect(() => {
    return i18n.subscribe(setLocaleState);
  }, []);

  return { locale, set };
}
