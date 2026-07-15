import { describe, it, expect, vi } from 'vitest';

import { resolveConnectTarget } from './connect-target';

describe('resolveConnectTarget', () => {
  it('returns embedded mode for undefined / empty / whitespace-only KIMI_SERVER_URL, without reading the token', () => {
    const readToken = vi.fn(() => 'tok');
    for (const serverUrl of [undefined, '', '   ']) {
      expect(resolveConnectTarget(serverUrl, readToken)).toEqual({ external: false });
    }
    expect(readToken).not.toHaveBeenCalled();
  });

  it('returns the bare origin and the injected token for a plain loopback URL', () => {
    const readToken = vi.fn(() => 'tok-123');
    expect(resolveConnectTarget('http://127.0.0.1:58627', readToken)).toEqual({
      external: true,
      origin: 'http://127.0.0.1:58627',
      token: 'tok-123',
    });
    expect(readToken).toHaveBeenCalledOnce();
  });

  it('passes through an undefined token from the reader', () => {
    expect(resolveConnectTarget('http://127.0.0.1:58627', () => undefined)).toEqual({
      external: true,
      origin: 'http://127.0.0.1:58627',
      token: undefined,
    });
  });

  it('strips a trailing slash', () => {
    const target = resolveConnectTarget('http://127.0.0.1:58627/', () => 'tok');
    expect(target).toEqual({
      external: true,
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
    });
  });

  it('strips /v1 and /v1/ suffixes', () => {
    for (const serverUrl of ['http://127.0.0.1:58627/v1', 'http://127.0.0.1:58627/v1/']) {
      const target = resolveConnectTarget(serverUrl, () => 'tok');
      expect(target).toEqual({
        external: true,
        origin: 'http://127.0.0.1:58627',
        token: 'tok',
      });
    }
  });

  it('strips query string and hash', () => {
    const target = resolveConnectTarget('http://127.0.0.1:58627/?a=1#frag', () => 'tok');
    expect(target).toEqual({
      external: true,
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
    });
  });

  it('throws on an invalid URL', () => {
    expect(() => resolveConnectTarget('not a url', () => 'tok')).toThrow();
  });
});
