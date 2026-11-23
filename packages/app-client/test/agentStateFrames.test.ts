import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppQueuedInput,
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

  it('keeps the draft thinking pick when the initial frame arrives during its write', async () => {
    vi.stubGlobal('WebSocket', vi.fn());
    vi.resetModules();

    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, baseApi([], connection, handlersRef));
    const created = session('s_1');
    clientApiMock.createSession = vi.fn(async () => created);
    clientApiMock.getSession = vi.fn(async () => created);
    clientApiMock.submitPrompt = vi.fn(async () => ({ promptId: 'prompt-1', userMessageId: 'message-1' }));
    let releaseWrite!: () => void;
    clientApiMock.updateSession = vi.fn(
      () => new Promise((resolve) => { releaseWrite = () => resolve(created); }),
    );

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const { modeStore } = await import('../src/stores/mode');
    const client = useKimiWebClient();
    await client.load();
    await flush();
    await client.setThinking('max');
    const starting = client.startSessionAndSendPrompt(
      'workspace-1',
      client.createPromptEnvelope({ text: 'hello' }),
    );
    await vi.waitFor(() => expect(clientApiMock.updateSession).toHaveBeenCalled());
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
    expect(modeStore().thinkingBySession['s_1']).toBe('max');

    releaseWrite();
    await expect(starting).resolves.toEqual({ sessionId: 's_1', promptRejected: false });
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

  it('shows the main agent queue frame and acts on queued prompts by prompt id', async () => {
    vi.stubGlobal('WebSocket', class { close(): void {} });
    vi.resetModules();

    const connection = makeConnection();
    const handlersRef: { handlers?: KimiEventHandlers } = {};
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    const abortPrompt = vi.fn(async () => ({ aborted: true }));
    const steerPrompts = vi.fn(async (_sid: string, promptIds: string[]) => ({ steered: true, promptIds }));
    const moveQueuedPrompt = vi.fn(async () => undefined);
    Object.assign(clientApiMock, baseApi([session('s_1')], connection, handlersRef), {
      abortPrompt,
      steerPrompts,
      moveQueuedPrompt,
    });

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s_1');
    await flush();

    const createdAt = '2026-11-06T00:00:00.000Z';
    handlersRef.handlers?.onAgentQueue?.('s_1', 'agent-1', [
      { promptId: 'p_side', content: [{ type: 'text', text: 'side' }], createdAt },
    ]);
    handlersRef.handlers?.onAgentQueue?.('s_1', 'main', [
      { promptId: 'p_skill', content: [{ type: 'text', text: 'go' }], skills: [{ name: 'review' }], createdAt },
      { promptId: 'p_url', content: [{ type: 'image', source: { kind: 'url', url: 'https://example.test/a.png' } }], createdAt },
      { promptId: 'p_snap', content: [{ type: 'text', text: 'go' }], skills: [{ name: 'review' }], clientMetadata: { kimi_code_composer: {} }, createdAt },
    ]);
    await vi.waitFor(() => expect(client.queued.value.map((item) => item.editable)).toEqual([false, false, true]));
    const mainInputs: AppQueuedInput[] = [
      {
        promptId: 'p_a',
        content: [
          { type: 'text', text: 'wire text' },
          { type: 'file', fileId: 'f_1', name: 'notes.md', mediaType: 'text/markdown', size: 3 },
        ],
        clientMetadata: { display_text: 'shown text', edit_text: '/swarm shown text' },
        createdAt,
      },
      { promptId: 'p_b', content: [{ type: 'text', text: 'second' }], createdAt },
    ];
    handlersRef.handlers?.onAgentQueue?.('s_1', 'main', mainInputs);
    await vi.waitFor(() => expect(client.queued.value.map((item) => item.id)).toEqual(['p_a', 'p_b']));
    expect(client.queued.value[0]).toMatchObject({
      text: 'shown text',
      editText: '/swarm shown text',
      attachmentCount: 1,
      attachments: [{ kind: 'file', fileId: 'f_1', name: 'notes.md' }],
    });
    expect(client.queued.value[1]).toMatchObject({ text: 'second', attachmentCount: 0, kind: 'prompt' });
    expect(client.queued.value[1]?.editable).toBe(true);

    expect(await client.steerQueued('p_b')).toBe('ok');
    expect(steerPrompts).toHaveBeenCalledWith('s_1', ['p_b']);
    const { promptStore } = await import('../src/stores/prompt');
    expect(promptStore().optimisticMessagesBySession.s_1?.map((message) => message.metadata)).toEqual([
      expect.objectContaining({ 'kimiWeb.promptId': 'p_b', 'kimiWeb.steered': true, 'kimiWeb.steerPhase': 'accepted' }),
    ]);
    expect(client.queued.value.map((item) => item.id)).toEqual(['p_a']);
    handlersRef.handlers?.onAgentQueue?.('s_1', 'main', mainInputs);

    steerPrompts.mockResolvedValueOnce({ steered: false, promptIds: [] });
    expect(await client.steerQueued('p_a')).toBe('rejected');
    expect(steerPrompts).toHaveBeenCalledTimes(2);
    expect(promptStore().optimisticMessagesBySession.s_1?.map((message) => message.metadata?.['kimiWeb.promptId'])).toEqual(['p_b']);

    await client.reorderQueue('p_b', 'p_a');
    expect(moveQueuedPrompt).toHaveBeenLastCalledWith('s_1', 'main', 'p_b', 'p_a');
    expect(client.queued.value.map((item) => item.id)).toEqual(['p_b', 'p_a']);
    handlersRef.handlers?.onAgentQueue?.('s_1', 'main', [mainInputs[1]!, mainInputs[0]!]);

    moveQueuedPrompt.mockRejectedValueOnce(new Error('offline'));
    await client.reorderQueue('p_a', 'p_b');
    expect(moveQueuedPrompt).toHaveBeenLastCalledWith('s_1', 'main', 'p_a', 'p_b');
    expect(client.queued.value.map((item) => item.id)).toEqual(['p_b', 'p_a']);

    const rejects: ((error: Error) => void)[] = [];
    moveQueuedPrompt.mockImplementation(() => new Promise((_resolve, reject) => { rejects.push(reject); }));
    const first = client.reorderQueue('p_a', 'p_b');
    const second = client.reorderQueue('p_b', 'p_a');
    await vi.waitFor(() => expect(rejects).toHaveLength(1));
    rejects[0]!(new Error('offline'));
    await first;
    await vi.waitFor(() => expect(rejects).toHaveLength(2));
    rejects[1]!(new Error('offline'));
    await second;
    expect(client.queued.value.map((item) => item.id)).toEqual(['p_b', 'p_a']);

    expect(await client.unqueue('p_a')).toBe(true);
    expect(abortPrompt).toHaveBeenCalledWith('s_1', 'p_a');
    expect(client.queued.value.map((item) => item.id)).not.toContain('p_a');

    let answerSteer!: (value: { steered: boolean; promptIds: string[] }) => void;
    steerPrompts.mockImplementationOnce(() => new Promise((done) => { answerSteer = done; }));
    const lateSteer = client.steerQueued('p_b');
    handlersRef.handlers?.onAgentQueue?.('s_1', 'main', [
      { promptId: 'p_b', content: [{ type: 'text', text: 'second' }], createdAt },
    ]);
    answerSteer({ steered: true, promptIds: ['p_b'] });
    expect(await lateSteer).toBe('ok');
    expect(client.queued.value).toEqual([]);
    expect(promptStore().optimisticMessagesBySession.s_1?.map((message) => message.metadata?.['kimiWeb.promptId'])).toEqual(['p_b', 'p_b']);

    handlersRef.handlers?.onAgentQueue?.('s_1', 'main', [
      { promptId: 'p_c', content: [{ type: 'text', text: 'first line' }, { type: 'text', text: 'second line' }], createdAt },
    ]);
    await vi.waitFor(() =>
      expect(client.queued.value[0]).toMatchObject({ id: 'p_c', text: 'first line\nsecond line' }),
    );
    expect(promptStore().optimisticMessagesBySession.s_1?.map((message) => message.metadata?.['kimiWeb.promptId'])).toEqual(['p_b', 'p_b']);
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
