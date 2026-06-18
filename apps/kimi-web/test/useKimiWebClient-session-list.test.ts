// apps/kimi-web/test/useKimiWebClient-session-list.test.ts
//
// load() must list sessions per workspace and follow pagination, so a session
// that falls outside the global top-N is still reachable from the sidebar.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSession,
  AppWorkspace,
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

function workspace(id: string, root: string): AppWorkspace {
  return { id, root, name: id, isGitRepo: false, sessionCount: 0 };
}

interface SetupOpts {
  workspaces: AppWorkspace[];
  /** Map of workspaceId -> pages, or undefined -> global fallback pages. */
  pagesByWorkspace: Record<string, Array<Page<AppSession>>>;
  /** Pages used by the global fallback when no workspaces are returned. */
  globalPages?: Array<Page<AppSession>>;
  /** workspaceIds whose listSessions call should reject. */
  failingWorkspaces?: Set<string>;
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

  // Per-workspace page cursors (mutable so repeated calls walk pages).
  const cursors = new Map<string, number>();
  const globalCursor = { value: 0 };

  const listSessions = vi.fn(
    async (input?: { workspaceId?: string; beforeId?: string; pageSize?: number }) => {
      if (input?.workspaceId) {
        if (opts.failingWorkspaces?.has(input.workspaceId)) {
          throw new Error('boom');
        }
        const pages = opts.pagesByWorkspace[input.workspaceId] ?? [];
        const idx = cursors.get(input.workspaceId) ?? 0;
        cursors.set(input.workspaceId, idx + 1);
        return pages[idx] ?? { items: [], hasMore: false };
      }
      const pages = opts.globalPages ?? [];
      const idx = globalCursor.value;
      globalCursor.value += 1;
      return pages[idx] ?? { items: [], hasMore: false };
    },
  );

  const api = {
    getHealth: vi.fn(async () => ({ status: 'ok', uptimeSec: 1 })),
    getMeta: vi.fn(async () => ({ daemonVersion: 't', serverId: 's', startedAt: t0, capabilities: {} })),
    getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'kimi-test', managedProvider: null })),
    listModels: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => opts.workspaces),
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

describe('load() per-workspace session listing', () => {
  it('fans out to each workspace with the correct workspaceId', async () => {
    const wsA = workspace('ws_a', '/repo/a');
    const wsB = workspace('ws_b', '/repo/b');
    const { api, client } = await setup({
      workspaces: [wsA, wsB],
      pagesByWorkspace: {
        ws_a: [{ items: [session('sess_a1')], hasMore: false }],
        ws_b: [{ items: [session('sess_b1'), session('sess_b2')], hasMore: false }],
      },
    });

    await client.load();

    const calls = (api.listSessions as ReturnType<typeof vi.fn>).mock.calls;
    const workspaceIds = calls.map(([input]) => input?.workspaceId).sort();
    expect(workspaceIds).toEqual(['ws_a', 'ws_b']);

    const ids = client.sessions.value.map((s) => s.id).sort();
    expect(ids).toEqual(['sess_a1', 'sess_b1', 'sess_b2']);
  });

  it('follows pagination within a workspace using beforeId', async () => {
    const ws = workspace('ws_a', '/repo/a');
    const { api, client } = await setup({
      workspaces: [ws],
      pagesByWorkspace: {
        ws_a: [
          { items: [session('sess_1'), session('sess_2')], hasMore: true },
          { items: [session('sess_3')], hasMore: false },
        ],
      },
    });

    await client.load();

    const calls = (api.listSessions as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toMatchObject({ workspaceId: 'ws_a', beforeId: undefined });
    expect(calls[1]![0]).toMatchObject({ workspaceId: 'ws_a', beforeId: 'sess_2' });

    const ids = client.sessions.value.map((s) => s.id).sort();
    expect(ids).toEqual(['sess_1', 'sess_2', 'sess_3']);
  });

  it('sorts merged sessions by updatedAt descending across workspaces', async () => {
    const wsA = workspace('ws_a', '/repo/a');
    const wsB = workspace('ws_b', '/repo/b');
    const { client } = await setup({
      workspaces: [wsA, wsB],
      pagesByWorkspace: {
        ws_a: [
          {
            items: [
              session('sess_old', { updatedAt: '2026-06-10T00:00:00.000Z' }),
              session('sess_newest', { updatedAt: '2026-06-12T00:00:00.000Z' }),
            ],
            hasMore: false,
          },
        ],
        ws_b: [
          {
            items: [session('sess_mid', { updatedAt: '2026-06-11T00:00:00.000Z' })],
            hasMore: false,
          },
        ],
      },
    });

    await client.load();

    expect(client.sessions.value.map((s) => s.id)).toEqual([
      'sess_newest',
      'sess_mid',
      'sess_old',
    ]);
  });

  it('falls back to a global paginated list when no workspaces are returned', async () => {
    const { api, client } = await setup({
      workspaces: [],
      pagesByWorkspace: {},
      globalPages: [
        { items: [session('sess_g1')], hasMore: true },
        { items: [session('sess_g2')], hasMore: false },
      ],
    });

    await client.load();

    const calls = (api.listSessions as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toMatchObject({ beforeId: undefined });
    expect(calls[0]![0]?.workspaceId).toBeUndefined();
    expect(calls[1]![0]).toMatchObject({ beforeId: 'sess_g1' });

    const ids = client.sessions.value.map((s) => s.id).sort();
    expect(ids).toEqual(['sess_g1', 'sess_g2']);
  });

  it('isolates a failing workspace so other workspaces still load', async () => {
    const wsA = workspace('ws_a', '/repo/a');
    const wsB = workspace('ws_b', '/repo/b');
    const { client } = await setup({
      workspaces: [wsA, wsB],
      pagesByWorkspace: {
        ws_b: [{ items: [session('sess_b1')], hasMore: false }],
      },
      failingWorkspaces: new Set(['ws_a']),
    });

    await expect(client.load()).resolves.toBeUndefined();
    expect(client.sessions.value.map((s) => s.id)).toEqual(['sess_b1']);
  });
});
