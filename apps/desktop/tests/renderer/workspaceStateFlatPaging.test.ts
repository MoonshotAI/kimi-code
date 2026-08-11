import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';

const { getKimiWebApiMock, trackMock } = vi.hoisted(() => ({
  getKimiWebApiMock: vi.fn(),
  trackMock: vi.fn(),
}));

vi.mock('../../src/renderer/api', () => ({ getKimiWebApi: getKimiWebApiMock }));
vi.mock('../../src/renderer/lib/track', () => ({ track: trackMock }));

import { DaemonApiError } from '@moonshot-ai/app-core/api';
import { useWorkspaceState } from '../../src/renderer/composables/client/useWorkspaceState';
import type { V2Session, V2SessionsPage } from '../../src/renderer/api/types';

/** Minimal v2 item: the flat paging path reads workspace/meta/activity + git. */
function v2Item(
  id: string,
  opts: { empty?: boolean; ws?: string; updatedAt?: number } = {},
): V2Session {
  return {
    id,
    workspace: { id: opts.ws ?? 'ws1', cwd: `/repo/${opts.ws ?? 'ws1'}` },
    meta: {
      title: `title-${id}`,
      last_prompt: opts.empty === true ? null : `prompt-${id}`,
      created_at: 1,
      updated_at: opts.updatedAt ?? 1000,
      archived: false,
    },
    activity: { status: 'idle' },
  };
}

function page(items: V2Session[], hasMore: boolean, nextToken: string | null): V2SessionsPage {
  return { items, hasMore, nextPageToken: hasMore ? nextToken : null };
}

interface SetupOptions {
  /** Ids already in the shared pool (count as overlap on upsert). */
  pooledIds?: string[];
  /** Pages returned in order by the mocked listSessionsV2. */
  pages: V2SessionsPage[];
  seeded?: boolean;
}

function createState({ pooledIds = [], pages, seeded = true }: SetupOptions) {
  const listSessionsV2 = vi.fn();
  for (const p of pages) listSessionsV2.mockResolvedValueOnce(p);
  // Any call beyond the queued pages drains the list.
  listSessionsV2.mockResolvedValue(page([], false, null));
  getKimiWebApiMock.mockReturnValue({ listSessionsV2 });

  const rawState = {
    sessions: pooledIds.map((id) => ({ id })),
    flatSessionsNextPageToken: 'tok0' as string | null,
    flatSessionsHasMore: true,
    flatSessionsLoading: false,
    flatSessionsLoadingMore: false,
    flatSessionsSeeded: seeded,
    flatSessionsFrontier: null as number | null,
  };
  const deps = {
    setSessions: (next: typeof rawState.sessions) => {
      rawState.sessions = next;
    },
    updateSession: (id: string, update: (s: { id: string }) => { id: string }) => {
      rawState.sessions = rawState.sessions.map((s) => (s.id === id ? update(s) : s));
    },
    pushOperationFailure: vi.fn(),
    // The flat view only shows sessions whose workspace is visible — the
    // revealable-row count keys off this set (hidden-workspace rows don't count).
    workspacesView: computed(() => [{ id: 'ws1', root: '/repo/ws1', name: 'ws1' }]),
    workspaceIdForSession: (s: { workspaceId?: string; cwd: string }) =>
      s.workspaceId ?? s.cwd,
  };
  return {
    rawState,
    listSessionsV2,
    pushOperationFailureMock: deps.pushOperationFailure,
    ws: useWorkspaceState(rawState as never, deps as never),
  };
}

