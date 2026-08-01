import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getKimiWebApiMock, trackMock } = vi.hoisted(() => ({
  getKimiWebApiMock: vi.fn(),
  trackMock: vi.fn(),
}));

vi.mock('../../src/renderer/api', () => ({ getKimiWebApi: getKimiWebApiMock }));
vi.mock('../../src/renderer/lib/track', () => ({ track: trackMock }));

import { useWorkspaceState } from '../../src/renderer/composables/client/useWorkspaceState';

const BASE = 1_700_000_000_000;
const WS = 'ws1';

/** Minimal AppSession shape: the backfill only reads id / updatedAt /
 *  parentSessionId and whatever workspaceIdForSession looks at. */
function makeSession(id: string, index: number) {
  return {
    id,
    workspaceId: WS,
    cwd: `/repo/${WS}`,
    updatedAt: new Date(BASE - index * 1000).toISOString(),
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
