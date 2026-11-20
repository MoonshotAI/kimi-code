import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig, AppSession, KimiWebApi, ReadRequestOptions, SessionsPage } from '@moonshot-ai/app-core/api';
import { connectionStore } from '../src/stores/connection';
import { workspacesStore } from '../src/stores/workspaces';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { configStore } from '../src/stores/config';
import { sessionListStore, setSessionListHooks } from '../src/stores/sessionList';
import { sessionsStore } from '../src/stores/sessions';

function makeSession(id: string, updatedAt: string): AppSession {
  return { id, title: `Session ${id}`, createdAt: updatedAt, updatedAt, cwd: '/workspace' } as AppSession;
}

beforeEach(() => {
  sessionListStore().resetSessionList();
  sessionsStore().setSessions([]);
  configStore().resetConfig();
});

describe('sessionListStore pagination state', () => {
  it('starts with the defaults the facade rawState used to initialize', () => {
    const store = sessionListStore();
    expect(store.sessionsFullyLoaded).toBe(false);
    expect(store.flatSessionsNextPageToken).toBeNull();
    expect(store.flatSessionsHasMore).toBe(true);
    expect(store.flatSessionsLoading).toBe(false);
    expect(store.flatSessionsLoadingMore).toBe(false);
    expect(store.flatSessionsSeeded).toBe(false);
    expect(store.doneSessions).toEqual([]);
    expect(store.doneSessionsNextPageToken).toBeNull();
    expect(store.doneSessionsHasMore).toBe(true);
    expect(store.doneSessionsLoading).toBe(false);
    expect(store.doneSessionsLoadingMore).toBe(false);
    expect(store.doneSessionsSeeded).toBe(false);
  });
});

describe('sessionListStore tombstones', () => {
  it('add / has / clear archive tombstones', () => {
    const store = sessionListStore();
    expect(store.hasArchiveTombstone('a')).toBe(false);
    store.addArchiveTombstone('a');
    expect(store.hasArchiveTombstone('a')).toBe(true);
    store.clearArchiveTombstone('a');
    expect(store.hasArchiveTombstone('a')).toBe(false);
  });

  it('caps archive tombstones at 500 with oldest-first eviction', () => {
    const store = sessionListStore();
    for (let i = 0; i < 500; i++) store.addArchiveTombstone(`s${i}`);
    store.addArchiveTombstone('s500');
    expect(store.hasArchiveTombstone('s0')).toBe(false);
    expect(store.hasArchiveTombstone('s1')).toBe(true);
    expect(store.hasArchiveTombstone('s500')).toBe(true);
    store.addArchiveTombstone('s500');
    expect(store.hasArchiveTombstone('s1')).toBe(true);
  });

  it('caps deleted tombstones at 500 with oldest-first eviction', () => {
    const store = sessionListStore();
    for (let i = 0; i < 500; i++) store.addDeletedTombstone(`s${i}`);
    store.addDeletedTombstone('s500');
    expect(store.hasDeletedTombstone('s0')).toBe(false);
    expect(store.hasDeletedTombstone('s500')).toBe(true);
  });

  it('markRestoredRecently records a timestamp and clearRestoredRecently clears both markers', () => {
    const store = sessionListStore();
    store.addRestoredRecently('a');
    store.markRestoredRecently('a');
    expect(store.hasRestoredRecently('a')).toBe(true);
    expect(store.restoredAt('a')).toBeTypeOf('number');
    store.clearRestoredRecently('a');
    expect(store.hasRestoredRecently('a')).toBe(false);
    expect(store.restoredAt('a')).toBeUndefined();
  });

  it('caps restored-recently markers at 500 with oldest-first eviction', () => {
    const store = sessionListStore();
    for (let i = 0; i < 500; i++) store.addRestoredRecently(`s${i}`);
    store.addRestoredRecently('s500');
    expect(store.hasRestoredRecently('s0')).toBe(false);
    expect(store.hasRestoredRecently('s500')).toBe(true);
  });

  it('tombstonesEmpty reflects both tombstone sets', () => {
    const store = sessionListStore();
    expect(store.tombstonesEmpty()).toBe(true);
    store.addArchiveTombstone('a');
    expect(store.tombstonesEmpty()).toBe(false);
    store.clearArchiveTombstone('a');
    store.addDeletedTombstone('b');
    expect(store.tombstonesEmpty()).toBe(false);
  });

  it('resetSessionList restores defaults and clears bookkeeping', () => {
    const store = sessionListStore();
    store.sessionsFullyLoaded = true;
    store.flatSessionsSeeded = true;
    store.doneSessions = [makeSession('a', '2026-01-01T00:00:00.000Z')];
    store.doneSessionsSeeded = true;
    store.addArchiveTombstone('a');
    store.addDeletedTombstone('b');
    store.addRestoredRecently('c');
    store.markRestoredRecently('c');
    store.resetSessionList();
    expect(store.sessionsFullyLoaded).toBe(false);
    expect(store.flatSessionsSeeded).toBe(false);
    expect(store.doneSessions).toEqual([]);
    expect(store.doneSessionsSeeded).toBe(false);
    expect(store.tombstonesEmpty()).toBe(true);
    expect(store.hasRestoredRecently('c')).toBe(false);
    expect(store.restoredAt('c')).toBeUndefined();
  });
});


