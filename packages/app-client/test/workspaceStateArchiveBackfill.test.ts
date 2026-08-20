import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { useWorkspaceState } from '../src/client/useWorkspaceState';

const getKimiWebApiMock = vi.fn();

const BASE = 1_700_000_000_000;
const WS = 'ws1';

/** Minimal AppSession shape: the backfill only reads id / updatedAt /
 *  parentSessionId and whatever workspaceIdForSession looks at; usage is the
 *  all-zero placeholder so setSessionsPreservingLiveUsage can read it. */
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
  const rawState = {
    sessions: [...loaded],
    // The status view's 已完成 list — archiveSession feeds it on success.
    doneSessions: [] as ReturnType<typeof makeSession>[],
    workspaces: [] as { id: string; root: string; name: string }[],
    sessionsCursorByWorkspace: { [WS]: cursor } as Record<string, string | undefined>,
    sessionsHasMoreByWorkspace: { [WS]: hasMore } as Record<string, boolean>,
    sessionsLoadingMoreByWorkspace: {} as Record<string, boolean>,
    sideChatUserMessageIdsBySession: {},
    activeSessionId: undefined as string | undefined,
  };
  const deps = {
    forgetSession: (id: string) => {
      rawState.sessions = rawState.sessions.filter((s) => s.id !== id);
    },
    setSessions: (next: typeof rawState.sessions) => {
      rawState.sessions = next;
    },
    upsertSessionSorted: (session: (typeof rawState.sessions)[number]) => {
      rawState.sessions = [...rawState.sessions.filter((s) => s.id !== session.id), session];
    },
    workspaceIdForSession: (s: { workspaceId?: string; cwd: string }) => s.workspaceId ?? s.cwd,
    sideChat: { clearSideChatForSession: vi.fn() },
    pushOperationFailure: pushOperationFailureMock,
  };
  return {
    rawState,
    archiveSessionMock,
    pushOperationFailureMock,
    ws: useWorkspaceState(rawState as never, deps as never),
  };
}

