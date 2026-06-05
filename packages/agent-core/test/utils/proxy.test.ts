import { describe, expect, it, vi } from 'vitest';

import {
  createProxyDispatcher,
  installGlobalProxyDispatcher,
  isProxyConfigured,
  proxyEnvForChild,
  resolveNoProxy,
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

describe('createProxyDispatcher', () => {
  it('returns undefined and never builds an agent when no proxy is set', () => {
    const makeAgent = vi.fn();
    expect(createProxyDispatcher({}, makeAgent)).toBeUndefined();
    expect(makeAgent).not.toHaveBeenCalled();
  });

  it('builds an agent with loopback-protected NO_PROXY when a proxy is set', () => {
    const sentinel = { id: 'agent' } as never;
    const makeAgent = vi.fn().mockReturnValue(sentinel);
    const result = createProxyDispatcher({ HTTP_PROXY: 'http://p:3128', NO_PROXY: 'corp' }, makeAgent);
    expect(result).toBe(sentinel);
    expect(makeAgent).toHaveBeenCalledWith({ noProxy: 'corp,localhost,127.0.0.1,::1' });
  });

  it('reports and ignores an invalid proxy configuration instead of crashing', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const makeAgent = vi.fn(() => {
      throw new TypeError('Invalid URL');
    });
    try {
      expect(createProxyDispatcher({ HTTP_PROXY: 'gibberish' }, makeAgent)).toBeUndefined();
      expect(makeAgent).toHaveBeenCalledTimes(1);
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
});