describe('sessionListStore title domain', () => {
  const apiMock: Record<string, unknown> = {};
  const notifyMock = vi.fn();
  const failureMock = vi.fn();

  beforeEach(() => {
    setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: (key) => key });
    setSessionListHooks({
      pushOperationFailure: failureMock,
      notify: notifyMock,
    });
    configStore().config = {} as AppConfig;
  });

  afterEach(() => {
    resetKimiClientDeps();
    setSessionListHooks(null);
  });

  it('maybeGenerateSessionTitle fires once and marks done on success', async () => {
    const generateSessionTitle = vi.fn().mockResolvedValue('Generated');
    apiMock.generateSessionTitle = generateSessionTitle;
    const store = sessionListStore();

    store.maybeGenerateSessionTitle('a');
    await vi.waitFor(() => expect(generateSessionTitle).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    store.maybeGenerateSessionTitle('a');
    store.maybeGenerateSessionTitle('a');
    expect(generateSessionTitle).toHaveBeenCalledTimes(1);
    expect(generateSessionTitle).toHaveBeenCalledWith('a', { source: 'first_turn' });
  });

  it('maybeGenerateSessionTitle caps attempts at three when the title never lands', async () => {
    const generateSessionTitle = vi.fn().mockResolvedValue(null);
    apiMock.generateSessionTitle = generateSessionTitle;
    const store = sessionListStore();

    for (let i = 0; i < 5; i++) store.maybeGenerateSessionTitle('a');
    await vi.waitFor(() => expect(generateSessionTitle).toHaveBeenCalledTimes(3));

    store.maybeGenerateSessionTitle('a');
    expect(generateSessionTitle).toHaveBeenCalledTimes(3);
  });

  it('maybeGenerateSessionTitle skips the API call when auto title is off', async () => {
    const generateSessionTitle = vi.fn().mockResolvedValue('Generated');
    apiMock.generateSessionTitle = generateSessionTitle;
    configStore().config = { autoSessionTitle: false } as AppConfig;
    sessionListStore().maybeGenerateSessionTitle('a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(generateSessionTitle).not.toHaveBeenCalled();
  });

  it('maybeGenerateSessionTitle skips the API call when config is not loaded', async () => {
    const generateSessionTitle = vi.fn().mockResolvedValue('Generated');
    apiMock.generateSessionTitle = generateSessionTitle;
    configStore().resetConfig();
    sessionListStore().maybeGenerateSessionTitle('a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(generateSessionTitle).not.toHaveBeenCalled();
  });

  it('renameSession updates the pool row and the done-list copy', async () => {
    apiMock.updateSession = vi.fn().mockResolvedValue({});
    sessionsStore().setSessions([makeSession('a', '2026-01-01T00:00:00.000Z')]);
    sessionListStore().doneSessions = [makeSession('a', '2026-01-01T00:00:00.000Z')];

    await sessionListStore().renameSession('a', 'renamed');

    expect(sessionsStore().sessions[0]!.title).toBe('renamed');
    expect(sessionListStore().doneSessions[0]!.title).toBe('renamed');
    expect(apiMock.updateSession).toHaveBeenCalledWith('a', { title: 'renamed' });
  });

  it('renameSession surfaces failures via pushOperationFailure', async () => {
    apiMock.updateSession = vi.fn().mockRejectedValue(new Error('boom'));

    await sessionListStore().renameSession('a', 'renamed');

    expect(failureMock).toHaveBeenCalledWith('renameSession', expect.any(Error), { sessionId: 'a' });
  });

  it('regenerateSessionTitle returns the title and syncs the done-list copy', async () => {
    apiMock.generateSessionTitle = vi.fn().mockResolvedValue('Digested');
    sessionListStore().doneSessions = [makeSession('a', '2026-01-01T00:00:00.000Z')];

    const title = await sessionListStore().regenerateSessionTitle('a');

    expect(title).toBe('Digested');
    expect(sessionListStore().doneSessions[0]!.title).toBe('Digested');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('regenerateSessionTitle notifies when the digest is unavailable', async () => {
    apiMock.generateSessionTitle = vi.fn().mockResolvedValue(null);

    const title = await sessionListStore().regenerateSessionTitle('a');

    expect(title).toBeNull();
    expect(notifyMock).toHaveBeenCalledWith({ severity: 'info', title: 'sidebar.genTitleUnavailable' });
  });
});

describe('sessionListStore cancellable background reads', () => {
  const getSession = vi.fn<(id: string, options?: ReadRequestOptions) => Promise<AppSession>>();
  const listSessions = vi.fn<(input?: unknown, options?: ReadRequestOptions) => Promise<SessionsPage>>();
  const listSessionGroups = vi.fn();
  const failure = vi.fn();

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  function row(id: string): AppSession {
    return {
      ...makeSession(id, '1970-01-01T00:00:00.001Z'),
      workspaceId: 'ws1',
      lastPrompt: 'prompt',
      busy: false,
      archived: false,
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

  function page(id: string): SessionsPage {
    return { items: [row(id)], hasMore: false, nextPageToken: null, total: 1 };
  }

  beforeEach(() => {
    getSession.mockReset();
    listSessions.mockReset();
    listSessionGroups.mockReset();
    failure.mockClear();
    sessionsStore().setActiveSessionId('active');
    connectionStore().eventCountBySession.clear();
    workspacesStore().workspaces = [{ id: 'ws1', root: '/workspace', name: 'workspace', sessionCount: 1 }];
    setKimiClientDeps({ api: () => ({ getSession, listSessions, listSessionGroups }) as unknown as KimiWebApi, t: (key) => key });
    setSessionListHooks({ pushOperationFailure: failure });
  });

  afterEach(() => {
    sessionListStore().cancelBackgroundReads();
    resetKimiClientDeps();
    setSessionListHooks(null);
  });

  it('defaults non-current hydration to background but keeps current hydration in the foreground', async () => {
    const store = sessionListStore();
    getSession.mockResolvedValue({ ...makeSession('other', '2026-01-01'), busy: false });
    await store.hydrateLiveSession('other');
    await store.hydrateLiveSession('active');

    expect(getSession).toHaveBeenNthCalledWith(1, 'other', { background: true, signal: expect.any(AbortSignal) });
    expect(getSession).toHaveBeenNthCalledWith(2, 'active', { background: false, signal: expect.any(AbortSignal) });
  });

  it('propagates cancellation and drops a late hydration merge even when the transport ignores abort', async () => {
    const pending = deferred<AppSession>();
    getSession.mockReturnValue(pending.promise);
    sessionsStore().setSessions([{ ...makeSession('other', '2026-01-01'), busy: true }]);
    const controller = new AbortController();
    const hydration = sessionListStore().hydrateLiveSession('other', { background: true, signal: controller.signal });
    const signal = getSession.mock.calls[0]![1]!.signal!;
    controller.abort();
    expect(signal.aborted).toBe(true);
    pending.resolve({ ...makeSession('other', '2026-01-01'), busy: false });
    await hydration;
    expect(sessionsStore().sessions[0]!.busy).toBe(true);
  });

  it('aborts only a deleted session and never removes its newer hydration controller from an older finally', async () => {
    const old = deferred<AppSession>();
    const current = deferred<AppSession>();
    const other = deferred<AppSession>();
    getSession.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockReturnValueOnce(other.promise);
    const store = sessionListStore();
    sessionsStore().setSessions([
      { ...makeSession('a', '2026-01-01'), busy: true },
      { ...makeSession('b', '2026-01-01'), busy: true },
    ]);
    const oldHydration = store.hydrateLiveSession('a');
    const currentHydration = store.hydrateLiveSession('a');
    const otherHydration = store.hydrateLiveSession('b');
    expect(getSession.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    old.resolve({ ...makeSession('a', '2026-01-01'), busy: false });
    await oldHydration;
    store.noteSessionDeleted('a');
    expect(getSession.mock.calls[1]![1]!.signal!.aborted).toBe(true);
    expect(getSession.mock.calls[2]![1]!.signal!.aborted).toBe(false);
    current.resolve({ ...makeSession('a', '2026-01-01'), busy: false });
    other.resolve({ ...makeSession('b', '2026-01-01'), busy: false });
    await Promise.all([currentHydration, otherHydration]);
    expect(sessionsStore().sessions.find((s) => s.id === 'a')!.busy).toBe(true);
    expect(sessionsStore().sessions.find((s) => s.id === 'b')!.busy).toBe(false);
  });

  it('keeps event-fresh activity over a stale background hydration', async () => {
    const pending = deferred<AppSession>();
    getSession.mockReturnValue(pending.promise);
    sessionsStore().setSessions([{ ...makeSession('other', '2026-01-01'), busy: true }]);
    const hydration = sessionListStore().hydrateLiveSession('other');
    connectionStore().noteSessionEvent('other');
    pending.resolve({ ...makeSession('other', '2026-01-01'), busy: false });
    await hydration;
    expect(sessionsStore().sessions[0]!.busy).toBe(true);
  });

  it('cancels flat and archived reads on reset without stale rows, cursors, seeded flags or loading resets', async () => {
    const oldFlat = deferred<SessionsPage>();
    const oldDone = deferred<SessionsPage>();
    const newFlat = deferred<SessionsPage>();
    const newDone = deferred<SessionsPage>();
    listSessions.mockReturnValueOnce(oldFlat.promise).mockReturnValueOnce(oldDone.promise)
      .mockReturnValueOnce(newFlat.promise).mockReturnValueOnce(newDone.promise);
    const store = sessionListStore();
    const first = [store.ensureFlatSessions(), store.ensureDoneSessions()];
    store.resetSessionList();
    const second = [store.ensureFlatSessions(), store.ensureDoneSessions()];
    expect(listSessions.mock.calls.slice(0, 2).every(([, options]) => options?.signal?.aborted)).toBe(true);
    expect(listSessions.mock.calls.every(([, options]) => options?.background === true)).toBe(true);

    oldFlat.resolve({ ...page('stale-flat'), nextPageToken: 'stale-token', hasMore: true });
    oldDone.resolve({ ...page('stale-done'), items: [{ ...row('stale-done'), archived: true }] });
    await Promise.all(first);
    expect(sessionsStore().sessions).toEqual([]);
    expect(store.doneSessions).toEqual([]);
    expect(store.flatSessionsNextPageToken).toBeNull();
    expect(store.flatSessionsLoading).toBe(true);
    expect(store.doneSessionsLoading).toBe(true);
    expect(store.flatSessionsSeeded).toBe(false);
    expect(store.doneSessionsSeeded).toBe(false);
    expect(failure).not.toHaveBeenCalled();

    newFlat.resolve(page('fresh-flat'));
    newDone.resolve({ ...page('fresh-done'), items: [{ ...row('fresh-done'), archived: true }] });
    await Promise.all(second);
    expect(sessionsStore().sessions.map((s) => s.id)).toEqual(['fresh-flat']);
    expect(store.doneSessions.map((s) => s.id)).toEqual(['fresh-done']);
    expect(store.flatSessionsSeeded).toBe(true);
    expect(store.doneSessionsSeeded).toBe(true);
    expect(store.flatSessionsLoading).toBe(false);
    expect(store.doneSessionsLoading).toBe(false);
  });

  it.each(['flat', 'done'] as const)('drops aborted %s pagination failures without retries or warnings', async (kind) => {
    const pending = deferred<SessionsPage>();
    const store = sessionListStore();
    store.flatSessionsSeeded = true;
    store.doneSessionsSeeded = true;
    store.flatSessionsNextPageToken = 'flat';
    store.doneSessionsNextPageToken = 'done';
    listSessions.mockReturnValue(pending.promise);
    const load = kind === 'flat' ? store.loadMoreFlatSessions() : store.loadMoreDoneSessions();
    store.resetSessionList();
    pending.reject(new Error('late transport error'));
    await load;
    expect(listSessions).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    expect(store.flatSessionsNextPageToken).toBeNull();
    expect(store.doneSessionsNextPageToken).toBeNull();
  });

  it('preserves hydrated first-page activity when the remaining groups commit without rehydrating it again', async () => {
    const later = deferred<unknown>();
    listSessionGroups.mockResolvedValueOnce({
      groups: [{ workspaceId: 'ws1', sessions: [{ ...row('active'), busy: true }], total: 1 }],
      hasMore: true,
      nextPageToken: 'later',
      total: 2,
    }).mockReturnValueOnce(later.promise);
    const store = sessionListStore();
    const initial = await store.loadInitialSessionsByWorkspace(store.fireFirstSessionGroupPage());
    store.setSessionsPreservingLiveUsage(initial!.sessions);
    getSession.mockResolvedValue({ ...makeSession('active', '2026-01-01'), busy: false, mainTurnActive: false });
    await store.hydrateLiveSession('active');
    const finish = initial!.finishInBackground!();
    later.resolve({ groups: [], hasMore: false, nextPageToken: null, total: 1 });
    await finish;
    expect(sessionsStore().sessions[0]).toMatchObject({ id: 'active', busy: false, mainTurnActive: false });
    expect(getSession).toHaveBeenCalledOnce();
  });

  it('does not borrow pagination from a sibling project with the same root', async () => {
    workspacesStore().workspaces = [
      { id: 'ws1', root: '/workspace', name: 'one', sessionCount: 2 },
      { id: 'ws2', root: '/workspace', name: 'two', sessionCount: 0 },
    ];
    listSessionGroups.mockResolvedValueOnce({
      groups: [{ workspaceId: 'ws1', sessions: [row('first')], total: 2 }],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });

    const initial = await sessionListStore().loadInitialSessionsByWorkspace(
      sessionListStore().fireFirstSessionGroupPage(),
    );

    expect(initial!.sessions.map((session) => session.id)).toEqual(['first']);
    expect(workspacesStore().sessionsHasMoreByWorkspace).toMatchObject({ ws1: true, ws2: false });
    expect(workspacesStore().sessionsCursorByWorkspace).toMatchObject({ ws1: 'first', ws2: undefined });
  });

  it('keeps verified Windows aliases in the selected group across pages and restore events', async () => {
    const workspace = workspacesStore();
    const list = sessionListStore();
    const primary = 'wd_c.repo_current';
    const alias = 'wd_c.repo_legacy';
    const other = 'wm_independent';
    const root = 'C:\\Repo';
    workspace.workspaces = [
      { id: primary, root, name: 'project', sessionCount: 3 },
      { id: other, root, name: 'independent', sessionCount: 1 },
    ];
    const item = (id: string, workspaceId: string) => ({ ...row(id), cwd: 'c:/repo', workspaceId });
    listSessionGroups.mockResolvedValueOnce({
      groups: [
        { workspaceId: primary, sessions: [item('first', primary)], total: 3 },
        { workspaceId: other, sessions: [item('separate', other)], total: 1 },
      ],
      hasMore: false, nextPageToken: null, total: 2,
    });
    const initial = await list.loadInitialSessionsByWorkspace(list.fireFirstSessionGroupPage());
    list.setSessionsPreservingLiveUsage(initial!.sessions);
    listSessions.mockResolvedValueOnce({ items: [item('second', alias)], hasMore: true, nextPageToken: null, total: 3 });
    await list.loadMoreSessions(primary);
    expect(listSessions).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: primary, beforeId: 'first' }));
    expect(list.loadedInWorkspace(primary).map((session) => session.id)).toEqual(['first', 'second']);
    listSessions.mockResolvedValueOnce({ items: [item('first', primary), item('second', alias), item('third', alias)], hasMore: false, nextPageToken: null, total: 3 });
    await list.loadFirstWorkspacePage(primary);
    expect(list.loadedInWorkspace(primary).map((session) => session.id)).toEqual(['first', 'second', 'third']);

    getSession.mockResolvedValueOnce(item('restored', alias));
    await list.applyRemoteSessionRestored('restored');
    expect(list.loadedInWorkspace(primary).map((session) => session.id)).toContain('restored');
    expect(list.loadedInWorkspace(other).map((session) => session.id)).toEqual(['separate']);
    expect(workspace.mergedWorkspaces.map((project) => project.id)).toEqual([primary, other]);
    expect(workspace.sessionBelongsToWorkspace(item('live', alias), primary)).toBe(true);
    expect(workspace.sessionBelongsToWorkspace(item('live', alias), other)).toBe(false);
    expect(workspace.sessionBelongsToWorkspace({ ...item('foreign', alias), hostId: 'another-host' }, primary)).toBe(false);

    setSessionListHooks({
      pushOperationFailure: failure,
      onSessionsArchivedLocally: async (ids) => {
        for (const id of ids) sessionsStore().removeSession(id);
      },
    });
    workspace.setSessionHasMore(primary, true);
    listSessions.mockResolvedValueOnce({ items: [item('backfill', alias)], hasMore: false, nextPageToken: null, total: 3 });
    await list.applyRemoteSessionArchived('second', alias);
    await vi.waitFor(() => expect(list.loadedInWorkspace(primary).map((session) => session.id)).toContain('backfill'));
    expect(listSessions).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: primary, beforeId: 'third' }));
    expect(list.loadedInWorkspace(other).map((session) => session.id)).toEqual(['separate']);
  });

  it.each(['restore', 'archived page'])('asks the session host for an unobserved legacy bucket on its first %s', async (source) => {
    const workspace = workspacesStore();
    const list = sessionListStore();
    const cwd = 'D:\\repo';
    const owner = 'wd_d.repo_current';
    const alias = 'wd_d.repo_legacy';
    workspace.workspaces = [
      { id: owner, root: cwd, name: 'current', sessionCount: 2 },
      { id: 'wm_other', root: cwd, name: 'other', sessionCount: 1 },
      { id: alias, hostId: 'dev', root: cwd, name: 'remote', sessionCount: 1 },
    ];
    const old = { ...row('old'), cwd, workspaceId: alias };
    listSessionGroups.mockResolvedValueOnce({
      groups: [{ workspaceId: owner, sessions: [{ ...row('recent'), cwd, workspaceId: owner }], total: 2 }],
      hasMore: false, nextPageToken: null, total: 1,
    });
    if (source === 'restore') {
      getSession.mockResolvedValueOnce(old);
      await list.applyRemoteSessionRestored('old');
    } else {
      listSessions.mockResolvedValueOnce({ ...page('old'), items: [{ ...old, archived: true }] });
      await list.ensureDoneSessions();
    }
    await vi.waitFor(() => expect(workspace.workspaceIdForSession(old)).toBe(owner));
    expect(listSessionGroups).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceIds: [alias], localOnly: true }),
      expect.objectContaining({ background: true }),
    );
    expect(list.loadedInWorkspace('wm_other')).toEqual([]);
    expect(workspace.workspaceIdForSession({ ...old, hostId: 'dev' })).toBe(alias);
    expect(workspace.mergedWorkspaces.map((project) => project.id)).toEqual([owner, 'wm_other', alias]);
  });

  it('does not assign a different project’s sessions by matching their working directory', async () => {
    listSessionGroups.mockResolvedValueOnce({
      groups: [{
        workspaceId: 'wd_alias',
        sessions: [{ ...row('aliased'), workspaceId: 'wd_alias', cwd: '/workspace' }],
        total: 2,
      }],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });

    const initial = await sessionListStore().loadInitialSessionsByWorkspace(
      sessionListStore().fireFirstSessionGroupPage(),
    );

    expect(initial!.sessions).toEqual([]);
    expect(workspacesStore().sessionsHasMoreByWorkspace).toMatchObject({ ws1: false });
    expect(workspacesStore().sessionsCursorByWorkspace).toMatchObject({ ws1: undefined });
  });

  it('keeps the first grouped page critical and cancels later background pages on a new generation', async () => {
    const later = deferred<unknown>();
    listSessionGroups.mockResolvedValueOnce({
      groups: [{ workspaceId: 'ws1', sessions: [row('first')], total: 1 }],
      hasMore: true,
      nextPageToken: 'later',
      total: 2,
    }).mockReturnValueOnce(later.promise).mockResolvedValueOnce({ groups: [], hasMore: false, nextPageToken: null, total: 0 });
    const store = sessionListStore();
    const initial = await store.loadInitialSessionsByWorkspace(store.fireFirstSessionGroupPage());
    const finish = initial!.finishInBackground!();
    expect(listSessionGroups.mock.calls[0]![1].background).toBeUndefined();
    expect(listSessionGroups.mock.calls[1]![1].background).toBe(true);
    const signal = listSessionGroups.mock.calls[1]![1].signal as AbortSignal;
    const next = store.fireFirstSessionGroupPage();
    expect(signal.aborted).toBe(true);
    later.resolve({ groups: [], hasMore: false, nextPageToken: null, total: 0 });
    await finish;
    await next.firstPage;
    expect(sessionsStore().sessions).toEqual([]);
    expect(failure).not.toHaveBeenCalled();
  });
});

