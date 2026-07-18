// Scenario: workspace/session actions exposed by useWorkspaceState.
// Responsibilities: observable state and error reporting across load, paging, and user actions.
// Wiring: the composable is real; daemon requests and unrelated facade collaborators are stubbed.
// Run: pnpm --filter @moonshot-ai/kimi-web exec vitest run test/workspace-state.test.ts

import { computed, ref, type Ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApprovalRequest, AppQuestionRequest, AppSession, AppTask } from '../src/api/types';
import { DaemonApiError } from '../src/api/errors';
import { createInitialState } from '../src/api/daemon/eventReducer';
import { mergeWorkspaces } from '../src/lib/mergeWorkspaces';
import { loadWorkspaceNameOverrides, saveWorkspaceNameOverrides } from '../src/lib/storage';
import { useWorkspaceState, forgetLocalTurnState, type UseWorkspaceStateDeps } from '../src/composables/client/useWorkspaceState';
import type { ExtendedState } from '../src/composables/useKimiWebClient';
import { clearTrace, traceKeyEvent } from '../src/debug/trace';

const apiMock = vi.hoisted(() => ({
  abortPrompt: vi.fn(),
  abortSession: vi.fn(),
  addWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  createSession: vi.fn(),
  exportSession: vi.fn(),
  updateSession: vi.fn(),
  submitPrompt: vi.fn(),
  respondQuestion: vi.fn(),
  respondApproval: vi.fn(),
  dismissQuestion: vi.fn(),
  cancelTask: vi.fn(),
  getAuth: vi.fn(),
  getConfig: vi.fn(),
  getFsHome: vi.fn(),
  getHealth: vi.fn(),
  getMeta: vi.fn(),
  listSessions: vi.fn(),
  listWorkspaces: vi.fn(),
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
    busy: true,
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
    dangerousBypassAuth: false,
    backend: 'v1',
    workspaceName: 'kimi-web',
    connection: 'connected',
    permission: 'manual',
    thinking: 'high',
    planModeBySession: {},
    swarmModeBySession: {},
    goalModeBySession: {},
    loading: false,
    sessionLoading: false,
    queuedBySession: {},
    gitStatusBySession: {},
    promptIdBySession: { sess_1: 'prompt_stale' },
    inFlightBySession: {},
    unreadBySession: {},
    authReady: true,
    defaultModel: null,
    managedProviderStatus: null,
    workspaces: [],
    activeWorkspaceId: null,
    sessionsHasMoreByWorkspace: {},
    sessionsLoadingMoreByWorkspace: {},
    sessionsCursorByWorkspace: {},
    sessionsInitialCountByWorkspace: {},
    sessionsFullyLoaded: false,
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
    modelProvider: { thinkingLevelForModelId: () => undefined },
    pushOperationFailure: vi.fn(),
    activity: computed(() => 'running'),
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
    refreshSessionGoal: vi.fn(),
    persistSessionProfile: vi.fn().mockResolvedValue(true),
    mergedWorkspaces: computed(() => []),
    workspacesView: computed(() => []),
    status: computed(() => ({})),
    workspaceIdForSession: vi.fn(),
    savePermissionToStorage: vi.fn(),
    savePlanModeToStorage: vi.fn(),
    saveSwarmModeToStorage: vi.fn(),
    saveGoalModeToStorage: vi.fn(),
    draftModes: { planMode: false, swarmMode: false, goalMode: false },
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

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys()).at(index) ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
  };
}

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

function workspace(id: string, root: string, name: string) {
  return { id, root, name, sessionCount: 0 };
}

function questionRequest(questionId: string): AppQuestionRequest {
  return {
    questionId,
    sessionId: 'sess_1',
    questions: [
      {
        id: 'q1',
        question: 'Pick one',
        options: [{ id: 'a', label: 'A' }],
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function approvalRequest(approvalId: string): AppApprovalRequest {
  return {
    approvalId,
    sessionId: 'sess_1',
    toolCallId: 'tc_1',
    toolName: 'bash',
    action: 'shell',
    display: null,
    expiresAt: '2099-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function task(id: string, status: AppTask['status'] = 'running'): AppTask {
  return {
    id,
    sessionId: 'sess_1',
    kind: 'bash',
    description: 'run',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
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

  it('uses a server-v2 msg prompt id recovered from session state', async () => {
    apiMock.abortPrompt.mockResolvedValue({ aborted: true });
    const state = createState();
    state.promptIdBySession = {};
    state.sessions = [{ ...state.sessions[0]!, currentPromptId: 'msg_live' }];
    const workspace = useWorkspaceState(state, createDeps());

    await workspace.abortCurrentPrompt();

    expect(apiMock.abortPrompt).toHaveBeenCalledWith('sess_1', 'msg_live');
    expect(apiMock.abortSession).not.toHaveBeenCalled();
  });

  it('does not send synthetic projector prompt ids to per-prompt abort', async () => {
    apiMock.abortSession.mockResolvedValue({ aborted: true });
    const state = createState();
    state.promptIdBySession = {};
    state.sessions = [{ ...state.sessions[0]!, currentPromptId: 'pr_synthetic' }];
    const workspace = useWorkspaceState(state, createDeps());

    await workspace.abortCurrentPrompt();

    expect(apiMock.abortPrompt).not.toHaveBeenCalled();
    expect(apiMock.abortSession).toHaveBeenCalledWith('sess_1');
  });
});

describe('useWorkspaceState — exportSession', () => {
  let anchor: {
    href: string;
    download: string;
    click: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let append: ReturnType<typeof vi.fn>;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    apiMock.exportSession.mockReset();
    clearTrace();
    anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    append = vi.fn();
    createObjectURL = vi.fn(() => 'blob:session-export');
    revokeObjectURL = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { append },
    });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    clearTrace();
    vi.unstubAllGlobals();
  });

  it('downloads the returned ZIP and reclaims its temporary browser resources', async () => {
    const secret = 'PROMPT_TEXT_MUST_NOT_ENTER_EXPORT_REQUEST';
    const metadata = {
      sessionId: 'sess_1',
      contentCount: 1,
      mediaCount: 0,
      text: secret,
    };
    traceKeyEvent('prompt:start', metadata);
    const blob = new Blob(['zip']);
    apiMock.exportSession.mockResolvedValue({ blob, fileName: 'sess_1.zip' });
    const workspace = useWorkspaceState(createState(), createDeps());

    await workspace.exportSession();

    const webLog = apiMock.exportSession.mock.calls[0]?.[1] as string;
    expect(webLog).toContain('prompt:start');
    expect(webLog).toContain('contentCount');
    expect(webLog).not.toContain(secret);
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(anchor).toMatchObject({ href: 'blob:session-export', download: 'sess_1.zip' });
    expect(append).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:session-export');
    });
  });

  it('keeps one request targeted at the session selected when export started', async () => {
    let resolveExport!: (value: { blob: Blob; fileName: string }) => void;
    apiMock.exportSession.mockReturnValue(
      new Promise((resolve) => {
        resolveExport = resolve;
      }),
    );
    const state = createState();
    const workspace = useWorkspaceState(state, createDeps());

    const first = workspace.exportSession();
    state.activeSessionId = 'sess_2';
    const second = workspace.exportSession();
    resolveExport({ blob: new Blob(['zip']), fileName: 'sess_1.zip' });
    await Promise.all([first, second]);
    await vi.waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:session-export');
    });

    expect(apiMock.exportSession).toHaveBeenCalledTimes(1);
    expect(apiMock.exportSession).toHaveBeenCalledWith('sess_1', expect.any(String));
  });

  it('reclaims the object URL when the browser rejects the download click', async () => {
    apiMock.exportSession.mockResolvedValue({ blob: new Blob(['zip']), fileName: 'sess_1.zip' });
    anchor.click.mockImplementation(() => {
      throw new Error('download blocked');
    });
    const deps = createDeps();
    const workspace = useWorkspaceState(createState(), deps);

    await workspace.exportSession();

    expect(anchor.remove).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:session-export');
    });
    expect(deps.pushOperationFailure).toHaveBeenCalledWith(
      'exportSession',
      expect.any(Error),
      { sessionId: 'sess_1' },
    );
  });

  it('surfaces an error instead of silently exporting without an active session', async () => {
    const state = createState();
    state.activeSessionId = undefined;
    const deps = createDeps();
    const workspace = useWorkspaceState(state, deps);

    await workspace.exportSession();

    expect(apiMock.exportSession).not.toHaveBeenCalled();
    expect(deps.pushOperationFailure).toHaveBeenCalledWith(
      'exportSession',
      expect.any(Error),
      expect.objectContaining({ message: expect.any(String) }),
    );
  });
});

