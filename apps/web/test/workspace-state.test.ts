// Scenario: workspace/session actions exposed by useWorkspaceState.
// Responsibilities: observable state and error reporting across load, paging, and user actions.
// Wiring: the composable is real; daemon requests and unrelated facade collaborators are stubbed.
// Run: pnpm --filter kimi-code-web exec vitest run test/workspace-state.test.ts

import { computed, ref, type Ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApprovalRequest, AppQuestionRequest, AppSession, AppTask, ManagedUserInfo, ManagedUserInfoResult } from '../src/api/types';
import { DaemonApiError } from '../src/api/errors';
import { createInitialState, reduceAppEvent } from '@moonshot-ai/web-core/api';
import { mergeWorkspaces } from '../src/lib/mergeWorkspaces';
import { foldDaemonThinkingLevel } from '../src/lib/modelThinking';
import { loadWorkspaceNameOverrides, saveWorkspaceNameOverrides } from '../src/lib/storage';
import { useWorkspaceState, forgetLocalTurnState, type UseWorkspaceStateDeps } from '../src/composables/client/useWorkspaceState';
import type { ExtendedState } from '../src/composables/useKimiWebClient';
import { clearTrace, traceKeyEvent } from '../src/debug/trace';

const apiMock = vi.hoisted(() => ({
  abortPrompt: vi.fn(),
  abortSession: vi.fn(),
  addWorkspace: vi.fn(),
  archiveSession: vi.fn(),
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
  getUserInfo: vi.fn(),
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
    thinkingBySession: {},
    pendingThinkingBySession: {},
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
    managedUserInfo: null,
    managedMembership: null,
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
    modelProvider: { resolveThinkingForPrompt: async () => undefined },
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
    initialized: ref(true),
    selectedDiffPath: ref(null),
    fileDiffLines: ref([]),
    fileDiffLoading: ref(false),
    fileDiffTexts: ref(null),
    fileDiffEmptyFile: ref(false),
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
  return { id, root, name,sessionCount: 0 };
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

  it('does not fall back to session abort once the daemon calls the prompt not-abortable', async () => {
    apiMock.abortPrompt.mockResolvedValue({ aborted: false });
    const state = createState();
    // Even with a main turn apparently in flight locally, a definitive
    // "not abortable" makes all local in-flight state stale — no fallback.
    state.turnActiveBySession = { sess_1: true };
    const workspace = useWorkspaceState(state, createDeps());

    await workspace.abortCurrentPrompt();

    expect(apiMock.abortPrompt).toHaveBeenCalledWith('sess_1', 'prompt_stale');
    expect(apiMock.abortSession).not.toHaveBeenCalled();
    expect(state.promptIdBySession).toEqual({});
    // A definitive "not abortable" also clears the stale main-turn flags.
    expect(state.turnActiveBySession).toEqual({ sess_1: false });
  });

  it('falls back to session abort for a fresh submit without a prompt id', async () => {
    apiMock.abortSession.mockResolvedValue({ aborted: true });
    const state = createState();
    // Just submitted: no prompt id captured yet, but a main turn is starting.
    state.promptIdBySession = {};
    state.sessions = [{ ...state.sessions[0]!, currentPromptId: '' }];
    state.inFlightBySession = { sess_1: true };
    const workspace = useWorkspaceState(state, createDeps());

    await workspace.abortCurrentPrompt();

    expect(apiMock.abortPrompt).not.toHaveBeenCalled();
    expect(apiMock.abortSession).toHaveBeenCalledWith('sess_1');
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
    // The session-level fallback requires a main turn still in flight.
    state.turnActiveBySession = { sess_1: true };
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
    expect(apiMock.exportSession).toHaveBeenCalledWith('sess_1', expect.any(String), {
      desktop: false,
    });
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
        { id: 'wd_current', root: '/agent/GEO', name: 'GEO',sessionCount: 0 },
        { id: 'wd_legacy', root: '/agent/GEO', name: 'GEO',sessionCount: 0 },
      ],
      // A session whose daemon workspace_id points at the dropped (legacy) entry.
      sessions: [{ id: 's1', cwd: '/agent/GEO', workspaceId: 'wd_legacy' }],
      hiddenWorkspaceRoots: [],
      sessionsHasMoreByWorkspace: { wd_current: false },
      activeRoot: undefined,
      activeBranch: null,
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
        { id: 'wd_a', root: '/agent/A', name: 'A',sessionCount: 1 },
      ],
      sessions: [
        { id: 's1', cwd: '/agent/A', workspaceId: 'wd_a' },
        { id: 's2', cwd: '/agent/B', workspaceId: 'wd_b' },
      ],
      hiddenWorkspaceRoots: [],
      sessionsHasMoreByWorkspace: {},
      activeRoot: undefined,
      activeBranch: null,
    });

    expect(result.map((w) => w.root)).toEqual(['/agent/A', '/agent/B']);
    expect(result.find((w) => w.root === '/agent/B')?.id).toBe('wd_b');
  });

  it('hides workspaces whose root the user removed', () => {
    const result = mergeWorkspaces({
      workspaces: [
        { id: 'wd_a', root: '/agent/A', name: 'A',sessionCount: 1 },
      ],
      sessions: [{ id: 's1', cwd: '/agent/A', workspaceId: 'wd_a' }],
      hiddenWorkspaceRoots: ['/agent/A'],
      sessionsHasMoreByWorkspace: {},
      activeRoot: undefined,
      activeBranch: null,
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
  const registered = { id: 'wd_1', root: '/abs/path', name: 'A',sessionCount: 0 };
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
        resolveThinkingForPrompt: async () => undefined,
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
    expect(activateSkill).toHaveBeenCalledWith('pre-changelog', undefined, undefined, 'sess_new', {
      skipThinkingPersist: true,
    });
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });

  it('carries the draft thinking pick into the new session own entry', async () => {
    // A level picked on the empty composer has no session to live in yet; the
    // draft transfer seeds it so the first action submits the pick, not the
    // catalog default.
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const state = createState();
    state.thinking = 'max';
    const ws = useWorkspaceState(state, deps);

    await ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');

    expect(state.thinkingBySession['sess_new']).toBe('max');
  });

  it('captures the draft thinking pick before the creation awaits', async () => {
    // A concurrent session switch mid-creation re-resolves rawState.thinking
    // for the other session — the seed must come from the pre-await capture.
    let resolveCreate!: (session: typeof newSession) => void;
    apiMock.createSession.mockReturnValue(
      new Promise<typeof newSession>((r) => {
        resolveCreate = r;
      }),
    );
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const state = createState();
    state.thinking = 'max';
    const ws = useWorkspaceState(state, deps);

    const pending = ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');
    await new Promise((r) => setTimeout(r, 0));
    // The user switches to another session while createSession is in flight;
    // the watcher would re-resolve rawState.thinking to that session's level.
    state.thinking = 'low';
    resolveCreate(newSession);
    await pending;

    expect(state.thinkingBySession['sess_new']).toBe('max');
  });

  it('passes through skill args', async () => {
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const ws = useWorkspaceState(createState(), deps);

    await ws.startSessionAndActivateSkill('wd_1', 'write-goal', 'ship it');

    expect(activateSkill).toHaveBeenCalledWith('write-goal', 'ship it', undefined, 'sess_new', {
      skipThinkingPersist: true,
    });
  });

  it('awaits the profile POST before activating, so draft controls apply first', async () => {
    // Skill activation carries no per-prompt controls (plan/swarm plus
    // permission), so the daemon never sees the ones the user set on the
    // draft.
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
      { model: undefined, planMode: true, swarmMode: true, permissionMode: 'auto', thinking: 'high' },
      'sess_new',
    );
    expect(activateSkill).not.toHaveBeenCalled();

    resolveProfile(true);
    await pending;

    expect(activateSkill).toHaveBeenCalledWith('pre-changelog', undefined, undefined, 'sess_new', {
      skipThinkingPersist: true,
    });
  });

  it('writes the seeded draft thinking in the profile patch so the /status fold cannot clobber it', async () => {
    // The chain-tail /status fold would otherwise overwrite the seeded pick
    // with the daemon's default — the pick must ride THIS patch.
    const activateSkill2 = vi.fn().mockResolvedValue(undefined);
    const persistSessionProfile2 = vi.fn().mockResolvedValue(true);
    const state2 = createState();
    state2.thinking = 'max';
    const base = skillDeps(activateSkill2);
    const deps2: UseWorkspaceStateDeps = {
      ...base,
      persistSessionProfile: persistSessionProfile2,
      modelProvider: {
        ...(base.modelProvider as unknown as Record<string, unknown>),
        // Mirror the real gated read: the session's own seeded entry wins.
        resolveThinkingForPrompt: async (sid: string) => state2.thinkingBySession[sid],
      } as unknown as UseWorkspaceStateDeps['modelProvider'],
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
    expect(patch).toMatchObject({ model: 'kimi-code', planMode: true, swarmMode: false, thinking: 'max' });
    expect(activateSkill2).toHaveBeenCalledWith('pre-changelog', undefined, undefined, 'sess_new', {
      skipThinkingPersist: true,
    });
  });

  it('seeds the draft thinking pick before selectSession flips the active session', async () => {
    // The thinking watcher re-resolves rawState.thinking from the new session's
    // own entry the moment selection changes — a late seed flashes the default.
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const state = createState();
    state.thinking = 'max';
    deps.upsertSessionFront = vi.fn((s) => {
      state.sessions = [s, ...state.sessions.filter((x) => x.id !== s.id)];
    });
    let seededWhenSelected: string | undefined;
    deps.syncSessionFromSnapshot = vi.fn(async (sessionId: string) => {
      seededWhenSelected = state.thinkingBySession[sessionId];
      return 'ok' as const;
    });
    const ws = useWorkspaceState(state, deps);

    await ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');

    expect(seededWhenSelected).toBe('max');
    // A fresh-session /status fold would only report daemon defaults over the
    // seeds — including the one fired inside the snapshot sync.
    expect(deps.refreshSessionStatus).not.toHaveBeenCalled();
    expect(deps.syncSessionFromSnapshot).toHaveBeenCalledWith('sess_new', { skipStatusRefresh: true });
  });

  it('shields the pending pick from daemon reports that predate the persist', async () => {
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    let releasePersist!: (persisted: boolean) => void;
    const persistSessionProfile = vi.fn(
      () => new Promise<boolean>((r) => { releasePersist = r; }),
    );
    const deps = { ...skillDeps(activateSkill), persistSessionProfile };
    const state = createState();
    state.thinking = 'max';
    const ws = useWorkspaceState(state, deps);

    const pending = ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');
    // Reach the in-flight persist: the pick is seeded but unacknowledged.
    await new Promise((r) => setTimeout(r, 0));
    expect(state.pendingThinkingBySession['sess_new']).toBeDefined();
    // A stale daemon report must not fold over the unacknowledged pick.
    foldDaemonThinkingLevel(state, 'sess_new', 'high');
    expect(state.thinkingBySession['sess_new']).toBe('max');

    releasePersist(true);
    await pending;

    expect(state.thinkingBySession['sess_new']).toBe('max');
    expect(activateSkill).toHaveBeenCalledWith('pre-changelog', undefined, undefined, 'sess_new', {
      skipThinkingPersist: true,
    });
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
  const registered = { id: 'wd_1', root: '/abs/path', name: 'A',sessionCount: 0 };
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
        resolveThinkingForPrompt: async () => undefined,
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

    await expect(ws.createGoal('improve test coverage')).resolves.toBeNull();

    expect(deps.pushOperationFailure).toHaveBeenCalledWith('createGoal', err);
    expect(apiMock.updateSession).not.toHaveBeenCalled();
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — startSessionAndOpenSideChat', () => {
  const registered = { id: 'wd_1', root: '/abs/path', name: 'A',sessionCount: 0 };
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
        resolveThinkingForPrompt: async () => undefined,
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

describe('useWorkspaceState — managed account profile', () => {
  const profile: ManagedUserInfo = {
    userId: 'u_1',
    nickname: 'Kimi User',
    status: 'active',
    region: 'cn',
    userLevel: 3,
    userLevelName: 'Vivace',
    domain: 1,
    domainName: 'DOMAIN_EXAMPLE',
    avatar: 'https://cdn.example/avatar.png',
  };

  beforeEach(() => {
    apiMock.getAuth.mockReset().mockResolvedValue({
      ready: true,
      defaultModel: 'kimi-code',
      managedProvider: { status: 'authenticated' },
    });
    apiMock.getUserInfo.mockReset().mockResolvedValue({ kind: 'ok', userInfo: profile });
  });

  function createAuthDeps(connectIssue: Ref<string | null>): UseWorkspaceStateDeps {
    return {
      ...createDeps(),
      connectIssue,
    } as unknown as UseWorkspaceStateDeps;
  }

  // The getUserInfo chain is fire-and-forget; a macrotask boundary drains its
  // microtasks (the .catch on a rejection settles one tick after .then).
  function flushUserInfo(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('stores the profile after an authenticated checkAuth (fire-and-forget /oauth/userinfo)', async () => {
    const state = createState();
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

    await expect(ws.checkAuth()).resolves.toBe('proceed');
    await flushUserInfo();

    expect(apiMock.getUserInfo).toHaveBeenCalledTimes(1);
    expect(state.managedUserInfo).toEqual(profile);
  });

  it('clears the profile when /oauth/userinfo answers the error shape', async () => {
    const state = createState();
    state.managedUserInfo = profile;
    apiMock.getUserInfo.mockResolvedValue({ kind: 'error', message: 'endpoint unavailable' });
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

    await ws.checkAuth();
    await flushUserInfo();

    expect(state.managedUserInfo).toBeNull();
  });

  it('clears the profile when /oauth/userinfo rejects (older daemon / transient failure)', async () => {
    const state = createState();
    state.managedUserInfo = profile;
    apiMock.getUserInfo.mockRejectedValue(new Error('404'));
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

    await ws.checkAuth();
    await flushUserInfo();

    expect(state.managedUserInfo).toBeNull();
  });

  it('skips /oauth/userinfo and clears the profile when not authenticated', async () => {
    const state = createState();
    state.managedUserInfo = profile;
    apiMock.getAuth.mockResolvedValue({
      ready: true,
      defaultModel: 'kimi-code',
      managedProvider: null,
    });
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

    await ws.checkAuth();
    await flushUserInfo();

    expect(apiMock.getUserInfo).not.toHaveBeenCalled();
    expect(state.managedUserInfo).toBeNull();
  });

  it('does not resurrect the profile when a logout lands while /oauth/userinfo is in flight', async () => {
    const state = createState();
    let resolveUserInfo!: (value: ManagedUserInfoResult) => void;
    apiMock.getUserInfo.mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((done) => {
          resolveUserInfo = done;
        }),
    );
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

    await ws.checkAuth();
    // Logout's own checkAuth flips the status before the profile lands.
    state.managedProviderStatus = null;
    state.managedUserInfo = null;
    resolveUserInfo({ kind: 'ok', userInfo: profile });
    await flushUserInfo();

    expect(state.managedUserInfo).toBeNull();
  });

  it('lets the newest request win when overlapping checkAuth profile fetches race', async () => {
    const state = createState();
    const deferreds: Array<{
      resolve: (value: ManagedUserInfoResult) => void;
      reject: (err: Error) => void;
    }> = [];
    apiMock.getUserInfo.mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((resolve, reject) => {
          deferreds.push({ resolve, reject });
        }),
    );
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));
    const newestProfile = { ...profile, nickname: 'Newest' };

    await ws.checkAuth();
    await ws.checkAuth();
    expect(apiMock.getUserInfo).toHaveBeenCalledTimes(2);
    const [stale, newest] = deferreds;
    if (!stale || !newest) throw new Error('expected two in-flight requests');

    // The newer request settles first and stores its profile…
    newest.resolve({ kind: 'ok', userInfo: newestProfile });
    await flushUserInfo();
    expect(state.managedUserInfo).toEqual(newestProfile);

    // …and the superseded request's late answer must not overwrite it.
    stale.resolve({ kind: 'ok', userInfo: profile });
    await flushUserInfo();
    expect(state.managedUserInfo).toEqual(newestProfile);
  });

  it('does not let a superseded rejection clear the profile written by the newest request', async () => {
    const state = createState();
    const deferreds: Array<{
      resolve: (value: ManagedUserInfoResult) => void;
      reject: (err: Error) => void;
    }> = [];
    apiMock.getUserInfo.mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((resolve, reject) => {
          deferreds.push({ resolve, reject });
        }),
    );
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

    await ws.checkAuth();
    await ws.checkAuth();
    const [stale, newest] = deferreds;
    if (!stale || !newest) throw new Error('expected two in-flight requests');

    newest.resolve({ kind: 'ok', userInfo: profile });
    await flushUserInfo();
    expect(state.managedUserInfo).toEqual(profile);

    stale.reject(new Error('404'));
    await flushUserInfo();
    expect(state.managedUserInfo).toEqual(profile);
  });

  it('lets the last-issued checkAuth win when the first call\'s /auth is slower', async () => {
    const state = createState();
    const authResponse = {
      ready: true,
      defaultModel: 'kimi-code',
      managedProvider: { status: 'authenticated' },
    };
    let resolveFirstAuth!: (value: typeof authResponse) => void;
    apiMock.getAuth
      .mockImplementationOnce(
        () =>
          new Promise<typeof authResponse>((resolve) => {
            resolveFirstAuth = resolve;
          }),
      )
      .mockResolvedValue(authResponse);
    const deferreds: Array<{
      resolve: (value: ManagedUserInfoResult) => void;
      reject: (err: Error) => void;
    }> = [];
    apiMock.getUserInfo.mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((resolve, reject) => {
          deferreds.push({ resolve, reject });
        }),
    );
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));
    const newestProfile = { ...profile, nickname: 'Newest' };

    // The first call's /auth is slower: the second call settles first and its
    // userinfo writes the profile.
    const first = ws.checkAuth();
    await expect(ws.checkAuth()).resolves.toBe('proceed');
    expect(apiMock.getUserInfo).toHaveBeenCalledTimes(1);
    const [secondUserInfo] = deferreds;
    if (!secondUserInfo) throw new Error('expected an in-flight userinfo request');
    secondUserInfo.resolve({ kind: 'ok', userInfo: newestProfile });
    await flushUserInfo();
    expect(state.managedUserInfo).toEqual(newestProfile);

    // The slower first call's /auth finally lands; its superseded userinfo
    // rejection must not clear the newer profile.
    resolveFirstAuth(authResponse);
    await expect(first).resolves.toBe('proceed');
    expect(apiMock.getUserInfo).toHaveBeenCalledTimes(2);
    const [, firstUserInfo] = deferreds;
    if (!firstUserInfo) throw new Error('expected a second in-flight userinfo request');
    firstUserInfo.reject(new Error('404'));
    await flushUserInfo();
    expect(state.managedUserInfo).toEqual(newestProfile);
  });

  it('derives member when the profile loads', async () => {
    const state = createState();
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

    await ws.checkAuth();
    await flushUserInfo();

    expect(state.managedMembership).toBe('member');
  });

  it('derives free when the loaded profile reports the free user level', async () => {
    const state = createState();
    apiMock.getUserInfo.mockResolvedValue({ kind: 'ok', userInfo: { ...profile, userLevel: 10 } });
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

    await ws.checkAuth();
    await flushUserInfo();

    expect(state.managedMembership).toBe('free');
  });

  it('derives free when userinfo is rejected with 402 (the non-member signal)', async () => {
    const state = createState();
    apiMock.getUserInfo.mockResolvedValue({ kind: 'error', message: 'payment required', status: 402 });
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

    await ws.checkAuth();
    await flushUserInfo();

    expect(state.managedMembership).toBe('free');
  });

  it.each([403, 500])(
    'stays unknown when userinfo fails with %i (not the non-member signal)',
    async (status) => {
      const state = createState();
      apiMock.getUserInfo.mockResolvedValue({ kind: 'error', message: 'boom', status });
      const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

      await ws.checkAuth();
      await flushUserInfo();

      expect(state.managedMembership).toBeNull();
    },
  );

  it('stays unknown when userinfo rejects (a transient failure must not be mislabeled)', async () => {
    const state = createState();
    state.managedMembership = 'free';
    apiMock.getUserInfo.mockRejectedValue(new Error('network down'));
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

    await ws.checkAuth();
    await flushUserInfo();

    expect(state.managedMembership).toBeNull();
  });

  it('clears the membership when not authenticated', async () => {
    const state = createState();
    state.managedMembership = 'free';
    apiMock.getAuth.mockResolvedValue({
      ready: true,
      defaultModel: 'kimi-code',
      managedProvider: null,
    });
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

    await ws.checkAuth();
    await flushUserInfo();

    expect(apiMock.getUserInfo).not.toHaveBeenCalled();
    expect(state.managedMembership).toBeNull();
  });

  it('probeManagedMembership awaits the fetch and derives the membership', async () => {
    const state = createState();
    const deferreds: Array<{ resolve: (value: ManagedUserInfoResult) => void }> = [];
    apiMock.getUserInfo.mockImplementation(
      () =>
        new Promise<ManagedUserInfoResult>((resolve) => {
          deferreds.push({ resolve });
        }),
    );
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));
    // Authenticate first (checkAuth fires its own fire-and-forget probe).
    await ws.checkAuth();

    let settled = false;
    const probe = ws.probeManagedMembership().then(() => {
      settled = true;
    });
    expect(apiMock.getUserInfo).toHaveBeenCalledTimes(2);
    await flushUserInfo();
    // The probe must not settle while its fetch is still in flight.
    expect(settled).toBe(false);

    deferreds[1]?.resolve({ kind: 'error', message: 'payment required', status: 402 });
    await probe;
    expect(settled).toBe(true);
    expect(state.managedMembership).toBe('free');
  });

  it('probeManagedMembership is a no-op when not authenticated', async () => {
    const state = createState();
    const ws = useWorkspaceState(state, createAuthDeps(ref(null)));

    await ws.probeManagedMembership();

    expect(apiMock.getUserInfo).not.toHaveBeenCalled();
  });
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

  it('stops a global session walk before requesting another page when invalidated', async () => {
    const firstPage = { ...createSession(), id: 'sess_first' };
    let shouldContinue = true;
    apiMock.listSessions.mockImplementation(async () => {
      shouldContinue = false;
      return { items: [firstPage], hasMore: true };
    });
    const { workspaceState } = createSessionLoadRig([]);

    const result = await workspaceState.listAllSessionsGlobal({
      shouldContinue: () => shouldContinue,
    });

    expect(apiMock.listSessions).toHaveBeenCalledOnce();
    expect(result).toEqual({ sessions: [firstPage], error: undefined });
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
        resolveThinkingForPrompt: async () => undefined,
      } as unknown as UseWorkspaceStateDeps['modelProvider'],
      ...overrides,
    };
  }

  beforeEach(() => {
    apiMock.submitPrompt.mockReset();
    apiMock.submitPrompt.mockResolvedValue({
      promptId: 'prompt_new',
      userMessageId: 'message_new',
    });
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

    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
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

  it('drains one queued prompt when the finished turn was locally witnessed', async () => {
    const state = createState();
    state.queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    const ws = useWorkspaceState(state, promptDeps());

    ws.finishPromptLocal('sess_1', { turnWasActive: true });

    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
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
    const resolveThinkingForPrompt = vi.fn(async (_sid: string | null, id: string | undefined) =>
      id === 'provider/model-a' ? 'low' : undefined,
    );
    const ws = useWorkspaceState(
      state,
      promptDeps({
        modelProvider: {
          models: ref([]),
          resolveThinkingForPrompt,
        } as unknown as UseWorkspaceStateDeps['modelProvider'],
      }),
    );

    ws.handleSessionSnapshot('sess_a', { inFlightTurn: null, busy: true });

    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalled());
    expect(resolveThinkingForPrompt).toHaveBeenCalledWith('sess_a', 'provider/model-a');
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
          resolveThinkingForPrompt: async () => undefined,
        } as unknown as UseWorkspaceStateDeps['modelProvider'],
      }),
    );

    ws.handleSessionSnapshot('sess_a', { inFlightTurn: null, busy: true });

    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalled());
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
    let resolveSubmit!: (value: { promptId: string; userMessageId: string }) => void;
    apiMock.submitPrompt.mockImplementation(
      () =>
        new Promise<{ promptId: string; userMessageId: string }>((resolve) => {
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

    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalled());
    resolveSubmit({ promptId: 'prompt_new', userMessageId: 'message_new' });
    await pendingSubmit;
    expect(ws.localTurnStartState('sess_1').pending).toBe(false);
    expect(retrySnapshot).toHaveBeenCalledOnce();
  });

  function createPromptMessageRig() {
    const state = createState();
    let optimisticId = 0;
    const deps = promptDeps({
      activity: computed(() => 'idle'),
      nextOptimisticMsgId: () => `msg_opt_${++optimisticId}`,
      updateSessionMessages: (sessionId, update) => {
        state.messagesBySession = {
          ...state.messagesBySession,
          [sessionId]: update(state.messagesBySession[sessionId] ?? []),
        };
      },
    });
    return { state, workspaceState: useWorkspaceState(state, deps) };
  }

  function applyUserEcho(
    state: ExtendedState,
    input: { promptId: string; userMessageId: string; text: string; seq: number },
  ): void {
    const next = reduceAppEvent(
      state,
      {
        type: 'messageCreated',
        message: {
          id: input.userMessageId,
          sessionId: 'sess_1',
          role: 'user',
          content: [{ type: 'text', text: input.text }],
          createdAt: `2026-01-01T00:00:0${input.seq}.000Z`,
          promptId: input.promptId,
        },
      },
      { sessionId: 'sess_1', seq: input.seq },
    );
    state.messagesBySession = next.messagesBySession;
  }

  it('reconciles the POST-first user echo by prompt and user-message ids', async () => {
    const { state, workspaceState } = createPromptMessageRig();
    apiMock.submitPrompt.mockResolvedValue({
      promptId: 'prompt_1',
      userMessageId: 'message_1',
    });

    await workspaceState.submitPromptInternal('sess_1', 'hello');
    applyUserEcho(state, {
      promptId: 'prompt_1',
      userMessageId: 'message_1',
      text: 'hello',
      seq: 1,
    });

    expect(state.messagesBySession.sess_1).toHaveLength(1);
    expect(state.messagesBySession.sess_1?.[0]).toMatchObject({
      id: 'msg_opt_1',
      promptId: 'prompt_1',
      userMessageId: 'message_1',
    });
  });

  it('reconciles a WS-first user echo after the POST response supplies stable ids', async () => {
    let resolveSubmit!: (value: { promptId: string; userMessageId: string }) => void;
    apiMock.submitPrompt.mockImplementation(
      () =>
        new Promise<{ promptId: string; userMessageId: string }>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const { state, workspaceState } = createPromptMessageRig();
    const pending = workspaceState.submitPromptInternal('sess_1', 'hello');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());

    applyUserEcho(state, {
      promptId: 'prompt_1',
      userMessageId: 'message_1',
      text: 'server-resolved hello',
      seq: 1,
    });
    expect(state.messagesBySession.sess_1?.map((message) => message.id)).toEqual([
      'msg_opt_1',
      'message_1',
    ]);

    resolveSubmit({ promptId: 'prompt_1', userMessageId: 'message_1' });
    await pending;
    expect(state.messagesBySession.sess_1).toHaveLength(1);
    expect(state.messagesBySession.sess_1?.[0]).toMatchObject({
      id: 'msg_opt_1',
      promptId: 'prompt_1',
      userMessageId: 'message_1',
      content: [{ type: 'text', text: 'server-resolved hello' }],
    });
  });

  it('does not merge another client prompt into the local pending submission', async () => {
    let resolveSubmit!: (value: { promptId: string; userMessageId: string }) => void;
    apiMock.submitPrompt.mockImplementation(
      () =>
        new Promise<{ promptId: string; userMessageId: string }>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const { state, workspaceState } = createPromptMessageRig();
    const pending = workspaceState.submitPromptInternal('sess_1', 'local');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());

    applyUserEcho(state, {
      promptId: 'prompt_remote',
      userMessageId: 'message_remote',
      text: 'remote',
      seq: 1,
    });
    resolveSubmit({ promptId: 'prompt_local', userMessageId: 'message_local' });
    await pending;

    expect(state.messagesBySession.sess_1).toEqual([
      expect.objectContaining({
        id: 'msg_opt_1',
        promptId: 'prompt_local',
        userMessageId: 'message_local',
        content: [{ type: 'text', text: 'local' }],
      }),
      expect.objectContaining({
        id: 'message_remote',
        promptId: 'prompt_remote',
        content: [{ type: 'text', text: 'remote' }],
      }),
    ]);

    applyUserEcho(state, {
      promptId: 'prompt_local',
      userMessageId: 'message_local',
      text: 'server-resolved local',
      seq: 2,
    });
    expect(state.messagesBySession.sess_1).toEqual([
      expect.objectContaining({
        id: 'msg_opt_1',
        promptId: 'prompt_local',
        userMessageId: 'message_local',
        content: [{ type: 'text', text: 'server-resolved local' }],
      }),
      expect.objectContaining({
        id: 'message_remote',
        promptId: 'prompt_remote',
      }),
    ]);
  });

  it('keeps a WS-confirmed user message when the POST response is lost', async () => {
    let rejectSubmit!: (error: unknown) => void;
    apiMock.submitPrompt.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSubmit = reject;
        }),
    );
    const { state, workspaceState } = createPromptMessageRig();
    const pending = workspaceState.submitPromptInternal('sess_1', 'hello');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());

    applyUserEcho(state, {
      promptId: 'prompt_1',
      userMessageId: 'message_1',
      text: 'hello',
      seq: 1,
    });
    rejectSubmit(new TypeError('response lost'));

    await expect(pending).resolves.toBe('uncertain');
    expect(state.messagesBySession.sess_1).toEqual([
      expect.objectContaining({
        id: 'message_1',
        promptId: 'prompt_1',
      }),
    ]);
  });

  it('keeps consecutive equal-text submissions as two user messages', async () => {
    const { state, workspaceState } = createPromptMessageRig();
    apiMock.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt_1', userMessageId: 'message_1' })
      .mockResolvedValueOnce({ promptId: 'prompt_2', userMessageId: 'message_2' });

    await workspaceState.submitPromptInternal('sess_1', 'repeat');
    applyUserEcho(state, {
      promptId: 'prompt_1',
      userMessageId: 'message_1',
      text: 'repeat',
      seq: 1,
    });
    await workspaceState.submitPromptInternal('sess_1', 'repeat');
    applyUserEcho(state, {
      promptId: 'prompt_2',
      userMessageId: 'message_2',
      text: 'repeat',
      seq: 2,
    });

    expect(state.messagesBySession.sess_1?.map((message) => message.userMessageId)).toEqual([
      'message_1',
      'message_2',
    ]);
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
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalled());
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

describe('useWorkspaceState — archiveSession backfill and cursor re-anchoring', () => {
  const WS = 'wd_1';
  const BASE = Date.parse('2026-01-10T00:00:00.000Z');

  beforeEach(() => {
    apiMock.archiveSession.mockReset().mockResolvedValue({ archived: true });
    apiMock.listSessions.mockReset();
  });

  function wsSession(id: string, index: number): AppSession {
    return {
      ...createSession(),
      id,
      workspaceId: WS,
      updatedAt: new Date(BASE - index * 1000).toISOString(),
    };
  }

  function createArchiveRig(loaded: AppSession[], cursor: string | undefined, hasMore: boolean) {
    const state = createState();
    state.sessions = [...loaded];
    state.sessionsCursorByWorkspace = { [WS]: cursor };
    state.sessionsHasMoreByWorkspace = { [WS]: hasMore };
    const deps = {
      ...createDeps(),
      sideChat: { clearSideChatForSession: vi.fn() },
      forgetSession: vi.fn((id: string) => {
        state.sessions = state.sessions.filter((s) => s.id !== id);
      }),
      setSessions: vi.fn((next: AppSession[]) => {
        state.sessions = next;
      }),
      workspaceIdForSession: vi.fn(
        (s: { workspaceId?: string; cwd: string }) => s.workspaceId ?? s.cwd,
      ),
    } as unknown as UseWorkspaceStateDeps;
    return { state, deps, workspaceState: useWorkspaceState(state, deps) };
  }

  // The backfill is fire-and-forget; a macrotask boundary drains its chain of
  // immediately-resolving fetches.
  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  const ids = (sessions: AppSession[]) => sessions.map((s) => s.id);

  it('archiving a middle row fetches the next page to restore the loaded count', async () => {
    const loaded = [1, 2, 3, 4, 5].map((i) => wsSession(`s${i}`, i - 1));
    const page2 = [6, 7, 8, 9, 10].map((i) => wsSession(`s${i}`, i - 1));
    apiMock.listSessions.mockResolvedValue({ items: page2, hasMore: true });
    const { state, workspaceState } = createArchiveRig(loaded, 's5', true);

    await workspaceState.archiveSession('s2');
    await flush();

    expect(apiMock.listSessions).toHaveBeenCalledTimes(1);
    expect(apiMock.listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's5',
      excludeEmpty: true,
    });
    expect(ids(state.sessions)).toEqual(['s1', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']);
    expect(state.sessionsCursorByWorkspace[WS]).toBe('s10');
    expect(state.sessionsHasMoreByWorkspace[WS]).toBe(true);
  });

  it('re-anchors the cursor first when the archived session was the cursor', async () => {
    const loaded = [1, 2, 3, 4, 5].map((i) => wsSession(`s${i}`, i - 1));
    apiMock.listSessions.mockResolvedValue({ items: [wsSession('s6', 5)], hasMore: false });
    const { state, workspaceState } = createArchiveRig(loaded, 's5', true);

    await workspaceState.archiveSession('s5');
    await flush();

    // The fetch must page from the new oldest loaded session — the archived
    // id would resolve to an empty, terminal page on the server.
    expect(apiMock.listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      excludeEmpty: true,
    });
    expect(state.sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(state.sessionsHasMoreByWorkspace[WS]).toBe(false);
    expect(ids(state.sessions)).toEqual(['s1', 's2', 's3', 's4', 's6']);
  });

  it('re-anchors an emptied workspace with a fresh first page (no before_id)', async () => {
    apiMock.listSessions.mockResolvedValue({
      items: [wsSession('s2', 1), wsSession('s3', 2)],
      hasMore: false,
    });
    const { state, workspaceState } = createArchiveRig([wsSession('s1', 0)], 's1', true);

    await workspaceState.archiveSession('s1');
    await flush();

    expect(apiMock.listSessions).toHaveBeenCalledTimes(1);
    expect(apiMock.listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      excludeEmpty: true,
    });
    expect(ids(state.sessions)).toEqual(['s2', 's3']);
    expect(state.sessionsCursorByWorkspace[WS]).toBe('s3');
    expect(state.sessionsHasMoreByWorkspace[WS]).toBe(false);
  });

  it('does not fetch when the server has no more pages — the group just shrinks', async () => {
    const loaded = [1, 2, 3, 4, 5].map((i) => wsSession(`s${i}`, i - 1));
    const { state, workspaceState } = createArchiveRig(loaded, 's5', false);

    await workspaceState.archiveSession('s2');
    await flush();

    expect(apiMock.listSessions).not.toHaveBeenCalled();
    expect(ids(state.sessions)).toEqual(['s1', 's3', 's4', 's5']);
  });

  it('stops after one attempt when the backfill fetch fails (no retry spin)', async () => {
    const loaded = [1, 2, 3, 4, 5].map((i) => wsSession(`s${i}`, i - 1));
    apiMock.listSessions.mockRejectedValue(new Error('network down'));
    const { state, deps, workspaceState } = createArchiveRig(loaded, 's5', true);

    await workspaceState.archiveSession('s2');
    await flush();

    expect(apiMock.listSessions).toHaveBeenCalledTimes(1);
    expect(deps.pushOperationFailure).toHaveBeenCalled();
    expect(ids(state.sessions)).toEqual(['s1', 's3', 's4', 's5']);
  });

  it('stops after one attempt when the emptied-workspace reload fails', async () => {
    apiMock.listSessions.mockRejectedValue(new Error('network down'));
    const { state, deps, workspaceState } = createArchiveRig([wsSession('s1', 0)], 's1', true);

    await workspaceState.archiveSession('s1');
    await flush();

    expect(apiMock.listSessions).toHaveBeenCalledTimes(1);
    expect(deps.pushOperationFailure).toHaveBeenCalled();
    expect(state.sessions).toEqual([]);
    expect(state.sessionsHasMoreByWorkspace[WS]).toBe(true);
  });

  it('re-anchors to the contiguous predecessor, not an off-page loaded row', async () => {
    // s20 was appended out of band (deep link / search) — it must not become
    // the cursor when the contiguous cursor row is archived, or the next page
    // would skip every session between them.
    const loaded = [1, 2, 3, 4, 5].map((i) => wsSession(`s${i}`, i - 1));
    loaded.push(wsSession('s20', 19));
    apiMock.listSessions.mockResolvedValue({ items: [wsSession('s6', 5)], hasMore: true });
    const { state, workspaceState } = createArchiveRig(loaded, 's5', true);

    await workspaceState.archiveSession('s5');
    await flush();

    // The backfill must page from the contiguous predecessor s4 — never from
    // the off-page s20.
    expect(apiMock.listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      excludeEmpty: true,
    });
    expect(state.sessionsCursorByWorkspace[WS]).toBe('s6');
  });

  it('retries a stale load-more from the re-anchored cursor instead of discarding', async () => {
    const loaded = [1, 2, 3, 4, 5].map((i) => wsSession(`s${i}`, i - 1));
    const resolvers: Array<(page: { items: AppSession[]; hasMore: boolean }) => void> = [];
    apiMock.listSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { state, workspaceState } = createArchiveRig(loaded, 's5', true);

    const pending = workspaceState.loadMoreSessions(WS);
    await workspaceState.archiveSession('s5'); // re-anchors the cursor to s4 mid-flight
    // The stale page (anchored to the archived s5) must not be committed —
    // the request is re-issued from the re-anchored cursor instead.
    resolvers[0]!({ items: [], hasMore: false });
    await flush();
    expect(apiMock.listSessions).toHaveBeenCalledTimes(2);
    expect(apiMock.listSessions).toHaveBeenNthCalledWith(2, {
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      excludeEmpty: true,
    });
    resolvers[1]!({ items: [wsSession('s6', 5)], hasMore: false });
    await pending;
    await flush();

    // The retry restores the row the backfill skipped while it was locked
    // out by this in-flight request.
    expect(state.sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(state.sessionsHasMoreByWorkspace[WS]).toBe(false);
    expect(ids(state.sessions)).toEqual(['s1', 's2', 's3', 's4', 's6']);
  });

  it('stops after the page budget when backfill pages are all child sessions', async () => {
    const loaded = [1, 2, 3, 4, 5].map((i) => wsSession(`s${i}`, i - 1));
    // Child-only pages: the cursor advances, the visible (non-child) count
    // never does — the budget, not the no-progress guard, must stop the walk.
    const childPage = (page: number) =>
      Array.from({ length: 5 }, (_, i) => ({
        ...wsSession(`c${page}_${i}`, 5 + page * 5 + i),
        parentSessionId: 'parent_1',
      }));
    apiMock.listSessions.mockImplementation(async ({ beforeId }: { beforeId?: string }) => {
      const page = beforeId === 's5' ? 0 : beforeId === 'c0_4' ? 1 : 2;
      return { items: childPage(page), hasMore: true };
    });
    const { state, workspaceState } = createArchiveRig(loaded, 's5', true);

    await workspaceState.archiveSession('s1');
    await flush();

    expect(apiMock.listSessions).toHaveBeenCalledTimes(3);
    expect(ids(state.sessions).filter((id) => !id.startsWith('c'))).toEqual([
      's2',
      's3',
      's4',
      's5',
    ]);
  });

  it('still backfills when another client removes the row while the POST is in flight', async () => {
    const loaded = [1, 2, 3, 4, 5].map((i) => wsSession(`s${i}`, i - 1));
    apiMock.listSessions.mockResolvedValue({ items: [wsSession('s6', 5)], hasMore: false });
    const { state, workspaceState } = createArchiveRig(loaded, 's5', true);
    // Simulate the WS-driven removal landing before the archive POST resolves.
    apiMock.archiveSession.mockImplementation(async () => {
      state.sessions = state.sessions.filter((s) => s.id !== 's5');
      return { archived: true };
    });

    await workspaceState.archiveSession('s5');
    await flush();

    // The re-anchor and backfill must run from the state captured before the
    // POST — paging from the contiguous predecessor s4.
    expect(apiMock.listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      excludeEmpty: true,
    });
    expect(state.sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(ids(state.sessions)).toEqual(['s1', 's2', 's3', 's4', 's6']);
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
