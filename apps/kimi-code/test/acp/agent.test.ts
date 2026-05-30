import {
  RequestError,
  type AgentSideConnection,
  type InitializeResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  ErrorCodes,
  KimiError,
  type ApprovalRequest,
  type Event,
  type KimiHarness,
  type Session,
  type SessionSummary,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { KimiAcpAgent } from '#/acp/agent';
import { KimiAcpSession } from '#/acp/session';

describe('KimiAcpAgent', () => {
  it('advertises ACP capabilities and auth methods during initialize', async () => {
    const { agent } = makeAgent();

    const response = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { auth: { terminal: true } },
    });

    expect(response).toMatchObject<InitializeResponse>({
      protocolVersion: 1,
      agentInfo: { name: 'kimi-code', title: 'Kimi Code', version: '0.0.0-test' },
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true },
        sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
      },
    });
    expect(response.authMethods?.map((method) => method.id)).toContain('kimi-code-terminal');
  });

  it('advertises terminal auth for the ACP registry validator capability shape', async () => {
    const { agent } = makeAgent();

    const response = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        terminal: true,
        _meta: { 'terminal-auth': true },
      },
    });

    expect(response.authMethods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kimi-code-terminal',
          type: 'terminal',
        }),
      ]),
    );
  });

  it('creates SDK sessions with ACP-provided MCP servers', async () => {
    const fake = makeAgent();

    const response = await fake.agent.newSession({
      cwd: '/tmp/project',
      mcpServers: [
        {
          name: 'filesystem',
          command: 'node',
          args: ['server.mjs'],
          env: [],
        },
      ],
    });

    expect(response).toEqual({
      sessionId: 'ses_acp',
      models: {
        availableModels: [
          {
            modelId: 'kimi-test',
            name: 'Kimi Test',
            description: 'local/kimi-test (1000 context)',
          },
        ],
        currentModelId: 'kimi-test',
      },
    });
    expect(fake.harness.ensureConfigFile).toHaveBeenCalledTimes(1);
    expect(fake.harness.createSession).toHaveBeenCalledWith({
      workDir: '/tmp/project',
      permission: 'manual',
      metadata: { acp: true },
      mcpServers: {
        filesystem: {
          transport: 'stdio',
          command: 'node',
          args: ['server.mjs'],
        },
      },
    });
  });

  it('sets the active ACP session model through the SDK session', async () => {
    const session = makeSession();
    const fake = makeAgent({ session });

    await fake.agent.newSession({ cwd: '/tmp/project', mcpServers: [] });

    await expect(
      fake.agent.unstable_setSessionModel({
        sessionId: 'ses_acp',
        modelId: 'kimi-test',
      }),
    ).resolves.toEqual({});
    expect(session.setModel).toHaveBeenCalledWith('kimi-test');
  });

  it('maps unknown ACP model selections to invalid params', async () => {
    const session = makeSession({
      setModel: vi.fn(async () => {
        throw new KimiError(
          ErrorCodes.CONFIG_INVALID,
          'Model "matrix-model" is not configured in config.toml.',
        );
      }),
    });
    const fake = makeAgent({ session });

    await fake.agent.newSession({ cwd: '/tmp/project', mcpServers: [] });

    await expect(
      fake.agent.unstable_setSessionModel({
        sessionId: 'ses_acp',
        modelId: 'matrix-model',
      }),
    ).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('resumes persisted sessions with ACP-provided MCP servers', async () => {
    const session = makeSession();
    const fake = makeAgent({
      session,
      sessions: [
        {
          id: 'ses_acp',
          workDir: '/tmp/project',
          sessionDir: '/tmp/kimi/sessions/ses_acp',
          createdAt: Date.parse('2026-05-29T01:00:00.000Z'),
          updatedAt: Date.parse('2026-05-30T02:03:04.000Z'),
        },
      ],
    });

    await expect(
      fake.agent.resumeSession({
        sessionId: 'ses_acp',
        cwd: '/tmp/project',
        mcpServers: [
          {
            type: 'http',
            name: 'docs',
            url: 'https://mcp.example.test',
            headers: [],
          },
        ],
      }),
    ).resolves.toEqual({
      models: {
        availableModels: [
          {
            modelId: 'kimi-test',
            name: 'Kimi Test',
            description: 'local/kimi-test (1000 context)',
          },
        ],
        currentModelId: 'kimi-test',
      },
    });
    expect(fake.harness.resumeSession).toHaveBeenCalledWith({
      id: 'ses_acp',
      mcpServers: {
        docs: {
          transport: 'http',
          url: 'https://mcp.example.test',
        },
      },
    });
  });

  it('rejects resume requests whose cwd does not match the persisted session', async () => {
    const fake = makeAgent({
      sessions: [
        {
          id: 'ses_acp',
          workDir: '/tmp/project',
          sessionDir: '/tmp/kimi/sessions/ses_acp',
          createdAt: Date.parse('2026-05-29T01:00:00.000Z'),
          updatedAt: Date.parse('2026-05-30T02:03:04.000Z'),
        },
      ],
    });

    await expect(
      fake.agent.resumeSession({
        sessionId: 'ses_acp',
        cwd: '/tmp/other',
        mcpServers: [],
      }),
    ).rejects.toMatchObject({
      code: -32602,
    });
    expect(fake.harness.resumeSession).not.toHaveBeenCalled();
  });

  it('forks persisted sessions with ACP-provided MCP servers', async () => {
    const forkedSession = makeSession({ id: 'ses_fork' });
    const fake = makeAgent({
      forkedSession,
      sessions: [
        {
          id: 'ses_acp',
          workDir: '/tmp/project',
          sessionDir: '/tmp/kimi/sessions/ses_acp',
          createdAt: Date.parse('2026-05-29T01:00:00.000Z'),
          updatedAt: Date.parse('2026-05-30T02:03:04.000Z'),
        },
      ],
    });

    await expect(
      fake.agent.unstable_forkSession({
        sessionId: 'ses_acp',
        cwd: '/tmp/project',
        mcpServers: [
          {
            name: 'filesystem',
            command: 'node',
            args: ['server.mjs'],
            env: [],
          },
        ],
      }),
    ).resolves.toEqual({
      sessionId: 'ses_fork',
      models: {
        availableModels: [
          {
            modelId: 'kimi-test',
            name: 'Kimi Test',
            description: 'local/kimi-test (1000 context)',
          },
        ],
        currentModelId: 'kimi-test',
      },
    });
    expect(fake.harness.forkSession).toHaveBeenCalledWith({
      id: 'ses_acp',
      mcpServers: {
        filesystem: {
          transport: 'stdio',
          command: 'node',
          args: ['server.mjs'],
        },
      },
    });
  });

  it('lists persisted sessions as ACP session info', async () => {
    const fake = makeAgent({
      sessions: [
        {
          id: 'ses_recent',
          workDir: '/tmp/project',
          sessionDir: '/tmp/kimi/sessions/ses_recent',
          title: 'Recent work',
          createdAt: Date.parse('2026-05-29T01:00:00.000Z'),
          updatedAt: Date.parse('2026-05-30T02:03:04.000Z'),
          metadata: { acp: true },
        },
      ],
    });

    await expect(fake.agent.listSessions({ cwd: '/tmp/project' })).resolves.toEqual({
      sessions: [
        {
          sessionId: 'ses_recent',
          cwd: '/tmp/project',
          title: 'Recent work',
          updatedAt: '2026-05-30T02:03:04.000Z',
        },
      ],
    });
    expect(fake.harness.ensureConfigFile).toHaveBeenCalledTimes(1);
    expect(fake.harness.listSessions).toHaveBeenCalledWith({ workDir: '/tmp/project' });
  });

  it('rejects unsupported session/list cursors before touching the harness', async () => {
    const fake = makeAgent();

    await expect(
      fake.agent.listSessions({ cwd: '/tmp/project', cursor: 'page-2' }),
    ).rejects.toThrow(RequestError);
    expect(fake.harness.listSessions).not.toHaveBeenCalled();
  });

  it('streams user and assistant chunks for a prompt turn', async () => {
    let listener: ((event: Event) => void) | undefined;
    const session = makeSession({
      onEvent: (next) => {
        listener = next;
        return () => {};
      },
      prompt: vi.fn(async () => {
        listener?.({
          type: 'turn.started',
          turnId: 1,
          origin: { kind: 'user' },
          sessionId: 'ses_acp',
          agentId: 'main',
        } as Event);
        listener?.({
          type: 'assistant.delta',
          turnId: 1,
          delta: 'hello',
          sessionId: 'ses_acp',
          agentId: 'main',
        } as Event);
        listener?.({
          type: 'turn.ended',
          turnId: 1,
          reason: 'completed',
          sessionId: 'ses_acp',
          agentId: 'main',
        } as Event);
      }),
    });
    const fake = makeAgent({ session });

    await fake.agent.newSession({ cwd: '/tmp/project', mcpServers: [] });
    const response = await fake.agent.prompt({
      sessionId: 'ses_acp',
      messageId: '00000000-0000-4000-8000-000000000000',
      prompt: [{ type: 'text', text: 'hi' }],
    });

    expect(response).toEqual({
      stopReason: 'end_turn',
      userMessageId: '00000000-0000-4000-8000-000000000000',
    });
    expect(fake.connection.sessionUpdate).toHaveBeenNthCalledWith(1, {
      sessionId: 'ses_acp',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'hi' },
        messageId: '00000000-0000-4000-8000-000000000000',
      },
    });
    expect(fake.connection.sessionUpdate).toHaveBeenNthCalledWith(2, {
      sessionId: 'ses_acp',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    });
  });

  it('waits for turn completion before resolving a prompt request', async () => {
    let listener: ((event: Event) => void) | undefined;
    const session = makeSession({
      onEvent: (next) => {
        listener = next;
        return () => {};
      },
      prompt: vi.fn(async () => {}),
    });
    const fake = makeAgent({ session });

    await fake.agent.newSession({ cwd: '/tmp/project', mcpServers: [] });
    let resolved = false;
    const promptPromise = fake.agent.prompt({
      sessionId: 'ses_acp',
      messageId: '00000000-0000-4000-8000-000000000001',
      prompt: [{ type: 'text', text: 'wait' }],
    }).then((response) => {
      resolved = true;
      return response;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    listener?.({
      type: 'turn.started',
      turnId: 3,
      origin: { kind: 'user' },
      sessionId: 'ses_acp',
      agentId: 'main',
    } as Event);
    listener?.({
      type: 'assistant.delta',
      turnId: 3,
      delta: 'done',
      sessionId: 'ses_acp',
      agentId: 'main',
    } as Event);
    await Promise.resolve();
    expect(resolved).toBe(false);

    listener?.({
      type: 'turn.ended',
      turnId: 3,
      reason: 'completed',
      sessionId: 'ses_acp',
      agentId: 'main',
    } as Event);

    await expect(promptPromise).resolves.toEqual({
      stopReason: 'end_turn',
      userMessageId: '00000000-0000-4000-8000-000000000001',
    });
    expect(fake.connection.sessionUpdate).toHaveBeenCalledWith({
      sessionId: 'ses_acp',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' },
      },
    });
  });

  it('unblocks pending permission requests when the session is cancelled', async () => {
    let approvalHandler: ((request: ApprovalRequest) => unknown) | undefined;
    let resolvePermission:
      | ((value: { outcome: { outcome: 'selected'; optionId: 'allow_once' } }) => void)
      | undefined;
    const session = makeSession({
      setApprovalHandler: vi.fn((handler: Parameters<Session['setApprovalHandler']>[0]) => {
        approvalHandler = handler as typeof approvalHandler;
      }),
    });
    const connection = {
      sessionUpdate: vi.fn(async (_params: SessionNotification) => {}),
      requestPermission: vi.fn(
        () =>
          new Promise<{ outcome: { outcome: 'selected'; optionId: 'allow_once' } }>((resolve) => {
            resolvePermission = resolve;
          }),
      ),
    };
    const acpSession = new KimiAcpSession(
      session,
      connection as unknown as AgentSideConnection,
    );

    const approval = approvalHandler?.({
      turnId: 2,
      toolCallId: 'tc_permission',
      toolName: 'Write',
      action: 'Write file',
      display: {
        kind: 'file_io',
        operation: 'write',
        path: '/tmp/project/file.txt',
        content: 'hello',
      },
    });
    await acpSession.cancel();

    await expect(approval).resolves.toEqual({
      decision: 'cancelled',
    });
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(connection.sessionUpdate).toHaveBeenCalledWith({
      sessionId: 'ses_acp',
      update: expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: '2:tc_permission',
        status: 'failed',
      }),
    });
    resolvePermission?.({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  });
});