describe('mergeWorkspaces', () => {
  it('collapses registered workspaces that share a root, keeping the first entry and its sessions', () => {
    const result = mergeWorkspaces({
      workspaces: [
        // Server orders by last_opened_at desc, so the most recently opened
        // (typically the canonical re-add) comes first.
        { id: 'wd_current', root: '/agent/GEO', name: 'GEO', sessionCount: 0 },
        { id: 'wd_legacy', root: '/agent/GEO', name: 'GEO', sessionCount: 0 },
      ],
      // A session whose daemon workspace_id points at the dropped (legacy) entry.
      sessions: [{ id: 's1', cwd: '/agent/GEO', workspaceId: 'wd_legacy' }],
      hiddenWorkspaceRoots: [],
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
        { id: 'wd_a', root: '/agent/A', name: 'A', sessionCount: 1 },
      ],
      sessions: [
        { id: 's1', cwd: '/agent/A', workspaceId: 'wd_a' },
        { id: 's2', cwd: '/agent/B', workspaceId: 'wd_b' },
      ],
      hiddenWorkspaceRoots: [],
      sessionsHasMoreByWorkspace: {},
    });

    expect(result.map((w) => w.root)).toEqual(['/agent/A', '/agent/B']);
    expect(result.find((w) => w.root === '/agent/B')?.id).toBe('wd_b');
  });

  it('hides workspaces whose root the user removed', () => {
    const result = mergeWorkspaces({
      workspaces: [
        { id: 'wd_a', root: '/agent/A', name: 'A', sessionCount: 1 },
      ],
      sessions: [{ id: 's1', cwd: '/agent/A', workspaceId: 'wd_a' }],
      hiddenWorkspaceRoots: ['/agent/A'],
      sessionsHasMoreByWorkspace: {},
    });

    expect(result.map((w) => w.root)).not.toContain('/agent/A');
  });
});

