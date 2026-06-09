// apps/kimi-web/src/api/daemon/__tests__/client.session.test.ts
// Adapter-level tests for the session profile (model + runtime controls) and the
// live /status endpoint — the daemon has no PATCH on sessions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonKimiWebApi } from '../client';

const config = { daemonHttpUrl: 'http://127.0.0.1:7878', clientId: 'test' };

function envelope(data: unknown, code = 0, msg = 'ok') {
  return { ok: true, json: async () => ({ code, msg, data, request_id: 'r1' }) } as unknown as Response;
}

function wireSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ses_1',
    title: 'T',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    status: 'idle',
    workspace_id: 'wd_x',
    metadata: { cwd: '/Users/me/p' },
    agent_config: { model: '' },
    usage: {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
      total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0,
    },
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('DaemonKimiWebApi — session profile + status', () => {
  it('updateSession POSTs to /profile with agent_config (not PATCH /sessions)', async () => {
    fetchMock.mockResolvedValue(envelope(wireSession()));
    const api = new DaemonKimiWebApi(config);
    await api.updateSession('ses_1', { model: 'kimi-k2', permissionMode: 'auto', planMode: true, thinking: 'high' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/sessions/ses_1/profile');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.agent_config).toEqual({
      model: 'kimi-k2',
      permission_mode: 'auto',
      plan_mode: true,
      thinking: 'high',
    });
  });

  it('getSessionStatus maps the live runtime status', async () => {
    fetchMock.mockResolvedValue(
      envelope({
        model: 'kimi-k2',
        thinking_level: 'high',
        permission: 'auto',
        plan_mode: true,
        context_tokens: 1200,
        max_context_tokens: 200000,
        context_usage: 0.006,
      }),
    );
    const api = new DaemonKimiWebApi(config);
    const st = await api.getSessionStatus('ses_1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/sessions/ses_1/status');
    expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
    expect(st).toEqual({
      model: 'kimi-k2',
      thinkingLevel: 'high',
      permission: 'auto',
      planMode: true,
      contextTokens: 1200,
      maxContextTokens: 200000,
      contextUsage: 0.006,
    });
  });

  it('forkSession POSTs to :fork and maps the new session', async () => {
    fetchMock.mockResolvedValue(envelope(wireSession({ id: 'ses_2', title: 'fork' })));
    const api = new DaemonKimiWebApi(config);
    const forked = await api.forkSession('ses_1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/sessions/ses_1:fork');
    expect((init as RequestInit).method).toBe('POST');
    expect(forked.id).toBe('ses_2');
  });
});
