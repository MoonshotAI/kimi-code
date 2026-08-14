import { describe, expect, it } from 'vitest';

import {
  buildTokenCookie,
  clearTokenCookie,
  parseRedirectUri,
  readLocaleCookie,
  readTokenCookie,
  TOKEN_COOKIE_NAME,
} from '../src/auth-token';

describe('readTokenCookie', () => {
  it('returns null when the cookie is absent', () => {
    expect(readTokenCookie('')).toBeNull();
    expect(readTokenCookie('other=abc')).toBeNull();
  });

  it('reads the token among several cookies', () => {
    expect(readTokenCookie(`a=1; ${TOKEN_COOKIE_NAME}=tok123; b=2`)).toBe('tok123');
  });

  it('returns null for an empty value', () => {
    expect(readTokenCookie(`${TOKEN_COOKIE_NAME}=`)).toBeNull();
  });

  it('decodes percent-encoded values', () => {
    expect(readTokenCookie(`${TOKEN_COOKIE_NAME}=${encodeURIComponent('a b=c')}`)).toBe('a b=c');
  });
});

describe('buildTokenCookie', () => {
  it('sets Path/Expires/SameSite and Secure on https', () => {
    const cookie = buildTokenCookie('tok', { expiresAt: 1_900_000_000, secure: true });
    expect(cookie).toContain(`${TOKEN_COOKIE_NAME}=tok`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Expires=${new Date(1_900_000_000 * 1000).toUTCString()}`);
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
  });

  it('omits Secure on http (localhost dev)', () => {
    const cookie = buildTokenCookie('tok', { expiresAt: 1_900_000_000, secure: false });
    expect(cookie).not.toContain('Secure');
  });

  it('encodes the token value', () => {
    expect(buildTokenCookie('a b', { expiresAt: 1_900_000_000, secure: true })).toContain(
      `${TOKEN_COOKIE_NAME}=a%20b`,
    );
  });
});

describe('clearTokenCookie', () => {
  it('expires the cookie immediately', () => {
    const cookie = clearTokenCookie();
    expect(cookie).toContain(`${TOKEN_COOKIE_NAME}=;`);
    expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
    expect(cookie).toContain('Path=/');
  });
});

describe('parseRedirectUri', () => {
  it('accepts absolute https URLs', () => {
    expect(parseRedirectUri('?redirect_uri=https%3A%2F%2Frc.example.com%2Fs%2Fabc')).toBe(
      'https://rc.example.com/s/abc',
    );
  });

  it('accepts http URLs (local tunnel dev)', () => {
    expect(parseRedirectUri('?redirect_uri=http%3A%2F%2F127.0.0.1%3A8080%2F')).toBe(
      'http://127.0.0.1:8080/',
    );
  });

  it('rejects non-http schemes', () => {
    expect(parseRedirectUri(`?redirect_uri=${encodeURIComponent('javascript:alert(1)')}`)).toBeNull();
  });

  it('rejects missing or unparsable values', () => {
    expect(parseRedirectUri('')).toBeNull();
    expect(parseRedirectUri('?redirect_uri=')).toBeNull();
    expect(parseRedirectUri('?redirect_uri=%2F%2Fevil.example.com')).toBeNull();
    expect(parseRedirectUri(`?redirect_uri=${encodeURIComponent('/relative/path')}`)).toBeNull();
  });
});

describe('readLocaleCookie', () => {
  it('returns null when the cookie is absent', () => {
    expect(readLocaleCookie('')).toBeNull();
    expect(readLocaleCookie('other=1')).toBeNull();
  });

  it('reads zh and en values among several cookies', () => {
    expect(readLocaleCookie('KIMI_LOCALE=zh')).toBe('zh');
    expect(readLocaleCookie(`a=1; KIMI_LOCALE=en; ${TOKEN_COOKIE_NAME}=x`)).toBe('en');
  });

  it('accepts regional variants', () => {
    expect(readLocaleCookie('KIMI_LOCALE=zh-CN')).toBe('zh');
    expect(readLocaleCookie('KIMI_LOCALE=en-US')).toBe('en');
  });

  it('ignores unknown values', () => {
    expect(readLocaleCookie('KIMI_LOCALE=fr')).toBeNull();
  });
});
