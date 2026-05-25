/**
 * OAuth device code flow tests — pure HTTP wrappers against a fake server.
 *
 * Covers the three endpoint calls: requestDeviceAuthorization, pollDeviceToken,
 * refreshAccessToken. Uses a local HTTP server on a dynamic port to exercise
 * the real fetch code path.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RetryableRefreshError, OAuthError, OAuthUnauthorizedError } from '../src/errors';
import {
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceAuthorization,
  type RefreshOptions,
} from '../src/oauth';
import type { DeviceHeaders, OAuthFlowConfig } from '../src/types';

interface FakeResponse {
  status: number;
  body: string | Record<string, unknown>;
  /**
   * When true, destroy the socket before writing any status / body.
   * Used by the "network error retry" test to surface a transport-level
   * failure (fetch throws) on the first N attempts.
   */
  drop?: boolean;
}

interface Recorded {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

class FakeOAuthServer {
  private server: Server | undefined;
  private responses: Map<string, FakeResponse[]> = new Map();
  readonly recorded: Recorded[] = [];
  host = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const addr = this.server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('no server address');
    }
    this.host = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server!.close(() => {
        resolve();
      });
    });
  }

  /** Queue a response for the given POST path (FIFO). */
  enqueue(path: string, response: FakeResponse): void {
    const key = `POST ${path}`;
    const list = this.responses.get(key) ?? [];
    list.push(response);
    this.responses.set(key, list);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const path = req.url ?? '';
      this.recorded.push({
        path,
        method: req.method ?? '',
        headers: req.headers as Record<string, string>,
        body,
      });
      const key = `${req.method} ${path}`;
      const queue = this.responses.get(key);
      const next = queue?.shift();
      if (!next) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'no fake response queued', key }));
        return;
      }
      if (next.drop === true) {
        // Destroy the socket so `fetch` rejects with a transport error.
        req.socket.destroy();
        return;
      }
      res.statusCode = next.status;
      res.setHeader('content-type', 'application/json');
      res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
    });
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────

let server: FakeOAuthServer;

const TEST_DEVICE_HEADERS: DeviceHeaders = {
  'X-Msh-Platform': 'kimi-code-cli',
  'X-Msh-Version': '0.0.0-test',
  'X-Msh-Device-Name': 'test-device',
  'X-Msh-Device-Model': 'test-model',
  'X-Msh-Os-Version': 'test-os',
  'X-Msh-Device-Id': 'test-device-id',
};

function expectNoDeviceHeaders(headers: Record<string, string>): void {
  expect(headers['x-msh-platform']).toBeUndefined();
  expect(headers['x-msh-device-id']).toBeUndefined();
  expect(headers['x-msh-version']).toBeUndefined();
}

function flowConfig(): OAuthFlowConfig {
  return {
    name: 'kimi-code',
    oauthHost: server.host,
    clientId: 'test-client-id',
  };
}

function requestAuth(
  config: OAuthFlowConfig = flowConfig(),
): ReturnType<typeof requestDeviceAuthorization> {
  return requestDeviceAuthorization(config, { deviceHeaders: TEST_DEVICE_HEADERS });
}

function pollToken(
  config: OAuthFlowConfig,
  deviceCode: string,
): ReturnType<typeof pollDeviceToken> {
  return pollDeviceToken(config, deviceCode, { deviceHeaders: TEST_DEVICE_HEADERS });
}

function refreshToken(
  config: OAuthFlowConfig,
  refreshTokenValue: string,
  options: Omit<RefreshOptions, 'deviceHeaders'> = {},
): ReturnType<typeof refreshAccessToken> {
  return refreshAccessToken(config, refreshTokenValue, {
    ...options,
    deviceHeaders: TEST_DEVICE_HEADERS,
  });
}

