import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IOAuthService,
  type IOAuthService as IOAuthServiceType,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import {
  managedUsageResultSchema,
  managedUserInfoResultSchema,
  oauthManagedWorkspacesResultSchema,
  oauthWorkspaceSwitchResponseSchema,
  type ManagedUsageResult,
  type ManagedUserInfoResult,
  type OAuthManagedWorkspacesResult,
  type OAuthWorkspaceSwitchResponse,
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
      listManagedWorkspaces: async () => ({ kind: 'error' as const, message: 'unused' }),
      switchManagedWorkspace: async () => ({ kind: 'error' as const, message: 'unused' }),
      resolveTokenProvider: () => undefined,
      getCachedAccessToken: async () => undefined,
      getRegion: () => 'mainland-cn',
      getRegionAsync: async () => 'mainland-cn',
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

  it('returns the ok quota payload in the camelCase domain shape', async () => {
    const getManagedUsage = vi.fn(async () => ({
      kind: 'ok' as const,
      quota: {
        usages: {
          limit5h: { usedRatio: 0.3, resetAt: '2030-01-01T00:00:00.000Z' },
          monthTotal: { usedRatio: 0.4, resetAt: '2030-02-01T00:00:00.000Z' },
          monthCode: { usedRatio: 0.25 },
        },
        extraUsage: {
          balanceCents: 500,
          totalCents: 1000,
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimitCents: 2000,
          monthlyUsedCents: 1500,
          currency: 'CNY',
        },
      },
    }));
    await boot([[IOAuthService, oauthStub(getManagedUsage)]] as unknown as ScopeSeed);

    expect(await getUsage()).toEqual({
      kind: 'ok',
      quota: {
        usages: {
          limit5h: { usedRatio: 0.3, resetAt: '2030-01-01T00:00:00.000Z' },
          monthTotal: { usedRatio: 0.4, resetAt: '2030-02-01T00:00:00.000Z' },
          monthCode: { usedRatio: 0.25 },
        },
        extraUsage: {
          balanceCents: 500,
          totalCents: 1000,
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimitCents: 2000,
          monthlyUsedCents: 1500,
          currency: 'CNY',
        },
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
      listManagedWorkspaces: async () => ({ kind: 'error' as const, message: 'unused' }),
      switchManagedWorkspace: async () => ({ kind: 'error' as const, message: 'unused' }),
      resolveTokenProvider: () => undefined,
      getCachedAccessToken: async () => undefined,
      getRegion: () => 'mainland-cn',
      getRegionAsync: async () => 'mainland-cn',
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

describe('server-v2 /api/v1/oauth/workspaces and /switch', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-oauth-workspaces-'));
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

  function oauthStub(overrides: Partial<IOAuthServiceType>): IOAuthServiceType {
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
      status: async () => ({ loggedIn: true }),
      refreshOAuthProviderModels: async () => ({ changed: [], unchanged: [], failed: [] }),
      getManagedUsage: async () => ({ kind: 'error' as const, message: 'unused' }),
      getManagedUserInfo: async () => ({ kind: 'error' as const, message: 'unused' }),
      listManagedWorkspaces: async () => ({ kind: 'ok' as const, workspaces: [] }),
      switchManagedWorkspace: async () => ({
        kind: 'ok' as const,
        provider: 'managed:kimi-code',
        target: { kind: 'personal' as const },
      }),
      resolveTokenProvider: () => undefined,
      getCachedAccessToken: async () => undefined,
      getRegion: () => 'mainland-cn',
      getRegionAsync: async () => 'mainland-cn',
      ...overrides,
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

  it('lists personal and business workspaces in snake_case wire format', async () => {
    const listManagedWorkspaces = vi.fn(async () => ({
      kind: 'ok' as const,
      workspaces: [
        {
          kind: 'personal' as const,
          key: 'personal',
          name: 'Alex',
          current: true,
          disabled: false,
          switchable: true,
          roles: ['ROLE_OWNER'],
        },
        {
          kind: 'business' as const,
          key: 'business:biz_01',
          business_id: 'biz_01',
          name: 'Acme Org',
          status: 'STATUS_ACTIVE',
          current: false,
          disabled: false,
          switchable: true,
          nickname: 'Alex',
          roles: ['ROLE_MEMBER'],
        },
      ],
    }));
    await boot([[IOAuthService, oauthStub({ listManagedWorkspaces })]] as unknown as ScopeSeed);

    const res = await fetch(`${base}/api/v1/oauth/workspaces`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<OAuthManagedWorkspacesResult>;
    expect(body.code).toBe(0);
    expect(oauthManagedWorkspacesResultSchema.parse(body.data)).toEqual({
      kind: 'ok',
      workspaces: [
        {
          kind: 'personal',
          key: 'personal',
          name: 'Alex',
          current: true,
          disabled: false,
          switchable: true,
          roles: ['ROLE_OWNER'],
        },
        {
          kind: 'business',
          key: 'business:biz_01',
          business_id: 'biz_01',
          name: 'Acme Org',
          status: 'STATUS_ACTIVE',
          current: false,
          disabled: false,
          switchable: true,
          nickname: 'Alex',
          roles: ['ROLE_MEMBER'],
        },
      ],
    });
  });

  it('switches workspace via POST /api/v1/oauth/workspaces/switch and preserves membership revocation error_code', async () => {
    const switchManagedWorkspace = vi
      .fn<IOAuthServiceType['switchManagedWorkspace']>()
      .mockResolvedValueOnce({
        kind: 'ok',
        provider: 'managed:kimi-code',
        target: { kind: 'business', business_id: 'biz_01' },
      })
      .mockResolvedValueOnce({
        kind: 'error',
        status: 401,
        error_code: 'REASON_BUSINESS_MEMBER_REMOVED',
        message: 'Removed from business workspace.',
      });
    await boot([[IOAuthService, oauthStub({ switchManagedWorkspace })]] as unknown as ScopeSeed);

    const okRes = await fetch(`${base}/api/v1/oauth/workspaces/switch`, {
      method: 'POST',
      headers: {
        ...authHeaders(server as RunningServer),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ target: { kind: 'business', business_id: 'biz_01' } }),
    } as never);
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as Envelope<OAuthWorkspaceSwitchResponse>;
    expect(oauthWorkspaceSwitchResponseSchema.parse(okBody.data)).toEqual({
      kind: 'ok',
      provider: 'managed:kimi-code',
      target: { kind: 'business', business_id: 'biz_01' },
    });

    const errRes = await fetch(`${base}/api/v1/oauth/workspaces/switch`, {
      method: 'POST',
      headers: {
        ...authHeaders(server as RunningServer),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ target: { kind: 'personal' } }),
    } as never);
    expect(errRes.status).toBe(200);
    const errBody = (await errRes.json()) as Envelope<OAuthWorkspaceSwitchResponse>;
    expect(oauthWorkspaceSwitchResponseSchema.parse(errBody.data)).toEqual({
      kind: 'error',
      status: 401,
      error_code: 'REASON_BUSINESS_MEMBER_REMOVED',
      message: 'Removed from business workspace.',
    });
  });
});
