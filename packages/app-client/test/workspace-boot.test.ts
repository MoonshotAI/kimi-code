import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '@moonshot-ai/app-core/api';
import type { AppSession, KimiWebApi, ReadRequestOptions, SessionGroupsPage } from '@moonshot-ai/app-core/api';
import { sessionUrl, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { createWorkspaceBoot, type WorkspaceBootDeps, type UseWorkspaceBoot } from '../src/client/boot';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { sessionReadScope, workspaceReadScope } from '../src/client/observationScope';
import type { ExtendedState } from '../src/client/types';
import { authStore } from '../src/stores/auth';
import { configStore } from '../src/stores/config';
import { connectionStore } from '../src/stores/connection';
import { sessionListStore, setSessionListHooks } from '../src/stores/sessionList';
import { sessionsStore } from '../src/stores/sessions';
import { warningsStore } from '../src/stores/warnings';
import { workspacesStore } from '../src/stores/workspaces';

const bootLogs = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@moonshot-ai/app-core/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-core/lib')>();
  return {
    ...actual,
    logInfo: bootLogs.info,
    logWarn: bootLogs.warn,
    logError: bootLogs.error,
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function session(id: string): AppSession {
  return {
    id,
    title: id,
    cwd: '/workspace',
    workspaceId: 'ws1',
    busy: false,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    model: '',
    messageCount: 0,
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

function page(ids: string[], liveIds: string[] = []): SessionGroupsPage {
  return {
    groups: [{
      workspaceId: 'ws1',
      sessions: ids.map((id, i) => ({
        ...session(id),
        lastPrompt: 'prompt',
        createdAt: new Date(1000 - i).toISOString(),
        updatedAt: new Date(1000 - i).toISOString(),
        busy: liveIds.includes(id),
      })),
      total: ids.length,
    }],
    hasMore: false,
    nextPageToken: null,
    total: 1,
  };
}

const api = {
  getAuth: vi.fn(),
  getHealth: vi.fn(),
  getMeta: vi.fn(),
  getSession: vi.fn(),
  getSessionWarnings: vi.fn<KimiWebApi['getSessionWarnings']>().mockResolvedValue([]),
  listSessionGroups: vi.fn(),
  listSessions: vi.fn(),
  listWorkspaces: vi.fn(),
  getFsHome: vi.fn(),
};
const boots: UseWorkspaceBoot[] = [];
const storage = new Map<string, string>();

function setup() {
  const state = { ...createInitialState(), mainView: 'chat' } as ExtendedState;
  const selectSession = vi.fn(async (id: string) => { sessionsStore().setActiveSessionId(id); });
  const fetchSessionIntoList = vi.fn(async (id: string, options?: ReadRequestOptions) => {
    const fresh = await api.getSession(id, options);
    if (options?.signal?.aborted) return 'error' as const;
    sessionsStore().upsertSessionSorted(fresh);
    return 'ok' as const;
  });
  const backfillPinnedSession = vi.fn(async () => 'ok' as 'ok' | 'stale' | 'error');
  const deps = {
    modelProvider: { loadModels: vi.fn(async () => {}) },
    bindSessionRoute: vi.fn(),
    writeSessionUrl: vi.fn(),
    unpinSessions: vi.fn(),
    setActiveSessionId: vi.fn((id: string | undefined) => sessionsStore().setActiveSessionId(id)),
    sessionSelection: { selectSession, fetchSessionIntoList, backfillPinnedSession },
    resumeObservationReads: vi.fn(),
  };
  const boot = createWorkspaceBoot(state, deps as unknown as WorkspaceBootDeps);
  boots.push(boot);
  return { state, boot, deps };
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  setKimiClientDeps({ api: () => api as unknown as KimiWebApi, t: (key) => key });
  sessionListStore().resetSessionList();
  sessionsStore().setSessions([]);
  sessionsStore().setActiveSessionId(undefined);
  connectionStore().eventCountBySession.clear();
  workspacesStore().workspaces = [{ id: 'ws1', root: '/workspace', name: 'workspace', sessionCount: 3 }];
  workspacesStore().storedActiveWorkspaceId = 'ws1';
  vi.spyOn(authStore(), 'checkAuth').mockResolvedValue('ok' as never);
  vi.spyOn(configStore(), 'refreshServerMeta').mockResolvedValue(undefined);
  vi.spyOn(configStore(), 'loadConfig').mockResolvedValue('committed');
  vi.spyOn(workspacesStore(), 'loadWorkspaces').mockImplementation(async (trace) => {
    if (trace === undefined) return;
    await Promise.all([
      trace('list', () => Promise.resolve([])),
      trace('home', () => Promise.resolve({ home: '', recentRoots: [] })),
    ]);
  });
  vi.spyOn(warningsStore(), 'pushOperationFailure').mockImplementation(() => {});
  setSessionListHooks({ pushOperationFailure: vi.fn() });
  api.getAuth.mockReset().mockResolvedValue({});
  api.getHealth.mockReset().mockResolvedValue({ ok: true });
  api.getMeta.mockReset().mockResolvedValue({});
  api.getSession.mockReset().mockImplementation(async (id: string) => session(id));
  api.listSessionGroups.mockReset().mockResolvedValue(page(['recent', 'live'], ['live']));
  api.listSessions.mockReset().mockResolvedValue({ items: [], hasMore: false, nextPageToken: null });
  api.listWorkspaces.mockReset().mockResolvedValue([]);
  api.getFsHome.mockReset().mockResolvedValue({ home: '', recentRoots: [] });
});

afterEach(() => {
  for (const boot of boots.splice(0)) boot.cancel();
  sessionListStore().resetSessionList();
  setSessionListHooks(null);
  resetKimiClientDeps();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('workspace boot foreground and follow-up reads', () => {
  it('selects the target and initializes before slow non-target hydration and pinned backfills', async () => {
    const live = deferred<AppSession>();
    const pinned = deferred<'ok'>();
    storage.set('kimi-web.pinned-sessions', JSON.stringify(['pin']));
    api.getSession.mockReturnValue(live.promise);
    const { boot, deps } = setup();
    deps.sessionSelection.backfillPinnedSession.mockReturnValue(pinned.promise);

    await boot.load();

    expect(boot.initialized.value).toBe(true);
    expect(sessionsStore().activeSessionId).toBe('recent');
    expect(api.getSession).toHaveBeenCalledWith('live', { background: true, signal: expect.any(AbortSignal) });
    expect(deps.sessionSelection.selectSession.mock.invocationCallOrder[0]).toBeLessThan(api.getSession.mock.invocationCallOrder[0]!);
    expect(deps.sessionSelection.backfillPinnedSession).toHaveBeenCalledWith('pin', { background: true, signal: expect.any(AbortSignal) });
    expect(deps.sessionSelection.selectSession.mock.invocationCallOrder[0]).toBeLessThan(deps.sessionSelection.backfillPinnedSession.mock.invocationCallOrder[0]!);

    live.resolve({ ...session('live'), busy: false, mainTurnActive: false });
    pinned.resolve('ok');
    await vi.waitFor(() => expect(sessionsStore().sessions.find((s) => s.id === 'live')?.mainTurnActive).toBe(false));
  });

  it('resolves a missing URL target in the foreground without selecting the most recent row first', async () => {
    vi.stubGlobal('window', { location: { pathname: sessionUrl('url-target') } });
    const metadata = deferred<AppSession>();
    api.getSession.mockImplementation((id: string) => id === 'url-target' ? metadata.promise : Promise.resolve(session(id)));
    const { boot, deps } = setup();
    const pending = boot.load();
    await vi.waitFor(() => expect(api.getSession).toHaveBeenCalledWith('url-target', { signal: expect.any(AbortSignal) }));
    expect(boot.initialized.value).toBe(false);
    expect(deps.sessionSelection.selectSession).not.toHaveBeenCalled();
    expect(api.getSession.mock.calls.map(([id]) => id)).toEqual(['url-target']);

    metadata.resolve(session('url-target'));
    await pending;

    expect(deps.sessionSelection.selectSession).toHaveBeenCalledOnce();
    expect(deps.sessionSelection.selectSession).toHaveBeenCalledWith('url-target', { urlMode: 'replace', skipTrack: true });
    expect(sessionsStore().activeSessionId).toBe('url-target');
  });

  it('does not replace an unresolved URL target with the most recent session on transient failure', async () => {
    vi.stubGlobal('window', { location: { pathname: sessionUrl('url-target') } });
    const { boot, deps } = setup();
    deps.sessionSelection.fetchSessionIntoList.mockResolvedValue('error' as never);

    await boot.load();

    expect(deps.sessionSelection.selectSession).not.toHaveBeenCalled();
    expect(sessionsStore().activeSessionId).toBeUndefined();
  });

  it('keeps the empty new-session state on reload instead of jumping to the most recent session', async () => {
    const { boot, deps } = setup();
    await boot.load();
    expect(sessionsStore().activeSessionId).toBe('recent');
    sessionsStore().setActiveSessionId(undefined);
    deps.sessionSelection.selectSession.mockClear();

    await boot.load();

    expect(deps.sessionSelection.selectSession).not.toHaveBeenCalled();
    expect(sessionsStore().activeSessionId).toBeUndefined();
  });

  it('hydrates a live initial target on the foreground lane, not the sidebar budget', async () => {
    api.listSessionGroups.mockResolvedValue(page(['live', 'recent'], ['live']));
    const live = deferred<AppSession>();
    api.getSession.mockReturnValue(live.promise);
    const { boot, deps } = setup();
    const pending = boot.load();
    await vi.waitFor(() => expect(api.getSession).toHaveBeenCalledWith('live', { background: false, signal: expect.any(AbortSignal) }));
    expect(deps.sessionSelection.selectSession).not.toHaveBeenCalled();

    live.resolve({ ...session('live'), mainTurnActive: false });
    await pending;
    expect(sessionsStore().activeSessionId).toBe('live');
    expect(api.getSession).toHaveBeenCalledOnce();
  });

  it('refreshes the flat sidebar after reload without blocking completion', async () => {
    const { boot, state } = setup();
    await boot.load();
    state.flatSessionsSeeded = true;
    const flat = deferred<{ items: []; hasMore: false; nextPageToken: null; total: number }>();
    api.listSessions.mockReturnValue(flat.promise);

    await boot.load();

    expect(state.loading).toBe(false);
    expect(api.listSessions).toHaveBeenCalledWith({ pageSize: 50, include: 'git' }, { background: true, signal: expect.any(AbortSignal) });
    flat.resolve({ items: [], hasMore: false, nextPageToken: null, total: 0 });
    await vi.waitFor(() => expect(sessionListStore().flatSessionsSeeded).toBe(true));
  });
});

describe('workspace boot cancellation', () => {
  it('cancels both observation scopes and never resumes them from a cancelled boot', async () => {
    sessionReadScope.activate('recent');
    workspaceReadScope.activate('ws1');
    const oldSession = sessionReadScope.options('recent');
    const oldWorkspace = workspaceReadScope.options('ws1');
    const groups = deferred<SessionGroupsPage>();
    api.listSessionGroups.mockReturnValue(groups.promise);
    const { boot, deps } = setup();
    const pending = boot.load();
    expect(oldSession.signal?.aborted).toBe(true);
    expect(oldWorkspace.signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(api.listSessionGroups).toHaveBeenCalledOnce());
    sessionReadScope.activate('recent');
    workspaceReadScope.activate('ws1');
    const currentSession = sessionReadScope.options('recent');
    const currentWorkspace = workspaceReadScope.options('ws1');
    boot.cancel();
    expect(currentSession.signal?.aborted).toBe(true);
    expect(currentWorkspace.signal?.aborted).toBe(true);
    groups.resolve(page(['recent']));
    await pending;
    expect(deps.resumeObservationReads).not.toHaveBeenCalled();
    expect(boot.initialized.value).toBe(false);
  });

  it('does not let a superseded initial page commit or initialize while the new boot is pending', async () => {
    const old = deferred<SessionGroupsPage>();
    const current = deferred<SessionGroupsPage>();
    api.listSessionGroups.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { boot, state, deps } = setup();
    const first = boot.load();
    await vi.waitFor(() => expect(api.listSessionGroups).toHaveBeenCalledOnce());
    const oldSignal = api.listSessionGroups.mock.calls[0]![1].signal as AbortSignal;
    const second = boot.load();
    await vi.waitFor(() => expect(api.listSessionGroups).toHaveBeenCalledTimes(2));
    expect(oldSignal.aborted).toBe(true);

    old.resolve(page(['old']));
    await first;
    expect(boot.initialized.value).toBe(false);
    expect(state.loading).toBe(true);
    expect(sessionsStore().sessions).toEqual([]);
    expect(deps.sessionSelection.selectSession).not.toHaveBeenCalled();
    expect(deps.resumeObservationReads).not.toHaveBeenCalled();

    current.resolve(page(['new']));
    await second;
    expect(sessionsStore().activeSessionId).toBe('new');
    expect(boot.initialized.value).toBe(true);
    expect(deps.resumeObservationReads).toHaveBeenCalledOnce();
  });

  it.each(['restart', 'cancel', 'reset-list'] as const)('ignores late stale pin outcomes after %s', async (action) => {
    const pinned = deferred<'stale'>();
    storage.set('kimi-web.pinned-sessions', JSON.stringify(['pin']));
    const { boot, deps } = setup();
    deps.sessionSelection.backfillPinnedSession.mockReturnValueOnce(pinned.promise);
    await boot.load();
    const oldSignal = (deps.sessionSelection.backfillPinnedSession.mock.calls[0] as unknown as [string, ReadRequestOptions])[1].signal!;

    if (action === 'restart') await boot.load();
    else if (action === 'cancel') boot.cancel();
    else sessionListStore().resetSessionList();
    expect(oldSignal.aborted).toBe(true);
    pinned.resolve('stale');
    await pinned.promise;
    await Promise.resolve();
    expect(deps.unpinSessions).not.toHaveBeenCalled();
  });

  it('unpins only successful stale outcomes and preserves failed backfills', async () => {
    storage.set('kimi-web.pinned-sessions', JSON.stringify(['gone', 'offline']));
    const { boot, deps } = setup();
    deps.sessionSelection.backfillPinnedSession.mockResolvedValueOnce('stale').mockResolvedValueOnce('error');
    await boot.load();
    await vi.waitFor(() => expect(deps.unpinSessions).toHaveBeenCalledWith(['gone']));
    expect(deps.unpinSessions).toHaveBeenCalledOnce();
  });

  it('cancels the first auth retry without marking the app initialized', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(authStore().checkAuth).mockResolvedValue('retry');
      const { boot, state } = setup();
      const pending = boot.load();
      await vi.advanceTimersByTimeAsync(0);
      expect(boot.bootRetries.value).toBe(1);
      boot.cancel();
      await pending;
      await vi.advanceTimersByTimeAsync(4000);
      expect(boot.initialized.value).toBe(false);
      expect(state.loading).toBe(false);
      expect(authStore().checkAuth).toHaveBeenCalledOnce();
      expect(storage.get(STORAGE_KEYS.pinnedSessions)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs completion for individual startup requests', async () => {
    const { boot } = setup();

    await boot.load();

    expect(bootLogs.info).toHaveBeenCalledWith('[boot] server.health ok', { runId: 1, durationMs: expect.any(Number) });
    expect(bootLogs.info).toHaveBeenCalledWith('[boot] sessions.workspaces.list ok', { runId: 1, durationMs: expect.any(Number) });
    expect(bootLogs.info).toHaveBeenCalledWith('[boot] sessions.workspaces.home ok', { runId: 1, durationMs: expect.any(Number) });
    expect(bootLogs.info).toHaveBeenCalledWith('[boot] sessions.initial ok', { runId: 1, durationMs: expect.any(Number) });
    expect(bootLogs.info).toHaveBeenCalledWith('[boot] session.select ok', { runId: 1, durationMs: expect.any(Number) });
  });

  it('logs a pending request and its eventual API error details', async () => {
    vi.useFakeTimers();
    try {
      const models = deferred<void>();
      const { boot, deps } = setup();
      deps.modelProvider.loadModels.mockReturnValueOnce(models.promise);
      const pending = boot.load();
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.modelProvider.loadModels).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(bootLogs.warn).toHaveBeenCalledWith('[boot] server.models pending', { runId: 1, elapsedMs: 10_000 });

      models.reject(Object.assign(new Error('upstream unavailable'), {
        name: 'DaemonNetworkError',
        method: 'GET',
        path: '/models',
        requestId: 'req-models',
        phase: 'fetch',
        status: 503,
      }));
      await pending;

      expect(bootLogs.error).toHaveBeenCalledWith('[boot] server.models error', expect.objectContaining({
        runId: 1,
        durationMs: expect.any(Number),
        name: 'DaemonNetworkError',
        message: 'upstream unavailable',
        method: 'GET',
        path: '/models',
        requestId: 'req-models',
        phase: 'fetch',
        httpStatus: 503,
      }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(bootLogs.warn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports errors swallowed by production startup implementations', async () => {
    const error = Object.assign(new Error('metadata unavailable'), {
      name: 'DaemonApiError',
      code: 500,
      requestId: 'req-meta',
    });
    api.getMeta.mockRejectedValueOnce(error);
    vi.mocked(configStore().refreshServerMeta).mockRestore();
    const { boot } = setup();

    await boot.load();

    expect(bootLogs.error).toHaveBeenCalledWith('[boot] server.server-meta error', expect.objectContaining({
      runId: 1,
      name: 'DaemonApiError',
      message: 'metadata unavailable',
      code: 500,
      requestId: 'req-meta',
    }));
    expect(bootLogs.info).not.toHaveBeenCalledWith('[boot] server.server-meta ok', expect.anything());
  });

  it('traces the first session request while workspaces are pending', async () => {
    vi.useFakeTimers();
    try {
      const firstPage = deferred<SessionGroupsPage>();
      const workspaces = deferred<void>();
      api.listSessionGroups.mockReturnValueOnce(firstPage.promise);
      vi.mocked(workspacesStore().loadWorkspaces).mockImplementationOnce((trace) => {
        if (trace === undefined) return workspaces.promise;
        return trace('list', () => workspaces.promise);
      });
      const { boot } = setup();
      const pending = boot.load();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.listSessionGroups).toHaveBeenCalledOnce();
      expect(bootLogs.info).toHaveBeenCalledWith('[boot] sessions.first-page start', { runId: 1 });
      expect(bootLogs.info).toHaveBeenCalledWith('[boot] sessions.workspaces.list start', { runId: 1 });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(bootLogs.warn).toHaveBeenCalledWith('[boot] sessions.first-page pending', { runId: 1, elapsedMs: 10_000 });

      workspaces.resolve();
      firstPage.reject(Object.assign(new Error('session groups unavailable'), {
        name: 'DaemonApiError',
        code: 500,
        requestId: 'req-groups',
      }));
      await pending;

      expect(bootLogs.error).toHaveBeenCalledWith('[boot] sessions.first-page error', expect.objectContaining({
        runId: 1,
        name: 'DaemonApiError',
        message: 'session groups unavailable',
        code: 500,
        requestId: 'req-groups',
      }));
      expect(bootLogs.info).not.toHaveBeenCalledWith('[boot] sessions.first-page ok', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs cancellation immediately without a later pending or duplicate error', async () => {
    vi.useFakeTimers();
    try {
      const models = deferred<void>();
      const { boot, deps } = setup();
      deps.modelProvider.loadModels.mockReturnValueOnce(models.promise);
      const pending = boot.load();
      await vi.advanceTimersByTimeAsync(0);

      boot.cancel();
      expect(bootLogs.info).toHaveBeenCalledWith('[boot] server.models cancelled', {
        runId: 1,
        durationMs: expect.any(Number),
      });

      models.reject(new Error('late failure'));
      await pending;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(bootLogs.warn).not.toHaveBeenCalled();
      expect(bootLogs.error).not.toHaveBeenCalledWith('[boot] server.models error', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports authentication errors before converting them to retries', async () => {
    vi.useFakeTimers();
    try {
      const error = Object.assign(new Error('daemon unavailable'), {
        name: 'DaemonNetworkError',
        method: 'GET',
        path: '/auth',
        requestId: 'req-auth',
        phase: 'fetch',
      });
      api.getAuth.mockRejectedValue(error);
      vi.mocked(authStore().checkAuth).mockRestore();
      const { boot } = setup();
      const pending = boot.load();
      await vi.advanceTimersByTimeAsync(0);

      expect(bootLogs.error).toHaveBeenCalledWith('[boot] auth.check error', expect.objectContaining({
        runId: 1,
        name: 'DaemonNetworkError',
        message: 'daemon unavailable',
        method: 'GET',
        path: '/auth',
        requestId: 'req-auth',
        phase: 'fetch',
      }));
      expect(bootLogs.info).not.toHaveBeenCalledWith('[boot] auth.check ok', expect.anything());

      boot.cancel();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps tracing a pending workspace request after the other request fails', async () => {
    vi.useFakeTimers();
    try {
      const home = deferred<{ home: string; recentRoots: string[] }>();
      api.listWorkspaces.mockRejectedValueOnce(Object.assign(new Error('workspace list unavailable'), {
        name: 'DaemonApiError',
        code: 500,
        requestId: 'req-workspaces',
      }));
      api.getFsHome.mockReturnValueOnce(home.promise);
      vi.mocked(workspacesStore().loadWorkspaces).mockRestore();
      const { boot } = setup();
      const pending = boot.load();
      await vi.advanceTimersByTimeAsync(0);

      expect(bootLogs.error).toHaveBeenCalledWith('[boot] sessions.workspaces.list error', expect.objectContaining({
        runId: 1,
        name: 'DaemonApiError',
        message: 'workspace list unavailable',
        code: 500,
        requestId: 'req-workspaces',
      }));

      await vi.advanceTimersByTimeAsync(10_000);
      expect(bootLogs.warn).toHaveBeenCalledWith('[boot] sessions.workspaces.home pending', {
        runId: 1,
        elapsedMs: 10_000,
      });

      home.resolve({ home: '', recentRoots: [] });
      await pending;
      expect(bootLogs.info).toHaveBeenCalledWith('[boot] sessions.workspaces.home ok', {
        runId: 1,
        durationMs: expect.any(Number),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
