import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetKimiClientDeps,
  setKimiClientDeps,
  useWorkspaceState,
} from '@moonshot-ai/app-client/client';
import type { V2Session, V2SessionsPage } from '@moonshot-ai/app-core/api';

const getKimiWebApiMock = vi.fn();

beforeEach(() => {
  getKimiWebApiMock.mockReset();
  setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
});
afterEach(() => {
  resetKimiClientDeps();
});

/** Minimal v2 item for the done list: archived rows with an archived_at stamp. */
function v2Done(id: string, opts: { empty?: boolean; ws?: string } = {}): V2Session {
  return {
    id,
    workspace: { id: opts.ws ?? 'ws1', cwd: `/repo/${opts.ws ?? 'ws1'}` },
    meta: {
      title: `title-${id}`,
      last_prompt: opts.empty === true ? null : `prompt-${id}`,
      created_at: 1,
      updated_at: 2000,
      archived: true,
      archived_at: 3000,
    },
    activity: { status: 'idle' },
  };
}

function page(items: V2Session[], hasMore: boolean, nextToken: string | null): V2SessionsPage {
  return { items, hasMore, nextPageToken: hasMore ? nextToken : null, total: items.length };
}

/** Minimal pooled AppSession shape: archive reads id / updatedAt /
 *  workspaceIdForSession fields. */
function pooledSession(id: string) {
  return {
    id,
    workspaceId: 'ws1',
    cwd: '/repo/ws1',
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    archived: false,
  };
}

interface SetupOptions {
  pages?: V2SessionsPage[];
  pooled?: ReturnType<typeof pooledSession>[];
}

function createState({ pages = [], pooled = [] }: SetupOptions = {}) {
  const listSessionsV2 = vi.fn();
  for (const p of pages) listSessionsV2.mockResolvedValueOnce(p);
  listSessionsV2.mockResolvedValue(page([], false, null));
  const archiveSessionMock = vi.fn().mockResolvedValue({ archived: true });
  const restoreSessionMock = vi.fn().mockImplementation((id: string) =>
    Promise.resolve({ ...pooledSession(id), title: `title-${id}` }),
  );
  getKimiWebApiMock.mockReturnValue({
    listSessionsV2,
    archiveSession: archiveSessionMock,
    restoreSession: restoreSessionMock,
  });

  const rawState = {
    sessions: [...pooled],
    doneSessions: [] as Array<Record<string, unknown>>,
    doneSessionsNextPageToken: null as string | null,
    doneSessionsHasMore: true,
    doneSessionsLoading: false,
    doneSessionsLoadingMore: false,
    doneSessionsSeeded: false,
    sessionsCursorByWorkspace: {} as Record<string, string | undefined>,
    // No further pages → the archive backfill is a no-op in these tests.
    sessionsHasMoreByWorkspace: { ws1: false } as Record<string, boolean>,
    sessionsLoadingMoreByWorkspace: {} as Record<string, boolean>,
    sideChatUserMessageIdsBySession: {},
    activeSessionId: undefined as string | undefined,
  };
  const deps = {
    setSessions: (next: typeof rawState.sessions) => {
      rawState.sessions = next;
    },
    upsertSessionSorted: (s: (typeof rawState.sessions)[number]) => {
      rawState.sessions = [s, ...rawState.sessions.filter((x) => x.id !== s.id)];
    },
    forgetSession: (id: string) => {
      rawState.sessions = rawState.sessions.filter((s) => s.id !== id);
    },
    setActiveSessionId: (id: string | undefined) => {
      rawState.activeSessionId = id;
    },
    workspaceIdForSession: (s: { workspaceId?: string; cwd: string }) => s.workspaceId ?? s.cwd,
    sideChat: { clearSideChatForSession: vi.fn() },
    pushOperationFailure: vi.fn(),
  };
  return {
    rawState,
    listSessionsV2,
    archiveSessionMock,
    restoreSessionMock,
    ws: useWorkspaceState(rawState as never, deps as never),
  };
}

