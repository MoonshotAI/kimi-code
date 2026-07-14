import en from './locales/en';
import zh from './locales/zh';

export type Locale = 'en' | 'zh';

const messages = { en, zh };

let currentLocale: Locale = 'en';

function detectLocale(): Locale {
  const envLang = process.env['KIMI_LANG'];
  if (envLang === 'zh' || envLang?.startsWith('zh')) {
    return 'zh';
  }
  if (envLang === 'en' || envLang?.startsWith('en')) {
    return 'en';
  }
  const systemLang = process.env['LANG'] || process.env['LC_ALL'] || process.env['LC_MESSAGES'];
  if (systemLang?.toLowerCase().startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

currentLocale = detectLocale();

export function setLocale(locale: Locale): void {
  if (locale in messages) {
    currentLocale = locale;
  }
}

export function getLocale(): Locale {
  return currentLocale;
}

type MessageValue = string | { [key: string]: MessageValue };

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

export type TranslationKey = Paths<typeof en>;

function resolveMessage(
  locale: Locale,
  key: string,
): string | undefined {
  const parts = key.split('.');
  let current: MessageValue | undefined = messages[locale];
  for (const part of parts) {
    if (current === undefined || typeof current === 'string') {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === 'string' ? current : undefined;
}

export function t(
  key: TranslationKey | (string & {}),
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
