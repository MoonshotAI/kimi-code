import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IOAuthService,
  type IOAuthService as IOAuthServiceType,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import {
  managedUserInfoResultSchema,
  managedUsageResultSchema,
  type ManagedUserInfoResult,
  type ManagedUsageResult,
} from '@moonshot-ai/agent-core-v2/app/auth/oauthProtocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 GET /api/v1/oauth/usage', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-oauth-usage-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  function oauthStub(getManagedUsage: IOAuthServiceType['getManagedUsage']): IOAuthServiceType {
    return {
      _serviceBrand: undefined,
      startLogin: async () => {
        throw new Error('unused');
      },
      getFlow: () => undefined,
      cancelLogin: async () => {
        throw new Error('unused');
      },
      logout: async () => {
        throw new Error('unused');
      },
      status: async () => ({ loggedIn: false }),
      refreshOAuthProviderModels: async () => ({ changed: [], unchanged: [], failed: [] }),
      getManagedUsage,
      getManagedUserInfo: async () => ({ kind: 'error' as const, message: 'unused' }),
      resolveTokenProvider: () => undefined,
      getCachedAccessToken: async () => undefined,
      getRegion: () => 'mainland-cn',
    };
  }

  async function boot(seeds: ScopeSeed): Promise<void> {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getUsage(query = ''): Promise<ManagedUsageResult> {
    const res = await fetch(`${base}/api/v1/oauth/usage${query}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ManagedUsageResult>;
    expect(body.code).toBe(0);
    return managedUsageResultSchema.parse(body.data);
  }

  it('maps the ok usage payload to the snake_case wire shape', async () => {
    const getManagedUsage = vi.fn(async () => ({
      kind: 'ok' as const,
      summary: {
        name: 'Weekly limit',
        window: { duration: 1, unit: 'week' as const },
        used: 40,
        limit: 1000,
        resetAt: '2030-01-01T00:00:00.000Z',
      },
      limits: [
        { name: '5h limit', window: { duration: 5, unit: 'hour' as const }, used: 1, limit: 100 },
        { used: 2, limit: 50 },
      ],
      extraUsage: {
        balanceCents: 500,
        totalCents: 1000,
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimitCents: 2000,
        monthlyUsedCents: 1500,
        currency: 'CNY',
      },
    }));
    await boot([[IOAuthService, oauthStub(getManagedUsage)]] as unknown as ScopeSeed);

    expect(await getUsage()).toEqual({
      kind: 'ok',
      summary: {
        name: 'Weekly limit',
        window: { duration: 1, unit: 'week' },
        used: 40,
        limit: 1000,
        reset_at: '2030-01-01T00:00:00.000Z',
      },
      limits: [
        { name: '5h limit', window: { duration: 5, unit: 'hour' }, used: 1, limit: 100 },
        { used: 2, limit: 50 },
      ],
      extra_usage: {
        balance_cents: 500,
        total_cents: 1000,
        monthly_charge_limit_enabled: true,
        monthly_charge_limit_cents: 2000,
        monthly_used_cents: 1500,
        currency: 'CNY',
      },
    });
  });

  it('passes through the error payload and forwards the provider query', async () => {
    const getManagedUsage = vi.fn(async (_provider?: string) => ({
      kind: 'error' as const,
      message: 'Authorization failed.',
      status: 401,
    }));
    await boot([[IOAuthService, oauthStub(getManagedUsage)]] as unknown as ScopeSeed);

    expect(await getUsage('?provider=managed%3Akimi-code')).toEqual({
      kind: 'error',
      message: 'Authorization failed.',
      status: 401,
    });
    expect(getManagedUsage).toHaveBeenCalledWith('managed:kimi-code');
  });
});

describe('server-v2 GET /api/v1/oauth/userinfo', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-oauth-userinfo-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  function oauthStub(getManagedUserInfo: IOAuthServiceType['getManagedUserInfo']): IOAuthServiceType {
    return {
      _serviceBrand: undefined,
      startLogin: async () => {
        throw new Error('unused');
      },
      getFlow: () => undefined,
      cancelLogin: async () => {
        throw new Error('unused');
      },
      logout: async () => {
        throw new Error('unused');
      },
      status: async () => ({ loggedIn: false }),
      refreshOAuthProviderModels: async () => ({ changed: [], unchanged: [], failed: [] }),
      getManagedUsage: async () => ({ kind: 'error' as const, message: 'unused' }),
      getManagedUserInfo,
      resolveTokenProvider: () => undefined,
      getCachedAccessToken: async () => undefined,
      getRegion: () => 'mainland-cn',
    };
  }

  async function boot(seeds: ScopeSeed): Promise<void> {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getUserInfo(query = ''): Promise<ManagedUserInfoResult> {
    const res = await fetch(`${base}/api/v1/oauth/userinfo${query}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ManagedUserInfoResult>;
    expect(body.code).toBe(0);
    return managedUserInfoResultSchema.parse(body.data);
  }

  it('returns the ok profile payload in the camelCase domain shape', async () => {
    const getManagedUserInfo = vi.fn(async () => ({
      kind: 'ok' as const,
      userInfo: {
        userId: 'u_123',
        nickname: 'moonwalker',
        status: 'USER_STATUS_NORMAL',
        region: 'REGION_CN',
        userLevel: 30,
        userLevelName: 'Vivace',
        domain: 1,
        domainName: 'DOMAIN_EXAMPLE',
        globalId: 'u_123',
        avatar: 'https://example.com/avatar.png',
        username: 'moonwalker2333',
        email: 'user@example.com',
        phone: { countryCode: '86', number: '176****0000' },
        createdTime: '2026-06-11T13:26:47.561184Z',
        lastLoginTime: '2026-07-16T03:12:03.033412Z',
      },
    }));
    await boot([[IOAuthService, oauthStub(getManagedUserInfo)]] as unknown as ScopeSeed);

    expect(await getUserInfo()).toEqual({
      kind: 'ok',
      userInfo: {
        userId: 'u_123',
        nickname: 'moonwalker',
        status: 'USER_STATUS_NORMAL',
        region: 'REGION_CN',
        userLevel: 30,
        userLevelName: 'Vivace',
        domain: 1,
        domainName: 'DOMAIN_EXAMPLE',
        globalId: 'u_123',
        avatar: 'https://example.com/avatar.png',
        username: 'moonwalker2333',
        email: 'user@example.com',
        phone: { countryCode: '86', number: '176****0000' },
        createdTime: '2026-06-11T13:26:47.561184Z',
        lastLoginTime: '2026-07-16T03:12:03.033412Z',
      },
    });
  });

  it('passes through the error payload and forwards the provider query', async () => {
    const getManagedUserInfo = vi.fn(async (_provider?: string) => ({
      kind: 'error' as const,
      message: 'Authorization failed.',
      status: 401,
    }));
    await boot([[IOAuthService, oauthStub(getManagedUserInfo)]] as unknown as ScopeSeed);

    expect(await getUserInfo('?provider=managed%3Akimi-code')).toEqual({
      kind: 'error',
      message: 'Authorization failed.',
      status: 401,
    });
    expect(getManagedUserInfo).toHaveBeenCalledWith('managed:kimi-code');
  });
});
