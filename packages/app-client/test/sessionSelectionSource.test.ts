import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonApiError, type AppSession } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { createSessionSelection } from '../src/client/sessionSelection';
import { noopProductTracker, setProductTracker } from '../src/contracts';
import { sessionsStore } from '../src/stores/sessions';
import { warningsStore } from '../src/stores/warnings';

const getKimiWebApiMock = vi.fn();
const trackMock = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function session(id: string): AppSession {
  return {
    id,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    busy: false,
    archived: false,
    cwd: '/workspace',
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
    messageCount: 1,
    workspaceId: 'workspace',
  };
}

function createWorkspaceState(
  getSession: (sessionId: string) => Promise<AppSession>,
  whenMainConversationLoaded?: (sessionId: string) => Promise<void>,
) {
  const state = { sessionLoading: false };
  getKimiWebApiMock.mockReturnValue({
    getSession,
    getGitStatus: vi.fn().mockRejectedValue(new Error('not needed')),
    getSessionGoal: vi.fn(async () => null),
    getSessionWarnings: vi.fn(async () => []),
  });

  const selection = createSessionSelection({
    modelProvider: { skillsBySession: ref({}), loadSkillsForSession: vi.fn() } as never,
    appendSession: sessionsStore().appendSession,
    setActiveSessionId: sessionsStore().setActiveSessionId,
    noteSessionWatermark: vi.fn(),
    hasLoadedMessages: () => whenMainConversationLoaded === undefined,
    whenMainConversationLoaded,
    markSessionStatusSettled: vi.fn(),
    writeSessionUrl: vi.fn(),
    setMainView: vi.fn(),
    setSessionLoading: (loading) => {
      state.sessionLoading = loading;
    },
  });

  return { ...selection, state };
}

