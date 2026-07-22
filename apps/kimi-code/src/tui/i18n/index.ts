import { en } from './en';
import type { Language, TranslationKey, Translations } from './types';
import { zh } from './zh';

const TRANSLATIONS: Record<Language, Translations> = {
  en,
  zh,
};

let currentLanguage: Language = 'en';

export function setLanguage(language: Language): void {
  currentLanguage = language;
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function isLanguage(value: string): value is Language {
  return value === 'en' || value === 'zh';
}

export function t(key: TranslationKey, vars?: Record<string, string>): string {
  const value = getNestedValue(TRANSLATIONS[currentLanguage], key);
  if (vars === undefined) return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? `{{${name}}}`);
}

function getNestedValue(obj: Translations, key: string): string {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      throw new Error(`Missing translation key: ${key}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== 'string') {
    throw new Error(`Missing translation key: ${key}`);
  }
  return current;
}

export type { Language, TranslationKey, Translations } from './types';
