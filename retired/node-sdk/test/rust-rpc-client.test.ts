/**
 * RustRpcClient tests — fake rust-loop surface, verifying the CoreAPI
 * mappings (create/list/status/prompt/event routing) and the native
 * capability policy.
 */
import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { RustRpcClient, type RustLoopApi } from '../src/rust/rpc-client.js';
import { Session } from '../src/session.js';
import { readConfigFile, writeConfigFile } from '../src/legacy/config.js';
import type { ToolCallRequest } from '../src/legacy/rpc-types.js';

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
    sessionArchive: async () => ({ archived: true }),
    sessionDelete: async () => ({ deleted: true }),
    sessionSetModel: async () => ({ ok: true }),
    sessionSetPlanMode: async () => ({ ok: true }),
    sessionListSkills: async () => ({ skills: [] }),
    sessionListMcpServers: async () => ({ servers: [] }),
    sessionGetUsage: async () => ({}),
    sessionGetWarnings: async () => ({ warnings: [] }),
    sessionGetContext: async () => ({ messages: [], token_count: 100 }),
    sessionGetPlan: async () => null,
    sessionCompact: async () => ({ compacted: true }),
    sessionCancelCompaction: async () => ({ cancelled: true }),
    cronList: async () => ({ tasks: [] }),
    bgList: async () => ({ tasks: [] }),
    pluginList: async () => ({ plugins: [] }),
    pluginInstall: async (source: string) => ({
      id: `local:${source}`,
      display_name: 'test',
      version: '1.0.0',
      enabled: true,
      state: 'ok',
      skill_count: 0,
      mcp_server_count: 0,
      enabled_mcp_server_count: 0,
      hook_count: 0,
      command_count: 0,
      has_errors: false,
      source: 'local-path',
    }),
    pluginSetEnabled: async (id: string, enabled: boolean) => ({
      id,
      display_name: 'test',
      version: '1.0.0',
      enabled,
      state: 'ok',
      skill_count: 0,
      mcp_server_count: 0,
      enabled_mcp_server_count: 0,
      hook_count: 0,
      command_count: 0,
      has_errors: false,
      source: 'local-path',
    }),
    pluginSetMcpEnabled: async () => ({}),
    pluginRemove: async () => ({ removed: true }),
    pluginReload: async () => ({ ok: true }),
    pluginListCommands: async () => ({ commands: [] }),
    pluginActivateCommand: async () => ({ accepted: true }),
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

  it('routes plugin lifecycle methods to the engine', async () => {
    const rust = fakeRustLoop();
    const client = new RustRpcClient({ rustLoop: rust });
    const rpc = await client['getRpc']();

    const summary = await rpc.installPlugin({ source: '/tmp/p' } as never);
    expect(summary).toMatchObject({ id: 'local:/tmp/p', enabled: true });

    await expect(rpc.setPluginEnabled({ id: 'x', enabled: false } as never)).resolves.toBeUndefined();
    await expect(rpc.removePlugin({ id: 'x' } as never)).resolves.toBeUndefined();
    await expect(rpc.reloadPlugins()).resolves.toMatchObject({ added: 0 });
  });

  it('lists and activates plugin commands through the engine', async () => {
    const rust = fakeRustLoop({
      pluginList: async () => ({
        plugins: [{ id: 'p1' }, { id: 'p2' }],
      }),
      pluginListCommands: async (id: string) => ({
        commands: id === 'p1'
          ? [{ name: 'review', description: 'Review', body: 'review the diff' }]
          : [],
      }),
    });
    const client = new RustRpcClient({ rustLoop: rust });
    const rpc = await client['getRpc']();
    const commands = await rpc.listPluginCommands({ sessionId: 's' });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ pluginId: 'p1', name: 'review' });

    await expect(
      rpc.activatePluginCommand({
        sessionId: 's',
        pluginId: 'p1',
        commandName: 'review',
        args: 'focus',
      } as never),
    ).resolves.toBeUndefined();
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

  it('removes the kimi provider from the local config', async () => {
    const rust = fakeRustLoop();
    const configPath = join(
      tmpdir(),
      `kimi-sdk-remove-kimi-${process.pid}.toml`,
    );
    await writeConfigFile(configPath, {
      providers: { kimi: { type: 'kimi', apiKey: 'sk-test' } },
      defaultModel: 'kimi-k2',
    } as never);

    const client = new RustRpcClient({ rustLoop: rust, configPath });
    const rpc = await client['getRpc']();
    await rpc.removeKimiProvider();

    const after = readConfigFile(configPath);
    expect((after.providers as Record<string, unknown> | undefined)?.['kimi']).toBeUndefined();
    expect(after.defaultModel).toBe('kimi-k2');
  });

  it('cancels compaction through the engine (no-op success)', async () => {
    const rust = fakeRustLoop();
    const client = new RustRpcClient({ rustLoop: rust });
    const rpc = await client['getRpc']();
    await expect(rpc.cancelCompaction({ sessionId: 'ses_1' } as never)).resolves.toBeUndefined();
  });

  it('archives a session through the engine', async () => {
    const rust = fakeRustLoop();
    const client = new RustRpcClient({ rustLoop: rust });
    const rpc = await client['getRpc']() as unknown as Record<string, unknown>;
    const archive = rpc['archiveSession'] as (input: unknown) => Promise<void>;
    await expect(archive({ sessionId: 'ses_1' })).resolves.toBeUndefined();
  });
});

