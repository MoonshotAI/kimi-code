/**
 * Browser i18n factory — pure JavaScript, no native dependencies.
 *
 * Uses the same logic as the Rust engine (mirrored in `core.ts`), so
 * translations are identical across Node.js and browser environments.
 *
 * Includes:
 * - `localStorage` persistence for locale preference
 * - `navigator.language` auto-detection
 * - Optional `useLocale()` React hook for React-based apps
 */

import type { Locale, MessageValue, TranslationKey, I18nInstance } from './types.js';
import { detectLocaleWeb } from './detect.js';
import { translate } from './core.js';

// ── Factory ──────────────────────────────────────────────────────────────────

export interface CreateI18nWebOptions {
  /** Initial locale. Defaults to browser-based detection. */
  initialLocale?: Locale;
  /** localStorage key for persisting locale preference. */
  storageKey?: string;
  /** Skip auto-detection. */
  noDetect?: boolean;
}

/**
 * Create a browser-side i18n instance backed by pure JavaScript.
 *
 * @param messages - Locale message trees, e.g. `{ en: {...}, zh: {...} }`.
 * @param options - Optional configuration.
 *
 * @example
 * ```tsx
 * import { createI18n } from '@moonshot-ai/i18n-shared/web';
 * import en from './locales/en';
 * import zh from './locales/zh';
 *
 * const i18n = createI18n({ en, zh }, { storageKey: 'myapp.locale' });
 * export const { t, setLocale, getLocale, useLocale } = i18n;
 * ```
 */
export function createI18n<M extends Record<Locale, MessageValue>>(
  messages: M,
  options: CreateI18nWebOptions = {},
): I18nInstance<M> & {
  /** React hook for reactive locale access. */
  useLocale: () => { locale: Locale; set: (l: Locale) => void };
  /** Subscribe to locale changes. Returns an unsubscribe function. */
  subscribe: (fn: (locale: Locale) => void) => () => void;
} {
  const storageKey = options.storageKey;

  let currentLocale: Locale = options.noDetect
    ? 'en'
    : (options.initialLocale ?? detectLocaleWeb(storageKey));

  // ── Reactive subscriber list (for React hooks) ───────────────────────────

  type Listener = (locale: Locale) => void;
  const listeners = new Set<Listener>();

  function subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function notifyAll(): void {
    for (const fn of listeners) fn(currentLocale);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  function t(
    key: TranslationKey<M['en']> | (string & {}),
    params?: Record<string, string | number>,
  ): string {
    return translate(messages[currentLocale], messages.en, key as string, params);
  }

  function setLocale(locale: Locale): void {
    if (locale in messages && locale !== currentLocale) {
      currentLocale = locale;
      // Persist to localStorage
      if (storageKey) {
        try {
          if (locale === 'en') {
            // Don't store 'en' — treat it as the default (unset) state,
            // matching the existing vis/kimi-inspect convention.
            localStorage.removeItem(storageKey);
          } else {
            localStorage.setItem(storageKey, locale);
          }
        } catch {
          /* localStorage may be unavailable */
        }
      }
      notifyAll();
    }
  }

  function getLocale(): Locale {
    return currentLocale;
  }

  function getMessages(): M {
    return messages;
  }

  // ── React hook ───────────────────────────────────────────────────────────
  //
  // Lazily import React's hooks so this module doesn't hard-depend on React
  // (non-React apps like vanilla TS can still use `createI18n`).

  function useLocale(): { locale: Locale; set: (l: Locale) => void } {
    // Dynamic hook resolution — works when React is available.
    const React = (globalThis as any).React;
    if (!React || !React.useState || !React.useEffect || !React.useCallback) {
      // Non-React environment: return a static snapshot.
      return { locale: currentLocale, set: setLocale };
    }

    const { useState, useEffect, useCallback } = React;
    const [locale, setLocaleState] = useState(currentLocale);

    const set = useCallback((l: Locale) => {
      setLocale(l);
      setLocaleState(l);
    }, []);

    useEffect(() => {
      setLocaleState(currentLocale);
      return subscribe(setLocaleState);
    }, []);

    return { locale, set };
  }

  return { t, setLocale, getLocale, getMessages, useLocale, subscribe };
}
