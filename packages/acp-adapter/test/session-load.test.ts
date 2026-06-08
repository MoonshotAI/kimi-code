import { describe, expect, it } from 'vitest';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { KimiError, ErrorCodes, type Event, type KimiHarness, type Session } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS, UNAUTHED_STATUS, makeModelsMap } from './_helpers/harness-stubs';

class CapturingClient implements Client {
  readonly updates: SessionNotification[] = [];

  /**
   * Updates produced AFTER `session/load` returns. Phase 9.3 makes
   * `loadSession` emit exactly one `available_commands_update` after
   * the history-replay batch; existing replay tests assert only on
   * history-derived updates, so we filter that variant out.
   */
  get historyUpdates(): readonly SessionNotification[] {
    return this.updates.filter(
      (n) =>
        (n.update as { sessionUpdate?: string }).sessionUpdate !==
        'available_commands_update',
    );
  }

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('CapturingClient.requestPermission should not be called in session-load test');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('CapturingClient.writeTextFile should not be called in session-load test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('CapturingClient.readTextFile should not be called in session-load test');
  }
}

function makeInMemoryStreamPair(): {
  agentStream: ReturnType<typeof ndJsonStream>;
  clientStream: ReturnType<typeof ndJsonStream>;
} {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
  const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
  return { agentStream, clientStream };
}

function makeSessionWithHistory(
  sessionId: string,
  history: ReadonlyArray<unknown>,
): Session {
  return {
    id: sessionId,
    cancel: async () => undefined,
    prompt: async () => undefined,
    onEvent: (_fn: (event: Event) => void) => () => undefined,
    setApprovalHandler: () => undefined,
    getResumeState: () => ({
      agents: {
        main: {
          context: { history, tokenCount: 0 },
        },
      },
    }),
  } as unknown as Session;
}

function makeHarness(
  opts: {
    hasUsableToken?: boolean;
    session?: Session;
    resumeError?: Error;
  },
): KimiHarness {
  const authed = opts.hasUsableToken ?? true;
  return {
    auth: {
      status: async () => (authed ? AUTHED_STATUS : UNAUTHED_STATUS),
    },
    resumeSession: async (_input: { id: string }) => {
      if (opts.resumeError) throw opts.resumeError;
      if (!opts.session) throw new Error('test harness has no session configured');
      return opts.session;
    },
    // Phase 14: server.loadSession reads these to assemble configOptions
    // when the resumed session lacks a `modelAlias` (the fixture sessions
    // in this file do not set one). `models` map carries the same
    // (id, displayName, thinkingSupported) intent the old
    // `listAvailableModels` stub did — `kimi-coder` opts in to thinking
    // via `capabilities: ['thinking']`, `kimi-plain` stays off.
    getConfig: async () => ({
      providers: {},
      defaultModel: 'kimi-coder',
      models: makeModelsMap([
        { id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: true },
        { id: 'kimi-plain', name: 'Kimi Plain', thinkingSupported: false },
      ]),
    }),
  } as unknown as KimiHarness;
}

