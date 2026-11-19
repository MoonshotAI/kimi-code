
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSession,
  AppSessionSnapshot,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
} from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';

function listedOf(s: AppSession): AppSession {
  return { ...s, lastPrompt: s.lastPrompt ?? 'prompt' };
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
  it('cleans session state and lists after a sessionDeleted event', async () => {
    vi.resetModules();
    vi.stubGlobal('WebSocket', class {});

    let handlers: KimiEventHandlers | undefined;
    const unsubscribeConversationMock: KimiEventConnection['unsubscribeConversation'] = vi.fn();
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn(),
      unsubscribeConversation: unsubscribeConversationMock,
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
      listSessions: vi.fn(async () => ({ items: [session], hasMore: false, nextPageToken: null, total: 1 })),
      listSessionGroups: vi.fn(async () => ({
        groups: [
          {
            workspaceId: 'workspace-1',
            sessions: [listedOf(session)],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSessionSnapshot: vi.fn(async () => initialSnapshot),
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

      await client.openSideChat();
      expect(client.sideChatVisible.value).toBe(true);
      expect(client.auxiliaryConversations.getEntry(sessionId, 'agent-btw-1')).toBeDefined();
      handlers!.onConversation?.(sessionId, 'agent-btw-1', {
        type: 'turns',
        turns: [{
          turn_id: 't0',
          ordinal: 0,
          turn_number: 1,
          kind: 'agent',
          status: 'ended',
          outcome: 'completed',
          started_at: '2026-01-01T00:00:01.000Z',
          steps: [],
          items: [{
            type: 'user_message',
            item_id: 'prompt-btw-1',
            status: 'ended',
            outcome: 'completed',
            created_at: '2026-01-01T00:00:01.000Z',
            placement: 'opener',
            prompt_ids: ['prompt-btw-1'],
            origin: { kind: 'user' },
            text: 'side question',
            attachments: [],
            skills: [],
          }],
        }],
        has_more: false,
      });
      await vi.waitFor(() => expect(client.sideChatTurns.value).toHaveLength(1));

      const { sessionListStore } = await import('../src/stores/sessionList');
      sessionListStore().doneSessions = [{ ...session, archived: true }];
      client.sessionAdminItems.value.push(listedOf(session));
      client.sessionAdminSelectedIds.value.add(sessionId);
      handlers!.onEvent({ type: 'sessionDeleted', sessionId }, { sessionId });
      expect(sessionListStore().doneSessions).toEqual([]);
      expect(client.sessionAdminItems.value).toEqual([]);
      expect(client.sessionAdminSelectedIds.value.has(sessionId)).toBe(false);

      expect(client.sessions.value.some((s) => s.id === sessionId)).toBe(false);
      expect(unsubscribeConversationMock).toHaveBeenCalledWith(sessionId, ['agent-btw-1']);
      expect(client.sideChatVisible.value).toBe(false);
      expect(client.sideChatTurns.value).toEqual([]);
      expect(client.auxiliaryConversations.getEntry(sessionId, 'agent-btw-1')).toBeUndefined();
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });
});
