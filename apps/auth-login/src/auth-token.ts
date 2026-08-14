// Cookie + query-param helpers for the auth-login page. Pure functions so the
// contract stays unit-testable; the page wires them to document/location.

export const TOKEN_COOKIE_NAME = 'kimi-auth';

/** Read the access token from a `document.cookie`-shaped string. Returns null
    when absent or empty. */
export function readTokenCookie(cookieString: string): string | null {
  for (const part of cookieString.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === TOKEN_COOKIE_NAME) {
      const value = rest.join('=');
      return value.length > 0 ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

export interface TokenCookieOptions {
  /** Unix seconds when the token expires; mapped to the cookie's Expires. */
  readonly expiresAt: number;
  /** Emit the Secure attribute. True on https; false for http://localhost dev. */
  readonly secure: boolean;
}

/** Serialize the token cookie. SameSite=Lax so the tunnel's top-level
    navigation back to the app carries it; Path=/ so every route on the host
    sees it. */
export function buildTokenCookie(accessToken: string, options: TokenCookieOptions): string {
  const expires = new Date(options.expiresAt * 1000).toUTCString();
  const parts = [
    `${TOKEN_COOKIE_NAME}=${encodeURIComponent(accessToken)}`,
    'Path=/',
    `Expires=${expires}`,
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Serialize an immediately-expired token cookie (i.e. delete it). Used when
    the server side has rejected the token — e.g. the tunnel bounces the user
    back with `force_relogin=1` — so a stale cookie can't ping-pong the user
    between this page and the target. */
export function clearTokenCookie(): string {
  return `${TOKEN_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
}

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
