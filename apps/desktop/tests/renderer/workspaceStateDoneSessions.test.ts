import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetKimiClientDeps,
  setKimiClientDeps,
} from '@moonshot-ai/app-client/client';
import { createWorkspaceRig } from '@moonshot-ai/app-client/testing';
import type { AppSession, SessionsPage } from '@moonshot-ai/app-core/api';
import { sessionListStore, sessionsStore, setSessionListHooks } from '@moonshot-ai/app-client/stores';

const getKimiWebApiMock = vi.fn();

beforeEach(() => {
  getKimiWebApiMock.mockReset();
  setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  sessionListStore().resetSessionList();
});
afterEach(() => {
  resetKimiClientDeps();
});

function doneRow(id: string, opts: { empty?: boolean; ws?: string } = {}): AppSession {
  const ws = opts.ws ?? 'ws1';
  return {
    id,
    workspaceId: ws,
    cwd: `/repo/${ws}`,
    title: `title-${id}`,
    lastPrompt: opts.empty === true ? undefined : `prompt-${id}`,
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(2000).toISOString(),
    busy: false,
    archived: true,
    archivedAt: new Date(3000).toISOString(),
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
  pages?: SessionsPage[];
  pooled?: ReturnType<typeof pooledSession>[];
}

function createState({ pages = [], pooled = [] }: SetupOptions = {}) {
  const listSessions = vi.fn();
  for (const p of pages) listSessions.mockResolvedValueOnce(p);
  listSessions.mockResolvedValue(page([], false, null));
  const archiveSessionMock = vi.fn().mockResolvedValue({ archived: true });
  const restoreSessionMock = vi.fn().mockImplementation((id: string) =>
    Promise.resolve({ ...pooledSession(id), title: `title-${id}` }),
  );
  getKimiWebApiMock.mockReturnValue({
    listSessions,
    archiveSession: archiveSessionMock,
    restoreSession: restoreSessionMock,
    connectEvents: vi.fn(() => ({
      subscribeConversation: vi.fn(),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: false, open: false, stale: false }),
      close: vi.fn(),
    })),
  });

  sessionsStore().setSessions([...pooled] as never);
  const rawState = {
    get sessions() {
      return sessionsStore().sessions;
    },
    set sessions(next: AppSession[]) {
      sessionsStore().setSessions(next as never);
    },
    get doneSessions() {
      return sessionListStore().doneSessions;
    },
    set doneSessions(next: Array<Record<string, unknown>>) {
      sessionListStore().doneSessions = next as never;
    },
    get doneSessionsNextPageToken() {
      return sessionListStore().doneSessionsNextPageToken;
    },
    set doneSessionsNextPageToken(next: string | null) {
      sessionListStore().doneSessionsNextPageToken = next;
    },
    get doneSessionsHasMore() {
      return sessionListStore().doneSessionsHasMore;
    },
    set doneSessionsHasMore(next: boolean) {
      sessionListStore().doneSessionsHasMore = next;
    },
    get doneSessionsLoading() {
      return sessionListStore().doneSessionsLoading;
    },
    set doneSessionsLoading(next: boolean) {
      sessionListStore().doneSessionsLoading = next;
    },
    get doneSessionsLoadingMore() {
      return sessionListStore().doneSessionsLoadingMore;
    },
    set doneSessionsLoadingMore(next: boolean) {
      sessionListStore().doneSessionsLoadingMore = next;
    },
    get doneSessionsSeeded() {
      return sessionListStore().doneSessionsSeeded;
    },
    set doneSessionsSeeded(next: boolean) {
      sessionListStore().doneSessionsSeeded = next;
    },
    sessionsCursorByWorkspace: {} as Record<string, string | undefined>,
    sessionsHasMoreByWorkspace: { ws1: false } as Record<string, boolean>,
    sessionsLoadingMoreByWorkspace: {} as Record<string, boolean>,
    sideChatUserMessageIdsBySession: {},
    activeSessionId: undefined as string | undefined,
  };
  const deps = {
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
  setSessionListHooks({
    pushOperationFailure: vi.fn(),
    onSessionsArchivedLocally: async (ids) => {
      for (const id of ids) sessionsStore().removeSession(id);
      if (rawState.activeSessionId !== undefined && ids.includes(rawState.activeSessionId)) {
        const next = sessionsStore().sessions[0];
        rawState.activeSessionId = next?.id;
      }
    },
  });
  return {
    rawState,
    listSessions,
    archiveSessionMock,
    restoreSessionMock,
    ws: createWorkspaceRig(rawState as never, deps as never),
  };
}

describe('done sessions (status view 已完成 tab)', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
  });

  it('ensureDoneSessions seeds the first page with the archived filter', async () => {
    const { rawState, listSessions, ws } = createState({
      pages: [page([doneRow('d1'), doneRow('d2'), doneRow('e1', { empty: true })], true, 'tok1')],
    });

    await ws.ensureDoneSessions();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledWith({
      pageSize: 50,
      include: 'git',
      archived: true,
    }, { background: true, signal: expect.any(AbortSignal) });
    expect(rawState.doneSessions.map((s) => s.id)).toEqual(['d1', 'd2']);
    expect(rawState.doneSessions[0]).toMatchObject({ archived: true });
    expect(rawState.doneSessionsNextPageToken).toBe('tok1');
    expect(rawState.doneSessionsSeeded).toBe(true);

    await ws.ensureDoneSessions();
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it('loadMoreDoneSessions appends the next page, de-duped, cursor forwarded', async () => {
    const { rawState, listSessions, ws } = createState({
      pages: [
        page([doneRow('d1')], true, 'tok1'),
        page([doneRow('d1'), doneRow('d2')], false, null),
      ],
    });

    await ws.ensureDoneSessions();
    await ws.loadMoreDoneSessions();

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenLastCalledWith({
      pageSize: 50,
      pageToken: 'tok1',
      include: 'git',
      archived: true,
    }, { background: true, signal: expect.any(AbortSignal) });
    expect(rawState.doneSessions.map((s) => s.id)).toEqual(['d1', 'd2']);
    expect(rawState.doneSessionsHasMore).toBe(false);
  });

  it('loadMoreDoneSessions keeps paging past all-filtered pages until visible rows land', async () => {
    const { rawState, listSessions, ws } = createState({
      pages: [
        page([doneRow('d1')], true, 'tok1'),
        page([doneRow('e1', { empty: true })], true, 'tok2'),
        page([doneRow('d2')], false, null),
      ],
    });

    await ws.ensureDoneSessions();
    await ws.loadMoreDoneSessions();

    expect(listSessions).toHaveBeenCalledTimes(3);
    expect(listSessions).toHaveBeenLastCalledWith({
      pageSize: 50,
      pageToken: 'tok2',
      include: 'git',
      archived: true,
    }, { background: true, signal: expect.any(AbortSignal) });
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
    expect(rawState.sessions.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(rawState.sessions[1]).toMatchObject({ archived: false });
  });
});
