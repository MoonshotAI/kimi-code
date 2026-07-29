/**
 * Scenario: the WebSocket reconnects after session work changed while the
 * client was offline.
 * Responsibilities: wait for replay ACK, refresh list-level work state,
 * preserve live events during the REST request, and drain queued prompts.
 * Wiring: the real composable with daemon requests and the socket stubbed.
 * Run: pnpm --filter kimi-code-web exec vitest run test/session-work-reconnect.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppApprovalRequest,
  AppQuestionRequest,
  AppSession,
  AppSessionSnapshot,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
} from '../src/api/types';

const clientApiMock = vi.hoisted(() => ({}));

vi.mock('../src/api', () => ({
  getKimiWebApi: () => clientApiMock,
}));

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

function snapshot(value: AppSession): AppSessionSnapshot {
  return {
    asOfSeq: value.lastSeq,
    epoch: 'epoch-1',
    session: value,
    messages: [],
    hasMoreMessages: false,
    inFlightTurn: value.mainTurnActive
      ? {
          turnId: 1,
          assistantText: '',
          thinkingText: '',
          runningTools: [],
          promptId: 'prompt-1',
        }
      : null,
    subagents: [],
    pendingApprovals: [],
    pendingQuestions: [],
  };
}

describe('useKimiWebClient session work reconnect baseline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconciles after replay without overwriting live events or stranding the queue', async () => {
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
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      bindNextPromptId: vi.fn(),
      seedSnapshot: vi.fn(),
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
          isGitRepo: false,
          sessionCount: initial.length,
        },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions,
      getSessionSnapshot: vi.fn(async (id) => snapshot(initial.find((item) => item.id === id)!)),
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
      getFileUrl: (fileId) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(queued.id);
      expect(handlers).toBeDefined();

      handlers!.onConnectionChange(true);
      handlers!.onReplayComplete?.();
      expect(listSessions).toHaveBeenCalledTimes(1);
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
      expect(listSessions).toHaveBeenCalledTimes(1);
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
});
