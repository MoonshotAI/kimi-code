export type Locale = 'en' | 'zh';

import { default as en } from './i18n-locales/en';
import { default as zh } from './i18n-locales/zh';

const messages: Record<Locale, object> = { en, zh };
let currentLocale: Locale = 'en';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

function resolveMessage(key: string, locale: Locale): string | undefined {
  const parts = key.split('.');
  let current: unknown = messages[locale];
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

export function t(
  key: string,
  params?: Record<string, string | number>,
): string {
  let msg = resolveMessage(key, currentLocale) ?? resolveMessage(key, 'en') ?? key;
  if (params) {
    msg = msg.replace(/\{\{(\w+)\}\}/g, (_: string, name: string) =>
      params[name] !== undefined ? String(params[name]) : `{{${name}}}`,
    );
  }
  return msg;
}