describe('AcpServer session/load auth gate', () => {
  it('rejects loadSession with auth_required (-32000) when no token', async () => {
    const harness = makeHarness({ hasUsableToken: false });
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const clientConn = new ClientSideConnection((_a) => new CapturingClient(), clientStream);

    await expect(
      clientConn.loadSession({ sessionId: 'sess-x', cwd: '/tmp/x', mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32000 });
  });
});

describe('AcpServer session/load replay', () => {
  it('replays a single assistant text-only turn as agent_message_chunk updates', async () => {
    const sessionId = 'sess-text-only';
    const history = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi there' }],
        toolCalls: [],
      },
    ];
    const session = makeSessionWithHistory(sessionId, history);
    const harness = makeHarness({ hasUsableToken: true, session });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new CapturingClient();
    const clientConn = new ClientSideConnection((_a) => client, clientStream);

    const response = await clientConn.loadSession({
      sessionId,
      cwd: '/tmp/x',
      mcpServers: [],
    });

    // Response shape: per ACP schema every field on LoadSessionResponse is
    // optional, so an empty object is a valid success body.
    expect(response).toBeDefined();

    // Two history entries → expect exactly two session/update notifications.
    expect(client.historyUpdates.length).toBe(2);
    expect(client.historyUpdates[0]?.update).toMatchObject({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hello' },
    });
    expect(client.historyUpdates[1]?.update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi there' },
    });
  });

  it('replays a turn with a tool call + tool result using ${turnId}:${toolCallId} ids', async () => {
    const sessionId = 'sess-with-tools';
    const history = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'ls' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'running ls' }],
        toolCalls: [
          {
            type: 'function',
            id: 'tc-abc',
            name: 'Bash',
            arguments: JSON.stringify({ command: 'ls' }),
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'tc-abc',
        content: [{ type: 'text', text: 'file1\nfile2' }],
        toolCalls: [],
      },
    ];
    const session = makeSessionWithHistory(sessionId, history);
    const harness = makeHarness({ hasUsableToken: true, session });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new CapturingClient();
    const clientConn = new ClientSideConnection((_a) => client, clientStream);

    await clientConn.loadSession({ sessionId, cwd: '/tmp/x', mcpServers: [] });

    // user_message_chunk + agent_message_chunk + tool_call + tool_call_update = 4 updates.
    expect(client.historyUpdates.length).toBe(4);
    expect(client.historyUpdates[0]?.update).toMatchObject({ sessionUpdate: 'user_message_chunk' });
    expect(client.historyUpdates[1]?.update).toMatchObject({ sessionUpdate: 'agent_message_chunk' });
    // Synthetic turnId starts at 1 (first assistant message in history).
    expect(client.historyUpdates[2]?.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: '1:tc-abc',
      title: 'Bash',
      status: 'in_progress',
    });
    expect(client.historyUpdates[3]?.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: '1:tc-abc',
      status: 'completed',
    });
  });

  it('maps the SDK session.not_found error to ACP invalid_params (-32602)', async () => {
    const harness = makeHarness({
      hasUsableToken: true,
      resumeError: new KimiError(ErrorCodes.SESSION_NOT_FOUND, 'Session "ghost" was not found'),
    });
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const clientConn = new ClientSideConnection((_a) => new CapturingClient(), clientStream);

    await expect(
      clientConn.loadSession({ sessionId: 'ghost', cwd: '/tmp/x', mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('registers the AcpSession under its id so subsequent calls can locate it', async () => {
    const sessionId = 'sess-registered';
    const session = makeSessionWithHistory(sessionId, []);
    const harness = makeHarness({ hasUsableToken: true, session });
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    let server: AcpServer | undefined;
    new AgentSideConnection((c) => {
      server = new AcpServer(harness, c);
      return server;
    }, agentStream);
    const clientConn = new ClientSideConnection((_a) => new CapturingClient(), clientStream);

    await clientConn.loadSession({ sessionId, cwd: '/tmp/x', mcpServers: [] });

    expect(server?.getSession(sessionId)?.id).toBe(sessionId);
  });

  it('advertises configOptions (PLAN D11 + Phase 15 thinking toggle) on loadSession too — model + thinking + mode under the unified surface', async () => {
    const sessionId = 'sess-modes-load';
    const session = makeSessionWithHistory(sessionId, []);
    const harness = makeHarness({ hasUsableToken: true, session });
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const clientConn = new ClientSideConnection((_a) => new CapturingClient(), clientStream);

    const response = await clientConn.loadSession({
      sessionId,
      cwd: '/tmp/x',
      mcpServers: [],
    });

    // Phase 14 (PLAN D11): the dedicated `modes:` field is gone; the
    // four-mode taxonomy now lives under `configOptions[id='mode']`.
    // Mode is still session-scoped and not persisted, so a resumed
    // session re-starts in `default`.
    expect(response.modes).toBeUndefined();

    expect(response.configOptions).toBeDefined();
    // Default model resolves to `kimi-coder` (thinkingSupported) so the
    // toggle is visible → 3 options.
    expect(response.configOptions).toHaveLength(3);
    const [modelOpt, thinkingOpt, modeOpt] = response.configOptions!;
    expect(modelOpt!.id).toBe('model');
    expect(thinkingOpt!.id).toBe('thinking');
    expect(modeOpt!.id).toBe('mode');

    if (thinkingOpt!.type !== 'select') {
      throw new Error('thinking option must be a select');
    }
    expect(thinkingOpt!.category).toBe('thought_level');
    expect(thinkingOpt!.currentValue).toBe('off');

    if (modeOpt!.type !== 'select') {
      throw new Error('mode option must be a select');
    }
    expect(modeOpt!.currentValue).toBe('default');
    expect(modeOpt!.options).toHaveLength(4);
    const modeIds = modeOpt!.options.map((o) => 'value' in o ? o.value : '');
    expect(modeIds).toEqual(['default', 'plan', 'auto', 'yolo']);
    for (const entry of modeOpt!.options) {
      if ('value' in entry) {
        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
        expect(typeof entry.description).toBe('string');
        expect((entry.description ?? '').length).toBeGreaterThan(0);
      }
    }

    if (modelOpt!.type !== 'select') {
      throw new Error('model option must be a select');
    }
    // Resumed session has no main-agent `modelAlias` in its fixture
    // resume state → server falls back to harness `defaultModel`.
    expect(modelOpt!.currentValue).toBe('kimi-coder');
    // Phase 15: model dropdown holds N rows (no `,thinking` variants).
    expect(modelOpt!.options).toHaveLength(2);
  });
});
