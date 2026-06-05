import { describe, expect, it, vi } from 'vitest';

import {
  createProxyDispatcher,
  installGlobalProxyDispatcher,
  isProxyConfigured,
  makeNoProxyMatcher,
  proxyEnvForChild,
  resolveNoProxy,
  resolveSocksProxy,
} from '../../src/utils/proxy';

describe('isProxyConfigured', () => {
  it('is false when no proxy variable is set', () => {
    expect(isProxyConfigured({})).toBe(false);
  });

  it('is true for HTTP_PROXY and the lowercase form', () => {
    expect(isProxyConfigured({ HTTP_PROXY: 'http://p:3128' })).toBe(true);
    expect(isProxyConfigured({ http_proxy: 'http://p:3128' })).toBe(true);
  });

  it('is true for HTTPS_PROXY', () => {
    expect(isProxyConfigured({ HTTPS_PROXY: 'http://p:3128' })).toBe(true);
  });

  it('ignores blank values', () => {
    expect(isProxyConfigured({ HTTP_PROXY: '   ' })).toBe(false);
  });

  it('is true when only a SOCKS proxy (ALL_PROXY) is set', () => {
    expect(isProxyConfigured({ ALL_PROXY: 'socks5://127.0.0.1:1080' })).toBe(true);
  });
});

describe('resolveNoProxy', () => {
  it('adds loopback hosts when NO_PROXY is unset', () => {
    expect(resolveNoProxy({})).toBe('localhost,127.0.0.1,::1');
  });

  it('preserves existing hosts and appends only the missing loopback hosts', () => {
    expect(resolveNoProxy({ NO_PROXY: 'example.com, 127.0.0.1' })).toBe(
      'example.com,127.0.0.1,localhost,::1',
    );
  });

  it('reads the lowercase no_proxy', () => {
    expect(resolveNoProxy({ no_proxy: 'internal' })).toBe('internal,localhost,127.0.0.1,::1');
  });

  it('preserves the "*" wildcard verbatim (it must stay an exact match to bypass everything)', () => {
    expect(resolveNoProxy({ NO_PROXY: '*' })).toBe('*');
    expect(resolveNoProxy({ NO_PROXY: 'corp, *' })).toBe('*');
  });

  it('falls through to NO_PROXY when no_proxy is set but blank', () => {
    expect(resolveNoProxy({ no_proxy: '', NO_PROXY: 'corp' })).toBe('corp,localhost,127.0.0.1,::1');
  });
});

describe('resolveSocksProxy', () => {
  it('returns undefined when no SOCKS proxy is configured', () => {
    expect(resolveSocksProxy({})).toBeUndefined();
    expect(resolveSocksProxy({ HTTP_PROXY: 'http://p:3128' })).toBeUndefined();
  });

  it('parses ALL_PROXY socks5 and defaults the port to 1080', () => {
    expect(resolveSocksProxy({ ALL_PROXY: 'socks5://10.0.0.1' })).toEqual({
      type: 5,
      host: '10.0.0.1',
      port: 1080,
    });
  });

  it('normalizes the socks:// alias to socks5', () => {
    expect(resolveSocksProxy({ ALL_PROXY: 'socks://127.0.0.1:7890' })).toEqual({
      type: 5,
      host: '127.0.0.1',
      port: 7890,
    });
  });

  it('parses socks4 as type 4', () => {
    expect(resolveSocksProxy({ ALL_PROXY: 'socks4://127.0.0.1:1080' })).toEqual({
      type: 4,
      host: '127.0.0.1',
      port: 1080,
    });
  });

  it('reads credentials from the URL', () => {
    expect(resolveSocksProxy({ ALL_PROXY: 'socks5://user:pass@127.0.0.1:1080' })).toEqual({
      type: 5,
      host: '127.0.0.1',
      port: 1080,
      userId: 'user',
      password: 'pass',
    });
  });

  it('picks up a SOCKS scheme set in HTTP_PROXY', () => {
    expect(resolveSocksProxy({ HTTP_PROXY: 'socks5://127.0.0.1:1080' })).toEqual({
      type: 5,
      host: '127.0.0.1',
      port: 1080,
    });
  });

  it('prefers ALL_PROXY over a SOCKS value in HTTPS_PROXY', () => {
    expect(resolveSocksProxy({ ALL_PROXY: 'socks5://a:1', HTTPS_PROXY: 'socks5://b:2' })).toEqual({
      type: 5,
      host: 'a',
      port: 1,
    });
  });

  it('is case-insensitive on the scheme', () => {
    expect(resolveSocksProxy({ ALL_PROXY: 'SOCKS5://127.0.0.1:1080' })).toEqual({
      type: 5,
      host: '127.0.0.1',
      port: 1080,
    });
  });
});

