/**
 * I18n class + global singleton.
 *
 * Mirrors the `currentTheme` Theme singleton: components import `i18n` and call
 * `i18n.t('module.submodule.phrase')` at render time. When the user switches
 * languages we call `i18n.setLocale(locale)` — the same instance stays alive, so
 * every component picks up the new locale on the next render frame.
 *
 * Lookups resolve `module.submodule.phrase` dotted keys against the active
 * locale, falling back to the default locale (`en`) on a missing key, then to
 * the raw key itself so a missing translation is visible rather than blank.
 * `{param}` placeholders are interpolated from the optional params map.
 */

import { locales } from './locales';

/** A nested tree of translation strings keyed by namespace segment. */
export interface MessageTree {
  readonly [segment: string]: string | MessageTree;
}

export type Locale = 'en' | 'zh-CN';

export type LocaleMessages = Record<string, MessageTree>;

export type TranslateParams = Record<string, string | number>;

const DEFAULT_FALLBACK_LOCALE: Locale = 'en';

export class I18n {
  private readonly locales: LocaleMessages;
  private locale: string;
  private readonly fallbackLocale: string;

  constructor(
    locales: LocaleMessages,
    locale: string,
    fallbackLocale: string = DEFAULT_FALLBACK_LOCALE,
  ) {
    this.locales = locales;
    this.locale = locale;
    this.fallbackLocale = fallbackLocale;
  }

  get currentLocale(): string {
    return this.locale;
  }

  setLocale(locale: string): void {
    this.locale = locale;
  }

  t(key: string, params?: TranslateParams): string {
    const raw =
      lookup(this.locales[this.locale], key) ??
      lookup(this.locales[this.fallbackLocale], key) ??
      key;
    return interpolate(raw, params);
  }
}

/**
 * Global singleton. Starts on the `en` locale (also the fallback); startup
 * wiring calls `i18n.setLocale(resolveLocale(config.language))` once the TUI
 * config is loaded, mirroring `currentTheme.setPalette(...)`.
 */
export const i18n = new I18n(locales, DEFAULT_FALLBACK_LOCALE);

function lookup(tree: MessageTree | undefined, key: string): string | undefined {
  if (tree === undefined) return undefined;
  let node: string | MessageTree | undefined = tree;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object') return undefined;
    node = node[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(template: string, params?: TranslateParams): string {
  if (params === undefined) return template;
  return template.replaceAll(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