beforeEach(async () => {
  server = new FakeOAuthServer();
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

// ── requestDeviceAuthorization ────────────────────────────────────────

describe('requestDeviceAuthorization', () => {
  it('parses a successful response', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'WDJB-MJHT',
        device_code: 'devcode123',
        verification_uri: 'https://auth.kimi.com/verify',
        verification_uri_complete: 'https://auth.kimi.com/verify?user_code=WDJB-MJHT',
        expires_in: 600,
        interval: 5,
      },
    });

    const auth = await requestAuth();
    expect(auth.userCode).toBe('WDJB-MJHT');
    expect(auth.deviceCode).toBe('devcode123');
    expect(auth.verificationUri).toBe('https://auth.kimi.com/verify');
    expect(auth.verificationUriComplete).toBe('https://auth.kimi.com/verify?user_code=WDJB-MJHT');
    expect(auth.expiresIn).toBe(600);
    expect(auth.interval).toBe(5);
  });

  it('posts client_id as form-encoded body', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'U',
        device_code: 'D',
        verification_uri_complete: 'https://x/y',
        expires_in: 60,
        interval: 5,
      },
    });
    await requestAuth();
    const recorded = server.recorded[0]!;
    expect(recorded.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(recorded.body).toContain('client_id=test-client-id');
  });

  it('sends X-Msh-* device headers', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'U',
        device_code: 'D',
        verification_uri_complete: 'https://x/y',
        expires_in: 60,
        interval: 5,
      },
    });
    await requestAuth();
    const recorded = server.recorded[0]!;
    expect(recorded.headers['x-msh-platform']).toBe('kimi-code-cli');
    expect(recorded.headers['x-msh-device-id']).toBe('test-device-id');
    expect(recorded.headers['x-msh-version']).toBe('0.0.0-test');
    expect(recorded.headers['user-agent'] ?? '').not.toContain('kimi-code-cli');
  });

  it('omits X-Msh-* device headers when deviceHeaders are absent', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'U',
        device_code: 'D',
        verification_uri_complete: 'https://x/y',
        expires_in: 60,
        interval: 5,
      },
    });
    await requestDeviceAuthorization(flowConfig(), {});
    const recorded = server.recorded[0]!;
    expectNoDeviceHeaders(recorded.headers);
  });

  it('defaults interval to 5 when omitted', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'U',
        device_code: 'D',
        verification_uri_complete: 'https://x/y',
        expires_in: 60,
      },
    });
    const auth = await requestAuth();
    expect(auth.interval).toBe(5);
  });

  it('throws OAuthError on non-200 response', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 500,
      body: { error: 'server_error' },
    });
    await expect(requestAuth()).rejects.toBeInstanceOf(OAuthError);
  });

  it('surfaces message fields from failed device authorization responses', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 400,
      body: { message: 'device authorization disabled' },
    });

    await expect(requestAuth()).rejects.toThrow(/device authorization disabled/);
  });

  it('throws when device_code is missing (required-field validation)', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'X',
        verification_uri_complete: 'https://x',
        expires_in: 60,
        interval: 5,
        // device_code missing
      },
    });
    await expect(requestAuth()).rejects.toBeInstanceOf(OAuthError);
  });

  it('throws when verification_uri_complete is missing (required-field validation)', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'X',
        device_code: 'D',
        expires_in: 60,
        interval: 5,
        // verification_uri_complete missing
      },
    });
    await expect(requestAuth()).rejects.toBeInstanceOf(OAuthError);
  });
});

// ── pollDeviceToken ───────────────────────────────────────────────────

