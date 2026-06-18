// apps/kimi-web/test/useKimiWebClient-session-list.test.ts
//
// load() must drain every session page (not just the first), so a session
// beyond the initial page is still reachable from the sidebar. A single global
// walk is used so sessions whose cwd is not a registered workspace root are
// included too.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSession,
  KimiEventHandlers,
  KimiWebApi,
  Page,
} from '../src/api/types';

const t0 = '2026-06-11T00:00:00.000Z';

function session(id: string, overrides?: Partial<AppSession>): AppSession {
  return {
    id,
    title: id,
    createdAt: t0,
    updatedAt: t0,
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

interface SetupOpts {
  pages: Array<Page<AppSession>>;
  listWorkspaces?: () => Promise<unknown[]>;
  listSessionsError?: Error;
}

async function setup(opts: SetupOpts) {
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

  let cursor = 0;
  const listSessions = vi.fn(
    async (_input?: { workspaceId?: string; beforeId?: string; pageSize?: number }) => {
      if (opts.listSessionsError) throw opts.listSessionsError;
      const page = opts.pages[cursor] ?? { items: [], hasMore: false };
      cursor += 1;
      return page;
    },
  );

  const api = {
    getHealth: vi.fn(async () => ({ status: 'ok', uptimeSec: 1 })),
    getMeta: vi.fn(async () => ({ daemonVersion: 't', serverId: 's', startedAt: t0, capabilities: {} })),
    getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'kimi-test', managedProvider: null })),
    listModels: vi.fn(async () => []),
    listWorkspaces: vi.fn(opts.listWorkspaces ?? (async () => [])),
    getFsHome: vi.fn(async () => ({ home: '/home', recentRoots: [] })),
    listSessions,
    getSession: vi.fn(async (id: string) => session(id)),
    getSessionSnapshot: vi.fn(async (id: string) => ({
      asOfSeq: 0,
      epoch: 'ep_test',
      session: session(id),
      messages: [],
      hasMoreMessages: false,
      inFlightTurn: null,
      pendingApprovals: [],
      pendingQuestions: [],
    })),
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

describe('load() session listing', () => {
  it('drains every page using the beforeId cursor', async () => {
    const { api, client } = await setup({
      pages: [
        { items: [session('sess_1'), session('sess_2')], hasMore: true },
        { items: [session('sess_3')], hasMore: false },
      ],
    });

    await client.load();

    const calls = (api.listSessions as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toMatchObject({ beforeId: undefined });
    expect(calls[1]![0]).toMatchObject({ beforeId: 'sess_2' });

    const ids = client.sessions.value.map((s) => s.id).sort();
    expect(ids).toEqual(['sess_1', 'sess_2', 'sess_3']);
  });

  it('never passes a workspaceId so unregistered-cwd sessions are included', async () => {
    const { api, client } = await setup({
      pages: [{ items: [session('sess_orphan', { cwd: '/tmp/scratch' })], hasMore: false }],
    });

    await client.load();

    const calls = (api.listSessions as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]?.workspaceId).toBeUndefined();
    expect(client.sessions.value.map((s) => s.id)).toEqual(['sess_orphan']);
  });

  it('surfaces an empty list when listSessions rejects', async () => {
    const { client } = await setup({
      pages: [],
      listSessionsError: new Error('boom'),
    });

    await expect(client.load()).resolves.toBeUndefined();
    expect(client.sessions.value).toEqual([]);
  });
});
