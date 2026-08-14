import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { readLocaleCookie } from './auth-token';

// Locale resolution for this page: the shared `KIMI_LOCALE` cookie (a
// root-domain cookie, so the main site's language choice carries over) →
// browser language → English.
function detectLocale(): 'en' | 'zh' {
  try {
    const fromCookie = readLocaleCookie(document.cookie);
    if (fromCookie) return fromCookie;
  } catch {
    // document unavailable — fall through to the browser language.
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

// Single i18n instance from the shared app-i18n factory: the page reuses the
// client's `login` namespace (plus the rc* keys) and `common` (Spinner's aria
// label).
export const i18n = createKimiI18n({ locale: detectLocale() });

export default i18n;
