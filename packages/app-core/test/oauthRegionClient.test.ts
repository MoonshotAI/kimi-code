import { describe, expect, it, vi } from 'vitest';
import { DaemonKimiWebApi } from '../src/api/daemon/client';

const identity = {
  clientId: 'web_t',
  clientName: 't',
  clientVersion: '0',
  clientUiMode: 'web',
};

function makeApi() {
  return new DaemonKimiWebApi({
    origin: 'http://test.local',
    identity,
    projectorFactory: () => {
      throw new Error('projector not needed for REST-only tests');
    },
  });
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data, request_id: 'req_t' }));
}

const pendingLoginStart = {
  flow_id: 'flow_1',
  provider: 'kimi',
  status: 'pending',
  verification_uri: 'https://example.com/device',
  verification_uri_complete: 'https://example.com/device?code=ABCD',
  user_code: 'ABCD',
  expires_in: 600,
  interval: 5,
  expires_at: '2026-08-12T00:10:00Z',
};

describe('DaemonKimiWebApi.startOAuthLogin region', () => {
  it('POSTs an empty body when no region is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(pendingLoginStart));
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().startOAuthLogin();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/oauth/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('POSTs the chosen region in the body', async () => {
    // Fresh Response per call: a reused instance's body is consumed once.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(envelope(pendingLoginStart)));
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().startOAuthLogin('global');
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({
      region: 'global',
    });

    await makeApi().startOAuthLogin('mainland-cn');
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)).toEqual({
      region: 'mainland-cn',
    });
  });
});

describe('DaemonKimiWebApi.getOAuthRegion', () => {
  it('GETs /oauth/region and returns the resolved region', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ region: 'global' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().getOAuthRegion();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/oauth/region');
    expect(init.method).toBe('GET');
    expect(result).toBe('global');
  });

  it('returns null when the endpoint does not exist (older daemon 404)', async () => {
    // A bare fastify 404 body is not an envelope — the client must degrade.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 404, error: 'Not Found', message: 'Route GET:/api/v1/oauth/region not found' }), { status: 404 }),
    ));

    await expect(makeApi().getOAuthRegion()).resolves.toBeNull();
  });

  it('returns null on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(makeApi().getOAuthRegion()).resolves.toBeNull();
  });

  it('returns null on an unknown region value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ region: 'apac' })));

    await expect(makeApi().getOAuthRegion()).resolves.toBeNull();
  });
});

describe('DaemonKimiWebApi.getOAuthRegion timeout', () => {
  it('degrades to null when the daemon route hangs past the probe bound', async () => {
    vi.useFakeTimers();
    try {
      // A half-dead daemon: never responds. The probe must not wait for the
      // generic request timeout — it degrades to null after ~5s.
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
      const result = makeApi().getOAuthRegion();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
