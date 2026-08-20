// Scenario: workspace/session actions exposed by useWorkspaceState.
// Responsibilities: observable state and error reporting across load, paging, and user actions.
// Wiring: the composable is real; daemon requests and unrelated facade collaborators are stubbed.
// Run: cd packages/app-client && npx vitest run test/workspace-state.test.ts

import { computed, ref, type Ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApprovalRequest, AppQuestionRequest, AppSession, AppTask, KimiWebApi, ManagedUserInfo, ManagedUserInfoResult } from '@moonshot-ai/app-core/api';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import { createInitialState, reduceAppEvent } from '@moonshot-ai/app-core/api';
import { mergeWorkspaces } from '@moonshot-ai/app-core/lib';
import { foldDaemonThinkingLevel } from '@moonshot-ai/app-core/lib';
import { loadWorkspaceNameOverrides, saveWorkspaceNameOverrides } from '@moonshot-ai/app-core/lib';
import { insertSessionByRecency } from '@moonshot-ai/app-core/lib';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { Translator } from '@moonshot-ai/app-core/contracts';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { approvalsStore } from '../src/stores/approvals';
import type { ExtendedState } from '../src/client/types';
import { useWorkspaceState, forgetLocalTurnState, type UseWorkspaceStateDeps } from '../src/client/useWorkspaceState';

const apiMock = {
  abortPrompt: vi.fn(),
  abortSession: vi.fn(),
  addWorkspace: vi.fn(),
  archiveSession: vi.fn(),
  updateWorkspace: vi.fn(),
  createSession: vi.fn(),
  exportSession: vi.fn(),
  forkSession: vi.fn(),
  restoreSession: vi.fn(),
  updateSession: vi.fn(),
  submitPrompt: vi.fn(),
  steerPrompts: vi.fn(),
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
  getSession: vi.fn(),
  listSessions: vi.fn(),
  listSessionsV2: vi.fn(),
  listSessionGroupsV2: vi.fn(),
  listWorkspaces: vi.fn(),
  searchFiles: vi.fn(),
  suggestFiles: vi.fn(),
};

// Real i18n (the export-failure test asserts on localized copy); the client
// modules receive the translator through the deps registry.
const i18n = createKimiI18n({ locale: 'en' });
const t: Translator = (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params));

// Deps-registry stand-ins for the app's debug/trace module: traceKeyEvent
// records into a local ring, and the session-export serializer mirrors the
// real ring's metadata-only whitelist projection (free-text fields like
// `text` never enter a session export). The whitelist matches the real
// pushExportTrace key for key; the real ring's event-name gate, string
// truncation, and byte cap are not mirrored (no test exercises them).
const EXPORT_TRACE_INFO_KEYS = [
  'sessionId',
  'status',
  'operation',
  'seq',
  'durationMs',
  'messageCount',
  'contentCount',
  'mediaCount',
  'sessionCount',
  'workspaceCount',
  'promptId',
  'zipBytes',
  'errorName',
  'errorCode',
  'requestId',
  'phase',
  'httpStatus',
  'fatal',
  'line',
  'col',
] as const;
const traceRecords: Array<Record<string, unknown>> = [];

function clearTraceRecords(): void {
  traceRecords.length = 0;
}

function recordKeyEvent(event: string, info?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = { ts: 0, event };
  for (const key of EXPORT_TRACE_INFO_KEYS) {
    const value = info?.[key];
    if (value !== undefined) entry[key] = value;
  }
  traceRecords.push(entry);
}

function exportTraceRecordsToJsonl(): string {
  return traceRecords.map((entry) => JSON.stringify(entry)).join('\n');
}

beforeEach(() => {
  setKimiClientDeps({
    api: () => apiMock as unknown as KimiWebApi,
    t,
    traceKeyEvent: recordKeyEvent,
    sessionExportTraceToJsonl: exportTraceRecordsToJsonl,
  });
});

afterEach(() => {
  resetKimiClientDeps();
});

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
  const state: ExtendedState = {
    ...createInitialState(),
    // Status-view fields (the factory predates them — the archive path folds
    // into doneSessions and reads the side-chat id map).
    doneSessions: [],
    doneSessionsNextPageToken: null,
    doneSessionsHasMore: false,
    doneSessionsLoading: false,
    doneSessionsLoadingMore: false,
    doneSessionsSeeded: false,
    draftEntry: 'newChat',
    mainView: 'chat',
    sideChatUserMessageIdsBySession: {},
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
    planArmedBySession: {},
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
  return state;
}

function createDeps(): UseWorkspaceStateDeps {
  return {
    taskPoller: {},
    sideChat: { clearSideChatForSession: vi.fn() },
    modelProvider: { resolveThinkingForPrompt: async () => undefined },
    pushOperationFailure: vi.fn(),
    activity: computed(() => 'running'),
    sessionsKnownEmpty: new Set(),
    setSessions: vi.fn(),
    updateSession: vi.fn(),
    upsertSessionSorted: vi.fn(),
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
    refillSessionGoalOnReload: vi.fn(),
    persistSessionProfile: vi.fn().mockResolvedValue(true),
    notify: vi.fn(),
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
    clearTraceRecords();
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
    clearTraceRecords();
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
    recordKeyEvent('prompt:start', metadata);
    const blob = new Blob(['zip']);
    apiMock.exportSession.mockResolvedValue({ blob, fileName: 'sess_1.zip' });
    const workspace = useWorkspaceState(createState(), createDeps());

    await expect(workspace.exportSession()).resolves.toBe(true);

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
    const deps = createDeps();
    const workspace = useWorkspaceState(state, deps);

    const first = workspace.exportSession();
    state.activeSessionId = 'sess_2';
    const second = workspace.exportSession();
    resolveExport({ blob: new Blob(['zip']), fileName: 'sess_1.zip' });
    // The first export completes the download; the duplicate click is locked
    // out and reports no success.
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
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

    await expect(workspace.exportSession()).resolves.toBe(false);

    expect(apiMock.exportSession).not.toHaveBeenCalled();
    expect(deps.pushOperationFailure).toHaveBeenCalledWith(
      'exportSession',
      expect.any(Error),
      expect.objectContaining({ message: expect.any(String) }),
    );
  });

  it('resolves false when the export fails, so a retry can start', async () => {
    apiMock.exportSession.mockRejectedValue(new Error('boom'));
    const workspace = useWorkspaceState(createState(), createDeps());

    await expect(workspace.exportSession()).resolves.toBe(false);
    // The lock is released: a retry hits the API again.
    apiMock.exportSession.mockResolvedValue({ blob: new Blob(['zip']), fileName: 'sess_1.zip' });
    await expect(workspace.exportSession()).resolves.toBe(true);
  });

  it('maps the server archive-cap rejection to an actionable CLI fallback message', async () => {
    apiMock.exportSession.mockRejectedValue(
      new DaemonApiError({
        code: 41301,
        msg: 'session export exceeds the archive size limit',
        requestId: 'req_1',
      }),
    );
    const deps = createDeps();
    const workspace = useWorkspaceState(createState(), deps);

    await workspace.exportSession();

    expect(deps.pushOperationFailure).toHaveBeenCalledWith(
      'exportSession',
      expect.any(Error),
      {
        sessionId: 'sess_1',
        message: i18n.global.t('commands.export.tooLarge', { sessionId: 'sess_1' }),
      },
    );
  });

  it('keeps the generic failure mapping for non-cap export errors', async () => {
    apiMock.exportSession.mockRejectedValue(
      new DaemonApiError({ code: 50001, msg: 'internal error', requestId: 'req_1' }),
    );
    const deps = createDeps();
    const workspace = useWorkspaceState(createState(), deps);

    await workspace.exportSession();

    expect(deps.pushOperationFailure).toHaveBeenCalledWith(
      'exportSession',
      expect.any(Error),
      { sessionId: 'sess_1' },
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
    approvalsStore().clearSessionQuestions('sess_1');
  });

  it('removes the question locally and stays silent when already resolved (40902)', async () => {
    apiMock.respondQuestion.mockRejectedValue(
      new DaemonApiError({ code: 40902, msg: 'question q_1 already resolved', requestId: 'r' }),
    );
    const state = createState();
    approvalsStore().setSessionQuestions('sess_1', [questionRequest('q_1')]);
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.respondQuestion('q_1', response);

    expect(apiMock.respondQuestion).toHaveBeenCalledOnce();
    // Already resolved is the desired end state, so the card is dropped locally
    // without surfacing a duplicate error to the user.
    expect(approvalsStore().questionsBySession['sess_1']).toEqual([]);
    expect(deps.pushOperationFailure).not.toHaveBeenCalled();
  });

  it('surfaces genuine errors and keeps the question for retry', async () => {
    apiMock.respondQuestion.mockRejectedValue(
      new DaemonApiError({ code: 50001, msg: 'boom', requestId: 'r' }),
    );
    const state = createState();
    approvalsStore().setSessionQuestions('sess_1', [questionRequest('q_1')]);
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.respondQuestion('q_1', response);

    expect(approvalsStore().questionsBySession['sess_1']).toHaveLength(1);
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
    approvalsStore().setSessionQuestions('sess_1', [questionRequest('q_1')]);
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    const first = ws.respondQuestion('q_1', response);
    // Second click while the first request is still in flight must be a no-op.
    await ws.respondQuestion('q_1', response);

    expect(apiMock.respondQuestion).toHaveBeenCalledOnce();

    // Resolve the first request and ensure the question is removed.
    resolveRespond({ resolved: true, resolvedAt: '2026-01-01T00:00:00.000Z' });
    await first;
    expect(approvalsStore().questionsBySession['sess_1']).toEqual([]);
  });
});

