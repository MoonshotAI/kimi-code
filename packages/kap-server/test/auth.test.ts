import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authSummarySchema, type AuthSummary } from '@moonshot-ai/agent-core-v2/app/authLegacy/authLegacy';
import {
  managedUsageResponseSchema,
  type ManagedUsageResponse,
} from '@moonshot-ai/agent-core-v2/app/auth/oauthProtocol';
import {
  IOAuthService,
  type IOAuthService as IOAuthServiceType,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 GET /api/v1/auth', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-auth-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function boot(toml?: string): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getAuth(): Promise<AuthSummary> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/auth');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<AuthSummary>;
    expect(body.code).toBe(0);
    return authSummarySchema.parse(body.data);
  }

  it('returns ready=false with an empty snapshot on empty config', async () => {
    await boot();
    expect(await getAuth()).toEqual({
      ready: false,
      providers_count: 0,
      default_model: null,
      managed_provider: null,
    });
  });

  it('returns ready=true when provider + api_key + default_model are set', async () => {
    await boot(
      [
        'default_model = "x"',
        '',
        '[providers.x]',
        'type = "kimi"',
        'api_key = "sk-test"',
        '',
        '[models.x]',
        'provider = "x"',
        'model = "x"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
    );
    expect(await getAuth()).toEqual({
      ready: true,
      providers_count: 1,
      default_model: 'x',
      managed_provider: null,
    });
  });

  it('returns ready=false when a provider exists but default_model is missing', async () => {
    await boot(
      [
        '[providers.x]',
        'type = "kimi"',
        'api_key = "sk-test"',
        '',
        '[models.x]',
        'provider = "x"',
        'model = "x"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
    );
    const summary = await getAuth();
    expect(summary.ready).toBe(false);
    expect(summary.providers_count).toBe(1);
    expect(summary.default_model).toBeNull();
    expect(summary.managed_provider).toBeNull();
  });

  it('surfaces managed_provider.unauthenticated without a cached token', async () => {
    await boot(
      [
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        'base_url = "https://example.test/v1"',
        '',
        '[providers."managed:kimi-code".oauth]',
        'storage = "file"',
        'key = "oauth/kimi-code"',
        '',
      ].join('\n'),
    );
    const summary = await getAuth();
    expect(summary.managed_provider).toEqual({
      name: 'managed:kimi-code',
      status: 'unauthenticated',
    });
    // No default_model → still not ready, even though the provider exists.
    expect(summary.ready).toBe(false);
  });
});

describe('server-v2 GET /api/v1/oauth/usage', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-usage-'));
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

  async function boot(seeds?: ScopeSeed): Promise<void> {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getUsage(): Promise<ManagedUsageResponse> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/oauth/usage');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<unknown>;
    expect(body.code).toBe(0);
    return managedUsageResponseSchema.parse(body.data);
  }

  function oauthUsageStub(
    getManagedUsage: IOAuthServiceType['getManagedUsage'],
  ): IOAuthServiceType {
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
      refreshOAuthProviderModels: async () => {
        throw new Error('unused');
      },
      resolveTokenProvider: () => undefined,
      getCachedAccessToken: async () => undefined,
      getManagedUsage,
    };
  }

  it('returns kind=error when no managed token exists', async () => {
    await boot();
    // Empty token store → the toolkit surfaces an error result (no network).
    const parsed = await getUsage();
    expect(parsed.kind).toBe('error');
  });

  it('maps the ok result to the snake_case wire contract', async () => {
    const okResult = {
      kind: 'ok' as const,
      summary: {
        label: 'Weekly limit',
        used: 40,
        limit: 1000,
        resetHint: 'resets in 6d',
        resetAt: '2026-07-24T00:00:00Z',
      },
      limits: [
        {
          label: '5h limit',
          used: 30,
          limit: 100,
          resetHint: 'resets in 4h',
          resetAt: '2026-07-17T09:00:00Z',
          windowSeconds: 18000,
        },
      ],
      extraUsage: {
        balanceCents: 1000,
        totalCents: 2000,
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimitCents: 20000,
        monthlyUsedCents: 5000,
        currency: 'USD',
      },
    };
    const seeds = [
      [IOAuthService, oauthUsageStub(async () => okResult)],
    ] as unknown as ScopeSeed;
    await boot(seeds);

    const parsed = await getUsage();
    expect(parsed).toEqual({
      kind: 'ok',
      summary: {
        label: 'Weekly limit',
        used: 40,
        limit: 1000,
        reset_hint: 'resets in 6d',
        reset_at: '2026-07-24T00:00:00Z',
      },
      limits: [
        {
          label: '5h limit',
          used: 30,
          limit: 100,
          reset_hint: 'resets in 4h',
          reset_at: '2026-07-17T09:00:00Z',
          window_seconds: 18000,
        },
      ],
      extra_usage: {
        balance_cents: 1000,
        total_cents: 2000,
        monthly_charge_limit_enabled: true,
        monthly_charge_limit_cents: 20000,
        monthly_used_cents: 5000,
        currency: 'USD',
      },
    });
  });

  it('maps a 401 toolkit error to code=unauthenticated', async () => {
    const seeds = [
      [IOAuthService, oauthUsageStub(async () => ({ kind: 'error' as const, status: 401, message: 'expired' }))],
    ] as unknown as ScopeSeed;
    await boot(seeds);
    expect(await getUsage()).toEqual({ kind: 'error', code: 'unauthenticated', message: 'expired' });
  });

  it('maps other toolkit errors to code=unavailable', async () => {
    const seeds = [
      [IOAuthService, oauthUsageStub(async () => ({ kind: 'error' as const, message: 'boom' }))],
    ] as unknown as ScopeSeed;
    await boot(seeds);
    expect(await getUsage()).toEqual({ kind: 'error', code: 'unavailable', message: 'boom' });
  });
});
