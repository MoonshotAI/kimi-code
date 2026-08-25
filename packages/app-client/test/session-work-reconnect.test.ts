/**
 * Scenario: the WebSocket reconnects after session work changed while the
 * client was offline.
 * Responsibilities: wait for replay ACK, refresh list-level work state,
 * preserve live events during the REST request, and drain queued prompts.
 * Wiring: the real composable with daemon requests and the socket stubbed.
 * Run: cd packages/app-client && npx vitest run test/session-work-reconnect.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppApprovalRequest,
  AppQuestionRequest,
  AppSession,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  PromptSubmitResult,
  V2Session,
} from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';

/** Convert an AppSession fixture to the v2 grouped-wire shape the initial
 *  load consumes (one group for the single stub workspace). */
function v2Of(s: AppSession): V2Session {
  return {
    id: s.id,
    workspace: { id: s.workspaceId ?? 'workspace-1', cwd: s.cwd },
    meta: {
      title: s.title,
      last_prompt: s.lastPrompt ?? 'prompt',
      created_at: Date.parse(s.createdAt),
      updated_at: Date.parse(s.updatedAt),
      archived: s.archived,
      archived_at: null,
    },
    activity: { status: s.busy ? 'running' : 'idle' },
  };
}

const clientApiMock: Record<string, unknown> = {};

