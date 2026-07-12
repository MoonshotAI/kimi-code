import { useCallback, useEffect, useState } from 'react';
import en from './locales/en';
import zh from './locales/zh';

export type Locale = 'en' | 'zh';

const STORAGE_KEY = 'vis.locale';

const messages = { en, zh } as const;

let currentLocale: Locale = detectLocale();

function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    /* ignore */
  }
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

type MessageValue = string | { [key: string]: MessageValue };

function resolveMessage(locale: Locale, key: string): string | undefined {
  const parts = key.split('.');
  let current: MessageValue | undefined = messages[locale] as unknown as MessageValue;
  for (const part of parts) {
    if (current === undefined || typeof current === 'string') {
      return undefined;
    }
    current = (current as Record<string, MessageValue>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

export function t(
  key: string,
  params?: Record<string, string | number>,
): string {
  let message = resolveMessage(currentLocale, key);
  if (message === undefined) {
    message = resolveMessage('en', key);
  }
  if (message === undefined) {
    return key;
  }
  if (!params) {
    return message;
  }
  return message.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    const value = params[name];
    return value !== undefined ? String(value) : `{{${name}}}`;
  });
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  try {
    if (locale === 'en') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, locale);
    }
  } catch {
    /* ignore */
  }
}

export function useLocale(): {
  locale: Locale;
  set: (l: Locale) => void;
} {
  const [locale, setLocaleState] = useState<Locale>(currentLocale);

  const set = useCallback((l: Locale) => {
    setLocale(l);
    setLocaleState(l);
  }, []);

  useEffect(() => {
    setLocaleState(currentLocale);
  }, []);

  return { locale, set };
}
