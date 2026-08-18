import { describe, expect, it, vi } from 'vitest';

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { AcpSession } from '../src/session';

function fakeSession(): Session {
  return {
    id: 'session-usage',
    getStatus: async () => ({
      thinkingEffort: 'off',
      permission: 'default',
      planMode: false,
      contextTokens: 250,
      maxContextTokens: 1_000,
      contextUsage: 0.25,
    }),
  } as unknown as Session;
}

function fakeConnection(sessionUpdate: ReturnType<typeof vi.fn>): AgentSideConnection {
  return { sessionUpdate } as unknown as AgentSideConnection;
}

describe('AcpSession usage reporting', () => {
  it('emits Coding Plan rate limits and caches the account lookup for one minute', async () => {
    const sessionUpdate = vi.fn(async () => undefined);
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
    const harness = {
      getConfig: async () => ({
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            apiKey: '',
            oauth: { storage: 'keyring', key: 'kimi-code' },
          },
        },
        defaultModel: 'kimi-for-coding',
        models: {
          'kimi-for-coding': {
            provider: 'managed:kimi-code',
            model: 'kimi-for-coding',
            maxContextSize: 262_144,
          },
        },
      }),
      auth: { getManagedUsage },
    } as unknown as KimiHarness;
    const acpSession = new AcpSession(
      fakeConnection(sessionUpdate),
      fakeSession(),
      undefined,
      undefined,
      'kimi-for-coding',
      harness,
    );

    await acpSession.emitUsageReport();
    await acpSession.emitUsageReport();

    expect(getManagedUsage).toHaveBeenCalledTimes(1);
    expect(sessionUpdate).toHaveBeenLastCalledWith({
      sessionId: 'session-usage',
      update: {
        sessionUpdate: 'usage_update',
        used: 250,
        size: 1_000,
        _meta: {
          kimiCode: {
            billingMode: 'coding_plan',
            rateLimits: {
              summary: {
                name: 'Weekly',
                used: 30,
                limit: 100,
                resetAt: '2026-08-14T00:00:00Z',
              },
              limits: [
                {
                  name: '5h',
                  window: { duration: 5, unit: 'hour' },
                  used: 20,
                  limit: 100,
                  resetAt: '2026-08-07T12:00:00Z',
                },
              ],
              booster: { balanceCents: 500, totalCents: 1_000, currency: 'USD' },
            },
          },
        },
      },
    });
  });

  it('reports API-key billing without exposing or querying the credential', async () => {
    const sessionUpdate = vi.fn(async () => undefined);
    const getManagedUsage = vi.fn();
    const harness = {
      getConfig: async () => ({
        providers: {
          'moonshot-cn': {
            type: 'kimi',
            apiKey: 'secret-api-key',
          },
        },
        defaultModel: 'kimi-k2',
        models: {
          'kimi-k2': {
            provider: 'moonshot-cn',
            model: 'kimi-k2',
            maxContextSize: 262_144,
          },
        },
      }),
      auth: { getManagedUsage },
    } as unknown as KimiHarness;
    const acpSession = new AcpSession(
      fakeConnection(sessionUpdate),
      fakeSession(),
      undefined,
      undefined,
      'kimi-k2',
      harness,
    );

    await acpSession.emitUsageReport();

    expect(getManagedUsage).not.toHaveBeenCalled();
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: 'session-usage',
      update: {
        sessionUpdate: 'usage_update',
        used: 250,
        size: 1_000,
        _meta: { kimiCode: { billingMode: 'api_key' } },
      },
    });
    expect(JSON.stringify(sessionUpdate.mock.calls)).not.toContain('secret-api-key');
  });

  it('reports API-key billing when the key is supplied through the provider env table', async () => {
    const sessionUpdate = vi.fn(async () => undefined);
    const getManagedUsage = vi.fn();
    const harness = {
      getConfig: async () => ({
        providers: {
          'moonshot-cn': {
            type: 'kimi',
            apiKey: '',
            env: { KIMI_API_KEY: 'secret-env-key' },
          },
        },
        defaultModel: 'kimi-k2',
        models: {
          'kimi-k2': {
            provider: 'moonshot-cn',
            model: 'kimi-k2',
            maxContextSize: 262_144,
          },
        },
      }),
      auth: { getManagedUsage },
    } as unknown as KimiHarness;
    const acpSession = new AcpSession(
      fakeConnection(sessionUpdate),
      fakeSession(),
      undefined,
      undefined,
      'kimi-k2',
      harness,
    );

    await acpSession.emitUsageReport();

    expect(getManagedUsage).not.toHaveBeenCalled();
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: 'session-usage',
      update: {
        sessionUpdate: 'usage_update',
        used: 250,
        size: 1_000,
        _meta: { kimiCode: { billingMode: 'api_key' } },
      },
    });
    expect(JSON.stringify(sessionUpdate.mock.calls)).not.toContain('secret-env-key');
  });
});
