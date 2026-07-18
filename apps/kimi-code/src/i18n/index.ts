/**
 * kimi-code i18n — backed by the compiled Rust translation engine.
 *
 * Uses `nativeTranslateCached` (process-wide `CachedTranslator` singleton) so
 * that repeated calls with the same locale JSON skip re-parsing entirely.
 * The cache is invalidated on locale switch via `nativeTranslateClearCache`.
 */

import type { Locale, TranslationKey } from '@moonshot-ai/i18n-shared';
import { detectLocaleNode } from '@moonshot-ai/i18n-shared';

import en from './locales/en';
import zh from './locales/zh';

// Re-export shared types for consumers.
export type { Locale };
export type TranslationKey = TranslationKey<typeof en>;

// In a SEA binary, @moonshot-ai/kimi-native-tools is excluded from the JS
// bundle and shipped as a native asset. The Module._load hook approach
// doesn't work because the SEA runtime throws ERR_UNKNOWN_BUILTIN_MODULE
// before Module._load is called. Instead, ensureNative() falls back to
// loading the module from the native asset cache via getNativePackageRoot.
import { getNativePackageRoot } from '../native/native-assets';

const messages = { en, zh };

let currentLocale: Locale = detectLocaleNode();

export function setLocale(locale: Locale): void {
  if (locale in messages) {
    currentLocale = locale;
    // Invalidate the Rust-side cache so stale parsed JSON is evicted.
    localeJsonCurrent = undefined;
    try {
      const native = ensureNative();
      native.nativeTranslateClearCache?.();
    } catch {
      /* native module may not be loaded yet */
    }
  }
}

export function getLocale(): Locale {
  return currentLocale;
}

// ── Native Rust engine (compiled, no fallback) ───────────────────────────────
// The Rust module is compiled into the binary via napi-rs. If it's not available
// the error is thrown immediately — no silent fallback, because the compiled
// engine is the only canonical implementation.

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

let nativeModule: NativeModule | undefined;

let localeJsonEn: string | undefined;
let localeJsonCurrent: string | undefined;

function ensureNative(): NativeModule {
  if (nativeModule) return nativeModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try {
    const mod = require('@moonshot-ai/kimi-native-tools') as NativeModule;
    nativeModule = mod;
    localeJsonEn = JSON.stringify(en);
    localeJsonCurrent = JSON.stringify(messages[currentLocale]);
    return mod;
  } catch {
    // In a SEA binary the module is a native asset, not a bundled JS module.
    // Load it from the extracted cache via getNativePackageRoot.
    const pkgRoot = getNativePackageRoot('@moonshot-ai/kimi-native-tools');
    if (pkgRoot === null) throw new Error(
      'Failed to load @moonshot-ai/kimi-native-tools: not available as a bundled module or native asset.',
    );
    const { createRequire } = require('node:module');
    const { join } = require('node:path');
    const cacheRequire = createRequire(join(pkgRoot, 'index.js'));
    const mod = cacheRequire(pkgRoot) as NativeModule;
    nativeModule = mod;
    localeJsonEn = JSON.stringify(en);
    localeJsonCurrent = JSON.stringify(messages[currentLocale]);
    return mod;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function t(
  key: TranslationKey | (string & {}),
  params?: Record<string, string | number>,
): string {
  const native = ensureNative();
  if (localeJsonCurrent === undefined) {
    localeJsonCurrent = JSON.stringify(messages[currentLocale]);
  }
  const stringParams: Record<string, string> | undefined = params
    ? Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      )
    : undefined;

  // Use the cached translator (skips JSON re-parsing on repeated calls).
  // Falls back to uncached `nativeTranslate` if the .node file predates it.
  if (native.nativeTranslateCached) {
    return native.nativeTranslateCached(
      localeJsonCurrent!,
      localeJsonEn!,
      key,
      stringParams,
    );
  }
  return native.nativeTranslate(
    localeJsonCurrent!,
    localeJsonEn!,
    key,
    stringParams,
  );
}
