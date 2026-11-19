import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { createWorkspaceRig } from '../src/testing/workspaceRig';
import { sessionsStore } from '../src/stores/sessions';
import { sessionListStore, setSessionListHooks } from '../src/stores/sessionList';
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
  store.workspaceSortMode = 'manual';
  store.workspaceRecencyFloor = {};
  store.sessionsHasMoreByWorkspace = {};
  store.sessionsLoadingMoreByWorkspace = {};
  store.sessionsCursorByWorkspace = {};
  store.sessionsInitialCountByWorkspace = {};
  sessionsStore().setSessions([]);
  sessionsStore().setActiveSessionId(undefined);
  sessionsStore().unpinSessions([...sessionsStore().pinnedSessionIds]);
  sessionListStore().resetSessionList();
}

beforeEach(() => {
  resetStores();
});

const BASE = 1_700_000_000_000;
const WS = 'ws1';

function makeSession(id: string, index: number) {
  return {
    id,
    workspaceId: WS,
    cwd: `/repo/${WS}`,
    updatedAt: new Date(BASE - index * 1000).toISOString(),
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
  };
}

function makeSessions(prefix: string, count: number, indexOffset = 0) {
  return Array.from({ length: count }, (_, i) =>
    makeSession(`${prefix}${i + 1}`, indexOffset + i),
  );
}

interface SetupOptions {
  loaded: ReturnType<typeof makeSession>[];
  cursor: string | undefined;
  hasMore: boolean;
  listSessions: ReturnType<typeof vi.fn>;
}

