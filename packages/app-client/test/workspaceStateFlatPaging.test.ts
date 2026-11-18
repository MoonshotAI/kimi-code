import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonApiError } from '@moonshot-ai/app-core/api';
import type { AppSession, SessionsPage } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { createWorkspaceRig } from '../src/testing/workspaceRig';
import { sessionsStore } from '../src/stores/sessions';
import { sessionListStore, setSessionListHooks } from '../src/stores/sessionList';
import { sessionViewsStore } from '../src/stores/sessionViews';
import { workspacesStore } from '../src/stores/workspaces';

const getKimiWebApiMock = vi.fn();

function resetStores(): void {
  const store = workspacesStore();
  store.workspaces = [];
  store.storedActiveWorkspaceId = null;
  store.fsHome = null;
  store.recentRoots = [];
  store.hiddenWorkspaceIds = [];
  store.workspaceOrder = [];
  store.pinnedWorkspaceIds = [];
  store.workspaceSortMode = 'manual';
  store.workspaceRecencyFloor = {};
  store.sessionsHasMoreByWorkspace = {};
  store.sessionsLoadingMoreByWorkspace = {};
  store.sessionsCursorByWorkspace = {};
  store.sessionsInitialCountByWorkspace = {};
  sessionsStore().setSessions([]);
  sessionsStore().setActiveSessionId(undefined);
  sessionsStore().unpinSessions([...sessionsStore().pinnedSessionIds]);
  sessionViewsStore().setFlatSessionsFrontier(null);
  sessionListStore().resetSessionList();
}

beforeEach(() => {
  resetStores();
});

function flatItem(
  id: string,
  opts: { empty?: boolean; ws?: string; updatedAt?: number } = {},
): AppSession {
  const ws = opts.ws ?? 'ws1';
  return {
    id,
    workspaceId: ws,
    cwd: `/repo/${ws}`,
    title: `title-${id}`,
    lastPrompt: opts.empty === true ? undefined : `prompt-${id}`,
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(opts.updatedAt ?? 1000).toISOString(),
    busy: false,
    archived: false,
    model: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
  };
}

function page(items: AppSession[], hasMore: boolean, nextToken: string | null): SessionsPage {
  return { items, hasMore, nextPageToken: hasMore ? nextToken : null, total: items.length };
}

interface SetupOptions {
  pooledIds?: string[];
  pages: SessionsPage[];
  seeded?: boolean;
}

function createState({ pooledIds = [], pages, seeded = true }: SetupOptions) {
  const listSessions = vi.fn();
  for (const p of pages) listSessions.mockResolvedValueOnce(p);
  listSessions.mockResolvedValue(page([], false, null));
  getKimiWebApiMock.mockReturnValue({ listSessions });

  sessionsStore().setSessions(pooledIds.map((id) => ({ id })) as never);
  const listStore = sessionListStore();
  listStore.flatSessionsNextPageToken = 'tok0';
  listStore.flatSessionsSeeded = seeded;
  const pushOperationFailureMock = vi.fn();
  setSessionListHooks({
    pushOperationFailure: pushOperationFailureMock,
  });
  workspacesStore().workspaces = [
    { id: 'ws1', root: '/repo/ws1', name: 'ws1', sessionCount: 0 },
  ];
  const rawState = { sessions: [], activeSessionId: undefined };
  return {
    listSessions,
    pushOperationFailureMock,
    listStore,
    ws: createWorkspaceRig(rawState as never, {} as never),
  };
}

describe('flat list — remote-archive tombstones', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
    setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  });

  afterEach(() => {
    resetKimiClientDeps();
  });

  it('does not resurrect a tombstoned session when a flat page commits', async () => {
    const { ws } = createState({
      pages: [page([flatItem('s_arch'), flatItem('s_new')], false, null)],
      seeded: false,
    });

    await ws.applyRemoteSessionArchived('s_arch');
    await sessionListStore().ensureFlatSessions();

    expect(sessionsStore().sessions.map((s) => s.id)).toEqual(['s_new']);
  });
});

