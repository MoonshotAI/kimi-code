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

function session(id: string): AppSession {
  return {
    id,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
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
      total: initial.length,
    })),
    getSession: vi.fn(async (id: string) => session(id)),
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

describe('agent state frames', () => {
  it('folds the main agent frame into the session settings authoritatively', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi([session('s_1')], connection, handlersRef));

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s_1');
    await flush();

    handlersRef.handlers?.onAgentState?.('s_1', 'main', {
      status: 'running',
      model: 'model-2',
      thinking: 'low',
      permissionMode: 'yolo',
      planMode: true,
      swarmMode: false,
      towerMode: false,
    });
    await vi.waitFor(() => expect(client.planMode.value).toBe(true));
    expect(client.status.value.permission).toBe('yolo');

    handlersRef.handlers?.onAgentState?.('s_1', 'main', {
      status: 'idle',
      model: 'model-2',
      thinking: 'low',
      permissionMode: 'manual',
      planMode: false,
      swarmMode: false,
      towerMode: false,
    });
    await vi.waitFor(() => expect(client.planMode.value).toBe(false));
    expect(client.status.value.permission).toBe('manual');
  });

  it('applies agent and usage frames that arrived before the session row', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi([session('s_1')], connection, handlersRef));

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const { sessionsStore } = await import('../src/stores/sessions');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s_1');
    await flush();

    handlersRef.handlers?.onAgentState?.('s_2', 'main', {
      status: 'idle',
      model: 'model-9',
      planMode: false,
      swarmMode: false,
      towerMode: false,
    });
    handlersRef.handlers?.onAgentUsage?.('s_2', 'main', { contextTokens: 5000, contextLimit: 200000 });
    sessionsStore().upsertSessionSorted(session('s_2'));
    await flush();

    const row = sessionsStore().sessions.find((s) => s.id === 's_2');
    expect(row?.model).toBe('model-9');
    expect(row?.usage.contextTokens).toBe(5000);
    expect(row?.usage.contextLimit).toBe(200000);
  });

  it('shows a model switch while its write is in flight, then follows the agent frames', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi([session('s_1')], connection, handlersRef));
    let releaseWrite!: () => void;
    clientApiMock.updateSession = vi.fn(
      () => new Promise((resolve) => { releaseWrite = () => resolve(session('s_1')); }),
    );

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const { sessionsStore } = await import('../src/stores/sessions');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s_1');
    await flush();
    const modelOf = () => sessionsStore().sessions.find((s) => s.id === 's_1')?.model;
    const frame = (model: string) => ({
      status: 'idle' as const,
      model,
      planMode: false,
      swarmMode: false,
      towerMode: false,
    });

    const switching = client.setSessionModel('s_1', 'model-2');
    await flush();
    handlersRef.handlers?.onAgentState?.('s_1', 'main', frame('model-1'));
    await flush();
    expect(modelOf()).toBe('model-2');

    handlersRef.handlers?.onAgentState?.('s_1', 'main', frame('model-2'));
    releaseWrite();
    await expect(switching).resolves.toBe(true);
    expect(modelOf()).toBe('model-2');

    handlersRef.handlers?.onAgentState?.('s_1', 'main', frame('model-3'));
    await flush();
    expect(modelOf()).toBe('model-3');
  });

  it('keeps a successful thinking write when its agent frame arrives after the response', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi([session('s_1')], connection, handlersRef));
    let releaseWrite!: () => void;
    clientApiMock.updateSession = vi.fn(
      () => new Promise((resolve) => { releaseWrite = () => resolve(session('s_1')); }),
    );

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const { modeStore } = await import('../src/stores/mode');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s_1');
    await flush();
    const frame = (thinking: string) => ({
      status: 'idle' as const,
      model: 'model-1',
      thinking,
      planMode: false,
      swarmMode: false,
      towerMode: false,
    });

    handlersRef.handlers?.onAgentState?.('s_1', 'main', frame('high'));
    await flush();
    expect(modeStore().thinkingBySession['s_1']).toBe('high');

    client.setThinking('max');
    await flush();
    expect(modeStore().thinkingBySession['s_1']).toBe('max');

    releaseWrite();
    await flush();
    expect(modeStore().thinkingBySession['s_1']).toBe('max');

    handlersRef.handlers?.onAgentState?.('s_1', 'main', frame('low'));
    await flush();
    expect(modeStore().thinkingBySession['s_1']).toBe('low');
  });

  it('falls back to the latest agent frame when a model switch fails', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi([session('s_1')], connection, handlersRef));
    let failWrite!: () => void;
    clientApiMock.updateSession = vi.fn(
      () => new Promise((_resolve, reject) => { failWrite = () => reject(new Error('write failed')); }),
    );

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const { sessionsStore } = await import('../src/stores/sessions');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s_1');
    await flush();
    const modelOf = () => sessionsStore().sessions.find((s) => s.id === 's_1')?.model;

    const switching = client.setSessionModel('s_1', 'model-2');
    await flush();
    handlersRef.handlers?.onAgentState?.('s_1', 'main', {
      status: 'idle',
      model: 'model-1',
      planMode: false,
      swarmMode: false,
      towerMode: false,
    });
    await flush();
    expect(modelOf()).toBe('model-2');

    failWrite();
    await expect(switching).resolves.toBe(false);
    expect(modelOf()).toBe('model-1');
  });

  it('follows a frame without a model or thinking level, also after a failed write', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi([session('s_1')], connection, handlersRef));
    clientApiMock.updateSession = vi.fn(async () => {
      throw new Error('write failed');
    });

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const { sessionsStore } = await import('../src/stores/sessions');
    const { modeStore } = await import('../src/stores/mode');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s_1');
    await flush();
    const frame = { status: 'idle' as const, planMode: false, swarmMode: false, towerMode: false };
    handlersRef.handlers?.onAgentState?.('s_1', 'main', { ...frame, model: 'model-1', thinking: 'high' });
    handlersRef.handlers?.onAgentState?.('s_1', 'main', frame);
    await flush();
    const modelOf = () => sessionsStore().sessions.find((s) => s.id === 's_1')?.model;
    expect(modelOf()).toBe('');
    expect(modeStore().thinkingBySession['s_1']).toBeUndefined();

    await expect(client.setSessionModel('s_1', 'model-2')).resolves.toBe(false);
    expect(modelOf()).toBe('');
  });

  it('reports an earlier failure in the same settings write chain', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi([session('s_1')], connection, handlersRef));
    clientApiMock.updateSession = vi.fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValue(session('s_1'));

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s_1');
    await flush();

    const first = client.setSessionModel('s_1', 'model-2');
    const second = client.setSessionModel('s_1', 'model-3');
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });

  it('shows the main agent todo frame in the dock', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi([session('s_1')], connection, handlersRef));

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s_1');
    await flush();

    handlersRef.handlers?.onAgentTodos?.('s_1', 'agent-1', [{ title: 'side work', status: 'pending' }]);
    handlersRef.handlers?.onAgentTodos?.('s_1', 'main', [
      { title: 'write tests', status: 'in_progress' },
      { title: 'ship', status: 'pending' },
    ]);
    await vi.waitFor(() =>
      expect(client.todos.value).toEqual([
        { title: 'write tests', status: 'in_progress' },
        { title: 'ship', status: 'pending' },
      ]),
    );

    handlersRef.handlers?.onAgentTodos?.('s_1', 'main', []);
    await vi.waitFor(() => expect(client.todos.value).toEqual([]));
  });

  it('folds context usage into the status bar, including post-compaction drops', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi([session('s_1')], connection, handlersRef));

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s_1');
    await flush();

    expect(client.status.value.ctxUsed).toBe(0);

    handlersRef.handlers?.onAgentUsage?.('s_1', 'main', { contextTokens: 784000, contextLimit: 1000000 });
    await vi.waitFor(() => expect(client.status.value.ctxUsed).toBe(784000));
    expect(client.status.value.ctxMax).toBe(1000000);

    handlersRef.handlers?.onAgentUsage?.('s_1', 'main', { contextTokens: 48800, contextLimit: 1000000 });
    await vi.waitFor(() => expect(client.status.value.ctxUsed).toBe(48800));
    expect(client.status.value.ctxMax).toBe(1000000);

    handlersRef.handlers?.onAgentUsage?.('s_1', 'main', { contextTokens: 1200 });
    await vi.waitFor(() => expect(client.status.value.ctxUsed).toBe(1200));
    expect(client.status.value.ctxMax).toBe(0);
  });

  it('leaves the usage untouched when only the agent state changes', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi([session('s_1')], connection, handlersRef));

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s_1');
    await flush();

    handlersRef.handlers?.onAgentUsage?.('s_1', 'main', { contextTokens: 48000, contextLimit: 1000000 });
    await vi.waitFor(() => expect(client.status.value.ctxUsed).toBe(48000));

    handlersRef.handlers?.onAgentState?.('s_1', 'main', {
      status: 'idle',
      thinking: 'high',
      planMode: false,
      swarmMode: false,
      towerMode: false,
    });
    await flush();
    expect(client.status.value.ctxUsed).toBe(48000);
  });
});
