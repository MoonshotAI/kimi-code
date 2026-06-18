/**
 * Locale resolution.
 *
 * Turns a user `language` preference into a concrete `Locale`. Explicit
 * preferences (`'en'` / `'zh-CN'`) pass straight through; `'auto'` inspects the
 * POSIX locale environment variables (`LC_ALL` > `LC_MESSAGES` > `LANG`, matching
 * standard precedence) against a small known-locale table. Anything unknown —
 * including the `C` / `POSIX` locales and an empty environment — falls back to
 * `'en'`.
 */

import type { TuiLanguage } from '#/tui/config';

import type { Locale } from './i18n';

export type LocaleEnv = Partial<Record<'LC_ALL' | 'LC_MESSAGES' | 'LANG', string>>;

const FALLBACK_LOCALE: Locale = 'en';

export function resolveLocale(
  language: TuiLanguage,
  env: LocaleEnv = process.env,
): Locale {
  if (language === 'en') return 'en';
  if (language === 'zh-CN') return 'zh-CN';
  return detectLocaleFromEnv(env);
}

function detectLocaleFromEnv(env: LocaleEnv): Locale {
  // POSIX precedence: LC_ALL overrides LC_MESSAGES overrides LANG. Empty values
  // are skipped, so an empty LC_ALL still defers to LANG.
  const raw = [env.LC_ALL, env.LC_MESSAGES, env.LANG]
    .find((value) => value !== undefined && value.trim().length > 0)
    ?.trim();
  if (raw === undefined) return FALLBACK_LOCALE;

  // Normalise `zh_CN.UTF-8` / `zh-CN` / `zh_CN` down to the language+region
  // stem before matching.
  const normalized = raw.split('.')[0]!.replace('_', '-').toLowerCase();
  if (normalized === 'zh-cn' || normalized === 'zh') return 'zh-CN';
  return FALLBACK_LOCALE;
}
