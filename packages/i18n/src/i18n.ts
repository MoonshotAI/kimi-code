import type { Locale, MessageValue } from '@moonshot-ai/i18n-shared/types';
import { interpolate } from '@moonshot-ai/i18n-shared/core';

export type { Locale } from '@moonshot-ai/i18n-shared/types';

type Join<K, P> = K extends string | number
  ? P extends string | number
    ? `${K}.${P}`
    : never
  : never;

type Paths<T> = T extends MessageValue
  ? T extends string
    ? never
    : {
        [K in keyof T]-?: K extends string | number
          ? Join<K, Paths<T[K]>> | K
          : never;
      }[keyof T]
  : never;

export type TranslationKey = Paths<typeof import('./locales/en').default>;

import { en } from './locales/en';
import { zh } from './locales/zh';

// ── Pre-computed flat lookup maps ───────────────────────────────────────────
// Converts nested message trees to flat Map<dotPath, string> at module init,
// turning O(depth) tree traversal into O(1) Map.get for the JS fallback path.

function flattenMessages(obj: object, prefix = ''): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      map.set(fullKey, value);
    } else if (typeof value === 'object' && value !== null) {
      for (const [k, v] of flattenMessages(value as object, fullKey)) {
        map.set(k, v);
      }
    }
  }
  return map;
}

const flatMessages: Record<Locale, Map<string, string>> = {
  en: flattenMessages(en),
  zh: flattenMessages(zh),
};

// ── Optional native Rust engine ─────────────────────────────────────────────
// The Rust engine (`@moonshot-ai/kimi-native-tools`) provides a faster path
// via napi-rs. When unavailable (e.g. in a browser or SEA binary), we fall
// back to the pure-JS implementation transparently.

interface NativeModule {
  nativeTranslateCached?: (
    localeJson: string,
    fallbackJson: string,
    key: string,
    params: Record<string, string> | null | undefined,
  ) => string;
  nativeTranslate: (
    localeJson: string,
    fallbackJson: string,
    key: string,
    params: Record<string, string> | null | undefined,
  ) => string;
  nativeTranslateClearCache?: () => void;
}

// Load native module lazily on first use (not at module init) to respect
// KIMI_I18N_FORCE_JS env var set during test setup. After first resolution,
// subsequent calls are a single `!== undefined` check.
function loadNativeImpl(): NativeModule | null {
  if (process.env['KIMI_I18N_FORCE_JS']) {
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@moonshot-ai/kimi-native-tools') as NativeModule;
    if (typeof mod.nativeTranslateCached !== 'function' && typeof mod.nativeTranslate !== 'function') {
      return null;
    }
    return mod;
  } catch {
    return null;
  }
}

let _native: NativeModule | null | undefined; // undefined = not yet resolved

function getNative(): NativeModule | null {
  if (_native !== undefined) return _native;
  _native = loadNativeImpl();
  return _native;
}

// ── Eager JSON pre-serialization ────────────────────────────────────────────
// Only 2 locales exist, so pre-serialize both at module init to avoid lazy
// serialization cost on first t() call after locale switch.

const localeJsonMap: Record<Locale, string> = {
  en: JSON.stringify(en),
  zh: JSON.stringify(zh),
};

// ── Locale detection ────────────────────────────────────────────────────────

let currentLocale: Locale;

function detectLocale(): Locale {
  const envLang = process.env['KIMI_LANG'];
  if (envLang === 'zh' || envLang?.startsWith('zh')) {
    return 'zh';
  }
  if (envLang === 'en' || envLang?.startsWith('en')) {
    return 'en';
  }
  return 'en';
}

currentLocale = detectLocale();

export function setLocale(locale: Locale): void {
  if (locale === 'en' || locale === 'zh') {
    currentLocale = locale;
    // Invalidate the Rust-side cache so stale parsed JSON is evicted.
    getNative()?.nativeTranslateClearCache?.();
  }
}

export function getLocale(): Locale {
  return currentLocale;
}

export type Engine = 'rust' | 'js';

/**
 * Returns whether the native Rust engine is active, or the pure-JS fallback.
 *
 * - `'rust'` — `@moonshot-ai/kimi-native-tools` napi module loaded successfully
 * - `'js'`   — napi module unavailable, using pure-JS translation
 */
export function getEngine(): Engine {
  return getNative() ? 'rust' : 'js';
}

// ── Optimized params conversion ─────────────────────────────────────────────
// Skip Object.fromEntries/entries/map when all values are already strings.

function toStringParams(params: Record<string, string | number>): Record<string, string> {
  let allStrings = true;
  for (const v of Object.values(params)) {
    if (typeof v !== 'string') { allStrings = false; break; }
  }
  if (allStrings) return params as Record<string, string>;
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
}

// ── Pure-JS fallback (flat map) ─────────────────────────────────────────────

function translatePure(key: string, params?: Record<string, string | number>): string {
  const message = flatMessages[currentLocale].get(key) ?? flatMessages.en.get(key);
  if (message === undefined) {
    return key;
  }
  return params ? interpolate(message, params) : message;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function t(
  key: TranslationKey | (string & {}),
  params?: Record<string, string | number>,
): string {
  const native = getNative();
  if (native) {
    // Use the Rust native engine with pre-serialized JSON.
    const stringParams = params ? toStringParams(params) : undefined;

    if (native.nativeTranslateCached) {
      return native.nativeTranslateCached(
        localeJsonMap[currentLocale],
        localeJsonMap.en,
        key,
        stringParams,
      );
    }
    return native.nativeTranslate(
      localeJsonMap[currentLocale],
      localeJsonMap.en,
      key,
      stringParams,
    );
  }

  // Fall back to pure-JS implementation (O(1) flat map lookup).
  return translatePure(key, params);
}