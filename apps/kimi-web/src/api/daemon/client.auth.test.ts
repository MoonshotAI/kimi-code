import { afterEach, describe, expect, it, vi } from 'vitest';

import { DaemonKimiWebApi } from './client';

const config = {
  serverHttpUrl: 'http://127.0.0.1:58627',
  clientId: 'web-test',
  clientName: 'kimi-code-web',
  clientVersion: '0.0.0-test',
  clientUiMode: 'web',
};

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: 'OK', data, request_id: 'request-1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DaemonKimiWebApi auth', () => {
  it('maps every OAuth provider from the auth summary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({
      ready: true,
      providers_count: 2,
      default_model: 'openai-codex/gpt-test',
      managed_provider: null,
      oauth_providers: [
        {
          name: 'managed:kimi-code',
          status: 'authenticated',
          active: false,
          entitlement_status: 'membership_required',
        },
        { name: 'openai-codex', status: 'authenticated', active: true },
      ],
    })));

    await expect(new DaemonKimiWebApi(config).getAuth()).resolves.toMatchObject({
      oauthProviders: [
        {
          name: 'managed:kimi-code',
          status: 'authenticated',
          active: false,
          entitlementStatus: 'membership_required',
        },
        { name: 'openai-codex', status: 'authenticated', active: true },
      ],
    });
  });

  it('maps the legacy managed provider when oauth_providers is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({
      ready: true,
      providers_count: 1,
      default_model: 'kimi-code/kimi-k2',
      managed_provider: { name: 'managed:kimi-code', status: 'authenticated' },
    })));

    await expect(new DaemonKimiWebApi(config).getAuth()).resolves.toMatchObject({
      oauthProviders: [
        { name: 'managed:kimi-code', status: 'authenticated', active: true },
      ],
    });
  });

  it('sends the selected provider in the logout request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({
      logged_out: true,
      provider: 'openai-codex',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DaemonKimiWebApi(config).logout('openai-codex')).resolves.toEqual({
      loggedOut: true,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ provider: 'openai-codex' }));
  });

  it('keeps start, poll, and cancel bound to the selected OAuth provider', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({
        flow_id: 'flow-1',
        provider: 'openai-codex',
        status: 'pending',
        verification_uri: 'https://auth.example.test/device',
        verification_uri_complete: 'https://auth.example.test/device',
        user_code: 'ABCD-EFGH',
        expires_in: 900,
        interval: 5,
        expires_at: '2026-07-22T12:00:00.000Z',
      }))
      .mockResolvedValueOnce(ok({
        flow_id: 'flow-1',
        provider: 'openai-codex',
        status: 'pending',
        verification_uri: 'https://auth.example.test/device',
        verification_uri_complete: 'https://auth.example.test/device',
        user_code: 'ABCD-EFGH',
        expires_in: 900,
        interval: 5,
        expires_at: '2026-07-22T12:00:00.000Z',
      }))
      .mockResolvedValueOnce(ok({ cancelled: true, status: 'cancelled' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new DaemonKimiWebApi(config);

    await api.startOAuthLogin('openai-codex', { preserveDefaultModel: true });
    await api.pollOAuthLogin('openai-codex');
    await api.cancelOAuthLogin('openai-codex');

    const [, startInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(startInit.body).toBe(JSON.stringify({
      provider: 'openai-codex',
      preserve_default_model: true,
    }));
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      '/oauth/login?provider=openai-codex',
    );
    const [cancelUrl, cancelInit] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(String(cancelUrl)).toContain('/oauth/login?provider=openai-codex');
    expect(cancelInit.method).toBe('DELETE');
  });

  it('maps an immediate OAuth denial with its provider error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({
      flow_id: 'flow-denied',
      provider: 'managed:kimi-code',
      status: 'denied',
      error_message: 'Kimi Code membership is not active.',
    })));

    await expect(
      new DaemonKimiWebApi(config).startOAuthLogin('managed:kimi-code', {
        preserveDefaultModel: false,
      }),
    ).resolves.toEqual({
      flowId: 'flow-denied',
      provider: 'managed:kimi-code',
      status: 'denied',
      errorMessage: 'Kimi Code membership is not active.',
    });
  });

  it('maps a polled OAuth denial with its provider error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({
      flow_id: 'flow-denied',
      status: 'denied',
      resolved_at: '2026-07-23T12:00:00.000Z',
      error_message: 'Kimi Code membership is not active.',
    })));

    await expect(
      new DaemonKimiWebApi(config).pollOAuthLogin('managed:kimi-code'),
    ).resolves.toEqual({
      flowId: 'flow-denied',
      status: 'denied',
      resolvedAt: '2026-07-23T12:00:00.000Z',
      errorMessage: 'Kimi Code membership is not active.',
    });
  });
});
