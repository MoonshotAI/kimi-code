/**
 * VS Code webview i18n — backed by the shared pure-JS engine.
 *
 * Uses `createI18nWeb` from `@moonshot-ai/i18n-shared/web`, which mirrors the
 * Rust engine's logic exactly. Includes:
 * - `navigator.language` auto-detection
 * - `localStorage` persistence for locale preference
 * - Type-safe `TranslationKey` derived from the English locale data
 */

import { createI18n } from '@moonshot-ai/i18n-shared/web';
import type { Locale, TranslationKey } from '@moonshot-ai/i18n-shared';

import en from './locales/en';
import zh from './locales/zh';

export type { Locale };
export type TranslationKey = TranslationKey<typeof en>;

const STORAGE_KEY = 'kimi-vscode.locale';

const i18n = createI18n(
  { en, zh },
  { storageKey: STORAGE_KEY },
);

export const t = i18n.t;
export const setLocale = i18n.setLocale;
export const getLocale = i18n.getLocale;
export const useLocale = i18n.useLocale;