describe('loadMoreFlatSessions — paging loop', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
    setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  });

  afterEach(() => {
    resetKimiClientDeps();
  });

  it('keeps paging past empty and hidden-workspace pages until visible rows land', async () => {
    const { listSessions, listStore } = createState({
      pages: [
        page([flatItem('e1', { empty: true })], true, 'tok1'),
        page([flatItem('h1', { ws: 'ws-hidden' }), flatItem('h2', { ws: 'ws-hidden' })], true, 'tok2'),
        page([flatItem('v1'), flatItem('v2')], true, 'tok3'),
      ],
    });
    workspacesStore().hiddenWorkspaceIds = ['ws-hidden'];

    await listStore.loadMoreFlatSessions();

    expect(listSessions).toHaveBeenCalledTimes(3);
    expect(sessionsStore().sessions.map((s) => s.id)).toEqual(['h1', 'h2', 'v1', 'v2']);
    expect(listStore.flatSessionsNextPageToken).toBe('tok3');
    expect(listStore.flatSessionsLoadingMore).toBe(false);
  });

  it('stops on an overlapped page: the frontier extension reveals its rows', async () => {
    const { listSessions, listStore } = createState({
      pooledIds: ['a', 'b'],
      pages: [page([flatItem('a', { updatedAt: 500 }), flatItem('b', { updatedAt: 400 })], true, 'tok1')],
    });

    await listStore.loadMoreFlatSessions();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(sessionsStore().sessions).toHaveLength(2);
    expect(listStore.flatSessionsNextPageToken).toBe('tok1');
    expect(sessionViewsStore().flatSessionsFrontier).toBe(400);
  });

  it('stops cleanly when the endpoint drains mid-click', async () => {
    const { listSessions, listStore } = createState({
      pages: [page([flatItem('x', { empty: true })], false, null)],
    });

    await listStore.loadMoreFlatSessions();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listStore.flatSessionsHasMore).toBe(false);
    expect(sessionsStore().sessions).toHaveLength(0);
    expect(listStore.flatSessionsLoadingMore).toBe(false);
  });

  it('caps the page loop when every page reveals nothing', async () => {
    const { listSessions, listStore } = createState({
      pages: Array.from({ length: 8 }, (_, i) =>
        page([flatItem(`e${i}`, { empty: true })], true, `tok${i + 1}`),
      ),
    });

    await listStore.loadMoreFlatSessions();

    expect(listSessions).toHaveBeenCalledTimes(5);
    expect(listStore.flatSessionsNextPageToken).toBe('tok5');
    expect(listStore.flatSessionsLoadingMore).toBe(false);
  });

  it('a 40922 page_token mismatch resets the cursor and refetches the first page', async () => {
    const { pushOperationFailureMock, listStore } = createState({ pages: [] });
    const listSessions = vi
      .fn()
      .mockRejectedValueOnce(
        new DaemonApiError({ code: 40922, msg: 'mismatch', requestId: 'r' }),
      )
      .mockResolvedValueOnce(page([flatItem('fresh', { updatedAt: 700 })], false, null));
    getKimiWebApiMock.mockReturnValue({ listSessions });

    await listStore.loadMoreFlatSessions();

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions.mock.calls[1]![0].pageToken).toBeUndefined();
    expect(listSessions.mock.calls[1]![0].pageSize).toBeGreaterThan(0);
    expect(sessionsStore().sessions.map((s) => s.id)).toEqual(['fresh']);
    expect(listStore.flatSessionsSeeded).toBe(true);
    expect(sessionViewsStore().flatSessionsFrontier).toBe(700);
    expect(pushOperationFailureMock).not.toHaveBeenCalled();
    expect(listStore.flatSessionsLoadingMore).toBe(false);
  });

  it('non-mismatch failures surface via pushOperationFailure and reset the flag', async () => {
    const { pushOperationFailureMock, listStore } = createState({ pages: [] });
    const listSessions = vi.fn().mockRejectedValue(new Error('boom'));
    getKimiWebApiMock.mockReturnValue({ listSessions });

    await listStore.loadMoreFlatSessions();

    expect(pushOperationFailureMock).toHaveBeenCalledWith('loadMoreFlatSessions', expect.any(Error));
    expect(listStore.flatSessionsLoadingMore).toBe(false);
  });

  it('is a no-op while a fetch is in flight', async () => {
    const { ws } = createState({ pages: [] });
    let resolvePage: (p: SessionsPage) => void = () => {};
    const listSessions = vi.fn().mockImplementation(
      () => new Promise<SessionsPage>((resolve) => { resolvePage = resolve; }),
    );
    getKimiWebApiMock.mockReturnValue({ listSessions });

    const first = ws.loadMoreFlatSessions();
    await ws.loadMoreFlatSessions();
    expect(listSessions).toHaveBeenCalledTimes(1);
    resolvePage(page([], false, null));
    await first;
  });

  it('retries the first-page seed when it never landed (earlier seed failure)', async () => {
    const { listSessions, listStore } = createState({
      pages: [page([flatItem('s1', { updatedAt: 900 })], true, 'tok1')],
      seeded: false,
    });
    listStore.flatSessionsNextPageToken = null;

    await listStore.loadMoreFlatSessions();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions.mock.calls[0]![0].pageToken).toBeUndefined();
    expect(listStore.flatSessionsSeeded).toBe(true);
    expect(sessionsStore().sessions.map((s) => s.id)).toEqual(['s1']);
    expect(listStore.flatSessionsNextPageToken).toBe('tok1');
    expect(sessionViewsStore().flatSessionsFrontier).toBe(900);
    expect(listStore.flatSessionsLoadingMore).toBe(false);
  });

  it('ensureSidebarFlatSessions automatically advances past pages belonging only to pinned workspaces', async () => {
    const { listSessions, listStore } = createState({
      pages: [
        page([flatItem('s-pinned-ws-1', { ws: 'ws-pinned', updatedAt: 950 })], true, 'tok1'),
        page([flatItem('s-unpinned-1', { ws: 'ws1', updatedAt: 850 })], false, null),
      ],
      seeded: false,
    });
    workspacesStore().workspaces = [
      { id: 'ws-pinned', root: '/repo/ws-pinned', name: 'Pinned WS', sessionCount: 0 },
      { id: 'ws1', root: '/repo/ws1', name: 'ws1', sessionCount: 0 },
    ];
    workspacesStore().pinWorkspace('ws-pinned');
    listStore.flatSessionsNextPageToken = null;

    await listStore.ensureSidebarFlatSessions(1);

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(sessionViewsStore().flatSessionsAll.map((s) => s.id)).toEqual([
      's-pinned-ws-1',
      's-unpinned-1',
    ]);
    expect(sessionViewsStore().unpinnedFlatSessionsAll.map((s) => s.id)).toEqual(['s-unpinned-1']);
    expect(listStore.flatSessionsHasMore).toBe(false);
  });
});