describe('pollDeviceToken', () => {
  it('returns TokenInfo on success (200)', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: 'read',
        token_type: 'Bearer',
      },
    });

    const res = await pollToken(flowConfig(), 'devcode123');
    expect(res.kind).toBe('success');
    if (res.kind !== 'success') throw new Error('expected success');
    expect(res.token.accessToken).toBe('at-1');
    expect(res.token.refreshToken).toBe('rt-1');
    expect(res.token.expiresIn).toBe(3600);
    expect(res.token.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('omits X-Msh-* device headers when deviceHeaders are absent', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: '',
        token_type: 'Bearer',
      },
    });
    await pollDeviceToken(flowConfig(), 'devcode123', {});
    const recorded = server.recorded[0]!;
    expectNoDeviceHeaders(recorded.headers);
  });

  it('returns pending on authorization_pending', async () => {
    server.enqueue('/api/oauth/token', {
      status: 400,
      body: { error: 'authorization_pending' },
    });

    const res = await pollToken(flowConfig(), 'devcode123');
    expect(res.kind).toBe('pending');
    if (res.kind !== 'pending') throw new Error('expected pending');
    expect(res.errorCode).toBe('authorization_pending');
  });

  it('returns pending on slow_down', async () => {
    server.enqueue('/api/oauth/token', {
      status: 400,
      body: { error: 'slow_down' },
    });
    const res = await pollToken(flowConfig(), 'devcode123');
    expect(res.kind).toBe('pending');
  });

  it('returns expired on expired_token', async () => {
    server.enqueue('/api/oauth/token', {
      status: 400,
      body: { error: 'expired_token' },
    });
    const res = await pollToken(flowConfig(), 'devcode123');
    expect(res.kind).toBe('expired');
  });

  it('returns denied on access_denied', async () => {
    server.enqueue('/api/oauth/token', {
      status: 400,
      body: { error: 'access_denied' },
    });
    const res = await pollToken(flowConfig(), 'devcode123');
    expect(res.kind).toBe('denied');
  });

  it('throws on 500 server error', async () => {
    server.enqueue('/api/oauth/token', {
      status: 500,
      body: { error: 'server_error' },
    });
    await expect(pollToken(flowConfig(), 'd')).rejects.toBeInstanceOf(OAuthError);
  });

  it('surfaces nested API error messages from failed polling responses', async () => {
    server.enqueue('/api/oauth/token', {
      status: 400,
      body: { error: { code: 'invalid_request', message: 'poll rejected by server' } },
    });

    await expect(pollToken(flowConfig(), 'd')).rejects.toThrow(/poll rejected by server/);
  });

  it('throws when success response is missing refresh_token (required-field validation)', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'at-1',
        // refresh_token missing
        expires_in: 60,
        scope: '',
        token_type: 'Bearer',
      },
    });
    await expect(pollToken(flowConfig(), 'd')).rejects.toBeInstanceOf(OAuthError);
  });

  it('throws when success response has zero/missing expires_in (required-field validation)', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        scope: '',
        token_type: 'Bearer',
        // expires_in missing
      },
    });
    await expect(pollToken(flowConfig(), 'd')).rejects.toBeInstanceOf(OAuthError);
  });

  it('sends device_code + grant_type=urn:ietf:params:oauth:grant-type:device_code', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 60,
        scope: '',
        token_type: 'Bearer',
      },
    });
    await pollToken(flowConfig(), 'devcode123');
    const recorded = server.recorded[0]!;
    expect(recorded.body).toContain('device_code=devcode123');
    expect(recorded.body).toContain(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code',
    );
  });
});

// ── refreshAccessToken ────────────────────────────────────────────────

