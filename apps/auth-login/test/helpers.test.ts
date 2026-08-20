import { describe, expect, it } from 'vitest';

import { parseRedirectUri, readLocaleCookie } from '../src/helpers';

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
    expect(readLocaleCookie('a=1; KIMI_LOCALE=en; session=x')).toBe('en');
  });

  it('accepts regional variants', () => {
    expect(readLocaleCookie('KIMI_LOCALE=zh-CN')).toBe('zh');
    expect(readLocaleCookie('KIMI_LOCALE=en-US')).toBe('en');
  });

  it('ignores unknown values', () => {
    expect(readLocaleCookie('KIMI_LOCALE=fr')).toBeNull();
  });
});
