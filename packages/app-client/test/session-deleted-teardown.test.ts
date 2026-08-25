/**
 * Scenario: a session is deleted REMOTELY (another client), arriving as a
 * sessionDeleted WS event. Responsibilities: the client must run the full
 * per-session teardown — not just drop the row from the sidebar: the event
 * connection is unsubscribed (which releases the projector's per-session
 * projection state, transcript copies included) and the side-chat buckets
 * keyed by the session are evicted. Regression guard for the memory-leak fix
 * where this path only removed the pin and left every sidecar map behind.
 * Wiring: the composable is real; daemon requests and the WS connection are
 * stubbed, events are injected through the captured handlers.
 * Run: cd packages/app-client && npx vitest run test/session-deleted-teardown.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSession,
  AppSessionSnapshot,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  V2Session,
} from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';

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

beforeEach(() => {
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
});

afterEach(() => {
  resetKimiClientDeps();
});

const sessionId = 'session-1';

const session: AppSession = {
  id: sessionId,
  title: 'Session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  archived: false,
  currentPromptId: null,
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
  inFlightTurn: null,
  subagents: [],
  pendingApprovals: [],
  pendingQuestions: [],
};

describe('useKimiWebClient — remote sessionDeleted teardown', () => {
  it('unsubscribes the session and evicts its side-chat state', async () => {
    vi.stubGlobal('WebSocket', class {});

    let handlers: KimiEventHandlers | undefined;
    const unsubscribeMock: KimiEventConnection['unsubscribe'] = vi.fn();
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: unsubscribeMock,
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
      listSessions: vi.fn(async () => ({ items: [session], hasMore: false })),
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: [v2Of(session)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
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
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      expect(handlers).toBeDefined();

      // Open the side chat and seed one side-chat exchange.
      await client.openSideChat();
      expect(client.sideChatVisible.value).toBe(true);
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
        { sessionId, seq: 11 },
      );
      expect(client.sideChatTurns.value).toHaveLength(1);

      // The remote deletion arrives.
      handlers!.onEvent({ type: 'sessionDeleted', sessionId }, { sessionId, seq: 12 });

      // The sidebar row is gone…
      expect(client.sessions.value.some((s) => s.id === sessionId)).toBe(false);
      // …the event connection was dropped (the daemon client releases the
      // projector's per-session state on unsubscribe)…
      expect(unsubscribeMock).toHaveBeenCalledWith(sessionId);
      // …and the side-chat surface reset (its per-agent buckets evicted).
      expect(client.sideChatVisible.value).toBe(false);
      expect(client.sideChatTurns.value).toEqual([]);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });
});