// The backfill is fire-and-forget; a macrotask boundary drains its chain of
// immediately-resolving fetches.
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
    const page2 = makeSessions('s', 10, 5).slice(5); // s6..s10
    const listSessions = vi.fn().mockResolvedValue({ items: page2, hasMore: true });
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.archiveSession('s2');
    await flush();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's5',
      excludeEmpty: true,
    });
    expect(ids(rawState.sessions)).toEqual(['s1', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']);
    expect(rawState.sessionsCursorByWorkspace[WS]).toBe('s10');
    expect(rawState.sessionsHasMoreByWorkspace[WS]).toBe(true);
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

    // The fetch must page from the new oldest loaded session — the archived
    // id would resolve to an empty, terminal page on the server.
    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      excludeEmpty: true,
    });
    expect(rawState.sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(rawState.sessionsHasMoreByWorkspace[WS]).toBe(false);
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
      excludeEmpty: true,
    });
    expect(ids(rawState.sessions)).toEqual(['s2', 's3']);
    expect(rawState.sessionsCursorByWorkspace[WS]).toBe('s3');
    expect(rawState.sessionsHasMoreByWorkspace[WS]).toBe(false);
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
    expect(rawState.sessionsHasMoreByWorkspace[WS]).toBe(true);
  });

  it('re-anchors to the contiguous predecessor, not an off-page loaded row', async () => {
    // s20 was appended out of band (deep link / search) — it must not become
    // the cursor when the contiguous cursor row is archived, or the next page
    // would skip every session between them.
    const loaded = [...makeSessions('s', 5), makeSession('s20', 19)];
    const listSessions = vi.fn().mockResolvedValue({
      items: [makeSession('s6', 5)],
      hasMore: true,
    });
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.archiveSession('s5');
    await flush();

    // The backfill must page from the contiguous predecessor s4 — never from
    // the off-page s20.
    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      excludeEmpty: true,
    });
    expect(rawState.sessionsCursorByWorkspace[WS]).toBe('s6');
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
    await ws.archiveSession('s5'); // re-anchors the cursor to s4 mid-flight
    // The stale page (anchored to the archived s5) must not be committed —
    // the request is re-issued from the re-anchored cursor instead.
    resolvers[0]!({ items: [], hasMore: false });
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenNthCalledWith(2, {
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      excludeEmpty: true,
    });
    resolvers[1]!({ items: [makeSession('s6', 5)], hasMore: false });
    await pending;
    await flush();

    // The retry restores the row the backfill skipped while it was locked
    // out by this in-flight request.
    expect(rawState.sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(rawState.sessionsHasMoreByWorkspace[WS]).toBe(false);
    expect(ids(rawState.sessions)).toEqual(['s1', 's2', 's3', 's4', 's6']);
  });

  it('stops after the page budget when backfill pages are all child sessions', async () => {
    const loaded = makeSessions('s', 5);
    // Child-only pages: the cursor advances, the visible (non-child) count
    // never does — the budget, not the no-progress guard, must stop the walk.
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
    // Simulate the WS-driven removal landing before the archive POST resolves.
    archiveSessionMock.mockImplementation(async () => {
      rawState.sessions = rawState.sessions.filter((s) => s.id !== 's5');
      return { archived: true };
    });

    await ws.archiveSession('s5');
    await flush();

    // The re-anchor and backfill must run from the state captured before the
    // POST — paging from the contiguous predecessor s4.
    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      excludeEmpty: true,
    });
    expect(rawState.sessionsCursorByWorkspace[WS]).toBe('s6');
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

    // Remote archive: NO archive API call — the server already did it.
    expect(archiveSessionMock).not.toHaveBeenCalled();
    expect(ids(rawState.sessions)).toEqual(['s1', 's3', 's4', 's5', 's6']);
    expect(rawState.doneSessions.map((s) => s.id)).toEqual(['s2']);
    expect(rawState.doneSessions[0]).toMatchObject({ archived: true });
    // Same backfill as the local path: one page from the cursor.
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's5',
      excludeEmpty: true,
    });
    expect(rawState.sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(rawState.sessionsHasMoreByWorkspace[WS]).toBe(false);
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
      excludeEmpty: true,
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
    // The server committed the archive and broadcast the event; the POST
    // response itself is then lost. The EVENT (not pool membership) is what
    // proves the goal state is reached.
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
    // The row disappears from the pool for an unrelated reason (a concurrent
    // load reset it) and NO archive event confirms the request — the POST
    // failure is real and must surface.
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
    // The expand page was already on the wire (s6 included) when the archive
    // event landed — the tombstone must win over the stale page.
    const listSessions = vi.fn().mockResolvedValue({
      items: [makeSession('s6', 5), makeSession('s7', 6)],
      hasMore: false,
    });
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.applyRemoteSessionArchived('s6', WS);
    await ws.loadMoreSessions(WS);

    expect(ids(rawState.sessions)).toEqual(['s1', 's2', 's3', 's4', 's5', 's7']);
    expect(rawState.sessionsCursorByWorkspace[WS]).toBe('s7');
    expect(rawState.sessionsHasMoreByWorkspace[WS]).toBe(false);
  });

  it('advances the cursor from the filtered tail, never a tombstoned page tail', async () => {
    const loaded = makeSessions('s', 5);
    // The stale expand page ends on the tombstoned id — using it as the next
    // before_id could dead-end the following expand.
    const listSessions = vi.fn().mockResolvedValue({
      items: [makeSession('s6', 5), makeSession('s_old', 9)],
      hasMore: true,
    });
    const { rawState, ws } = createState({ loaded, cursor: 's5', hasMore: true, listSessions });

    await ws.applyRemoteSessionArchived('s_old', WS);
    await ws.loadMoreSessions(WS);

    expect(rawState.sessionsCursorByWorkspace[WS]).toBe('s6');
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
    // A full-list walk commits through setSessionsPreservingLiveUsage — the
    // lifted tombstone must not filter the just-restored row back out.
    await ws.loadAllSessions();

    expect(ids(rawState.sessions)).toContain('s2');
  });

  it('tombstones a local archive against stale page commits (backfill included)', async () => {
    const loaded = makeSessions('s', 5);
    // The backfill page still carries the just-archived s2 — the tombstone
    // must filter it out of every commit path.
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

    // The echo of the pre-restore archive lands late: the client VERIFIES
    // against the server (still restored) instead of comparing clocks — the
    // row must stay and no backfill may fire.
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

    // A NEW archive after the restore — the server confirms archived, so the
    // frame applies (and the restore markers are lifted with it).
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

    // Another client's archive broadcast for a session with NO local archive
    // POST in flight — it must not vouch for a future local request.
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

    // Re-archive: the POST hangs while the STALE echo of the first archive
    // arrives — it fails verification (the server still shows restored).
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

    // The POST then genuinely fails — the echo must not have confirmed it.
    rejectPost!(new Error('network down'));
    await pending;

    expect(pushOperationFailureMock).toHaveBeenCalled();
  });

  it('keeps archive folds that landed while the done first page was in flight', async () => {
    const loaded = makeSessions('s', 5);
    let resolveV2: ((page: unknown) => void) | undefined;
    const listSessionsV2 = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveV2 = resolve;
        }),
    );
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
      listSessionsV2,
    });

    const pending = ws.ensureDoneSessions();
    // The archive event folds s2 into the done list while the (stale) first
    // page is still on the wire.
    await ws.applyRemoteSessionArchived('s2', WS);
    await flush();
    expect(rawState.doneSessions.map((s) => s.id)).toContain('s2');

    resolveV2!({ items: [], hasMore: false, nextPageToken: null, total: 0 });
    await pending;

    expect(rawState.doneSessions.map((s) => s.id)).toContain('s2');
  });

  it('does not re-list a restored session when a stale done page commits', async () => {
    const loaded = makeSessions('s', 5);
    const restored = makeSession('s2', 1);
    const listSessionsV2 = vi.fn().mockResolvedValue({
      items: [
        {
          id: 's2',
          workspace: { id: WS, cwd: `/repo/${WS}` },
          meta: {
            title: 'title-s2',
            last_prompt: 'p-s2',
            created_at: BASE - 1000,
            updated_at: BASE - 1000,
            archived: true,
            archived_at: BASE - 1000,
          },
          activity: { status: 'idle' as const },
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
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
      listSessionsV2,
      restoreSession: vi.fn().mockResolvedValue(restored),
    });

    await ws.applyRemoteSessionArchived('s2', WS);
    await flush();
    await ws.restoreSession('s2');

    // A done-list page fetched before the restore still carries s2 as
    // archived — the commit must drop it.
    rawState.doneSessionsSeeded = true;
    rawState.doneSessionsHasMore = true;
    rawState.doneSessionsNextPageToken = 'tok';
    await ws.loadMoreDoneSessions();

    expect(rawState.doneSessions.find((s) => s.id === 's2')).toBeUndefined();
  });
});