describe('done sessions (status view 已完成 tab)', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
  });

  it('ensureDoneSessions seeds the first page with the archived filter', async () => {
    const { rawState, listSessionsV2, ws } = createState({
      pages: [page([v2Done('d1'), v2Done('d2'), v2Done('e1', { empty: true })], true, 'tok1')],
    });

    await ws.ensureDoneSessions();

    expect(listSessionsV2).toHaveBeenCalledTimes(1);
    expect(listSessionsV2).toHaveBeenCalledWith({
      pageSize: 50,
      include: 'git',
      archived: true,
    });
    // Empty sessions (no last_prompt) are filtered on entry.
    expect(rawState.doneSessions.map((s) => s.id)).toEqual(['d1', 'd2']);
    expect(rawState.doneSessions[0]).toMatchObject({ archived: true });
    expect(rawState.doneSessionsNextPageToken).toBe('tok1');
    expect(rawState.doneSessionsSeeded).toBe(true);

    // Idempotent: a second call is a no-op.
    await ws.ensureDoneSessions();
    expect(listSessionsV2).toHaveBeenCalledTimes(1);
  });

  it('loadMoreDoneSessions appends the next page, de-duped, cursor forwarded', async () => {
    const { rawState, listSessionsV2, ws } = createState({
      pages: [
        page([v2Done('d1')], true, 'tok1'),
        page([v2Done('d1'), v2Done('d2')], false, null),
      ],
    });

    await ws.ensureDoneSessions();
    await ws.loadMoreDoneSessions();

    expect(listSessionsV2).toHaveBeenCalledTimes(2);
    expect(listSessionsV2).toHaveBeenLastCalledWith({
      pageSize: 50,
      pageToken: 'tok1',
      include: 'git',
      archived: true,
    });
    expect(rawState.doneSessions.map((s) => s.id)).toEqual(['d1', 'd2']);
    expect(rawState.doneSessionsHasMore).toBe(false);
  });

  it('loadMoreDoneSessions keeps paging past all-filtered pages until visible rows land', async () => {
    const { rawState, listSessionsV2, ws } = createState({
      pages: [
        page([v2Done('d1')], true, 'tok1'),
        // Second page: only an empty-prompt row — filtered out, cursor advances.
        page([v2Done('e1', { empty: true })], true, 'tok2'),
        page([v2Done('d2')], false, null),
      ],
    });

    await ws.ensureDoneSessions();
    await ws.loadMoreDoneSessions();

    expect(listSessionsV2).toHaveBeenCalledTimes(3);
    expect(listSessionsV2).toHaveBeenLastCalledWith({
      pageSize: 50,
      pageToken: 'tok2',
      include: 'git',
      archived: true,
    });
    expect(rawState.doneSessions.map((s) => s.id)).toEqual(['d1', 'd2']);
    expect(rawState.doneSessionsHasMore).toBe(false);
  });

  it('archiveSession moves the session into the done list (front) and out of the pool', async () => {
    const { rawState, ws } = createState({ pooled: [pooledSession('s1'), pooledSession('s2')] });

    await ws.archiveSession('s1');

    expect(rawState.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(rawState.doneSessions.map((s) => s.id)).toEqual(['s1']);
    expect(rawState.doneSessions[0]).toMatchObject({ archived: true });
    expect(typeof (rawState.doneSessions[0] as { archivedAt?: unknown }).archivedAt).toBe('string');
  });

  it('restoreSession removes the session from the done list', async () => {
    const { rawState, ws } = createState({ pooled: [pooledSession('s1')] });
    await ws.archiveSession('s1');
    expect(rawState.doneSessions.map((s) => s.id)).toEqual(['s1']);

    const ok = await ws.restoreSession('s1');

    expect(ok).toBe(true);
    expect(rawState.doneSessions).toEqual([]);
    expect(rawState.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('applySessionsArchivedLocally archives ids: pool removal + done-list insert (front)', async () => {
    const { rawState, ws } = createState({
      pooled: [pooledSession('s1'), pooledSession('s2'), pooledSession('s3')],
    });

    await ws.applySessionsArchivedLocally(['s1', 's3'], true);

    expect(rawState.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(rawState.doneSessions.map((s) => s.id)).toEqual(['s1', 's3']);
    expect(rawState.doneSessions[0]).toMatchObject({ archived: true });
    expect(typeof (rawState.doneSessions[0] as { archivedAt?: unknown }).archivedAt).toBe('string');
  });

  it('applySessionsArchivedLocally clears the active session when it gets archived', async () => {
    const { rawState, ws } = createState({ pooled: [pooledSession('s1')] });
    rawState.activeSessionId = 's1';

    await ws.applySessionsArchivedLocally(['s1'], true);

    expect(rawState.activeSessionId).toBeUndefined();
    expect(rawState.sessions).toEqual([]);
  });

  it('applySessionsArchivedLocally restores ids from done-list copies back into the pool', async () => {
    const { rawState, ws } = createState({ pooled: [pooledSession('s1'), pooledSession('s2')] });
    await ws.archiveSession('s1');
    expect(rawState.doneSessions.map((s) => s.id)).toEqual(['s1']);

    await ws.applySessionsArchivedLocally(['s1'], false);

    expect(rawState.doneSessions).toEqual([]);
    expect(rawState.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(rawState.sessions[0]).toMatchObject({ archived: false });
  });
});