describe('useWorkspaceState — renameWorkspace', () => {
  beforeEach(() => {
    apiMock.updateWorkspace.mockReset();
    installStorage(createMemoryStorage());
  });

  afterEach(() => {
    installStorage(createMemoryStorage());
  });

  it('renames via the daemon and applies the name locally', async () => {
    apiMock.updateWorkspace.mockResolvedValue({});
    const state = createState();
    state.workspaces = [workspace('wd_1', '/abs/path', 'Old')];
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.renameWorkspace('wd_1', 'New');

    expect(apiMock.updateWorkspace).toHaveBeenCalledWith('wd_1', { name: 'New' });
    expect(state.workspaces[0]?.name).toBe('New');
    expect(loadWorkspaceNameOverrides()).toEqual({});
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });

  it('falls back to a local override when the daemon reports not found', async () => {
    apiMock.updateWorkspace.mockRejectedValue(
      new DaemonApiError({ code: 40410, msg: 'workspace not found', requestId: 'r' }),
    );
    const state = createState();
    state.workspaces = [workspace('wd_1', '/abs/path', 'Old')];
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.renameWorkspace('wd_1', 'New');

    expect(state.workspaces[0]?.name).toBe('New');
    expect(loadWorkspaceNameOverrides()).toEqual({ '/abs/path': 'New' });
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });

  it('surfaces daemon errors other than not-found', async () => {
    apiMock.updateWorkspace.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }),
    );
    const state = createState();
    state.workspaces = [workspace('wd_1', '/abs/path', 'Old')];
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.renameWorkspace('wd_1', 'New');

    expect(state.workspaces[0]?.name).toBe('Old');
    expect(loadWorkspaceNameOverrides()).toEqual({});
    expect(deps.pushOperationFailure).toHaveBeenCalled();
  });

  it('keeps a saved name override when a workspace is upserted (derived → registered)', () => {
    // Simulates: user renamed a derived workspace, then the daemon registers
    // the root (e.g. on first chat) and returns the default basename.
    saveWorkspaceNameOverrides({ '/abs/path': 'Renamed' });
    const state = createState();
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    ws.upsertWorkspacePreserveOrder(workspace('wd_1', '/abs/path', 'path'));

    expect(state.workspaces[0]?.name).toBe('Renamed');
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

describe('useWorkspaceState — respondQuestion', () => {
  const response = { answers: {}, method: 'click' as const };

  beforeEach(() => {
    apiMock.respondQuestion.mockReset();
  });

  it('removes the question locally and stays silent when already resolved (40902)', async () => {
    apiMock.respondQuestion.mockRejectedValue(
      new DaemonApiError({ code: 40902, msg: 'question q_1 already resolved', requestId: 'r' }),
    );
    const state = createState();
    state.questionsBySession = { sess_1: [questionRequest('q_1')] };
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.respondQuestion('q_1', response);

    expect(apiMock.respondQuestion).toHaveBeenCalledOnce();
    // Already resolved is the desired end state, so the card is dropped locally
    // without surfacing a duplicate error to the user.
    expect(state.questionsBySession['sess_1']).toEqual([]);
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });

  it('surfaces genuine errors and keeps the question for retry', async () => {
    apiMock.respondQuestion.mockRejectedValue(
      new DaemonApiError({ code: 50001, msg: 'boom', requestId: 'r' }),
    );
    const state = createState();
    state.questionsBySession = { sess_1: [questionRequest('q_1')] };
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.respondQuestion('q_1', response);

    expect(state.questionsBySession['sess_1']).toHaveLength(1);
    expect(deps.pushOperationFailure).toHaveBeenCalledOnce();
  });

  it('drops a duplicate submit while the first respond is still in flight', async () => {
    let resolveRespond!: (value: { resolved: true; resolvedAt: string }) => void;
    apiMock.respondQuestion.mockReturnValue(
      new Promise<{ resolved: true; resolvedAt: string }>((r) => {
        resolveRespond = r;
      }),
    );
    const state = createState();
    state.questionsBySession = { sess_1: [questionRequest('q_1')] };
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    const first = ws.respondQuestion('q_1', response);
    // Second click while the first request is still in flight must be a no-op.
    await ws.respondQuestion('q_1', response);

    expect(apiMock.respondQuestion).toHaveBeenCalledOnce();

    // Resolve the first request and ensure the question is removed.
    resolveRespond({ resolved: true, resolvedAt: '2026-01-01T00:00:00.000Z' });
    await first;
    expect(state.questionsBySession['sess_1']).toEqual([]);
  });
});

describe('useWorkspaceState — respondApproval', () => {
  beforeEach(() => {
    apiMock.respondApproval.mockReset();
  });

  it('removes the approval locally and stays silent when already resolved (40902)', async () => {
    apiMock.respondApproval.mockRejectedValue(
      new DaemonApiError({ code: 40902, msg: 'approval a_1 already resolved', requestId: 'r' }),
    );
    const state = createState();
    state.approvalsBySession = { sess_1: [approvalRequest('a_1')] };
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.respondApproval('a_1', { decision: 'approved' });

    expect(apiMock.respondApproval).toHaveBeenCalledOnce();
    expect(state.approvalsBySession['sess_1']).toEqual([]);
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — cancelTask', () => {
  beforeEach(() => {
    apiMock.cancelTask.mockReset();
  });

  it('stays silent and does not force-cancel when the task already finished (40904)', async () => {
    apiMock.cancelTask.mockRejectedValue(
      new DaemonApiError({ code: 40904, msg: 'task t_1 already finished', requestId: 'r' }),
    );
    const state = createState();
    state.tasksBySession = { sess_1: [task('t_1', 'running')] };
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.cancelTask('t_1');

    expect(apiMock.cancelTask).toHaveBeenCalledOnce();
    // Benign idempotent conflict — no error, and we do NOT lie about the
    // status (the task finished; it was not cancelled).
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
    expect(state.tasksBySession['sess_1']?.[0]?.status).toBe('running');
  });

  it('marks the task cancelled on success', async () => {
    apiMock.cancelTask.mockResolvedValue({ cancelled: true });
    const state = createState();
    state.tasksBySession = { sess_1: [task('t_1', 'running')] };
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.cancelTask('t_1');

    expect(state.tasksBySession['sess_1']?.[0]?.status).toBe('cancelled');
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });

  it('drops a duplicate cancel while the first is still in flight', async () => {
    let resolveCancel!: (value: { cancelled: true }) => void;
    apiMock.cancelTask.mockReturnValue(
      new Promise<{ cancelled: true }>((r) => {
        resolveCancel = r;
      }),
    );
    const state = createState();
    state.tasksBySession = { sess_1: [task('t_1', 'running')] };
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    const first = ws.cancelTask('t_1');
    await ws.cancelTask('t_1');

    expect(apiMock.cancelTask).toHaveBeenCalledOnce();

    resolveCancel({ cancelled: true });
    await first;
  });
});

describe('useWorkspaceState — startSessionAndActivateSkill', () => {
  const registered = { id: 'wd_1', root: '/abs/path', name: 'A', sessionCount: 0 };
  const newSession = { ...createSession(), id: 'sess_new', workspaceId: 'wd_1', cwd: '/abs/path' };

  beforeEach(() => {
    apiMock.addWorkspace.mockReset();
    apiMock.createSession.mockReset();
    apiMock.addWorkspace.mockResolvedValue(registered);
    apiMock.createSession.mockResolvedValue(newSession);
  });

  function skillDeps(activateSkill: ReturnType<typeof vi.fn>): UseWorkspaceStateDeps {
    return {
      ...createDeps(),
      taskPoller: { loadTasksForSession: vi.fn() } as unknown as UseWorkspaceStateDeps['taskPoller'],
      modelProvider: {
        draftModel: ref(null),
        skillsBySession: ref({}),
        loadSkillsForSession: vi.fn(),
        activateSkill,
        thinkingLevelForModelId: () => undefined,
      } as unknown as UseWorkspaceStateDeps['modelProvider'],
      mergedWorkspaces: computed(() => [workspace('wd_1', '/abs/path', 'A')]),
    };
  }

  it('creates a session, then activates the skill on the new session id', async () => {
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const ws = useWorkspaceState(createState(), deps);

    await ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');

    expect(apiMock.createSession).toHaveBeenCalledOnce();
    // The activation targets the freshly created session, so a concurrent
    // session switch can't redirect it.
    expect(activateSkill).toHaveBeenCalledWith('pre-changelog', undefined, 'sess_new');
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });

  it('passes through skill args', async () => {
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const ws = useWorkspaceState(createState(), deps);

    await ws.startSessionAndActivateSkill('wd_1', 'write-goal', 'ship it');

    expect(activateSkill).toHaveBeenCalledWith('write-goal', 'ship it', 'sess_new');
  });

  it('awaits the profile POST before activating, so draft controls apply first', async () => {
    // Skill activation only carries `args`, so the daemon never sees the per-
    // prompt controls (plan/swarm plus permission) the user set on the draft.
    // We persist them to the new session's profile and must WAIT for it;
    // otherwise :activate can race ahead of applyAgentState and the first
    // skill turn runs at daemon defaults while the UI shows otherwise.
    let resolveProfile!: (persisted: boolean) => void;
    const profileGate = new Promise<boolean>((r) => {
      resolveProfile = r;
    });
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const persistSessionProfile = vi.fn().mockReturnValue(profileGate);
    const deps = {
      ...skillDeps(activateSkill),
      persistSessionProfile,
      draftModes: { planMode: true, swarmMode: true, goalMode: false },
    };
    const state = createState();
    state.permission = 'auto';
    state.thinking = 'high';
    const ws = useWorkspaceState(state, deps);

    const pending = ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');
    // Yield a macrotask so createDraftSession's chain (which awaits selectSession
    // before persisting the profile) progresses to the in-flight /profile POST.
    // Activation must NOT have started while /profile is still pending.
    await new Promise((r) => setTimeout(r, 0));
    expect(persistSessionProfile).toHaveBeenCalledWith(
      { model: undefined, planMode: true, swarmMode: true, permissionMode: 'auto' },
      'sess_new',
    );
    expect(activateSkill).not.toHaveBeenCalled();

    resolveProfile(true);
    await pending;

    expect(activateSkill).toHaveBeenCalledWith('pre-changelog', undefined, 'sess_new');
  });

  it('does not write thinking in the draft profile patch — activateSkill persists it once', async () => {
    // activateSkill resolves and persists the level itself (gated) right
    // before activating. Duplicating the write in THIS patch would be a
    // redundant profile update whose transient failure could veto an
    // otherwise-ready activation, so the draft patch must not carry it.
    const activateSkill2 = vi.fn().mockResolvedValue(undefined);
    const persistSessionProfile2 = vi.fn().mockResolvedValue(true);
    const state2 = createState();
    state2.thinking = 'max';
    const deps2: UseWorkspaceStateDeps = {
      ...skillDeps(activateSkill2),
      persistSessionProfile: persistSessionProfile2,
      // upsertSessionFront must actually land the new session in rawState.sessions
      // so startSessionAndActivateSkill can read its model.
      upsertSessionFront: vi.fn((s) => {
        state2.sessions = [s, ...state2.sessions.filter((x) => x.id !== s.id)];
      }),
      draftModes: { planMode: true, swarmMode: false, goalMode: false },
    };
    const ws2 = useWorkspaceState(state2, deps2);

    await ws2.startSessionAndActivateSkill('wd_1', 'pre-changelog');

    expect(persistSessionProfile2).toHaveBeenCalledOnce();
    const patch = persistSessionProfile2.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch).toMatchObject({ model: 'kimi-code', planMode: true, swarmMode: false });
    expect('thinking' in patch).toBe(false);
    expect(activateSkill2).toHaveBeenCalledWith('pre-changelog', undefined, 'sess_new');
  });

  it('is a no-op for an unknown workspace', async () => {
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const ws = useWorkspaceState(createState(), deps);

    await ws.startSessionAndActivateSkill('wd_missing', 'pre-changelog');

    expect(apiMock.createSession).not.toHaveBeenCalled();
    expect(activateSkill).not.toHaveBeenCalled();
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — createGoal from an empty composer', () => {
  const registered = { id: 'wd_1', root: '/abs/path', name: 'A', sessionCount: 0 };
  const newSession = { ...createSession(), id: 'sess_new', workspaceId: 'wd_1', cwd: '/abs/path' };

  beforeEach(() => {
    apiMock.addWorkspace.mockReset();
    apiMock.createSession.mockReset();
    apiMock.updateSession.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.addWorkspace.mockResolvedValue(registered);
    apiMock.createSession.mockResolvedValue(newSession);
    apiMock.updateSession.mockResolvedValue({});
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_goal' });
  });

  function emptyComposerState() {
    const state = createState();
    state.activeSessionId = null;
    state.activeWorkspaceId = 'wd_1';
    state.workspaces = [workspace('wd_1', '/abs/path', 'A')];
    state.permission = 'auto'; // skip the interactive goal-start confirmation
    return state;
  }

  function goalDeps(): UseWorkspaceStateDeps {
    return {
      ...createDeps(),
      taskPoller: { loadTasksForSession: vi.fn() } as unknown as UseWorkspaceStateDeps['taskPoller'],
      modelProvider: {
        draftModel: ref(null),
        skillsBySession: ref({}),
        loadSkillsForSession: vi.fn(),
        thinkingLevelForModelId: () => undefined,
      } as unknown as UseWorkspaceStateDeps['modelProvider'],
      // Something the goal can land in + what's visible in the sidebar.
      mergedWorkspaces: computed(() => [workspace('wd_1', '/abs/path', 'A')]),
      workspacesView: computed(() => [workspace('wd_1', '/abs/path', 'A')]),
    } as unknown as UseWorkspaceStateDeps;
  }

  it('creates a session, sets the goal profile, and submits the objective', async () => {
    const state = emptyComposerState(); // rawState.activeWorkspaceId = 'wd_1'
    const deps = goalDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.createGoal('improve test coverage');

    expect(apiMock.createSession).toHaveBeenCalledOnce();
    // Profile is updated on the new session: that's what marks the prompt as a goal.
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_new', { goalObjective: 'improve test coverage' });
    // And the objective is sent as the first user prompt on the new session.
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_new',
      expect.objectContaining({
        content: [{ type: 'text', text: 'improve test coverage' }],
      }),
    );
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });

  it('falls back to the first visible workspace when raw activeWorkspaceId is unset', async () => {
    // Regression for a real empty-workspace boot: load() never writes
    // rawState.activeWorkspaceId when there are no sessions, so the raw read is
    // null, but the sidebar still shows a usable workspace via the computed
    // fallback. First-session goals must work there too.
    const state = emptyComposerState();
    state.activeWorkspaceId = null;
    const ws = useWorkspaceState(state, goalDeps());

    await ws.createGoal('improve test coverage');

    expect(apiMock.createSession).toHaveBeenCalledOnce();
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_new', { goalObjective: 'improve test coverage' });
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
  });

  it('queues the objective when the active session is running (no queue bypass)', async () => {
    // Regression: creating a goal against an already-active session must honor
    // sendPrompt's queue guard, not bypass straight to submitPromptInternal.
    // Otherwise a /goal message sent while another turn is running races with
    // the active turn instead of being locally queued like normal sends.
    const state = createState();
    state.activeSessionId = 'sess_1';
    state.permission = 'auto'; // skip the interactive goal-start confirmation
    const ws = useWorkspaceState(state, createDeps());

    await ws.createGoal('improve test coverage');

    // Didn't create a session: we targeted the existing one.
    expect(apiMock.createSession).not.toHaveBeenCalled();
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_1', { goalObjective: 'improve test coverage' });
    // And because the session is running (createDeps' default activity is
    // 'running'), sendPrompt queues rather than posting immediately.
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(state.queuedBySession['sess_1']).toEqual([
      expect.objectContaining({ text: 'improve test coverage', attachments: undefined }),
    ]);
  });

  it('is a no-op when there is no active session and no usable workspace', async () => {
    const state = emptyComposerState();
    state.activeWorkspaceId = null;
    const deps: UseWorkspaceStateDeps = {
      ...createDeps(),
      mergedWorkspaces: computed(() => []),
      workspacesView: computed(() => []),
    };
    const ws = useWorkspaceState(state, deps);

    await ws.createGoal('improve test coverage');

    expect(apiMock.createSession).not.toHaveBeenCalled();
    expect(apiMock.updateSession).not.toHaveBeenCalled();
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });

  it('ignores empty/whitespace objectives', async () => {
    const state = emptyComposerState();
    const ws = useWorkspaceState(state, goalDeps());

    await ws.createGoal('   ');

    expect(apiMock.createSession).not.toHaveBeenCalled();
    expect(apiMock.updateSession).not.toHaveBeenCalled();
  });

  it('clears staged goal mode so the objective prompt is submitted once', async () => {
    // Regression for: empty composer with bare `/goal` staged (draftModes.goalMode),
    // then `/goal <objective>`. createDraftSession copies draftModes.goalMode into
    // goalModeBySession[sid]. If we don't clear it after the explicit
    // updateSession(goalObjective), submitPromptInternal re-POSTs a goalObjective,
    // the daemon rejects it (existing goal), and the objective prompt never sends.
    const state = emptyComposerState();
    const deps: UseWorkspaceStateDeps = {
      ...goalDeps(),
      draftModes: { planMode: false, swarmMode: false, goalMode: true },
    };
    const ws = useWorkspaceState(state, deps);

    await ws.createGoal('improve test coverage');

    // The explicit goal objective went through...
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_new', { goalObjective: 'improve test coverage' });
    // ...and the objective prompt itself was submitted exactly once as a user prompt.
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(1);
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_new',
      expect.objectContaining({
        content: [{ type: 'text', text: 'improve test coverage' }],
      }),
    );
    // goal mode flag was consumed by the explicit goal.
    expect(state.goalModeBySession['sess_new']).toBe(false);
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });

  it('surfaces session-creation failures instead of leaking an unhandled rejection', async () => {
    // App.vue invokes createGoal fire-and-forget, so a rejection from
    // createDraftSession must be caught and reported via pushOperationFailure —
    // mirroring the other draft-session paths (skill / BTW / first prompt).
    const state = emptyComposerState();
    const deps = goalDeps();
    const ws = useWorkspaceState(state, deps);
    const err = new Error('snapshot failed');
    apiMock.createSession.mockRejectedValue(err);

    await expect(ws.createGoal('improve test coverage')).resolves.toBeUndefined();

    expect(deps.pushOperationFailure).toHaveBeenCalledWith('createGoal', err);
    expect(apiMock.updateSession).not.toHaveBeenCalled();
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — startSessionAndOpenSideChat', () => {
  const registered = { id: 'wd_1', root: '/abs/path', name: 'A', sessionCount: 0 };
  const newSession = { ...createSession(), id: 'sess_new', workspaceId: 'wd_1', cwd: '/abs/path' };

  beforeEach(() => {
    apiMock.addWorkspace.mockReset();
    apiMock.createSession.mockReset();
    apiMock.addWorkspace.mockResolvedValue(registered);
    apiMock.createSession.mockResolvedValue(newSession);
  });

  function sideChatDeps(openSideChatOn: ReturnType<typeof vi.fn>): UseWorkspaceStateDeps {
    return {
      ...createDeps(),
      taskPoller: { loadTasksForSession: vi.fn() } as unknown as UseWorkspaceStateDeps['taskPoller'],
      sideChat: { openSideChatOn } as unknown as UseWorkspaceStateDeps['sideChat'],
      modelProvider: {
        draftModel: ref(null),
        skillsBySession: ref({}),
        loadSkillsForSession: vi.fn(),
        thinkingLevelForModelId: () => undefined,
      } as unknown as UseWorkspaceStateDeps['modelProvider'],
      mergedWorkspaces: computed(() => [workspace('wd_1', '/abs/path', 'A')]),
    };
  }

  it('creates a session, then opens BTW on the new session id with the question', async () => {
    const openSideChatOn = vi.fn().mockResolvedValue(undefined);
    const deps = sideChatDeps(openSideChatOn);
    const ws = useWorkspaceState(createState(), deps);

    await ws.startSessionAndOpenSideChat('wd_1', 'what changed?');

    expect(apiMock.createSession).toHaveBeenCalledOnce();
    // The BTW sub-agent is opened on the freshly created session, so a
    // concurrent session switch can't redirect it.
    expect(openSideChatOn).toHaveBeenCalledWith('sess_new', 'what changed?');
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });

  it('works without an initial question (bare /btw)', async () => {
    const openSideChatOn = vi.fn().mockResolvedValue(undefined);
    const deps = sideChatDeps(openSideChatOn);
    const ws = useWorkspaceState(createState(), deps);

    await ws.startSessionAndOpenSideChat('wd_1');

    expect(openSideChatOn).toHaveBeenCalledWith('sess_new', undefined);
  });

  it('is a no-op for an unknown workspace', async () => {
    const openSideChatOn = vi.fn().mockResolvedValue(undefined);
    const deps = sideChatDeps(openSideChatOn);
    const ws = useWorkspaceState(createState(), deps);

    await ws.startSessionAndOpenSideChat('wd_missing', 'what changed?');

    expect(apiMock.createSession).not.toHaveBeenCalled();
    expect(openSideChatOn).not.toHaveBeenCalled();
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — first-load auth gate', () => {
  beforeEach(() => {
    apiMock.getAuth.mockReset();
    apiMock.getHealth.mockReset().mockResolvedValue({ ok: true });
    apiMock.getMeta.mockReset().mockResolvedValue({
      serverVersion: '0.0.0',
      openInApps: [],
      dangerousBypassAuth: false,
      backend: 'v1',
    });
    apiMock.getConfig.mockReset().mockResolvedValue({});
    apiMock.listWorkspaces.mockReset().mockResolvedValue([]);
    apiMock.getFsHome.mockReset().mockResolvedValue({ home: '', recentRoots: [] });
    apiMock.listSessions.mockReset().mockResolvedValue({ items: [], hasMore: false });
  });

  function createLoadDeps(
    initialized: Ref<boolean>,
    connectIssue: Ref<string | null>,
  ): UseWorkspaceStateDeps {
    return {
      ...createDeps(),
      modelProvider: { loadModels: vi.fn().mockResolvedValue(undefined) },
      initialized,
      connectIssue,
    } as unknown as UseWorkspaceStateDeps;
  }

  it('keeps the splash up and retries /auth when the first check fails transiently', async () => {
    vi.useFakeTimers();
    try {
      const initialized = ref(false);
      const connectIssue = ref<string | null>(null);
      const state = createState();
      state.authReady = false;
      apiMock.getAuth
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValue({ ready: true, defaultModel: 'kimi-code', managedProvider: null });
      const ws = useWorkspaceState(state, createLoadDeps(initialized, connectIssue));

      const pending = ws.load();
      await vi.advanceTimersByTimeAsync(0);
      // First /auth failed: NOT treated as "not signed in" — no initialization.
      // The first failure stays silent so a single blip flashes no error.
      expect(initialized.value).toBe(false);
      expect(apiMock.getAuth).toHaveBeenCalledTimes(1);
      expect(connectIssue.value).toBeNull();

      // From the 2nd failed attempt the reason is surfaced for the splash.
      await vi.advanceTimersByTimeAsync(2000);
      expect(apiMock.getAuth).toHaveBeenCalledTimes(2);
      expect(initialized.value).toBe(false);
      expect(connectIssue.value).toBe('connection refused');

      // The retry re-checks /auth; once it answers, load completes.
      await vi.advanceTimersByTimeAsync(2000);
      await pending;
      expect(apiMock.getAuth).toHaveBeenCalledTimes(3);
      expect(initialized.value).toBe(true);
      expect(state.authReady).toBe(true);
      expect(connectIssue.value).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('initializes normally (into the login gate) when /auth answers ready:false', async () => {
    const initialized = ref(false);
    const state = createState();
    state.authReady = false;
    apiMock.getAuth.mockResolvedValue({ ready: false, defaultModel: null, managedProvider: null });
    const ws = useWorkspaceState(state, createLoadDeps(initialized, ref(null)));

    await ws.load();

    // A definitive "not ready" answer behaves exactly as before: initialize and
    // let the auth gate show /login.
    expect(apiMock.getAuth).toHaveBeenCalledTimes(1);
    expect(initialized.value).toBe(true);
    expect(state.authReady).toBe(false);
  });

  it.each([40101, 401])(
    'stops without retrying when /auth rejects with %i (server token required)',
    async (code) => {
      vi.useFakeTimers();
      try {
        const initialized = ref(false);
        const state = createState();
        state.authReady = false;
        apiMock.getAuth.mockRejectedValue(
          new DaemonApiError({ code, msg: 'Unauthorized', requestId: 'req_1' }),
        );
        const ws = useWorkspaceState(state, createLoadDeps(initialized, ref(null)));

        await ws.load();
        expect(apiMock.getAuth).toHaveBeenCalledTimes(1);
        expect(initialized.value).toBe(false);

        // No retry loop is running — recovery belongs to the ServerAuthDialog,
        // which reloads the page once the user enters the token.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(apiMock.getAuth).toHaveBeenCalledTimes(1);
        expect(initialized.value).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('useWorkspaceState — session list loading', () => {
  beforeEach(() => {
    apiMock.getAuth.mockReset().mockResolvedValue({
      ready: true,
      defaultModel: 'kimi-code',
      managedProvider: null,
    });
    apiMock.getHealth.mockReset().mockResolvedValue({ ok: true });
    apiMock.getMeta.mockReset().mockResolvedValue({
      serverVersion: '0.0.0',
      openInApps: [],
      dangerousBypassAuth: false,
      backend: 'v1',
    });
    apiMock.getConfig.mockReset().mockResolvedValue({});
    apiMock.listWorkspaces.mockReset().mockResolvedValue([]);
    apiMock.getFsHome.mockReset().mockResolvedValue({ home: '', recentRoots: [] });
    apiMock.listSessions.mockReset();
  });

  function createSessionLoadRig(sessions: AppSession[]) {
    const state = createState();
    state.sessions = sessions;
    state.activeSessionId = sessions[0]?.id ?? null;
    const deps = {
      ...createDeps(),
      modelProvider: { loadModels: vi.fn().mockResolvedValue(undefined) },
      initialized: ref(false),
      connectIssue: ref<string | null>(null),
      setSessions: vi.fn((next: AppSession[]) => {
        state.sessions = next;
      }),
      workspaceIdForSession: vi.fn(
        (session: { workspaceId?: string; cwd: string }) =>
          state.workspaces.find((item) => item.root === session.cwd)?.id ??
          session.workspaceId ??
          session.cwd,
      ),
    } as unknown as UseWorkspaceStateDeps;
    return { state, deps, workspaceState: useWorkspaceState(state, deps) };
  }

  it('reports one load failure when the no-workspace session fallback rejects', async () => {
    const error = new Error('session index unavailable');
    apiMock.listSessions.mockRejectedValue(error);
    const { deps, workspaceState } = createSessionLoadRig([]);

    await workspaceState.load();

    expect(deps.pushOperationFailure).toHaveBeenCalledOnce();
    expect(deps.pushOperationFailure).toHaveBeenCalledWith('load', error);
  });

  it('keeps failed workspace sessions while replacing a successful shared-root workspace', async () => {
    const error = new Error('legacy workspace unavailable');
    const cached = {
      ...createSession(),
      id: 'sess_cached',
      title: 'Cached legacy',
      workspaceId: 'wd_legacy',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const fresh = {
      ...createSession(),
      id: 'sess_fresh',
      title: 'Fresh current',
      workspaceId: 'wd_current',
      updatedAt: '2026-01-03T00:00:00.000Z',
    };
    const staleCurrent = {
      ...createSession(),
      id: 'sess_stale',
      title: 'Stale current',
      workspaceId: 'wd_current',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    apiMock.listWorkspaces.mockResolvedValue([
      workspace('wd_current', '/workspace', 'Workspace'),
      workspace('wd_legacy', '/workspace', 'Workspace'),
    ]);
    apiMock.listSessions.mockImplementation(
      async ({ workspaceId }: { workspaceId?: string }) => {
        if (workspaceId === 'wd_current') return { items: [fresh], hasMore: false };
        throw error;
      },
    );
    const { state, deps, workspaceState } = createSessionLoadRig([cached, staleCurrent]);

    await workspaceState.load();

    expect(state.sessions.map((session) => session.id)).toEqual(['sess_fresh', 'sess_cached']);
    expect(deps.pushOperationFailure).toHaveBeenCalledOnce();
    expect(deps.pushOperationFailure).toHaveBeenCalledWith('load', error);
  });

  it('keeps root-matched sessions when their stored workspace id is no longer registered', async () => {
    const error = new Error('current workspace unavailable');
    const cached = {
      ...createSession(),
      id: 'sess_cached',
      title: 'Cached old workspace id',
      workspaceId: 'wd_removed',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const fresh = {
      ...createSession(),
      id: 'sess_fresh',
      title: 'Fresh other workspace',
      cwd: '/other-workspace',
      workspaceId: 'wd_other',
      updatedAt: '2026-01-03T00:00:00.000Z',
    };
    apiMock.listWorkspaces.mockResolvedValue([
      workspace('wd_current', '/workspace', 'Workspace'),
      workspace('wd_other', '/other-workspace', 'Other'),
    ]);
    apiMock.listSessions.mockImplementation(
      async ({ workspaceId }: { workspaceId?: string }) => {
        if (workspaceId === 'wd_current') throw error;
        return { items: [fresh], hasMore: false };
      },
    );
    const { state, deps, workspaceState } = createSessionLoadRig([cached]);

    await workspaceState.load();

    expect(state.sessions.map((session) => session.id)).toEqual(['sess_fresh', 'sess_cached']);
    expect(deps.pushOperationFailure).toHaveBeenCalledOnce();
    expect(deps.pushOperationFailure).toHaveBeenCalledWith('load', error);
  });

  it('loads the next page when a retry follows an automatic continuation failure', async () => {
    const error = new Error('automatic continuation unavailable');
    const cached = {
      ...createSession(),
      title: 'Cached first page',
      workspaceId: 'wd_1',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
    const fresh = { ...cached, title: 'Fresh first page' };
    const older = {
      ...createSession(),
      id: 'sess_older',
      workspaceId: 'wd_1',
      updatedAt: '2025-12-31T00:00:00.000Z',
    };
    apiMock.listWorkspaces.mockResolvedValue([workspace('wd_1', '/workspace', 'Workspace')]);
    apiMock.listSessions
      .mockResolvedValueOnce({ items: [fresh], hasMore: true })
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ items: [older], hasMore: false });
    const { state, deps, workspaceState } = createSessionLoadRig([cached]);

    await workspaceState.load();

    expect(state.sessions.map((session) => session.title)).toEqual(['Fresh first page']);
    expect(deps.pushOperationFailure).toHaveBeenCalledWith('load', error);

    await workspaceState.loadMoreSessions('wd_1');

    expect(state.sessions.map((session) => session.id)).toEqual(['sess_1', 'sess_older']);
    expect(deps.pushOperationFailure).toHaveBeenCalledOnce();
  });

  it('recovers the global session list when a retry follows a second-page failure', async () => {
    const error = new Error('global continuation unavailable');
    const cached = { ...createSession(), title: 'Cached first page' };
    const fresh = {
      ...cached,
      title: 'Fresh first page',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const older = {
      ...createSession(),
      id: 'sess_older',
      updatedAt: '2025-12-31T00:00:00.000Z',
    };
    const cachedOlder = { ...older, title: 'Cached older page' };
    apiMock.listSessions
      .mockResolvedValueOnce({ items: [fresh], hasMore: true })
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ items: [fresh, older], hasMore: false });
    const { state, deps, workspaceState } = createSessionLoadRig([cached, cachedOlder]);

    await workspaceState.load();

    expect(state.sessions.map((session) => session.title)).toEqual([
      'Fresh first page',
      'Cached older page',
    ]);
    expect(deps.pushOperationFailure).toHaveBeenCalledOnce();
    expect(deps.pushOperationFailure).toHaveBeenCalledWith('load', error);

    await workspaceState.load();

    expect(state.sessions.map((session) => session.id)).toEqual(['sess_1', 'sess_older']);
  });

  it('preserves cached sessions when every workspace initial page rejects', async () => {
    const firstError = new Error('workspace A unavailable');
    const cachedA = {
      ...createSession(),
      id: 'sess_a',
      cwd: '/workspace-a',
      workspaceId: 'wd_a',
    };
    const cachedB = {
      ...createSession(),
      id: 'sess_b',
      cwd: '/workspace-b',
      workspaceId: 'wd_b',
    };
    apiMock.listWorkspaces.mockResolvedValue([
      workspace('wd_a', '/workspace-a', 'A'),
      workspace('wd_b', '/workspace-b', 'B'),
    ]);
    apiMock.listSessions.mockImplementation(
      async ({ workspaceId }: { workspaceId?: string }) => {
        if (workspaceId === 'wd_a') throw firstError;
        throw new Error('workspace B unavailable');
      },
    );
    const { state, deps, workspaceState } = createSessionLoadRig([cachedA, cachedB]);

    await workspaceState.load();

    expect(state.sessions.map((session) => session.id)).toEqual(['sess_a', 'sess_b']);
    expect(deps.pushOperationFailure).toHaveBeenCalledOnce();
    expect(deps.pushOperationFailure).toHaveBeenCalledWith('load', firstError);
  });

  it('loads workspace sessions when a retry follows an initial failure', async () => {
    const cached = {
      ...createSession(),
      title: 'Cached',
      workspaceId: 'wd_1',
    };
    const recovered = { ...cached, title: 'Recovered' };
    apiMock.listWorkspaces.mockResolvedValue([workspace('wd_1', '/workspace', 'Workspace')]);
    apiMock.listSessions
      .mockRejectedValueOnce(new Error('session index unavailable'))
      .mockResolvedValue({ items: [recovered], hasMore: false });
    const { state, workspaceState } = createSessionLoadRig([cached]);

    await workspaceState.load();
    await workspaceState.load();

    expect(state.sessions.map((session) => session.title)).toEqual(['Recovered']);
  });

  it('loads the next workspace page when a retry follows a rejection', async () => {
    const loaded = { ...createSession(), workspaceId: 'wd_1' };
    const older = {
      ...createSession(),
      id: 'sess_older',
      workspaceId: 'wd_1',
      updatedAt: '2025-12-31T00:00:00.000Z',
    };
    const { state, deps, workspaceState } = createSessionLoadRig([loaded]);
    state.workspaces = [workspace('wd_1', '/workspace', 'Workspace')];
    state.sessionsHasMoreByWorkspace = { wd_1: true };
    state.sessionsCursorByWorkspace = { wd_1: 'sess_1' };
    state.sessionsLoadingMoreByWorkspace = { wd_1: false };
    apiMock.listSessions
      .mockRejectedValueOnce(new Error('next page unavailable'))
      .mockResolvedValue({ items: [older], hasMore: false });

    await workspaceState.loadMoreSessions('wd_1');
    await workspaceState.loadMoreSessions('wd_1');

    expect(state.sessions.map((session) => session.id)).toEqual(['sess_1', 'sess_older']);
    expect(deps.pushOperationFailure).toHaveBeenCalledOnce();
  });
});

// /meta re-read on every WS (re)connect — keeps version / backend truthful
// across backend restarts and dev-proxy backend switches.
describe('useWorkspaceState — refreshServerMeta', () => {
  beforeEach(() => {
    apiMock.getMeta.mockReset();
  });

  it('applies the meta payload including the v2 backend marker', async () => {
    apiMock.getMeta.mockResolvedValue({
      serverVersion: '9.9.9',
      openInApps: ['finder'],
      dangerousBypassAuth: true,
      backend: 'v2',
    });
    const state = createState();
    const ws = useWorkspaceState(state, createDeps());

    await ws.refreshServerMeta();

    expect(state.serverVersion).toBe('9.9.9');
    expect(state.availableOpenInApps).toEqual(['finder']);
    expect(state.dangerousBypassAuth).toBe(true);
    expect(state.backend).toBe('v2');
  });

  it('keeps the previous meta when /meta fails', async () => {
    apiMock.getMeta.mockRejectedValue(new Error('connection refused'));
    const state = createState();
    state.backend = 'v2';
    const ws = useWorkspaceState(state, createDeps());

    await ws.refreshServerMeta();

    expect(state.backend).toBe('v2');
    expect(state.serverVersion).toBe('');
  });
});

// Regression coverage for wake/reconnect snapshot recovery.
describe('useWorkspaceState — snapshot prompt recovery', () => {
  function promptDeps(overrides: Partial<UseWorkspaceStateDeps> = {}): UseWorkspaceStateDeps {
    return {
      ...createDeps(),
      modelProvider: {
        models: ref([]),
        thinkingLevelForModelId: () => undefined,
      } as unknown as UseWorkspaceStateDeps['modelProvider'],
      ...overrides,
    };
  }

  beforeEach(() => {
    apiMock.submitPrompt.mockReset();
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'prompt_new' });
    // Module-level flush failure budget must not leak between tests.
    forgetLocalTurnState('sess_1');
  });

  it('clears a finished prompt from a terminal snapshot so the next send is immediate', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    const ws = useWorkspaceState(
      state,
      promptDeps({ activity: computed(() => 'idle') }),
    );

    ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });

    expect(state.inFlightBySession.sess_1).toBe(false);
    expect(state.promptIdBySession.sess_1).toBeUndefined();

    await ws.sendPrompt('next');
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(state.queuedBySession.sess_1).toBeUndefined();
  });

  it('keeps a genuinely running prompt in flight and queues the next send', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    const ws = useWorkspaceState(state, promptDeps());

    ws.handleSessionSnapshot('sess_1', {
      inFlightTurn: { turnId: 1, assistantText: '', thinkingText: '', runningTools: [] },
      busy: true,
    });
    await ws.sendPrompt('next');

    expect(state.inFlightBySession.sess_1).toBe(true);
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(state.queuedBySession.sess_1).toEqual([
      expect.objectContaining({ text: 'next', attachments: undefined }),
    ]);
  });

  it('drains one queued prompt when only background work remains', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.promptIdBySession = { sess_1: 'prompt_old' };
    state.queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    const ws = useWorkspaceState(state, promptDeps());

    ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: true });

    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
    ]);
  });

  // Regression: re-opening a session after a failed drain must NOT fire the
  // stuck queued prompts (with their stale attachments) out of nowhere.
  it('does not drain the queue on a bare session-open snapshot with no locally witnessed prompt', () => {
    const state = createState();
    state.queuedBySession = {
      sess_1: [{ text: 'stuck queued', attachments: [{ fileId: 'f_old', kind: 'image' }] }],
    };
    const ws = useWorkspaceState(state, promptDeps());

    ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });

    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'stuck queued', attachments: [{ fileId: 'f_old', kind: 'image' }] }],
    );
  });

  it('drains one queued prompt when the finished turn was locally witnessed', () => {
    const state = createState();
    state.queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    const ws = useWorkspaceState(state, promptDeps());

    ws.finishPromptLocal('sess_1', { turnWasActive: true });

    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
    ]);
  });

  it('flushes the stuck queue head before the new prompt when sending while idle', async () => {
    const state = createState();
    state.queuedBySession = { sess_1: [{ text: 'stuck queued', attachments: undefined }] };
    const ws = useWorkspaceState(state, promptDeps({ activity: computed(() => 'idle') }));

    await ws.sendPrompt('next');

    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'stuck queued' }] }),
    );
    expect(state.queuedBySession.sess_1).toEqual([
      expect.objectContaining({ text: 'next', attachments: undefined }),
    ]);
  });

  it('re-queues a failed flush at the head and drops it after repeated failures', async () => {
    const state = createState();
    state.queuedBySession = { sess_1: [{ text: 'first queued', attachments: undefined }] };
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'turn.agent_busy', requestId: 'r' }),
    );
    const ws = useWorkspaceState(state, promptDeps());
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Failures 1-2 (e.g. racing a still-busy daemon after an abort): the
    // entry goes back at the head and waits for the next flush driver.
    for (let i = 0; i < 2; i += 1) {
      state.inFlightBySession = { sess_1: true };
      ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });
      await settle();
      expect(state.queuedBySession.sess_1).toEqual([{ text: 'first queued', attachments: undefined }]);
    }

    // Failure 3: a permanently rejected head is dropped rather than blocking
    // every later prompt behind it forever.
    state.inFlightBySession = { sess_1: true };
    ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });
    await settle();
    expect(state.queuedBySession.sess_1).toEqual([]);
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(3);
  });

  it('restores the merged queue entries when a steer submit is definitively rejected', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [{ text: 'queued', attachments: [{ fileId: 'f_q', kind: 'image' }] }],
    };
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }),
    );
    const ws = useWorkspaceState(state, promptDeps());

    await ws.steerPrompt('live text', [{ fileId: 'f_live', kind: 'image' }]);

    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'queued', attachments: [{ fileId: 'f_q', kind: 'image' }] }],
    );
  });

  it('does NOT restore merged queue entries when a steer failure is network-ambiguous', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [{ text: 'queued', attachments: [{ fileId: 'f_q', kind: 'image' }] }],
    };
    // Response lost mid-flight: the merged prompt may already be queued
    // server-side, so restoring would duplicate it on a later drain.
    apiMock.submitPrompt.mockRejectedValue(new TypeError('fetch failed'));
    const ws = useWorkspaceState(state, promptDeps());

    await ws.steerPrompt('live text', [{ fileId: 'f_live', kind: 'image' }]);

    expect(state.queuedBySession.sess_1 ?? []).toEqual([]);
  });

  it('restores the queue when an idle steer falls back to a normal send that fails', async () => {
    const state = createState();
    state.queuedBySession = { sess_1: [{ text: 'queued', attachments: undefined }] };
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }),
    );
    const ws = useWorkspaceState(state, promptDeps({ activity: computed(() => 'idle') }));

    await ws.steerPrompt('live text');

    expect(state.queuedBySession.sess_1).toEqual([{ text: 'queued', attachments: undefined }]);
  });

  // A background session's drained prompt must not inherit the thinking level
  // of whichever session is active when the drain happens — the level is
  // resolved from the prompt's OWN model, never the active-view global.
  it('drains a queued prompt with the level of its own session model, not the active view', async () => {
    const state = createState();
    state.sessions = [{ ...createSession(), id: 'sess_a', model: 'provider/model-a' }];
    state.activeSessionId = 'sess_b'; // the user has switched to another session
    state.thinking = 'max'; // the global now tracks that session's max-only model
    state.inFlightBySession = { sess_a: true };
    state.queuedBySession = { sess_a: [{ text: 'follow up', attachments: undefined }] };
    const thinkingLevelForModelId = vi.fn((id: string | undefined) =>
      id === 'provider/model-a' ? 'low' : undefined,
    );
    const ws = useWorkspaceState(
      state,
      promptDeps({
        modelProvider: {
          models: ref([]),
          thinkingLevelForModelId,
        } as unknown as UseWorkspaceStateDeps['modelProvider'],
      }),
    );

    ws.handleSessionSnapshot('sess_a', { inFlightTurn: null, busy: true });

    expect(thinkingLevelForModelId).toHaveBeenCalledWith('provider/model-a');
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_a',
      expect.objectContaining({ model: 'provider/model-a', thinking: 'low' }),
    );
  });

  it('falls back to the active level for a drained prompt whose model left the catalog', async () => {
    const state = createState();
    state.sessions = [{ ...createSession(), id: 'sess_a', model: 'provider/gone-model' }];
    state.thinking = 'max';
    state.inFlightBySession = { sess_a: true };
    state.queuedBySession = { sess_a: [{ text: 'follow up', attachments: undefined }] };
    const ws = useWorkspaceState(
      state,
      promptDeps({
        modelProvider: {
          models: ref([]),
          thinkingLevelForModelId: () => undefined,
        } as unknown as UseWorkspaceStateDeps['modelProvider'],
      }),
    );

    ws.handleSessionSnapshot('sess_a', { inFlightTurn: null, busy: true });

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_a',
      expect.objectContaining({ model: 'provider/gone-model', thinking: 'max' }),
    );
  });

  it('clears local prompt state when busy disproves a stale snapshot turn', () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.promptIdBySession = { sess_1: 'prompt_old' };
    const ws = useWorkspaceState(state, promptDeps());

    ws.handleSessionSnapshot('sess_1', {
      inFlightTurn: { turnId: 1, assistantText: '', thinkingText: '', runningTools: [] },
      busy: false,
    });

    expect(state.inFlightBySession.sess_1).toBe(false);
    expect(state.promptIdBySession.sess_1).toBeUndefined();
  });

  it('rejects a snapshot when a new local prompt started during the request', async () => {
    const state = createState();
    const ws = useWorkspaceState(state, promptDeps());
    const atRequest = ws.localTurnStartState('sess_1');

    await ws.submitPromptInternal('sess_1', 'fresh prompt');

    expect(ws.isLocalTurnSnapshotCurrent('sess_1', atRequest)).toBe(false);
    expect(state.inFlightBySession.sess_1).toBe(true);
  });

  it('rejects a snapshot requested while the local submit is still pending', async () => {
    let resolveSubmit!: (value: { promptId: string }) => void;
    apiMock.submitPrompt.mockImplementation(
      () =>
        new Promise<{ promptId: string }>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const ws = useWorkspaceState(createState(), promptDeps());
    const pendingSubmit = ws.submitPromptInternal('sess_1', 'fresh prompt');
    const atRequest = ws.localTurnStartState('sess_1');
    const retrySnapshot = vi.fn();

    expect(atRequest.pending).toBe(true);
    expect(ws.isLocalTurnSnapshotCurrent('sess_1', atRequest)).toBe(false);
    ws.afterLocalTurnStartsSettle('sess_1', retrySnapshot);
    expect(retrySnapshot).not.toHaveBeenCalled();

    resolveSubmit({ promptId: 'prompt_new' });
    await pendingSubmit;
    expect(ws.localTurnStartState('sess_1').pending).toBe(false);
    expect(retrySnapshot).toHaveBeenCalledOnce();
  });

  it('maps attachments to the matching content parts on submit (file parts included)', async () => {
    const ws = useWorkspaceState(createState(), promptDeps());

    await ws.submitPromptInternal('sess_1', 'look at these', [
      { fileId: 'f_img', kind: 'image' },
      { fileId: 'f_vid', kind: 'video' },
      { fileId: 'f_pdf', kind: 'file', name: 'a.pdf', mediaType: 'application/pdf', size: 42 },
    ]);

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [
          { type: 'text', text: 'look at these' },
          { type: 'image', source: { kind: 'file', fileId: 'f_img' } },
          { type: 'video', source: { kind: 'file', fileId: 'f_vid' } },
          { type: 'file', fileId: 'f_pdf', name: 'a.pdf', mediaType: 'application/pdf', size: 42 },
        ],
      }),
    );
  });

  it('normalizes an empty attachment MIME to application/octet-stream on submit', async () => {
    const ws = useWorkspaceState(createState(), promptDeps());

    await ws.submitPromptInternal('sess_1', 'look at this', [
      { fileId: 'f_mk', kind: 'file', name: 'Makefile', mediaType: '', size: 10 },
    ]);

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'file', fileId: 'f_mk', name: 'Makefile', mediaType: 'application/octet-stream', size: 10 },
        ],
      }),
    );
  });

  it('advances to the next queued entry after dropping an exhausted head', async () => {
    const state = createState();
    state.queuedBySession = {
      sess_1: [
        { text: 'poisoned head', attachments: undefined, id: 'id-bad' },
        { text: 'good next', attachments: undefined, id: 'id-good' },
      ],
    };
    apiMock.submitPrompt
      .mockRejectedValueOnce(new DaemonApiError({ code: 50000, msg: 'gone', requestId: 'r' }))
      .mockRejectedValueOnce(new DaemonApiError({ code: 50000, msg: 'gone', requestId: 'r' }))
      .mockRejectedValueOnce(new DaemonApiError({ code: 50000, msg: 'gone', requestId: 'r' }))
      .mockResolvedValueOnce({ promptId: 'prompt_good' });
    const ws = useWorkspaceState(state, promptDeps());
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    for (let i = 0; i < 3; i += 1) {
      state.inFlightBySession = { sess_1: true };
      ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });
      await settle();
    }

    // The exhausted head is gone AND the next entry was submitted right
    // away — entries behind a dropped head must not wait for another send.
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(4);
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'good next' }] }),
    );
    expect(state.queuedBySession.sess_1 ?? []).toEqual([]);
  });

  it('drops (never duplicates) a flush whose failure was network-ambiguous', async () => {
    const state = createState();
    state.queuedBySession = { sess_1: [{ text: 'maybe sent', attachments: undefined, id: 'id-x' }] };
    apiMock.submitPrompt.mockRejectedValue(new TypeError('fetch failed'));
    const ws = useWorkspaceState(state, promptDeps());

    state.inFlightBySession = { sess_1: true };
    ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // The response was lost mid-flight — the daemon may already hold the
    // prompt. Re-queueing could submit it twice, so the entry is dropped
    // instead (the failure was surfaced via pushOperationFailure).
    expect(state.queuedBySession.sess_1 ?? []).toEqual([]);
  });

  it('resets the flush failure budget when the queue head changes', async () => {
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'turn.agent_busy', requestId: 'r' }),
    );
    const state = createState();
    state.queuedBySession = {
      sess_1: [
        { text: 'first', attachments: undefined, id: 'id-first' },
        { text: 'second', attachments: undefined, id: 'id-second' },
      ],
    };
    const ws = useWorkspaceState(state, promptDeps());
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const flushOnce = async () => {
      state.inFlightBySession = { sess_1: true };
      ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });
      await settle();
    };

    // 'first' fails once, then the user discards it.
    await flushOnce();
    ws.unqueue(0);
    expect(state.queuedBySession.sess_1?.map((e) => e.text)).toEqual(['second']);

    // 'second' gets its OWN budget: two failures leave it queued...
    await flushOnce();
    await flushOnce();
    expect(state.queuedBySession.sess_1?.map((e) => e.text)).toEqual(['second']);
    // ...and only the third consecutive failure drops it.
    await flushOnce();
    expect(state.queuedBySession.sess_1 ?? []).toEqual([]);
  });

  it('does not resurrect the queue when a submit fails after the session was forgotten', async () => {
    let rejectSubmit!: (err: Error) => void;
    apiMock.submitPrompt.mockImplementation(
      () =>
        new Promise<{ promptId: string }>((_resolve, reject) => {
          rejectSubmit = reject;
        }),
    );
    const state = createState();
    state.queuedBySession = {
      sess_1: [{ text: 'doomed', attachments: undefined, id: 'id-doomed' }],
    };
    const ws = useWorkspaceState(state, promptDeps());

    ws.finishPromptLocal('sess_1', { turnWasActive: true });
    expect(state.queuedBySession.sess_1 ?? []).toEqual([]);

    // Facade forget path (e.g. archive) while the submit is pending. The
    // daemon definitively rejects afterwards — even then, no resurrection.
    state.sessions = [];
    delete state.queuedBySession.sess_1;
    rejectSubmit(new DaemonApiError({ code: 50000, msg: 'network down', requestId: 'r' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(state.queuedBySession.sess_1).toBeUndefined();
  });
});

// Regression: a search-triggered full session-list reload must not clobber the
// live usage (context ring) with the list endpoint's all-zero placeholder.
describe('useWorkspaceState — loadAllSessions usage preservation', () => {
  beforeEach(() => {
    apiMock.listSessions.mockReset();
  });

  function liveUsage() {
    return {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 28772,
      contextLimit: 1048576,
      turnCount: 3,
    };
  }

  it('keeps the cached live usage when the reloaded row carries the placeholder', async () => {
    const state = createState();
    state.sessions = [{ ...createSession(), usage: liveUsage() }];
    apiMock.listSessions.mockResolvedValue({
      items: [{ ...createSession(), title: 'Fresh from server' }],
      hasMore: false,
    });
    const setSessions = vi.fn();
    const ws = useWorkspaceState(state, { ...createDeps(), setSessions });

    await ws.loadAllSessions();

    expect(setSessions).toHaveBeenCalledOnce();
    const next = setSessions.mock.calls[0][0];
    expect(next[0].title).toBe('Fresh from server');
    expect(next[0].usage).toEqual(liveUsage());
  });

  it('takes the server row as-is when there is no live usage to preserve', async () => {
    const state = createState();
    apiMock.listSessions.mockResolvedValue({ items: [createSession()], hasMore: false });
    const setSessions = vi.fn();
    const ws = useWorkspaceState(state, { ...createDeps(), setSessions });

    await ws.loadAllSessions();

    const next = setSessions.mock.calls[0][0];
    expect(next[0].usage.contextTokens).toBe(0);
  });
});

describe('useWorkspaceState — upsertWorkspacePreserveOrder hidden roots', () => {
  beforeEach(() => {
    installStorage(createMemoryStorage());
  });

  afterEach(() => {
    installStorage(createMemoryStorage());
  });

  it('clears a folded hidden entry when the same directory is re-added with a different spelling', () => {
    // mergeWorkspaces hides by folded key, so hiding `C:\Foo` then re-adding
    // `c:\foo` must un-hide too — otherwise the add succeeds but the group
    // never reappears.
    const state = createState();
    state.hiddenWorkspaceRoots = ['C:\\Users\\Foo\\Proj'];
    const ws = useWorkspaceState(state, createDeps());

    ws.upsertWorkspacePreserveOrder(workspace('wd_x', 'c:\\users\\foo\\proj', 'proj'));

    expect(state.hiddenWorkspaceRoots).toEqual([]);
    expect(state.workspaces[0]?.root).toBe('c:\\users\\foo\\proj');
  });

  it('keeps hidden entries for case-distinct POSIX roots', () => {
    const state = createState();
    state.hiddenWorkspaceRoots = ['/home/Foo'];
    const ws = useWorkspaceState(state, createDeps());

    ws.upsertWorkspacePreserveOrder(workspace('wd_y', '/home/foo', 'foo'));

    expect(state.hiddenWorkspaceRoots).toEqual(['/home/Foo']);
  });
});
