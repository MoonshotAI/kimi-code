// Query-param + locale helpers for the auth-login page. Pure functions so the
// contract stays unit-testable; the page wires them to document/location.

/** Parse and validate the `redirect_uri` query param. Only absolute http(s)
    URLs are accepted — anything else (javascript:, relative, protocol-relative)
    is rejected so the page cannot become an open-redirect trampoline onto
    non-http schemes. Returns null when missing or invalid. */
export function parseRedirectUri(search: string): string | null {
  const raw = new URLSearchParams(search).get('redirect_uri');
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.toString();
}

const LOCALE_COOKIE_NAME = 'KIMI_LOCALE';

/** Read the locale preference from the shared `KIMI_LOCALE` cookie (set on the
    root domain, so the main site's language choice carries over to this page).
    Only en/zh are recognized (regional variants like zh-CN / en-US count);
    anything else — or absence — returns null and the caller falls back to the
    browser language, then English. */
export function readLocaleCookie(cookieString: string): 'en' | 'zh' | null {
  for (const part of cookieString.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === LOCALE_COOKIE_NAME) {
      const value = rest.join('=').toLowerCase();
      if (value.startsWith('zh')) return 'zh';
      if (value.startsWith('en')) return 'en';
      return null;
    }
  }
  return null;
}