describe('makeNoProxyMatcher', () => {
  it('bypasses everything for the "*" wildcard', () => {
    const bypass = makeNoProxyMatcher('*');
    expect(bypass('example.com')).toBe(true);
    expect(bypass('127.0.0.1')).toBe(true);
  });

  it('bypasses listed hosts and loopback, not others', () => {
    const bypass = makeNoProxyMatcher('localhost,127.0.0.1,::1,corp.internal');
    expect(bypass('localhost')).toBe(true);
    expect(bypass('127.0.0.1')).toBe(true);
    expect(bypass('corp.internal')).toBe(true);
    expect(bypass('example.com')).toBe(false);
  });

  it('matches subdomains for both bare and leading-dot entries', () => {
    const bypass = makeNoProxyMatcher('.example.com,foo.org');
    expect(bypass('a.example.com')).toBe(true);
    expect(bypass('example.com')).toBe(true);
    expect(bypass('sub.foo.org')).toBe(true);
    expect(bypass('foo.org')).toBe(true);
    expect(bypass('other.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(makeNoProxyMatcher('Corp.Internal')('corp.INTERNAL')).toBe(true);
  });

  it('never bypasses when NO_PROXY is empty', () => {
    expect(makeNoProxyMatcher('')('example.com')).toBe(false);
  });
});

describe('createProxyDispatcher', () => {
  it('returns undefined and builds nothing when no proxy is set', () => {
    const makeHttpAgent = vi.fn();
    const makeSocksAgent = vi.fn();
    expect(createProxyDispatcher({}, { makeHttpAgent, makeSocksAgent })).toBeUndefined();
    expect(makeHttpAgent).not.toHaveBeenCalled();
    expect(makeSocksAgent).not.toHaveBeenCalled();
  });

  it('builds an HTTP-proxy agent with loopback-protected NO_PROXY', () => {
    const sentinel = { id: 'http' } as never;
    const makeHttpAgent = vi.fn().mockReturnValue(sentinel);
    const makeSocksAgent = vi.fn();
    const result = createProxyDispatcher(
      { HTTP_PROXY: 'http://p:3128', NO_PROXY: 'corp' },
      { makeHttpAgent, makeSocksAgent },
    );
    expect(result).toBe(sentinel);
    expect(makeHttpAgent).toHaveBeenCalledWith({ noProxy: 'corp,localhost,127.0.0.1,::1' });
    expect(makeSocksAgent).not.toHaveBeenCalled();
  });

  it('builds a SOCKS agent when only a SOCKS proxy is configured', () => {
    const sentinel = { id: 'socks' } as never;
    const makeSocksAgent = vi.fn().mockReturnValue(sentinel);
    const makeHttpAgent = vi.fn();
    const result = createProxyDispatcher(
      { ALL_PROXY: 'socks5://127.0.0.1:1080', NO_PROXY: 'corp' },
      { makeHttpAgent, makeSocksAgent },
    );
    expect(result).toBe(sentinel);
    expect(makeSocksAgent).toHaveBeenCalledWith({
      proxy: { type: 5, host: '127.0.0.1', port: 1080 },
      noProxy: 'corp,localhost,127.0.0.1,::1',
    });
    expect(makeHttpAgent).not.toHaveBeenCalled();
  });

  it('prefers an HTTP(S) proxy over a SOCKS ALL_PROXY', () => {
    const makeHttpAgent = vi.fn().mockReturnValue({ id: 'http' } as never);
    const makeSocksAgent = vi.fn();
    createProxyDispatcher(
      { HTTP_PROXY: 'http://p:3128', ALL_PROXY: 'socks5://127.0.0.1:1080' },
      { makeHttpAgent, makeSocksAgent },
    );
    expect(makeHttpAgent).toHaveBeenCalledTimes(1);
    expect(makeSocksAgent).not.toHaveBeenCalled();
  });

  it('reports and ignores an invalid proxy configuration instead of crashing', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const makeHttpAgent = vi.fn(() => {
      throw new TypeError('Invalid URL');
    });
    try {
      expect(createProxyDispatcher({ HTTP_PROXY: 'gibberish' }, { makeHttpAgent })).toBeUndefined();
      expect(makeHttpAgent).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('installGlobalProxyDispatcher', () => {
  it('installs the dispatcher exactly once and returns true when a proxy is set', () => {
    const dispatcher = { id: 'dispatcher' } as never;
    const setGlobalDispatcher = vi.fn();
    const createDispatcher = vi.fn().mockReturnValue(dispatcher);
    const installed = installGlobalProxyDispatcher(
      { HTTP_PROXY: 'http://p:3128' },
      { setGlobalDispatcher, createProxyDispatcher: createDispatcher },
    );
    expect(installed).toBe(true);
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(setGlobalDispatcher).toHaveBeenCalledWith(dispatcher);
  });

  it('installs nothing and returns false when no proxy is set', () => {
    const setGlobalDispatcher = vi.fn();
    const createDispatcher = vi.fn().mockReturnValue(undefined);
    const installed = installGlobalProxyDispatcher(
      {},
      { setGlobalDispatcher, createProxyDispatcher: createDispatcher },
    );
    expect(installed).toBe(false);
    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });
});

describe('proxyEnvForChild', () => {
  it('returns an empty object when no proxy is configured', () => {
    expect(proxyEnvForChild({})).toEqual({});
  });

  it('enables Node native env-proxy and protects loopback for spawned node children', () => {
    // Sets BOTH casings: a child inherits the parent's env, and undici reads
    // the lowercase no_proxy first — so the lowercase form must also carry the
    // loopback-augmented value or the protection is silently defeated.
    expect(proxyEnvForChild({ HTTP_PROXY: 'http://p:3128', NO_PROXY: 'corp' })).toEqual({
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: 'corp,localhost,127.0.0.1,::1',
      no_proxy: 'corp,localhost,127.0.0.1,::1',
    });
  });

  it('passes the "*" wildcard through to the child verbatim in both casings', () => {
    expect(proxyEnvForChild({ HTTP_PROXY: 'http://p:3128', NO_PROXY: '*' })).toEqual({
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: '*',
      no_proxy: '*',
    });
  });

  it('returns an empty object for a SOCKS-only proxy (children cannot use SOCKS natively)', () => {
    expect(proxyEnvForChild({ ALL_PROXY: 'socks5://127.0.0.1:1080' })).toEqual({});
  });
});
