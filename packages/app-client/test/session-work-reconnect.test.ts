
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppApprovalRequest,
  AppQuestionRequest,
  AppSession,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  PromptSubmission,
} from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps as installKimiClientDeps, type KimiClientDeps } from '../src/client/deps';
import { agentState } from './agentFrames';

function setKimiClientDeps(deps: KimiClientDeps): void {
  installKimiClientDeps({
    ...deps,
    api: () => {
      const api = deps.api();
      if (api.getWorkspaceTrust === undefined) {
        Object.assign(api, { getWorkspaceTrust: vi.fn(async () => ({ trusted: true })) });
      }
      return api;
    },
  });
}

function listedOf(s: AppSession): AppSession {
  return {
    ...s,
    mainTurnActive: undefined,
    pendingInteraction: undefined,
    lastTurnReason: undefined,
    lastPrompt: s.lastPrompt ?? 'prompt',
  };
}

const clientApiMock: Record<string, unknown> = {};

beforeEach(() => {
  clientApiMock.getWorkspaceTrust = vi.fn(async () => ({ trusted: true }));
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
});

afterEach(() => {
  resetKimiClientDeps();
});

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

function session(id: string, busy: boolean, mainTurnActive: boolean): AppSession {
  return {
    id,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    busy,
    mainTurnActive,
    pendingInteraction: 'none',
    archived: false,
    cwd: '/workspace',
    model: 'model-1',
    usage: { ...usage },
    messageCount: 0,
    workspaceId: 'workspace-1',
  };
}

function approval(sessionId: string): AppApprovalRequest {
  return {
    approvalId: `approval-${sessionId}`,
    sessionId,
    toolCallId: `tool-${sessionId}`,
    toolName: 'Bash',
    action: 'run',
    display: null,
  };
}

function question(sessionId: string): AppQuestionRequest {
  return {
    questionId: `question-${sessionId}`,
    sessionId,
    questions: [{ id: 'question-1', question: 'Continue?', options: [] }],
  };
}

