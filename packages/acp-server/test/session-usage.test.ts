/**
 * ACP `usage_update` metadata tests.
 *
 * These exercise the billing-mode classification and (for Coding Plan) the
 * managed-usage rate-limit fetch that `acp-server` attaches to every
 * `usage_update` notification. They use the real engine + ACP wire but replace
 * the LLM with the scripted provider and the OAuth toolkit with a fake.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IOAuthToolkit } from '@moonshot-ai/agent-core-v2/app/auth/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestClient, type TestClient } from './_helpers/acpClient';
import { createScriptedProvider } from './_helpers/scriptedProvider';

interface UsageUpdateBody {
  sessionUpdate: 'usage_update';
  used?: number;
  size?: number;
  _meta?: {
    kimiCode?: {
      billingMode: 'coding_plan' | 'api_key';
      rateLimits?: {
        summary: {
          name?: string;
          used: number;
          limit: number;
          resetAt?: string;
        } | null;
        limits: Array<{
          name?: string;
          window?: { duration: number; unit: 'minute' | 'hour' | 'day' | 'week' };
          used: number;
          limit: number;
          resetAt?: string;
        }>;
        booster: { balanceCents: number; totalCents: number; currency: string } | null;
      };
    };
  };
}

function usageUpdates(c: TestClient): UsageUpdateBody[] {
  return c
    .sessionUpdates()
    .map((m) => (m.params as { update?: UsageUpdateBody }).update)
    .filter((u): u is UsageUpdateBody => u?.sessionUpdate === 'usage_update');
}

async function writeUsageConfig(
  homeDir: string,
  providerName: string,
  providerToml: string,
): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  await writeFile(
    join(homeDir, 'config.toml'),
    `defaultModel = "fake"

[models.fake]
name = "fake-model"
protocol = "openai"
provider = "${providerName}"
model = "fake"
maxContextSize = 8192

${providerToml}`,
    'utf8',
  );
}

describe('acp-server usage metadata', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function boot(options: {
    providerName: string;
    providerToml: string;
    extraSeeds?: Parameters<typeof createTestClient>[0]['extraSeeds'];
  }): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-usage-'));
    await writeUsageConfig(homeDir, options.providerName, options.providerToml);
    client = await createTestClient({ homeDir, extraSeeds: options.extraSeeds });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  it('opening usage_update reports api_key billing and never exposes the key', async () => {
    const c = await boot({
      providerName: 'moonshot-cn',
      providerToml: `[providers.moonshot-cn]
type = "kimi"
baseUrl = "http://localhost"
apiKey = "secret-api-key"`,
    });

    await c.send('session/new', { cwd: homeDir, mcpServers: [] });
    const update = await c.waitForSessionUpdate('usage_update', 10_000);
    const body = (update.params as { update?: UsageUpdateBody }).update;
    expect(body?._meta?.kimiCode?.billingMode).toBe('api_key');
    expect(body?._meta?.kimiCode?.rateLimits).toBeUndefined();
    expect(JSON.stringify(c.received)).not.toContain('secret-api-key');
  }, 30_000);

  it('opening usage_update reports api_key billing when the key is in the provider env table', async () => {
    const c = await boot({
      providerName: 'moonshot-cn',
      providerToml: `[providers.moonshot-cn]
type = "kimi"
baseUrl = "http://localhost"
apiKey = ""
[providers.moonshot-cn.env]
KIMI_API_KEY = "secret-env-key"`,
    });

    await c.send('session/new', { cwd: homeDir, mcpServers: [] });
    const update = await c.waitForSessionUpdate('usage_update', 10_000);
    const body = (update.params as { update?: UsageUpdateBody }).update;
    expect(body?._meta?.kimiCode?.billingMode).toBe('api_key');
    expect(body?._meta?.kimiCode?.rateLimits).toBeUndefined();
    expect(JSON.stringify(c.received)).not.toContain('secret-env-key');
  }, 30_000);

  it('reports coding_plan billing and caches the managed usage lookup', async () => {
    const scripted = createScriptedProvider();
    scripted.mockNextText('hello from coding plan');

    const getManagedUsage = vi.fn(async () => ({
      kind: 'ok' as const,
      summary: { name: 'Weekly', used: 30, limit: 100, resetAt: '2026-08-14T00:00:00Z' },
      limits: [
        {
          name: '5h',
          window: { duration: 5, unit: 'hour' as const },
          used: 20,
          limit: 100,
          resetAt: '2026-08-07T12:00:00Z',
        },
      ],
      extraUsage: {
        balanceCents: 500,
        totalCents: 1_000,
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimitCents: 2_000,
        monthlyUsedCents: 400,
        currency: 'USD',
      },
    }));

    const oauthToolkit = {
      _serviceBrand: undefined,
      login: vi.fn(),
      logout: vi.fn(),
      getCachedAccessToken: vi.fn(async () => 'fake-token'),
      tokenProvider: vi.fn(() => ({
        getAccessToken: async () => 'fake-token',
      })),
      getManagedUsage,
      getManagedUserInfo: vi.fn(),
    } as unknown as IOAuthToolkit;

    const c = await boot({
      providerName: 'managed:kimi-code',
      providerToml: `[providers."managed:kimi-code"]
type = "kimi"
baseUrl = "https://api.moonshot.ai/v1"
oauth = { storage = "keyring", key = "kimi-code" }`,
      extraSeeds: [scripted.seed, [IOAuthToolkit, oauthToolkit]],
    });

    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };

    const opening = await c.waitForSessionUpdate('usage_update', 10_000);
    const openingBody = (opening.params as { update?: UsageUpdateBody }).update;
    expect(openingBody?._meta?.kimiCode?.billingMode).toBe('coding_plan');
    expect(openingBody?._meta?.kimiCode?.rateLimits?.summary).toEqual({
      name: 'Weekly',
      used: 30,
      limit: 100,
      resetAt: '2026-08-14T00:00:00Z',
    });
    expect(openingBody?._meta?.kimiCode?.rateLimits?.booster).toEqual({
      balanceCents: 500,
      totalCents: 1_000,
      currency: 'USD',
    });

    expect(getManagedUsage).toHaveBeenCalledTimes(1);
    expect(getManagedUsage).toHaveBeenCalledWith('managed:kimi-code', {
      oauthRef: { storage: 'keyring', key: 'kimi-code' },
      baseUrl: 'https://api.moonshot.ai/v1',
    });

    // Drive one turn and assert the post-turn usage_update reuses the cache.
    const promptPromise = c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'say hi' }],
    });
    await c.waitForSessionUpdate('agent_message_chunk', 10_000);
    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');

    const deadline = Date.now() + 10_000;
    while (usageUpdates(c).length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const all = usageUpdates(c);
    expect(all).toHaveLength(2);
    expect(all[1]?._meta?.kimiCode?.billingMode).toBe('coding_plan');
    expect(all[1]?._meta?.kimiCode?.rateLimits?.summary).toEqual({
      name: 'Weekly',
      used: 30,
      limit: 100,
      resetAt: '2026-08-14T00:00:00Z',
    });
    expect(getManagedUsage).toHaveBeenCalledTimes(1);
  }, 30_000);
});
