import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';

import {
  resetKimiClientDeps,
  setKimiClientDeps,
  useWorkspaceState,
} from '@moonshot-ai/app-client/client';

const getKimiWebApiMock = vi.fn();

beforeEach(() => {
  getKimiWebApiMock.mockReset();
  setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
});
afterEach(() => {
  resetKimiClientDeps();
});

/** Minimal window stub (node env): a live pathname over a tiny history stack.
 *  `land(path)` simulates the browser settling on a history entry after
 *  back/forward — the URL is already `path` when popstate fires. */
function stubWindow(initialPath: string) {
  let current = initialPath;
  const entries: string[] = [initialPath];
  const win = {
    location: {
      get pathname() {
        return current;
      },
    },
    history: {
      pushState: (_state: unknown, _title: string, url: string) => {
        entries.push(url);
        current = url;
      },
      replaceState: (_state: unknown, _title: string, url: string) => {
        entries[entries.length - 1] = url;
        current = url;
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  vi.stubGlobal('window', win);
  return {
    entries,
    path: () => current,
    land: (path: string) => {
      current = path;
    },
  };
}

/** Minimal pooled AppSession shape: selectSession/load read id + workspace
 *  fields; the goal refill reads busy/mainTurnActive; the pool-replace merge
 *  reads usage (placeholder zero-usage keeps the live one). */
function pooledSession(id: string, ws = 'ws1') {
  return {
    id,
    title: `title-${id}`,
    workspaceId: ws,
    cwd: `/repo/${ws}`,
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    archived: false,
    busy: false,
    usage: { contextTokens: 0, contextLimit: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
  };
}

interface SetupOptions {
  initialPath?: string;
  sessions?: Array<ReturnType<typeof pooledSession>>;
  activeSessionId?: string;
}

function createState({ initialPath = '/', sessions = [], activeSessionId }: SetupOptions = {}) {
  const win = stubWindow(initialPath);
  const listSessions = vi.fn().mockResolvedValue({ items: sessions, hasMore: false });
  getKimiWebApiMock.mockReturnValue({
    getAuth: vi.fn().mockResolvedValue({ ready: true, defaultModel: null }),
    getHealth: vi.fn().mockResolvedValue(null),
    getMeta: vi.fn().mockResolvedValue(null),
    getConfig: vi.fn().mockRejectedValue(new Error('no config')),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    getFsHome: vi.fn().mockResolvedValue({ home: '', recentRoots: [] }),
    listSessions,
    getSession: vi.fn().mockRejectedValue(new Error('not found')),
  });

  const rawState = {
    mainView: 'chat' as 'chat' | 'sessionAdmin',
    sessions: [...sessions],
    activeSessionId,
    activeWorkspaceId: sessions.length > 0 ? 'ws1' : null,
    sessionLoading: false,
    loading: false,
    unreadBySession: {} as Record<string, boolean>,
    goalBySession: {} as Record<string, unknown>,
    workspaces: [] as Array<Record<string, unknown>>,
    sessionsHasMoreByWorkspace: {} as Record<string, boolean>,
    sessionsCursorByWorkspace: {} as Record<string, string | undefined>,
    sessionsInitialCountByWorkspace: {} as Record<string, number>,
    sessionsFullyLoaded: false,
    flatSessionsSeeded: false,
    flatSessionsNextPageToken: null as string | null,
    flatSessionsHasMore: true,
    flatSessionsFrontier: null as number | null,
    gitStatusBySession: {} as Record<string, unknown>,
    config: null,
    serverVersion: '',
    availableOpenInApps: [] as string[],
    dangerousBypassAuth: false,
    experimentalFlags: {} as Record<string, boolean>,
    backend: 'v1',
  };
  const deps = {
    taskPoller: { loadTasksForSession: vi.fn() },
    sideChat: { clearSideChatForSession: vi.fn() },
    modelProvider: {
      loadModels: vi.fn().mockResolvedValue(undefined),
      skillsBySession: { value: {} as Record<string, unknown> },
      loadSkillsForSession: vi.fn().mockResolvedValue(undefined),
    },
    pushOperationFailure: vi.fn(),
    notify: vi.fn(),
    activity: computed(() => ({})),
    sessionsKnownEmpty: new Set<string>(),
    setSessions: (next: typeof rawState.sessions) => {
      rawState.sessions = next;
    },
    updateSession: vi.fn(),
    upsertSessionSorted: (s: (typeof rawState.sessions)[number]) => {
      rawState.sessions = [s, ...rawState.sessions.filter((x) => x.id !== s.id)];
    },
    appendSession: (s: (typeof rawState.sessions)[number]) => {
      rawState.sessions = [...rawState.sessions, s];
    },
    forgetSession: (id: string) => {
      rawState.sessions = rawState.sessions.filter((s) => s.id !== id);
    },
    unpinSessions: vi.fn(),
    setActiveSessionId: (id: string | undefined) => {
      rawState.activeSessionId = id;
    },
    updateSessionMessages: vi.fn(),
    nextOptimisticMsgId: vi.fn().mockReturnValue('tmp'),
    getEventConn: () => null,
    syncSessionFromSnapshot: vi.fn().mockResolvedValue('ok'),
    reopenSession: vi.fn().mockResolvedValue('ok'),
    hasLoadedMessages: () => false,
    refreshSessionStatus: vi.fn().mockResolvedValue(undefined),
    refreshSessionGoal: vi.fn().mockResolvedValue(undefined),
    refillSessionGoalOnReload: vi.fn(),
    refreshSessionPlans: vi.fn().mockResolvedValue(undefined),
    settlePlanReviewLocally: vi.fn(),
    persistSessionProfile: vi.fn().mockResolvedValue(true),
    mergedWorkspaces: computed(() => []),
    workspacesView: computed(() => []),
    status: computed(() => ({})),
    workspaceIdForSession: (s: { workspaceId?: string; cwd: string }) => s.workspaceId ?? s.cwd,
    savePermissionToStorage: vi.fn(),
    savePlanModeToStorage: vi.fn(),
    saveSwarmModeToStorage: vi.fn(),
    saveGoalModeToStorage: vi.fn(),
    draftModes: { planMode: false, swarmMode: false, goalMode: false },
    saveUnread: vi.fn(),
    saveActiveWorkspaceToStorage: vi.fn(),
    saveHiddenWorkspacesToStorage: vi.fn(),
    goalErrorMessage: () => undefined,
    initialized: ref(false),
    connectIssue: ref<string | null>(null),
    selectedDiffPath: ref<string | null>(null),
    fileDiffLines: ref<unknown[]>([]),
    fileDiffLoading: ref(false),
    fileDiffTexts: ref(null),
    fileDiffEmptyFile: ref(false),
  };
  return { rawState, win, ws: useWorkspaceState(rawState as never, deps as never) };
}

describe('mainView ↔ URL binding (session admin page)', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('openSessionAdmin flips the main view and pushes /admin/sessions; idempotent', () => {
    const { rawState, win, ws } = createState({
      initialPath: '/sessions/s1',
      sessions: [pooledSession('s1')],
      activeSessionId: 's1',
    });

    ws.openSessionAdmin();

    expect(rawState.mainView).toBe('sessionAdmin');
    expect(win.path()).toBe('/admin/sessions');
    expect(win.entries).toEqual(['/sessions/s1', '/admin/sessions']);

    // Already open: no second history entry.
    ws.openSessionAdmin();
    expect(win.entries).toEqual(['/sessions/s1', '/admin/sessions']);
  });

  it('closeSessionAdmin returns to the chat view and restores the session URL', () => {
    const { rawState, win, ws } = createState({
      initialPath: '/sessions/s1',
      sessions: [pooledSession('s1')],
      activeSessionId: 's1',
    });
    ws.openSessionAdmin();

    ws.closeSessionAdmin();

    expect(rawState.mainView).toBe('chat');
    expect(win.entries).toEqual(['/sessions/s1', '/admin/sessions', '/sessions/s1']);

    // Already closed: no-op.
    ws.closeSessionAdmin();
    expect(win.entries).toHaveLength(3);
  });

  it("closeSessionAdmin falls back to '/' when no session is active", () => {
    const { rawState, win, ws } = createState();
    ws.openSessionAdmin();

    ws.closeSessionAdmin();

    expect(rawState.mainView).toBe('chat');
    expect(win.path()).toBe('/');
  });

  it('suspends session-URL writes while the admin page is open', () => {
    const { rawState, win, ws } = createState({
      initialPath: '/sessions/s1',
      sessions: [pooledSession('s1'), pooledSession('s2')],
      activeSessionId: 's1',
    });
    ws.openSessionAdmin();

    // Programmatic rewrites (archive fallback, workspace removal, …) must not
    // yank /admin/sessions away from the open admin page.
    ws.writeSessionUrl('s2', 'replace');
    ws.writeSessionUrl(undefined, 'push');
    expect(win.path()).toBe('/admin/sessions');
    expect(win.entries).toEqual(['/sessions/s1', '/admin/sessions']);

    // Writes resume once the page closes (rewritten from live state).
    rawState.activeSessionId = 's2';
    ws.closeSessionAdmin();
    expect(win.path()).toBe('/sessions/s2');
  });

  it('selectSession (user navigation) leaves the admin page and pushes the session URL', async () => {
    const { rawState, win, ws } = createState({
      initialPath: '/sessions/s1',
      sessions: [pooledSession('s1'), pooledSession('s2')],
      activeSessionId: 's1',
    });
    ws.openSessionAdmin();

    await ws.selectSession('s2');

    expect(rawState.mainView).toBe('chat');
    expect(rawState.activeSessionId).toBe('s2');
    expect(win.entries).toEqual(['/sessions/s1', '/admin/sessions', '/sessions/s2']);
  });

  it("selectSession with urlMode 'none'/'replace' keeps the admin page open", async () => {
    const { rawState, win, ws } = createState({
      initialPath: '/sessions/s1',
      sessions: [pooledSession('s1'), pooledSession('s2')],
      activeSessionId: 's1',
    });
    ws.openSessionAdmin();

    // popstate-driven select: popstate owns mainView, the URL is already right.
    await ws.selectSession('s2', { urlMode: 'none', skipTrack: true });
    expect(rawState.mainView).toBe('sessionAdmin');
    expect(rawState.activeSessionId).toBe('s2');
    expect(win.path()).toBe('/admin/sessions');

    // Programmatic re-select (archive fallback semantics): also not a navigation.
    await ws.selectSession('s1', { urlMode: 'replace', skipTrack: true });
    expect(rawState.mainView).toBe('sessionAdmin');
    expect(rawState.activeSessionId).toBe('s1');
    expect(win.entries).toEqual(['/sessions/s1', '/admin/sessions']);
  });

  it('popstate into /admin/sessions flips the main view, session untouched', () => {
    const { rawState, win, ws } = createState({
      initialPath: '/sessions/s1',
      sessions: [pooledSession('s1')],
      activeSessionId: 's1',
    });
    ws.bindSessionRoute();

    win.land('/admin/sessions');
    ws.onSessionRoutePopState();

    expect(rawState.mainView).toBe('sessionAdmin');
    expect(rawState.activeSessionId).toBe('s1');
  });

  it('popstate out of the admin page restores the chat view and selects the landed session', async () => {
    const { rawState, win, ws } = createState({
      sessions: [pooledSession('s1'), pooledSession('s2')],
      activeSessionId: 's1',
    });
    win.land('/admin/sessions');
    rawState.mainView = 'sessionAdmin';

    win.land('/sessions/s2');
    ws.onSessionRoutePopState();
    await vi.waitFor(() => expect(rawState.activeSessionId).toBe('s2'));

    expect(rawState.mainView).toBe('chat');
  });

  it("popstate out of the admin page to '/' clears the active session", () => {
    const { rawState, win, ws } = createState({
      sessions: [pooledSession('s1')],
      activeSessionId: 's1',
    });
    win.land('/admin/sessions');
    rawState.mainView = 'sessionAdmin';

    win.land('/');
    ws.onSessionRoutePopState();

    expect(rawState.mainView).toBe('chat');
    expect(rawState.activeSessionId).toBeUndefined();
  });

  it('load() deep link /admin/sessions: opens the admin page, auto-selects in the background, keeps the URL', async () => {
    const { rawState, win, ws } = createState({
      initialPath: '/admin/sessions',
      sessions: [pooledSession('s1'), pooledSession('s2')],
    });

    await ws.load();

    expect(rawState.mainView).toBe('sessionAdmin');
    // The most-recent session loads underneath so closing the page lands on it…
    expect(rawState.activeSessionId).toBe('s1');
    // …but the address bar stays on the admin deep link (no push, no replace).
    expect(win.path()).toBe('/admin/sessions');
    expect(win.entries).toEqual(['/admin/sessions']);
  });

  it('load() deep link /sessions/<id> still opens that session (regression)', async () => {
    const { rawState, win, ws } = createState({
      initialPath: '/sessions/s2',
      sessions: [pooledSession('s1'), pooledSession('s2')],
    });

    await ws.load();

    expect(rawState.mainView).toBe('chat');
    expect(rawState.activeSessionId).toBe('s2');
    expect(win.path()).toBe('/sessions/s2');
    expect(win.entries).toEqual(['/sessions/s2']);
  });

  it("load() '/' auto-selects the most-recent session with a URL replace (regression)", async () => {
    const { rawState, win, ws } = createState({
      initialPath: '/',
      sessions: [pooledSession('s1'), pooledSession('s2')],
    });

    await ws.load();

    expect(rawState.mainView).toBe('chat');
    expect(rawState.activeSessionId).toBe('s1');
    expect(win.entries).toEqual(['/sessions/s1']);
  });
});