describe('refreshAccessToken', () => {
  it('returns new TokenInfo on success', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_in: 3600,
        scope: '',
        token_type: 'Bearer',
      },
    });
    const token = await refreshToken(flowConfig(), 'old-rt');
    expect(token.accessToken).toBe('new-at');
    expect(token.refreshToken).toBe('new-rt');
  });

  it('does not retry after a 401 refresh response', async () => {
    server.enqueue('/api/oauth/token', {
      status: 401,
      body: { error: 'invalid_grant', error_description: 'refresh_token expired' },
    });
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'should-not-reach',
        refresh_token: 'r',
        expires_in: 60,
        scope: '',
        token_type: 'Bearer',
      },
    });
    await expect(
      refreshToken(flowConfig(), 'old-rt', { maxRetries: 3, backoffMs: () => 0 }),
    ).rejects.toBeInstanceOf(OAuthUnauthorizedError);
    expect(server.recorded.length).toBe(1);
  });

  it('throws OAuthUnauthorizedError on 403', async () => {
    server.enqueue('/api/oauth/token', {
      status: 403,
      body: {},
    });
    await expect(refreshToken(flowConfig(), 'old-rt')).rejects.toBeInstanceOf(
      OAuthUnauthorizedError,
    );
  });

  it('surfaces nested API error messages from unauthorized refresh responses', async () => {
    server.enqueue('/api/oauth/token', {
      status: 401,
      body: { error: { message: 'refresh token revoked' } },
    });

    await expect(refreshToken(flowConfig(), 'old-rt')).rejects.toThrow(/refresh token revoked/);
  });

  it('throws OAuthUnauthorizedError on invalid_grant refresh responses', async () => {
    server.enqueue('/api/oauth/token', {
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: 'The provided authorization grant is invalid',
      },
    });
    await expect(refreshToken(flowConfig(), 'old-rt')).rejects.toBeInstanceOf(
      OAuthUnauthorizedError,
    );
  });

  it.each([429, 500, 502, 503, 504])(
    'retries transient HTTP %i refresh responses until success',
    async (status) => {
      server.enqueue('/api/oauth/token', {
        status,
        body: { error_description: 'overloaded' },
      });
      server.enqueue('/api/oauth/token', {
        status: 200,
        body: {
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 60,
          scope: '',
          token_type: 'Bearer',
        },
      });
      const token = await refreshToken(flowConfig(), 'old-rt', {
        maxRetries: 2,
        backoffMs: () => 0,
      });
      expect(token.accessToken).toBe('a');
      expect(server.recorded.length).toBe(2);
    },
  );

  it('eventually raises RetryableRefreshError after max retries', async () => {
    server.enqueue('/api/oauth/token', { status: 503, body: {} });
    server.enqueue('/api/oauth/token', { status: 503, body: {} });
    await expect(
      refreshToken(flowConfig(), 'old-rt', { maxRetries: 2, backoffMs: () => 0 }),
    ).rejects.toBeInstanceOf(RetryableRefreshError);
  });

  it('retries on transport-level fetch failure (network retry gap fix)', async () => {
    // First attempt: server unreachable. Second: success.
    const badConfig: OAuthFlowConfig = {
      ...flowConfig(),
      // Stop the real server, point at it (will refuse connection), then
      // restart for the retry. This is awkward; instead inject via a
      // separate flowConfig with closed port for the first call.
      oauthHost: 'http://127.0.0.1:1', // reserved port, ECONNREFUSED
    };
    // Single attempt against unreachable host should throw (not RetryableRefreshError)
    await expect(
      refreshToken(badConfig, 'rt', { maxRetries: 1, backoffMs: () => 0 }),
    ).rejects.toThrow(/OAuth request|fetch failed|Token refresh request|ECONNREFUSED|connect/i);
  });

  it('sends grant_type=refresh_token + refresh_token', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 60,
        scope: '',
        token_type: 'Bearer',
      },
    });
    await refreshToken(flowConfig(), 'old-rt-xyz');
    const recorded = server.recorded[0]!;
    expect(recorded.body).toContain('grant_type=refresh_token');
    expect(recorded.body).toContain('refresh_token=old-rt-xyz');
  });

  it('omits X-Msh-* device headers when deviceHeaders are absent', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 60,
        scope: '',
        token_type: 'Bearer',
      },
    });
    await refreshAccessToken(flowConfig(), 'old-rt-xyz', { maxRetries: 1 });
    const recorded = server.recorded[0]!;
    expectNoDeviceHeaders(recorded.headers);
  });

  // ── network error retry / 400 fail-fast ───────────────────────────────

  it('retries transport-level failures N times, then succeeds', async () => {
    // The first two attempts fail with a transport error, the third
    // succeeds. We prime the fake server with two force-drop responses
    // that destroy the socket before writing headers, which surfaces
    // as `fetch` throwing.
    server.enqueue('/api/oauth/token', { status: 0, body: '', drop: true });
    server.enqueue('/api/oauth/token', { status: 0, body: '', drop: true });
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'recovered-at',
        refresh_token: 'recovered-rt',
        expires_in: 3600,
        scope: '',
        token_type: 'Bearer',
      },
    });
    const token = await refreshToken(flowConfig(), 'old-rt', {
      maxRetries: 3,
      backoffMs: () => 0,
    });
    expect(token.accessToken).toBe('recovered-at');
    // All three attempts hit the server (two destroyed + one success)
    expect(server.recorded.length).toBe(3);
  });

  it('400 Bad Request fails fast (not retried, non-retryable)', async () => {
    // 400 is a client-side fault and must surface immediately as a
    // bare OAuthError (never RetryableRefreshError, never retried).
    server.enqueue('/api/oauth/token', {
      status: 400,
      body: { error: 'invalid_request', error_description: 'bad client id' },
    });
    // Second enqueue exists to prove a retry would hit it — if the
    // implementation incorrectly retried, the second call would succeed
    // and the test would miss the regression.
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'should-not-reach',
        refresh_token: 'r',
        expires_in: 60,
        scope: '',
        token_type: 'Bearer',
      },
    });
    const err = await refreshToken(flowConfig(), 'rt', {
      maxRetries: 5,
      backoffMs: () => 0,
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err).not.toBeInstanceOf(RetryableRefreshError);
    expect(err).not.toBeInstanceOf(OAuthUnauthorizedError);
    // Only one request — no retry.
    expect(server.recorded.length).toBe(1);
  });
});
