// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSession,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
} from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { agentState } from './agentFrames';

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

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

describe('active session unread on turn end', () => {
  it('clears automatic unread on visibility and preserves manual unread until the session is opened', { timeout: 30_000 }, async () => {
    vi.resetModules();
    setVisibility('visible');
    window.localStorage.clear();

    const target = session('active-unread-target');
    const other = session('active-unread-other');
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn((sid: string, agentId: string) => {
        queueMicrotask(() => handlers?.onConversation?.(sid, agentId, { type: 'turns', turns: [], has_more: false }));
      }),
      unsubscribeConversation: vi.fn(),
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
      listSessions: vi.fn(async () => ({ items: [target, other], hasMore: false, nextPageToken: null, total: 2 })),
      listSessionGroups: vi.fn(async () => ({
        groups: [
          {
            workspaceId: 'workspace-1',
            sessions: [listedOf(target), listedOf(other)],
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

    const turn = (turnId: string, ordinal: number, state: 'running' | 'completed') => ({
      turn_id: turnId,
      ordinal,
      turn_number: ordinal + 1,
      kind: 'agent' as const,
      status: state === 'running' ? 'running' as const : 'ended' as const,
      ...(state === 'completed' ? { outcome: 'completed' as const, ended_at: '2026-08-24T10:00:01.000Z' } : {}),
      started_at: '2026-08-24T10:00:00.000Z',
      steps: [],
    });
    const runTurn = async (turnId: string, ordinal: number): Promise<void> => {
      handlers!.onAgentState?.(target.id, 'main', agentState('running'));
      handlers!.onConversation?.(target.id, 'main', { type: 'turn.started', turn: turn(turnId, ordinal, 'running') });
      await new Promise((resolve) => setTimeout(resolve, 0));
      handlers!.onConversation?.(target.id, 'main', { type: 'turn.ended', turn: turn(turnId, ordinal, 'completed') });
      handlers!.onAgentState?.(target.id, 'main', agentState('idle'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession(target.id);
      expect(client.activeSessionId.value).toBe(target.id);

      await runTurn('visible-turn', 1);
      expect(client.unreadBySession.value[target.id]).not.toBe(true);

      setVisibility('hidden');
      await runTurn('hidden-turn', 2);
      expect(client.unreadBySession.value[target.id]).toBe(true);

      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(client.unreadBySession.value[target.id]).not.toBe(true);

      const { sessionViewsStore } = await import('../src/stores/sessionViews');
      sessionViewsStore().markManualUnread(target.id);
      setVisibility('hidden');
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(client.unreadBySession.value[target.id]).toBe(true);

      await client.selectSession(target.id);
      expect(client.unreadBySession.value[target.id]).not.toBe(true);
    } finally {
      connection.close();
    }
  });
});
