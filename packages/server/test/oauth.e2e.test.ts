/**
 * `/v1/oauth/*` REST endpoints e2e tests (P2.7).
 *
 * **Strategy**: replace the real `IOAuthService` via a startup DI override,
 * so the routes go through their
 * full Fastify validation + envelope wrapping but never touch a real OAuth
 * host. We keep the `OAuthServiceImpl` itself out of scope here — the
 * services-package unit test (`oauth-service.test.ts`) covers its internal
 * state machine end-to-end.
 *
 * Coverage:
 *   - POST   /oauth/login   returns 200 + envelope { code:0, data: OAuthFlowStart }
 *   - GET    /oauth/login   returns 200 + envelope { code:0, data: null } before start
 *   - GET    /oauth/login   returns the snapshot after start
 *   - DELETE /oauth/login   returns { cancelled, status }
 *   - POST   /oauth/logout  returns { logged_out: true, provider }
 *   - body / query schema validation → 40001
 *   - device_code never appears in any response body
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  oauthFlowSnapshotSchema,
  oauthFlowStartSchema,
} from '@moonshot-ai/protocol';
import {
  IOAuthService,
} from '@moonshot-ai/agent-core';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
} from '@moonshot-ai/protocol';

import { IRestGateway, startServer, type RunningServer } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-oauth-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-oauth-home-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

interface StubOAuth {
  startLogin: (provider?: string) => Promise<OAuthFlowStart>;
  getFlow: (provider?: string) => OAuthFlowSnapshot | undefined;
  cancelLogin: (provider?: string) => Promise<OAuthLoginCancelResponse>;
  logout: (provider?: string) => Promise<OAuthLogoutResponse>;
  calls: {
    start: Array<{ provider: string | undefined }>;
    get: Array<{ provider: string | undefined }>;
    cancel: Array<{ provider: string | undefined }>;
    logout: Array<{ provider: string | undefined }>;
  };
}

/** Build a stub service with scripted responses. */
function makeStub(scripted: {
  start?: OAuthFlowStart;
  snapshot?: OAuthFlowSnapshot | undefined;
  cancel?: OAuthLoginCancelResponse;
  logout?: OAuthLogoutResponse;
}): StubOAuth {
  const calls = {
    start: [] as Array<{ provider: string | undefined }>,
    get: [] as Array<{ provider: string | undefined }>,
    cancel: [] as Array<{ provider: string | undefined }>,
    logout: [] as Array<{ provider: string | undefined }>,
  };
  const defaultStart: OAuthFlowStart = {
    flow_id: 'oauth_01ABCDEFGH',
    provider: 'managed:kimi-code',
    verification_uri: 'https://example.com/device',
    verification_uri_complete: 'https://example.com/device?user_code=KIMI-1234',
    user_code: 'KIMI-1234',
    expires_in: 900,
    interval: 5,
    status: 'pending',
    expires_at: '2026-06-05T08:00:00.000Z',
  };
  return {
    calls,
    startLogin: async (provider) => {
      calls.start.push({ provider });
      return scripted.start ?? defaultStart;
    },
    getFlow: (provider) => {
      calls.get.push({ provider });
      return scripted.snapshot;
    },
    cancelLogin: async (provider) => {
      calls.cancel.push({ provider });
      return scripted.cancel ?? { cancelled: false, status: 'cancelled' };
    },
    logout: async (provider) => {
      calls.logout.push({ provider });
      return scripted.logout ?? { logged_out: true, provider: 'managed:kimi-code' };
    },
  };
}

async function bootDaemon(stub: StubOAuth): Promise<RunningServer> {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    serviceOverrides: [[IOAuthService, stub]],
  });
  return server;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
    };
  });
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
    details?: unknown;
  };
}

describe('POST /api/v1/oauth/login (P2.7)', () => {
  it('returns 200 + envelope { code:0, data: OAuthFlowStart }', async () => {
    const stub = makeStub({});
    const r = await bootDaemon(stub);
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/oauth/login',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<OAuthFlowStart>(res.json());
    expect(env.code).toBe(0);
    const data = oauthFlowStartSchema.parse(env.data);
    expect(data.flow_id).toBe('oauth_01ABCDEFGH');
    expect(data.verification_uri_complete).toBe(
      'https://example.com/device?user_code=KIMI-1234',
    );
    expect(stub.calls.start).toEqual([{ provider: undefined }]);
  });

  it('passes through the optional provider field', async () => {
    const stub = makeStub({});
    const r = await bootDaemon(stub);
    await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/oauth/login',
      payload: { provider: 'managed:other' },
    });
    expect(stub.calls.start[0]?.provider).toBe('managed:other');
  });

  it('rejects an invalid provider field with 40001', async () => {
    const stub = makeStub({});
    const r = await bootDaemon(stub);
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/oauth/login',
      payload: { provider: 123 },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });
});

