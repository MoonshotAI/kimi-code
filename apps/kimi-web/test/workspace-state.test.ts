import { computed, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession } from '../src/api/types';
import { createInitialState } from '../src/api/daemon/eventReducer';
import { mergeWorkspaces } from '../src/lib/mergeWorkspaces';
import { useWorkspaceState, type UseWorkspaceStateDeps } from '../src/composables/client/useWorkspaceState';
import type { ExtendedState } from '../src/composables/useKimiWebClient';

const apiMock = vi.hoisted(() => ({
  abortPrompt: vi.fn(),
  abortSession: vi.fn(),
  addWorkspace: vi.fn(),
}));

vi.mock('../src/api', () => ({
  getKimiWebApi: () => apiMock,
}));

function createSession(): AppSession {
  return {
    id: 'sess_1',
    title: 'Session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    archived: false,
    currentPromptId: 'prompt_live',
    cwd: '/workspace',
    model: 'kimi-code',
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
    lastSeq: 0,
  };
}

function createState(): ExtendedState {
  return {
    ...createInitialState(),
    sessions: [createSession()],
    activeSessionId: 'sess_1',
    connected: true,
    serverVersion: '',
    workspaceName: 'kimi-web',
    connection: 'connected',
    permission: 'manual',
    thinking: 'high',
    planMode: false,
    swarmMode: false,
    goalMode: false,
    loading: false,
    sessionLoading: false,
    queuedBySession: {},
    gitStatusBySession: {},
    promptIdBySession: { sess_1: 'prompt_stale' },
    sendingBySession: {},
    unreadBySession: {},
    authReady: true,
    defaultModel: null,
    managedProviderStatus: null,
    workspaces: [],
    activeWorkspaceId: null,
    fsHome: null,
    recentRoots: [],
    hiddenWorkspaceRoots: [],
    availableOpenInApps: [],
    config: null,
    sideChatMessagesByAgent: {},
    sideChatSendingByAgent: {},
    sideChatUserMessageIdsBySession: {},
    messagesLoadingMoreBySession: {},
    messagesHasMoreBySession: {},
    messagesLoadMoreErrorBySession: {},
  };
}

function createDeps(): UseWorkspaceStateDeps {
  return {
    taskPoller: {},
    sideChat: {},
    modelProvider: {},
    pushOperationFailure: vi.fn(),
    activity: computed(() => 'running'),
    inFlightPromptSessions: new Set(),
    sessionsKnownEmpty: new Set(),
    setSessions: vi.fn(),
    updateSession: vi.fn(),
    upsertSessionFront: vi.fn(),
    appendSession: vi.fn(),
    forgetSession: vi.fn(),
    setActiveSessionId: vi.fn(),
    updateSessionMessages: vi.fn(),
    nextOptimisticMsgId: () => 'msg_opt_1',
    getEventConn: () => null,
    syncSessionFromSnapshot: vi.fn(),
    subscribeToSessionEvents: vi.fn(),
    hasLoadedMessages: vi.fn(),
    refreshSessionStatus: vi.fn(),
    persistSessionProfile: vi.fn(),
    mergedWorkspaces: computed(() => []),
    workspacesView: computed(() => []),
    status: computed(() => ({})),
    workspaceIdForSession: vi.fn(),
    savePermissionToStorage: vi.fn(),
    savePlanModeToStorage: vi.fn(),
    saveSwarmModeToStorage: vi.fn(),
    saveGoalModeToStorage: vi.fn(),
    saveUnread: vi.fn(),
    saveActiveWorkspaceToStorage: vi.fn(),
    saveHiddenWorkspacesToStorage: vi.fn(),
    goalErrorMessage: vi.fn(),
    basename: (path: string) => path.split('/').at(-1) ?? path,
    resetFastMoon: vi.fn(),
    initialized: ref(true),
    selectedDiffPath: ref(null),
    fileDiffLines: ref([]),
    fileDiffLoading: ref(false),
  } as unknown as UseWorkspaceStateDeps;
}

describe('useWorkspaceState — abortCurrentPrompt', () => {
  beforeEach(() => {
    apiMock.abortPrompt.mockReset();
    apiMock.abortSession.mockReset();
  });

  it('falls back to session abort when the cached prompt id is already completed', async () => {
    apiMock.abortPrompt.mockResolvedValue({ aborted: false });
    apiMock.abortSession.mockResolvedValue({ aborted: true });
    const state = createState();
    const workspace = useWorkspaceState(state, createDeps());

    await workspace.abortCurrentPrompt();

    expect(apiMock.abortPrompt).toHaveBeenCalledWith('sess_1', 'prompt_stale');
    expect(apiMock.abortSession).toHaveBeenCalledWith('sess_1');
    expect(state.promptIdBySession).toEqual({});
  });

  it('does not fall back when prompt abort succeeds', async () => {
    apiMock.abortPrompt.mockResolvedValue({ aborted: true });
    const workspace = useWorkspaceState(createState(), createDeps());

    await workspace.abortCurrentPrompt();

    expect(apiMock.abortPrompt).toHaveBeenCalledWith('sess_1', 'prompt_stale');
    expect(apiMock.abortSession).not.toHaveBeenCalled();
  });
});

