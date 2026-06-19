// apps/kimi-web/test/archive-last-session.test.ts
//
// Reproduces / verifies the bug where archiving the only session in a workspace
// does not behave correctly.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, AppWorkspace, KimiEventHandlers, KimiWebApi } from '../src/api/types';

const now = '2026-06-11T00:00:00.000Z';

function session(id: string, overrides?: Partial<AppSession>): AppSession {
  return {
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    status: 'idle',
    archived: false,
    cwd: '/repo',
    model: 'kimi-test',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 128_000,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
    ...overrides,
  };
}

async function setup(opts: {
  sessions?: AppSession[];
  workspaces?: AppWorkspace[];
}) {
  vi.resetModules();
  vi.stubGlobal('WebSocket', class WebSocket {});
  window.history.replaceState(null, '', '/');

  let handlers: KimiEventHandlers | undefined;
  const eventConn = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    bindNextPromptId: vi.fn(),
    seedSnapshot: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(),
  };
  const listed = opts.sessions ?? [];
  const workspaces = opts.workspaces ?? [];
  const api = {
    getHealth: vi.fn(async () => ({ status: 'ok', uptimeSec: 1 })),
    getMeta: vi.fn(async () => ({ daemonVersion: 't', serverId: 's', startedAt: now, capabilities: {} })),
    getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'kimi-test', managedProvider: null })),
    listModels: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => workspaces),
    getFsHome: vi.fn(async () => ({ home: '/home', recentRoots: [] })),
    listSessions: vi.fn(async () => ({ items: listed, hasMore: false })),
    getSession: vi.fn(async (id: string) => {
      const found = listed.find((s) => s.id === id);
      if (!found) throw new Error('SESSION_NOT_FOUND');
      return found;
    }),
    archiveSession: vi.fn(async () => ({ archived: true })),
    getSessionSnapshot: vi.fn(async (id: string) => {
      const found = listed.find((s) => s.id === id) ?? session(id);
      return {
        asOfSeq: 0,
        epoch: 'ep_test',
        session: found,
        messages: [],
        hasMoreMessages: false,
        inFlightTurn: null,
        pendingApprovals: [],
        pendingQuestions: [],
      };
    }),
    listTasks: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => ({ branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0 })),
    getSessionStatus: vi.fn(async () => ({
      model: 'kimi-test',
      thinkingLevel: 'high',
      permission: 'manual',
      planMode: false,
      swarmMode: false,
      contextTokens: 0,
      maxContextTokens: 128_000,
      contextUsage: 0,
    })),
    connectEvents: vi.fn((nextHandlers: KimiEventHandlers) => {
      handlers = nextHandlers;
      return eventConn;
    }),
    getFileUrl: vi.fn((fileId: string) => `/files/${fileId}`),
  } as unknown as KimiWebApi;

  vi.doMock('../src/api', () => ({ getKimiWebApi: () => api }));
  const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');

  return {
    api,
    client: useKimiWebClient(),
    getHandlers: () => {
      if (!handlers) throw new Error('connectEvents was not called');
      return handlers;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('archive last session in workspace', () => {
  it('removes the only session and clears active session', async () => {
    const { client } = await setup({
      sessions: [session('sess_1', { cwd: '/repo' })],
      workspaces: [{ id: 'ws_repo', root: '/repo', name: 'repo', sessionCount: 1 }],
    });
    await client.load();

    expect(client.activeSessionId.value).toBe('sess_1');
    expect(client.sessions.value.map((s) => s.id)).toEqual(['sess_1']);
    expect(client.workspacesView.value.map((w) => ({ id: w.id, sessionCount: w.sessionCount }))).toEqual([
      { id: 'ws_repo', sessionCount: 1 },
    ]);

    await client.archiveSession('sess_1');

    expect(client.sessions.value).toEqual([]);
    expect(client.activeSessionId.value).toBe('');
    expect(window.location.pathname).toBe('/');
    expect(client.workspacesView.value.map((w) => ({ id: w.id, sessionCount: w.sessionCount }))).toEqual([
      { id: 'ws_repo', sessionCount: 0 },
    ]);
  });

  it('removes the only session in one workspace when another workspace exists', async () => {
    const { client } = await setup({
      sessions: [
        session('sess_a', { cwd: '/repo-a' }),
        session('sess_b', { cwd: '/repo-b' }),
      ],
      workspaces: [
        { id: 'ws_a', root: '/repo-a', name: 'repo-a', sessionCount: 1 },
        { id: 'ws_b', root: '/repo-b', name: 'repo-b', sessionCount: 1 },
      ],
    });
    await client.load();

    expect(client.activeSessionId.value).toBe('sess_a');

    await client.archiveSession('sess_a');

    expect(client.sessions.value.map((s) => s.id)).toEqual(['sess_b']);
    expect(client.activeSessionId.value).toBe('sess_b');
  });
});
