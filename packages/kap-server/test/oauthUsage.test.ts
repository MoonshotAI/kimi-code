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
  type ManagedUsageResult,
} from '@moonshot-ai/agent-core-v2/app/auth/oauthProtocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
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
      resolveTokenProvider: () => undefined,
      getCachedAccessToken: async () => undefined,
    };
  }

  async function boot(seeds: ScopeSeed): Promise<void> {
    server = await startServer({
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
      summary: { label: 'Weekly limit', used: 40, limit: 1000, resetHint: 'resets in 2d' },
      limits: [{ label: '5h limit', used: 1, limit: 100 }],
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
      summary: { label: 'Weekly limit', used: 40, limit: 1000, reset_hint: 'resets in 2d' },
      limits: [{ label: '5h limit', used: 1, limit: 100 }],
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
