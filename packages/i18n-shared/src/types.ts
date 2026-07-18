/**
 * Shared i18n types — used by all apps (Node.js and browser).
 *
 * The `TranslationKey<T>` type derives all valid dot-separated key paths from
 * a locale message tree, giving compile-time safety to `t()` calls.
 */

// ── Locale ───────────────────────────────────────────────────────────────────

export type Locale = 'en' | 'zh';

// ── Message tree ─────────────────────────────────────────────────────────────

export type MessageValue = string | { [key: string]: MessageValue };

// ── Deep path derivation ─────────────────────────────────────────────────────
//
// Given a message tree like:
//   { common: { ok: 'OK', cancel: 'Cancel' } }
// produces the union:
//   'common' | 'common.ok' | 'common.cancel'

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

/**
 * Derive all valid translation key paths from a locale message tree.
 *
 * @example
 * const en = { common: { ok: 'OK' } } as const;
 * type Key = TranslationKey<typeof en>; // 'common' | 'common.ok'
 */
export type TranslationKey<T> = Paths<T>;

// ── I18n instance ────────────────────────────────────────────────────────────

export interface I18nInstance<M extends Record<Locale, MessageValue>> {
  /** Translate a key with optional `{{param}}` interpolation. */
  t: (key: TranslationKey<M['en']> | (string & {}), params?: Record<string, string | number>) => string;
  /** Set the current locale. */
  setLocale: (locale: Locale) => void;
  /** Get the current locale. */
  getLocale: () => Locale;
  /** Get the messages object. */
  getMessages: () => M;
}

// ── Helper: collect all leaf keys from a message tree ────────────────────────

export function collectLeafKeys(obj: MessageValue, prefix = ''): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = (obj as Record<string, MessageValue>)[key];
    if (typeof value === 'object' && value !== null) {
      keys.push(...collectLeafKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}
