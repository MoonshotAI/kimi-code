import { afterEach, describe, expect, it, vi } from 'vitest';

import { readKimiApiConfig, serverEndpointLabel } from './config';

function setWindowLocation(search: string, origin = 'app://renderer'): void {
  vi.stubGlobal('window', { location: { search, origin } });
}

function setWindowLocationWithSession(search: string, session: Record<string, string>): void {
  vi.stubGlobal('window', {
    location: { search, origin: 'app://renderer' },
    sessionStorage: {
      getItem: (k: string) => session[k] ?? null,
      setItem: (k: string, v: string) => {
        session[k] = v;
      },
      removeItem: (k: string) => {
        delete session[k];
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('kimi_origin query injection (desktop app:// renderer)', () => {
  it('readKimiApiConfig prefers the injected origin over env', () => {
    vi.stubEnv('VITE_KIMI_SERVER_HTTP_URL', 'http://10.0.0.5:9999');
    setWindowLocation('?kimi_origin=http%3A%2F%2F127.0.0.1%3A4242');

    expect(readKimiApiConfig().serverHttpUrl).toBe('http://127.0.0.1:4242');
  });

  it('serverEndpointLabel reflects the injected origin', () => {
    vi.stubEnv('VITE_KIMI_SERVER_HTTP_URL', '');
    setWindowLocation('?kimi_origin=http%3A%2F%2F127.0.0.1%3A4242');

    const env = import.meta.env as { DEV: boolean };
    const prevDev = env.DEV;
    env.DEV = false;
    try {
      expect(serverEndpointLabel()).toBe('127.0.0.1:4242');
    } finally {
      env.DEV = prevDev;
    }
  });

  it('falls back to VITE_KIMI_SERVER_HTTP_URL when no kimi_origin is present', () => {
    vi.stubEnv('VITE_KIMI_SERVER_HTTP_URL', 'http://10.0.0.5:9999');
    setWindowLocation('');

    expect(readKimiApiConfig().serverHttpUrl).toBe('http://10.0.0.5:9999');
    expect(serverEndpointLabel()).toBe('10.0.0.5:9999');
  });

  it('survives a reload that dropped the query string (sessionStorage cache)', () => {
    const session: Record<string, string> = {};
    setWindowLocationWithSession('?kimi_origin=http%3A%2F%2F127.0.0.1%3A4242', session);
    expect(readKimiApiConfig().serverHttpUrl).toBe('http://127.0.0.1:4242');
    expect(session['kimi-desktop-server-origin']).toBe('http://127.0.0.1:4242');
    setWindowLocationWithSession('', session);
    expect(readKimiApiConfig().serverHttpUrl).toBe('http://127.0.0.1:4242');
  });

  it('a fresh launch query overwrites the stored origin', () => {
    const session: Record<string, string> = {
      'kimi-desktop-server-origin': 'http://127.0.0.1:1111',
    };
    setWindowLocationWithSession('?kimi_origin=http%3A%2F%2F127.0.0.1%3A2222', session);
    expect(readKimiApiConfig().serverHttpUrl).toBe('http://127.0.0.1:2222');
    expect(session['kimi-desktop-server-origin']).toBe('http://127.0.0.1:2222');
  });
});