describe('facade bridge (rawState accessors → sessionList store)', () => {
  const clientApiMock: Record<string, unknown> = {};

  beforeEach(() => {
    setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
    clientApiMock.connectEvents = vi.fn(() => ({
      subscribeConversation: vi.fn(),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: false, open: false, stale: false }),
      close: vi.fn(),
    }));
  });

  afterEach(() => {
    resetKimiClientDeps();
  });

  it('facade computeds track store pagination state (read direction)', async () => {
    vi.resetModules();
    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const { sessionListStore: freshSessionListStore } = await import('../src/stores/sessionList');
    const client = useKimiWebClient();

    expect(client.flatSessionsHasMore.value).toBe(true);
    expect(client.flatSessionsLoadingMore.value).toBe(false);

    freshSessionListStore().flatSessionsHasMore = false;
    freshSessionListStore().flatSessionsLoadingMore = true;

    expect(client.flatSessionsHasMore.value).toBe(false);
    expect(client.flatSessionsLoadingMore.value).toBe(true);
  });

  it('facade renameSession writes doneSessions through to the store (write direction)', async () => {
    vi.resetModules();
    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const { sessionListStore: freshSessionListStore } = await import('../src/stores/sessionList');
    const client = useKimiWebClient();

    clientApiMock.updateSession = vi.fn().mockResolvedValue({});
    freshSessionListStore().doneSessions = [makeSession('a', '2026-01-01T00:00:00.000Z')];

    await client.renameSession('a', 'new title');
    expect(freshSessionListStore().doneSessions[0]!.title).toBe('new title');
  });
});