describe('useWorkspaceState — respondApproval', () => {
  beforeEach(() => {
    apiMock.respondApproval.mockReset();
    approvalsStore().clearSessionApprovals('sess_1');
  });

  it('removes the approval locally and stays silent when already resolved (40902)', async () => {
    apiMock.respondApproval.mockRejectedValue(
      new DaemonApiError({ code: 40902, msg: 'approval a_1 already resolved', requestId: 'r' }),
    );
    const state = createState();
    state.approvalsBySession = { sess_1: [approvalRequest('a_1')] };
    approvalsStore().setSessionApprovals('sess_1', [approvalRequest('a_1')]);
    const deps = createDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.respondApproval('a_1', { decision: 'approved' });

    expect(apiMock.respondApproval).toHaveBeenCalledOnce();
    expect(approvalsStore().approvalsBySession['sess_1']).toEqual([]);
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
      // upsertSessionSorted must actually land the new session in rawState.sessions
      // so startSessionAndActivateSkill can read its model.
      upsertSessionSorted: vi.fn((s) => {
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
    deps.upsertSessionSorted = vi.fn((s) => {
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
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_new', {
      goalObjective: 'improve test coverage',
      // The goal write always carries the plan disarm (plan/goal exclusivity).
      planMode: false,
    });
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
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_new', {
      goalObjective: 'improve test coverage',
      // The goal write always carries the plan disarm (plan/goal exclusivity).
      planMode: false,
    });
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
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_1', {
      goalObjective: 'improve test coverage',
      planMode: false,
    });
    // And because the session is running (createDeps' default activity is
    // 'running'), sendPrompt queues rather than posting immediately.
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(state.queuedBySession['sess_1']).toEqual([
      expect.objectContaining({ text: 'improve test coverage', attachments: undefined }),
    ]);
  });

  it('surfaces a structured refusal of the goal write without submitting the objective', async () => {
    const state = createState();
    state.permission = 'auto';
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockRejectedValue(
      new DaemonApiError({ code: 40913, msg: 'goal already exists', requestId: 'r' }),
    );
    apiMock.submitPrompt.mockReset();
    const deps = goalDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.createGoal('improve test coverage');

    expect(deps.pushOperationFailure).toHaveBeenCalledWith(
      'createGoal',
      expect.anything(),
      expect.objectContaining({ sessionId: 'sess_1' }),
    );
    expect(state.queuedBySession.sess_1 ?? []).toEqual([]);
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(apiMock.updateSession).toHaveBeenCalledTimes(1); // no objective replay
  });

  it('surfaces an ambiguous goal-write failure the same way, without submitting', async () => {
    // A lost response leaves the write's outcome unknown — the failure is
    // reported like any other send failure and the objective prompt is not
    // submitted (no blind retry of a non-idempotent write).
    const state = createState();
    state.permission = 'auto';
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockRejectedValue(new TypeError('fetch failed'));
    apiMock.submitPrompt.mockReset();
    const deps = goalDeps();
    const ws = useWorkspaceState(state, deps);

    await ws.createGoal('improve test coverage');

    expect(deps.pushOperationFailure).toHaveBeenCalledWith(
      'createGoal',
      expect.anything(),
      expect.objectContaining({ sessionId: 'sess_1' }),
    );
    expect(state.queuedBySession.sess_1 ?? []).toEqual([]);
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
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
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_new', {
      goalObjective: 'improve test coverage',
      // The goal write always carries the plan disarm (plan/goal exclusivity).
      planMode: false,
    });
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
    region: 'mainland-cn',
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
    apiMock.listSessionGroupsV2.mockReset();
    apiMock.getSession.mockReset();
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

  it('loads workspace sessions when a retry follows an initial failure', async () => {
    const cached = {
      ...createSession(),
      title: 'Cached',
      workspaceId: 'wd_1',
    };
    // First grouped request fails (previous list kept); the retry succeeds.
    const recoveredV2 = {
      id: 'sess_1',
      workspace: { id: 'wd_1', cwd: '/workspace' },
      meta: {
        title: 'Recovered',
        last_prompt: 'p',
        created_at: 1,
        updated_at: 2,
        archived: false,
        archived_at: null,
      },
      activity: { status: 'idle' as const },
    };
    apiMock.listWorkspaces.mockResolvedValue([workspace('wd_1', '/workspace', 'Workspace')]);
    apiMock.listSessionGroupsV2
      .mockRejectedValueOnce(new Error('session index unavailable'))
      .mockResolvedValue({
        groups: [
          { workspace: { id: 'wd_1', cwd: '/workspace' }, sessions: [recoveredV2], total: 1 },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      });
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

  it('does not resurrect a session archived remotely while the load was in flight', async () => {
    const live = { ...createSession(), id: 'sess_live', busy: false };
    const archived = { ...createSession(), id: 'sess_arch', busy: false };
    const { state, workspaceState } = createSessionLoadRig([live]);
    // No registered workspaces → the initial load walks the global v1 list.
    // Hold its response so the remote archive lands mid-flight.
    let resolveList: ((page: { items: AppSession[]; hasMore: boolean }) => void) | undefined;
    apiMock.listSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );

    const pending = workspaceState.load();
    // Wait until the global walk's request is actually in flight, then land
    // the remote archive: the row was never in the pool (nothing to remove
    // right now) — the tombstone is the only thing standing between it and
    // resurrection on commit.
    await vi.waitFor(() => expect(apiMock.listSessions).toHaveBeenCalled());
    await workspaceState.applyRemoteSessionArchived('sess_arch');
    resolveList!({ items: [archived, live], hasMore: false });
    await pending;

    expect(state.sessions.map((session) => session.id)).toEqual(['sess_live']);
  });

  it('auto-selects from the committed pool, not the unfiltered load result', async () => {
    // The archived row is the NEWEST item of the stale page — an unfiltered
    // array would put it first and make it the auto-select target.
    const archived = {
      ...createSession(),
      id: 'sess_arch',
      busy: false,
      updatedAt: '2026-06-01T00:00:00.000Z',
    };
    const live = {
      ...createSession(),
      id: 'sess_live',
      busy: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { state, deps, workspaceState } = createSessionLoadRig([live]);
    state.activeSessionId = null;
    let resolveList: ((page: { items: AppSession[]; hasMore: boolean }) => void) | undefined;
    apiMock.listSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );

    const pending = workspaceState.load();
    await vi.waitFor(() => expect(apiMock.listSessions).toHaveBeenCalled());
    await workspaceState.applyRemoteSessionArchived('sess_arch');
    resolveList!({ items: [archived, live], hasMore: false });
    await pending;

    // The committed pool excludes sess_arch, so the auto-select picks
    // sess_live directly (no by-id fetch of the archived row).
    expect(apiMock.getSession).not.toHaveBeenCalledWith('sess_arch');
    expect(deps.setActiveSessionId).toHaveBeenCalledWith('sess_live');
    expect(deps.setActiveSessionId).not.toHaveBeenCalledWith('sess_arch');
  });

  it('preserves a concurrently backfilled row when the stale first page commits', async () => {
    const rows = [1, 2, 3, 4, 5].map((i) => ({
      ...createSession(),
      id: `s${i}`,
      workspaceId: 'wd_1',
      busy: false,
      updatedAt: new Date(Date.parse('2026-01-05T00:00:00.000Z') - i * 1000).toISOString(),
    }));
    const backfilled = {
      ...createSession(),
      id: 's6',
      workspaceId: 'wd_1',
      busy: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    apiMock.listWorkspaces.mockResolvedValue([workspace('wd_1', '/workspace', 'Workspace')]);
    const state = createState();
    state.sessions = [...rows];
    state.activeSessionId = rows[0]!.id;
    const deps = {
      ...createDeps(),
      modelProvider: { loadModels: vi.fn().mockResolvedValue(undefined) },
      initialized: ref(false),
      connectIssue: ref<string | null>(null),
      setSessions: (next: AppSession[]) => {
        state.sessions = next;
      },
      // The archive reconciliation removes rows through this dep — it must
      // actually apply, or the backfill sees nothing to restore.
      forgetSession: (id: string) => {
        state.sessions = state.sessions.filter((s) => s.id !== id);
      },
      workspaceIdForSession: vi.fn(
        (session: { workspaceId?: string; cwd: string }) =>
          state.workspaces.find((item) => item.root === session.cwd)?.id ??
          session.workspaceId ??
          session.cwd,
      ),
    } as unknown as UseWorkspaceStateDeps;
    const workspaceState = useWorkspaceState(state, deps);
    state.sessionsHasMoreByWorkspace = { wd_1: true };
    state.sessionsCursorByWorkspace = { wd_1: 's5' };
    state.sessionsInitialCountByWorkspace = { wd_1: 5 };
    // The grouped first page is held; the archive backfill's v1 page answers.
    let resolveFirst: ((page: unknown) => void) | undefined;
    apiMock.listSessionGroupsV2.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    apiMock.listSessions.mockResolvedValue({ items: [backfilled], hasMore: false });

    const pending = workspaceState.load();
    await vi.waitFor(() => expect(apiMock.listSessionGroupsV2).toHaveBeenCalled());
    // The remote archive lands mid-load: s2 is removed and the backfill
    // inserts s6 — then the STALE first page (s2 included, s6 absent) commits.
    await workspaceState.applyRemoteSessionArchived('s2', 'wd_1');
    await vi.waitFor(() => expect(apiMock.listSessions).toHaveBeenCalledTimes(1));
    resolveFirst!({
      groups: [
        {
          workspace: { id: 'wd_1', cwd: '/workspace' },
          sessions: rows.map((r) => ({
            id: r.id,
            workspace: { id: 'wd_1', cwd: '/workspace' },
            meta: {
              title: r.title,
              last_prompt: 'p',
              created_at: Date.parse(r.createdAt),
              updated_at: Date.parse(r.updatedAt),
              archived: false,
              archived_at: null,
            },
            activity: { status: 'idle' as const },
          })),
          total: 5,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    await pending;

    // s2 stays filtered (tombstone); the concurrently backfilled s6 survives
    // the wholesale commit instead of being overwritten away.
    expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's3', 's4', 's5', 's6']);
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
    apiMock.steerPrompts.mockReset();
    apiMock.steerPrompts.mockResolvedValue({});
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

  it('drains queued session-media attachments without changing their namespace', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [
        {
          text: 'queued media',
          attachments: [
            { fileId: 'f_img', kind: 'image', sessionId: 'sess_1' },
            { fileId: 'f_vid', kind: 'video', sessionId: 'sess_1' },
          ],
        },
      ],
    };
    const ws = useWorkspaceState(state, promptDeps());

    ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: true });

    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [
          { type: 'text', text: 'queued media' },
          { type: 'image', source: { kind: 'sessionMedia', fileId: 'f_img' } },
          { type: 'video', source: { kind: 'sessionMedia', fileId: 'f_vid' } },
        ],
      }),
    );
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
    // flushQueueHead is fire-and-forget, and the send path now waits one more
    // microtask hop (the profile-chain no-op) — give the flush a macrotask
    // to reach the submit before asserting.
    await new Promise((r) => setTimeout(r, 0));

    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'stuck queued' }] }),
    );
    expect(state.queuedBySession.sess_1).toEqual([
      expect.objectContaining({ text: 'next', attachments: undefined }),
    ]);
  });

  it('arms plan locally without a profile write, and cashes it on send', async () => {
    // Plan-as-intent: the toggle writes NO profile — the daemon learns plan
    // mode via the profile write riding ahead of the next prompt.
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockResolvedValue({});
    const state = createState();
    const deps = promptDeps({ activity: computed(() => 'idle') });
    const ws = useWorkspaceState(state, deps);

    ws.setPlanMode(true);
    expect(state.planArmedBySession.sess_1).toBe(true);
    expect(deps.persistSessionProfile).not.toHaveBeenCalled();

    await ws.sendPrompt('make a plan');

    // Cashed: the profile write ran ahead of the prompt, intent consumed.
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_1', { planMode: true });
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(apiMock.updateSession.mock.invocationCallOrder[0]!).toBeLessThan(
      apiMock.submitPrompt.mock.invocationCallOrder[0]!,
    );
    expect(state.planArmedBySession.sess_1).toBe(false);
  });

  it('disarming a live plan mode writes the daemon at once', async () => {
    // Toggle-off is the opposite asymmetry: it terminates the FACT, not an
    // intent, so it goes straight to the profile.
    const state = createState();
    state.planModeBySession = { sess_1: true }; // daemon fact: plan active
    const deps = promptDeps();
    const ws = useWorkspaceState(state, deps);

    ws.setPlanMode(false);

    expect(deps.persistSessionProfile).toHaveBeenCalledWith({ planMode: false }, 'sess_1');
    expect(state.planArmedBySession.sess_1).toBe(false);
  });

  it('keeps a mid-flight re-arm when the toggle goes off then back on', async () => {
    // Cash in flight, user toggles off then back on: the armed flag simply
    // ends up true — the in-flight cash lands, no disarm ever fires, and the
    // intent stays armed for the next send.
    apiMock.updateSession.mockReset();
    let resolveCash!: (value: unknown) => void;
    apiMock.updateSession.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCash = resolve; }),
    );
    apiMock.updateSession.mockResolvedValue({});
    const state = createState();
    const deps = promptDeps({ activity: computed(() => 'idle') });
    const ws = useWorkspaceState(state, deps);

    ws.setPlanMode(true);
    const send = ws.sendPrompt('make a plan');
    await vi.waitFor(() =>
      expect(apiMock.updateSession).toHaveBeenCalledWith('sess_1', { planMode: true }),
    );

    // Off, then back on, all within the cash flight.
    ws.setPlanMode(false);
    ws.setPlanMode(true);

    resolveCash({});
    await send;

    // No disarm fired; the re-armed intent survives for the next send, and
    // this send's cash stays landed.
    expect(deps.persistSessionProfile).not.toHaveBeenCalledWith({ planMode: false }, 'sess_1');
    expect(state.planArmedBySession.sess_1).toBe(true);
    expect(state.planModeBySession.sess_1).toBe(true);
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
  });

  it('keeps the re-armed intent when a second send queues mid-cash (off→on→send)', async () => {
    // Cash in flight, user toggles off then back on, then sends a second
    // message — the second send enqueues behind the in-flight first one and
    // the re-armed flag stays put; nothing ever fires a disarm.
    apiMock.updateSession.mockReset();
    let resolveCash!: (value: unknown) => void;
    apiMock.updateSession.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCash = resolve; }),
    );
    apiMock.updateSession.mockResolvedValue({});
    const state = createState();
    const deps = promptDeps({ activity: computed(() => 'idle') });
    const ws = useWorkspaceState(state, deps);

    ws.setPlanMode(true);
    const send = ws.sendPrompt('first');
    await vi.waitFor(() =>
      expect(apiMock.updateSession).toHaveBeenCalledWith('sess_1', { planMode: true }),
    );

    ws.setPlanMode(false);
    ws.setPlanMode(true);
    await ws.sendPrompt('second'); // enqueued — the re-armed flag stays armed

    resolveCash({});
    await send;

    // No disarm: the first message keeps its plan and the intent rides the
    // second entry.
    expect(deps.persistSessionProfile).not.toHaveBeenCalledWith({ planMode: false }, 'sess_1');
    expect(state.planModeBySession.sess_1).toBe(true);
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
  });

  it('skips the cashing write when the daemon fact is already active', async () => {
    // The daemon already runs plan mode (e.g. the model auto-entered via
    // EnterPlanMode): an armed send needs no PATCH — the intent just folds
    // into the live fact.
    apiMock.updateSession.mockReset();
    const state = createState();
    state.planModeBySession = { sess_1: true };
    state.planArmedBySession = { sess_1: true };
    const ws = useWorkspaceState(state, promptDeps({ activity: computed(() => 'idle') }));

    await ws.sendPrompt('continue planning');

    expect(apiMock.updateSession).not.toHaveBeenCalled();
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(state.planArmedBySession.sess_1).toBe(false);
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

  it('keeps session-media attachments in their namespace when steering a running turn', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [
        {
          text: 'queued media',
          attachments: [{ fileId: 'f_img', kind: 'image', sessionId: 'sess_1' }],
        },
      ],
    };
    const ws = useWorkspaceState(state, promptDeps());

    await ws.steerPrompt('live media', [
      { fileId: 'f_vid', kind: 'video', sessionId: 'sess_1' },
    ]);

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [
          { type: 'text', text: 'queued media\n\nlive media' },
          { type: 'image', source: { kind: 'sessionMedia', fileId: 'f_img' } },
          { type: 'video', source: { kind: 'sessionMedia', fileId: 'f_vid' } },
        ],
      }),
    );
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
      { text: 'queued', attachments: [{ fileId: 'f_q', kind: 'image' }] },
    ]);
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

  it('consumes the armed plan intent when an idle steer falls back to a normal send', async () => {
    // The idle fallback goes through the same send chain, so the armed plan
    // intent is cashed there and the pill clears with the send.
    const state = createState();
    state.planArmedBySession = { sess_1: true };
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockResolvedValue({});
    const ws = useWorkspaceState(state, promptDeps({ activity: computed(() => 'idle') }));

    await ws.steerPrompt('live text');

    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_1', { planMode: true });
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(state.planArmedBySession.sess_1).toBe(false);
  });

  it('restores the merged queue entries when an idle steer falls back to a normal send that fails', async () => {
    const state = createState();
    state.queuedBySession = { sess_1: [{ text: 'queued', attachments: undefined }] };
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }),
    );
    const ws = useWorkspaceState(state, promptDeps({ activity: computed(() => 'idle') }));

    await ws.steerPrompt('live text');

    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'queued', attachments: undefined },
    ]);
  });

  it('steers one queued message into the running turn and keeps the rest of the queue', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    // Parked behind the active turn — the client then POSTs the steer.
    apiMock.submitPrompt.mockResolvedValue({
      promptId: 'prompt_steered',
      userMessageId: 'message_steered',
      status: 'queued',
    });
    const ws = useWorkspaceState(state, promptDeps());

    await ws.steerQueued(0);

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [{ type: 'text', text: 'first queued' }],
      }),
    );
    expect(apiMock.steerPrompts).toHaveBeenCalledWith('sess_1', ['prompt_steered']);
    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
    ]);
  });

  it('restores the entry at its original index when a queued steer is definitively rejected', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }),
    );
    const ws = useWorkspaceState(state, promptDeps());

    await ws.steerQueued(1);

    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'first queued', attachments: undefined },
      { text: 'second queued', attachments: undefined },
    ]);
  });

  it('does NOT restore the entry when a queued steer failure is network-ambiguous', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    // Response lost mid-flight: the prompt may already be queued server-side,
    // so restoring would duplicate it on a later drain.
    apiMock.submitPrompt.mockRejectedValue(new TypeError('fetch failed'));
    const ws = useWorkspaceState(state, promptDeps());

    await ws.steerQueued(0);

    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
    ]);
  });

  it('falls back to a normal send when steering a queued message with no turn running', async () => {
    const state = createState();
    state.queuedBySession = { sess_1: [{ text: 'queued', attachments: undefined }] };
    const ws = useWorkspaceState(state, promptDeps({ activity: computed(() => 'idle') }));

    await ws.steerQueued(0);

    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(apiMock.steerPrompts).not.toHaveBeenCalled();
    expect(state.queuedBySession.sess_1).toEqual([]);
  });

  it('sends the queued text verbatim (no trimming)', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [{ text: '    indented code block', attachments: undefined }],
    };
    apiMock.submitPrompt.mockResolvedValue({
      promptId: 'prompt_steered',
      userMessageId: 'message_steered',
      status: 'queued',
    });
    const ws = useWorkspaceState(state, promptDeps());

    await ws.steerQueued(0);

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [{ type: 'text', text: '    indented code block' }],
      }),
    );
  });

  it('does not drain the queue while a queued steer is still in flight', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    // Park the steer's own submit so we control when it settles.
    let resolveSteer!: (value: unknown) => void;
    apiMock.submitPrompt.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSteer = resolve; }),
    );
    const ws = useWorkspaceState(state, promptDeps());

    const steer = ws.steerQueued(0);
    // The first entry leaves the queue immediately; its submit is parked.
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
    ]);

    // The running turn ends mid-steer: the drain must NOT fire — it would
    // submit "second queued" ahead of the steered "first queued", breaking
    // FIFO (and the steer could then land in the drained entry's turn).
    ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
    ]);

    // The steer settles; its own turn's end drains the next entry as usual.
    resolveSteer({ promptId: 'prompt_steered', userMessageId: 'message_steered', status: 'queued' });
    await steer;
    expect(apiMock.steerPrompts).toHaveBeenCalledWith('sess_1', ['prompt_steered']);

    state.inFlightBySession = { sess_1: true };
    ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2));
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'second queued' }] }),
    );
  });

  it('serializes consecutive queued steers so the daemon sees them in click order', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    // First steer's submit parked; the second steer must queue behind it.
    let resolveFirst!: (value: unknown) => void;
    apiMock.submitPrompt
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ promptId: 'prompt_b', userMessageId: 'message_b', status: 'queued' });
    const ws = useWorkspaceState(state, promptDeps());

    const s1 = ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    const s2 = ws.steerQueued(0); // clicked the new head
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    // Still parked behind the first steer — no submit, no queue mutation yet.
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
    ]);

    resolveFirst({ promptId: 'prompt_a', userMessageId: 'message_a', status: 'queued' });
    await Promise.all([s1, s2]);
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2);
    expect(apiMock.submitPrompt).toHaveBeenNthCalledWith(
      2,
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'second queued' }] }),
    );
    expect(apiMock.steerPrompts).toHaveBeenNthCalledWith(1, 'sess_1', ['prompt_a']);
    expect(apiMock.steerPrompts).toHaveBeenNthCalledWith(2, 'sess_1', ['prompt_b']);
    expect(state.queuedBySession.sess_1 ?? []).toEqual([]);
  });

  it('sendPrompt enqueues behind an in-flight steer without flushing early', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    let resolveSteer!: (value: unknown) => void;
    apiMock.submitPrompt.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSteer = resolve; }),
    );
    const ws = useWorkspaceState(state, promptDeps());

    const steer = ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());

    await ws.sendPrompt('third');
    // 'third' waits in line; the parked steer holds the drain shut.
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
      expect.objectContaining({ text: 'third' }),
    ]);

    // The steer settles; its turn's end drains the next entry in order.
    resolveSteer({ promptId: 'prompt_steered', userMessageId: 'message_steered', status: 'queued' });
    await steer;
    state.inFlightBySession = { sess_1: true };
    ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2));
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'second queued' }] }),
    );
  });

  it('ignores an empty queued entry without dropping it', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = { sess_1: [{ text: '   ', attachments: undefined }] };
    const ws = useWorkspaceState(state, promptDeps());

    await ws.steerQueued(0);

    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(state.queuedBySession.sess_1).toEqual([{ text: '   ', attachments: undefined }]);
  });

  it('restores the queued entry when the steer fails before the submit is sent', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = { sess_1: [{ text: 'queued', attachments: undefined }] };
    // The thinking resolution throws before any POST: nothing reached the
    // daemon, so the never-restore "ambiguous" rule must NOT apply.
    const ws = useWorkspaceState(state, promptDeps({
      modelProvider: {
        models: ref([]),
        resolveThinkingForPrompt: async () => {
          throw new TypeError('fetch failed');
        },
      } as unknown as UseWorkspaceStateDeps['modelProvider'],
    }));

    await ws.steerQueued(0);

    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(state.queuedBySession.sess_1).toEqual([{ text: 'queued', attachments: undefined }]);
  });

  it('resumes the queue after a rejected steer once the hold is released', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = { sess_1: [{ text: 'queued', attachments: undefined }] };
    let rejectSteer!: (err: unknown) => void;
    apiMock.submitPrompt.mockImplementationOnce(
      () => new Promise((_, reject) => { rejectSteer = reject; }),
    );
    const activity = ref('working');
    const ws = useWorkspaceState(state, promptDeps({ activity: computed(() => activity.value) }));

    // The turn ends while the steer is parked; the drain stays shut.
    const steer = ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    activity.value = 'idle';
    state.inFlightBySession = { sess_1: false };
    ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });

    // Rejected with the session now idle: the entry is restored AND the queue
    // is re-driven immediately — no turn end is coming to do it.
    rejectSteer(new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }));
    await steer;
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2));
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'queued' }] }),
    );
    expect(state.queuedBySession.sess_1).toEqual([]);
  });

  it('steers the entry locked at click time, not whatever sits at the index later', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [
        { text: 'A', attachments: undefined },
        { text: 'B', attachments: undefined },
      ],
    };
    let rejectFirst!: (err: unknown) => void;
    apiMock.submitPrompt
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce({ promptId: 'prompt_b', userMessageId: 'message_b', status: 'queued' });
    const ws = useWorkspaceState(state, promptDeps());

    const s1 = ws.steerQueued(0); // locks A
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    const s2 = ws.steerQueued(0); // locks B (the new head)
    // A is rejected and comes back at index 0.
    rejectFirst(new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }));
    await s1;
    expect(state.queuedBySession.sess_1).toEqual([
      { text: 'A', attachments: undefined },
      { text: 'B', attachments: undefined },
    ]);
    // The queued steer must still send B — not the restored A at index 0.
    await s2;
    expect(apiMock.submitPrompt).toHaveBeenNthCalledWith(
      2,
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'B' }] }),
    );
    expect(apiMock.steerPrompts).toHaveBeenCalledWith('sess_1', ['prompt_b']);
    expect(state.queuedBySession.sess_1).toEqual([{ text: 'A', attachments: undefined }]);
  });

  it('runs a Ctrl+S merge steer behind an in-flight queued steer', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [
        { text: 'A', attachments: undefined },
        { text: 'B', attachments: undefined },
      ],
    };
    let resolveFirst!: (value: unknown) => void;
    apiMock.submitPrompt
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ promptId: 'prompt_merge', userMessageId: 'message_merge', status: 'queued' });
    const ws = useWorkspaceState(state, promptDeps());

    const s1 = ws.steerQueued(0); // A in flight
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    const s2 = ws.steerPrompt('live');
    // The merge steer must wait: no submit, and the queue is NOT merged yet.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(state.queuedBySession.sess_1).toEqual([{ text: 'B', attachments: undefined }]);

    resolveFirst({ promptId: 'prompt_a', userMessageId: 'message_a', status: 'queued' });
    await Promise.all([s1, s2]);
    expect(apiMock.submitPrompt).toHaveBeenNthCalledWith(
      2,
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'B\n\nlive' }] }),
    );
    expect(apiMock.steerPrompts).toHaveBeenNthCalledWith(1, 'sess_1', ['prompt_a']);
    expect(apiMock.steerPrompts).toHaveBeenNthCalledWith(2, 'sess_1', ['prompt_merge']);
    expect(state.queuedBySession.sess_1 ?? []).toEqual([]);
  });

  it('sendPrompt falls in line behind an in-flight steer even after the turn ended', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = { sess_1: [{ text: 'steered', attachments: undefined }] };
    let resolveSteer!: (value: unknown) => void;
    apiMock.submitPrompt.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSteer = resolve; }),
    );
    // Start "working" so the steer takes the running path, then flip to idle
    // to model the turn ending while the steer's submit is parked.
    const activity = ref('working');
    const ws = useWorkspaceState(state, promptDeps({ activity: computed(() => activity.value) }));

    const steer = ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    activity.value = 'idle';
    state.inFlightBySession = { sess_1: false };

    // Idle + empty queue + no in-flight: a naive sendPrompt would submit
    // directly and could reach the daemon ahead of the parked steer.
    await ws.sendPrompt('new message');
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(state.queuedBySession.sess_1).toEqual([
      expect.objectContaining({ text: 'new message' }),
    ]);

    // The steer settles; its turn's end drains the new message in order.
    resolveSteer({ promptId: 'prompt_steered', userMessageId: 'message_steered', status: 'queued' });
    await steer;
    state.inFlightBySession = { sess_1: true };
    ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2));
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'new message' }] }),
    );
  });

  it('forgetLocalTurnState releases the steer-in-flight hold', async () => {
    const state = createState();
    state.inFlightBySession = { sess_1: true };
    state.queuedBySession = {
      sess_1: [
        { text: 'steered', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    apiMock.submitPrompt.mockImplementationOnce(() => new Promise(() => {})); // parked forever
    const ws = useWorkspaceState(state, promptDeps());

    void ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());

    // Forgetting the session drops every hold, so a later turn end drains again.
    forgetLocalTurnState('sess_1');
    state.inFlightBySession = { sess_1: true };
    ws.handleSessionSnapshot('sess_1', { inFlightTurn: null, busy: false });
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2));
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'second queued' }] }),
    );
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
      { fileId: 'f_history_img', kind: 'image', sessionId: 'sess_1' },
      { fileId: 'f_history_vid', kind: 'video', sessionId: 'sess_1' },
      { fileId: 'f_pdf', kind: 'file', name: 'a.pdf', mediaType: 'application/pdf', size: 42 },
    ]);

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [
          { type: 'text', text: 'look at these' },
          { type: 'image', source: { kind: 'file', fileId: 'f_img' } },
          { type: 'video', source: { kind: 'file', fileId: 'f_vid' } },
          { type: 'image', source: { kind: 'sessionMedia', fileId: 'f_history_img' } },
          { type: 'video', source: { kind: 'sessionMedia', fileId: 'f_history_vid' } },
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

describe('useWorkspaceState — recency-ordered restore/fork', () => {
  const T = {
    newest: '2026-08-11T04:00:00.000Z',
    middle: '2026-08-11T02:00:00.000Z',
    between: '2026-08-11T01:00:00.000Z',
    oldest: '2026-08-10T23:00:00.000Z',
  };

  function poolSession(id: string, updatedAt: string): AppSession {
    return { ...createSession(), id, updatedAt };
  }

  function setup() {
    const state = createState();
    state.sessions = [
      poolSession('a', T.newest),
      poolSession('b', T.middle),
      poolSession('c', T.oldest),
    ];
    const deps = createDeps();
    // Faithful stand-in for the facade's upsertSessionSorted.
    deps.upsertSessionSorted = (s: AppSession) => {
      state.sessions = insertSessionByRecency(state.sessions, s);
    };
    deps.setActiveSessionId = (id: string | undefined) => {
      state.activeSessionId = id;
    };
    const ws = useWorkspaceState(state, deps);
    return { state, deps, ws };
  }

  beforeEach(() => {
    apiMock.restoreSession.mockReset();
    apiMock.forkSession.mockReset();
  });

  it('restoreSession lands the session at its content time, not the front', async () => {
    const { state, ws } = setup();
    apiMock.restoreSession.mockResolvedValue(poolSession('restored', T.between));

    const ok = await ws.restoreSession('restored');

    expect(ok).toBe(true);
    expect(apiMock.restoreSession).toHaveBeenCalledWith('restored');
    expect(state.sessions.map((s) => s.id)).toEqual(['a', 'b', 'restored', 'c']);
  });

  it('forkSession lands the fork next to the source and selects it', async () => {
    const { state, ws } = setup();
    apiMock.forkSession.mockResolvedValue(poolSession('forked', T.middle));

    await ws.forkSession('b');

    expect(apiMock.forkSession).toHaveBeenCalledWith('b');
    // Same timestamp as the source: lands right after it, never at the front.
    expect(state.sessions.map((s) => s.id)).toEqual(['a', 'b', 'forked', 'c']);
    expect(state.activeSessionId).toBe('forked');
  });
});

describe('useWorkspaceState — searchFiles (fs:suggest with fs:search fallback)', () => {
  beforeEach(() => {
    apiMock.suggestFiles.mockReset();
    apiMock.searchFiles.mockReset();
  });

  function setupSearch(deps: UseWorkspaceStateDeps = createDeps()) {
    deps.workspaceIdForSession = () => 'ws_1';
    return useWorkspaceState(createState(), deps);
  }

  it('prefers fs:suggest and preserves kind + matchPositions', async () => {
    apiMock.suggestFiles.mockResolvedValue({
      items: [{ path: 'src/app.ts', name: 'app.ts', kind: 'file', score: 0.9, matchPositions: [4, 5, 6] }],
      truncated: false,
    });
    const workspace = setupSearch();

    const items = await workspace.searchFiles('app');

    expect(apiMock.suggestFiles).toHaveBeenCalledWith('ws_1', { query: 'app', limit: 20 });
    expect(apiMock.searchFiles).not.toHaveBeenCalled();
    expect(items).toEqual([{ path: 'src/app.ts', name: 'app.ts', kind: 'file', matchPositions: [4, 5, 6] }]);
  });

  it('falls back to fs:search on a bare 404 and stops probing fs:suggest', async () => {
    apiMock.suggestFiles.mockRejectedValue(
      new DaemonApiError({ code: 404, msg: 'Not Found', requestId: 'r1' }),
    );
    apiMock.searchFiles.mockResolvedValue({
      items: [{ path: 'README.md', name: 'README.md', kind: 'file', score: 1, matchPositions: [0] }],
      truncated: false,
    });
    const workspace = setupSearch();

    const first = await workspace.searchFiles('read');
    const second = await workspace.searchFiles('read');

    expect(first[0]?.path).toBe('README.md');
    expect(apiMock.searchFiles).toHaveBeenCalledTimes(2);
    // The 404 is sticky: the server build does not change mid-session.
    expect(apiMock.suggestFiles).toHaveBeenCalledTimes(1);
    expect(second[0]?.matchPositions).toEqual([0]);
  });

  it('does not fall back on non-404 suggest errors (defensive [])', async () => {
    apiMock.suggestFiles.mockRejectedValue(
      new DaemonApiError({ code: 500, msg: 'boom', requestId: 'r2' }),
    );
    const workspace = setupSearch();

    expect(await workspace.searchFiles('x')).toEqual([]);
    expect(apiMock.searchFiles).not.toHaveBeenCalled();
    // Not sticky — the next query probes fs:suggest again.
    expect(await workspace.searchFiles('x')).toEqual([]);
    expect(apiMock.suggestFiles).toHaveBeenCalledTimes(2);
  });

  it('returns [] when no workspace ref is active', async () => {
    // createDeps' default workspaceIdForSession is a bare vi.fn() → undefined.
    const workspace = useWorkspaceState(createState(), createDeps());
    expect(await workspace.searchFiles('x')).toEqual([]);
    expect(apiMock.suggestFiles).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — grouped initial session load (view=by_workspace)', () => {
  const BASE = Date.parse('2026-02-01T00:00:00.000Z');

  function v2Session(id: string, index: number, workspaceId: string, cwd: string) {
    return {
      id,
      workspace: { id: workspaceId, cwd },
      meta: {
        title: `title-${id}`,
        last_prompt: `prompt-${id}`,
        created_at: BASE - index * 1000,
        updated_at: BASE - index * 1000,
        archived: false,
        archived_at: null,
      },
      activity: { status: 'idle' as const },
    };
  }

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
      backend: 'v2',
    });
    apiMock.getConfig.mockReset().mockResolvedValue({});
    apiMock.getFsHome.mockReset().mockResolvedValue({ home: '', recentRoots: [] });
    apiMock.listSessions.mockReset().mockResolvedValue({ items: [], hasMore: false });
    apiMock.listSessionsV2.mockReset();
    apiMock.listSessionGroupsV2.mockReset();
    apiMock.listWorkspaces.mockReset().mockResolvedValue([
      workspace('ws1', '/repo/ws1', 'ws1'),
      workspace('ws2', '/repo/ws2', 'ws2'),
      workspace('ws3', '/repo/ws3', 'ws3'),
    ]);
  });

  function createLoadDeps(state: ExtendedState): UseWorkspaceStateDeps {
    return {
      ...createDeps(),
      modelProvider: { loadModels: vi.fn().mockResolvedValue(undefined) },
      // First-load path (waitForFirstAuth, no separate checkAuth).
      initialized: ref(false),
      connectIssue: ref<string | null>(null),
      // Commit pool replacements so the test can read the merged list back.
      setSessions: (next: AppSession[]) => {
        state.sessions = next;
      },
      updateSession: (id: string, update: (s: AppSession) => AppSession) => {
        state.sessions = state.sessions.map((s) => (s.id === id ? update(s) : s));
      },
      appendSession: (session: AppSession) => {
        state.sessions = [...state.sessions, session];
      },
      workspaceIdForSession: (s: { workspaceId?: string; cwd: string }) => s.workspaceId ?? s.cwd,
    } as unknown as UseWorkspaceStateDeps;
  }

  it('loads every workspace in one grouped request, with totals driving hasMore', async () => {
    apiMock.listSessionGroupsV2.mockResolvedValue({
      groups: [
        {
          workspace: { id: 'ws1', cwd: '/repo/ws1' },
          sessions: [1, 2, 3, 4, 5].map((i) => v2Session(`s${i}`, i, 'ws1', '/repo/ws1')),
          total: 7,
        },
        {
          workspace: { id: 'ws2', cwd: '/repo/ws2' },
          sessions: [v2Session('s6', 6, 'ws2', '/repo/ws2')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });
    const state = createState();
    const ws = useWorkspaceState(state, createLoadDeps(state));

    await ws.load();

    expect(apiMock.listSessionGroupsV2).toHaveBeenCalledTimes(1);
    expect(apiMock.listSessionGroupsV2).toHaveBeenCalledWith({
      groupPageSize: 5,
      hasPrompt: true,
    });
    // The v1 per-workspace fan-out is fully replaced.
    expect(apiMock.listSessions).not.toHaveBeenCalled();
    expect(apiMock.listSessionsV2).not.toHaveBeenCalled();
    // Newest-first merge of both groups.
    expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    // hasMore comes from the group's full matching total; the empty workspace
    // (no group) defaults to a collapsed, exhausted state.
    expect(state.sessionsHasMoreByWorkspace).toEqual({ ws1: true, ws2: false, ws3: false });
    expect(state.sessionsCursorByWorkspace).toEqual({
      ws1: 's5',
      ws2: 's6',
      ws3: undefined,
    });
    expect(state.sessionsInitialCountByWorkspace).toEqual({ ws1: 5, ws2: 5, ws3: 5 });
  });

  it('matches a server-canonicalized alias group to the registered workspace by root', async () => {
    apiMock.listSessionGroupsV2.mockResolvedValue({
      groups: [
        {
          // The group carries the canonical id (the registry entry keeps its own).
          workspace: { id: 'wd_canonical', cwd: '/repo/ws1' },
          sessions: [v2Session('s1', 1, 'wd_legacy', '/repo/ws1')],
          total: 3,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    const state = createState();
    const ws = useWorkspaceState(state, createLoadDeps(state));

    await ws.load();

    expect(state.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(state.sessionsHasMoreByWorkspace['ws1']).toBe(true);
    expect(state.sessionsCursorByWorkspace['ws1']).toBe('s1');
    expect(state.sessionsHasMoreByWorkspace['ws2']).toBe(false);
  });

  it('drains follow-up group pages with the opaque token', async () => {
    apiMock.listSessionGroupsV2
      .mockResolvedValueOnce({
        groups: [
          {
            workspace: { id: 'ws1', cwd: '/repo/ws1' },
            sessions: [v2Session('s1', 1, 'ws1', '/repo/ws1')],
            total: 1,
          },
        ],
        hasMore: true,
        nextPageToken: 'gtok1',
        total: 2,
      })
      .mockResolvedValueOnce({
        groups: [
          {
            workspace: { id: 'ws2', cwd: '/repo/ws2' },
            sessions: [v2Session('s2', 2, 'ws2', '/repo/ws2')],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 2,
      });
    const state = createState();
    const ws = useWorkspaceState(state, createLoadDeps(state));

    await ws.load();

    expect(apiMock.listSessionGroupsV2).toHaveBeenCalledTimes(2);
    expect(apiMock.listSessionGroupsV2).toHaveBeenNthCalledWith(2, {
      groupPageSize: 5,
      hasPrompt: true,
      pageToken: 'gtok1',
    });
    expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('keeps the previous list when the grouped request fails', async () => {
    apiMock.listSessionGroupsV2.mockRejectedValue(new Error('network down'));
    const state = createState();
    const failure = vi.fn();
    const deps = { ...createLoadDeps(state), pushOperationFailure: failure };
    const ws = useWorkspaceState(state, deps);

    await ws.load();

    // No fallback on a transient failure (same server, same likely failure) —
    // the previous pool stays and the error is surfaced.
    expect(apiMock.listSessions).not.toHaveBeenCalled();
    expect(state.sessions.map((s) => s.id)).toEqual(['sess_1']);
    expect(failure).toHaveBeenCalled();
  });

  it('drains group pages until the token exhausts (no page cap)', async () => {
    // 11 workspaces → 11 sequential pages of one group each, all loaded.
    const workspaces = Array.from({ length: 11 }, (_, i) =>
      workspace(`ws${i + 1}`, `/repo/ws${i + 1}`, `ws${i + 1}`),
    );
    apiMock.listWorkspaces.mockResolvedValue(workspaces);
    for (let i = 0; i < 11; i += 1) {
      const last = i === 10;
      apiMock.listSessionGroupsV2.mockResolvedValueOnce({
        groups: [
          {
            workspace: { id: `ws${i + 1}`, cwd: `/repo/ws${i + 1}` },
            sessions: [v2Session(`s${i + 1}`, i + 1, `ws${i + 1}`, `/repo/ws${i + 1}`)],
            total: 1,
          },
        ],
        hasMore: !last,
        nextPageToken: last ? null : `gtok${i + 1}`,
        total: 11,
      });
    }
    const state = createState();
    const ws = useWorkspaceState(state, createLoadDeps(state));

    await ws.load();

    expect(apiMock.listSessionGroupsV2).toHaveBeenCalledTimes(11);
    expect(state.sessions.map((s) => s.id)).toHaveLength(11);
    expect(state.sessionsHasMoreByWorkspace['ws11']).toBe(false);
  });

  it('rehydrates live rows from the v1 read (restores mainTurnActive)', async () => {
    apiMock.listSessionGroupsV2.mockResolvedValue({
      groups: [
        {
          workspace: { id: 'ws1', cwd: '/repo/ws1' },
          sessions: [
            { ...v2Session('s_run', 1, 'ws1', '/repo/ws1'), activity: { status: 'running' as const } },
            v2Session('s_idle', 2, 'ws1', '/repo/ws1'),
          ],
          total: 2,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    // The v1 read carries main_turn_active — the field the v2 domain lacks.
    // Its other fields are an OLDER snapshot: a WS update landed meanwhile.
    apiMock.getSession.mockReset().mockResolvedValue({
      ...createSession(),
      id: 's_run',
      title: 'Stale snapshot title',
      busy: true,
      mainTurnActive: true,
    });
    const state = createState();
    // Keep the active session inside the grouped page — otherwise the new
    // active-session backfill issues its own getSession and pollutes the count.
    state.activeSessionId = 's_run';
    const ws = useWorkspaceState(state, createLoadDeps(state));

    await ws.load();

    expect(apiMock.getSession).toHaveBeenCalledTimes(1);
    expect(apiMock.getSession).toHaveBeenCalledWith('s_run');
    const run = state.sessions.find((s) => s.id === 's_run');
    expect(run?.mainTurnActive).toBe(true);
    // Only the hydration target fields merge — the stale snapshot must not
    // roll back the fresher pooled row.
    expect(run?.title).toBe('title-s_run');
    // Idle rows are not hydrated.
    expect(state.sessions.find((s) => s.id === 's_idle')?.mainTurnActive).toBeUndefined();
  });

  it('adopts a cleared activity state when the turn ended before the hydration read', async () => {
    apiMock.listSessionGroupsV2.mockResolvedValue({
      groups: [
        {
          workspace: { id: 'ws1', cwd: '/repo/ws1' },
          sessions: [
            { ...v2Session('s_run', 1, 'ws1', '/repo/ws1'), activity: { status: 'running' as const } },
          ],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    // The turn ENDED between the grouped response and the hydration read —
    // with no live event racing, the newer snapshot clears the stale state.
    apiMock.getSession.mockReset().mockResolvedValue({
      ...createSession(),
      id: 's_run',
      busy: false,
      mainTurnActive: false,
    });
    const state = createState();
    const ws = useWorkspaceState(state, createLoadDeps(state));

    await ws.load();

    const run = state.sessions.find((s) => s.id === 's_run');
    expect(run?.busy).toBe(false);
    expect(run?.mainTurnActive).toBe(false);
  });

  it('skips the hydration merge when a live event lands during the read', async () => {
    apiMock.listSessionGroupsV2.mockResolvedValue({
      groups: [
        {
          workspace: { id: 'ws1', cwd: '/repo/ws1' },
          sessions: [
            { ...v2Session('s_run', 1, 'ws1', '/repo/ws1'), activity: { status: 'running' as const } },
          ],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    let resolveGet: ((value: unknown) => void) | undefined;
    apiMock.getSession.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve;
        }),
    );
    const state = createState();
    // Same as above: keep the active session inside the grouped page so the
    // active-session backfill does not issue a competing getSession.
    state.activeSessionId = 's_run';
    const ws = useWorkspaceState(state, createLoadDeps(state));

    const pending = ws.load();
    await vi.waitFor(() => expect(apiMock.getSession).toHaveBeenCalled());
    // A live event for this session lands while the read is in flight — the
    // pool is newer, so the snapshot must not merge at all.
    state.lastSeqBySession = { s_run: 42 };
    resolveGet!({ ...createSession(), id: 's_run', busy: false, mainTurnActive: false });
    await pending;

    const run = state.sessions.find((s) => s.id === 's_run');
    expect(run?.busy).toBe(true);
  });

  it('refills goal state for approval/question rows only after hydration lands', async () => {
    apiMock.listSessionGroupsV2.mockResolvedValue({
      groups: [
        {
          workspace: { id: 'ws1', cwd: '/repo/ws1' },
          sessions: [
            { ...v2Session('s_appr', 1, 'ws1', '/repo/ws1'), activity: { status: 'approval' as const } },
          ],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    // v2 approval maps to busy=false + no main-turn flag; the parked turn is
    // still open on the server, so the v1 read reports main_turn_active.
    apiMock.getSession.mockReset().mockResolvedValue({
      ...createSession(),
      id: 's_appr',
      busy: false,
      mainTurnActive: true,
    });
    const state = createState();
    const deps = createLoadDeps(state);
    const ws = useWorkspaceState(state, deps);

    await ws.load();

    // busy=false would skip the refill if the loop ran before hydration —
    // the awaited hydration is what makes this call happen.
    expect(deps.refillSessionGoalOnReload).toHaveBeenCalledWith('s_appr');
  });

  it('keeps the live model when a v2 row replaces a pooled session', async () => {
    // The pool holds sess_1 with a resolved model ('kimi-code' from
    // createSession); v2 rows carry model:'' — swapping the pool on reload
    // must not reset it to the global default.
    apiMock.listSessionGroupsV2.mockResolvedValue({
      groups: [
        {
          workspace: { id: 'ws1', cwd: '/repo/ws1' },
          sessions: [v2Session('sess_1', 1, 'ws1', '/repo/ws1')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    const state = createState();
    const ws = useWorkspaceState(state, createLoadDeps(state));

    await ws.load();

    expect(state.sessions.find((s) => s.id === 'sess_1')?.model).toBe('kimi-code');
  });

  it('backfills the active session into the swapped pool when it falls outside the first pages', async () => {
    // The pool holds sess_1 (the ACTIVE session); the grouped first page
    // covers only ws1's five newest — the swap would drop the active row and
    // no auto-select / deep-link backfill would recover it.
    apiMock.listSessionGroupsV2.mockResolvedValue({
      groups: [
        {
          workspace: { id: 'ws1', cwd: '/repo/ws1' },
          sessions: [1, 2, 3, 4, 5].map((i) => v2Session(`s${i}`, i, 'ws1', '/repo/ws1')),
          total: 6,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    apiMock.getSession.mockReset().mockResolvedValue({
      ...createSession(),
      id: 'sess_1',
      workspaceId: 'ws1',
      cwd: '/repo/ws1',
      busy: false,
    });
    const state = createState();
    const ws = useWorkspaceState(state, createLoadDeps(state));

    await ws.load();

    expect(apiMock.getSession).toHaveBeenCalledWith('sess_1');
    expect(state.sessions.map((s) => s.id)).toContain('sess_1');
  });

  it('clears the active id when the backfill confirms the session was deleted', async () => {
    apiMock.listSessionGroupsV2.mockResolvedValue({
      groups: [
        {
          workspace: { id: 'ws1', cwd: '/repo/ws1' },
          sessions: [v2Session('s1', 1, 'ws1', '/repo/ws1')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    // The active session is gone from the server (40401 = session not found).
    apiMock.getSession.mockReset().mockRejectedValue(
      new DaemonApiError({ code: 40401, msg: 'session does not exist', requestId: 'r' }),
    );
    const state = createState();
    state.activeSessionId = 'sess_gone';
    const deps = createLoadDeps(state);
    const ws = useWorkspaceState(state, deps);

    await ws.load();

    expect(deps.setActiveSessionId).toHaveBeenCalledWith(undefined);
  });

  it('refreshes the active session status after the pool swap', async () => {
    apiMock.listSessionGroupsV2.mockResolvedValue({
      groups: [
        {
          workspace: { id: 'ws1', cwd: '/repo/ws1' },
          sessions: [v2Session('sess_1', 1, 'ws1', '/repo/ws1')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    const state = createState();
    const deps = createLoadDeps(state);
    const ws = useWorkspaceState(state, deps);

    await ws.load();

    expect(deps.refreshSessionStatus).toHaveBeenCalledWith('sess_1');
  });

  it('filters archive tombstones out of grouped rows and cursors', async () => {
    apiMock.listSessionGroupsV2.mockResolvedValue({
      groups: [
        {
          workspace: { id: 'ws1', cwd: '/repo/ws1' },
          sessions: [
            v2Session('s1', 1, 'ws1', '/repo/ws1'),
            v2Session('s2', 2, 'ws1', '/repo/ws1'),
            v2Session('s3', 3, 'ws1', '/repo/ws1'),
          ],
          total: 4,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    const state = createState();
    const ws = useWorkspaceState(state, createLoadDeps(state));

    // The grouped response was fetched before the archive event landed.
    await ws.applyRemoteSessionArchived('s3');
    await ws.load();

    expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    // The cursor comes from the filtered tail, never the archived page tail.
    expect(state.sessionsCursorByWorkspace['ws1']).toBe('s2');
    expect(state.sessionsHasMoreByWorkspace['ws1']).toBe(true);
  });

  it('falls back to the matched workspace root when a v2 row has no cwd', async () => {
    apiMock.listSessionGroupsV2.mockResolvedValue({
      groups: [
        {
          workspace: { id: 'ws1', cwd: '/repo/ws1' },
          sessions: [
            { ...v2Session('s1', 1, 'ws1', '/repo/ws1'), workspace: { id: 'ws1', cwd: null } },
          ],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    const state = createState();
    const ws = useWorkspaceState(state, createLoadDeps(state));

    await ws.load();

    expect(state.sessions.find((s) => s.id === 's1')?.cwd).toBe('/repo/ws1');
  });
});
