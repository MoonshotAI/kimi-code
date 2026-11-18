import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { readLocaleCookie } from './helpers';

function detectLocale(): 'en' | 'zh' {
  try {
    const fromCookie = readLocaleCookie(document.cookie);
    if (fromCookie) return fromCookie;
  } catch {}
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export const i18n = createKimiI18n({ locale: detectLocale() });

export default i18n;
