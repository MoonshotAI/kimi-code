import { computed, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { useWorkspaceState } from '../src/client/useWorkspaceState';
import { noopProductTracker, setProductTracker } from '../src/contracts';

const getKimiWebApiMock = vi.fn();
const trackMock = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    lastSeq: 1,
    workspaceId: 'workspace',
  };
}

function createWorkspaceState(getSession: (sessionId: string) => Promise<AppSession>) {
  const rawState = {
    sessions: [] as AppSession[],
    activeSessionId: undefined as string | undefined,
    activeWorkspaceId: 'workspace',
    sessionLoading: false,
    unreadBySession: {} as Record<string, boolean>,
    gitStatusBySession: {},
    hiddenWorkspaceRoots: [],
  };
  getKimiWebApiMock.mockReturnValue({
    getSession,
    getGitStatus: vi.fn().mockRejectedValue(new Error('not needed')),
  });

  const deps = {
    taskPoller: { loadTasksForSession: vi.fn() },
    sideChat: {},
    modelProvider: { skillsBySession: ref({}), loadSkillsForSession: vi.fn() },
    pushOperationFailure: vi.fn(),
    activity: computed(() => ({ state: 'idle' })),
    sessionsKnownEmpty: new Set<string>(),
    setSessions: (sessions: AppSession[]) => {
      rawState.sessions = sessions;
    },
    updateSession: vi.fn(),
    upsertSessionSorted: vi.fn(),
    appendSession: (next: AppSession) => rawState.sessions.push(next),
    forgetSession: vi.fn(),
    unpinSessions: vi.fn(),
    setActiveSessionId: (id: string | undefined) => {
      rawState.activeSessionId = id;
    },
    updateSessionMessages: vi.fn(),
    nextOptimisticMsgId: vi.fn(() => 'optimistic'),
    getEventConn: vi.fn(() => null),
    subscribeSessionEvents: vi.fn(),
    refreshMainTranscript: vi.fn(async () => {}),
    hasLoadedMessages: vi.fn(() => true),
    refreshSessionStatus: vi.fn(async () => {}),
    refreshSessionGoal: vi.fn(async () => {}),
    refreshSessionPlans: vi.fn(async () => {}),
    persistSessionProfile: vi.fn(async () => true),
    mergedWorkspaces: computed(() => []),
    workspacesView: computed(() => []),
    status: computed(() => ({ cwd: '/workspace' })),
    workspaceIdForSession: vi.fn(() => 'workspace'),
    savePermissionToStorage: vi.fn(),
    savePlanModeToStorage: vi.fn(),
    saveSwarmModeToStorage: vi.fn(),
    saveGoalModeToStorage: vi.fn(),
    draftModes: { planMode: false, swarmMode: false, goalMode: false },
    saveUnread: vi.fn(),
    saveActiveWorkspaceToStorage: vi.fn(),
    saveHiddenWorkspacesToStorage: vi.fn(),
    goalErrorMessage: vi.fn(),
    initialized: ref(true),
    connectIssue: ref(null),
  };

  return useWorkspaceState(rawState as never, deps as never);
}

describe('session selection source', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
    trackMock.mockReset();
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
});
