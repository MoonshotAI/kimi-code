
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSession,
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
  status: 'running',
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

describe('useKimiWebClient (applyEvent slice isolation)', () => {
  it('an event that changes no session leaves sidebar computeds untouched', async () => {
    vi.stubGlobal('WebSocket', class {});

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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace',sessionCount: 1 },
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
      await new Promise((resolve) => setTimeout(resolve, 120));

      const sessionsBefore = client.sessionsForView.value;
      const groupsBefore = client.workspaceGroups.value;
      const turnsBefore = client.turns.value;

      handlers!.onEvent(
        { type: 'unknown', raw: { _noop: true, _wireType: 'event.capability.changed' } },
        { sessionId },
      );
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(client.turns.value).toBe(turnsBefore);
      expect(client.sessionsForView.value).toBe(sessionsBefore);
      expect(client.workspaceGroups.value).toBe(groupsBefore);

      handlers!.onEvent(
        { type: 'sessionWorkChanged', sessionId, busy: false, mainTurnActive: false },
        { sessionId },
      );
      expect(client.sessionsForView.value).not.toBe(sessionsBefore);
      expect(client.workspaceGroups.value).not.toBe(groupsBefore);

    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

  it('reads the side chat turn error from its transcript and hides it once a new send runs', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

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
        { id: 'workspace-1', root: '/workspace', name: 'Workspace',sessionCount: 1 },
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
      submitPrompt: vi.fn(async () => ({ promptId: 'prompt-btw-2', userMessageId: 'message-btw-2', status: 'running' as const })),
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
      await new Promise((resolve) => setTimeout(resolve, 120));

      await client.openSideChat();
      handlers!.onConversation?.(sessionId, 'agent-btw-1', {
        type: 'turns',
        turns: [{
          turn_id: 't0',
          ordinal: 0,
          turn_number: 1,
          kind: 'agent',
          status: 'ended',
          outcome: 'failed',
          error: {
            code: 'quota_exhausted',
            message: 'exceeded your current quota',
            retryable: false,
            status_code: 429,
            request_id: 'req-1',
          },
          started_at: '2026-01-01T00:00:01.000Z',
          steps: [],
          items: [{
            type: 'user_message',
            item_id: 'prompt-btw-1',
            status: 'ended',
            placement: 'opener',
            prompt_ids: ['prompt-btw-1'],
            origin: { kind: 'user' },
            content: [{ type: 'text', text: 'side question' }],
          }],
        }],
        has_more: false,
      });

      expect(client.sideChatTurnErrorOf('agent-btw-1')).toEqual(
        expect.objectContaining({
          code: 'quota_exhausted',
          message: 'exceeded your current quota',
          statusCode: 429,
          requestId: 'req-1',
        }),
      );
      expect(client.sideChatSendingOf('agent-btw-1')).toBe(false);
      expect(client.sideChatRunningOf('agent-btw-1')).toBe(false);

      await expect(client.sendSideChatPromptOn(sessionId, 'agent-btw-1', 'again')).resolves.toBe(true);
      expect(client.sideChatRunningOf('agent-btw-1')).toBe(true);
      expect(client.sideChatTurnErrorOf('agent-btw-1')).toBeNull();
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });

});
