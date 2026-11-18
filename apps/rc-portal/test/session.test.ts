import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenInfo } from '@moonshot-ai/kimi-code-oauth/device';

import { exchangeSession, logoutSession, probeSession, ExchangeError, LogoutError } from '../src/session';

const token: TokenInfo = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: 1_900_000_000,
  scope: 'kimi-code',
  tokenType: 'Bearer',
  expiresIn: 900,
};

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeSession', () => {
  it('returns the account profile on 200 with a live session', async () => {
    stubFetch(() => Promise.resolve(new Response(JSON.stringify({
      user_id: 'u_1',
      level: 30,
      nickname: '林小满',
      avatar: 'https://cdn.example/avatar.png',
      user_level_name: 'Vivace',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(probeSession()).resolves.toEqual({
      userId: 'u_1',
      level: 30,
      nickname: '林小满',
      avatar: 'https://cdn.example/avatar.png',
      userLevelName: 'Vivace',
    });
  });

  it('defaults missing display fields without rejecting the session', async () => {
    stubFetch(() => Promise.resolve(new Response(JSON.stringify({ user_id: 'u_1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(probeSession()).resolves.toEqual({
      userId: 'u_1',
      level: 0,
      nickname: '',
      avatar: undefined,
      userLevelName: '',
    });
  });

  it('returns null on 200 with HTML (a dev-server SPA fallback, not a session)', async () => {
    stubFetch(() => Promise.resolve(new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })));
    await expect(probeSession()).resolves.toBeNull();
  });

  it('returns null on 401 (signed out)', async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 401 })));
    await expect(probeSession()).resolves.toBeNull();
  });

  it('returns null on network failure (the exchange step surfaces outages)', async () => {
    stubFetch(() => Promise.reject(new Error('connection refused')));
    await expect(probeSession()).resolves.toBeNull();
  });

  it('returns null when the response has no user id', async () => {
    stubFetch(() => Promise.resolve(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(probeSession()).resolves.toBeNull();
  });

  it('calls the sibling /auth/me endpoint', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })));
    vi.stubGlobal('fetch', spy);
    await probeSession();
    expect(spy).toHaveBeenCalledWith('/auth/me', expect.objectContaining({ credentials: 'same-origin' }));
  });
});

describe('exchangeSession', () => {
  it('posts the device-flow token response to /auth/exchange', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', spy);
    await exchangeSession(token);
    expect(spy).toHaveBeenCalledWith(
      '/auth/exchange',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 900 }),
      }),
    );
  });

  it('sends the POST with keepalive so it survives the tab closing', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', spy);
    await exchangeSession(token);
    expect(spy).toHaveBeenCalledWith(
      '/auth/exchange',
      expect.objectContaining({ keepalive: true }),
    );
  });

  it('resolves on 204 (session planted)', async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(exchangeSession(token)).resolves.toBeUndefined();
  });

  it.each([400, 401, 503])('rejects with ExchangeError(%d) so the page can branch', async (status) => {
    stubFetch(() => Promise.resolve(new Response(null, { status })));
    const err = await exchangeSession(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExchangeError);
    expect((err as ExchangeError).status).toBe(status);
  });

  it('rejects on network failure', async () => {
    stubFetch(() => Promise.reject(new Error('offline')));
    await expect(exchangeSession(token)).rejects.toThrow('offline');
  });
});

describe('logoutSession', () => {
  it('posts to /auth/logout with the session cookie', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', spy);
    await logoutSession();
    expect(spy).toHaveBeenCalledWith('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
  });

  it('resolves on 204 (session deleted and cookie cleared)', async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(logoutSession()).resolves.toBeUndefined();
  });

  it.each([400, 401, 503])('rejects with LogoutError(%d)', async (status) => {
    stubFetch(() => Promise.resolve(new Response(null, { status })));
    const err = await logoutSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LogoutError);
    expect((err as LogoutError).status).toBe(status);
  });

  it('rejects on network failure', async () => {
    stubFetch(() => Promise.reject(new Error('offline')));
    await expect(logoutSession()).rejects.toThrow('offline');
  });
});
