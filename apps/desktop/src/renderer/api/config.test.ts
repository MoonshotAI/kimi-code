import { afterEach, describe, expect, it, vi } from 'vitest';

import { readKimiApiConfig, serverEndpointLabel } from './config';

function setWindowLocation(search: string, origin = 'app://renderer'): void {
  vi.stubGlobal('window', { location: { search, origin } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('kimi_origin query injection (desktop app:// renderer)', () => {
  it('readKimiApiConfig prefers the injected origin over env', () => {
    vi.stubEnv('VITE_KIMI_SERVER_HTTP_URL', 'http://10.0.0.5:9999');
    setWindowLocation('?kimi_origin=http%3A%2F%2F127.0.0.1%3A4242');

    // URLSearchParams.get already percent-decodes the value; the resolver must
    // pass it straight to normalizeServerOrigin (no double decodeURIComponent).
    expect(readKimiApiConfig().serverHttpUrl).toBe('http://127.0.0.1:4242');
  });

  it('serverEndpointLabel reflects the injected origin', () => {
    vi.stubEnv('VITE_KIMI_SERVER_HTTP_URL', '');
    setWindowLocation('?kimi_origin=http%3A%2F%2F127.0.0.1%3A4242');

    // The desktop ships a production bundle (DEV=false), where the dev-proxy
    // gate is closed and the injected origin wins. Vitest runs with DEV=true,
    // so close the gate here to exercise the same branch production hits.
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
});