describe('loadMoreFlatSessions — paging loop', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
  });

  it('keeps paging past empty and hidden-workspace pages until visible rows land', async () => {
    // Page 1: all empty (filtered on entry). Page 2: all hidden-workspace.
    // Page 3: one visible row.
    const { rawState, listSessionsV2, ws } = createState({
      pages: [
        page([v2Item('e1', { empty: true })], true, 'tok1'),
        page([v2Item('h1', { ws: 'ws-hidden' }), v2Item('h2', { ws: 'ws-hidden' })], true, 'tok2'),
        page([v2Item('v1'), v2Item('v2')], true, 'tok3'),
      ],
    });

    await ws.loadMoreFlatSessions();

    expect(listSessionsV2).toHaveBeenCalledTimes(3);
    // Hidden rows still enter the pool; empty rows never do.
    expect(rawState.sessions.map((s) => s.id)).toEqual(['h1', 'h2', 'v1', 'v2']);
    expect(rawState.flatSessionsNextPageToken).toBe('tok3');
    expect(rawState.flatSessionsLoadingMore).toBe(false);
  });

  it('stops on an overlapped page: the frontier extension reveals its rows', async () => {
    // a/b are already pooled, but the page still moves the frontier over them —
    // the flat view reveals them, so the click is not a no-op and must stop.
    const { rawState, listSessionsV2, ws } = createState({
      pooledIds: ['a', 'b'],
      pages: [page([v2Item('a', { updatedAt: 500 }), v2Item('b', { updatedAt: 400 })], true, 'tok1')],
    });

    await ws.loadMoreFlatSessions();

    expect(listSessionsV2).toHaveBeenCalledTimes(1);
    expect(rawState.sessions).toHaveLength(2); // nothing new appended
    expect(rawState.flatSessionsNextPageToken).toBe('tok1');
    expect(rawState.flatSessionsFrontier).toBe(400);
  });

  it('stops cleanly when the endpoint drains mid-click', async () => {
    const { rawState, listSessionsV2, ws } = createState({
      pages: [page([v2Item('x', { empty: true })], false, null)],
    });

    await ws.loadMoreFlatSessions();

    expect(listSessionsV2).toHaveBeenCalledTimes(1);
    expect(rawState.flatSessionsHasMore).toBe(false);
    expect(rawState.sessions).toHaveLength(0);
    expect(rawState.flatSessionsLoadingMore).toBe(false);
  });

  it('caps the page loop when every page reveals nothing', async () => {
    const { listSessionsV2, rawState, ws } = createState({
      pages: Array.from({ length: 8 }, (_, i) =>
        page([v2Item(`e${i}`, { empty: true })], true, `tok${i + 1}`),
      ),
    });

    await ws.loadMoreFlatSessions();

    // FLAT_LOAD_MORE_MAX_PAGES = 5 — never spins through the whole backlog.
    expect(listSessionsV2).toHaveBeenCalledTimes(5);
    expect(rawState.flatSessionsNextPageToken).toBe('tok5');
    expect(rawState.flatSessionsLoadingMore).toBe(false);
  });

  it('a 40922 page_token mismatch resets the cursor and refetches the first page', async () => {
    const { rawState, pushOperationFailureMock, ws } = createState({ pages: [] });
    const listSessionsV2 = vi
      .fn()
      .mockRejectedValueOnce(
        new DaemonApiError({ code: 40922, msg: 'mismatch', requestId: 'r' }),
      )
      .mockResolvedValueOnce(page([v2Item('fresh', { updatedAt: 700 })], false, null));
    getKimiWebApiMock.mockReturnValue({ listSessionsV2 });

    await ws.loadMoreFlatSessions();

    expect(listSessionsV2).toHaveBeenCalledTimes(2);
    // Second call is the first-page refetch: no page_token.
    expect(listSessionsV2.mock.calls[1]![0].pageToken).toBeUndefined();
    expect(listSessionsV2.mock.calls[1]![0].pageSize).toBeGreaterThan(0);
    expect(rawState.sessions.map((s) => s.id)).toEqual(['fresh']);
    expect(rawState.flatSessionsSeeded).toBe(true);
    // The first-page refetch resets the frontier to its own tail.
    expect(rawState.flatSessionsFrontier).toBe(700);
    expect(pushOperationFailureMock).not.toHaveBeenCalled();
    expect(rawState.flatSessionsLoadingMore).toBe(false);
  });

  it('non-mismatch failures surface via pushOperationFailure and reset the flag', async () => {
    const { rawState, pushOperationFailureMock, ws } = createState({ pages: [] });
    const listSessionsV2 = vi.fn().mockRejectedValue(new Error('boom'));
    getKimiWebApiMock.mockReturnValue({ listSessionsV2 });

    await ws.loadMoreFlatSessions();

    expect(pushOperationFailureMock).toHaveBeenCalledWith('loadMoreFlatSessions', expect.any(Error));
    expect(rawState.flatSessionsLoadingMore).toBe(false);
  });

  it('is a no-op while a fetch is in flight', async () => {
    const { ws } = createState({ pages: [] });
    let resolvePage: (p: V2SessionsPage) => void = () => {};
    const listSessionsV2 = vi.fn().mockImplementation(
      () => new Promise<V2SessionsPage>((resolve) => { resolvePage = resolve; }),
    );
    getKimiWebApiMock.mockReturnValue({ listSessionsV2 });

    const first = ws.loadMoreFlatSessions();
    await ws.loadMoreFlatSessions(); // must not fire a second request
    expect(listSessionsV2).toHaveBeenCalledTimes(1);
    resolvePage(page([], false, null));
    await first;
  });

  it('retries the first-page seed when it never landed (earlier seed failure)', async () => {
    const { rawState, listSessionsV2, ws } = createState({
      pages: [page([v2Item('s1', { updatedAt: 900 })], true, 'tok1')],
      seeded: false,
    });
    rawState.flatSessionsNextPageToken = null; // no cursor without a seed

    await ws.loadMoreFlatSessions();

    // The click refetches the first page instead of dead-ending on the null
    // token: no page_token is sent, cursor/frontier come from the seed page.
    expect(listSessionsV2).toHaveBeenCalledTimes(1);
    expect(listSessionsV2.mock.calls[0]![0].pageToken).toBeUndefined();
    expect(rawState.flatSessionsSeeded).toBe(true);
    expect(rawState.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(rawState.flatSessionsNextPageToken).toBe('tok1');
    expect(rawState.flatSessionsFrontier).toBe(900);
    expect(rawState.flatSessionsLoadingMore).toBe(false);
  });
});
