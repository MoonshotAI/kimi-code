import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pollDeviceToken,
  type DeviceAuthorization,
} from '@moonshot-ai/kimi-code-oauth/device';
import { createAuthLoginFlow, oauthHostForHostname } from '../src/flow';

vi.mock('@moonshot-ai/kimi-code-oauth/device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-oauth/device')>();
  return {
    ...actual,
    pollDeviceToken: vi.fn(),
  };
});

const pollDeviceTokenMock = vi.mocked(pollDeviceToken);

const deviceAuthorization: DeviceAuthorization = {
  userCode: 'ABCD-EFGH',
  deviceCode: 'dc_1',
  verificationUri: 'https://example.com/device',
  verificationUriComplete: 'https://example.com/device?code=ABCD',
  expiresIn: 900,
  interval: 5,
};

function deviceAuthorizationResponse(): Response {
  return new Response(JSON.stringify({
    user_code: deviceAuthorization.userCode,
    device_code: deviceAuthorization.deviceCode,
    verification_uri: deviceAuthorization.verificationUri,
    verification_uri_complete: deviceAuthorization.verificationUriComplete,
    expires_in: deviceAuthorization.expiresIn,
    interval: deviceAuthorization.interval,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  vi.stubGlobal('location', { hostname: 'localhost' });
  vi.stubGlobal('navigator', { onLine: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stubFetch(() => Promise.resolve(deviceAuthorizationResponse()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('oauthHostForHostname', () => {
  it('maps .kimi.ai hosts to the global OAuth host', () => {
    expect(oauthHostForHostname('kimi.ai')).toBe('https://auth.kimi.ai');
    expect(oauthHostForHostname('www.kimi.ai')).toBe('https://auth.kimi.ai');
    expect(oauthHostForHostname('code.kimi.ai')).toBe('https://auth.kimi.ai');
  });

  it('maps everything else to the mainland-China OAuth host', () => {
    expect(oauthHostForHostname('kimi.com')).toBe('https://auth.kimi.com');
    expect(oauthHostForHostname('www.kimi.com')).toBe('https://auth.kimi.com');
    expect(oauthHostForHostname('localhost')).toBe('https://auth.kimi.com');
    expect(oauthHostForHostname('127.0.0.1')).toBe('https://auth.kimi.com');
  });

  it('does not match lookalike suffixes', () => {
    expect(oauthHostForHostname('kimi.ai.evil.example.com')).toBe('https://auth.kimi.com');
    expect(oauthHostForHostname('notkimi.ai')).toBe('https://auth.kimi.com');
  });
});

describe('onStartOAuthLogin', () => {
  it('returns the device authorization without a start error', async () => {
    const flow = createAuthLoginFlow();
    const result = await flow.callbacks.onStartOAuthLogin();
    expect(result).toMatchObject({
      flowId: 'dc_1',
      status: 'pending',
      userCode: 'ABCD-EFGH',
      expiresIn: 900,
      interval: 5,
    });
    expect(flow.startError()).toBeNull();
  });

  it('posts the client ID to the selected OAuth host', async () => {
    const spy = vi.mocked(fetch);
    const flow = createAuthLoginFlow();
    await flow.callbacks.onStartOAuthLogin();
    expect(spy).toHaveBeenCalledWith(
      'https://auth.kimi.com/api/oauth/device_authorization',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('client_id='),
      }),
    );
  });

  it.each([
    [429, 'rate-limited'],
    [503, 'service-unavailable'],
    [400, 'request-rejected'],
  ])('classifies HTTP %d as %s with diagnostics', async (status, kind) => {
    stubFetch(() => Promise.resolve(new Response(JSON.stringify({
      error_description: 'Authorization service rejected the request',
    }), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req_test_123',
      },
    })));
    const flow = createAuthLoginFlow();
    await expect(flow.callbacks.onStartOAuthLogin()).resolves.toBeNull();
    expect(flow.startError()).toMatchObject({
      kind,
      code: `AUTH_START_HTTP_${status}`,
      status,
      requestId: 'req_test_123',
      oauthHost: 'auth.kimi.com',
      description: 'Authorization service rejected the request',
    });
  });

  it('classifies an offline browser separately from other connection failures', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const flow = createAuthLoginFlow();
    await flow.callbacks.onStartOAuthLogin();
    expect(flow.startError()).toMatchObject({
      kind: 'offline',
      code: 'AUTH_START_OFFLINE',
      description: 'Failed to fetch',
    });
  });

  it('classifies a fetch rejection as a connection failure', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const flow = createAuthLoginFlow();
    await flow.callbacks.onStartOAuthLogin();
    expect(flow.startError()).toMatchObject({
      kind: 'connection',
      code: 'AUTH_START_CONNECTION',
    });
  });

  it('classifies request timeouts', async () => {
    stubFetch(() => Promise.reject(new DOMException('Timed out', 'TimeoutError')));
    const flow = createAuthLoginFlow();
    await flow.callbacks.onStartOAuthLogin();
    expect(flow.startError()).toMatchObject({
      kind: 'timeout',
      code: 'AUTH_START_TIMEOUT',
    });
  });

  it('classifies a successful response with missing fields as invalid', async () => {
    stubFetch(() => Promise.resolve(new Response(JSON.stringify({ user_code: 'ABCD-EFGH' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const flow = createAuthLoginFlow();
    await flow.callbacks.onStartOAuthLogin();
    expect(flow.startError()).toMatchObject({
      kind: 'invalid-response',
      code: 'AUTH_START_INVALID_RESPONSE',
    });
  });

  it('clears the previous start error when a retry succeeds', async () => {
    const spy = stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const flow = createAuthLoginFlow();
    await flow.callbacks.onStartOAuthLogin();
    expect(flow.startError()?.kind).toBe('connection');
    spy.mockImplementation(() => Promise.resolve(deviceAuthorizationResponse()));
    await flow.callbacks.onStartOAuthLogin();
    expect(flow.startError()).toBeNull();
  });
});

describe('onPollOAuthLogin', () => {
  it('passes a denied poll through as the denied status', async () => {
    pollDeviceTokenMock.mockResolvedValue({
      kind: 'denied',
      description: 'The resource owner denied the request',
    });
    const flow = createAuthLoginFlow();
    await flow.callbacks.onStartOAuthLogin();
    const result = await flow.callbacks.onPollOAuthLogin();
    expect(result?.status).toBe('denied');
  });

  it('maps an expired poll to the expired status', async () => {
    pollDeviceTokenMock.mockResolvedValue({ kind: 'expired' });
    const flow = createAuthLoginFlow();
    await flow.callbacks.onStartOAuthLogin();
    const result = await flow.callbacks.onPollOAuthLogin();
    expect(result?.status).toBe('expired');
  });
});