function createState({ loaded, cursor, hasMore, listSessions }: SetupOptions) {
  const archiveSessionMock = vi.fn().mockResolvedValue({ archived: true });
  const pushOperationFailureMock = vi.fn();
  getKimiWebApiMock.mockReturnValue({
    archiveSession: archiveSessionMock,
    listSessions,
  });
  sessionsStore().setSessions([...loaded] as never);
  const rawState = {
    get sessions() {
      return sessionsStore().sessions;
    },
    set sessions(next: ReturnType<typeof makeSession>[]) {
      sessionsStore().setSessions(next as never);
    },
    get doneSessions() {
      return sessionListStore().doneSessions;
    },
    set doneSessions(next: ReturnType<typeof makeSession>[]) {
      sessionListStore().doneSessions = next as never;
    },
    get doneSessionsSeeded() {
      return sessionListStore().doneSessionsSeeded;
    },
    set doneSessionsSeeded(next: boolean) {
      sessionListStore().doneSessionsSeeded = next;
    },
    get doneSessionsHasMore() {
      return sessionListStore().doneSessionsHasMore;
    },
    set doneSessionsHasMore(next: boolean) {
      sessionListStore().doneSessionsHasMore = next;
    },
    get doneSessionsNextPageToken() {
      return sessionListStore().doneSessionsNextPageToken;
    },
    set doneSessionsNextPageToken(next: string | null) {
      sessionListStore().doneSessionsNextPageToken = next;
    },
    sideChatUserMessageIdsBySession: {},
    activeSessionId: undefined as string | undefined,
  };
  const store = workspacesStore();
  store.sessionsCursorByWorkspace = { [WS]: cursor };
  store.sessionsHasMoreByWorkspace = { [WS]: hasMore };
  const deps = {
    forgetSession: (id: string) => sessionsStore().removeSession(id),
    upsertSessionSorted: (session: ReturnType<typeof makeSession>) =>
      sessionsStore().upsertSessionSorted(session as never),
    sideChat: { clearSideChatForSession: vi.fn() },
    pushOperationFailure: pushOperationFailureMock,
    noteSessionWatermark: vi.fn(),
  };
  setSessionListHooks({
    pushOperationFailure: pushOperationFailureMock,
    onSessionsArchivedLocally: async (ids) => {
      for (const id of ids) sessionsStore().removeSession(id);
    },
  });
  return {
    rawState,
    archiveSessionMock,
    pushOperationFailureMock,
    ws: createWorkspaceRig(rawState as never, deps as never),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function ids(sessions: { id: string }[]): string[] {
  return sessions.map((s) => s.id);
}

describe('archiveSession — backfill and cursor re-anchoring', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
    setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  });

  afterEach(() => {
    resetKimiClientDeps();
  });

  it('archiving a middle row fetches the next page to restore the loaded count', async () => {
    const loaded = makeSessions('s', 5);
    const page2 = makeSessions('s', 10, 5).slice(5);
    const listSessions = vi.fn().mockResolvedValue({ items: page2, hasMore: true });
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.archiveSession('s2');
    await flush();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's5',
      hasPrompt: true,
    });
    expect(ids(rawState.sessions)).toEqual(['s1', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']);
    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s10');
    expect(workspacesStore().sessionsHasMoreByWorkspace[WS]).toBe(true);
  });

  it('re-anchors the cursor first when the archived session was the cursor', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn().mockResolvedValue({
      items: [makeSession('s6', 5)],
      hasMore: false,
    });
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.archiveSession('s5');
    await flush();

    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      hasPrompt: true,
    });
    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(workspacesStore().sessionsHasMoreByWorkspace[WS]).toBe(false);
    expect(ids(rawState.sessions)).toEqual(['s1', 's2', 's3', 's4', 's6']);
  });

  it('re-anchors an emptied workspace with a fresh first page (no before_id)', async () => {
    const loaded = [makeSession('s1', 0)];
    const listSessions = vi.fn().mockResolvedValue({
      items: [makeSession('s2', 1), makeSession('s3', 2)],
      hasMore: false,
    });
    const { rawState, ws } = createState({ loaded, cursor: 's1', hasMore: true, listSessions });

    await ws.archiveSession('s1');
    await flush();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      hasPrompt: true,
    });
    expect(ids(rawState.sessions)).toEqual(['s2', 's3']);
    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s3');
    expect(workspacesStore().sessionsHasMoreByWorkspace[WS]).toBe(false);
  });

  it('does not fetch when the server has no more pages — the group just shrinks', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn();
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: false, listSessions });

    await ws.archiveSession('s2');
    await flush();

    expect(listSessions).not.toHaveBeenCalled();
    expect(ids(rawState.sessions)).toEqual(['s1', 's3', 's4', 's5']);
  });

  it('stops after one attempt when the backfill fetch fails (no retry spin)', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn().mockRejectedValue(new Error('network down'));
    const { rawState, pushOperationFailureMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });

    await ws.archiveSession('s2');
    await flush();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(pushOperationFailureMock).toHaveBeenCalled();
    expect(ids(rawState.sessions)).toEqual(['s1', 's3', 's4', 's5']);
  });

  it('stops after one attempt when the emptied-workspace reload fails', async () => {
    const loaded = [makeSession('s1', 0)];
    const listSessions = vi.fn().mockRejectedValue(new Error('network down'));
    const { rawState, pushOperationFailureMock, ws } = createState({
      loaded,
      cursor: 's1',
      hasMore: true,
      listSessions,
    });

    await ws.archiveSession('s1');
    await flush();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(pushOperationFailureMock).toHaveBeenCalled();
    expect(rawState.sessions).toEqual([]);
    expect(workspacesStore().sessionsHasMoreByWorkspace[WS]).toBe(true);
  });

  it('re-anchors to the contiguous predecessor, not an off-page loaded row', async () => {
    const loaded = [...makeSessions('s', 5), makeSession('s20', 19)];
    const listSessions = vi.fn().mockResolvedValue({
      items: [makeSession('s6', 5)],
      hasMore: true,
    });
    const { ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.archiveSession('s5');
    await flush();

    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      hasPrompt: true,
    });
    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s6');
  });

  it('retries a stale load-more from the re-anchored cursor instead of discarding', async () => {
    const loaded = makeSessions('s', 5);
    const resolvers: Array<
      (page: { items: ReturnType<typeof makeSession>[]; hasMore: boolean }) => void
    > = [];
    const listSessions = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    const pending = ws.loadMoreSessions(WS);
    await ws.archiveSession('s5');
    resolvers[0]!({ items: [], hasMore: false });
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenNthCalledWith(2, {
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      hasPrompt: true,
    });
    resolvers[1]!({ items: [makeSession('s6', 5)], hasMore: false });
    await pending;
    await flush();

    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(workspacesStore().sessionsHasMoreByWorkspace[WS]).toBe(false);
    expect(ids(rawState.sessions)).toEqual(['s1', 's2', 's3', 's4', 's6']);
  });

  it('stops after the page budget when backfill pages are all child sessions', async () => {
    const loaded = makeSessions('s', 5);
    const childPage = (page: number) =>
      Array.from({ length: 5 }, (_, i) => ({
        ...makeSession(`c${page}_${i}`, 5 + page * 5 + i),
        parentSessionId: 'parent_1',
      }));
    const listSessions = vi.fn().mockImplementation(async ({ beforeId }: { beforeId?: string }) => {
      const page = beforeId === 's5' ? 0 : beforeId === 'c0_4' ? 1 : 2;
      return { items: childPage(page), hasMore: true };
    });
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.archiveSession('s1');
    await flush();

    expect(listSessions).toHaveBeenCalledTimes(3);
    expect(ids(rawState.sessions).filter((id) => !id.startsWith('c'))).toEqual([
      's2',
      's3',
      's4',
      's5',
    ]);
  });

  it('still backfills when another client removes the row while the POST is in flight', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn().mockResolvedValue({
      items: [makeSession('s6', 5)],
      hasMore: false,
    });
    const { rawState, archiveSessionMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });
    archiveSessionMock.mockImplementation(async () => {
      rawState.sessions = rawState.sessions.filter((s) => s.id !== 's5');
      return { archived: true };
    });

    await ws.archiveSession('s5');
    await flush();

    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      hasPrompt: true,
    });
    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(ids(rawState.sessions)).toEqual(['s1', 's2', 's3', 's4', 's6']);
  });
});