describe('mergeWorkspaces', () => {
  it('collapses registered workspaces that share a root, keeping the first entry and its sessions', () => {
    const result = mergeWorkspaces({
      workspaces: [
        // Server orders by last_opened_at desc, so the most recently opened
        // (typically the canonical re-add) comes first.
        { id: 'wd_current', root: '/agent/GEO', name: 'GEO', isGitRepo: false, sessionCount: 0 },
        { id: 'wd_legacy', root: '/agent/GEO', name: 'GEO', isGitRepo: false, sessionCount: 0 },
      ],
      // A session whose daemon workspace_id points at the dropped (legacy) entry.
      sessions: [{ id: 's1', cwd: '/agent/GEO', workspaceId: 'wd_legacy' }],
      hiddenWorkspaceRoots: [],
      activeRoot: undefined,
      activeBranch: null,
      sessionsHasMoreByWorkspace: { wd_current: false },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.root).toBe('/agent/GEO');
    // Keeps the first (most recent) entry, matching the sidebar's first-match
    // session assignment so the rendered workspace is the one sessions land under.
    expect(result[0]?.id).toBe('wd_current');
    expect(result[0]?.sessionCount).toBe(1);
  });

  it('keeps distinct roots separate and appends derived cwds after real ones', () => {
    const result = mergeWorkspaces({
      workspaces: [
        { id: 'wd_a', root: '/agent/A', name: 'A', isGitRepo: false, sessionCount: 1 },
      ],
      sessions: [
        { id: 's1', cwd: '/agent/A', workspaceId: 'wd_a' },
        { id: 's2', cwd: '/agent/B', workspaceId: 'wd_b' },
      ],
      hiddenWorkspaceRoots: [],
      activeRoot: undefined,
      activeBranch: null,
      sessionsHasMoreByWorkspace: {},
    });

    expect(result.map((w) => w.root)).toEqual(['/agent/A', '/agent/B']);
    expect(result.find((w) => w.root === '/agent/B')?.id).toBe('wd_b');
  });

  it('hides workspaces whose root the user removed', () => {
    const result = mergeWorkspaces({
      workspaces: [
        { id: 'wd_a', root: '/agent/A', name: 'A', isGitRepo: false, sessionCount: 1 },
      ],
      sessions: [{ id: 's1', cwd: '/agent/A', workspaceId: 'wd_a' }],
      hiddenWorkspaceRoots: ['/agent/A'],
      activeRoot: undefined,
      activeBranch: null,
      sessionsHasMoreByWorkspace: {},
    });

    expect(result.map((w) => w.root)).not.toContain('/agent/A');
  });
});

describe('useWorkspaceState — addWorkspaceByPath', () => {
  beforeEach(() => {
    apiMock.addWorkspace.mockReset();
  });

  it('registers the workspace with the daemon and selects it', async () => {
    const registered = {
      id: 'wd_abc',
      root: '/abs/path',
      name: 'path',
      isGitRepo: false,
      sessionCount: 0,
    };
    apiMock.addWorkspace.mockResolvedValue(registered);
    const state = createState();
    const deps = createDeps();
    const workspace = useWorkspaceState(state, deps);

    const ok = await workspace.addWorkspaceByPath('  /abs/path  ');

    expect(ok).toBe(true);
    expect(apiMock.addWorkspace).toHaveBeenCalledWith({ root: '/abs/path' });
    expect(state.workspaces).toContainEqual(registered);
    expect(state.activeWorkspaceId).toBe('wd_abc');
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });

  it('returns false and adds no local workspace on failure', async () => {
    const err = new Error('path not found');
    apiMock.addWorkspace.mockRejectedValue(err);
    const state = createState();
    const deps = createDeps();
    const workspace = useWorkspaceState(state, deps);

    const ok = await workspace.addWorkspaceByPath('/abs/missing');

    expect(ok).toBe(false);
    // The caller (the picker) is responsible for surfacing the failure inline.
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
    expect(state.workspaces).toEqual([]);
    expect(state.activeWorkspaceId).toBeNull();
  });
});
