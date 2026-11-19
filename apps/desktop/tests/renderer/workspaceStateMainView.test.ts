import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';

import type { AppSession } from '@moonshot-ai/app-core/api';
import { sessionsStore } from '@moonshot-ai/app-client/stores';
import {
  resetKimiClientDeps,
  setKimiClientDeps,
} from '@moonshot-ai/app-client/client';
import { createWorkspaceRig } from '@moonshot-ai/app-client/testing';

const getKimiWebApiMock = vi.fn();

beforeEach(() => {
  getKimiWebApiMock.mockReset();
  sessionsStore().setSessions([]);
  sessionsStore().setActiveSessionId(undefined);
  setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
});
afterEach(() => {
  resetKimiClientDeps();
});

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

function pooledSession(id: string, ws = 'ws1') {
  return {
    id,
    title: `title-${id}`,
    createdAt: new Date(1_700_000_000_000).toISOString(),
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    workspaceId: ws,
    cwd: `/repo/${ws}`,
    archived: false,
    busy: false,
    model: 'kimi',
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

interface SetupOptions {
  initialPath?: string;
  sessions?: Array<ReturnType<typeof pooledSession>>;
  activeSessionId?: string;
}

function createState({ initialPath = '/', sessions = [], activeSessionId }: SetupOptions = {}) {
  const win = stubWindow(initialPath);
  const listSessions = vi.fn().mockResolvedValue({ items: sessions, hasMore: false });
  getKimiWebApiMock.mockReturnValue({
    getAuth: vi.fn().mockResolvedValue({ modelsReady: true, providersCount: 0, managedProvider: null }),
    getHealth: vi.fn().mockResolvedValue(null),
    getMeta: vi.fn().mockResolvedValue(null),
    getConfig: vi.fn().mockRejectedValue(new Error('no config')),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    getFsHome: vi.fn().mockResolvedValue({ home: '', recentRoots: [] }),
    listSessions,
    getSession: vi.fn().mockRejectedValue(new Error('not found')),
    connectEvents: vi.fn(() => ({
      subscribeConversation: vi.fn(),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: false, open: false, stale: false }),
      close: vi.fn(),
    })),
  });

  const rawState = {
    mainView: 'chat' as 'chat' | 'sessionAdmin',
    get sessions() {
      return sessionsStore().sessions;
    },
    set sessions(next: AppSession[]) {
      sessionsStore().setSessions(next);
    },
    get activeSessionId() {
      return sessionsStore().activeSessionId;
    },
    set activeSessionId(next: string | undefined) {
      sessionsStore().setActiveSessionId(next);
    },
    activeWorkspaceId: sessions.length > 0 ? 'ws1' : null,
    sessionLoading: false,
    loading: false,
    goalBySession: {} as Record<string, unknown>,
    workspaces: [] as Array<Record<string, unknown>>,
    sessionsHasMoreByWorkspace: {} as Record<string, boolean>,
    sessionsCursorByWorkspace: {} as Record<string, string | undefined>,
    sessionsInitialCountByWorkspace: {} as Record<string, number>,
    sessionsFullyLoaded: false,
    flatSessionsSeeded: false,
    flatSessionsNextPageToken: null as string | null,
    flatSessionsHasMore: true,
    gitStatusBySession: {} as Record<string, unknown>,
    config: null,
    serverVersion: '',
    availableOpenInApps: [] as string[],
    dangerousBypassAuth: false,
    experimentalFlags: {} as Record<string, boolean>,
    backend: 'v1',
  };
  sessionsStore().setSessions([...sessions]);
  sessionsStore().setActiveSessionId(activeSessionId);
  const deps = {
    sideChat: { clearSideChatForSession: vi.fn() },
    modelProvider: {
      loadModels: vi.fn().mockResolvedValue(undefined),
      skillsBySession: { value: {} as Record<string, unknown> },
      loadSkillsForSession: vi.fn().mockResolvedValue(undefined),
    },
    pushOperationFailure: vi.fn(),
    notify: vi.fn(),
    activity: computed(() => ({})),
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
    noteSessionWatermark: vi.fn(),
    refreshMainTranscript: vi.fn().mockResolvedValue(undefined),
    hasLoadedMessages: () => false,
    markSessionStatusSettled: vi.fn(),
    persistSessionProfile: vi.fn().mockResolvedValue(true),
    mergedWorkspaces: computed(() => []),
    workspacesView: computed(() => []),
    workspaceIdForSession: (s: { workspaceId?: string; cwd: string }) => s.workspaceId ?? s.cwd,
    saveActiveWorkspaceToStorage: vi.fn(),
    saveHiddenWorkspacesToStorage: vi.fn(),
    initialized: ref(false),
    bootStage: ref('auth'),
    bootRetries: ref(0),
    connectIssue: ref<string | null>(null),
    selectedDiffPath: ref<string | null>(null),
    fileDiffLines: ref<unknown[]>([]),
    fileDiffLoading: ref(false),
    fileDiffTexts: ref(null),
    fileDiffEmptyFile: ref(false),
  };
  return { rawState, win, ws: createWorkspaceRig(rawState as never, deps as never) };
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

    ws.writeSessionUrl('s2', 'replace');
    ws.writeSessionUrl(undefined, 'push');
    expect(win.path()).toBe('/admin/sessions');
    expect(win.entries).toEqual(['/sessions/s1', '/admin/sessions']);

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

    await ws.selectSession('s2', { urlMode: 'none', skipTrack: true });
    expect(rawState.mainView).toBe('sessionAdmin');
    expect(rawState.activeSessionId).toBe('s2');
    expect(win.path()).toBe('/admin/sessions');

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
    expect(rawState.activeSessionId).toBe('s1');
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