describe('applyRemoteSessionArchived — event.session.archived reconciliation', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
    setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  });

  afterEach(() => {
    resetKimiClientDeps();
  });

  it('removes the session from the pool, folds it into the done list, and backfills', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn().mockResolvedValue({
      items: [makeSession('s6', 5)],
      hasMore: false,
    });
    const { rawState, archiveSessionMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });

    await ws.applyRemoteSessionArchived('s2', WS);
    await flush();

    expect(archiveSessionMock).not.toHaveBeenCalled();
    expect(ids(rawState.sessions)).toEqual(['s1', 's3', 's4', 's5', 's6']);
    expect(rawState.doneSessions.map((s) => s.id)).toEqual(['s2']);
    expect(rawState.doneSessions[0]).toMatchObject({ archived: true });
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's5',
      hasPrompt: true,
    });
    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(workspacesStore().sessionsHasMoreByWorkspace[WS]).toBe(false);
  });

  it('falls back to the locally derived workspace when the event omits workspaceId', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn().mockResolvedValue({
      items: [makeSession('s6', 5)],
      hasMore: false,
    });
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.applyRemoteSessionArchived('s2');
    await flush();

    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's5',
      hasPrompt: true,
    });
    expect(ids(rawState.sessions)).toEqual(['s1', 's3', 's4', 's5', 's6']);
  });

  it('is a complete no-op for a session the client never loaded (or already archived)', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn();
    const { rawState, archiveSessionMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });

    await ws.applyRemoteSessionArchived('unknown_session', WS);
    await flush();

    expect(archiveSessionMock).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
    expect(ids(rawState.sessions)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(rawState.doneSessions).toEqual([]);
  });

  it('is a no-op on the echo of our own archive (the pool row is already gone)', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn().mockResolvedValue({ items: [], hasMore: false });
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.archiveSession('s2');
    await flush();
    listSessions.mockClear();

    await ws.applyRemoteSessionArchived('s2', WS);
    await flush();

    expect(listSessions).not.toHaveBeenCalled();
    expect(ids(rawState.sessions)).toEqual(['s1', 's3', 's4', 's5']);
    expect(rawState.doneSessions.map((s) => s.id)).toEqual(['s2']);
  });

  it('stays silent when the POST rejects after the archive event already confirmed it', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn().mockResolvedValue({ items: [], hasMore: false });
    const { rawState, archiveSessionMock, pushOperationFailureMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });
    archiveSessionMock.mockImplementation(async () => {
      await ws.applyRemoteSessionArchived('s2', WS);
      throw new Error('network down');
    });

    await ws.archiveSession('s2');
    await flush();

    expect(pushOperationFailureMock).not.toHaveBeenCalled();
    expect(ids(rawState.sessions)).toEqual(['s1', 's3', 's4', 's5']);
  });

  it('reports the failure when the row vanished for an unrelated reason without a confirmation', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn();
    const { rawState, archiveSessionMock, pushOperationFailureMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });
    archiveSessionMock.mockImplementation(async () => {
      rawState.sessions = rawState.sessions.filter((s) => s.id !== 's2');
      throw new Error('network down');
    });

    await ws.archiveSession('s2');
    await flush();

    expect(pushOperationFailureMock).toHaveBeenCalled();
  });

  it('still reports the failure when the POST rejects and the row stays put', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn();
    const { rawState, archiveSessionMock, pushOperationFailureMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });
    archiveSessionMock.mockRejectedValue(new Error('network down'));

    await ws.archiveSession('s2');
    await flush();

    expect(pushOperationFailureMock).toHaveBeenCalled();
    expect(ids(rawState.sessions)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(rawState.doneSessions).toEqual([]);
  });

  it('loadMoreSessions does not resurrect a tombstoned session fetched before the archive', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn().mockResolvedValue({
      items: [makeSession('s6', 5), makeSession('s7', 6)],
      hasMore: false,
    });
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.applyRemoteSessionArchived('s6', WS);
    await ws.loadMoreSessions(WS);

    expect(ids(rawState.sessions)).toEqual(['s1', 's2', 's3', 's4', 's5', 's7']);
    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s7');
    expect(workspacesStore().sessionsHasMoreByWorkspace[WS]).toBe(false);
  });

  it('advances the cursor from the filtered tail, never a tombstoned page tail', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn().mockResolvedValue({
      items: [makeSession('s6', 5), makeSession('s_old', 9)],
      hasMore: true,
    });
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.applyRemoteSessionArchived('s_old', WS);
    await ws.loadMoreSessions(WS);

    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(ids(rawState.sessions)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
  });

  it('lifts the tombstone on restore so a later full-list commit keeps the row', async () => {
    const loaded = makeSessions('s', 5);
    const restored = makeSession('s2', 1);
    const listSessions = vi.fn().mockResolvedValue({ items: [restored], hasMore: false });
    const { rawState, archiveSessionMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });
    getKimiWebApiMock.mockReturnValue({
      archiveSession: archiveSessionMock,
      listSessions,
      restoreSession: vi.fn().mockResolvedValue(restored),
    });

    await ws.applyRemoteSessionArchived('s2', WS);
    await flush();
    expect(ids(rawState.sessions)).not.toContain('s2');

    await ws.restoreSession('s2');
    await ws.loadAllSessions();

    expect(ids(rawState.sessions)).toContain('s2');
  });

  it('tombstones a local archive against stale page commits (backfill included)', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn().mockResolvedValue({
      items: [makeSession('s2', 1), makeSession('s6', 5)],
      hasMore: false,
    });
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.archiveSession('s2');
    await flush();

    expect(ids(rawState.sessions)).toEqual(['s1', 's3', 's4', 's5', 's6']);
  });

  it('ignores a stale archive echo when the server still shows the session restored', async () => {
    const loaded = makeSessions('s', 5);
    const restored = makeSession('s2', 1);
    const listSessions = vi.fn().mockResolvedValue({ items: [], hasMore: false });
    const { rawState, archiveSessionMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });
    getKimiWebApiMock.mockReturnValue({
      archiveSession: archiveSessionMock,
      listSessions,
      restoreSession: vi.fn().mockResolvedValue(restored),
      getSession: vi.fn().mockResolvedValue({ ...restored, archived: false }),
    });

    await ws.archiveSession('s2');
    await flush();
    await ws.restoreSession('s2');
    expect(ids(rawState.sessions)).toContain('s2');
    listSessions.mockClear();

    const genuine = await ws.applyRemoteSessionArchived('s2', WS);
    await flush();

    expect(genuine).toBe(false);
    expect(ids(rawState.sessions)).toContain('s2');
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('applies a genuine archive after a restore when the server shows it archived', async () => {
    const loaded = makeSessions('s', 5);
    const restored = makeSession('s2', 1);
    const listSessions = vi.fn().mockResolvedValue({ items: [], hasMore: false });
    const { rawState, archiveSessionMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });
    getKimiWebApiMock.mockReturnValue({
      archiveSession: archiveSessionMock,
      listSessions,
      restoreSession: vi.fn().mockResolvedValue(restored),
      getSession: vi.fn().mockResolvedValue({ ...restored, archived: true }),
    });

    await ws.archiveSession('s2');
    await flush();
    await ws.restoreSession('s2');
    expect(ids(rawState.sessions)).toContain('s2');

    const genuine = await ws.applyRemoteSessionArchived('s2', WS);
    await flush();

    expect(genuine).toBe(true);
    expect(ids(rawState.sessions)).not.toContain('s2');
    expect(rawState.doneSessions.map((s) => s.id)).toContain('s2');
  });

  it('does not treat a broadcast archive as confirmation for a later local archive', async () => {
    const loaded = makeSessions('s', 5);
    const listSessions = vi.fn();
    const { archiveSessionMock, pushOperationFailureMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });

    await ws.applyRemoteSessionArchived('s9', WS);
    archiveSessionMock.mockRejectedValue(new Error('network down'));

    await ws.archiveSession('s9');
    await flush();

    expect(pushOperationFailureMock).toHaveBeenCalled();
  });

  it('does not confirm an in-flight archive with a stale echo that failed verification', async () => {
    const loaded = makeSessions('s', 5);
    const restored = makeSession('s2', 1);
    const listSessions = vi.fn().mockResolvedValue({ items: [], hasMore: false });
    const { archiveSessionMock, pushOperationFailureMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });
    getKimiWebApiMock.mockReturnValue({
      archiveSession: archiveSessionMock,
      listSessions,
      restoreSession: vi.fn().mockResolvedValue(restored),
      getSession: vi.fn().mockResolvedValue({ ...restored, archived: false }),
    });

    await ws.archiveSession('s2');
    await flush();
    await ws.restoreSession('s2');

    let rejectPost: ((error: Error) => void) | undefined;
    archiveSessionMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectPost = reject;
        }),
    );
    const pending = ws.archiveSession('s2');
    const genuine = await ws.applyRemoteSessionArchived('s2', WS);
    expect(genuine).toBe(false);

    rejectPost!(new Error('network down'));
    await pending;

    expect(pushOperationFailureMock).toHaveBeenCalled();
  });

  it('keeps archive folds that landed while the done first page was in flight', async () => {
    const loaded = makeSessions('s', 5);
    let resolveDone: ((page: unknown) => void) | undefined;
    const listSessions = vi.fn((input?: { archived?: boolean | 'all' }) =>
      input?.archived === true
        ? new Promise((resolve) => {
            resolveDone = resolve;
          })
        : Promise.resolve({ items: [], hasMore: false, nextPageToken: null, total: 0 }),
    );
    const { rawState, archiveSessionMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });
    getKimiWebApiMock.mockReturnValue({
      archiveSession: archiveSessionMock,
      listSessions,
    });

    const pending = ws.ensureDoneSessions();
    await ws.applyRemoteSessionArchived('s2', WS);
    await flush();
    expect(rawState.doneSessions.map((s) => s.id)).toContain('s2');

    resolveDone!({ items: [], hasMore: false, nextPageToken: null, total: 0 });
    await pending;

    expect(rawState.doneSessions.map((s) => s.id)).toContain('s2');
  });

  it('does not re-list a restored session when a stale done page commits', async () => {
    const loaded = makeSessions('s', 5);
    const restored = makeSession('s2', 1);
    const listSessions = vi.fn((input?: { archived?: boolean | 'all' }) =>
      Promise.resolve(
        input?.archived === true
          ? {
              items: [
                {
                  ...makeSession('s2', 1),
                  lastPrompt: 'p-s2',
                  archived: true,
                },
              ],
              hasMore: false,
              nextPageToken: null,
              total: 1,
            }
          : { items: [], hasMore: false, nextPageToken: null, total: 0 },
      ),
    );
    const { rawState, archiveSessionMock, ws } = createState({
      loaded,
      cursor: 's5',
      hasMore: true,
      listSessions,
    });
    getKimiWebApiMock.mockReturnValue({
      archiveSession: archiveSessionMock,
      listSessions,
      restoreSession: vi.fn().mockResolvedValue(restored),
    });

    await ws.applyRemoteSessionArchived('s2', WS);
    await flush();
    await ws.restoreSession('s2');

    rawState.doneSessionsSeeded = true;
    rawState.doneSessionsHasMore = true;
    rawState.doneSessionsNextPageToken = 'tok';
    await ws.loadMoreDoneSessions();

    expect(rawState.doneSessions.find((s) => s.id === 's2')).toBeUndefined();
  });
});
