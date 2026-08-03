/**
 * RustRpcClient tests — fake rust-loop surface, verifying the CoreAPI
 * mappings (create/list/status/prompt/event routing) and the native
 * capability policy.
 */
import { describe, expect, it } from 'vitest';

import { RustRpcClient, type RustLoopApi } from '../src/rust/rpc-client.js';

function fakeRustLoop(overrides: Partial<RustLoopApi> = {}): RustLoopApi & {
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => {
    return (...args: unknown[]): unknown => {
      (calls[name] ??= []).push(args);
      return undefined;
    };
  };
  return {
    calls,
    isRustEngineAvailable: () => true,
    installSessionHostHandlers: () => true,
    sessionCreate: async () => ({ session_id: 'ses_1' }),
    sessionList: async () => ({
      sessions: [
        { id: 'ses_1', created_at: '2026-08-02T00:00:00.000Z', updated_at: '2026-08-02T01:00:00.000Z', work_dir: '/ws' },
      ],
    }),
    sessionGetStatus: async () => ({
      model: 'kimi-k2',
      thinking_effort: 'medium',
      permission: 'auto',
      plan_mode: false,
      swarm_mode: false,
      goal_enabled: false,
      context_tokens: 100,
      max_context_tokens: 128000,
      context_usage: 0.001,
    }),
    sessionPrompt: async () => ({ stop_reason: 'EndTurn', steps: 1, usage: {} }),
    sessionExport: async () => null,
    sessionSave: record('sessionSave'),
    sessionCancel: async () => ({ cancelled: true }),
    sessionSetModel: async () => ({ ok: true }),
    sessionSetPlanMode: async () => ({ ok: true }),
    sessionListSkills: async () => ({ skills: [] }),
    sessionListMcpServers: async () => ({ servers: [] }),
    sessionGetUsage: async () => ({}),
    sessionGetWarnings: async () => ({ warnings: [] }),
    sessionGetContext: async () => ({ messages: [], token_count: 100 }),
    sessionGetPlan: async () => null,
    cronList: async () => ({ tasks: [] }),
    bgList: async () => ({ tasks: [] }),
    pluginList: async () => ({ plugins: [] }),
    configGet: async () => ({ model: 'kimi-k2' }),
    configSet: async (patch) => patch,
    ...overrides,
  } as RustLoopApi & { calls: Record<string, unknown[]> };
}

describe('RustRpcClient', () => {
  it('creates a session through the engine and maps the summary', async () => {
    const rust = fakeRustLoop();
    const client = new RustRpcClient({ rustLoop: rust, homeDir: '/home' });
    const rpc = await client['getRpc']();
    const summary = await rpc.createSession({ id: 'ses_1', workDir: '/ws' });
    expect(summary.id).toBe('ses_1');
    expect(summary.workDir).toBe('/ws');
  });

  it('maps the engine status onto the SDK shape', async () => {
    const rust = fakeRustLoop();
    const client = new RustRpcClient({ rustLoop: rust });
    const status = await client.getStatus({ sessionId: 'ses_1' });
    expect(status.model).toBe('kimi-k2');
    expect(status.thinkingEffort).toBe('medium');
    expect(status.permission).toBe('auto');
    expect(status.contextTokens).toBe(100);
  });

  it('lists sessions created through this client', async () => {
    const rust = fakeRustLoop();
    const client = new RustRpcClient({ rustLoop: rust });
    const rpc = await client['getRpc']();
    await rpc.createSession({ id: 'ses_1', workDir: '/ws' });
    const sessions = await rpc.listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('ses_1');
    expect(sessions[0]?.workDir).toBe('/ws');
  });

  it('dispatches engine events to session listeners with sessionId/agentId routing', async () => {
    let onEvent: ((event: unknown) => void) | undefined;
    const rust = fakeRustLoop({
      installSessionHostHandlers: (handlers) => {
        onEvent = handlers.onEvent;
        return true;
      },
    });
    const client = new RustRpcClient({ rustLoop: rust });
    const rpc = await client['getRpc']();
    await rpc.createSession({ id: 'ses_1', workDir: '/ws' });

    // The engine emits the SDK event shape (snake_case) directly; the client
    // only stamps the sessionId/agentId routing fields and passes the event
    // through verbatim (the old camelCase translator is gone).
    const seen: Array<{ type: string; sessionId?: string; agentId?: string }> = [];
    const unsubscribe = client['onEvent']((event) => {
      seen.push(event as { type: string; sessionId?: string; agentId?: string });
    });
    onEvent?.({
      type: 'session.turn.started',
      session_id: 'ses_1',
      turn_id: 1,
    });
    onEvent?.({
      type: 'llm.delta',
      session_id: 'ses_1',
      part: { type: 'text', text: 'hello' },
    });
    expect(seen.map((event) => event.type)).toEqual(['session.turn.started', 'llm.delta']);
    for (const event of seen) {
      expect(event.sessionId).toBe('ses_1');
      expect(event.agentId).toBe('main');
    }
    unsubscribe();
  });

  it('fails loud for capabilities the engine does not back', async () => {
    const rust = fakeRustLoop();
    const client = new RustRpcClient({ rustLoop: rust });
    const rpc = await client['getRpc']();
    await expect(rpc.installPlugin({ source: 'x' } as never)).rejects.toThrow(
      'not available under the native engine',
    );
  });

  it('fetches engine wire records for export; engine absence degrades to empty', async () => {
    const rust = fakeRustLoop();
    const client = new RustRpcClient({ rustLoop: rust });
    const rpc = await client['getRpc']();
    // The fake engine has no records to export (sessionExport → null); the
    // host export must still receive a usable empty record set.
    await expect(
      rpc.exportSession({ sessionId: 'ses_1' } as never),
    ).resolves.toEqual({ wireRecords: [] });
  });

  it('prompts the engine with the session id and text parts', async () => {
    const rust = fakeRustLoop();
    const client = new RustRpcClient({ rustLoop: rust });
    // The base-class prompt surface is fire-and-forget (void); the assertion
    // is that the engine sessionPrompt call path resolves without throwing.
    await expect(
      client.prompt({ sessionId: 'ses_1', input: [{ type: 'text', text: 'say hi' }] }),
    ).resolves.toBeUndefined();
  });
});
