/**
 * kimi-code i18n — backed by the compiled Rust translation engine.
 *
 * Uses `nativeTranslateCached` (process-wide `CachedTranslator` singleton) so
 * that repeated calls with the same locale JSON skip re-parsing entirely.
 * The cache is invalidated on locale switch via `nativeTranslateClearCache`.
 *
 * Provides both a module-level singleton (backward-compatible `t`, `setLocale`,
 * `getLocale`) and a `createI18n()` factory for multi-instance use, plus batch
 * translation via `translateBatch`.
 */

import type {
  Locale,
  TranslationKey as SharedTranslationKey,
  I18nInstance as SharedI18nInstance,
} from '@moonshot-ai/i18n-shared';
import { detectLocaleNode } from '@moonshot-ai/i18n-shared';

import en from './locales/en';
import zh from './locales/zh';

// Re-export shared types for consumers.
export type { Locale };
export type TranslationKey = SharedTranslationKey<typeof en>;
export type Engine = 'rust' | 'js';

// In a SEA binary, @moonshot-ai/kimi-native-tools is excluded from the JS
// bundle and shipped as a native asset. The Module._load hook approach
// doesn't work because the SEA runtime throws ERR_UNKNOWN_BUILTIN_MODULE
// before Module._load is called. Instead, ensureNative() falls back to
// loading the module from the native asset cache via getNativePackageRoot.
import { getNativePackageRoot } from '../native/native-assets';

const messages = { en, zh } as const;

// ── I18nInstance with batch support ────────────────────────────────────────────

export interface I18nInstance extends SharedI18nInstance<typeof messages> {
  /**
   * Returns whether the native Rust engine is active.
   * Always `'rust'` in kimi-code — the engine throws if unavailable.
   */
  getEngine: () => Engine;

  /**
   * Translate multiple keys in a single native call, parsing the JSON only once.
   *
   * Falls back to the cached engine when available. If neither batch variant is
   * available in the native module, iterates individual `t()` calls as a last
   * resort.
   */
  translateBatch: (
    keys: string[],
    params?: Record<string, string | number>,
  ) => { key: string; message: string }[];
}

// ── Native Rust engine (compiled, no fallback) ────────────────────────────────
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
  nativeTranslateBatch?: (
    localeJson: string,
    fallbackJson: string,
    keys: string[],
    params: Record<string, string> | null | undefined,
  ) => { key: string; message: string }[];
  nativeTranslateBatchCached?: (
    localeJson: string,
    fallbackJson: string,
    keys: string[],
    params: Record<string, string> | null | undefined,
  ) => { key: string; message: string }[];
}

let nativeModule: NativeModule | undefined;
let localeJsonEn: string | undefined;

function ensureNative(): NativeModule {
  if (nativeModule) return nativeModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try {
    const mod = require('@moonshot-ai/kimi-native-tools') as NativeModule;
    nativeModule = mod;
    localeJsonEn = JSON.stringify(en);
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
    return mod;
  }
}

function toNativeParams(params?: Record<string, string | number>): Record<string, string> | undefined {
  return params
    ? Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      )
    : undefined;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface CreateI18nOptions {
  /** Initial locale. Defaults to env-based detection. */
  initialLocale?: Locale;
  /** Skip auto-detection even in Node.js. */
  noDetect?: boolean;
}

/**
 * Create an i18n instance backed by the Rust translation engine.
 *
 * @example
 * const { t, setLocale } = createI18n();
 * console.log(t('cli.errors.promptEmpty'));
 */
export function createI18n(options: CreateI18nOptions = {}): I18nInstance {
  // An explicit initialLocale always wins; noDetect only suppresses
  // env-based detection (falling back to 'en') when no locale was given.
  let currentLocale: Locale = options.initialLocale
    ?? (options.noDetect ? 'en' : detectLocaleNode());

  let localeCurrentJson = JSON.stringify(messages[currentLocale]);

  return {
    t(
      key: TranslationKey | (string & {}),
      params?: Record<string, string | number>,
    ): string {
      const native = ensureNative();
      const stringParams = toNativeParams(params);

      if (native.nativeTranslateCached) {
        return native.nativeTranslateCached(
          localeCurrentJson,
          localeJsonEn!,
          key,
          stringParams,
        );
      }
      return native.nativeTranslate(
        localeCurrentJson,
        localeJsonEn!,
        key,
        stringParams,
      );
    },

    setLocale(locale: Locale): void {
      if (locale in messages) {
        currentLocale = locale;
        localeCurrentJson = JSON.stringify(messages[currentLocale]);
        try {
          const native = ensureNative();
          native.nativeTranslateClearCache?.();
        } catch {
          /* native module may not be loaded yet */
        }
      }
    },

    getLocale(): Locale {
      return currentLocale;
    },

    getEngine(): Engine {
      return 'rust';
    },

    getMessages(): typeof messages {
      return messages;
    },

    translateBatch(
      keys: string[],
      params?: Record<string, string | number>,
    ): { key: string; message: string }[] {
      const native = ensureNative();
      const stringParams = toNativeParams(params);

      // Prefer cached batch, fall back to uncached batch.
      if (native.nativeTranslateBatchCached) {
        return native.nativeTranslateBatchCached(
          localeCurrentJson,
          localeJsonEn!,
          keys,
          stringParams,
        );
      }
      if (native.nativeTranslateBatch) {
        return native.nativeTranslateBatch(
          localeCurrentJson,
          localeJsonEn!,
          keys,
          stringParams,
        );
      }
      // Last-resort: translate each key individually.
      return keys.map((key) => ({
        key,
        message: this.t(key, params),
      }));
    },
  };
}

// ── Module-level default singleton (backward-compatible API) ─────────────────

const defaultI18n = createI18n();

export const t = defaultI18n.t.bind(defaultI18n);
export const setLocale = defaultI18n.setLocale.bind(defaultI18n);
export const getLocale = defaultI18n.getLocale.bind(defaultI18n);
export const getEngine = defaultI18n.getEngine.bind(defaultI18n);
export const getMessages = defaultI18n.getMessages.bind(defaultI18n);
export const translateBatch = defaultI18n.translateBatch.bind(defaultI18n);