// The client modules resolve the api through the deps registry at call time
// (the registry cell lives on globalThis, so the fresh module graph after
// vi.resetModules below still sees this registration).
beforeEach(() => {
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
    lastSeq: 0,
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
    expiresAt: '2026-01-01T01:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function question(sessionId: string): AppQuestionRequest {
  return {
    questionId: `question-${sessionId}`,
    sessionId,
    questions: [{ id: 'question-1', question: 'Continue?', options: [] }],
    createdAt: '2026-01-01T00:00:00.000Z',
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
    const staleReplay = { ...session('stale-replay', false, false), lastSeq: 2 };
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
      staleReplay,
      liveInteraction,
      mixedInteraction,
      queued,
      localStart,
    ];
    const baseline = [
      session(stale.id, false, false),
      session(liveWork.id, false, false),
      {
        ...session(liveTurn.id, false, false),
        lastTurnReason: 'completed' as const,
      },
      (() => {
        const value = session(interaction.id, false, false);
        value.lastSeq = 2;
        delete value.pendingInteraction;
        return value;
      })(),
      staleReplay,
      liveInteraction,
      { ...mixedInteraction, lastSeq: 2 },
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
    const continuationError = new Error('second page unavailable');

    const listSessions = vi.fn(
      (input?: { pageSize?: number; beforeId?: string }) => {
        if (input?.pageSize === 100) {
          if (input.beforeId === undefined) {
            globalWalk += 1;
            if (globalWalk === 1) {
              resolveReconnectRequested();
              return reconnectBaseline;
            }
            return Promise.resolve({ items: recoveredBaseline, hasMore: false });
          }
          return Promise.reject(continuationError);
        }
        return Promise.resolve({ items: initial, hasMore: false });
      },
    );
    // The reconnect baseline is the pageSize-100 global walk; the initial
    // load goes through the grouped endpoint and never touches listSessions.
    const baselineCalls = () =>
      listSessions.mock.calls.filter(
        ([input]) => (input as { pageSize?: number } | undefined)?.pageSize === 100,
      ).length;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    let submissionCount = 0;
    const submitPrompt = vi.fn(async () => {
      submissionCount += 1;
      return {
        promptId: `prompt-${submissionCount}`,
        userMessageId: `message-${submissionCount}`,
        status: 'running' as const,
      };
    });
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({
        ready: true,
        defaultModel: 'model-1',
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: initial.map(v2Of),
            total: initial.length,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      submitPrompt,
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      // The reconnect baseline now settles offline turn ends through the
      // transcript replay: the mock serves one completed turn (the offline
      // 'first' prompt) so the edge watcher settles it and drains 'follow-up'.
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [
          {
            kind: 'turn',
            turnId: 't0',
            ordinal: 0,
            state: 'completed',
            origin: { kind: 'user', payload: { kind: 'user' } },
            prompt: 'first',
            steps: [],
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:00:05.000Z',
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        // The stamped prompt id is known ('prompt-1' from the submit mock):
        // a real baseline carries its entity — the settle is identity-judged,
        // not text-guessed.
        prompts: [
          {
            promptId: 'prompt-1',
            status: 'completed',
            content: [{ type: 'text', text: 'first' }],
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      handlers!.onReplayComplete?.();
      expect(baselineCalls()).toBe(0);
      handlers!.onEvent(
        {
          type: 'approvalRequested',
          sessionId: interaction.id,
          approval: approval(interaction.id),
        },
        { sessionId: interaction.id, seq: 1 },
      );
      expect(client.pendingBySession.value[interaction.id]?.approvals).toBe(1);
      handlers!.onEvent(
        {
          type: 'approvalRequested',
          sessionId: mixedInteraction.id,
          approval: approval(mixedInteraction.id),
        },
        { sessionId: mixedInteraction.id, seq: 1 },
      );
      handlers!.onEvent(
        {
          type: 'questionRequested',
          sessionId: mixedInteraction.id,
          question: question(mixedInteraction.id),
        },
        { sessionId: mixedInteraction.id, seq: 2 },
      );

      await client.sendPrompt('first');
      await client.sendPrompt('follow-up');
      expect(submitPrompt).toHaveBeenCalledTimes(1);

      handlers!.onConnectionChange(false);
      handlers!.onConnectionChange(true);
      await Promise.resolve();
      expect(baselineCalls()).toBe(0);
      handlers!.onReplayComplete?.();
      await reconnectRequested;

      handlers!.onEvent(
        {
          type: 'sessionWorkChanged',
          sessionId: liveWork.id,
          busy: true,
          mainTurnActive: true,
        },
        { sessionId: liveWork.id, seq: 1 },
      );
      handlers!.onEvent(
        {
          type: 'turnActiveChanged',
          sessionId: liveTurn.id,
          active: false,
          reason: 'completed',
        },
        { sessionId: liveTurn.id, seq: 1 },
      );
      handlers!.onEvent(
        {
          type: 'sessionWorkChanged',
          sessionId: staleReplay.id,
          busy: true,
          mainTurnActive: true,
          pendingInteraction: 'approval',
        },
        { sessionId: staleReplay.id, seq: 1 },
      );
      handlers!.onEvent(
        {
          type: 'questionRequested',
          sessionId: liveInteraction.id,
          question: question(liveInteraction.id),
        },
        { sessionId: liveInteraction.id, seq: 1 },
      );

      await client.selectSession(localStart.id);
      await client.sendPrompt('new local turn');
      vi.useFakeTimers();
      resolveReconnectBaseline({ items: baseline.slice(0, 7), hasMore: true });
      await vi.advanceTimersByTimeAsync(0);

      const byId = (id: string) =>
        client.workspaceGroups.value.flatMap((group) => group.sessions).find((item) => item.id === id);
      expect(byId(liveTurn.id)?.lastTurnReason).toBe('completed');
      expect(byId(interaction.id)?.pendingInteraction).toBe('none');
      expect(byId(staleReplay.id)?.busy).toBe(false);
      expect(byId(liveInteraction.id)?.pendingInteraction).toBe('question');
      expect(client.pendingBySession.value[interaction.id]).toBeUndefined();
      expect(client.pendingBySession.value[liveInteraction.id]?.questions).toBe(1);
      expect(client.pendingBySession.value[mixedInteraction.id]).toEqual({
        approvals: 1,
        questions: 1,
      });
      handlers!.onEvent(
        {
          type: 'sessionWorkChanged',
          sessionId: staleReplay.id,
          busy: true,
          mainTurnActive: true,
        },
        { sessionId: staleReplay.id, seq: 1 },
      );
      handlers!.onEvent(
        {
          type: 'approvalRequested',
          sessionId: interaction.id,
          approval: approval(interaction.id),
        },
        { sessionId: interaction.id, seq: 1 },
      );
      expect(byId(staleReplay.id)?.busy).toBe(false);
      expect(client.pendingBySession.value[interaction.id]).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1000);
      vi.useRealTimers();
      await vi.waitFor(() => {
        expect(byId(stale.id)?.busy).toBe(false);
        expect(byId(liveWork.id)?.busy).toBe(true);
        expect(byId(liveTurn.id)?.busy).toBe(false);
        expect(byId(localStart.id)?.busy).toBe(true);
        expect(submitPrompt).toHaveBeenCalledTimes(3);
      });
      expect(globalWalk).toBe(2);
      expect(
        submitPrompt.mock.calls.map(([, input]) =>
          input.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(''),
        ),
      ).toEqual(['first', 'new local turn', 'follow-up']);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it(
    're-activates an entryless active session on a capped backoff after a failed first read',
    { timeout: 30_000 },
    async () => {
    // The first-read failure drops the entry; re-selecting the SAME session
    // fires no session-change watcher, so the activate logic must also watch
    // entry existence and retry with a bounded backoff.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('reactivate', false, false);
    let handlers: KimiEventHandlers | undefined;
    let offline = true;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => {
        if (offline) throw new Error('network down');
        return {
          agentId: 'main',
          items: [],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [],
          agents: [],
          pendingInteractions: [],
          meta: { activity: 'idle' },
          hasMoreOlder: false,
        };
      }),
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

      await new Promise((resolve) => setTimeout(resolve, 300));
      // The first read fails and the entry is dropped…
      await vi.waitFor(() => expect(client.sessionLoading.value).toBe(false));
      // …and the capped backoff (attempt 1 → 2s) re-activates it once the
      // network recovers, so a later select finds a live baseline.
      await client.selectSession(target.id);
      offline = false;
      await vi.waitFor(() => expect(client.sessionLoading.value).toBe(false), { timeout: 4000 });
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it("keeps a side-chat agent pending approval across main transcript frames", async () => {
    // The BTW agent's approval lands in the session store via the reducer,
    // but the main-transcript watcher must not wipe it with a main-only
    // wholesale replace — the side-chat still waits for the answer.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('side-approval', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      startBtw: vi.fn(async () => ({ agentId: 'btw-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const sideInteraction = {
      interactionId: 'inter-btw-1',
      interactionKind: 'approval',
      state: 'pending',
      toolCallId: 'call-btw-1',
      request: { toolName: 'Bash', action: 'run', toolCallId: 'call-btw-1' },
    };

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();

      handlers!.onConnectionChange(true);
      handlers!.onReplayComplete?.();

      // Open the BTW side chat and activate its transcript (the detail panel
      // does this in production); its own transcript then carries the pending
      // approval interaction, and the session event lands the richer row.
      await client.openSideChat();
      client.auxiliaryTranscripts.activate(target.id, 'btw-1');
      await new Promise((resolve) => setTimeout(resolve, 150));
      handlers!.onTranscriptOps?.(
        target.id,
        'btw-1',
        [{ op: 'interaction.upsert', interaction: sideInteraction }],
        1,
      );
      handlers!.onEvent(
        {
          type: 'approvalRequested',
          sessionId: target.id,
          agentId: 'btw-1',
          approval: {
            approvalId: 'inter-btw-1',
            sessionId: target.id,
            toolCallId: 'call-btw-1',
            toolName: 'Bash',
            action: 'run',
            display: null,
            expiresAt: '2026-08-24T01:00:00.000Z',
            createdAt: '2026-08-24T00:00:00.000Z',
          },
        },
        { sessionId: target.id, seq: 1 },
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await vi.waitFor(() =>
        expect(client.pendingBySession.value[target.id]?.approvals).toBe(1),
      );

      // A MAIN transcript frame lands — the wholesale main-only overwrite
      // that used to wipe the side approval.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { activity: 'turn' } }],
        2,
      );

      await vi.waitFor(() =>
        expect(client.pendingBySession.value[target.id]?.approvals).toBe(1),
      );

      // A SIDE-only resolve frame (no main frame at all) must also re-run the
      // merge — the approval goes away when its own transcript says resolved.
      handlers!.onTranscriptOps?.(
        target.id,
        'btw-1',
        [
          {
            op: 'interaction.upsert',
            interaction: { ...sideInteraction, state: 'approved', response: {} },
          },
        ],
        2,
      );
      await vi.waitFor(() =>
        expect(client.pendingBySession.value[target.id]?.approvals ?? 0).toBe(0),
      );
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('invalidates the spawned-call cache when a resume turn is rewound by undo', async () => {
    // A resume re-links the agent to its LATEST spawning call; undo deletes
    // that turn — the cache must not keep pointing at the rewound call (and
    // must not suppress the backfill that re-proves the original one).
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('resume-undo', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const spawnTurnHeader = (turnId: string, ordinal: number) => ({
      kind: 'turn' as const,
      turnId,
      ordinal,
      state: 'completed' as const,
      origin: { kind: 'user' },
      startedAt: '2026-08-24T10:00:00.000Z',
    });
    const spawnStepHeader = (turnId: string) => ({
      kind: 'step' as const,
      stepId: `${turnId}.1`,
      turnId,
      ordinal: 1,
      state: 'completed' as const,
      startedAt: '2026-08-24T10:00:00.000Z',
    });
    const spawnFrame = (turnId: string, toolCallId: string) => ({
      kind: 'tool' as const,
      frameId: `${turnId}.1.f1`,
      toolCallId,
      name: 'Agent',
      state: 'done' as const,
      agentRefs: [{ agentId: 'ag-1' }],
    });
    const spawnTurn = (turnId: string, ordinal: number, toolCallId: string) => ({
      ...spawnTurnHeader(turnId, ordinal),
      steps: [{ ...spawnStepHeader(turnId), frames: [spawnFrame(turnId, toolCallId)] }],
    });
    const agentTask = {
      taskId: 'task-1',
      agentId: 'ag-1',
      kind: 'subagent',
      state: 'running',
      description: 'explore',
      startedAt: '2026-08-24T10:00:00.000Z',
      outputTail: '',
    };
    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();
      const groupOf = () => {
        for (const [key, members] of client.swarmMembersByToolCallId.value) {
          if (members.some((member) => member.id === 'task-1')) return key;
        }
        return undefined;
      };
      await new Promise((resolve) => setTimeout(resolve, 150));

      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          { op: 'turn.upsert', turn: spawnTurnHeader('t1', 1) },
          { op: 'step.upsert', turnId: 't1', step: spawnStepHeader('t1') },
          { op: 'frame.upsert', turnId: 't1', stepId: 't1.1', frame: spawnFrame('t1', 'c1') },
          { op: 'task.upsert', task: agentTask },
        ],
        2,
      );
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          { op: 'turn.upsert', turn: spawnTurnHeader('t2', 2) },
          { op: 'step.upsert', turnId: 't2', step: spawnStepHeader('t2') },
          { op: 'frame.upsert', turnId: 't2', stepId: 't2.1', frame: spawnFrame('t2', 'c2') },
        ],
        3,
      );
      await vi.waitFor(() => expect(groupOf()).toBe('c2'));

      // The undo rewinds t2 out of the window — the cache must drop c2 and
      // re-prove the original spawning call c1 from the remaining window.
      handlers!.onTranscriptReset?.(
        target.id,
        'main',
        {
          agentId: 'main',
          items: [spawnTurn('t1', 1, 'c1')],
          tasks: [agentTask],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [],
          agents: [],
          pendingInteractions: [],
          meta: { activity: 'idle' },
          hasMoreOlder: false,
        },
        4,
      );

      await vi.waitFor(() => expect(groupOf()).toBe('c1'));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('settles the in-flight prompt when its own queued prompt turns blocked before the response lands', async () => {
    // The prompt rides queued → blocked (pre-submit hook / queue cancel) while
    // the POST response is still in flight: the terminal frame alone must not
    // settle (another client's same-text terminal is indistinguishable in the
    // pending window). The response lands right after — a blocked prompt still
    // gets its answer — and the now-known prompt identity settles the
    // in-flight state the consumed frame could not.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('queued-blocked', false, false);
    let handlers: KimiEventHandlers | undefined;
    let answerSubmit: ((result: PromptSubmitResult) => void) | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      // The submit POST's answer is held back until the test releases it — a
      // blocked prompt still gets one, just after the terminal frame.
      submitPrompt: vi.fn(
        () =>
          new Promise<PromptSubmitResult>((resolve) => {
            answerSubmit = resolve;
          }),
      ),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const prompt = (status: string) => ({
      promptId: 'pr_1',
      status,
      content: [{ type: 'text', text: 'hello' }],
      createdAt: '2026-08-24T10:00:00.000Z',
    });

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();

      // Held back on purpose: the mocked POST answers only when the test says.
      void client.sendPrompt('hello');
      await vi.waitFor(() => expect(client.activity.value).toBe('running'));

      // Let the edge tracker's baseline frame settle, then ride queued →
      // blocked for the SAME text the in-flight bubble carries. The frames
      // alone must not settle — the pending window bars content attribution.
      await new Promise((resolve) => setTimeout(resolve, 150));
      handlers!.onTranscriptOps?.(target.id, 'main', [{ op: 'prompt.upsert', prompt: prompt('queued') }], 2);
      handlers!.onTranscriptOps?.(target.id, 'main', [{ op: 'prompt.upsert', prompt: prompt('blocked') }], 3);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.activity.value).toBe('running');

      // The POST's answer lands with the prompt id: the already-terminal
      // entity proves the fate — no later frame is needed.
      answerSubmit!({ promptId: 'pr_1', userMessageId: 'um_1' });
      await vi.waitFor(() => expect(client.activity.value).toBe('idle'));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('carries the recorded journal epoch when resubscribing an evicted session', async () => {
    // A bare old seq could be misread as a new-epoch-legal cursor after a
    // daemon restart — the resubscribe must carry the epoch the watermark was
    // recorded in, so a mismatch triggers resync_required instead of silently
    // skipping the gap.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const sessions5 = ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => session(id, false, false));
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: 5 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: sessions5, hasMore: false })),
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: sessions5.map(v2Of),
            total: 5,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async (id: string) => ({ id, archived: false, workspaceId: 'workspace-1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      expect(handlers).toBeDefined();

      // The daemon announces journal epoch 'epoch-x' at seq 100 for e1.
      handlers!.onResync?.('e1', 100, 'epoch-x');
      await vi.waitFor(() => expect(api.getSession).toHaveBeenCalledWith('e1'));

      // Subscribe e1..e5 — e1 falls out of the 4-slot LRU on the fifth.
      await client.selectSession('e1');
      await client.selectSession('e2');
      await client.selectSession('e3');
      await client.selectSession('e4');
      await client.selectSession('e5');
      await vi.waitFor(() => expect(connection.unsubscribe).toHaveBeenCalledWith('e1'));

      // Resubscribing e1 must carry BOTH the frozen seq and its epoch.
      await client.selectSession('e1');
      const reSub = (connection.subscribe as ReturnType<typeof vi.fn>).mock.calls
        .filter(([sid]) => sid === 'e1')
        .at(-1);
      expect(reSub?.[1]).toEqual({ seq: 100, epoch: 'epoch-x' });
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('keeps a /status response when the meta fold changes nothing', async () => {
    // An UNCHANGED thinkingEffort must not advance the status version — every
    // text/tool delta carries it, and bumping on it would keep dropping the
    // /status answer that carries fresh context numbers.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('status-unchanged', false, false);
    let handlers: KimiEventHandlers | undefined;
    let resolveStatus!: (value: unknown) => void;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    let deferStatus = false;
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      getSessionStatus: vi.fn(async () => {
        if (deferStatus) {
          return new Promise((resolve) => {
            resolveStatus = resolve;
          });
        }
        return {
          model: 'model-1',
          thinkingEffort: 'high',
          permission: 'manual',
          planMode: false,
          swarmMode: false,
          contextTokens: 0,
          maxContextTokens: 0,
          contextUsage: 0,
        };
      }),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      deferStatus = true;
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();
      await vi.waitFor(() => expect(resolveStatus).toBeDefined());
      await new Promise((resolve) => setTimeout(resolve, 150));

      // First fold: the level lands (version bumps legitimately).
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { agent: { thinkingEffort: 'high', model: 'model-1' } } }],
        2,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Second fold carries the SAME level — no change, no bump.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { agent: { thinkingEffort: 'high' } } }],
        3,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      resolveStatus({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 12345,
        maxContextTokens: 128000,
        contextUsage: 0.1,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(client.status.value.ctxUsed).toBe(12345);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('drops a /status response that a transcript meta fold already superseded', async () => {
    // selectSession fires a /status read concurrently with the transcript
    // baseline: a stale HTTP answer landing after the meta fold must not
    // revert model (or modes) back — the composer would show the new fact
    // while the next submit silently uses the reverted one.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('status-race', false, false);
    let handlers: KimiEventHandlers | undefined;
    let resolveStatus!: (value: unknown) => void;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      getSessionStatus: vi.fn(async () => {
        if (deferStatus) {
          return new Promise((resolve) => {
            resolveStatus = resolve;
          });
        }
        return {
          model: 'model-old',
          thinkingEffort: '',
          permission: 'manual',
          planMode: false,
          swarmMode: false,
          contextTokens: 0,
          maxContextTokens: 0,
          contextUsage: 0,
        };
      }),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    let deferStatus = false;
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      // The /status read issued on select stays in flight past the meta fold.
      deferStatus = true;
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();
      await vi.waitFor(() => expect(resolveStatus).toBeDefined());

      // Let the pool's own baseline settle first, then land the live model
      // via a meta.merge op (an items-empty reset would be discarded by the
      // pool's contract and re-read through REST).
      await new Promise((resolve) => setTimeout(resolve, 150));
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { agent: { model: 'model-new' } } }],
        2,
      );
      await vi.waitFor(() => expect(client.status.value.model).toBe('model-new'));

      // The stale answer lands after the fold — and must lose the race.
      resolveStatus({
        model: 'model-old',
        thinkingEffort: '',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(client.status.value.model).toBe('model-new');
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('shows new warning/info notice markers live with their severity', async () => {
    // The raw `warning` event is grade-suppressed and nothing renders notice
    // markers in-flow: a main-agent warning/info must toast live from the
    // transcript edge, deduped by marker id — not wait for the next reselect
    // or turn end.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('notice', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
      getSessionGoal: vi.fn(async () => null),
      getSessionWarnings: vi.fn(async () => [
        { code: 'code-heads up', message: 'heads up', severity: 'warning' },
      ]),
      getGitStatus: vi.fn(async () => ({
        branch: '',
        ahead: 0,
        behind: 0,
        entries: {},
        additions: 0,
        deletions: 0,
        pullRequest: null,
      })),
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const emptySnapshot = {
      agentId: 'main',
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      agents: [],
      pendingInteractions: [],
      meta: { activity: 'idle' },
      hasMoreOlder: false,
    };
    const notice = (markerId: string, level: string, message: string) => ({
      kind: 'marker' as const,
      markerId,
      marker: 'notice',
      payload: { level, message, event: { code: `code-${message}`, message } },
    });

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();

      handlers!.onTranscriptReset?.(target.id, 'main', emptySnapshot, 1);
      // The baseline frame initializes the edge tracker silently (a cold load
      // must not toast history) — let its notification window close so the
      // ops below arrive as a genuinely LIVE frame.
      await new Promise((resolve) => setTimeout(resolve, 150));
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          { op: 'marker.upsert', item: notice('m-warn', 'warning', 'heads up') },
          { op: 'marker.upsert', item: notice('m-info', 'info', 'fyi') },
          // The failed-turn card owns ACTIVE-session errors — no toast here.
          { op: 'marker.upsert', item: notice('m-err', 'error', 'boom') },
        ],
        2,
      );

      await vi.waitFor(() => {
        const warnings = client.warnings.value;
        expect(warnings.some((w) => typeof w === 'object' && w.severity === 'warning' && w.message === 'heads up')).toBe(true);
        expect(warnings.some((w) => typeof w === 'object' && w.severity === 'info' && w.message === 'fyi')).toBe(true);
        expect(warnings.some((w) => typeof w === 'object' && w.severity === 'error')).toBe(false);
      });

      // The turn-end / select-sidecar REST re-pull returns the SAME warning —
      // the live toast's content key is shared, so it must not toast twice.
      await client.selectSession(target.id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const headsUp = client.warnings.value.filter(
        (w) => typeof w === 'object' && w.message === 'heads up',
      );
      expect(headsUp).toHaveLength(1);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('renders a background error notice with the raw error details, not just the generic title', async () => {
    // The marker envelope carries level/message only — the raw error fields
    // (code/name/details) live at payload.event and must reach the notice
    // builder, or HTTP status / request id / error type are lost.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const active = session('active-now', false, false);
    const background = session('background-one', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessions: vi.fn(async () => ({ items: [active, background], hasMore: false })),
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(active), v2Of(background)],
            total: 2,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async (id: string) => ({ id, archived: false, workspaceId: 'workspace-1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      await client.selectSession(background.id);
      await client.selectSession(active.id);
      expect(handlers).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 150));

      // A background session's error notice must surface the raw details.
      handlers!.onTranscriptOps?.(
        background.id,
        'main',
        [
          {
            op: 'marker.upsert',
            item: {
              kind: 'marker',
              markerId: 'm-err',
              marker: 'notice',
              payload: {
                level: 'error',
                message: 'provider exploded',
                event: {
                  code: 42900,
                  name: 'RateLimitError',
                  message: 'provider exploded',
                  details: { requestId: 'req-9', statusCode: 429 },
                },
              },
            },
          },
        ],
        2,
      );

      await vi.waitFor(() => {
        const warning = client.warnings.value.find(
          (w) => typeof w === 'object' && w.severity === 'error',
        );
        expect(warning).toBeDefined();
        expect(
          typeof warning === 'object' &&
            (warning.details ?? []).some((d) => d.value === 'req-9'),
        ).toBe(true);
      });
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('re-anchors the activity watermark on resync so new-epoch events are not dropped', async () => {
    // A journal epoch switch (daemon restart) restarts seq from small values.
    // A resync arriving WITHOUT a preceding disconnect must reset the
    // per-session activity watermark too — otherwise work/turn/interaction
    // events with seq below the old-epoch high watermark keep being dropped.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('epoch', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      const busyOf = () => client.sessions.value.find((s) => s.id === target.id)?.busy;

      handlers!.onConnectionChange(true);
      handlers!.onReplayComplete?.();

      // Old epoch: the watermark climbs to 100.
      handlers!.onEvent(
        { type: 'sessionWorkChanged', sessionId: target.id, busy: true, mainTurnActive: true },
        { sessionId: target.id, seq: 100 },
      );
      await vi.waitFor(() => expect(busyOf()).toBe(true));

      // Journal epoch switch announced by a bare resync (no disconnect).
      handlers!.onResync?.(target.id, 1);
      await vi.waitFor(() => expect(api.getSession).toHaveBeenCalled());

      // New epoch: seq restarts small — this event must still apply.
      handlers!.onEvent(
        { type: 'sessionWorkChanged', sessionId: target.id, busy: false },
        { sessionId: target.id, seq: 2 },
      );
      await vi.waitFor(() => expect(busyOf()).toBe(false));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('drops a superseded resync read instead of letting landing order pick stale fields', async () => {
    // Two resyncs for the same session overlap (the second arrives while the
    // first getSession is still in flight). The newer read commits first; the
    // older read — superseded — must NOT then overwrite with its stale title
    // (a REST commit never advances the event seq that gates the writes).
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    let serverTitle = 'title-v0';
    const target = { ...session('race', false, false), title: serverTitle };
    let handlers: KimiEventHandlers | undefined;
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessions: vi.fn(async () => ({
        items: [{ ...target, title: serverTitle }],
        hasMore: false,
      })),
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of({ ...target, title: serverTitle })],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      const titleOf = () => client.sessions.value.find((s) => s.id === target.id)?.title;
      expect(titleOf()).toBe('title-v0');

      handlers!.onResync?.(target.id, 5);
      handlers!.onResync?.(target.id, 6);
      await vi.waitFor(() => expect(api.getSession).toHaveBeenCalledTimes(2));

      // The newer resync's read lands first and converges the gap's title.
      serverTitle = 'title-v2';
      resolveSecond({ id: target.id, title: serverTitle, archived: false, workspaceId: 'workspace-1' });
      await vi.waitFor(() => expect(titleOf()).toBe('title-v2'));

      // The superseded read lands last with the oldest title — and loses.
      resolveFirst({ id: target.id, title: 'title-v1', archived: false, workspaceId: 'workspace-1' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(titleOf()).toBe('title-v2');
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('does not settle a pending local submit on a REMOTE turn’s end', async () => {
    // P1: another client's turn ending while our POST is unanswered must not
    // reap the local submission — clearing in-flight, retiring the bubble and
    // draining the queue early. The late response must still record the
    // prompt id, and only OUR prompt's terminal frame settles the queue.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('p1-target', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    let resolveSubmit!: (value: unknown) => void;
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(
        () => new Promise((resolve) => { resolveSubmit = resolve; }),
      ),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const turnHeader = (turnId: string, ordinal: number, state: string) => ({
      kind: 'turn' as const,
      turnId,
      ordinal,
      state,
      origin: { kind: 'user' },
      startedAt: '2026-08-24T10:00:00.000Z',
    });

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();

      // Our submit's POST hangs unanswered; a follow-up queues behind it.
      void client.sendPrompt('hello');
      await vi.waitFor(() => expect(api.submitPrompt).toHaveBeenCalledTimes(1));
      void client.sendPrompt('follow-up');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(api.submitPrompt).toHaveBeenCalledTimes(1);

      // A REMOTE client's turn starts and ends (our POST still in flight).
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          { op: 'turn.upsert', turn: turnHeader('t_remote', 1, 'running') },
          { op: 'meta.merge', meta: { activity: 'turn' } },
        ],
        2,
      );
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          { op: 'turn.upsert', turn: turnHeader('t_remote', 1, 'completed') },
          { op: 'meta.merge', meta: { activity: 'idle' } },
        ],
        3,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));

      // The remote turn-end must NOT settle us: still busy, no early drain.
      expect(client.activity.value).toBe('running');
      expect(api.submitPrompt).toHaveBeenCalledTimes(1);

      // The late response arrives: the prompt id is still recordable.
      resolveSubmit({ promptId: 'pr_ours', userMessageId: 'msg_ours' });
      await vi.waitFor(() =>
        expect(connection.bindNextPromptId).toHaveBeenCalledWith(target.id, 'pr_ours'),
      );

      // OUR prompt reaches its terminal frame — only now the queue drains.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'prompt.upsert',
            prompt: {
              promptId: 'pr_ours',
              status: 'completed',
              content: [{ type: 'text', text: 'hello' }],
              createdAt: '2026-08-24T10:00:01.000Z',
            },
          },
          { op: 'turn.upsert', turn: turnHeader('t_ours', 2, 'completed') },
        ],
        4,
      );
      await vi.waitFor(() => expect(api.submitPrompt).toHaveBeenCalledTimes(2));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('retires an uncertain skill bubble on its BLOCKED skill marker', async () => {
    // A hook-blocked skill activation with a lost response leaves no turn —
    // only its persisted marker. The uncertain bubble must retire on that
    // anchored marker, not pin the session's subscription forever.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('skill-target', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      // The activation POST is LOST (network-ambiguous): the bubble goes
      // uncertain instead of being rolled back.
      activateSkill: vi.fn(async () => {
        throw new Error('network down');
      }),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      const ok = await client.activateSkill('review', 'pin-me-uniquely', undefined, undefined, {
        skipThinkingPersist: true,
      });
      // A lost response reports SUCCESS (a retry must not double-activate) —
      // the uncertain bubble is the command's only rendering meanwhile.
      expect(ok).toBe(true);
      // The skill name renders as a pill; the user turn's text is the args.
      const bubbleText = (turn: { role?: string; text?: string }) =>
        (turn.text ?? '').includes('pin-me-uniquely');
      await vi.waitFor(() => expect(client.turns.value.some(bubbleText)).toBe(true));

      // The blocked activation's marker lands (no turn ever will): the
      // anchored marker retires the uncertain bubble.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'marker.upsert',
            item: {
              kind: 'marker',
              markerId: 'm-skill-1',
              marker: 'skill',
              payload: {
                origin: { kind: 'skill_activation', skillName: 'review', skillArgs: 'pin-me-uniquely' },
              },
              at: '2026-08-24T10:00:01.000Z',
            },
          },
        ],
        2,
      );
      await vi.waitFor(() => expect(client.turns.value.some(bubbleText)).toBe(false));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('attributes a no-turn terminal prompt to the CURRENT submit, not the oldest bubble', async () => {
    // An older uncertain bubble stranded at [0] must not shadow the in-flight
    // submission. The blocked terminal arrives BEFORE the new submit's POST
    // response: the pending window bars content attribution (another client's
    // same-text terminal is indistinguishable), so the frame alone settles
    // nothing — the response's landing proves the prompt's identity and
    // settles then (the old uncertain bubble keeps waiting for its own echo).
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('attr-target', false, false);
    let handlers: KimiEventHandlers | undefined;
    let answerSecondSubmit: ((result: PromptSubmitResult) => void) | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      // The FIRST submit loses its response (uncertain bubble); the SECOND's
      // answer is held back until the test releases it.
      submitPrompt: vi
        .fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockImplementation(
          () =>
            new Promise<PromptSubmitResult>((resolve) => {
              answerSecondSubmit = resolve;
            }),
        ),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      await client.sendPrompt('old-text');
      void client.sendPrompt('new-text');
      await vi.waitFor(() => expect(client.activity.value).toBe('running'));
      // Let the transcript baseline finish before driving ops — ops pushed
      // mid-read buffer on the channel and race the scan.
      await vi.waitFor(() => expect(connection.subscribeTranscript).toHaveBeenCalled());

      // The NEW submit's prompt dies to a pre-submit hook before its response:
      // the pending window bars settling on the frame alone — the session
      // must stay in flight (another client's same-text terminal would be
      // indistinguishable at this point).
      await vi.waitFor(() => expect(api.submitPrompt).toHaveBeenCalledTimes(2));
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'prompt.upsert',
            prompt: {
              promptId: 'pr_new',
              status: 'blocked',
              content: [{ type: 'text', text: 'new-text' }],
              createdAt: '2026-08-24T10:00:02.000Z',
            },
          },
        ],
        2,
      );
      // Give the frame a beat to settle if it were going to — it must not.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.activity.value).toBe('running');

      // The POST's answer lands: the prompt's identity is now known and its
      // entity is terminal — THAT settles the current submission (the old
      // uncertain bubble keeps waiting for its own echo).
      answerSecondSubmit!({ promptId: 'pr_new', userMessageId: 'um_new' });
      await vi.waitFor(() => expect(client.activity.value).toBe('idle'));
      expect(client.turns.value.some((turn) => (turn.text ?? '').includes('old-text'))).toBe(true);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('shows the pending swarm pick while its profile write is in flight', async () => {
    // The toggle reads the transcript meta directly when a baseline exists —
    // a still-unwritten meta must not show the OLD mode mid-write.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('swarm-target', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      // The profile write never answers: the shield stays up.
      updateSession: vi.fn(() => new Promise(() => undefined)),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      // Mid-write: the pending pick shows, not the pre-write meta's OFF.
      await vi.waitFor(() => expect(client.swarmMode.value).toBe(true));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('does not fold a stale confirmation through the shield after a newer write', async () => {
    // Two quick swarm toggles: W1=ON's confirmation read answers LAST, with
    // W1's-era value. Its token no longer matches the current pending write
    // (W2=OFF) — folding it through the shield would flip the base back to ON
    // until W2's own confirmation lands (and for good if that never does).
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('shield-token', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const statusOf = (swarmMode: boolean) => ({
      model: 'model-1',
      thinkingEffort: 'high',
      permission: 'manual',
      planMode: false,
      swarmMode,
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
    });
    const heldReads: Array<(v: ReturnType<typeof statusOf>) => void> = [];
    let holdReads = false;
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      // Both profile writes succeed at once; the confirmation reads are held.
      updateSession: vi.fn(async () => ({} as AppSession)),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      // Setup reads answer OFF at once; the toggles' confirmation reads are
      // held back until the test releases them (holdReads flips below).
      getSessionStatus: vi.fn((sid: string) => {
        void sid;
        if (!holdReads) return Promise.resolve(statusOf(false));
        return new Promise<ReturnType<typeof statusOf>>((resolve) => {
          heldReads.push(resolve);
        });
      }),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      // Hold every confirmation read from here on.
      holdReads = true;

      client.setSwarmMode(true);
      await vi.waitFor(() => expect(client.swarmMode.value).toBe(true));
      await vi.waitFor(() => expect(heldReads.length).toBe(1));
      client.setSwarmMode(false);
      await vi.waitFor(() => expect(client.swarmMode.value).toBe(false));
      await vi.waitFor(() => expect(heldReads.length).toBe(2));

      // W1's read answers with W1's-era ON: stale token — it must NOT fold
      // through the shield (the base would flip back to ON).
      heldReads[0]!(statusOf(true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.swarmMode.value).toBe(false);

      // W2's own confirmation answers OFF: the current token owns the field.
      heldReads[1]!(statusOf(false));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.swarmMode.value).toBe(false);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('stamps recency with the no-turn terminal prompt’s own server time', async () => {
    // A blocked/aborted prompt leaves no turn — scanning the items window
    // finds nothing newer, so recency must ride the prompt's createdAt
    // (server domain), not a skewed browser clock.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('recency-target', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      const updatedAtOf = () =>
        client.workspaceGroups.value
          .flatMap((g) => g.sessions)
          .find((s) => s.id === target.id)?.updatedAt;
      expect(updatedAtOf()).toBe('2026-01-01T00:00:00.000Z');

      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'prompt.upsert',
            prompt: {
              promptId: 'pr_blocked',
              status: 'blocked',
              content: [{ type: 'text', text: 'hi' }],
              createdAt: '2026-08-24T10:00:02.000Z',
            },
          },
        ],
        2,
      );
      await vi.waitFor(() => expect(updatedAtOf()).toBe('2026-08-24T10:00:02.000Z'));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('merges the open DETAIL panel agent’s interactions into the session store', async () => {
    // A detail-opened subagent streams at transcript grade — the server
    // suppresses its projected session events on this connection, so its new
    // and resolved approvals only land on its auxiliary entry. The merge must
    // include that entry, not just the BTW side-chat's.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('detail-merge', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const detailInteraction = {
      interactionId: 'inter-detail-1',
      interactionKind: 'approval',
      state: 'pending',
      toolCallId: 'call-detail-1',
      request: { toolName: 'Bash', action: 'run', toolCallId: 'call-detail-1' },
    };

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();

      // The detail panel opens on a regular subagent (its activation in
      // production): the aux transcript is now the ONLY channel for its
      // interaction edges on this connection.
      client.auxiliaryTranscripts.activate(target.id, 'agent-detail-1');
      await new Promise((resolve) => setTimeout(resolve, 150));

      handlers!.onTranscriptOps?.(
        target.id,
        'agent-detail-1',
        [{ op: 'interaction.upsert', interaction: detailInteraction }],
        1,
      );
      await vi.waitFor(() =>
        expect(client.pendingBySession.value[target.id]?.approvals).toBe(1),
      );

      // Resolved by ANOTHER client: the aux transcript's non-pending frame is
      // the only proof — the lingering card must go away.
      handlers!.onTranscriptOps?.(
        target.id,
        'agent-detail-1',
        [
          {
            op: 'interaction.upsert',
            interaction: { ...detailInteraction, state: 'approved', response: {} },
          },
        ],
        2,
      );
      await vi.waitFor(() =>
        expect(client.pendingBySession.value[target.id]?.approvals ?? 0).toBe(0),
      );
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('invalidates an in-flight goal backfill when the meta status moves', async () => {
    // First sight of an ACTIVE goal starts a REST backfill; if the meta flips
    // to paused before the answer returns, the active-built response must be
    // dropped — a plain request mutex only stops new requests.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('goal-race', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    let resolveGoal!: (goal: unknown) => void;
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
      // The /goal read hangs until the test resolves it.
      getSessionGoal: vi.fn(() => new Promise((resolve) => { resolveGoal = resolve; })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      // First sight of an ACTIVE goal on the transcript fold: the tracked
      // backfill starts (its read hangs until the test resolves it).
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { goal: { status: 'active', objective: 'ship it' } } }],
        2,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));

      // The meta moves to paused while the read is in flight.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { goal: { status: 'paused' } } }],
        3,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));

      // The active-built answer returns — and must be DROPPED (the version
      // bump invalidated it), or the card would pin the goal at active.
      resolveGoal({ status: 'active', objective: 'ship it', turns: 3 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.goal.value).toBeNull();
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('settles a terminal REST task row whose completedAt is client-estimated', async () => {
    // The cancel response stamps the REST row with a CLIENT-clock completedAt
    // (completedAtEstimated): comparing it against the transcript row's
    // SERVER startedAt strands the row as running whenever the browser is
    // behind the daemon — simulated here with a server clock "ahead" of the
    // browser. The generation guard must ride the run's own SERVER stamps.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('skew-target', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      cancelTask: vi.fn(async () => ({})),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => [
        {
          id: 'task-1',
          sessionId: target.id,
          kind: 'subagent',
          description: 'explore',
          status: 'running',
          createdAt: '2027-01-01T00:00:00.000Z',
          startedAt: '2027-01-01T00:00:00.000Z',
        },
      ]),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [
          {
            taskId: 'task-1',
            agentId: 'ag-1',
            kind: 'subagent',
            state: 'running',
            description: 'explore',
            startedAt: '2027-01-01T00:00:00.000Z',
            outputTail: '',
          },
        ],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      // The cancel response stamps the REST row cancelled with a CLIENT-clock
      // (estimated) completedAt — the transcript row still says running.
      await client.cancelTask('task-1');

      // The generation guard rides the run's SERVER start stamps, not the
      // estimate: the dock row settles even with the browser "behind" the
      // daemon.
      await vi.waitFor(() =>
        expect(
          client.activeAppTasks.value.find((task) => task.id === 'task-1')?.status,
        ).toBe('cancelled'),
      );
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('notifies for NEW pending interactions on a detail agent’s aux transcript', async () => {
    // The aux agent's projected session events are suppressed on this
    // connection — without the merge-time notification edge a new approval
    // would surface as a silent card only. Baseline interactions stay silent.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('aux-notify', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const interactionOf = (interactionId: string) => ({
      interactionId,
      interactionKind: 'approval',
      state: 'pending',
      toolCallId: `call-${interactionId}`,
      request: { toolName: 'Bash', action: 'run', toolCallId: `call-${interactionId}` },
    });

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const { notificationsStore } = await import('../src/stores/notifications');
      const notifySpy = vi.spyOn(notificationsStore(), 'maybeNotifyApproval');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();

      client.auxiliaryTranscripts.activate(target.id, 'agent-notify-1');
      await new Promise((resolve) => setTimeout(resolve, 150));

      // A NEW pending approval on the aux transcript fires the same
      // notification path as a main-agent one.
      handlers!.onTranscriptOps?.(
        target.id,
        'agent-notify-1',
        [{ op: 'interaction.upsert', interaction: interactionOf('inter-new-1') }],
        1,
      );
      await vi.waitFor(() =>
        expect(notifySpy).toHaveBeenCalledWith(
          expect.objectContaining({ approvalId: 'inter-new-1' }),
        ),
      );

      // The same interaction on later frames does NOT re-notify.
      const callsAfterFirst = notifySpy.mock.calls.length;
      handlers!.onTranscriptOps?.(
        target.id,
        'agent-notify-1',
        [{ op: 'interaction.upsert', interaction: interactionOf('inter-new-1') }],
        2,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(notifySpy).toHaveBeenCalledTimes(callsAfterFirst);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('does not settle a live SKILL submit on a REMOTE turn’s end', async () => {
    // A skill submit has no promptId and a NON-uncertain bubble — "no
    // uncertain bubbles" must not read as fate-proven: a remote client's
    // turn end settles only when the SKILL's own echo exists.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('skill-fate', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      activateSkill: vi.fn(async () => ({})),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const turnHeader = (turnId: string, ordinal: number, state: string) => ({
      kind: 'turn' as const,
      turnId,
      ordinal,
      state,
      origin: { kind: 'user' },
      startedAt: '2026-08-24T10:00:00.000Z',
    });

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();

      const ok = await client.activateSkill('review', 'src', undefined, undefined, {
        skipThinkingPersist: true,
      });
      expect(ok).toBe(true);
      await vi.waitFor(() => expect(client.activity.value).toBe('running'));

      // A REMOTE client's turn starts and ends: the live skill submit must
      // not be settled by it (no skill echo exists yet).
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          { op: 'turn.upsert', turn: turnHeader('t_remote', 1, 'running') },
          { op: 'meta.merge', meta: { activity: 'turn' } },
        ],
        2,
      );
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          { op: 'turn.upsert', turn: turnHeader('t_remote', 1, 'completed') },
          { op: 'meta.merge', meta: { activity: 'idle' } },
        ],
        3,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(client.activity.value).toBe('running');
      expect(
        client.turns.value.some((turn) => (turn.text ?? '').includes('src')),
      ).toBe(true);

      // The skill's OWN echo turn lands and ends — now it settles.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'turn.upsert',
            turn: {
              ...turnHeader('t_skill', 2, 'running'),
              origin: { kind: 'skill_activation', skillName: 'review', skillArgs: 'src' },
            },
          },
          { op: 'meta.merge', meta: { activity: 'turn' } },
        ],
        4,
      );
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'turn.upsert',
            turn: {
              ...turnHeader('t_skill', 2, 'completed'),
              origin: { kind: 'skill_activation', skillName: 'review', skillArgs: 'src' },
            },
          },
          { op: 'meta.merge', meta: { activity: 'idle' } },
        ],
        5,
      );
      await vi.waitFor(() => expect(client.activity.value).toBe('idle'));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('fires the recovery branch after an empty-reset recovery (flag outlives the counter)', async () => {
    // The pool clears emptyResetRetries in the success path — the recovery
    // fact must outlive it (recoveredViaEmptyReset) so the watcher still
    // fires the interactions that landed while the baseline was unreadable.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('recover-target', false, false);
    let handlers: KimiEventHandlers | undefined;
    let resolveTranscript!: (page: unknown) => void;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      // The baseline read hangs until the test resolves it — the empty reset
      // must arrive BEFORE any baseline to arm the retry + recovery flag.
      getSessionTranscript: vi.fn(
        () => new Promise((resolve) => { resolveTranscript = resolve; }),
      ),
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
      const notifySpy = vi.spyOn(notificationsStore(), 'maybeNotifyApproval');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();

      // The server's cursorless answer arrives while the first read is
      // still in flight: the pool arms the empty-reset retry, the read then
      // succeeds, and the watcher must fire the recovered window's pending
      // approval even though the counter already reset in the success path.
      handlers!.onTranscriptReset?.(
        target.id,
        'main',
        {
          agentId: 'main',
          items: [],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [],
          agents: [],
          pendingInteractions: [],
          meta: { activity: 'idle' },
          hasMoreOlder: false,
        },
        2,
      );
      resolveTranscript({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [
          {
            interactionId: 'inter-recovered-1',
            interactionKind: 'approval',
            state: 'pending',
            toolCallId: 'call-recovered-1',
            request: { toolName: 'Bash', action: 'run', toolCallId: 'call-recovered-1' },
          },
        ],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      });
      await vi.waitFor(
        () =>
          expect(notifySpy).toHaveBeenCalledWith(
            expect.objectContaining({ approvalId: 'inter-recovered-1' }),
          ),
        { timeout: 5000 },
      );
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('settles a FAST local turn whose terminal frame beat the POST response', async () => {
    // The submit path explicitly allows a fast turn to finish before the
    // response arrives. The terminal frame ALONE must not settle (another
    // client's same-text turn is indistinguishable while the POST is
    // unanswered); the response's landing stamps the prompt id, and the
    // transcript's already-terminal prompt entity settles it there — the turn
    // edge itself never re-fires (it was marked settled when the frame hit).
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('fast-turn', false, false);
    let handlers: KimiEventHandlers | undefined;
    let answerFirstSubmit: ((result: PromptSubmitResult) => void) | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      // The FIRST submit's answer is held back until the test releases it
      // (the fast turn's terminal frame lands first); the drained queued
      // send's answer never arrives — the test ends first.
      submitPrompt: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<PromptSubmitResult>((resolve) => {
              answerFirstSubmit = resolve;
            }),
        )
        .mockImplementation(() => new Promise(() => undefined)),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      void client.sendPrompt('quick work');
      await vi.waitFor(() => expect(client.activity.value).toBe('running'));
      await vi.waitFor(() => expect(connection.subscribeTranscript).toHaveBeenCalled());
      void client.sendPrompt('behind it');
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The fast turn runs and completes while the POST is still unanswered —
      // the daemon's transcript carries the prompt entity alongside the turn.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'prompt.upsert',
            prompt: {
              promptId: 'pr_fast',
              status: 'running',
              content: [{ type: 'text', text: 'quick work' }],
              createdAt: '2026-08-24T10:00:00.000Z',
            },
          },
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId: 't_fast',
              ordinal: 1,
              state: 'running',
              origin: { kind: 'user' },
              prompt: 'quick work',
              startedAt: '2026-08-24T10:00:00.000Z',
            },
          },
          { op: 'meta.merge', meta: { activity: 'turn' } },
        ],
        2,
      );
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'prompt.upsert',
            prompt: {
              promptId: 'pr_fast',
              status: 'completed',
              content: [{ type: 'text', text: 'quick work' }],
              createdAt: '2026-08-24T10:00:00.000Z',
              finishedAt: '2026-08-24T10:00:01.000Z',
            },
          },
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId: 't_fast',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'quick work',
              startedAt: '2026-08-24T10:00:00.000Z',
              endedAt: '2026-08-24T10:00:01.000Z',
            },
          },
          { op: 'meta.merge', meta: { activity: 'idle' } },
        ],
        3,
      );
      // The frame alone must NOT settle: the POST is still unanswered, so the
      // queue stays parked behind the in-flight submission.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(api.submitPrompt).toHaveBeenCalledTimes(1);
      expect(client.activity.value).toBe('running');

      // The POST's answer lands with the prompt id — the transcript's
      // already-terminal entity proves the fate: settle and drain the queue.
      answerFirstSubmit!({ promptId: 'pr_fast', userMessageId: 'um_fast' });
      await vi.waitFor(() => expect(api.submitPrompt).toHaveBeenCalledTimes(2));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('floats the session on a LIVE pending interaction even when its step is long-running', async () => {
    // A pending approval arriving on a step that has been running for hours is
    // NEWS: the interaction entity carries no timestamp and the snapshot's
    // newest server stamp is the step's old startedAt — stamping THAT fails
    // the updatedAt check and the session never floats to the sidebar top.
    // The live arrival itself is the stamp.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('recency-interaction', true, true);
    const other = { ...session('recency-other', false, false), updatedAt: '2026-06-01T00:00:00.000Z' };
    let handlers: KimiEventHandlers | undefined;
    const subscribeTranscript = vi.fn();
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript,
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessions: vi.fn(async () => ({ items: [target, other], hasMore: false })),
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(other), v2Of(target)],
            total: 2,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 2,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      // The baseline: a turn whose only step started HOURS ago (every server
      // stamp in the snapshot is older than the session's updatedAt).
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [
          {
            kind: 'turn',
            turnId: 't_run',
            ordinal: 1,
            state: 'running',
            origin: { kind: 'user' },
            prompt: 'long work',
            startedAt: '2026-01-01T00:00:00.000Z',
            steps: [
              {
                kind: 'step',
                stepId: 's_run',
                turnId: 't_run',
                ordinal: 1,
                state: 'running',
                frames: [],
                startedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'turn' },
        hasMoreOlder: false,
      })),
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
      await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalled());
      // The first baseline initializes the edge tracker silently.
      await new Promise((resolve) => setTimeout(resolve, 150));
      // The sidebar's recency sort puts the newer OTHER session first.
      const orderOf = () => client.sessions.value.map((s) => s.id);
      expect(orderOf()).toEqual(['recency-other', 'recency-interaction']);

      // The approval arrives live on the long-running step: the session's
      // recency stamps the arrival (≈ browser now), not the step's old stamp —
      // it floats above the other session.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'interaction.upsert',
            interaction: {
              interactionId: 'inter-live-1',
              interactionKind: 'approval',
              state: 'pending',
              toolCallId: 'call-live-1',
              request: { toolName: 'Bash', action: 'run', toolCallId: 'call-live-1' },
            },
          },
        ],
        2,
      );
      await vi.waitFor(() =>
        expect(orderOf()).toEqual(['recency-interaction', 'recency-other']),
      );
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('settles the local submit once at the LAST item of a multi-turn terminal batch', async () => {
    // A merged frame (reconnect) can carry several unsettled terminal turns at
    // once. Settling the local submit against an EARLIER item with the whole
    // final snapshot clears the prompt id up front — the later turns' passes
    // then read a cleared state (and their completion notifications lose the
    // prompt's dedup tag, double-alerting one prompt). The settle and the
    // batch's single drain both belong to the last item.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('batch-settle', false, false);
    let handlers: KimiEventHandlers | undefined;
    const subscribeTranscript = vi.fn();
    let answerSubmit: ((result: PromptSubmitResult) => void) | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript,
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      // The FIRST submit's answer is held back until the test releases it (so
      // the prompt id is stamped before the batch); the drained queued send's
      // answer never arrives — the test ends first.
      submitPrompt: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<PromptSubmitResult>((resolve) => {
              answerSubmit = resolve;
            }),
        )
        .mockImplementation(() => new Promise(() => undefined)),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const turn = (turnId: string, ordinal: number, prompt: string) => ({
      op: 'turn.upsert' as const,
      turn: {
        kind: 'turn' as const,
        turnId,
        ordinal,
        state: 'completed' as const,
        origin: { kind: 'user' as const },
        prompt,
        startedAt: '2026-08-24T10:00:00.000Z',
        endedAt: '2026-08-24T10:00:01.000Z',
      },
    });

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const { notificationsStore } = await import('../src/stores/notifications');
      const notifySpy = vi.spyOn(notificationsStore(), 'maybeNotifyCompletion');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();

      void client.sendPrompt('our-text');
      await vi.waitFor(() => expect(client.activity.value).toBe('running'));
      await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalled());
      await vi.waitFor(() => expect(api.submitPrompt).toHaveBeenCalledTimes(1));
      // The POST answers: the prompt id is stamped, the turn is still running.
      answerSubmit!({ promptId: 'pr_ours', userMessageId: 'um_ours' });
      void client.sendPrompt('queued-text');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(api.submitPrompt).toHaveBeenCalledTimes(1);

      // The merged frame: a REMOTE turn AND our turn both terminal, our prompt
      // entity completed, meta idle — two unsettled ends in one batch.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'prompt.upsert',
            prompt: {
              promptId: 'pr_ours',
              status: 'completed',
              content: [{ type: 'text', text: 'our-text' }],
              createdAt: '2026-08-24T10:00:00.000Z',
              finishedAt: '2026-08-24T10:00:01.000Z',
            },
          },
          turn('t_remote', 1, 'someone else'),
          turn('t_ours', 2, 'our-text'),
          { op: 'meta.merge', meta: { activity: 'idle' } },
        ],
        2,
      );

      // The batch's ONE drain fires at the last item: the queued send goes out.
      await vi.waitFor(() => expect(api.submitPrompt).toHaveBeenCalledTimes(2));
      // Every completion notification kept OUR prompt's dedup tag — settling
      // at the first item would have cleared the id for the later passes.
      for (const call of notifySpy.mock.calls) {
        expect(call[1]?.promptId).toBe('pr_ours');
      }
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('retires every confirmed bubble the turn absorbed even when an uncertain bubble blocks the drain', async () => {
    // A turn end whose drain is vetoed by an unpaired UNCERTAIN bubble must
    // still retire ALL confirmed bubbles it absorbed (the main prompt plus a
    // steer): leftover covered bubbles keep hasPendingLocalWork true and pin
    // the session's transcript entry (and its WS subscription) in the LRU.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('retire-absorbed', false, false);
    let handlers: KimiEventHandlers | undefined;
    const subscribeTranscript = vi.fn();
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript,
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      // The FIRST submit loses its response (uncertain bubble); the MAIN send
      // and the STEER both answer normally.
      submitPrompt: vi
        .fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce({ promptId: 'pr_main', userMessageId: 'msg_main' })
        .mockResolvedValue({ promptId: 'pr_steer', userMessageId: 'msg_steer', status: 'queued' }),
      steerPrompts: vi.fn(async () => undefined),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalled());

      await client.sendPrompt('old lost text');
      await client.sendPrompt('main-text');
      await vi.waitFor(() => expect(client.activity.value).toBe('running'));
      await client.steerPrompt('steer-text');
      await vi.waitFor(() => expect(api.steerPrompts).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The turn ends, having absorbed main + steer; the uncertain bubble's
      // own echo never arrives, so the drain is vetoed — but the retirement
      // must still cover BOTH confirmed bubbles.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'prompt.upsert',
            prompt: {
              promptId: 'pr_main',
              status: 'completed',
              content: [{ type: 'text', text: 'main-text' }],
              createdAt: '2026-08-24T10:00:00.000Z',
              finishedAt: '2026-08-24T10:00:01.000Z',
            },
          },
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId: 't_main',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'main-text',
              startedAt: '2026-08-24T10:00:00.000Z',
              endedAt: '2026-08-24T10:00:01.000Z',
            },
          },
          { op: 'meta.merge', meta: { activity: 'idle' } },
        ],
        2,
      );

      await vi.waitFor(() => expect(client.activity.value).toBe('idle'));
      // The steered bubble is retired too (retirement is not gated by the
      // drain); only the unpaired UNCERTAIN bubble survives.
      expect(
        client.turns.value.some((turn) => (turn.text ?? '').includes('steer-text')),
      ).toBe(false);
      expect(
        client.turns.value.some((turn) => (turn.text ?? '').includes('old lost text')),
      ).toBe(true);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('re-freezes the honest watermark when a resumed session is evicted before its replay lands', async () => {
    // A session evicted by the LRU freezes its consumed cursor; broadcasts
    // (sessionWorkChanged) keep advancing the aggregate while unsubscribed.
    // Resumed from the frozen cursor and re-evicted BEFORE any replay/newer
    // frame lands, the re-freeze must keep the original watermark — the
    // aggregate is broadcast-inflated and would skip the subscription frames
    // the replay never delivered. The floor lifts once a frame past the
    // at-resume watermark proves the replay flushed (single FIFO).
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const ids = ['lru_s1', 'lru_s2', 'lru_s3', 'lru_s4', 'lru_s5'];
    const fixtures = ids.map((id) => session(id, false, false));
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: 5 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: fixtures, hasMore: false })),
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: fixtures.map(v2Of),
            total: fixtures.length,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: fixtures.length,
      })),
      getSession: vi.fn(async (id: string) => ({ id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const workChanged = (sessionId: string, seq: number) =>
      handlers!.onEvent(
        { type: 'sessionWorkChanged', sessionId, busy: false, mainTurnActive: false },
        { sessionId, seq },
      );
    const cursorOfLastSubscribe = (sessionId: string) =>
      (connection.subscribe as ReturnType<typeof vi.fn>).mock.calls
        .filter((call) => call[0] === sessionId)
        .at(-1)?.[1] as { seq?: number } | undefined;
    const beat = () => new Promise((resolve) => setTimeout(resolve, 100));

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      expect(handlers).toBeDefined();

      // s1 subscribed and consumed up to seq 10.
      await client.selectSession('lru_s1');
      await beat();
      workChanged('lru_s1', 10);
      await beat();

      // Cycle through s2..s5: the cap evicts s1 (frozen at the honest 10).
      for (const id of ['lru_s2', 'lru_s3', 'lru_s4', 'lru_s5']) {
        await client.selectSession(id);
        await beat();
      }
      // Broadcast inflation while s1 is unsubscribed: the aggregate jumps to
      // 50 without any subscription frame being delivered.
      workChanged('lru_s1', 50);
      await beat();

      // Resume s1 (cursor 10), then rapidly cycle it back OUT before any
      // replay/newer frame lands: the re-freeze must keep 10, not the
      // inflated 50.
      await client.selectSession('lru_s1');
      await beat();
      expect(cursorOfLastSubscribe('lru_s1')?.seq).toBe(10);
      for (const id of ['lru_s2', 'lru_s3', 'lru_s4', 'lru_s5']) {
        await client.selectSession(id);
        await beat();
      }
      await client.selectSession('lru_s1');
      await beat();
      expect(cursorOfLastSubscribe('lru_s1')?.seq).toBe(10);

      // A frame past the at-resume watermark (50) proves the replay flushed:
      // the floor lifts and later evictions freeze the honest aggregate.
      workChanged('lru_s1', 51);
      await beat();
      for (const id of ['lru_s2', 'lru_s3', 'lru_s4', 'lru_s5']) {
        await client.selectSession(id);
        await beat();
      }
      await client.selectSession('lru_s1');
      await beat();
      expect(cursorOfLastSubscribe('lru_s1')?.seq).toBe(51);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('lifts the resume floor when the replay reaches exactly the at-resume watermark', async () => {
    // The replay can finish EXACTLY at the resume-time aggregate (the session
    // stays quiet afterwards): seqs are unique, so only the replay can
    // deliver precisely that watermark — reaching it must lift the floor too,
    // or a quiet session's next eviction re-freezes the stale watermark and
    // replays already-consumed frames (duplicated side-chat text).
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const ids = ['lruq_s1', 'lruq_s2', 'lruq_s3', 'lruq_s4', 'lruq_s5'];
    const fixtures = ids.map((id) => session(id, false, false));
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: 5 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: fixtures, hasMore: false })),
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: fixtures.map(v2Of),
            total: fixtures.length,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: fixtures.length,
      })),
      getSession: vi.fn(async (id: string) => ({ id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const workChanged = (sessionId: string, seq: number) =>
      handlers!.onEvent(
        { type: 'sessionWorkChanged', sessionId, busy: false, mainTurnActive: false },
        { sessionId, seq },
      );
    const cursorOfLastSubscribe = (sessionId: string) =>
      (connection.subscribe as ReturnType<typeof vi.fn>).mock.calls
        .filter((call) => call[0] === sessionId)
        .at(-1)?.[1] as { seq?: number } | undefined;
    const beat = () => new Promise((resolve) => setTimeout(resolve, 100));

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      expect(handlers).toBeDefined();

      await client.selectSession('lruq_s1');
      await beat();
      workChanged('lruq_s1', 10);
      await beat();

      // Evict s1 (frozen at 10), inflate the aggregate to 50 via broadcast.
      for (const id of ['lruq_s2', 'lruq_s3', 'lruq_s4', 'lruq_s5']) {
        await client.selectSession(id);
        await beat();
      }
      workChanged('lruq_s1', 50);
      await beat();

      // Resume s1 (cursor 10), then a REPLAYED frame lands at exactly the
      // at-resume watermark (50): the window is provably flushed.
      await client.selectSession('lruq_s1');
      await beat();
      expect(cursorOfLastSubscribe('lruq_s1')?.seq).toBe(10);
      workChanged('lruq_s1', 50);
      await beat();

      // Re-evict and resume: the floor lifted, so the freeze used the honest
      // aggregate — the next resume starts at 50, not the stale 10.
      for (const id of ['lruq_s2', 'lruq_s3', 'lruq_s4', 'lruq_s5']) {
        await client.selectSession(id);
        await beat();
      }
      await client.selectSession('lruq_s1');
      await beat();
      expect(cursorOfLastSubscribe('lruq_s1')?.seq).toBe(50);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('settles the current skill submit without waiting on an older uncertain bubble', async () => {
    // An old uncertain text bubble (lost response) must not gate the CURRENT
    // skill submission's settle — its retirement is the sweep's business.
    // The skill's inFlight clears on its own echo turn; the old bubble stays.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('skill-mixed', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      // The first submit loses its response (uncertain bubble).
      submitPrompt: vi.fn().mockRejectedValueOnce(new Error('network down')),
      activateSkill: vi.fn(async () => ({})),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      await client.sendPrompt('old lost text');
      const ok = await client.activateSkill('review', 'src', undefined, undefined, {
        skipThinkingPersist: true,
      });
      expect(ok).toBe(true);
      await vi.waitFor(() => expect(client.activity.value).toBe('running'));
      await vi.waitFor(() => expect(connection.subscribeTranscript).toHaveBeenCalled());

      // The skill's OWN echo turn lands and ends: the skill settles even
      // though the old uncertain bubble's fate is still unproven.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId: 't_skill',
              ordinal: 1,
              state: 'running',
              origin: { kind: 'skill_activation', skillName: 'review', skillArgs: 'src' },
              startedAt: '2026-08-24T10:00:00.000Z',
            },
          },
          { op: 'meta.merge', meta: { activity: 'turn' } },
        ],
        2,
      );
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId: 't_skill',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'skill_activation', skillName: 'review', skillArgs: 'src' },
              startedAt: '2026-08-24T10:00:00.000Z',
              endedAt: '2026-08-24T10:00:01.000Z',
            },
          },
          { op: 'meta.merge', meta: { activity: 'idle' } },
        ],
        3,
      );
      await vi.waitFor(() => expect(client.activity.value).toBe('idle'));
      // The old uncertain bubble survived — its fate is still unproven.
      expect(
        client.turns.value.some((turn) => (turn.text ?? '').includes('old lost text')),
      ).toBe(true);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('does not settle a skill activation on its RUNNING echo turn when the response lands', async () => {
    // The activation's running echo turn beats the HTTP response: the
    // response's settle must require the echo turn TERMINAL — settling on a
    // running one would clear in-flight and drain the queue while the skill
    // is still executing.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('skill-running-echo', false, false);
    let handlers: KimiEventHandlers | undefined;
    const subscribeTranscript = vi.fn();
    let answerActivation: ((value: Record<string, never>) => void) | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript,
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      // The activation's answer is held back until the test releases it.
      activateSkill: vi.fn(
        () =>
          new Promise<Record<string, never>>((resolve) => {
            answerActivation = resolve;
          }),
      ),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    const skillTurn = (state: 'running' | 'completed') => ({
      op: 'turn.upsert' as const,
      turn: {
        kind: 'turn' as const,
        turnId: 't_skill',
        ordinal: 1,
        state,
        origin: { kind: 'skill_activation' as const, skillName: 'review', skillArgs: 'src' },
        startedAt: '2026-08-24T10:00:00.000Z',
        ...(state === 'completed' ? { endedAt: '2026-08-24T10:00:01.000Z' } : {}),
      },
    });

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(handlers).toBeDefined();
      await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalled());

      void client.activateSkill('review', 'src', undefined, undefined, {
        skipThinkingPersist: true,
      });
      await vi.waitFor(() => expect(client.activity.value).toBe('running'));
      void client.sendPrompt('queued behind');
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The RUNNING echo turn beats the HTTP response.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [skillTurn('running'), { op: 'meta.merge', meta: { activity: 'turn' } }],
        2,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The response lands — the echo turn is still running, so the settle
      // must NOT fire (a running turn proves only the start): the queue
      // stays parked behind the in-flight activation.
      answerActivation!({});
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(api.submitPrompt).not.toHaveBeenCalled();

      // The echo turn ends: NOW the skill settles and the queue drains.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [skillTurn('completed'), { op: 'meta.merge', meta: { activity: 'idle' } }],
        3,
      );
      await vi.waitFor(() => expect(api.submitPrompt).toHaveBeenCalledTimes(1));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('re-backfills the goal with the current status after an invalidation', async () => {
    // The invalidated first-sight read must not leave the card empty: once it
    // settles, a new read runs with the CURRENT meta status.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('goal-refill', false, false);
    let handlers: KimiEventHandlers | undefined;
    const resolvers: Array<(goal: unknown) => void> = [];
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
      getSessionGoal: vi.fn(
        () => new Promise((resolve) => { resolvers.push(resolve); }),
      ),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      // First sight active → the fold's backfill starts (its read hangs;
      // selectSession's sidecar may hold its own read too — count later).
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { goal: { status: 'active', objective: 'ship it' } } }],
        2,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      const callsAfterActive = (api.getSessionGoal as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfterActive).toBeGreaterThanOrEqual(1);

      // The meta flips to paused mid-read: the invalidated backfill settles
      // (its stale answer dropped) and a NEW read follows with the current
      // status.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { goal: { status: 'paused' } } }],
        3,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      resolvers[resolvers.length - 1]!({ status: 'active', objective: 'ship it', turns: 1 });
      await vi.waitFor(() =>
        expect((api.getSessionGoal as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
          callsAfterActive + 1,
        ),
      );

      // The follow-up read returns the CURRENT state — the card shows paused.
      resolvers[resolvers.length - 1]!({ status: 'paused', objective: 'ship it', turns: 1 });
      await vi.waitFor(() => expect(client.goal.value?.status).toBe('paused'));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('keeps the mode shield until the authoritative /status re-read lands', async () => {
    // POST success acks nothing until /status confirms: a stale transcript
    // meta arriving in between must not revert the optimistic pick (and must
    // not version-bump the re-read away either).
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('shield-window', false, false);
    let handlers: KimiEventHandlers | undefined;
    let resolveStatus!: (status: unknown) => void;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      updateSession: vi.fn(async () => ({})),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(
        () => new Promise((resolve) => { resolveStatus = resolve; }),
      ),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      client.setSwarmMode(true);
      await vi.waitFor(() => expect(api.getSessionStatus).toHaveBeenCalled());

      // A stale transcript meta (pre-write, swarm off) lands while the
      // authoritative /status re-read is still in flight: the shield holds,
      // the toggle stays ON.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { modes: {} } }],
        2,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(client.swarmMode.value).toBe(true);

      resolveStatus({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: true,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(client.swarmMode.value).toBe(true);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('does not drain the queue on ONE echo entity for TWO identical uncertain sends', async () => {
    // The drain is the one-to-one question: has EVERY uncertain bubble's own
    // echo arrived? Independent existence checks would let a single prompt
    // entity prove both sends and flush the queue while the second request
    // was never observed.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('drain-pair', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      // Both identical sends lose their responses (two uncertain bubbles).
      submitPrompt: vi.fn().mockRejectedValue(new Error('network down')),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      await vi.waitFor(() => expect(connection.subscribeTranscript).toHaveBeenCalled());

      await client.sendPrompt('same text');
      await client.sendPrompt('same text');
      expect(api.submitPrompt).toHaveBeenCalledTimes(2);

      // A remote turn runs (the queue forms behind it).
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId: 't_remote',
              ordinal: 1,
              state: 'running',
              origin: { kind: 'user' },
              startedAt: '2026-08-24T10:00:00.000Z',
            },
          },
          { op: 'meta.merge', meta: { activity: 'turn' } },
        ],
        2,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      void client.sendPrompt('queued third');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(api.submitPrompt).toHaveBeenCalledTimes(2);

      // ONE terminal prompt entity lands ('same text') and the turn ends:
      // it pairs with the FIRST uncertain bubble only — the queue must NOT
      // drain while the second send was never observed.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'prompt.upsert',
            prompt: {
              promptId: 'pr_echo',
              status: 'completed',
              content: [{ type: 'text', text: 'same text' }],
              createdAt: '2026-08-24T10:00:01.000Z',
            },
          },
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId: 't_remote',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'same text',
              startedAt: '2026-08-24T10:00:00.000Z',
              endedAt: '2026-08-24T10:00:02.000Z',
            },
          },
          { op: 'meta.merge', meta: { activity: 'idle' } },
        ],
        3,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(api.submitPrompt).toHaveBeenCalledTimes(2);
      // The second uncertain bubble survived — still unproven: it renders
      // alongside the transcript's own real turn (2 entries, not 3).
      expect(
        client.turns.value.filter((turn) => (turn.text ?? '') === 'same text').length,
      ).toBe(2);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('settles a plan review whose pending and resolved frames landed in one window', async () => {
    // The interaction was never OBSERVED pending — the resolved-edge loop
    // only walks tracked pending ids, so the same-window arrival must be
    // settled by the deduped scan instead.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('plan-samewin', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
      getSessionGoal: vi.fn(async () => null),
      getSessionWarnings: vi.fn(async () => []),
      getSessionPlans: vi.fn(async () => [{ toolCallId: 'call-plan-1', plan: 'do the thing' }]),
      getGitStatus: vi.fn(async () => ({
        branch: '',
        ahead: 0,
        behind: 0,
        entries: {},
        additions: 0,
        deletions: 0,
        pullRequest: null,
      })),
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      await vi.waitFor(() => expect(connection.subscribeTranscript).toHaveBeenCalled());
      (api.getSessionPlans as ReturnType<typeof vi.fn>).mockClear();

      // pending never observed — the interaction arrives ALREADY approved.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'interaction.upsert',
            interaction: {
              interactionId: 'inter-plan-1',
              interactionKind: 'approval',
              state: 'approved',
              toolCallId: 'call-plan-1',
              request: {
                toolName: 'ExitPlanMode',
                toolCallId: 'call-plan-1',
                display: { kind: 'plan_review', plan: 'do the thing' },
              },
              response: { selectedOption: 'approve' },
            },
          },
        ],
        2,
      );
      await vi.waitFor(() => expect(api.getSessionPlans).toHaveBeenCalled());
      await vi.waitFor(() =>
        expect(client.sessionPlans.value['call-plan-1']?.review?.state).toBe('approved'),
      );
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('settles a plan review already resolved in the FIRST baseline', async () => {
    // A cold baseline (first load / LRU re-open) carrying a terminal
    // ExitPlanMode interaction must settle it at open — the first-baseline
    // branch continues before the resolved scan otherwise.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('plan-cold', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
      getSessionGoal: vi.fn(async () => null),
      getSessionWarnings: vi.fn(async () => []),
      getSessionPlans: vi.fn(async () => [{ toolCallId: 'call-plan-1', plan: 'do the thing' }]),
      getGitStatus: vi.fn(async () => ({
        branch: '',
        ahead: 0,
        behind: 0,
        entries: {},
        additions: 0,
        deletions: 0,
        pullRequest: null,
      })),
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [
          {
            interactionId: 'inter-plan-1',
            interactionKind: 'approval',
            state: 'rejected',
            toolCallId: 'call-plan-1',
            request: {
              toolName: 'ExitPlanMode',
              toolCallId: 'call-plan-1',
              display: { kind: 'plan_review', plan: 'do the thing' },
            },
            response: { feedback: 'not now' },
          },
        ],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      // The first baseline settles the already-resolved review at once.
      await vi.waitFor(() =>
        expect(client.sessionPlans.value['call-plan-1']?.review?.state).toBe('rejected'),
      );
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('stays unproven when the stamped prompt entity is missing and a same-text turn ends', async () => {
    // The promptId is KNOWN (POST answered) but its entity hasn't arrived:
    // another client's same-text turn must not settle ours by text match.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('stamped-missing', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_ours', userMessageId: 'msg_ours' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      await client.sendPrompt('same text');
      await vi.waitFor(() => expect(client.activity.value).toBe('running'));
      await vi.waitFor(() => expect(connection.subscribeTranscript).toHaveBeenCalled());
      void client.sendPrompt('queued next');
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Another client's turn with the SAME text starts and ends — ours
      // (pr_ours) is still not in the transcript's prompts.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId: 't_other',
              ordinal: 1,
              state: 'running',
              origin: { kind: 'user' },
              prompt: 'same text',
              startedAt: '2026-08-24T10:00:00.000Z',
            },
          },
          { op: 'meta.merge', meta: { activity: 'turn' } },
        ],
        2,
      );
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId: 't_other',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'same text',
              startedAt: '2026-08-24T10:00:00.000Z',
              endedAt: '2026-08-24T10:00:01.000Z',
            },
          },
          { op: 'meta.merge', meta: { activity: 'idle' } },
        ],
        3,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Unproven: still working, no drain, our bubble still overlaid.
      expect(client.activity.value).toBe('running');
      expect(api.submitPrompt).toHaveBeenCalledTimes(1);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('does not settle an answered submit on another client’s same-text blocked prompt', async () => {
    // The response stamped pr_ours; its entity hasn't arrived. Another
    // client's same-text prompt dying blocked must not settle ours — the
    // known id is the only arbiter on the prompt-transition path too.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('blocked-attr', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_ours', userMessageId: 'msg_ours' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      await client.sendPrompt('same text');
      await vi.waitFor(() => expect(client.activity.value).toBe('running'));
      await vi.waitFor(() => expect(connection.subscribeTranscript).toHaveBeenCalled());
      void client.sendPrompt('queued next');
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Another client's same-text prompt dies blocked (pr_other ≠ pr_ours).
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [
          {
            op: 'prompt.upsert',
            prompt: {
              promptId: 'pr_other',
              status: 'blocked',
              content: [{ type: 'text', text: 'same text' }],
              createdAt: '2026-08-24T10:00:01.000Z',
            },
          },
        ],
        2,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Unproven: still working, no drain.
      expect(client.activity.value).toBe('running');
      expect(api.submitPrompt).toHaveBeenCalledTimes(1);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('holds the mode shield on a failed confirmation read until the retry lands', async () => {
    // The first /status confirmation fails — ack must NOT run on the promise
    // chain anyway. The shield holds through a stale meta frame, and the
    // bounded retry releases it after a successful re-read.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('confirm-retry', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    let statusCalls = 0;
    let failNextStatus = false;
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      updateSession: vi.fn(async () => ({})),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => {
        statusCalls += 1;
        if (failNextStatus) {
          failNextStatus = false;
          throw new Error('status down');
        }
        return {
          model: 'model-1',
          thinkingEffort: 'high',
          permission: 'manual',
          planMode: false,
          swarmMode: true,
          contextTokens: 0,
          maxContextTokens: 0,
          contextUsage: 0,
        };
      }),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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

      failNextStatus = true;
      const callsAtWrite = statusCalls;
      client.setSwarmMode(true);
      // The confirmation call fails; the retry re-reads later.
      await vi.waitFor(() => expect(statusCalls).toBe(callsAtWrite + 1));

      // The first confirmation FAILED: a stale meta frame (swarm appearing
      // OFF→ON in meta is a real change — merging an empty modes object is a
      // model no-op) must not revert the pick while the shield is held.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { modes: { plan: {} } } }],
        2,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(client.swarmMode.value).toBe(true);

      // The bounded retry re-reads (+2s) and acks: NOW a meta fold is just
      // an ordinary fold again (the shield is down) — clearing plan folds
      // the daemon fact back off.
      await vi.waitFor(() => expect(statusCalls).toBe(callsAtWrite + 2), { timeout: 4000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { modes: { swarm: null } } }],
        3,
      );
      await vi.waitFor(() => expect(client.swarmMode.value).toBe(false));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('keeps merged retry tokens across recursion when two fields confirm late', { timeout: 15000 }, async () => {
    // Two different fields (plan off-write, then swarm on-write) both miss
    // their /status confirmation: the second schedule merges the first's
    // pending token into the chain. The recursion must keep that merge (it
    // re-inherits from the still-current map entry) — a lost token would
    // strand the field's pending mark and shield every later fold forever.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const target = session('retry-merge', false, false);
    let handlers: KimiEventHandlers | undefined;
    const subscribeTranscript = vi.fn();
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript,
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    let statusCalls = 0;
    let failBudget = 0;
    // The seeded daemon state: plan ON, swarm OFF. The successful confirmation
    // at the end answers with the writes applied: plan OFF, swarm ON.
    const statusAnswer = { planMode: true, swarmMode: false };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      updateSession: vi.fn(async () => ({})),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => {
        statusCalls += 1;
        if (failBudget > 0) {
          failBudget -= 1;
          throw new Error('status down');
        }
        return {
          model: 'model-1',
          thinkingEffort: 'high',
          permission: 'manual',
          planMode: statusAnswer.planMode,
          swarmMode: statusAnswer.swarmMode,
          contextTokens: 0,
          maxContextTokens: 0,
          contextUsage: 0,
        };
      }),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalled());
      // Let the baseline finish loading before driving ops — a modes fold
      // pushed mid-read is skipped (baselineLoaded false) and clobbered.
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Seed plan ON via a meta fold (the daemon fact), so its OFF-write
      // below carries a real pending token.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { modes: { plan: {} } } }],
        2,
      );
      await vi.waitFor(() => expect(client.planMode.value).toBe(true));
      await vi.waitFor(() => expect(client.planMode.value).toBe(true));

      // Plan OFF-write, then swarm ON-write — both confirmations fail (the
      // first two status reads), so the retry chains merge; the merged chain's
      // first attempt fails too (third read), forcing a recursion.
      failBudget = 3;
      client.setPlanMode(false);
      await vi.waitFor(() => expect(client.planMode.value).toBe(false));
      client.setSwarmMode(true);
      await vi.waitFor(() => expect(client.swarmMode.value).toBe(true));
      const callsAtWrites = statusCalls;

      // The recursion's read succeeds (the writes applied) — BOTH pendings
      // must ack: a lost plan token would leave plan's shield up forever.
      statusAnswer.planMode = false;
      statusAnswer.swarmMode = true;
      await vi.waitFor(
        () => expect(statusCalls).toBeGreaterThanOrEqual(callsAtWrites + 2),
        { timeout: 10_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Shields down: ordinary meta folds land again on BOTH fields.
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { modes: { plan: {} } } }],
        3,
      );
      await vi.waitFor(() => expect(client.planMode.value).toBe(true));
      handlers!.onTranscriptOps?.(
        target.id,
        'main',
        [{ op: 'meta.merge', meta: { modes: { swarm: null } } }],
        4,
      );
      await vi.waitFor(() => expect(client.swarmMode.value).toBe(false));
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('registers the recovery-shown error so the warnings re-pull does not re-toast it', async () => {
    // The empty-reset recovery branch toasts a BACKGROUND session's persisted
    // error notice; selecting the session later re-pulls /warnings — the same
    // error must not toast twice.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const recover = session('recover-warn', false, false);
    const other = session('other', false, false);
    let handlers: KimiEventHandlers | undefined;
    let resolveTranscript!: (page: unknown) => void;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const errorEvent = { code: 'loop.max_steps_exceeded', message: 'max steps' };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessions: vi.fn(async () => ({ items: [recover, other], hasMore: false })),
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(recover), v2Of(other)],
            total: 2,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 2,
      })),
      getSession: vi.fn(async () => ({ id: recover.id, archived: false, workspaceId: 'workspace-1' })),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
      getSessionGoal: vi.fn(async () => null),
      getSessionWarnings: vi.fn(async () => [
        { severity: 'error', code: 'loop.max_steps_exceeded', message: 'max steps' },
      ]),
      getGitStatus: vi.fn(async () => ({
        branch: '',
        ahead: 0,
        behind: 0,
        entries: {},
        additions: 0,
        deletions: 0,
        pullRequest: null,
      })),
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(
        () => new Promise((resolve) => { resolveTranscript = resolve; }),
      ),
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
      await client.selectSession(recover.id);
      expect(handlers).toBeDefined();
      // Go elsewhere while the first read is in flight: the recovery branch
      // is for BACKGROUND sessions.
      await client.selectSession(other.id);

      // The empty reset arms the retry; the read then recovers with the
      // error notice aboard — toasted once here.
      handlers!.onTranscriptReset?.(
        recover.id,
        'main',
        {
          agentId: 'main',
          items: [],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [],
          agents: [],
          pendingInteractions: [],
          meta: { activity: 'idle' },
          hasMoreOlder: false,
        },
        2,
      );
      resolveTranscript({
        agentId: 'main',
        items: [
          {
            kind: 'marker',
            markerId: 'm-err-1',
            marker: 'notice',
            payload: { level: 'error', message: 'max steps', event: errorEvent },
            at: '2026-08-24T10:00:00.000Z',
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      });
      await vi.waitFor(() =>
        expect(
          client.warnings.value.filter((w) => (w.message ?? '').includes('max steps')),
        ).toHaveLength(1),
      );

      // Selecting the session re-pulls /warnings: the SAME persisted error
      // must not toast a second time (the recovery branch registered it).
      await client.selectSession(recover.id);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(
        client.warnings.value.filter((w) => (w.message ?? '').includes('max steps')),
      ).toHaveLength(1);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('stops the status-confirm retry chain once the session is gone', async () => {
    // A deleted/archived session must not get a 15s-cadence retry loop: the
    // in-flight retry's reschedule no-ops once forgetSession ran.
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();
    vi.useFakeTimers();

    const target = session('retry-gone', false, false);
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      subscribeTranscript: vi.fn(),
      unsubscribeTranscript: vi.fn(),
      bindNextPromptId: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    let statusCalls = 0;
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
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
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(target)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSession: vi.fn(async () => ({ id: target.id, archived: false, workspaceId: 'workspace-1' })),
      updateSession: vi.fn(async () => ({})),
      submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_1' })),
      getSessionStatus: vi.fn(async () => {
        statusCalls += 1;
        throw new Error('status down');
      }),
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
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getSessionTranscript: vi.fn(async () => ({
        agentId: 'main',
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        agents: [],
        pendingInteractions: [],
        meta: { activity: 'idle' },
        hasMoreOlder: false,
      })),
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
      await vi.advanceTimersByTimeAsync(150);

      const callsAtWrite = statusCalls;
      client.setSwarmMode(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(statusCalls).toBe(callsAtWrite + 1);

      // The session dies before the first retry fires.
      handlers!.onEvent({ type: 'sessionDeleted', sessionId: target.id }, { sessionId: target.id, seq: 1 });
      await vi.advanceTimersByTimeAsync(0);

      // The pending 2s retry may fire once (it was already scheduled) — but
      // nothing may RESCHEDULE after it.
      await vi.advanceTimersByTimeAsync(2100);
      const callsAfterFirstRetry = statusCalls;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(statusCalls).toBe(callsAfterFirstRetry);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