describe('session selection source', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
    trackMock.mockReset();
    sessionsStore().setSessions([]);
    sessionsStore().setActiveSessionId(undefined);
    warningsStore().resetWarnings();
    setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
    setProductTracker({ track: trackMock });
  });

  afterEach(() => {
    resetKimiClientDeps();
    setProductTracker(noopProductTracker);
  });

  it('keeps a source bound to its selection when a stale fetch finishes first', async () => {
    const trayFetch = deferred<AppSession>();
    const notificationFetch = deferred<AppSession>();
    const workspace = createWorkspaceState((sessionId) =>
      sessionId === 'tray-session' ? trayFetch.promise : notificationFetch.promise,
    );

    const traySelection = workspace.selectSession('tray-session', {
      urlMode: 'none',
      source: 'tray',
    });
    const notificationSelection = workspace.selectSession('notification-session', {
      urlMode: 'none',
      source: 'notification',
    });

    trayFetch.resolve(session('tray-session'));
    await traySelection;
    notificationFetch.resolve(session('notification-session'));
    await notificationSelection;

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('session_created', {
      kind: 'resumed',
      source: 'notification',
    });
  });

  describe.each(['before', 'after'] as const)('baseline settles %s a failed navigation', (order) => {
    it.each(['not-found', 'network'] as const)('keeps the active loading owner after a %s error', async (failure) => {
      const baseline = deferred<void>();
      const bFetch = deferred<AppSession>();
      const workspace = createWorkspaceState(
        (id) => id === 'a' ? Promise.resolve(session(id)) : bFetch.promise,
        () => baseline.promise,
      );
      await workspace.selectSession('a', { urlMode: 'none' });
      expect(sessionsStore().activeSessionId).toBe('a');
      expect(workspace.state.sessionLoading).toBe(true);

      const selectB = workspace.selectSession('b', { urlMode: 'none' });
      if (order === 'before') {
        baseline.resolve();
        await Promise.resolve();
      }
      bFetch.reject(failure === 'not-found'
        ? new DaemonApiError({ code: 40401, msg: 'Session not found', requestId: 'test' })
        : new Error('Network unavailable'));
      await selectB;
      expect(sessionsStore().activeSessionId).toBe('a');
      if (order === 'after') {
        expect(workspace.state.sessionLoading).toBe(true);
        baseline.resolve();
        await Promise.resolve();
      }
      expect(workspace.state.sessionLoading).toBe(false);
    });
  });

  it.each(['resolve', 'reject'] as const)('ignores an old A baseline %s after successful A-B-A selection', async (outcome) => {
    const oldA = deferred<void>();
    const b = deferred<void>();
    const currentA = deferred<void>();
    const baseline = vi.fn<(sessionId: string) => Promise<void>>()
      .mockReturnValueOnce(oldA.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(currentA.promise);
    const workspace = createWorkspaceState(async (id) => session(id), baseline);

    await workspace.selectSession('a', { urlMode: 'none' });
    await workspace.selectSession('b', { urlMode: 'none' });
    await workspace.selectSession('a', { urlMode: 'none' });
    expect(baseline.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'a']);
    expect(sessionsStore().activeSessionId).toBe('a');
    expect(workspace.state.sessionLoading).toBe(true);

    if (outcome === 'resolve') oldA.resolve();
    else oldA.reject(new Error('Old baseline failed'));
    await Promise.resolve();
    expect(workspace.state.sessionLoading).toBe(true);
    b.resolve();
    await Promise.resolve();
    expect(workspace.state.sessionLoading).toBe(true);
    currentA.resolve();
    await Promise.resolve();
    expect(workspace.state.sessionLoading).toBe(false);
  });

  it('skips an already aborted session fetch even if the API ignores cancellation', async () => {
    const getSession = vi.fn(async (id: string) => session(id));
    const workspace = createWorkspaceState(getSession);

    expect(await workspace.fetchSessionIntoList('a', {
      signal: AbortSignal.abort(),
      background: true,
    })).toBe('error');
    expect(getSession).not.toHaveBeenCalled();
    expect(sessionsStore().sessions).toEqual([]);
  });

  it('keeps a newer selection when a linked session finishes loading later', async () => {
    const linkFetch = deferred<AppSession>();
    const workspace = createWorkspaceState((id) => (id === 'linked' ? linkFetch.promise : Promise.resolve(session(id))));
    sessionsStore().setSessions([session('other')]);

    const opening = workspace.openSessionLink('linked', 'deep_link');
    await workspace.selectSession('other', { urlMode: 'none' });
    linkFetch.resolve(session('linked'));
    await opening;

    expect(sessionsStore().activeSessionId).toBe('other');
    expect(warningsStore().warnings).toEqual([]);
  });

  it('opens a linked session that is not loaded yet and records the link as its source', async () => {
    const getSession = vi.fn(async (id: string) => session(id));
    const workspace = createWorkspaceState(getSession);

    await workspace.openSessionLink('linked', 'deep_link');

    expect(getSession).toHaveBeenCalledWith('linked', undefined);
    expect(sessionsStore().sessions.map((s) => s.id)).toEqual(['linked']);
    expect(sessionsStore().activeSessionId).toBe('linked');
    expect(trackMock).toHaveBeenCalledWith('session_created', { kind: 'resumed', source: 'deep_link' });
    expect(warningsStore().warnings).toEqual([]);
  });

  it.each([
    ['no longer exists', new DaemonApiError({ code: 40401, msg: 'Session not found', requestId: 'test' }), 'sessions.notFound'],
    ['cannot be fetched', new Error('Network unavailable'), 'sessions.openFailed'],
  ])('tells the user when a linked session %s', async (_case, failure, title) => {
    const workspace = createWorkspaceState(async () => {
      throw failure;
    });

    await workspace.openSessionLink('missing', 'deep_link');

    expect(sessionsStore().activeSessionId).toBeUndefined();
    expect(trackMock).not.toHaveBeenCalled();
    expect(warningsStore().warnings).toEqual([expect.objectContaining({ severity: 'warning', title })]);
  });

  it('forwards options and ignores a delayed session response after cancellation', async () => {
    const fetch = deferred<AppSession>();
    const getSession = vi.fn(() => fetch.promise);
    const workspace = createWorkspaceState(getSession);
    const controller = new AbortController();
    const options = { signal: controller.signal, background: true };
    const pending = workspace.fetchSessionIntoList('a', options);
    expect(getSession).toHaveBeenCalledExactlyOnceWith('a', options);

    controller.abort();
    fetch.resolve(session('a'));
    expect(await pending).toBe('error');
    expect(sessionsStore().sessions).toEqual([]);
  });
});
