/**
 * Scenario: a streaming assistant delta reaches the client mid-turn.
 * Responsibilities: applyEvent must NOT dirty sidebar computeds whose inputs
 * the delta never touched (regression guard for the diff-and-assign fix —
 * previously every delta replaced every state slice's identity, so each
 * streamed token re-ran sessionsForView / workspaceGroups at
 * O(sessions × workspaces)); genuinely changed state must still propagate.
 * Wiring: the composable is real; daemon requests and the WS connection are
 * stubbed, events are injected through the captured handlers.
 * Run: pnpm --filter kimi-code-web exec vitest run test/apply-event-slices.test.ts
 */

import { describe, expect, it, vi } from 'vitest';
import type {
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

const sessionId = 'session-1';

const session: AppSession = {
  id: sessionId,
  title: 'Session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'running',
  archived: false,
  currentPromptId: 'prompt-1',
  cwd: '/workspace',
  model: 'model-1',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextLimit: 0,
    turnCount: 1,
  },
  messageCount: 1,
  lastSeq: 10,
  workspaceId: 'workspace-1',
};

const initialSnapshot: AppSessionSnapshot = {
  asOfSeq: 10,
  epoch: 'epoch-1',
  session,
  messages: [
    {
      id: 'message-1',
      sessionId,
      role: 'assistant',
      content: [{ type: 'text', text: 'seed' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  hasMoreMessages: false,
  inFlightTurn: {
    turnId: 1,
    assistantText: 'seed',
    thinkingText: '',
    runningTools: [],
    promptId: 'prompt-1',
  },
  subagents: [],
  pendingApprovals: [],
  pendingQuestions: [],
};

describe('useKimiWebClient (applyEvent slice isolation)', () => {
  it('a pure streaming delta leaves sidebar computeds untouched', async () => {
    vi.stubGlobal('WebSocket', class {});

    let handlers: KimiEventHandlers | undefined;
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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace',sessionCount: 1 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: [session], hasMore: false })),
      getSessionSnapshot: vi.fn(async () => initialSnapshot),
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
      startBtw: vi.fn(async () => ({ agentId: 'agent-btw-1' })),
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
      const assistantText = (): string | undefined =>
        client.turns.value.find((turn) => turn.role === 'assistant')?.text;
      expect(assistantText()).toBe('seed');
      expect(handlers).toBeDefined();

      // Vue computeds return their CACHED array identity until a dependency
      // changes, so reference equality observes exactly "did this recompute".
      const sessionsBefore = client.sessionsForView.value;
      const groupsBefore = client.workspaceGroups.value;

      // A mid-turn streaming delta: render events drain via the batcher's
      // task fallback (50 ms) when no animation frame fires.
      handlers!.onEvent(
        { type: 'assistantDelta', sessionId, messageId: 'message-1', contentIndex: 0, delta: { text: ' more' } },
        { sessionId, seq: 11 },
      );
      await new Promise((resolve) => setTimeout(resolve, 120));

      // The chat view consumed the delta…
      expect(assistantText()).toBe('seed more');
      // …without re-running the sidebar list derivations.
      expect(client.sessionsForView.value).toBe(sessionsBefore);
      expect(client.workspaceGroups.value).toBe(groupsBefore);

      // A genuine state change still invalidates and recomputes them.
      handlers!.onEvent(
        { type: 'sessionWorkChanged', sessionId, busy: false, mainTurnActive: false },
        { sessionId, seq: 12 },
      );
      expect(client.sessionsForView.value).not.toBe(sessionsBefore);
      expect(client.workspaceGroups.value).not.toBe(groupsBefore);

      await client.openSideChat();
      handlers!.onEvent(
        {
          type: 'messageCreated',
          agentId: 'agent-btw-1',
          message: {
            id: 'message-btw-1',
            sessionId,
            role: 'user',
            content: [{ type: 'text', text: 'side question' }],
            createdAt: '2026-01-01T00:00:01.000Z',
            promptId: 'prompt-btw-1',
          },
        },
        { sessionId, seq: 13 },
      );
      expect(client.sideChatTurns.value).toEqual([
        expect.objectContaining({ role: 'user', text: 'side question' }),
      ]);
      expect(client.turns.value.some((turn) => turn.text === 'side question')).toBe(false);

      client.closeSideChat();
      handlers!.onEvent(
        {
          type: 'messageCreated',
          agentId: 'agent-btw-1',
          message: {
            id: 'message-btw-2',
            sessionId,
            role: 'user',
            content: [{ type: 'text', text: 'late side question' }],
            createdAt: '2026-01-01T00:00:02.000Z',
            promptId: 'prompt-btw-2',
          },
        },
        { sessionId, seq: 14 },
      );
      expect(client.turns.value.some((turn) => turn.text === 'late side question')).toBe(false);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });
});