describe('RustRpcClient toolExecute bridge', () => {
  it('routes engine execute_tool to the session tool handler and maps the response', async () => {
    let toolExecute: ((req: unknown) => Promise<unknown>) | undefined;
    const rust = fakeRustLoop({
      installSessionHostHandlers: (handlers) => {
        toolExecute = handlers.toolExecute;
        return true;
      },
    });
    const client = new RustRpcClient({ rustLoop: rust });
    const handler = vi.fn((request: ToolCallRequest) => {
      expect(request).toMatchObject({
        toolCallId: 'call-1',
        args: { query: 'x' },
        sessionId: 'ses_1',
        agentId: 'main',
      });
      return { output: 'result text', isError: false };
    });
    client.setToolHandler('ses_1', handler);

    await expect(
      toolExecute?.({
        session_id: 'ses_1',
        turn_id: 'turn-1',
        tool_call_id: 'call-1',
        tool_name: 'my_tool',
        arguments: { query: 'x' },
      }),
    ).resolves.toEqual({ content: 'result text', is_error: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('maps btw side-question sessions onto the parent session handler', async () => {
    let toolExecute: ((req: unknown) => Promise<unknown>) | undefined;
    const rust = fakeRustLoop({
      installSessionHostHandlers: (handlers) => {
        toolExecute = handlers.toolExecute;
        return true;
      },
    });
    const client = new RustRpcClient({ rustLoop: rust });
    const seen: string[] = [];
    client.setToolHandler('ses_1', (request: ToolCallRequest & { sessionId?: string }) => {
      seen.push(request.sessionId ?? '');
      return { output: 'ok' };
    });

    await expect(
      toolExecute?.({
        session_id: 'btw-ses_1',
        turn_id: 'turn-1',
        tool_call_id: 'call-2',
        tool_name: 'my_tool',
        arguments: {},
      }),
    ).resolves.toEqual({ content: 'ok', is_error: false });
    expect(seen).toEqual(['ses_1']);
  });

  it('fails with the unsupported-tool result when no handler is registered', async () => {
    let toolExecute: ((req: unknown) => Promise<unknown>) | undefined;
    const rust = fakeRustLoop({
      installSessionHostHandlers: (handlers) => {
        toolExecute = handlers.toolExecute;
        return true;
      },
    });
    const client = new RustRpcClient({ rustLoop: rust });

    await expect(
      toolExecute?.({
        session_id: 'ses_1',
        turn_id: 'turn-1',
        tool_call_id: 'call-1',
        tool_name: 'my_tool',
        arguments: {},
      }),
    ).resolves.toEqual({
      content: 'SDK custom tool calls are not supported: call-1',
      is_error: true,
    });
  });

  it('maps a throwing tool handler to an error result and an error event', async () => {
    let toolExecute: ((req: unknown) => Promise<unknown>) | undefined;
    const rust = fakeRustLoop({
      installSessionHostHandlers: (handlers) => {
        toolExecute = handlers.toolExecute;
        return true;
      },
    });
    const client = new RustRpcClient({ rustLoop: rust });
    client.setToolHandler('ses_1', () => {
      throw new Error('boom');
    });
    const errors: Array<{ code?: string; message?: string; sessionId?: string }> = [];
    const unsubscribe = client.onEvent((event) => {
      if (event.type === 'error') {
        errors.push(event as { code?: string; message?: string; sessionId?: string });
      }
    });

    await expect(
      toolExecute?.({
        session_id: 'ses_1',
        turn_id: 'turn-1',
        tool_call_id: 'call-1',
        tool_name: 'my_tool',
        arguments: {},
      }),
    ).resolves.toEqual({ content: 'Tool call handler failed: boom', is_error: true });
    expect(errors).toMatchObject([
      {
        type: 'error',
        code: 'session.tool_handler_error',
        message: 'boom',
        sessionId: 'ses_1',
        agentId: 'main',
      },
    ]);
    unsubscribe();
  });

  it('maps content parts onto engine content and media blocks', async () => {
    let toolExecute: ((req: unknown) => Promise<unknown>) | undefined;
    const rust = fakeRustLoop({
      installSessionHostHandlers: (handlers) => {
        toolExecute = handlers.toolExecute;
        return true;
      },
    });
    const client = new RustRpcClient({ rustLoop: rust });
    client.setToolHandler('ses_1', () => ({
      output: [
        { type: 'text', text: 'done' },
        { type: 'image_url', imageUrl: { url: 'file:///shot.png' } },
      ],
    }));

    await expect(
      toolExecute?.({
        session_id: 'ses_1',
        turn_id: 'turn-1',
        tool_call_id: 'call-1',
        tool_name: 'my_tool',
        arguments: {},
      }),
    ).resolves.toEqual({
      content: 'done',
      is_error: false,
      media: [{ type: 'image_url', url: 'file:///shot.png' }],
    });
  });

  it('runs through the Session.setToolHandler surface end-to-end', async () => {
    let toolExecute: ((req: unknown) => Promise<unknown>) | undefined;
    const rust = fakeRustLoop({
      installSessionHostHandlers: (handlers) => {
        toolExecute = handlers.toolExecute;
        return true;
      },
    });
    const client = new RustRpcClient({ rustLoop: rust });
    const session = new Session({
      id: 'ses_1',
      workDir: '/ws',
      rpc: client,
    });
    session.setToolHandler((request) => ({ output: `handled: ${request.toolCallId}` }));

    await expect(
      toolExecute?.({
        session_id: 'ses_1',
        turn_id: 'turn-1',
        tool_call_id: 'call-9',
        tool_name: 'my_tool',
        arguments: {},
      }),
    ).resolves.toEqual({ content: 'handled: call-9', is_error: false });
  });
});
