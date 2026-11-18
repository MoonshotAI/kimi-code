
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSession,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
} from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalCostUsd: 0,
  contextTokens: 0,
  contextLimit: 0,
  turnCount: 0,
};

function session(id: string, updatedAt = '2026-01-01T00:00:00.000Z'): AppSession {
  return {
    id,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    busy: false,
    mainTurnActive: false,
    pendingInteraction: 'none',
    archived: false,
    cwd: '/workspace',
    model: 'model-1',
    usage: { ...usage },
    messageCount: 0,
    workspaceId: 'workspace-1',
  };
}

function listedOf(s: AppSession): AppSession {
  return { ...s, lastPrompt: s.lastPrompt ?? 'prompt' };
}

function makeConnection(): KimiEventConnection {
  return {
    subscribeConversation: vi.fn(),
    unsubscribeConversation: vi.fn(),
    health: () => ({ connected: true, open: true, stale: false }),
    reconnect: vi.fn(),
    close: vi.fn(),
  };
}

const clientApiMock: Record<string, unknown> = {};

beforeEach(() => {
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
});

afterEach(() => {
  resetKimiClientDeps();
});

function baseApi(
  initial: AppSession[],
  connection: KimiEventConnection,
  getSession: KimiWebApi['getSession'],
  handlersRef: { handlers?: KimiEventHandlers },
): Partial<KimiWebApi> {
  return {
    getAuth: vi.fn(async () => ({ modelsReady: true, providersCount: 1, managedProvider: null })),
    getHealth: vi.fn(async () => ({ status: 'ok', uptimeSec: 1 })),
    getMeta: vi.fn(async () => ({
      serverVersion: '0.0.0',
      serverId: 'server-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      capabilities: {},
      openInApps: [],
      dangerousBypassAuth: false,
      backend: 'v2',
    })),
    getConfig: vi.fn(async () => ({ providers: {}, defaultModel: 'model-1' })),
    listModels: vi.fn(async () => []),
    listProviders: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => [
      { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: initial.length },
    ]),
    getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
    listSessions: vi.fn(async () => ({ items: [], hasMore: false, nextPageToken: null, total: 0 })),
    listSessionGroups: vi.fn(async () => ({
      groups: [
        {
          workspaceId: 'workspace-1',
          sessions: initial.map(listedOf),
          total: initial.length,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    })),
    getSession,
    getSessionGoal: vi.fn(async () => null),
    getSessionWarnings: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => ({
      branch: '',
      ahead: 0,
      behind: 0,
      entries: {},
      additions: 0,
      deletions: 0,
      pullRequest: null,
    })),
    listSkills: vi.fn(async () => []),
    listSkillsForWorkspace: vi.fn(async () => []),
    getFileUrl: (fileId) => `file:${fileId}`,
    connectEvents: vi.fn((nextHandlers: KimiEventHandlers) => {
      handlersRef.handlers = nextHandlers;
      return connection;
    }),
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
}

describe('sessionRowRefresh on activity moments', () => {
  it('a fresh turn boundary re-pulls the row and the server stamp floats the session', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const initial = [session('other'), session('s_1')];
    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    const getSession = vi.fn(async (id: string) =>
      id === 's_1'
        ? { ...session(id), updatedAt: '2026-06-01T00:00:00.000Z' }
        : session(id),
    );
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi(initial, connection, getSession, handlersRef));

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s_1');
    handlersRef.handlers?.onEvent(
      { type: 'sessionWorkChanged', sessionId: 's_1', busy: true, mainTurnActive: true },
      { sessionId: 's_1' },
    );
    await flush();
    getSession.mockClear();

    handlersRef.handlers?.onEvent(
      { type: 'sessionWorkChanged', sessionId: 's_1', busy: false, mainTurnActive: false, lastTurnReason: 'completed' },
      { sessionId: 's_1' },
    );
    await flush();

    expect(getSession).toHaveBeenCalledWith('s_1');
    expect(client.sessions.value.map((s) => s.id)[0]).toBe('s_1');
  });


  it('a live interaction event re-pulls the row', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = { ...session('live-x'), busy: true, mainTurnActive: true };
    const other = session('other', '2026-06-01T00:00:00.000Z');
    const initial = [other, target];
    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    let serverUpdatedAt = '2026-01-01T00:00:00.000Z';
    const getSession = vi.fn(async (id: string) =>
      id === 'live-x' ? { ...session(id), updatedAt: serverUpdatedAt } : session(id),
    );
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi(initial, connection, getSession, handlersRef));

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('live-x');
    await flush();
    getSession.mockClear();
    expect(client.sessions.value.map((s) => s.id)[0]).toBe('other');

    serverUpdatedAt = '2026-06-02T00:00:00.000Z';
    handlersRef.handlers?.onEvent(
      {
        type: 'approvalRequested',
        sessionId: 'live-x',
        approval: {
          approvalId: 'inter-live-1',
          sessionId: 'live-x',
          toolCallId: 'call-live-1',
          toolName: 'Bash',
          action: 'run',
          display: null,
        },
      },
      { sessionId: 'live-x' },
    );
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledWith('live-x'));
    await vi.waitFor(() => expect(client.sessions.value.map((s) => s.id)[0]).toBe('live-x'));
  });

  it('a new running turn re-pulls the row at turn start, not only at turn end', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('live-start');
    const other = session('other', '2026-06-01T00:00:00.000Z');
    const initial = [other, target];
    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    let serverUpdatedAt = '2026-01-01T00:00:00.000Z';
    const getSession = vi.fn(async (id: string) =>
      id === 'live-start' ? { ...session(id), updatedAt: serverUpdatedAt } : session(id),
    );
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi(initial, connection, getSession, handlersRef));

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('live-start');
    await flush();
    getSession.mockClear();
    expect(client.sessions.value.map((s) => s.id)[0]).toBe('other');

    serverUpdatedAt = '2026-06-02T00:00:00.000Z';
    handlersRef.handlers?.onConversation?.('live-start', 'main', { type: 'turns', turns: [], has_more: false });
    handlersRef.handlers?.onConversation?.('live-start', 'main', {
      type: 'turn.started',
      turn: { turn_id: 't0', ordinal: 0, turn_number: 1, kind: 'agent', status: 'running', started_at: '2026-06-02T00:00:00.000Z', steps: [] },
    });

    await vi.waitFor(() => expect(getSession).toHaveBeenCalledWith('live-start'));
    await vi.waitFor(() => expect(client.sessions.value.map((s) => s.id)[0]).toBe('live-start'));
  });
});