describe('useKimiWebClient session work reconnect baseline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    'reconciles after replay without overwriting live events or stranding the queue',
    { timeout: 30_000 },
    async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const stale = session('stale', true, true);
    const liveWork = session('live-work', false, false);
    const liveTurn = session('live-turn', true, true);
    const queued = session('queued', false, false);
    const localStart = session('local-start', false, false);
    const interaction = {
      ...session('interaction', false, false),
      pendingInteraction: 'approval' as const,
    };
    const liveInteraction = session('live-interaction', false, false);
    const mixedInteraction = {
      ...session('mixed-interaction', false, false),
      pendingInteraction: 'approval' as const,
    };
    const initial = [
      stale,
      liveWork,
      liveTurn,
      interaction,
      liveInteraction,
      mixedInteraction,
      queued,
      localStart,
    ];
    const baseline = [
      { ...session(stale.id, false, false), title: 'renamed-while-offline' },
      session(liveWork.id, false, false),
      {
        ...session(liveTurn.id, false, false),
        lastTurnReason: 'completed' as const,
      },
      (() => {
        const value = session(interaction.id, false, false);
        delete value.pendingInteraction;
        return value;
      })(),
      liveInteraction,
      mixedInteraction,
      session(queued.id, false, false),
      session(localStart.id, true, true),
    ];
    const recoveredBaseline = baseline.map((value) =>
      value.id === liveWork.id ? session(liveWork.id, true, true) : value,
    );

    let handlers: KimiEventHandlers | undefined;
    let resolveReconnectBaseline!: (value: { items: AppSession[]; hasMore: boolean }) => void;
    const reconnectBaseline = new Promise<{ items: AppSession[]; hasMore: boolean }>((resolve) => {
      resolveReconnectBaseline = resolve;
    });
    let resolveReconnectRequested!: () => void;
    const reconnectRequested = new Promise<void>((resolve) => {
      resolveReconnectRequested = resolve;
    });
    let globalWalk = 0;
    const isGlobalList = (input?: { pageSize?: number; hasPrompt?: boolean }) =>
      input?.hasPrompt === true && input.pageSize === undefined;

    const listSessions = vi.fn(
      (input?: { pageSize?: number; hasPrompt?: boolean }) => {
        if (isGlobalList(input)) {
          globalWalk += 1;
          if (globalWalk === 1) {
            resolveReconnectRequested();
            return reconnectBaseline;
          }
          return Promise.resolve({ items: recoveredBaseline, hasMore: false });
        }
        return Promise.resolve({ items: initial, hasMore: false });
      },
    );
    const baselineCalls = () =>
      listSessions.mock.calls.filter(([input]) => isGlobalList(input)).length;
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn((sid: string, agentId: string) => {
        queueMicrotask(() => handlers?.onConversation?.(sid, agentId, { type: 'turns', turns: [], has_more: false }));
      }),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const submitPrompt = vi.fn(async (_sid: string, input: PromptSubmission) => ({
      promptId: input.promptId!,
      userMessageId: input.promptId!,
      status: 'running' as const,
      acceptedAs: 'turn' as const,
    }));
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({
        modelsReady: true,
        providersCount: 1,
        managedProvider: null,
      })),
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
        {
          id: 'workspace-1',
          root: '/workspace',
          name: 'Workspace',
          sessionCount: initial.length,
        },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions,
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
      submitPrompt,
      getSession: vi.fn(async (id: string) => ({ id, archived: false, workspaceId: 'workspace-1' })),
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
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(queued.id);
      expect(handlers).toBeDefined();

      handlers!.onConnectionChange(true);
      expect(baselineCalls()).toBe(0);
      handlers!.onEvent(
        {
          type: 'approvalRequested',
          sessionId: interaction.id,
          approval: approval(interaction.id),
        },
        { sessionId: interaction.id },
      );
      expect(client.pendingBySession.value[interaction.id]?.approvals).toBe(1);
      handlers!.onEvent(
        {
          type: 'approvalRequested',
          sessionId: mixedInteraction.id,
          approval: approval(mixedInteraction.id),
        },
        { sessionId: mixedInteraction.id },
      );
      handlers!.onEvent(
        {
          type: 'questionRequested',
          sessionId: mixedInteraction.id,
          question: question(mixedInteraction.id),
        },
        { sessionId: mixedInteraction.id },
      );

      await client.sendPrompt(client.createPromptEnvelope({ text: 'first' }));
      await client.sendPrompt(client.createPromptEnvelope({ text: 'follow-up' }));
      expect(submitPrompt).toHaveBeenCalledTimes(2);

      handlers!.onConnectionChange(false);
      handlers!.onConnectionChange(true);
      await reconnectRequested;

      handlers!.onEvent(
        {
          type: 'sessionWorkChanged',
          sessionId: liveWork.id,
          busy: true,
          mainTurnActive: true,
        },
        { sessionId: liveWork.id },
      );
      handlers!.onEvent(
        {
          type: 'sessionWorkChanged',
          sessionId: liveTurn.id,
          busy: false,
          mainTurnActive: false,
          lastTurnReason: 'completed',
        },
        { sessionId: liveTurn.id },
      );
      handlers!.onEvent(
        { type: 'sessionMetaUpdated', sessionId: liveTurn.id, title: 'renamed-live' },
        { sessionId: liveTurn.id },
      );
      handlers!.onEvent(
        {
          type: 'sessionWorkChanged',
          sessionId: liveInteraction.id,
          busy: true,
          mainTurnActive: true,
          pendingInteraction: 'question',
        },
        { sessionId: liveInteraction.id },
      );
      handlers!.onEvent(
        {
          type: 'questionRequested',
          sessionId: liveInteraction.id,
          question: question(liveInteraction.id),
        },
        { sessionId: liveInteraction.id },
      );

      await client.selectSession(localStart.id);
      await client.sendPrompt(client.createPromptEnvelope({ text: 'new local turn' }));
      vi.useFakeTimers();
      resolveReconnectBaseline({ items: baseline, hasMore: false });
      await vi.advanceTimersByTimeAsync(0);
      const firstPromptId = submitPrompt.mock.calls[0]![1].promptId!;
      handlers!.onConversation?.(queued.id, 'main', {
        type: 'turns',
        turns: [{
          turn_id: 't0', ordinal: 0, turn_number: 1, kind: 'agent', status: 'ended', outcome: 'completed',
          started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:05.000Z', steps: [],
          items: [{
            type: 'user_message', item_id: firstPromptId, status: 'ended', outcome: 'completed',
            created_at: '2026-01-01T00:00:00.000Z', placement: 'opener', prompt_ids: [firstPromptId],
            origin: { kind: 'user' }, text: 'first', attachments: [], skills: [],
          }],
        }],
        has_more: false,
      });

      const byId = (id: string) =>
        client.workspaceGroups.value.flatMap((group) => group.sessions).find((item) => item.id === id);
      expect(byId(liveTurn.id)?.lastTurnReason).toBe('completed');
      expect(byId(stale.id)?.title).toBe('renamed-while-offline');
      expect(byId(liveTurn.id)?.title).toBe('renamed-live');
      expect(byId(interaction.id)?.pendingInteraction).toBe('none');
      expect(byId(liveInteraction.id)?.pendingInteraction).toBe('question');
      expect(client.pendingBySession.value[interaction.id]).toBeUndefined();
      expect(client.pendingBySession.value[liveInteraction.id]?.questions).toBe(1);
      expect(client.pendingBySession.value[mixedInteraction.id]).toEqual({
        approvals: 1,
        questions: 1,
      });
      await vi.advanceTimersByTimeAsync(1000);
      vi.useRealTimers();
      await vi.waitFor(() => {
        expect(byId(stale.id)?.busy).toBe(false);
        expect(byId(liveWork.id)?.busy).toBe(true);
        expect(byId(liveTurn.id)?.busy).toBe(false);
        expect(byId(localStart.id)?.busy).toBe(true);
        expect(submitPrompt).toHaveBeenCalledTimes(3);
      });
      expect(globalWalk).toBe(1);
      expect(
        submitPrompt.mock.calls.map(([, input]) =>
          input.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(''),
        ),
      ).toEqual(['first', 'follow-up', 'new local turn']);

      await client.selectSession(stale.id);
      const { filesStore } = await import('../src/stores/files');
      filesStore().selectedDiffRoot = '/extra';
      await new Promise((resolve) => setTimeout(resolve, 0));
      const turn = {
        turn_id: 'root-refresh-turn',
        ordinal: 2,
        turn_number: 3,
        kind: 'agent' as const,
        status: 'running' as const,
        started_at: '2026-01-01T00:00:06.000Z',
        steps: [],
      };
      handlers!.onAgentState?.(stale.id, 'main', agentState('running'));
      handlers!.onConversation?.(stale.id, 'main', { type: 'turn.started', turn });
      await new Promise((resolve) => setTimeout(resolve, 0));
      handlers!.onConversation?.(stale.id, 'main', {
        type: 'turn.ended',
        turn: { ...turn, status: 'ended', outcome: 'completed', ended_at: '2026-01-01T00:00:07.000Z' },
      });
      handlers!.onAgentState?.(stale.id, 'main', agentState('idle'));
      await vi.waitFor(() => {
        expect(api.getGitStatus).toHaveBeenCalledWith(
          stale.id,
          { root: '/extra' },
          expect.objectContaining({ root: '/extra' }),
        );
      });
      filesStore().clearFileDiff();

      vi.useFakeTimers();
      listSessions.mockRejectedValue(new Error('baseline-down'));
      handlers!.onConnectionChange(false);
      handlers!.onConnectionChange(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(baselineCalls()).toBe(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(baselineCalls()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(baselineCalls()).toBe(3);
      await vi.advanceTimersByTimeAsync(1999);
      expect(baselineCalls()).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(baselineCalls()).toBe(4);
      await vi.advanceTimersByTimeAsync(3999);
      expect(baselineCalls()).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(baselineCalls()).toBe(5);

      await vi.advanceTimersByTimeAsync(8_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(baselineCalls()).toBe(6);
      await vi.advanceTimersByTimeAsync(16_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(baselineCalls()).toBe(7);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(baselineCalls()).toBe(7);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(baselineCalls()).toBe(8);

      handlers!.onConnectionChange(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(baselineCalls()).toBe(8);
      vi.useRealTimers();
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it("keeps a side-chat agent pending approval across main transcript frames", async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('side-approval', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn(),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: 1 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: [target], hasMore: false })),
      listSessionGroups: vi.fn(async () => ({
        groups: [
          {
            workspaceId: 'workspace-1',
            sessions: [listedOf(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      startBtw: vi.fn(async () => ({ agentId: 'btw-1' })),
      submitPrompt: vi.fn(async (_sid: string, input: PromptSubmission) => ({ promptId: input.promptId!, userMessageId: input.promptId! })),
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
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();

      handlers!.onConnectionChange(true);

      await client.openSideChat();
      client.auxiliaryConversations.activate(target.id, 'btw-1');
      await new Promise((resolve) => setTimeout(resolve, 150));
      handlers!.onEvent(
        {
          type: 'approvalRequested',
          sessionId: target.id,
          approval: {
            approvalId: 'inter-btw-1',
            sessionId: target.id,
            agentId: 'btw-1',
            toolCallId: 'call-btw-1',
            toolName: 'Bash',
            action: 'run',
            display: null,
          },
        },
        { sessionId: target.id },
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await vi.waitFor(() =>
        expect(client.pendingBySession.value[target.id]?.approvals).toBe(1),
      );

      handlers!.onAgentState?.(target.id, 'main', agentState('running'));

      await vi.waitFor(() =>
        expect(client.pendingBySession.value[target.id]?.approvals).toBe(1),
      );

      handlers!.onEvent(
        {
          type: 'interactionEnded',
          sessionId: target.id,
          interactionId: 'inter-btw-1',
          kind: 'approval',
          outcome: 'approved',
        },
        { sessionId: target.id },
      );
      await vi.waitFor(() =>
        expect(client.pendingBySession.value[target.id]?.approvals ?? 0).toBe(0),
      );
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('shows the pending swarm pick while its profile write is in flight', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('swarm-target', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn(),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: 1 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: [target], hasMore: false })),
      listSessionGroups: vi.fn(async () => ({
        groups: [
          {
            workspaceId: 'workspace-1',
            sessions: [listedOf(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      updateSession: vi.fn(() => new Promise(() => undefined)),
      submitPrompt: vi.fn(async (_sid: string, input: PromptSubmission) => ({ promptId: input.promptId!, userMessageId: input.promptId! })),
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
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(client.swarmMode.value).toBe(false);

      client.setSwarmMode(true);

      await vi.waitFor(() => expect(client.swarmMode.value).toBe(true));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('keeps session interactions in step with interaction events and notifies each interaction once', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('interaction-events', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn(),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: 1 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: [target], hasMore: false })),
      listSessionGroups: vi.fn(async () => ({
        groups: [
          {
            workspaceId: 'workspace-1',
            sessions: [listedOf(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async (_sid: string, input: PromptSubmission) => ({ promptId: input.promptId!, userMessageId: input.promptId! })),
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
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const approvalOf = (approvalId: string, agentId: string): AppApprovalRequest => ({
      approvalId,
      sessionId: target.id,
      agentId,
      toolCallId: `call-${approvalId}`,
      toolName: 'Bash',
      action: 'run',
      display: null,
    });

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const { notificationsStore } = await import('../src/stores/notifications');
      const notifySpy = vi.spyOn(notificationsStore(), 'maybeNotifyApproval');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();
      const meta = { sessionId: target.id };

      const requestApproval = (approvalId: string, agentId: string): void => {
        handlers!.onEvent(
          { type: 'approvalRequested', sessionId: target.id, approval: approvalOf(approvalId, agentId) },
          meta,
        );
      };

      handlers!.onEvent({ type: 'interactionsReset', sessionId: target.id }, meta);
      requestApproval('inter-1', 'main');
      await vi.waitFor(() =>
        expect(client.pendingBySession.value[target.id]?.approvals).toBe(1),
      );
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(notifySpy).toHaveBeenLastCalledWith(expect.objectContaining({ approvalId: 'inter-1' }));

      handlers!.onEvent({ type: 'interactionsReset', sessionId: target.id }, meta);
      requestApproval('inter-1', 'main');
      requestApproval('inter-2', 'agent-detail-1');
      await vi.waitFor(() =>
        expect(client.pendingBySession.value[target.id]?.approvals).toBe(2),
      );
      expect(notifySpy).toHaveBeenCalledTimes(2);
      expect(notifySpy).toHaveBeenLastCalledWith(expect.objectContaining({ approvalId: 'inter-2' }));

      handlers!.onEvent(
        {
          type: 'interactionEnded',
          sessionId: target.id,
          interactionId: 'inter-1',
          kind: 'approval',
          outcome: 'cancelled',
        },
        meta,
      );
      await vi.waitFor(() =>
        expect(client.pendingBySession.value[target.id]?.approvals).toBe(1),
      );

      handlers!.onEvent({ type: 'interactionsReset', sessionId: target.id }, meta);
      await vi.waitFor(() =>
        expect(client.pendingBySession.value[target.id]).toBeUndefined(),
      );
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('settles a cancelled task row from its task event', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('skew-target', false, false);
    let handlers: KimiEventHandlers | undefined;
    const stopTask = vi.fn(async () => ({ code: 0 }));
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn(),
      unsubscribeConversation: vi.fn(),
      stopTask,
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: 1 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: [target], hasMore: false })),
      listSessionGroups: vi.fn(async () => ({
        groups: [
          {
            workspaceId: 'workspace-1',
            sessions: [listedOf(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async (_sid: string, input: PromptSubmission) => ({ promptId: input.promptId!, userMessageId: input.promptId! })),
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
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const running = {
        taskId: 'task-1',
        agentId: 'ag-1',
        kind: 'subagent' as const,
        state: 'running' as const,
        detached: true,
        description: 'explore',
        startedAt: '2027-01-01T00:00:00.000Z',
      };
      handlers!.onTask?.(target.id, 'main', running);
      const statusOf = () => client.activeAppTasks.value.find((task) => task.id === 'task-1')?.status;
      await vi.waitFor(() => expect(statusOf()).toBe('running'));

      await client.cancelTask('task-1');
      expect(stopTask).toHaveBeenCalledExactlyOnceWith(target.id, 'main', 'task-1');
      expect(statusOf()).toBe('running');

      handlers!.onTask?.(target.id, 'main', { ...running, state: 'killed', endedAt: '2027-01-01T00:00:05.000Z' });
      await vi.waitFor(() => expect(statusOf()).toBe('cancelled'));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['an active', true],
    ['a background', false],
  ])('notifies for a live sub-agent question in %s session', async (_, selected) => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('aux-notify', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn(),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: 1 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: [target], hasMore: false })),
      listSessionGroups: vi.fn(async () => ({
        groups: [
          {
            workspaceId: 'workspace-1',
            sessions: [listedOf(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async (_sid: string, input: PromptSubmission) => ({ promptId: input.promptId!, userMessageId: input.promptId! })),
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
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const { notificationsStore } = await import('../src/stores/notifications');
      const notifySpy = vi.spyOn(notificationsStore(), 'maybeNotifyQuestion');
      const client = useKimiWebClient();
      await client.load();
      if (selected) await client.selectSession(target.id);
      expect(handlers).toBeDefined();

      handlers!.onEvent(
        {
          type: 'questionRequested',
          sessionId: target.id,
          question: { ...question(target.id), agentId: 'agent-notify-1' },
        },
        { sessionId: target.id },
      );
      await vi.waitFor(() =>
        expect(notifySpy).toHaveBeenCalledWith(
          expect.objectContaining({ questionId: `question-${target.id}` }),
        ),
      );
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('drops a side chat’s pending approval when the side chat closes and keeps it out after a re-seed', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('btw-notify', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn(),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: 1 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: [target], hasMore: false })),
      listSessionGroups: vi.fn(async () => ({
        groups: [
          {
            workspaceId: 'workspace-1',
            sessions: [listedOf(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      startBtw: vi.fn(async () => ({ agentId: 'btw-1' })),
      closeAgent: vi.fn(async () => ({ closed: true as const })),
      getSessionWarnings: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const { approvalsStore } = await import('../src/stores/approvals');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      await client.openSideChatOn(target.id);
      expect(handlers).toBeDefined();

      const approvalIds = () =>
        (approvalsStore().approvalsBySession[target.id] ?? []).map((approval) => approval.approvalId);
      handlers!.onEvent(
        {
          type: 'approvalRequested',
          sessionId: target.id,
          approval: { ...approval(target.id), approvalId: 'inter-btw-1', agentId: 'btw-1' },
        },
        { sessionId: target.id },
      );
      await vi.waitFor(() => expect(approvalIds()).toContain('inter-btw-1'));

      client.closeSideChat('btw-1');
      expect(approvalIds()).not.toContain('inter-btw-1');

      handlers!.onEvent({ type: 'interactionsReset', sessionId: target.id }, { sessionId: target.id });
      handlers!.onEvent(
        {
          type: 'approvalRequested',
          sessionId: target.id,
          approval: { ...approval(target.id), approvalId: 'inter-btw-1', agentId: 'btw-1' },
        },
        { sessionId: target.id },
      );
      handlers!.onEvent(
        {
          type: 'approvalRequested',
          sessionId: target.id,
          approval: { ...approval(target.id), approvalId: 'inter-main-1', agentId: 'main' },
        },
        { sessionId: target.id },
      );
      await vi.waitFor(() => expect(approvalIds()).toEqual(['inter-main-1']));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('persists the folded tower mode from live events', async () => {
    vi.stubGlobal('WebSocket', class {});
    const storageData = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() { return storageData.size; },
      clear: () => storageData.clear(),
      getItem: (key: string) => storageData.get(key) ?? null,
      key: (index: number) => [...storageData.keys()][index] ?? null,
      removeItem: (key: string) => { storageData.delete(key); },
      setItem: (key: string, value: string) => { storageData.set(key, String(value)); },
    });
    vi.resetModules();

    const target = session('tower-persist', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn(),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: 1 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: [target], hasMore: false })),
      listSessionGroups: vi.fn(async () => ({
        groups: [
          {
            workspaceId: 'workspace-1',
            sessions: [listedOf(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      updateSession: vi.fn(async () => ({})),
      submitPrompt: vi.fn(async (_sid: string, input: PromptSubmission) => ({ promptId: input.promptId!, userMessageId: input.promptId! })),
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
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const { STORAGE_KEYS } = await import('@moonshot-ai/app-core/lib');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 150));

      handlers!.onConnectionChange(true);
      await new Promise((resolve) => setTimeout(resolve, 150));

      handlers!.onAgentState?.(target.id, 'main', agentState('idle', { towerMode: true }));
      await vi.waitFor(() => expect(client.towerMode.value).toBe(true));
      expect(JSON.parse(storageData.get(STORAGE_KEYS.towerMode) ?? '{}')).toEqual({ [target.id]: true });

      handlers!.onAgentState?.(target.id, 'main', agentState('idle'));
      await vi.waitFor(() => expect(client.towerMode.value).toBe(false));
      expect(JSON.parse(storageData.get(STORAGE_KEYS.towerMode) ?? '{}')).toEqual({});
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('does not mark a session unread when a post-baseline bump meets a terminal last turn', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const oldSession = session('baseline-terminal-bump-old', false, false);
    const freshSession = session('baseline-terminal-bump-fresh', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn(),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: 2 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: [oldSession, freshSession], hasMore: false })),
      listSessionGroups: vi.fn(async () => ({
        groups: [
          {
            workspaceId: 'workspace-1',
            sessions: [listedOf(oldSession), listedOf(freshSession)],
            total: 2,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async (id: string) => ({ id, archived: false, workspaceId: 'workspace-1' })),
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
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const { notificationsStore } = await import('../src/stores/notifications');
      const notifySpy = vi.spyOn(notificationsStore(), 'maybeNotifyCompletion');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(oldSession.id);
      await client.selectSession(freshSession.id);
      expect(client.activeSessionId.value).toBe(freshSession.id);

      handlers!.onAgentState?.(oldSession.id, 'main', agentState('idle'));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(client.unreadBySession.value[oldSession.id]).not.toBe(true);
      expect(notifySpy).not.toHaveBeenCalled();
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

});
