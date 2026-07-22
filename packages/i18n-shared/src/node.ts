/**
 * @deprecated Use `apps/kimi-code/src/i18n/index.ts` (the `createI18n()` factory)
 * instead. This module is no longer exported from the package and exists only for
 * reference. The Rust-backed i18n factory has been consolidated into the kimi-code
 * package, which provides the same `t`, `setLocale`, `getLocale` API plus batch
 * translation via `translateBatch`.
 *
 * --- Original docs below ---
 *
 * Node.js i18n factory — uses the compiled Rust translation engine.
 *
 * The Rust engine (`@moonshot-ai/kimi-native-tools`) provides:
 * - `nativeTranslateCached`: cached JSON parsing for hot paths
 * - `nativeTranslateClearCache`: cache invalidation on locale switch
 *
 * This is the canonical implementation for all Node.js apps (agent-core,
 * kimi-code CLI/TUI, kap-server, vscode extension).
 */

import type { Locale, MessageValue, TranslationKey, I18nInstance } from './types.js';
import { detectLocaleNode } from './detect.js';

// ── Native module type ───────────────────────────────────────────────────────

interface NativeModule {
  nativeTranslateCached: (
    localeJson: string,
    fallbackJson: string,
    key: string,
    params: Record<string, string> | null | undefined,
  ) => string;
  nativeTranslateClearCache?: () => void;
  nativeTranslate?: (
    localeJson: string,
    fallbackJson: string,
    key: string,
    params: Record<string, string> | null | undefined,
  ) => string;
}

// ── Lazy native loader ───────────────────────────────────────────────────────

let _nativeModule: NativeModule | null | undefined;

function getNativeModule(): NativeModule {
  if (_nativeModule !== undefined) return _nativeModule as NativeModule;
  try {
    // Use require() so bundlers don't try to resolve the .node file.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _nativeModule = require('@moonshot-ai/kimi-native-tools');
  } catch {
    _nativeModule = null;
  }
  return _nativeModule as NativeModule;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface CreateI18nNodeOptions {
  /** Initial locale. Defaults to env-based detection. */
  initialLocale?: Locale;
  /** Skip auto-detection even in Node.js. */
  noDetect?: boolean;
}

/**
 * @deprecated Use `createI18n` from `apps/kimi-code/src/i18n/index.ts` instead.
 * This function will be removed in a future version.
 */
export function createI18n<M extends Record<Locale, MessageValue>>(
  messages: M,
  options: CreateI18nNodeOptions = {},
): I18nInstance<M> {
  let currentLocale: Locale = options.noDetect
    ? 'en'
    : (options.initialLocale ?? detectLocaleNode());

  // Pre-serialize locale JSON for the Rust engine.
  // `localeJsonEn` never changes; `localeJsonCurrent` is rebuilt on locale switch.
  const localeJsonEn = JSON.stringify(messages.en);
  let localeJsonCurrent = JSON.stringify(messages[currentLocale]);

  function t(
    key: TranslationKey<M['en']> | (string & {}),
    params?: Record<string, string | number>,
  ): string {
    const native = getNativeModule();
    if (native) {
      const stringParams: Record<string, string> | undefined = params
        ? Object.fromEntries(
            Object.entries(params).map(([k, v]) => [k, String(v)]),
          )
        : undefined;

      if (native.nativeTranslateCached) {
        return native.nativeTranslateCached(
          localeJsonCurrent,
          localeJsonEn,
          key as string,
          stringParams,
        );
      }
      // Fall back to uncached native if cached is unavailable.
      if (native.nativeTranslate) {
        return native.nativeTranslate(
          localeJsonCurrent,
          localeJsonEn,
          key as string,
          stringParams,
        );
      }
    }

    // Last-resort pure-JS fallback (if the native module failed to load).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { translate } = require('./core.js') as typeof import('./core.js');
    return translate(
      messages[currentLocale],
      messages.en,
      key as string,
      params,
    );
  }

  function setLocale(locale: Locale): void {
    if (locale in messages) {
      currentLocale = locale;
      localeJsonCurrent = JSON.stringify(messages[currentLocale]);
      // Invalidate the Rust-side cache so stale parsed JSON is evicted.
      const native = getNativeModule();
      native?.nativeTranslateClearCache?.();
    }
  }

  function getLocale(): Locale {
    return currentLocale;
  }

  function getMessages(): M {
    return messages;
  }

  return { t, setLocale, getLocale, getMessages };
}