describe('GET /api/v1/oauth/login (P2.7)', () => {
  it('returns 200 + envelope { code:0, data: null } when no flow is registered', async () => {
    const stub = makeStub({ snapshot: undefined });
    const r = await bootDaemon(stub);
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/oauth/login',
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).toBeNull();
  });

  it('returns the snapshot when present', async () => {
    const snap: OAuthFlowSnapshot = {
      flow_id: 'oauth_01ABCDEFGH',
      provider: 'managed:kimi-code',
      status: 'pending',
      verification_uri: 'https://example.com/device',
      verification_uri_complete: 'https://example.com/device?user_code=KIMI-1234',
      user_code: 'KIMI-1234',
      expires_in: 900,
      expires_at: '2026-06-05T08:00:00.000Z',
      interval: 5,
    };
    const stub = makeStub({ snapshot: snap });
    const r = await bootDaemon(stub);
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/oauth/login',
    });
    const env = envelopeOf<OAuthFlowSnapshot>(res.json());
    expect(env.code).toBe(0);
    const parsed = oauthFlowSnapshotSchema.parse(env.data);
    expect(parsed.status).toBe('pending');
    // Wire must not leak device_code.
    expect(JSON.stringify(env)).not.toContain('device_code');
  });

  it('reflects terminal-state snapshots', async () => {
    const snap: OAuthFlowSnapshot = {
      flow_id: 'oauth_01ABCDEFGH',
      provider: 'managed:kimi-code',
      status: 'authenticated',
      verification_uri: 'https://example.com/device',
      verification_uri_complete: 'https://example.com/device?user_code=KIMI-1234',
      user_code: 'KIMI-1234',
      expires_in: 900,
      expires_at: '2026-06-05T08:00:00.000Z',
      interval: 5,
      resolved_at: '2026-06-05T07:50:00.000Z',
    };
    const stub = makeStub({ snapshot: snap });
    const r = await bootDaemon(stub);
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/oauth/login',
    });
    const env = envelopeOf<OAuthFlowSnapshot>(res.json());
    const parsed = oauthFlowSnapshotSchema.parse(env.data);
    expect(parsed.status).toBe('authenticated');
    expect(parsed.resolved_at).toBe('2026-06-05T07:50:00.000Z');
  });
});

describe('DELETE /api/v1/oauth/login (P2.7)', () => {
  it('returns { cancelled:true, status:cancelled } on a pending flow', async () => {
    const stub = makeStub({
      cancel: { cancelled: true, status: 'cancelled' },
    });
    const r = await bootDaemon(stub);
    const res = await appOf(r).inject({
      method: 'DELETE',
      url: '/api/v1/oauth/login',
    });
    const env = envelopeOf<OAuthLoginCancelResponse>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).toEqual({ cancelled: true, status: 'cancelled' });
  });

  it('idempotently reports the current status on terminal flows', async () => {
    const stub = makeStub({
      cancel: { cancelled: false, status: 'authenticated' },
    });
    const r = await bootDaemon(stub);
    const res = await appOf(r).inject({
      method: 'DELETE',
      url: '/api/v1/oauth/login',
    });
    const env = envelopeOf<OAuthLoginCancelResponse>(res.json());
    expect(env.data).toEqual({ cancelled: false, status: 'authenticated' });
  });
});

describe('POST /api/v1/oauth/logout (P2.7)', () => {
  it('returns { logged_out:true, provider }', async () => {
    const stub = makeStub({});
    const r = await bootDaemon(stub);
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/oauth/logout',
      payload: {},
    });
    const env = envelopeOf<OAuthLogoutResponse>(res.json());
    expect(env.code).toBe(0);
    expect(env.data).toEqual({
      logged_out: true,
      provider: 'managed:kimi-code',
    });
    expect(stub.calls.logout).toHaveLength(1);
  });

  it('passes the provider field through', async () => {
    const stub = makeStub({
      logout: { logged_out: true, provider: 'managed:other' },
    });
    const r = await bootDaemon(stub);
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/oauth/logout',
      payload: { provider: 'managed:other' },
    });
    const env = envelopeOf<OAuthLogoutResponse>(res.json());
    expect(env.data?.provider).toBe('managed:other');
  });
});