function makeAgent(
  options: {
    session?: Session;
    forkedSession?: Session;
    sessions?: SessionSummary[];
  } = {},
) {
  const session = options.session ?? makeSession();
  const connection = {
    sessionUpdate: vi.fn(async (_params: SessionNotification) => {}),
    requestPermission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' as const } })),
  };
  const harness = {
    ensureConfigFile: vi.fn(async () => {}),
    getConfig: vi.fn(async () => ({
      providers: {
        local: {
          type: 'kimi',
          apiKey: 'sk-test',
        },
      },
      defaultModel: 'kimi-test',
      models: {
        'kimi-test': {
          provider: 'local',
          model: 'kimi-test',
          maxContextSize: 1000,
          displayName: 'Kimi Test',
        },
      },
    })),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    forkSession: vi.fn(async () => options.forkedSession ?? session),
    listSessions: vi.fn(async () => options.sessions ?? []),
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
    },
    close: vi.fn(async () => {}),
  };

  return {
    agent: new KimiAcpAgent({
      connection: connection as unknown as AgentSideConnection,
      version: '0.0.0-test',
      harness: harness as unknown as KimiHarness,
    }),
    connection,
    harness,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'ses_acp',
    workDir: '/tmp/project',
    onEvent: vi.fn(() => () => {}),
    setApprovalHandler: vi.fn(),
    prompt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({
      model: 'kimi-test',
      thinkingLevel: 'auto',
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 1000,
      contextUsage: 0,
    })),
    setModel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  } as unknown as Session;
}
