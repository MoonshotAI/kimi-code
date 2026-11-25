
import { computed, nextTick, ref, watch } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApprovalRequest, AppQuestionRequest, AppSession, InteractionRespondResult, KimiWebApi, PromptSubmission, PromptSubmitResult, ThinkingLevel } from '@moonshot-ai/app-core/api';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import { createInitialState } from '@moonshot-ai/app-core/api';
import { mergeWorkspaces } from '@moonshot-ai/app-core/lib';
import { foldDaemonThinkingLevel } from '@moonshot-ai/app-core/lib';
import { loadWorkspaceNameOverridesById, saveWorkspaceNameOverridesById } from '@moonshot-ai/app-core/lib';
import { insertSessionByRecency } from '@moonshot-ai/app-core/lib';
import { safeRemove, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { createComposerSnapshot, textToDoc } from '@moonshot-ai/app-composer/model';
import type { Translator } from '@moonshot-ai/app-core/contracts';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { approvalsStore } from '../src/stores/approvals';
import { authStore } from '../src/stores/auth';
import { modelsStore } from '../src/stores/models';
import { permissionsStore, setPermissionsHooks } from '../src/stores/permissions';
import { promptStore } from '../src/stores/prompt';
import { connectionStore, setEventConn } from '../src/stores/connection';
import { sessionRuntimeStore } from '../src/stores/sessionRuntime';
import { sessionsStore } from '../src/stores/sessions';
import { sessionListStore, setSessionListHooks } from '../src/stores/sessionList';
import { modeStore, setModeHooks } from '../src/stores/mode';
import { goalStore, setGoalHooks } from '../src/stores/goal';
import { tasksStore } from '../src/stores/tasks';
import { setApprovalsHooks } from '../src/stores/approvals';
import { configStore } from '../src/stores/config';
import { filesStore } from '../src/stores/files';
import { warningsStore } from '../src/stores/warnings';
import { workspacesStore } from '../src/stores/workspaces';
import type { ExtendedState } from '../src/client/types';
import type { PersistSessionProfilePatch } from '../src/client/useModelProviderState';
import { createWorkspaceRig, type WorkspaceRig, type WorkspaceRigDeps } from '../src/testing/workspaceRig';
import { useConfirmDialog } from '../src/composables/useConfirmDialog';
const apiMock = {
  abortPrompt: vi.fn(),
  cancelSession: vi.fn(),
  addWorkspace: vi.fn(),
  archiveSession: vi.fn(),
  updateWorkspace: vi.fn(),
  setWorkspacePrimary: vi.fn(),
  getWorkspaceProjectConfigDirs: vi.fn(),
  createSession: vi.fn(),
  exportSession: vi.fn(),
  forkSession: vi.fn(),
  restoreSession: vi.fn(),
  updateSession: vi.fn(),
  submitPrompt: vi.fn(),
  steerPrompt: vi.fn(),
  steerPrompts: vi.fn(),
  respondQuestion: vi.fn(),
  respondApproval: vi.fn(),
  dismissQuestion: vi.fn(),
  getAuth: vi.fn(),
  getUserInfo: vi.fn(),
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  getFsHome: vi.fn(),
  getHealth: vi.fn(),
  getMeta: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  listSessionGroups: vi.fn(),
  listWorkspaces: vi.fn(),
  searchFiles: vi.fn(),
  suggestFiles: vi.fn(),
};

function echoPromptSubmit(status?: PromptSubmitResult['status']) {
  return async (_sid: string, input: PromptSubmission): Promise<PromptSubmitResult> => ({
    promptId: input.promptId!,
    userMessageId: input.promptId!,
    status,
  });
}

function sentPromptId(index = 0): string {
  return (apiMock.submitPrompt.mock.calls[index]![1] as PromptSubmission).promptId!;
}

const i18n = createKimiI18n({ locale: 'en' });
const t: Translator = (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params));

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

function resetWorkspacesStore(): void {
  const store = workspacesStore();
  store.workspaces = [];
  store.storedActiveWorkspaceId = null;
  store.fsHome = null;
  store.recentRoots = [];
  store.hiddenWorkspaceIds = [];
  store.workspaceOrder = [];
  store.workspaceSortMode = 'manual';
  store.workspaceRecencyFloor = {};
  store.sessionsHasMoreByWorkspace = {};
  store.sessionsLoadingMoreByWorkspace = {};
  store.sessionsCursorByWorkspace = {};
  store.sessionsInitialCountByWorkspace = {};
  sessionsStore().setSessions([]);
  sessionsStore().setActiveSessionId(undefined);
  sessionsStore().unpinSessions([...sessionsStore().pinnedSessionIds]);
  sessionListStore().resetSessionList();
  modeStore().resetMode();
  goalStore().resetGoals();
  configStore().resetConfig();
  filesStore().resetFilesSearch();
  tasksStore().resetTasks();
}

function resetPromptStore(): void {
  const store = promptStore();
  for (const sid of Object.keys(store.queuedBySession)) store.forgetPromptState(sid);
  for (const sid of Object.keys(store.inFlightBySession)) store.forgetPromptState(sid);
  store.queuedBySession = {};
  store.inFlightBySession = {};
  store.optimisticMessagesBySession = {};
  store.setDraftEntry('newChat');
}

function resetConnectionStore(): void {
  const store = connectionStore();
  store.connected = false;
  store.connection = 'disconnected';
  store.connectionGeneration = 0;
  store.wsEverConnected = false;
  store.wsDisconnectedAt = null;
  store.eventCountBySession.clear();
  store.sessionWorkBaseline.run = null;
  store.sessionWorkBaseline.attempts = 0;
  store.sessionWorkBaseline.lastError = null;
  store.sessionWorkBaseline.cooldownUntil = null;
  store.cancelSessionWorkBaselineRetry();
  setEventConn(null);
}

function resetSessionRuntimeStore(): void {
  const store = sessionRuntimeStore();
  store.runtimes.clear();
  store.profileWriteChainBySid.clear();
  store.lastTurnReasonChangeBySession = {};
}
const pushFailureSpy = vi.spyOn(warningsStore(), 'pushOperationFailure');
beforeEach(() => {
  setKimiClientDeps({
    api: () => apiMock as unknown as KimiWebApi,
    t,
    traceKeyEvent: recordKeyEvent,
    sessionExportTraceToJsonl: exportTraceRecordsToJsonl,
  });
  pushFailureSpy.mockClear();
  warningsStore().resetWarnings();
  resetWorkspacesStore();
  resetPromptStore();
  resetConnectionStore();
  resetSessionRuntimeStore();
  authStore().resetAuth();
  authStore().connectIssue = null;
  modelsStore().setModels([]);
  modelsStore().setModelsReady(false);
  modelsStore().setDefaultModel(null);
  modelsStore().setDraftModel(null);
  safeRemove(STORAGE_KEYS.permission);
  safeRemove(STORAGE_KEYS.permissionBySession);
  safeRemove(STORAGE_KEYS.permissionExplicit);
  safeRemove(STORAGE_KEYS.permissionStickyAt);
  permissionsStore().$reset();
});

afterEach(() => {
  resetKimiClientDeps();
  setModeHooks(null);
  setGoalHooks(null);
  setPermissionsHooks(null);
  setApprovalsHooks(null);
});

function createSession(): AppSession {
  return {
    id: 'sess_1',
    title: 'Session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    busy: true,
    archived: false,
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
  };
}

function createState(): ExtendedState {
  const state: ExtendedState = {
    ...createInitialState(),
    doneSessions: [],
    doneSessionsNextPageToken: null,
    doneSessionsHasMore: false,
    doneSessionsLoading: false,
    doneSessionsLoadingMore: false,
    doneSessionsSeeded: false,
    mainView: 'chat',
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
    connected: true,
    get serverVersion() {
      return configStore().serverVersion;
    },
    get dangerousBypassAuth() {
      return configStore().dangerousBypassAuth;
    },
    set dangerousBypassAuth(next: boolean) {
      configStore().dangerousBypassAuth = next;
    },
    get backend() {
      return configStore().backend;
    },
    set backend(next: 'v1' | 'v2') {
      configStore().backend = next;
    },
    get experimentalFlags() {
      return configStore().experimentalFlags;
    },
    workspaceName: 'kimi-web',
    connection: 'connected',
    get thinking() {
      return modeStore().thinking;
    },
    set thinking(next: ThinkingLevel | undefined) {
      modeStore().thinking = next;
    },
    get draftThinkingExplicit() {
      return modeStore().draftThinkingExplicit;
    },
    set draftThinkingExplicit(next: boolean) {
      modeStore().draftThinkingExplicit = next;
    },
    get thinkingBySession() {
      return modeStore().thinkingBySession;
    },
    set thinkingBySession(next: Record<string, ThinkingLevel>) {
      modeStore().thinkingBySession = next;
    },
    get pendingThinkingBySession() {
      return modeStore().pendingThinkingBySession;
    },
    set pendingThinkingBySession(next: Record<string, number>) {
      modeStore().pendingThinkingBySession = next;
    },
    get planModeBySession() {
      return modeStore().planModeBySession;
    },
    set planModeBySession(next: Record<string, boolean>) {
      modeStore().planModeBySession = next;
    },
    get planArmedBySession() {
      return modeStore().planArmedBySession;
    },
    set planArmedBySession(next: Record<string, boolean>) {
      modeStore().planArmedBySession = next;
    },
    get pendingPlanBySession() {
      return modeStore().pendingPlanBySession;
    },
    set pendingPlanBySession(next: Record<string, number>) {
      modeStore().pendingPlanBySession = next;
    },
    get swarmModeBySession() {
      return modeStore().swarmModeBySession;
    },
    set swarmModeBySession(next: Record<string, boolean>) {
      modeStore().swarmModeBySession = next;
    },
    get pendingSwarmBySession() {
      return modeStore().pendingSwarmBySession;
    },
    set pendingSwarmBySession(next: Record<string, number>) {
      modeStore().pendingSwarmBySession = next;
    },
    get towerModeBySession() {
      return modeStore().towerModeBySession;
    },
    set towerModeBySession(next: Record<string, boolean>) {
      modeStore().towerModeBySession = next;
    },
    get pendingTowerBySession() {
      return modeStore().pendingTowerBySession;
    },
    set pendingTowerBySession(next: Record<string, number>) {
      modeStore().pendingTowerBySession = next;
    },
    get goalModeBySession() {
      return modeStore().goalModeBySession;
    },
    set goalModeBySession(next: Record<string, boolean>) {
      modeStore().goalModeBySession = next;
    },
    loading: false,
    sessionLoading: false,
    gitStatusBySession: {},
    sessionsFullyLoaded: false,
    get availableOpenInApps() {
      return configStore().availableOpenInApps;
    },
    get config() {
      return configStore().config;
    },
    set config(next: ExtendedState['config']) {
      configStore().config = next;
    },
    sideChatMessagesByAgent: {},
    sideChatSendingByAgent: {},
    sideChatTurnErrorByAgent: {},
  };
  state.thinking = 'high';
  state.activeSessionId = 'sess_1';
  state.sessions = [createSession()];
  return state;
}

function createDeps(): WorkspaceRigDeps {
  return {
    sideChat: { clearSideChatForSession: vi.fn() },
    modelProvider: { resolveThinkingForPrompt: () => undefined },
    activity: computed(() => 'running'),
    setSessions: vi.fn(),
    updateSession: vi.fn(),
    upsertSessionSorted: vi.fn(),
    appendSession: vi.fn(),
    forgetSession: vi.fn(),
    setActiveSessionId: vi.fn((id: string | undefined) => sessionsStore().setActiveSessionId(id)),
    nextOptimisticMsgId: () => 'msg_opt_1',
    mainUndoTarget: () => null,
    refreshMainTranscript: vi.fn(),
    hasLoadedMessages: vi.fn(),
    markSessionStatusSettled: vi.fn(),
    persistSessionProfile: vi.fn().mockResolvedValue(true),
    whenSessionProfileSettled: vi.fn(async () => true),
    hasUnechoedPrompt: (sid: string) => (promptStore().optimisticMessagesBySession[sid]?.length ?? 0) > 0,
    basename: (path: string) => path.split('/').at(-1) ?? path,
  } as unknown as WorkspaceRigDeps;
}

function endMainTurn(ws: WorkspaceRig): void {
  promptStore().setInFlight('sess_1', false);
  promptStore().clearOptimisticMessages('sess_1');
  ws.resumeQueueIfIdle('sess_1');
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
  return {
    id,
    root,
    name,
    kind: id.startsWith('wm_') ? 'managed' : 'implicit',
    additionalDirs: [],
    sessionCount: 1,
  };
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

describe('useWorkspaceState — abortCurrentPrompt', () => {
  beforeEach(() => {
    apiMock.abortPrompt.mockReset();
    apiMock.cancelSession.mockReset();
  });

  function abortDeps(promptId: string | undefined): WorkspaceRigDeps {
    return { ...createDeps(), promptIdToAbort: () => promptId, isMainTurnRunning: () => true };
  }

  it('does not fall back to session cancel once the daemon calls the prompt not-abortable', async () => {
    apiMock.abortPrompt.mockResolvedValue({ aborted: false });
    const workspace = createWorkspaceRig(createState(), abortDeps('prompt_live'));

    expect(await workspace.abortCurrentPrompt()).toBe(false);

    expect(apiMock.abortPrompt).toHaveBeenCalledWith('sess_1', 'prompt_live');
    expect(apiMock.cancelSession).not.toHaveBeenCalled();
  });

  it('falls back to session cancel for a fresh submit without a prompt id', async () => {
    apiMock.cancelSession.mockResolvedValue({ cancelled: true });
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    const workspace = createWorkspaceRig(state, abortDeps(undefined));

    await workspace.abortCurrentPrompt();

    expect(apiMock.abortPrompt).not.toHaveBeenCalled();
    expect(apiMock.cancelSession).toHaveBeenCalledWith('sess_1');
  });

  it('does not fall back when prompt abort succeeds, and drops the aborted prompt bubble', async () => {
    apiMock.abortPrompt.mockResolvedValue({ aborted: true });
    promptStore().setOptimisticMessages('sess_1', [
      { id: 'm1', sessionId: 'sess_1', role: 'user', content: [], createdAt: '', metadata: { 'kimiWeb.promptId': 'prompt_live' } },
      { id: 'm2', sessionId: 'sess_1', role: 'user', content: [], createdAt: '', metadata: { 'kimiWeb.promptId': 'prompt_next' } },
    ]);
    const workspace = createWorkspaceRig(createState(), abortDeps('prompt_live'));

    expect(await workspace.abortCurrentPrompt()).toBe(true);

    expect(apiMock.abortPrompt).toHaveBeenCalledWith('sess_1', 'prompt_live');
    expect(apiMock.cancelSession).not.toHaveBeenCalled();
    expect(promptStore().optimisticMessagesBySession.sess_1?.map((message) => message.id)).toEqual(['m2']);
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
    const workspace = createWorkspaceRig(createState(), createDeps());

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
    const workspace = createWorkspaceRig(state, deps);

    const first = workspace.exportSession();
    state.activeSessionId = 'sess_2';
    const second = workspace.exportSession();
    resolveExport({ blob: new Blob(['zip']), fileName: 'sess_1.zip' });
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
    const workspace = createWorkspaceRig(createState(), deps);

    await workspace.exportSession();

    expect(anchor.remove).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:session-export');
    });
    expect(pushFailureSpy).toHaveBeenCalledWith(
      'exportSession',
      expect.any(Error),
      { sessionId: 'sess_1' },
    );
  });

  it('surfaces an error instead of silently exporting without an active session', async () => {
    const state = createState();
    state.activeSessionId = undefined;
    const deps = createDeps();
    const workspace = createWorkspaceRig(state, deps);

    await expect(workspace.exportSession()).resolves.toBe(false);

    expect(apiMock.exportSession).not.toHaveBeenCalled();
    expect(pushFailureSpy).toHaveBeenCalledWith(
      'exportSession',
      expect.any(Error),
      expect.objectContaining({ message: expect.any(String) }),
    );
  });

  it('resolves false when the export fails, so a retry can start', async () => {
    apiMock.exportSession.mockRejectedValue(new Error('boom'));
    const workspace = createWorkspaceRig(createState(), createDeps());

    await expect(workspace.exportSession()).resolves.toBe(false);
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
    const workspace = createWorkspaceRig(createState(), deps);

    await workspace.exportSession();

    expect(pushFailureSpy).toHaveBeenCalledWith(
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
    const workspace = createWorkspaceRig(createState(), deps);

    await workspace.exportSession();

    expect(pushFailureSpy).toHaveBeenCalledWith(
      'exportSession',
      expect.any(Error),
      { sessionId: 'sess_1' },
    );
  });
});

describe('mergeWorkspaces', () => {
  it('keeps same-root registry entries separate and buckets sessions by workspaceId', () => {
    const result = mergeWorkspaces({
      workspaces: [
        { id: 'wd_current', root: '/agent/GEO', name: 'GEO',sessionCount: 0 },
        { id: 'wm_legacy', root: '/agent/GEO', name: 'GEO',sessionCount: 0 },
      ],
      sessions: [{ id: 's1', cwd: '/agent/GEO', workspaceId: 'wm_legacy' }],
      hiddenWorkspaceIds: [],
      sessionsHasMoreByWorkspace: { wd_current: false },
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('wd_current');
    expect(result[0]?.sessionCount).toBe(0);
    expect(result[1]?.id).toBe('wm_legacy');
    expect(result[1]?.sessionCount).toBe(1);
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
      hiddenWorkspaceIds: [],
      sessionsHasMoreByWorkspace: {},
    });

    expect(result.map((w) => w.root)).toEqual(['/agent/A', '/agent/B']);
    expect(result.find((w) => w.root === '/agent/B')?.id).toBe('wd_b');
  });

  it('hides workspaces whose id the user removed', () => {
    const result = mergeWorkspaces({
      workspaces: [
        { id: 'wd_a', root: '/agent/A', name: 'A',sessionCount: 1 },
      ],
      sessions: [{ id: 's1', cwd: '/agent/A', workspaceId: 'wd_a' }],
      hiddenWorkspaceIds: ['wd_a'],
      sessionsHasMoreByWorkspace: {},
    });

    expect(result.map((w) => w.root)).not.toContain('/agent/A');
  });
});

describe('kimi.workspaces — renameWorkspace', () => {
  beforeEach(() => {
    apiMock.updateWorkspace.mockReset();
    installStorage(createMemoryStorage());
  });

  afterEach(() => {
    installStorage(createMemoryStorage());
  });

  it('renames via the daemon and applies the name locally', async () => {
    apiMock.updateWorkspace.mockResolvedValue(workspace('wd_1', '/abs/path', 'New'));
    createState();
    workspacesStore().workspaces = [workspace('wd_1', '/abs/path', 'Old')];

    await workspacesStore().renameWorkspace('wd_1', 'New');

    expect(apiMock.updateWorkspace).toHaveBeenCalledWith('wd_1', { name: 'New' });
    expect(workspacesStore().workspaces[0]?.name).toBe('New');
    expect(loadWorkspaceNameOverridesById()).toEqual({});
    expect(pushFailureSpy).not.toHaveBeenCalled();
  });

  it('falls back to a local override when the daemon reports not found', async () => {
    apiMock.updateWorkspace.mockRejectedValue(
      new DaemonApiError({ code: 40410, msg: 'workspace not found', requestId: 'r' }),
    );
    createState();
    workspacesStore().workspaces = [workspace('wd_1', '/abs/path', 'Old')];

    await workspacesStore().renameWorkspace('wd_1', 'New');

    expect(workspacesStore().workspaces[0]?.name).toBe('New');
    expect(loadWorkspaceNameOverridesById()).toEqual({ wd_1: 'New' });
    expect(pushFailureSpy).not.toHaveBeenCalled();
  });

  it('surfaces daemon errors other than not-found', async () => {
    apiMock.updateWorkspace.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }),
    );
    createState();
    workspacesStore().workspaces = [workspace('wd_1', '/abs/path', 'Old')];

    await workspacesStore().renameWorkspace('wd_1', 'New');

    expect(workspacesStore().workspaces[0]?.name).toBe('Old');
    expect(loadWorkspaceNameOverridesById()).toEqual({});
    expect(pushFailureSpy).toHaveBeenCalled();
  });

  it('keeps a saved name override when a workspace is upserted (derived → registered)', () => {
    saveWorkspaceNameOverridesById({ wd_1: 'Renamed' });

    workspacesStore().upsertWorkspacePreserveOrder(workspace('wd_1', '/abs/path', 'path'));

    expect(workspacesStore().workspaces[0]?.name).toBe('Renamed');
  });
});

describe('kimi.workspaces — addWorkspaceByPath', () => {
  beforeEach(() => {
    apiMock.addWorkspace.mockReset();
    workspacesStore().resetCreateWorkspaceAttempt();
  });

  it('registers the workspace with the daemon and selects it', async () => {
    const registered = workspace('wd_abc', '/abs/path', 'path');
    apiMock.addWorkspace.mockResolvedValue(registered);
    createState();

    const ok = await workspacesStore().addWorkspaceByPath('  /abs/path  ');

    expect(ok).toBe(true);
    expect(apiMock.addWorkspace).toHaveBeenCalledWith({
      root: '/abs/path',
      idempotencyKey: expect.any(String),
    });
    expect(workspacesStore().workspaces).toContainEqual(registered);
    expect(workspacesStore().storedActiveWorkspaceId).toBe('wd_abc');
    expect(pushFailureSpy).not.toHaveBeenCalled();
  });

  it('strips surrounding double quotes from a pasted Windows "Copy as path" value', async () => {
    const registered = workspace('wd_win', 'D:\\Extensions', 'Extensions');
    apiMock.addWorkspace.mockResolvedValue(registered);
    createState();

    const ok = await workspacesStore().addWorkspaceByPath('"D:\\Extensions"');

    expect(ok).toBe(true);
    expect(apiMock.addWorkspace).toHaveBeenCalledWith({
      root: 'D:\\Extensions',
      idempotencyKey: expect.any(String),
    });
  });

  it('strips surrounding single quotes and trims inside them', async () => {
    const registered = workspace('wd_sq', '/abs/path with spaces', 'path with spaces');
    apiMock.addWorkspace.mockResolvedValue(registered);
    createState();

    const ok = await workspacesStore().addWorkspaceByPath("  '/abs/path with spaces'  ");

    expect(ok).toBe(true);
    expect(apiMock.addWorkspace).toHaveBeenCalledWith({
      root: '/abs/path with spaces',
      idempotencyKey: expect.any(String),
    });
  });

  it('keeps unmatched quotes — they can be part of a real folder name', async () => {
    const registered = workspace('wd_um', '"/abs/quoted', 'quoted');
    apiMock.addWorkspace.mockResolvedValue(registered);
    createState();

    const ok = await workspacesStore().addWorkspaceByPath('"/abs/quoted');

    expect(ok).toBe(true);
    expect(apiMock.addWorkspace).toHaveBeenCalledWith({
      root: '"/abs/quoted',
      idempotencyKey: expect.any(String),
    });
  });

  it('returns false for a pair of quotes with nothing inside', async () => {
    createState();

    const ok = await workspacesStore().addWorkspaceByPath('""');

    expect(ok).toBe(false);
    expect(apiMock.addWorkspace).not.toHaveBeenCalled();
  });

  it('returns false and adds no local workspace on failure', async () => {
    const err = new Error('path not found');
    apiMock.addWorkspace.mockRejectedValue(err);
    createState();

    const ok = await workspacesStore().addWorkspaceByPath('/abs/missing');

    expect(ok).toBe(false);
    expect(pushFailureSpy).not.toHaveBeenCalled();
    expect(workspacesStore().workspaces).toEqual([]);
    expect(workspacesStore().storedActiveWorkspaceId).toBeNull();
  });

  it('reuses the idempotency key only for the same unfinished path creation', async () => {
    apiMock.addWorkspace
      .mockRejectedValueOnce(new Error('response lost'))
      .mockImplementation(async (input: { root: string }) => workspace('wd_retry', input.root, 'retry'));
    createState();

    expect(await workspacesStore().addWorkspaceByPath('/abs/path')).toBe(false);
    expect(await workspacesStore().addWorkspaceByPath('/abs/path')).toBe(true);
    expect(await workspacesStore().addWorkspaceByPath('/other')).toBe(true);
    expect(await workspacesStore().addWorkspaceByPath('/abs/path')).toBe(true);

    const keys = apiMock.addWorkspace.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys).toHaveLength(4);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[2]);
  });
});

describe('workspace creation without randomUUID', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(1),
    });
    apiMock.addWorkspace.mockReset();
    workspacesStore().resetCreateWorkspaceAttempt();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    workspacesStore().resetCreateWorkspaceAttempt();
  });

  it('creates a workspace with a fallback idempotency key', async () => {
    const created = workspace('wd_create', '/abs/path', 'path');
    apiMock.addWorkspace.mockResolvedValue(created);
    createState();

    await expect(workspacesStore().createWorkspace({ paths: ['/abs/path'] })).resolves.toEqual(created);

    expect(apiMock.addWorkspace).toHaveBeenCalledWith({
      root: '/abs/path',
      idempotencyKey: '01010101-0101-4101-8101-010101010101',
    });
  });

  it('adds a workspace by path with a fallback idempotency key', async () => {
    const registered = workspace('wd_add', '/abs/path', 'path');
    apiMock.addWorkspace.mockResolvedValue(registered);
    createState();

    await expect(workspacesStore().addWorkspaceByPath('/abs/path')).resolves.toBe(true);

    expect(apiMock.addWorkspace).toHaveBeenCalledWith({
      root: '/abs/path',
      idempotencyKey: '01010101-0101-4101-8101-010101010101',
    });
  });
});

describe('kimi.approvals — respondQuestion', () => {
  const response = { answers: {}, method: 'click' as const };

  beforeEach(() => {
    apiMock.respondQuestion.mockReset();
    approvalsStore().clearSessionQuestions('sess_1');
  });

  it('removes the question locally and stays silent when already resolved (40902)', async () => {
    apiMock.respondQuestion.mockRejectedValue(
      new DaemonApiError({ code: 40902, msg: 'question q_1 already resolved', requestId: 'r' }),
    );
    createState();
    approvalsStore().setSessionQuestions('sess_1', [questionRequest('q_1')]);

    await approvalsStore().respondQuestion('q_1', response);

    expect(apiMock.respondQuestion).toHaveBeenCalledOnce();
    expect(approvalsStore().questionsBySession['sess_1']).toEqual([]);
    expect(pushFailureSpy).not.toHaveBeenCalled();
  });

  it('surfaces genuine errors and keeps the question for retry', async () => {
    apiMock.respondQuestion.mockRejectedValue(
      new DaemonApiError({ code: 50001, msg: 'boom', requestId: 'r' }),
    );
    createState();
    approvalsStore().setSessionQuestions('sess_1', [questionRequest('q_1')]);
    setApprovalsHooks({
      pushOperationFailure: (...args) => pushFailureSpy(...args),
    });

    await approvalsStore().respondQuestion('q_1', response);

    expect(approvalsStore().questionsBySession['sess_1']).toHaveLength(1);
    expect(pushFailureSpy).toHaveBeenCalledOnce();
  });

  it('drops a duplicate submit while the first respond is still in flight', async () => {
    let resolveRespond!: (value: InteractionRespondResult) => void;
    apiMock.respondQuestion.mockReturnValue(
      new Promise<InteractionRespondResult>((r) => {
        resolveRespond = r;
      }),
    );
    createState();
    approvalsStore().setSessionQuestions('sess_1', [questionRequest('q_1')]);

    const first = approvalsStore().respondQuestion('q_1', response);
    await approvalsStore().respondQuestion('q_1', response);

    expect(apiMock.respondQuestion).toHaveBeenCalledOnce();

    resolveRespond({ outcome: 'approved', endedAt: '2026-01-01T00:00:00.000Z' });
    await first;
    expect(approvalsStore().questionsBySession['sess_1']).toEqual([]);
  });
});

describe('kimi.approvals — respondApproval', () => {
  beforeEach(() => {
    apiMock.respondApproval.mockReset();
    approvalsStore().clearSessionApprovals('sess_1');
  });

  it('removes the approval locally and stays silent when already resolved (40902)', async () => {
    apiMock.respondApproval.mockRejectedValue(
      new DaemonApiError({ code: 40902, msg: 'approval a_1 already resolved', requestId: 'r' }),
    );
    createState();
    approvalsStore().setSessionApprovals('sess_1', [approvalRequest('a_1')]);

    await approvalsStore().respondApproval('a_1', { decision: 'approved' });

    expect(apiMock.respondApproval).toHaveBeenCalledOnce();
    expect(approvalsStore().approvalsBySession['sess_1']).toEqual([]);
    expect(pushFailureSpy).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — startSessionAndActivateSkill', () => {
  const registered = { id: 'wd_1', root: '/abs/path', name: 'A',sessionCount: 1 };
  const newSession = { ...createSession(), id: 'sess_new', workspaceId: 'wd_1', cwd: '/abs/path' };

  beforeEach(() => {
    apiMock.addWorkspace.mockReset();
    apiMock.createSession.mockReset();
    apiMock.addWorkspace.mockResolvedValue(registered);
    apiMock.createSession.mockResolvedValue(newSession);
    workspacesStore().workspaces = [workspace('wd_1', '/abs/path', 'A')];
  });

  function skillDeps(activateSkill: ReturnType<typeof vi.fn>): WorkspaceRigDeps {
    return {
      ...createDeps(),
      modelProvider: {
        draftModel: ref(null),
        skillsBySession: ref({}),
        loadSkillsForSession: vi.fn(),
        activateSkill,
        resolveThinkingForPrompt: () => undefined,
      } as unknown as WorkspaceRigDeps['modelProvider'],
    };
  }

  it('creates a session, then activates the skill on the new session id', async () => {
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const ws = createWorkspaceRig(createState(), deps);

    await ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');

    expect(apiMock.createSession).toHaveBeenCalledOnce();
    expect(activateSkill).toHaveBeenCalledWith('pre-changelog', undefined, undefined, 'sess_new', {
      snapshot: undefined,
    });
    expect(pushFailureSpy).not.toHaveBeenCalled();
  });

  it('creates in an unlisted workspace by id, without its sessions cwd, when the registry is unavailable', async () => {
    const state = createState();
    workspacesStore().workspaces = [];
    sessionsStore().setSessions([
      { ...createSession(), id: 'sess_old', workspaceId: 'wd_derived_123456789abc', cwd: '/abs/path' },
      ...state.sessions,
    ]);
    apiMock.createSession.mockResolvedValue({ ...newSession, workspaceId: 'wd_derived_123456789abc' });
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const ws = createWorkspaceRig(state, skillDeps(activateSkill));

    await ws.startSessionAndActivateSkill('wd_derived_123456789abc', 'pre-changelog');

    expect(apiMock.createSession).toHaveBeenCalledOnce();
    expect(apiMock.createSession).toHaveBeenCalledWith({
      workspaceId: 'wd_derived_123456789abc',
      cwd: undefined,
      model: undefined,
    });
    expect(activateSkill).toHaveBeenCalledOnce();
  });

  it('keeps legacy cwd-derived workspaces on the cwd creation path', async () => {
    const state = createState();
    workspacesStore().workspaces = [];
    sessionsStore().setSessions([
      { ...createSession(), id: 'sess_old', cwd: '/abs/path' },
      ...state.sessions,
    ]);
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const ws = createWorkspaceRig(state, skillDeps(activateSkill));

    await ws.startSessionAndActivateSkill('/abs/path', 'pre-changelog');

    expect(apiMock.createSession).toHaveBeenCalledOnce();
    expect(apiMock.createSession).toHaveBeenCalledWith({
      workspaceId: undefined,
      cwd: '/abs/path',
      model: undefined,
    });
    expect(activateSkill).toHaveBeenCalledOnce();
  });

  it('falls back to cwd only after the daemon rejects the workspace id', async () => {
    const state = createState();
    workspacesStore().workspaces = [];
    sessionsStore().setSessions([
      { ...createSession(), id: 'sess_old', workspaceId: 'wd_derived_123456789abc', cwd: '/abs/path' },
      ...state.sessions,
    ]);
    apiMock.createSession
      .mockRejectedValueOnce(new DaemonApiError({ code: 40410, msg: 'workspace not found', requestId: 'r' }))
      .mockResolvedValueOnce({ ...newSession, workspaceId: undefined });
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const ws = createWorkspaceRig(state, skillDeps(activateSkill));

    await ws.startSessionAndActivateSkill('wd_derived_123456789abc', 'pre-changelog');

    expect(apiMock.createSession).toHaveBeenCalledTimes(2);
    expect(apiMock.createSession).toHaveBeenNthCalledWith(1, {
      workspaceId: 'wd_derived_123456789abc',
      cwd: undefined,
      model: undefined,
    });
    expect(apiMock.createSession).toHaveBeenNthCalledWith(2, {
      workspaceId: undefined,
      cwd: '/abs/path',
      model: undefined,
    });
    expect(activateSkill).toHaveBeenCalledOnce();
  });

  it('does not retry session creation without a workspace-not-found response', async () => {
    const state = createState();
    workspacesStore().workspaces = [];
    sessionsStore().setSessions([
      { ...createSession(), id: 'sess_old', workspaceId: 'wd_derived_123456789abc', cwd: '/abs/path' },
      ...state.sessions,
    ]);
    apiMock.createSession.mockRejectedValue(
      new DaemonApiError({ code: 500, msg: 'unavailable', requestId: 'r' }),
    );
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const ws = createWorkspaceRig(state, skillDeps(activateSkill));

    await ws.startSessionAndActivateSkill('wd_derived_123456789abc', 'pre-changelog');

    expect(apiMock.createSession).toHaveBeenCalledOnce();
    expect(activateSkill).not.toHaveBeenCalled();
    expect(pushFailureSpy).toHaveBeenCalledOnce();
  });

  it('carries the draft thinking pick into the new session own entry', async () => {
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const state = createState();
    state.thinking = 'max';
    state.draftThinkingExplicit = true;
    const ws = createWorkspaceRig(state, deps);

    await ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');

    expect(state.thinkingBySession['sess_new']).toBe('max');
  });

  it('does NOT seed an inherited (non-explicit) draft level into the new session', async () => {
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const state = createState();
    state.thinking = 'max';
    state.draftThinkingExplicit = false;
    const ws = createWorkspaceRig(state, deps);

    await ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');

    expect(state.thinkingBySession['sess_new']).toBeUndefined();
  });

  it('captures the draft thinking pick before the creation awaits', async () => {
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
    state.draftThinkingExplicit = true;
    const ws = createWorkspaceRig(state, deps);

    const pending = ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');
    await new Promise((r) => setTimeout(r, 0));
    state.thinking = 'low';
    resolveCreate(newSession);
    await pending;

    expect(state.thinkingBySession['sess_new']).toBe('max');
  });

  it('passes through skill args', async () => {
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const ws = createWorkspaceRig(createState(), deps);

    await ws.startSessionAndActivateSkill('wd_1', 'write-goal', 'ship it');

    expect(activateSkill).toHaveBeenCalledWith('write-goal', 'ship it', undefined, 'sess_new', {
      snapshot: undefined,
    });
  });

  it('writes the draft controls to the new session and arms the draft plan intent', async () => {
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const persistSessionProfile = vi.fn().mockResolvedValue(true);
    const deps = {
      ...skillDeps(activateSkill),
      persistSessionProfile,
    };
    const state = createState();
    permissionsStore().pickInDraft('auto');
    state.thinking = 'max';
    state.draftThinkingExplicit = true;
    modeStore().draftModes.planMode = true;
    modeStore().draftModes.swarmMode = true;
    const ws = createWorkspaceRig(state, deps);

    await ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');

    expect(persistSessionProfile).toHaveBeenCalledOnce();
    expect(persistSessionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: 'max', permissionMode: 'auto', swarmMode: true }),
      'sess_new',
      true,
    );
    expect(persistSessionProfile.mock.calls[0]![0]).not.toHaveProperty('planMode', true);
    expect(state.planArmedBySession['sess_new']).toBe(true);
    expect(activateSkill).toHaveBeenCalledWith('pre-changelog', undefined, undefined, 'sess_new', {
      snapshot: undefined,
    });
  });

  it('seeds the draft thinking pick before selectSession flips the active session', async () => {
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const state = createState();
    state.thinking = 'max';
    state.draftThinkingExplicit = true;
    deps.upsertSessionSorted = vi.fn((s) => {
      state.sessions = [s, ...state.sessions.filter((x) => x.id !== s.id)];
    });
    let seededWhenSelected: string | undefined;
    deps.setActiveSessionId = vi.fn((sessionId: string | undefined) => {
      if (sessionId !== undefined) seededWhenSelected = state.thinkingBySession[sessionId];
      sessionsStore().setActiveSessionId(sessionId);
    });
    const ws = createWorkspaceRig(state, deps);

    await ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');

    expect(seededWhenSelected).toBe('max');
    expect(deps.setActiveSessionId).toHaveBeenCalledWith('sess_new');
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
    state.draftThinkingExplicit = true;
    const ws = createWorkspaceRig(state, deps);

    const pending = ws.startSessionAndActivateSkill('wd_1', 'pre-changelog');
    await new Promise((r) => setTimeout(r, 0));
    expect(state.pendingThinkingBySession['sess_new']).toBeDefined();
    foldDaemonThinkingLevel(state, 'sess_new', 'high');
    expect(state.thinkingBySession['sess_new']).toBe('max');

    releasePersist(true);
    await pending;

    expect(state.thinkingBySession['sess_new']).toBe('max');
    expect(activateSkill).toHaveBeenCalledWith('pre-changelog', undefined, undefined, 'sess_new', {
      snapshot: undefined,
    });
  });

  it('is a no-op for an unknown workspace', async () => {
    const activateSkill = vi.fn().mockResolvedValue(undefined);
    const deps = skillDeps(activateSkill);
    const ws = createWorkspaceRig(createState(), deps);

    await ws.startSessionAndActivateSkill('wd_missing', 'pre-changelog');

    expect(apiMock.createSession).not.toHaveBeenCalled();
    expect(activateSkill).not.toHaveBeenCalled();
    expect(pushFailureSpy).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — createGoal from an empty composer', () => {
  const registered = { id: 'wd_1', root: '/abs/path', name: 'A',sessionCount: 1 };
  const newSession = { ...createSession(), id: 'sess_new', workspaceId: 'wd_1', cwd: '/abs/path' };

  beforeEach(() => {
    apiMock.addWorkspace.mockReset();
    apiMock.createSession.mockReset();
    apiMock.updateSession.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.addWorkspace.mockResolvedValue(registered);
    apiMock.createSession.mockResolvedValue(newSession);
    apiMock.updateSession.mockResolvedValue({});
    apiMock.submitPrompt.mockImplementation(echoPromptSubmit());
  });

  function emptyComposerState() {
    const state = createState();
    state.activeSessionId = null;
    workspacesStore().storedActiveWorkspaceId = 'wd_1';
    workspacesStore().workspaces = [workspace('wd_1', '/abs/path', 'A')];
    permissionsStore().pickInDraft('auto');
    return state;
  }

  function goalDeps(): WorkspaceRigDeps {
    return {
      ...createDeps(),
      modelProvider: {
        draftModel: ref(null),
        skillsBySession: ref({}),
        loadSkillsForSession: vi.fn(),
        resolveThinkingForPrompt: () => undefined,
      } as unknown as WorkspaceRigDeps['modelProvider'],
    } as unknown as WorkspaceRigDeps;
  }

  it('stores a readable objective for a goal that cites a browser reference', async () => {
    const { browserReferenceNode, composerSchema, createComposerSnapshot, docToText } = await import('@moonshot-ai/app-composer/model');
    const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [
      composerSchema.text('Fix '),
      browserReferenceNode({ refId: 'ref-a', label: 'Button: Save' }),
    ])]);
    const snapshot = createComposerSnapshot(doc, [], [], {
      references: [{ id: 'ref-a', captureId: 'capture', comment: 'Rename this', includeScreenshot: false }],
      captures: [{
        version: 1, id: 'capture', ordinal: 1, label: 'Button: Save', capturedAt: '2026-09-07T00:00:00.000Z',
        page: { url: 'https://example.test', title: 'Example' },
        target: { kind: 'element', tagName: 'button', text: 'Save', bounds: { x: 1, y: 1, width: 2, height: 2 } },
        viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoomFactor: 1, devicePixelRatio: 2 },
      }],
    });
    const text = docToText(doc);
    expect(text).toContain('kimi-code-composer://');
    const state = emptyComposerState();
    const ws = createWorkspaceRig(state, goalDeps());

    await ws.createGoal({ text, snapshot, attachments: [] });

    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_new', { goalObjective: 'Fix Button: Save · Rename this', planMode: false });
    const sent = apiMock.submitPrompt.mock.calls[0]?.[1] as { content: { text?: string }[] };
    expect(sent.content.map((part) => part.text ?? '').join('\n')).toContain('<browser_references version="1">');
    expect(pushFailureSpy).not.toHaveBeenCalled();
  });

  it('creates a session, sets the goal profile, and submits the objective', async () => {
    const state = emptyComposerState();
    const deps = goalDeps();
    const ws = createWorkspaceRig(state, deps);

    await ws.createGoal('improve test coverage');

    expect(apiMock.createSession).toHaveBeenCalledOnce();
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_new', {
      goalObjective: 'improve test coverage',
      planMode: false,
    });
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_new',
      expect.objectContaining({
        content: [{ type: 'text', text: 'improve test coverage' }],
      }),
    );
    expect(pushFailureSpy).not.toHaveBeenCalled();
  });

  it('falls back to the first visible workspace when the stored selection is unset', async () => {
    const state = emptyComposerState();
    workspacesStore().storedActiveWorkspaceId = null;
    const ws = createWorkspaceRig(state, goalDeps());

    await ws.createGoal('improve test coverage');

    expect(apiMock.createSession).toHaveBeenCalledOnce();
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_new', {
      goalObjective: 'improve test coverage',
      planMode: false,
    });
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
  });

  it('queues the objective when the active session is running (no queue bypass)', async () => {
    const state = createState();
    state.activeSessionId = 'sess_1';
    permissionsStore().pickInSession('sess_1', 'auto');
    const ws = createWorkspaceRig(state, createDeps());

    await ws.createGoal('improve test coverage');

    expect(apiMock.createSession).not.toHaveBeenCalled();
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_1', {
      goalObjective: 'improve test coverage',
      planMode: false,
    });
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(promptStore().queuedBySession['sess_1']).toEqual([
      expect.objectContaining({ text: 'improve test coverage', attachments: [], skills: [] }),
    ]);
  });

  it('surfaces a structured refusal of the goal write without submitting the objective', async () => {
    const state = createState();
    permissionsStore().pickInSession('sess_1', 'auto');
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockRejectedValue(
      new DaemonApiError({ code: 40913, msg: 'goal already exists', requestId: 'r' }),
    );
    apiMock.submitPrompt.mockReset();
    const deps = goalDeps();
    setGoalHooks({
      pushOperationFailure: (...args) => pushFailureSpy(...args),
    });
    const ws = createWorkspaceRig(state, deps);

    await ws.createGoal('improve test coverage');

    expect(pushFailureSpy).toHaveBeenCalledWith(
      'createGoal',
      expect.anything(),
      expect.objectContaining({ sessionId: 'sess_1' }),
    );
    expect(promptStore().queuedBySession.sess_1 ?? []).toEqual([]);
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(apiMock.updateSession).toHaveBeenCalledTimes(1);
  });

  it('surfaces an ambiguous goal-write failure the same way, without submitting', async () => {
    const state = createState();
    permissionsStore().pickInSession('sess_1', 'auto');
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockRejectedValue(new TypeError('fetch failed'));
    apiMock.submitPrompt.mockReset();
    const deps = goalDeps();
    setGoalHooks({
      pushOperationFailure: (...args) => pushFailureSpy(...args),
    });
    const ws = createWorkspaceRig(state, deps);

    await ws.createGoal('improve test coverage');

    expect(pushFailureSpy).toHaveBeenCalledWith(
      'createGoal',
      expect.anything(),
      expect.objectContaining({ sessionId: 'sess_1' }),
    );
    expect(promptStore().queuedBySession.sess_1 ?? []).toEqual([]);
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no active session and no usable workspace', async () => {
    const state = emptyComposerState();
    state.sessions = [];
    workspacesStore().storedActiveWorkspaceId = null;
    workspacesStore().workspaces = [];
    const deps: WorkspaceRigDeps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    await ws.createGoal('improve test coverage');

    expect(apiMock.createSession).not.toHaveBeenCalled();
    expect(apiMock.updateSession).not.toHaveBeenCalled();
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(pushFailureSpy).not.toHaveBeenCalled();
  });

  it('ignores empty/whitespace objectives', async () => {
    const state = emptyComposerState();
    const ws = createWorkspaceRig(state, goalDeps());

    await ws.createGoal('   ');

    expect(apiMock.createSession).not.toHaveBeenCalled();
    expect(apiMock.updateSession).not.toHaveBeenCalled();
  });

  it('clears staged goal mode so the objective prompt is submitted once', async () => {
    const state = emptyComposerState();
    const deps: WorkspaceRigDeps = {
      ...goalDeps(),
    };
    modeStore().draftModes.goalMode = true;
    const ws = createWorkspaceRig(state, deps);

    await ws.createGoal('improve test coverage');

    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_new', {
      goalObjective: 'improve test coverage',
      planMode: false,
    });
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(1);
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_new',
      expect.objectContaining({
        content: [{ type: 'text', text: 'improve test coverage' }],
      }),
    );
    expect(state.goalModeBySession['sess_new']).toBe(false);
    expect(pushFailureSpy).not.toHaveBeenCalled();
  });

  it('surfaces session-creation failures instead of leaking an unhandled rejection', async () => {
    const state = emptyComposerState();
    const deps = goalDeps();
    const ws = createWorkspaceRig(state, deps);
    const err = new Error('snapshot failed');
    apiMock.createSession.mockRejectedValue(err);

    await expect(ws.createGoal('improve test coverage')).resolves.toEqual({
      sessionId: null,
      promptRejected: false,
    });

    expect(pushFailureSpy).toHaveBeenCalledWith('createGoal', err);
    expect(apiMock.updateSession).not.toHaveBeenCalled();
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — startSessionAndOpenSideChat', () => {
  const registered = { id: 'wd_1', root: '/abs/path', name: 'A',sessionCount: 1 };
  const newSession = { ...createSession(), id: 'sess_new', workspaceId: 'wd_1', cwd: '/abs/path' };

  beforeEach(() => {
    apiMock.addWorkspace.mockReset();
    apiMock.createSession.mockReset();
    apiMock.addWorkspace.mockResolvedValue(registered);
    apiMock.createSession.mockResolvedValue(newSession);
    workspacesStore().workspaces = [workspace('wd_1', '/abs/path', 'A')];
  });

  function sideChatDeps(openSideChatOn: ReturnType<typeof vi.fn>): WorkspaceRigDeps {
    return {
      ...createDeps(),
      sideChat: { openSideChatOn } as unknown as WorkspaceRigDeps['sideChat'],
      modelProvider: {
        draftModel: ref(null),
        skillsBySession: ref({}),
        loadSkillsForSession: vi.fn(),
        resolveThinkingForPrompt: () => undefined,
      } as unknown as WorkspaceRigDeps['modelProvider'],
    };
  }

  it('creates a session, then opens BTW on the new session id with the question', async () => {
    const openSideChatOn = vi
      .fn()
      .mockResolvedValue({ target: { agentId: 'btw_1', seq: 1 }, sent: true });
    const deps = sideChatDeps(openSideChatOn);
    const ws = createWorkspaceRig(createState(), deps);

    await ws.startSessionAndOpenSideChat('wd_1', 'what changed?');

    expect(apiMock.createSession).toHaveBeenCalledOnce();
    expect(openSideChatOn).toHaveBeenCalledWith('sess_new', 'what changed?');
    expect(pushFailureSpy).not.toHaveBeenCalled();
  });

  it('works without an initial question (bare /btw)', async () => {
    const openSideChatOn = vi
      .fn()
      .mockResolvedValue({ target: { agentId: 'btw_1', seq: 1 }, sent: true });
    const deps = sideChatDeps(openSideChatOn);
    const ws = createWorkspaceRig(createState(), deps);

    await ws.startSessionAndOpenSideChat('wd_1');

    expect(openSideChatOn).toHaveBeenCalledWith('sess_new', undefined);
  });

  it('is a no-op for an unknown workspace', async () => {
    const openSideChatOn = vi.fn().mockResolvedValue(undefined);
    const deps = sideChatDeps(openSideChatOn);
    const ws = createWorkspaceRig(createState(), deps);

    await ws.startSessionAndOpenSideChat('wd_missing', 'what changed?');

    expect(apiMock.createSession).not.toHaveBeenCalled();
    expect(openSideChatOn).not.toHaveBeenCalled();
    expect(pushFailureSpy).not.toHaveBeenCalled();
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

  function createLoadDeps(): WorkspaceRigDeps {
    return {
      ...createDeps(),
      modelProvider: { loadModels: vi.fn().mockResolvedValue(undefined) },
    } as unknown as WorkspaceRigDeps;
  }

  it('keeps the splash up and retries /auth when the first check fails transiently', async () => {
    vi.useFakeTimers();
    try {
      const state = createState();
      apiMock.getAuth
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValue({ modelsReady: true, providersCount: 1, managedProvider: null });
      const ws = createWorkspaceRig(state, createLoadDeps());

      const pending = ws.load();
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.initialized.value).toBe(false);
      expect(apiMock.getAuth).toHaveBeenCalledTimes(1);
      expect(authStore().connectIssue).toBeNull();
      expect(ws.bootRetries.value).toBe(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(apiMock.getAuth).toHaveBeenCalledTimes(2);
      expect(ws.initialized.value).toBe(false);
      expect(authStore().connectIssue).toEqual({ kind: 'unknown', message: 'connection refused' });
      expect(ws.bootRetries.value).toBe(2);

      await vi.advanceTimersByTimeAsync(2000);
      await pending;
      expect(apiMock.getAuth).toHaveBeenCalledTimes(3);
      expect(ws.initialized.value).toBe(true);
      expect(modelsStore().modelsReady).toBe(true);
      expect(authStore().connectIssue).toBeNull();
      expect(ws.bootRetries.value).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('initializes normally (into the login gate) when /auth answers modelsReady:false', async () => {
    const state = createState();
    apiMock.getAuth.mockResolvedValue({ modelsReady: false, providersCount: 0, managedProvider: null });
    const ws = createWorkspaceRig(state, createLoadDeps());

    await ws.load();

    expect(apiMock.getAuth).toHaveBeenCalledTimes(1);
    expect(ws.initialized.value).toBe(true);
    expect(modelsStore().modelsReady).toBe(false);
  });

  it('advances bootStage to the final phase by the end of the first load', async () => {
    const state = createState();
    apiMock.getAuth.mockResolvedValue({ modelsReady: false, providersCount: 0, managedProvider: null });
    const ws = createWorkspaceRig(state, createLoadDeps());

    await ws.load();

    expect(ws.bootStage.value).toBe('session');
  });

  it.each([40101, 401])(
    'stops without retrying when /auth rejects with %i (server token required)',
    async (code) => {
      vi.useFakeTimers();
      try {
        const state = createState();
        apiMock.getAuth.mockRejectedValue(
          new DaemonApiError({ code, msg: 'Unauthorized', requestId: 'req_1' }),
        );
        const ws = createWorkspaceRig(state, createLoadDeps());

        await ws.load();
        expect(apiMock.getAuth).toHaveBeenCalledTimes(1);
        expect(ws.initialized.value).toBe(false);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(apiMock.getAuth).toHaveBeenCalledTimes(1);
        expect(ws.initialized.value).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('useWorkspaceState — session list loading', () => {
  beforeEach(() => {
    apiMock.getAuth.mockReset().mockResolvedValue({
      modelsReady: true,
      providersCount: 1,
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
    apiMock.listSessionGroups.mockReset();
    apiMock.getSession.mockReset();
  });

  function createSessionLoadRig(sessions: AppSession[]) {
    const state = createState();
    sessionsStore().setSessions(sessions);
    Object.defineProperty(state, 'sessions', {
      get: () => sessionsStore().sessions,
      set: (next: AppSession[]) => sessionsStore().setSessions(next),
    });
    state.activeSessionId = sessions[0]?.id ?? null;
    const deps = {
      ...createDeps(),
      modelProvider: { loadModels: vi.fn().mockResolvedValue(undefined) },
    } as unknown as WorkspaceRigDeps;
    setSessionListHooks({
      pushOperationFailure: (...args) => pushFailureSpy(...args),
      onSessionsArchivedLocally: async (ids) => {
        for (const id of ids) deps.forgetSession(id);
        if (state.activeSessionId !== undefined && ids.includes(state.activeSessionId)) {
          const next = sessionsStore().sessions[0];
          deps.setActiveSessionId(next?.id);
        }
      },
    });
    return { state, deps, workspaceState: createWorkspaceRig(state, deps) };
  }

  it('reports one load failure when the no-workspace session fallback rejects', async () => {
    const error = new Error('session index unavailable');
    apiMock.listSessions.mockRejectedValue(error);
    const { workspaceState } = createSessionLoadRig([]);

    await workspaceState.load();

    expect(pushFailureSpy).toHaveBeenCalledOnce();
    expect(pushFailureSpy).toHaveBeenCalledWith('load', error);
  });

  it('keeps the cached sessions of a host that could not answer the global session list', async () => {
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
      .mockResolvedValueOnce({ items: [fresh], hasMore: false, unavailableHosts: ['off'] })
      .mockResolvedValue({ items: [fresh, older], hasMore: false });
    const { state, workspaceState } = createSessionLoadRig([cached, cachedOlder]);

    await workspaceState.load();

    expect(state.sessions.map((session) => session.title)).toEqual([
      'Fresh first page',
      'Cached older page',
    ]);
    expect(pushFailureSpy).not.toHaveBeenCalled();

    await workspaceState.load();

    expect(state.sessions.map((session) => session.id)).toEqual(['sess_1', 'sess_older']);
  });

  it('lists every session of every host in one request', async () => {
    const only = { ...createSession(), id: 'sess_only' };
    apiMock.listSessions.mockResolvedValue({ items: [only], hasMore: false });
    const { workspaceState } = createSessionLoadRig([]);

    const result = await workspaceState.listAllSessionsGlobal();

    expect(apiMock.listSessions).toHaveBeenCalledExactlyOnceWith({ hasPrompt: true });
    expect(result).toEqual({ sessions: [only], complete: true });
  });

  it('loads workspace sessions when a retry follows an initial failure', async () => {
    const cached = {
      ...createSession(),
      title: 'Cached',
      workspaceId: 'wd_1',
    };
    const recovered = {
      ...cached,
      id: 'sess_1',
      cwd: '/workspace',
      title: 'Recovered',
      lastPrompt: 'p',
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(2).toISOString(),
      busy: false,
      archived: false,
    };
    apiMock.listWorkspaces.mockResolvedValue([workspace('wd_1', '/workspace', 'Workspace')]);
    apiMock.listSessionGroups
      .mockRejectedValueOnce(new Error('session index unavailable'))
      .mockResolvedValue({
        groups: [
          { workspaceId: 'wd_1', sessions: [recovered], total: 1 },
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
    const { state, workspaceState } = createSessionLoadRig([loaded]);
    workspacesStore().workspaces = [workspace('wd_1', '/workspace', 'Workspace')];
    workspacesStore().sessionsHasMoreByWorkspace = { wd_1: true };
    workspacesStore().sessionsCursorByWorkspace = { wd_1: 'sess_1' };
    workspacesStore().sessionsLoadingMoreByWorkspace = { wd_1: false };
    apiMock.listSessions
      .mockRejectedValueOnce(new Error('next page unavailable'))
      .mockResolvedValue({ items: [older], hasMore: false });

    await workspaceState.loadMoreSessions('wd_1');
    await workspaceState.loadMoreSessions('wd_1');

    expect(state.sessions.map((session) => session.id)).toEqual(['sess_1', 'sess_older']);
    expect(pushFailureSpy).toHaveBeenCalledOnce();
  });

  it('does not resurrect a session archived remotely while the load was in flight', async () => {
    const live = { ...createSession(), id: 'sess_live', busy: false };
    const archived = { ...createSession(), id: 'sess_arch', busy: false };
    const { state, workspaceState } = createSessionLoadRig([live]);
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

    expect(state.sessions.map((session) => session.id)).toEqual(['sess_live']);
  });

  it('puts a session restored on another client back into the list', async () => {
    const live = { ...createSession(), id: 'sess_live', busy: false };
    const archived = { ...createSession(), id: 'sess_arch', busy: false };
    const { state, workspaceState } = createSessionLoadRig([live]);
    await workspaceState.applyRemoteSessionArchived('sess_arch');
    apiMock.getSession.mockResolvedValue({ ...archived, archived: false });

    await workspaceState.applyRemoteSessionRestored('sess_arch');

    expect(apiMock.getSession).toHaveBeenCalledWith('sess_arch', expect.objectContaining({ background: true }));
    expect(state.sessions.map((session) => session.id).toSorted()).toEqual(['sess_arch', 'sess_live']);
  });

  it('ignores a restored event when the server still reports the session archived', async () => {
    const live = { ...createSession(), id: 'sess_live', busy: false };
    const archived = { ...createSession(), id: 'sess_arch', busy: false };
    const { state, workspaceState } = createSessionLoadRig([live]);
    await workspaceState.applyRemoteSessionArchived('sess_arch');
    apiMock.getSession.mockResolvedValue({ ...archived, archived: true });

    await workspaceState.applyRemoteSessionRestored('sess_arch');

    expect(state.sessions.map((session) => session.id)).toEqual(['sess_live']);
  });

  it('keeps a session archived again while its restored read was in flight out of the list', async () => {
    const live = { ...createSession(), id: 'sess_live', busy: false };
    const archived = { ...createSession(), id: 'sess_arch', busy: false };
    const { state, workspaceState } = createSessionLoadRig([live]);
    await workspaceState.applyRemoteSessionArchived('sess_arch');
    let resolveRead: ((session: AppSession) => void) | undefined;
    apiMock.getSession.mockImplementation(() => new Promise((resolve) => {
      resolveRead = resolve;
    }));

    const restoring = workspaceState.applyRemoteSessionRestored('sess_arch');
    await vi.waitFor(() => expect(resolveRead).toBeDefined());
    await workspaceState.applyRemoteSessionArchived('sess_arch');
    resolveRead!({ ...archived, archived: false });
    await restoring;

    expect(state.sessions.map((session) => session.id)).toEqual(['sess_live']);
    expect(sessionListStore().hasArchiveTombstone('sess_arch')).toBe(true);
  });

  it('restores locally from the archived copy when the restored read fails', async () => {
    const live = { ...createSession(), id: 'sess_live', busy: false };
    const archived = { ...createSession(), id: 'sess_arch', busy: false };
    const { state, workspaceState } = createSessionLoadRig([live, archived]);
    await workspaceState.applySessionsArchivedLocally(['sess_arch'], true);
    apiMock.getSession.mockRejectedValue(new Error('offline'));

    await workspaceState.applyRemoteSessionRestored('sess_arch');

    expect(sessionListStore().hasArchiveTombstone('sess_arch')).toBe(false);
    expect(sessionListStore().doneSessions.map((session) => session.id)).not.toContain('sess_arch');
    expect(state.sessions.map((session) => session.id)).toContain('sess_arch');
  });

  it('skips the fetch for a restored event about a session already listed', async () => {
    const live = { ...createSession(), id: 'sess_live', busy: false };
    const { state, workspaceState } = createSessionLoadRig([live]);
    apiMock.getSession.mockClear();

    await workspaceState.applyRemoteSessionRestored('sess_live');

    expect(apiMock.getSession).not.toHaveBeenCalled();
    expect(state.sessions.map((session) => session.id)).toEqual(['sess_live']);
  });

  it('auto-selects from the committed pool, not the unfiltered load result', async () => {
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
    const { state, workspaceState } = createSessionLoadRig([live]);
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

    expect(apiMock.getSession).not.toHaveBeenCalledWith('sess_arch');
    expect(sessionsStore().activeSessionId).toBe('sess_live');
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
    sessionsStore().setSessions([...rows]);
    Object.defineProperty(state, 'sessions', {
      get: () => sessionsStore().sessions,
      set: (next: AppSession[]) => sessionsStore().setSessions(next),
    });
    state.activeSessionId = rows[0]!.id;
    const deps = {
      ...createDeps(),
      modelProvider: { loadModels: vi.fn().mockResolvedValue(undefined) },
      forgetSession: (id: string) => {
        state.sessions = state.sessions.filter((s) => s.id !== id);
      },
    } as unknown as WorkspaceRigDeps;
    setSessionListHooks({
      pushOperationFailure: (...args) => pushFailureSpy(...args),
      onSessionsArchivedLocally: async (ids) => {
        for (const id of ids) deps.forgetSession(id);
        if (state.activeSessionId !== undefined && ids.includes(state.activeSessionId)) {
          const next = sessionsStore().sessions[0];
          deps.setActiveSessionId(next?.id);
        }
      },
    });
    const workspaceState = createWorkspaceRig(state, deps);
    workspacesStore().sessionsHasMoreByWorkspace = { wd_1: true };
    workspacesStore().sessionsCursorByWorkspace = { wd_1: 's5' };
    workspacesStore().sessionsInitialCountByWorkspace = { wd_1: 5 };
    let resolveFirst: ((page: unknown) => void) | undefined;
    apiMock.listSessionGroups.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    apiMock.listSessions.mockResolvedValue({ items: [backfilled], hasMore: false });

    const pending = workspaceState.load();
    await vi.waitFor(() => expect(apiMock.listSessionGroups).toHaveBeenCalled());
    await workspaceState.applyRemoteSessionArchived('s2', 'wd_1');
    await vi.waitFor(() => expect(apiMock.listSessions).toHaveBeenCalledTimes(1));
    resolveFirst!({
      groups: [
        {
          workspaceId: 'wd_1',
          sessions: rows.map((r) => ({
            ...r,
            workspaceId: 'wd_1',
            cwd: '/workspace',
            lastPrompt: 'p',
            archived: false,
            busy: false,
          })),
          total: 5,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    await pending;

    expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's3', 's4', 's5', 's6']);
  });
});

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

    await configStore().refreshServerMeta();

    expect(state.serverVersion).toBe('9.9.9');
    expect(state.availableOpenInApps).toEqual(['finder']);
    expect(state.dangerousBypassAuth).toBe(true);
    expect(state.backend).toBe('v2');
  });

  it('keeps the previous meta when /meta fails', async () => {
    apiMock.getMeta.mockRejectedValue(new Error('connection refused'));
    const state = createState();
    state.backend = 'v2';

    await configStore().refreshServerMeta();

    expect(state.backend).toBe('v2');
    expect(state.serverVersion).toBe('');
  });
});

describe('useWorkspaceState — loadConfig write generation', () => {
  beforeEach(() => {
    apiMock.getConfig.mockReset();
    apiMock.setConfig.mockReset();
  });

  it('serializes concurrent writes and commits them in call order', async () => {
    let resolveFirst!: (value: unknown) => void;
    apiMock.setConfig
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; }),
      )
      .mockResolvedValueOnce({ providers: {}, defaultModel: 'model-b' });
    const setDefaultSpy = vi.spyOn(modelsStore(), 'setDefaultModel');

    const first = configStore().updateConfig({ defaultModel: 'model-a' });
    await vi.waitFor(() => expect(apiMock.setConfig).toHaveBeenCalledOnce());
    const second = configStore().updateConfig({ defaultModel: 'model-b' });
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.setConfig).toHaveBeenCalledTimes(1);

    resolveFirst({ providers: {}, defaultModel: 'model-a' });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(setDefaultSpy.mock.calls.map((call) => call[0])).toEqual(['model-a', 'model-b']);
    expect(modelsStore().defaultModel).toBe('model-b');
  });

  it('a POST commits over a GET that read before the write landed server-side', async () => {
    let resolvePost!: (value: unknown) => void;
    apiMock.setConfig.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePost = resolve; }),
    );
    apiMock.getConfig.mockResolvedValue({ providers: {}, defaultModel: 'model-old' });

    const post = configStore().updateConfig({ defaultModel: 'model-new' });
    await vi.waitFor(() => expect(apiMock.setConfig).toHaveBeenCalledOnce());
    expect(await configStore().loadConfig()).toBe('committed');
    expect(modelsStore().defaultModel).toBe('model-old');

    resolvePost({ providers: {}, defaultModel: 'model-new' });
    expect(await post).toBe(true);
    expect(modelsStore().defaultModel).toBe('model-new');
  });

  it('a GET still commits when the newer in-flight write fails', async () => {
    let resolveGet!: (value: unknown) => void;
    apiMock.getConfig.mockImplementation(
      () => new Promise((resolve) => { resolveGet = resolve; }),
    );
    apiMock.setConfig.mockRejectedValueOnce(new Error('write conflict'));

    const get = configStore().loadConfig();
    await vi.waitFor(() => expect(apiMock.getConfig).toHaveBeenCalledOnce());
    expect(await configStore().updateConfig({ defaultModel: 'model-b' })).toBe(false);

    resolveGet({ providers: {}, defaultModel: 'model-a' });
    expect(await get).toBe('committed');
    expect(modelsStore().defaultModel).toBe('model-a');
  });

  it('a failed write does not poison the write queue: the next write still commits', async () => {
    apiMock.setConfig
      .mockRejectedValueOnce(new Error('write conflict'))
      .mockResolvedValueOnce({ providers: {}, defaultModel: 'model-b' });

    expect(await configStore().updateConfig({ defaultModel: 'model-a' })).toBe(false);
    expect(await configStore().updateConfig({ defaultModel: 'model-b' })).toBe(true);
    expect(modelsStore().defaultModel).toBe('model-b');
  });

  it('a POST response returning after a WS config.changed snapshot must not roll back the default model', async () => {
    let resolvePost!: (value: unknown) => void;
    apiMock.setConfig.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePost = resolve; }),
    );

    const post = configStore().updateConfig({ defaultModel: 'model-post' });
    await vi.waitFor(() => expect(apiMock.setConfig).toHaveBeenCalledOnce());
    configStore().noteConfigWrite();
    modelsStore().setDefaultModel('model-ws');

    resolvePost({ providers: {}, defaultModel: 'model-post' });
    expect(await post).toBe(true);
    expect(modelsStore().defaultModel).toBe('model-ws');
  });

  it('a slow GET returning after a POST response must not roll back the default model', async () => {
    let resolveGet!: (value: unknown) => void;
    apiMock.getConfig.mockImplementation(
      () => new Promise((resolve) => { resolveGet = resolve; }),
    );
    apiMock.setConfig.mockResolvedValue({ providers: {}, defaultModel: 'model-new' });

    const get = configStore().loadConfig();
    await vi.waitFor(() => expect(apiMock.getConfig).toHaveBeenCalledOnce());
    expect(await configStore().updateConfig({ defaultModel: 'model-new' })).toBe(true);
    expect(modelsStore().defaultModel).toBe('model-new');

    resolveGet({ providers: {}, defaultModel: 'model-old' });
    expect(await get).toBe('superseded');
    expect(modelsStore().defaultModel).toBe('model-new');
  });

  it('a slow GET returning after a WS config.changed snapshot must not roll back the default model', async () => {
    let resolveGet!: (value: unknown) => void;
    apiMock.getConfig.mockImplementation(
      () => new Promise((resolve) => { resolveGet = resolve; }),
    );

    const get = configStore().loadConfig();
    await vi.waitFor(() => expect(apiMock.getConfig).toHaveBeenCalledOnce());
    configStore().noteConfigWrite();
    modelsStore().setDefaultModel('model-ws');

    resolveGet({ providers: {}, defaultModel: 'model-old' });
    expect(await get).toBe('superseded');
    expect(modelsStore().defaultModel).toBe('model-ws');
  });
});

describe('useWorkspaceState — snapshot prompt recovery', () => {
  function promptDeps(overrides: Partial<WorkspaceRigDeps> = {}): WorkspaceRigDeps {
    const chain = sessionRuntimeStore().profileWriteChainBySid;
    return {
      ...createDeps(),
      modelProvider: {
        models: ref([]),
        resolveThinkingForPrompt: () => undefined,
      } as unknown as WorkspaceRigDeps['modelProvider'],
      persistSessionProfile: vi.fn((patch: PersistSessionProfilePatch, sessionId?: string) => {
        const sid = sessionId ?? sessionsStore().activeSessionId!;
        const run = (chain.get(sid) ?? Promise.resolve(true)).then(async (prevOk) => {
          try {
            await apiMock.updateSession(sid, patch);
            return prevOk;
          } catch {
            return false;
          }
        });
        chain.set(sid, run);
        return run.then((ok) => {
          if (chain.get(sid) === run) chain.delete(sid);
          return ok;
        });
      }),
      whenSessionProfileSettled: vi.fn(async (sid: string) => {
        let ok = true;
        for (;;) {
          const tail = chain.get(sid);
          if (tail === undefined) return ok;
          ok = (await tail) && ok;
          if (chain.get(sid) === tail) return ok;
        }
      }),
      ...overrides,
    };
  }

  beforeEach(() => {
    apiMock.submitPrompt.mockReset();
    apiMock.submitPrompt.mockImplementation(echoPromptSubmit());
    apiMock.steerPrompt.mockReset();
    apiMock.steerPrompt.mockImplementation(echoPromptSubmit());
    apiMock.steerPrompts.mockReset();
    apiMock.steerPrompts.mockResolvedValue({});
    promptStore().forgetLocalTurnState('sess_1');
  });

  afterEach(() => {
    useConfirmDialog().settle(false);
  });

  it('keeps an occupied send bubble visible until the user cancels', async () => {
    let rejectSubmit!: (err: unknown) => void;
    apiMock.submitPrompt.mockImplementationOnce(
      () => new Promise((_, reject) => { rejectSubmit = reject; }),
    );
    const ws = createWorkspaceRig(createState(), promptDeps({ activity: computed(() => 'idle') }));
    let settled = false;
    const send = ws.sendPrompt(
      ws.createPromptEnvelope({ text: 'hello' }),
      undefined,
      { recoverConflicts: true },
    );
    void send.then(() => { settled = true; });
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    expect(promptStore().optimisticMessagesBySession.sess_1 ?? []).toHaveLength(1);

    rejectSubmit(new DaemonApiError({ code: 40931, msg: 'session occupied', requestId: 'occupied-1' }));
    await vi.waitFor(() => expect(useConfirmDialog().current.value).not.toBeNull());

    expect(promptStore().optimisticMessagesBySession.sess_1 ?? []).toHaveLength(1);
    expect(settled).toBe(false);
    useConfirmDialog().settle(false);
    expect(await send).toBe('rejected');
    expect(promptStore().optimisticMessagesBySession.sess_1 ?? []).toHaveLength(0);
  });

  it('retries an occupied send with the frozen request and no blank bubble or idle frame', async () => {
    let resolveRetry!: (value: unknown) => void;
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockResolvedValue(undefined);
    apiMock.submitPrompt
      .mockRejectedValueOnce(new DaemonApiError({ code: 40931, msg: 'session occupied', requestId: 'occupied-2' }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    const ws = createWorkspaceRig(createState(), promptDeps({ activity: computed(() => 'idle') }));
    ws.setPlanMode(true);
    const renderedBubbleCounts: number[] = [];
    const renderedInFlight: boolean[] = [];
    const stopBubble = watch(
      () => (promptStore().optimisticMessagesBySession.sess_1 ?? []).length,
      (count) => { renderedBubbleCounts.push(count); },
      { flush: 'post' },
    );
    const stopInFlight = watch(
      () => promptStore().inFlightBySession.sess_1 ?? false,
      (value) => { renderedInFlight.push(value); },
      { flush: 'post' },
    );
    try {
      const send = ws.sendPrompt(
        ws.createPromptEnvelope({ text: 'hello' }),
        undefined,
        { recoverConflicts: true },
      );
      await vi.waitFor(() => expect(useConfirmDialog().current.value).not.toBeNull());

      useConfirmDialog().settle(true);
      await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2));

      expect(promptStore().optimisticMessagesBySession.sess_1 ?? []).toHaveLength(1);
      await nextTick();
      expect(renderedInFlight).toEqual([true]);
      resolveRetry({ promptId: sentPromptId(1), userMessageId: sentPromptId(1) });
      expect(await send).toBe('ok');
      expect(promptStore().optimisticMessagesBySession.sess_1 ?? []).toHaveLength(1);
      expect(renderedBubbleCounts).toEqual([1]);
      expect(apiMock.submitPrompt.mock.calls[1]).toEqual(apiMock.submitPrompt.mock.calls[0]);
      expect(apiMock.updateSession.mock.calls.filter(([, patch]) => patch?.planMode === true)).toHaveLength(1);
    } finally {
      stopBubble();
      stopInFlight();
    }
  });

  it('wouldEnqueuePrompt tracks the busy, in-flight, and lined-up states', () => {
    const idle = createWorkspaceRig(createState(), promptDeps({ activity: computed(() => 'idle') }));
    expect(idle.wouldEnqueuePrompt()).toBe(false);

    const running = createWorkspaceRig(createState(), promptDeps());
    expect(running.wouldEnqueuePrompt()).toBe(true);

    const inFlightState = createState();
    promptStore().inFlightBySession = { sess_1: true };
    const inFlight = createWorkspaceRig(inFlightState, promptDeps({ activity: computed(() => 'idle') }));
    expect(inFlight.wouldEnqueuePrompt()).toBe(true);

    const queuedState = createState();
    const queued = createWorkspaceRig(queuedState, promptDeps({ activity: computed(() => 'idle') }));
    queued.enqueue('later');
    expect(queued.wouldEnqueuePrompt()).toBe(true);
  });

  it('does not resend a composer prompt rejected as stale', async () => {
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 40932, msg: 'session stale', requestId: 'stale-1' }),
    );
    const ws = createWorkspaceRig(createState(), promptDeps({ activity: computed(() => 'idle') }));

    const outcome = await ws.sendPrompt(
      ws.createPromptEnvelope({ text: 'hello' }),
      undefined,
      { recoverConflicts: true },
    );

    expect(outcome).toBe('rejected');
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(promptStore().optimisticMessagesBySession['sess_1'] ?? []).toHaveLength(0);
    expect(warningsStore().warnings).toEqual([
      expect.objectContaining({ severity: 'warning', title: 'Session updated' }),
    ]);
  });

  it('does not resend after the session is torn down while the occupied dialog is open', async () => {
    apiMock.submitPrompt.mockRejectedValueOnce(
      new DaemonApiError({ code: 40931, msg: 'session occupied', requestId: 'occupied-4' }),
    );
    const ws = createWorkspaceRig(createState(), promptDeps({ activity: computed(() => 'idle') }));

    const send = ws.sendPrompt(
      ws.createPromptEnvelope({ text: 'hello' }),
      undefined,
      { recoverConflicts: true },
    );
    await vi.waitFor(() => expect(useConfirmDialog().current.value).not.toBeNull());
    permissionsStore().clearSession('sess_1');
    useConfirmDialog().settle(true);

    expect(await send).toBe('rejected');
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(promptStore().inFlightBySession.sess_1 ?? false).toBe(false);
  });

  it('rolls the bubble back when a pre-POST step fails (plan cash write offline)', async () => {
    apiMock.submitPrompt.mockReset();
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockRejectedValue(new Error('network down'));
    const state = createState();
    const deps = promptDeps({ activity: computed(() => 'idle') });
    const ws = createWorkspaceRig(state, deps);

    ws.setPlanMode(true);
    await ws.sendPrompt(ws.createPromptEnvelope({ text: 'make a plan' }));

    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    const bubbles = promptStore().optimisticMessagesBySession['sess_1'] ?? [];
    expect(bubbles).toHaveLength(0);
    expect(promptStore().inFlightBySession.sess_1).toBe(false);
  });

  it('consumes an armed goal after its write even when the bundled first prompt is rejected', async () => {
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockResolvedValue({});
    apiMock.submitPrompt.mockReset();
    apiMock.submitPrompt
      .mockRejectedValueOnce(
        new DaemonApiError({ code: 40408, msg: 'skill.not_found', requestId: 'r1' }),
      )
      .mockImplementation(echoPromptSubmit());
    const state = createState();
    state.goalModeBySession = { sess_1: true };
    const deps = promptDeps({ activity: computed(() => 'idle') });
    const saveGoalSpy = vi.spyOn(modeStore(), 'saveGoalModeToStorage');
    const ws = createWorkspaceRig(state, deps);
    const prompt = ws.createPromptEnvelope({
      text: 'ship with [deploy](kimi-code://skill/deploy) and [review](kimi-code://skill/review)',
      skills: [{ name: 'deploy' }, { name: 'review' }],
    });

    expect(await ws.sendPrompt(prompt)).toBe('rejected');
    expect(apiMock.updateSession).toHaveBeenCalledOnce();
    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_1', {
      goalObjective: prompt.text,
      planMode: false,
    });
    expect(state.goalModeBySession.sess_1).toBe(false);
    expect(saveGoalSpy).toHaveBeenCalledOnce();

    expect(await ws.sendPrompt(prompt)).toBe('ok');
    expect(apiMock.updateSession).toHaveBeenCalledOnce();
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2);
  });

  it('ignores a late submit response when the terminal already settled the prompt', async () => {
    apiMock.submitPrompt.mockReset();
    let resolveSubmit!: (value: unknown) => void;
    apiMock.submitPrompt.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSubmit = resolve; }),
    );
    const state = createState();
    const ws = createWorkspaceRig(state, promptDeps({ activity: computed(() => 'idle') }));

    const send = ws.sendPrompt(ws.createPromptEnvelope({ text: 'quick turn' }));
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    expect(promptStore().inFlightBySession.sess_1).toBe(true);

    resolveSubmit({ promptId: sentPromptId(), userMessageId: sentPromptId(), status: 'running' });
    expect(await send).toBe('ok');

    expect(promptStore().inFlightBySession.sess_1).toBe(false);
    expect(promptStore().optimisticMessagesBySession.sess_1 ?? []).toHaveLength(1);
  });

  it('drains one queued prompt once the session is idle', async () => {
    const state = createState();
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    const ws = createWorkspaceRig(state, promptDeps());

    ws.resumeQueueIfIdle('sess_1');

    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    expect(promptStore().queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
    ]);
  });

  it('keeps the queue while the session runs or a sent prompt waits for its echo', () => {
    promptStore().queuedBySession = { sess_1: [{ text: 'queued', attachments: undefined }] };
    let running = true;
    let unechoed = false;
    const ws = createWorkspaceRig(createState(), promptDeps({
      isMainTurnRunning: () => running,
      hasUnechoedPrompt: () => unechoed,
    }));

    ws.resumeQueueIfIdle('sess_1');
    running = false;
    unechoed = true;
    ws.resumeQueueIfIdle('sess_1');

    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(promptStore().queuedBySession.sess_1).toHaveLength(1);
  });

  it('drains queued session-media attachments without changing their namespace', async () => {
    const state = createState();
    promptStore().queuedBySession = {
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
    const ws = createWorkspaceRig(state, promptDeps());

    ws.resumeQueueIfIdle('sess_1');

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

  it('flushes the stuck queue head before the new prompt when sending while idle', async () => {
    const state = createState();
    promptStore().queuedBySession = { sess_1: [{ text: 'stuck queued', attachments: undefined }] };
    const ws = createWorkspaceRig(state, promptDeps({ activity: computed(() => 'idle') }));

    await ws.sendPrompt(ws.createPromptEnvelope({ text: 'next' }));
    await new Promise((r) => setTimeout(r, 0));

    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'stuck queued' }] }),
    );
    expect(promptStore().queuedBySession.sess_1).toEqual([
      expect.objectContaining({ text: 'next', attachments: [], skills: [] }),
    ]);
  });

  it('arms plan locally without a profile write, and cashes it on send', async () => {
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockResolvedValue({});
    const state = createState();
    state.towerModeBySession = { sess_1: true };
    const deps = promptDeps({ activity: computed(() => 'idle') });
    const ws = createWorkspaceRig(state, deps);

    ws.setPlanMode(true);
    expect(state.planArmedBySession.sess_1).toBe(true);
    expect(deps.persistSessionProfile).not.toHaveBeenCalledWith(
      expect.objectContaining({ planMode: expect.anything() }),
    );

    await ws.sendPrompt(ws.createPromptEnvelope({ text: 'make a plan' }));

    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_1', { planMode: true, towerMode: false });
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(apiMock.updateSession.mock.invocationCallOrder[0]!).toBeLessThan(
      apiMock.submitPrompt.mock.invocationCallOrder[0]!,
    );
    expect(state.planArmedBySession.sess_1).toBe(false);
    expect(state.towerModeBySession.sess_1).toBe(false);
  });

  it('disarming a live plan mode writes the daemon at once', async () => {
    const state = createState();
    state.planModeBySession = { sess_1: true };
    const deps = promptDeps();
    setModeHooks({
      persistSessionProfile: (patch, sid) => deps.persistSessionProfile(patch, sid),
    });
    const ws = createWorkspaceRig(state, deps);

    ws.setPlanMode(false);

    expect(deps.persistSessionProfile).toHaveBeenCalledWith({ planMode: false }, 'sess_1');
    expect(state.planArmedBySession.sess_1).toBe(false);
  });

  it('keeps a mid-flight re-arm when the toggle goes off then back on', async () => {
    apiMock.updateSession.mockReset();
    let resolveCash!: (value: unknown) => void;
    apiMock.updateSession.mockImplementation((_sid: string, patch: { planMode?: boolean }) =>
      patch.planMode === true
        ? new Promise((resolve) => { resolveCash = resolve; })
        : Promise.resolve({}),
    );
    const state = createState();
    const deps = promptDeps({ activity: computed(() => 'idle') });
    const ws = createWorkspaceRig(state, deps);

    ws.setPlanMode(true);
    const send = ws.sendPrompt(ws.createPromptEnvelope({ text: 'make a plan' }));
    await vi.waitFor(() =>
      expect(apiMock.updateSession).toHaveBeenCalledWith('sess_1', { planMode: true, towerMode: false }),
    );

    ws.setPlanMode(false);
    ws.setPlanMode(true);

    resolveCash({});
    await send;

    expect(deps.persistSessionProfile).not.toHaveBeenCalledWith({ planMode: false }, 'sess_1');
    expect(state.planArmedBySession.sess_1).toBe(true);
    expect(state.planModeBySession.sess_1).toBe(true);
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
  });

  it('waits for a settings write made during the plan write before submitting', async () => {
    apiMock.updateSession.mockReset();
    let resolveCash: ((value: unknown) => void) | undefined;
    let resolvePermission: ((value: unknown) => void) | undefined;
    apiMock.updateSession.mockImplementation((_sid: string, patch: { planMode?: boolean; permissionMode?: string }) => {
      if (patch.planMode === true) return new Promise((resolve) => { resolveCash = resolve; });
      if (patch.permissionMode === 'auto') return new Promise((resolve) => { resolvePermission = resolve; });
      return Promise.resolve({});
    });
    const state = createState();
    const deps = promptDeps({ activity: computed(() => 'idle') });
    const ws = createWorkspaceRig(state, deps);

    ws.setPlanMode(true);
    const send = ws.sendPrompt(ws.createPromptEnvelope({ text: 'make a plan' }));
    await vi.waitFor(() => expect(resolveCash).toBeDefined());
    void deps.persistSessionProfile({ permissionMode: 'auto' }, 'sess_1');
    resolveCash?.({});
    await vi.waitFor(() => expect(resolvePermission).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();

    resolvePermission?.({});
    await send;
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
  });

  it('keeps the re-armed intent when a second send queues mid-cash (off→on→send)', async () => {
    apiMock.updateSession.mockReset();
    let resolveCash!: (value: unknown) => void;
    apiMock.updateSession.mockImplementation((_sid: string, patch: { planMode?: boolean }) =>
      patch.planMode === true
        ? new Promise((resolve) => { resolveCash = resolve; })
        : Promise.resolve({}),
    );
    const state = createState();
    const deps = promptDeps({ activity: computed(() => 'idle') });
    const ws = createWorkspaceRig(state, deps);

    ws.setPlanMode(true);
    const send = ws.sendPrompt(ws.createPromptEnvelope({ text: 'first' }));
    await vi.waitFor(() =>
      expect(apiMock.updateSession).toHaveBeenCalledWith('sess_1', { planMode: true, towerMode: false }),
    );

    ws.setPlanMode(false);
    ws.setPlanMode(true);
    await ws.sendPrompt(ws.createPromptEnvelope({ text: 'second' }));

    resolveCash({});
    await send;

    expect(deps.persistSessionProfile).not.toHaveBeenCalledWith({ planMode: false }, 'sess_1');
    expect(state.planModeBySession.sess_1).toBe(true);
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
  });

  it('skips the cashing write when the daemon fact is already active', async () => {
    apiMock.updateSession.mockReset();
    const state = createState();
    state.planModeBySession = { sess_1: true };
    state.planArmedBySession = { sess_1: true };
    const ws = createWorkspaceRig(state, promptDeps({ activity: computed(() => 'idle') }));

    await ws.sendPrompt(ws.createPromptEnvelope({ text: 'continue planning' }));

    expect(apiMock.updateSession).not.toHaveBeenCalled();
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(state.planArmedBySession.sess_1).toBe(false);
  });

  it('re-queues a failed flush at the head and keeps it after repeated failures', async () => {
    const state = createState();
    const queued = {
      text: 'first queued',
      attachments: [{ fileId: 'f_img', kind: 'image' as const, sessionId: 'sess_1' }],
    };
    promptStore().queuedBySession = { sess_1: [queued] };
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'turn.agent_busy', requestId: 'r' }),
    );
    const ws = createWorkspaceRig(state, promptDeps());
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    for (let i = 0; i < 3; i += 1) {
      ws.resumeQueueIfIdle('sess_1');
      await settle();
      expect(promptStore().queuedBySession.sess_1).toEqual([queued]);
    }

    ws.resumeQueueIfIdle('sess_1');
    await settle();
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(3);
    expect(promptStore().queuedBySession.sess_1).toEqual([queued]);
  });

  it('keeps an exhausted multi-skill entry editable until the user removes it', async () => {
    const state = createState();
    promptStore().queuedBySession = {
      sess_1: [
        {
          text: 'review this',
          editText: '[deploy](kimi-code://skill/deploy) [review](kimi-code://skill/review) review this',
          attachments: [],
          skills: [{ name: 'deploy' }, { name: 'review' }],
          permissionMode: 'manual',
          id: 'id-skills',
        },
        { text: 'next prompt', attachments: undefined, id: 'id-next' },
      ],
    };
    apiMock.submitPrompt
      .mockRejectedValueOnce(new DaemonApiError({ code: 40408, msg: 'skill.not_found', requestId: 'r1' }))
      .mockRejectedValueOnce(new DaemonApiError({ code: 40408, msg: 'skill.not_found', requestId: 'r2' }))
      .mockRejectedValueOnce(new DaemonApiError({ code: 40408, msg: 'skill.not_found', requestId: 'r3' }))
      .mockImplementationOnce(echoPromptSubmit());
    const ws = createWorkspaceRig(state, promptDeps());
    const flushOnce = async () => {
      ws.resumeQueueIfIdle('sess_1');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };

    await flushOnce();
    await flushOnce();
    await flushOnce();
    expect(promptStore().queuedBySession.sess_1?.[0]).toEqual(expect.objectContaining({
      id: 'id-skills',
      editText: '[deploy](kimi-code://skill/deploy) [review](kimi-code://skill/review) review this',
      skills: [{ name: 'deploy' }, { name: 'review' }],
    }));
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(3);

    await flushOnce();
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(3);
    ws.unqueue(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(4);
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'next prompt' }] }),
    );
  });

  it('resumes the queue when an exhausted multi-skill head is reordered away', async () => {
    const state = createState();
    promptStore().queuedBySession = {
      sess_1: [
        {
          text: 'review this',
          attachments: [],
          skills: [{ name: 'deploy' }, { name: 'review' }],
          permissionMode: 'manual',
          id: 'id-skills',
        },
        { text: 'next prompt', attachments: undefined, id: 'id-next' },
      ],
    };
    apiMock.submitPrompt
      .mockRejectedValueOnce(new DaemonApiError({ code: 40408, msg: 'skill.not_found', requestId: 'r1' }))
      .mockRejectedValueOnce(new DaemonApiError({ code: 40408, msg: 'skill.not_found', requestId: 'r2' }))
      .mockRejectedValueOnce(new DaemonApiError({ code: 40408, msg: 'skill.not_found', requestId: 'r3' }))
      .mockImplementationOnce(echoPromptSubmit());
    const ws = createWorkspaceRig(state, promptDeps());
    for (let i = 0; i < 3; i += 1) {
      ws.resumeQueueIfIdle('sess_1');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    ws.reorderQueue(1, 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(4);
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'next prompt' }] }),
    );
    expect(promptStore().queuedBySession.sess_1?.map((entry) => entry.id)).toEqual(['id-skills']);
  });

  it('keeps session-media attachments in their namespace when steering a running turn', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        {
          text: 'queued media',
          attachments: [{ fileId: 'f_img', kind: 'image', sessionId: 'sess_1' }],
        },
      ],
    };
    const ws = createWorkspaceRig(state, promptDeps());

    await ws.steerPrompt(ws.createPromptEnvelope({
      text: 'live media',
      attachments: [{ fileId: 'f_vid', kind: 'video', sessionId: 'sess_1' }],
    }));

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

  it('renumbers every segment’s attachment links when a steer merges queued pill-flow prompts', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        {
          text: 'use [a.pdf](kimi-code-composer://attachments/1)',
          attachments: [{ fileId: 'f_a', kind: 'file', name: 'a.pdf', mediaType: 'application/pdf', size: 1 }],
        },
        {
          text: 'and [b.pdf](kimi-code-composer://attachments/1) plus [c.pdf](kimi-code-composer://attachments/2)',
          attachments: [
            { fileId: 'f_b', kind: 'file', name: 'b.pdf', mediaType: 'application/pdf', size: 2 },
            { fileId: 'f_img', kind: 'image' },
            { fileId: 'f_c', kind: 'file', name: 'c.pdf', mediaType: 'application/pdf', size: 3 },
          ],
        },
      ],
    };
    const ws = createWorkspaceRig(state, promptDeps());

    await ws.steerPrompt(ws.createPromptEnvelope({
      text: 'live [d.pdf](kimi-code-composer://attachments/1)',
      attachments: [
        { fileId: 'f_d', kind: 'file', name: 'd.pdf', mediaType: 'application/pdf', size: 4 },
      ],
    }));

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [
          {
            type: 'text',
            text: 'use a.pdf\n\nand b.pdf plus c.pdf\n\nlive d.pdf',
          },
          { type: 'file', fileId: 'f_a', name: 'a.pdf', mediaType: 'application/pdf', size: 1 },
          { type: 'file', fileId: 'f_b', name: 'b.pdf', mediaType: 'application/pdf', size: 2 },
          { type: 'image', source: { kind: 'file', fileId: 'f_img' } },
          { type: 'file', fileId: 'f_c', name: 'c.pdf', mediaType: 'application/pdf', size: 3 },
          { type: 'file', fileId: 'f_d', name: 'd.pdf', mediaType: 'application/pdf', size: 4 },
        ],
      }),
    );
    expect(promptStore().queuedBySession.sess_1).toEqual([]);
  });

  it('renumbers generated media labels before stripping links when a steer merges queued prompts', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        {
          text: 'first [Image 1](kimi-code-composer://attachments/m1)',
          attachments: [{ fileId: 'f_img', kind: 'image', name: 'photo.png', mediaOrdinal: 1 }],
        },
        {
          text: 'second [视频 1](kimi-code-composer://attachments/m1)',
          attachments: [{ fileId: 'f_vid', kind: 'video', name: 'clip.mp4', mediaOrdinal: 1 }],
        },
      ],
    };
    const ws = createWorkspaceRig(state, promptDeps());
    const livePrompt = ws.createPromptEnvelope({
      text: 'live [Image 1](kimi-code-composer://attachments/m1)',
      attachments: [{ fileId: 'f_live', kind: 'image', name: 'live.png', mediaOrdinal: 1 }],
    });

    await ws.steerPrompt(livePrompt);

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [
          {
            type: 'text',
            text: 'first Image 1\n\nsecond 视频 2\n\nlive Image 3',
          },
          { type: 'image', source: { kind: 'file', fileId: 'f_img' }, name: 'photo.png' },
          { type: 'video', source: { kind: 'file', fileId: 'f_vid' }, name: 'clip.mp4' },
          { type: 'image', source: { kind: 'file', fileId: 'f_live' }, name: 'live.png' },
        ],
      }),
    );
    expect(livePrompt.text).toBe('live [Image 1](kimi-code-composer://attachments/m1)');
  });

  it('keeps a queued bundled prompt’s skills when steering the queue head', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        {
          text: 'deploy [deploy](kimi-code://skill/deploy) then [review](kimi-code://skill/review)',
          skills: [{ name: 'deploy' }, { name: 'review' }],
          id: 'q_skill',
        },
      ],
    };
    const ws = createWorkspaceRig(state, promptDeps());

    await ws.steerQueued(0);

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [
          {
            type: 'text',
            text: 'deploy [deploy](kimi-code://skill/deploy) then [review](kimi-code://skill/review)',
          },
        ],
        skills: [{ name: 'deploy' }, { name: 'review' }],
      }),
    );
  });

  it('merges queued bundled prompts’ skills (deduped, first occurrence) into a Ctrl+S steer', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'first [deploy](kimi-code://skill/deploy)', skills: [{ name: 'deploy' }], id: 'q1' },
        {
          text: 'then [review](kimi-code://skill/review) + [deploy](kimi-code://skill/deploy)',
          skills: [{ name: 'review' }],
          id: 'q2',
        },
      ],
    };
    const ws = createWorkspaceRig(state, promptDeps());

    await ws.steerPrompt(ws.createPromptEnvelope({ text: 'live text' }));

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [
          {
            type: 'text',
            text:
              'first [deploy](kimi-code://skill/deploy)\n\n' +
              'then [review](kimi-code://skill/review) + [deploy](kimi-code://skill/deploy)\n\n' +
              'live text',
          },
        ],
        skills: [{ name: 'deploy' }, { name: 'review' }],
      }),
    );
  });

  it('dedupes pathless skills against only the current default variant on Ctrl+S', async () => {
    const primary = { name: 'deploy', description: 'Primary', path: '/work/A/deploy/SKILL.md', source: 'project' as const };
    const secondary = { name: 'deploy', description: 'Secondary', path: '/work/B/deploy/SKILL.md', source: 'project' as const };
    const previousSkills = modelsStore().skillsBySession;
    modelsStore().setSkillsForSession('sess_1', [primary, secondary]);
    try {
      const state = createState();
      promptStore().inFlightBySession = { sess_1: true };
      promptStore().queuedBySession = {
        sess_1: [
          { text: 'legacy pill', skills: [{ name: 'deploy' }], id: 'q1' },
          {
            text: 'selected variants',
            skills: [{ name: 'deploy', path: primary.path }, { name: 'deploy', path: secondary.path }],
            id: 'q2',
          },
        ],
      };
      const ws = createWorkspaceRig(state, promptDeps());

      await ws.steerPrompt(ws.createPromptEnvelope({ text: 'live text' }));

      expect(apiMock.submitPrompt).toHaveBeenCalledWith(
        'sess_1',
        expect.objectContaining({
          skills: [
            { name: 'deploy', path: primary.path },
            { name: 'deploy', path: secondary.path },
          ],
        }),
      );
    } finally {
      modelsStore().skillsBySession = previousSkills;
    }
  });

  it('merges the live draft’s skills with the queued entries’ skills (deduped) on Ctrl+S', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'queued [deploy](kimi-code://skill/deploy)', skills: [{ name: 'deploy' }], id: 'q1' },
      ],
    };
    const ws = createWorkspaceRig(state, promptDeps());

    await ws.steerPrompt(ws.createPromptEnvelope({
      text: 'live [review](kimi-code://skill/review) + [deploy](kimi-code://skill/deploy)',
      skills: [{ name: 'review' }, { name: 'deploy' }],
    }));

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [
          {
            type: 'text',
            text:
              'queued [deploy](kimi-code://skill/deploy)\n\n' +
              'live [review](kimi-code://skill/review) + [deploy](kimi-code://skill/deploy)',
          },
        ],
        skills: [{ name: 'deploy' }, { name: 'review' }],
      }),
    );
  });

  it('surfaces the steer outcome for the App’s draft restore (rejected on definitive daemon refusal)', async () => {
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'skill.not_found', requestId: 'r' }),
    );
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    const ws = createWorkspaceRig(state, promptDeps());

    const outcome = await ws.steerPrompt(ws.createPromptEnvelope({
      text: 'live [deploy](kimi-code://skill/deploy)',
      skills: [{ name: 'deploy' }],
    }));

    expect(outcome).toBe('rejected');
  });

  it('marks an accepted steer with the accepted phase on the optimistic bubble', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    apiMock.submitPrompt.mockImplementation(echoPromptSubmit('queued'));
    apiMock.steerPrompts.mockImplementation(async (_sid: string, promptIds: string[]) => ({ steered: true, promptIds }));
    const ws = createWorkspaceRig(state, promptDeps());

    expect(await ws.steerPrompt(ws.createPromptEnvelope({ text: 'adjust the curve' }))).toBe('ok');

    const bubbles = promptStore().optimisticMessagesBySession.sess_1 ?? [];
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.metadata).toMatchObject({
      'kimiWeb.steered': true,
      'kimiWeb.steerPhase': 'accepted',
    });
  });

  it('steers when the conversation shows the main turn running despite empty local flags', async () => {
    const state = createState();
    sessionRuntimeStore().turnActiveBySession = {};
    promptStore().inFlightBySession = {};
    apiMock.steerPrompt.mockImplementation(echoPromptSubmit('queued'));
    const ws = createWorkspaceRig(state, promptDeps({ isMainTurnRunning: () => true, isMainWaitForWaiting: () => false }));

    expect(await ws.steerPromptDirect(ws.createPromptEnvelope({ text: 'steer into the running turn' }))).toBe('ok');

    expect(apiMock.steerPrompt).toHaveBeenCalledOnce();
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(apiMock.steerPrompts).not.toHaveBeenCalled();
    expect(promptStore().optimisticMessagesBySession.sess_1?.[0]?.metadata).toMatchObject({
      'kimiWeb.steered': true,
      'kimiWeb.steerPhase': 'accepted',
    });
  });

  it('queues a normal send instead of steering while the main agent waits in WaitFor', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    const ws = createWorkspaceRig(state, promptDeps({ isMainWaitForWaiting: () => true }));

    expect(ws.wouldSteerPrompt()).toBe(false);
    const outcome = await ws.sendPrompt(ws.createPromptEnvelope({ text: 'later note' }));

    expect(outcome).toBe('queued');
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(apiMock.steerPrompts).not.toHaveBeenCalled();
    expect(promptStore().queuedBySession.sess_1?.map((entry) => entry.text)).toEqual(['later note']);
  });

  it('steers an explicit Ctrl+S into a wait before local busy state catches up', async () => {
    apiMock.steerPrompt.mockImplementation(echoPromptSubmit('queued'));
    const ws = createWorkspaceRig(createState(), promptDeps({
      activity: computed(() => 'idle'),
      isMainWaitForWaiting: () => true,
    }));

    expect(await ws.steerPromptDirect(ws.createPromptEnvelope({ text: 'stop waiting' }))).toBe('ok');
    expect(apiMock.steerPrompt).toHaveBeenCalledOnce();
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(apiMock.steerPrompts).not.toHaveBeenCalled();
  });

  it('steers a clicked queued entry into a wait', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined, id: 'q1' },
        { text: 'second queued', attachments: undefined, id: 'q2' },
      ],
    };
    apiMock.submitPrompt.mockImplementation(echoPromptSubmit('queued'));
    const ws = createWorkspaceRig(state, promptDeps({ isMainWaitForWaiting: () => true }));

    expect(await ws.steerQueued(0)).toBe('ok');
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'first queued' }] }),
    );
    expect(apiMock.steerPrompts).toHaveBeenCalledWith('sess_1', [sentPromptId()]);
    expect(promptStore().queuedBySession.sess_1?.map((entry) => entry.text)).toEqual(['second queued']);
  });

  it('holds a tower-mode send queued behind another steer for a mode write that starts meanwhile', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    modeStore().towerModeBySession = { sess_1: true };
    let respondFirst: ((value: { promptId: string; userMessageId: string; status: 'queued' }) => void) | undefined;
    apiMock.submitPrompt.mockImplementationOnce(() => new Promise((done) => { respondFirst = done; }));
    let settle: ((ok: boolean) => void) | undefined;
    const ws = createWorkspaceRig(state, promptDeps({
      whenSessionProfileSettled: (sid) =>
        sessionRuntimeStore().profileWriteChainBySid.has(sid)
          ? new Promise((done) => { settle = done; })
          : Promise.resolve(true),
    }));

    const first = ws.sendPrompt(ws.createPromptEnvelope({ text: 'first' }));
    await vi.waitFor(() => expect(respondFirst).toBeDefined());
    const second = ws.sendPrompt(ws.createPromptEnvelope({ text: 'second' }));
    sessionRuntimeStore().profileWriteChainBySid.set('sess_1', Promise.resolve(true));
    respondFirst?.({ promptId: sentPromptId(), userMessageId: sentPromptId(), status: 'queued' });
    expect(await first).toBe('ok');
    await vi.waitFor(() => expect(settle).toBeDefined());
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(1);
    settle?.(false);

    expect(await second).toBe('rejected');
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(1);
    sessionRuntimeStore().profileWriteChainBySid.delete('sess_1');
    modeStore().towerModeBySession = {};
  });

  it('rejects every tower-mode send that joined a mode write when that write fails', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    modeStore().towerModeBySession = { sess_1: true };
    sessionRuntimeStore().profileWriteChainBySid.set('sess_1', Promise.resolve(true));
    let failed = false;
    const settles: ((ok: boolean) => void)[] = [];
    const ws = createWorkspaceRig(state, promptDeps({
      whenSessionProfileSettled: () => (failed ? Promise.resolve(true) : new Promise((done) => { settles.push(done); })),
    }));

    const first = ws.sendPrompt(ws.createPromptEnvelope({ text: 'first' }));
    const second = ws.sendPrompt(ws.createPromptEnvelope({ text: 'second' }));
    await vi.waitFor(() => expect(settles.length).toBeGreaterThanOrEqual(2));
    failed = true;
    sessionRuntimeStore().profileWriteChainBySid.delete('sess_1');
    for (const settle of settles) settle(false);

    expect(await first).toBe('rejected');
    expect(await second).toBe('rejected');
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    modeStore().towerModeBySession = {};
  });

  it('keeps later input queued behind a normal submit that is still in flight when a wait starts', async () => {
    const state = createState();
    let respond: ((value: { promptId: string; userMessageId: string; status: 'queued' }) => void) | undefined;
    apiMock.submitPrompt.mockImplementationOnce(() => new Promise((done) => { respond = done; }));
    let waiting = false;
    const ws = createWorkspaceRig(state, promptDeps({
      activity: computed(() => 'idle'),
      isMainWaitForWaiting: () => waiting,
    }));

    const first = ws.sendPrompt(ws.createPromptEnvelope({ text: 'first' }));
    await vi.waitFor(() => expect(respond).toBeDefined());
    waiting = true;
    promptStore().queuedBySession = { sess_1: [{ text: 'queued before', attachments: undefined }] };

    expect(ws.wouldSteerPrompt()).toBe(false);
    expect(await ws.sendPrompt(ws.createPromptEnvelope({ text: 'second' }))).toBe('queued');
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(1);
    expect(apiMock.steerPrompts).not.toHaveBeenCalled();
    respond?.({ promptId: sentPromptId(), userMessageId: sentPromptId(), status: 'queued' });
    expect(await first).toBe('ok');
  });

  it('queues a normal send while busy when no WaitFor is waiting', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    const ws = createWorkspaceRig(state, promptDeps({ isMainWaitForWaiting: () => false }));

    expect(ws.wouldSteerPrompt()).toBe(false);
    const outcome = await ws.sendPrompt(ws.createPromptEnvelope({ text: 'later' }));

    expect(outcome).toBe('queued');
    expect(apiMock.steerPrompts).not.toHaveBeenCalled();
  });

  it('queues an explicit forceQueue send even when tower mode would otherwise steer', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    modeStore().towerModeBySession = { sess_1: true };
    try {
      const ws = createWorkspaceRig(state, promptDeps({ isMainWaitForWaiting: () => false }));

      const outcome = await ws.sendPrompt(ws.createPromptEnvelope({ text: 'queued via shortcut' }), undefined, { forceQueue: true });

      expect(outcome).toBe('queued');
      expect(apiMock.submitPrompt).not.toHaveBeenCalled();
      expect(promptStore().queuedBySession.sess_1?.map((entry) => entry.text)).toEqual(['queued via shortcut']);
    } finally {
      modeStore().towerModeBySession = {};
    }
  });

  it('steers or force-queues createGoal prompts according to running delivery mode', async () => {
    const state = createState();
    permissionsStore().pickInSession('sess_1', 'auto');
    promptStore().inFlightBySession = { sess_1: true };
    modeStore().towerModeBySession = { sess_1: true };
    apiMock.updateSession.mockResolvedValue({});
    apiMock.steerPrompt.mockImplementation(echoPromptSubmit('queued'));
    try {
      const ws = createWorkspaceRig(state, promptDeps({ isMainWaitForWaiting: () => false }));

      const steered = await ws.createGoal({ text: 'steered goal' }, { delivery: 'steer' });
      expect(steered).toEqual({ sessionId: 'sess_1', promptRejected: false });
      expect(apiMock.steerPrompt).toHaveBeenCalledOnce();
      expect(promptStore().queuedBySession.sess_1 ?? []).toHaveLength(0);

      const queued = await ws.createGoal({ text: 'queued goal' }, { delivery: 'queue', editText: 'queued goal edit' });
      expect(queued).toEqual({ sessionId: 'sess_1', promptRejected: false });
      expect(apiMock.submitPrompt).not.toHaveBeenCalled();
      expect(promptStore().queuedBySession.sess_1).toEqual([
        expect.objectContaining({ text: 'queued goal', editText: 'queued goal edit' }),
      ]);
    } finally {
      modeStore().towerModeBySession = {};
    }
  });

  it('steers queued entries with composer snapshots together with the live draft on Ctrl+S', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [{ text: 'queued', attachments: undefined, snapshot: createComposerSnapshot(textToDoc('queued'), [], []), id: 'q1' }],
    };
    apiMock.submitPrompt.mockImplementation(echoPromptSubmit('queued'));
    const ws = createWorkspaceRig(state, promptDeps());

    const outcome = await ws.steerPrompt(ws.createPromptEnvelope({ text: 'live text', snapshot: createComposerSnapshot(textToDoc('live text'), [], []) }));

    expect(outcome).toBe('ok');
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'queued\n\nlive text' }] }),
    );
    expect(promptStore().queuedBySession.sess_1 ?? []).toHaveLength(0);
  });

  it('restores the merged queue entries when a steer submit is definitively rejected', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [{ text: 'queued', attachments: [{ fileId: 'f_q', kind: 'image' }] }],
    };
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }),
    );
    const ws = createWorkspaceRig(state, promptDeps());

    await ws.steerPrompt(ws.createPromptEnvelope({
      text: 'live text',
      attachments: [{ fileId: 'f_live', kind: 'image' }],
    }));

    expect(promptStore().queuedBySession.sess_1).toEqual([
      { text: 'queued', attachments: [{ fileId: 'f_q', kind: 'image' }] },
    ]);
  });

  it('restores the merged queue entries when a steer submit fails on the network', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [{ text: 'queued', attachments: [{ fileId: 'f_q', kind: 'image' }] }],
    };
    apiMock.submitPrompt.mockRejectedValue(new TypeError('fetch failed'));
    const ws = createWorkspaceRig(state, promptDeps());

    await ws.steerPrompt(ws.createPromptEnvelope({
      text: 'live text',
      attachments: [{ fileId: 'f_live', kind: 'image' }],
    }));

    expect(promptStore().queuedBySession.sess_1).toEqual([
      { text: 'queued', attachments: [{ fileId: 'f_q', kind: 'image' }] },
    ]);
  });

  it('resolves rejected with the bubble rolled back on a structured auth refusal, so the caller restores the composer draft', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 40111, msg: 'token missing', requestId: 'r' }),
    );
    const ws = createWorkspaceRig(state, promptDeps());

    const outcome = await ws.steerPrompt(ws.createPromptEnvelope({
      text: 'live text',
      attachments: [{ fileId: 'f_live', kind: 'image' }],
    }));

    expect(outcome).toBe('rejected');
    expect(promptStore().optimisticMessagesBySession['sess_1'] ?? []).toHaveLength(0);
  });

  it('resolves rejected with the bubble rolled back on a network failure, so the caller restores the composer draft', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    apiMock.submitPrompt.mockRejectedValue(new TypeError('fetch failed'));
    const ws = createWorkspaceRig(state, promptDeps());

    const outcome = await ws.steerPrompt(ws.createPromptEnvelope({ text: 'live text' }));

    expect(outcome).toBe('rejected');
    expect(promptStore().optimisticMessagesBySession['sess_1'] ?? []).toHaveLength(0);
  });

  it('consumes the armed plan intent when an idle steer falls back to a normal send', async () => {
    const state = createState();
    state.planArmedBySession = { sess_1: true };
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockResolvedValue({});
    const ws = createWorkspaceRig(state, promptDeps({ activity: computed(() => 'idle') }));

    await ws.steerPrompt(ws.createPromptEnvelope({ text: 'live text' }));

    expect(apiMock.updateSession).toHaveBeenCalledWith('sess_1', { planMode: true, towerMode: false });
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(state.planArmedBySession.sess_1).toBe(false);
  });

  it('restores the merged queue entries when an idle steer falls back to a normal send that fails', async () => {
    const state = createState();
    promptStore().queuedBySession = { sess_1: [{ text: 'queued', attachments: undefined }] };
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }),
    );
    const ws = createWorkspaceRig(state, promptDeps({ activity: computed(() => 'idle') }));

    await ws.steerPrompt(ws.createPromptEnvelope({ text: 'live text' }));

    await vi.waitFor(() => expect(promptStore().queuedBySession.sess_1).toEqual([
      { text: 'queued', attachments: undefined },
    ]));
  });

  it('steers one queued message into the running turn and keeps the rest of the queue', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    apiMock.submitPrompt.mockImplementation(echoPromptSubmit('queued'));
    const ws = createWorkspaceRig(state, promptDeps());

    await ws.steerQueued(0);

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        content: [{ type: 'text', text: 'first queued' }],
      }),
    );
    expect(apiMock.steerPrompts).toHaveBeenCalledWith('sess_1', [sentPromptId()]);
    expect(promptStore().queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
    ]);
  });

  it('restores the entry at its original index when a queued steer is definitively rejected', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }),
    );
    const ws = createWorkspaceRig(state, promptDeps());

    await ws.steerQueued(1);

    expect(promptStore().queuedBySession.sess_1).toEqual([
      { text: 'first queued', attachments: undefined },
      { text: 'second queued', attachments: undefined },
    ]);
  });

  it('restores the entry at its original index when a queued steer fails on the network', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    apiMock.submitPrompt.mockRejectedValue(new TypeError('fetch failed'));
    const ws = createWorkspaceRig(state, promptDeps());

    await ws.steerQueued(0);

    expect(promptStore().queuedBySession.sess_1).toEqual([
      { text: 'first queued', attachments: undefined },
      { text: 'second queued', attachments: undefined },
    ]);
  });

  it('falls back to a normal send when steering a queued message with no turn running', async () => {
    const state = createState();
    promptStore().queuedBySession = { sess_1: [{ text: 'queued', attachments: undefined }] };
    const ws = createWorkspaceRig(state, promptDeps({ activity: computed(() => 'idle') }));

    await ws.steerQueued(0);

    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(apiMock.steerPrompts).not.toHaveBeenCalled();
    expect(promptStore().queuedBySession.sess_1).toEqual([]);
  });

  it('sends the queued text verbatim (no trimming)', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [{ text: '    indented code block', attachments: undefined }],
    };
    apiMock.submitPrompt.mockImplementation(echoPromptSubmit('queued'));
    const ws = createWorkspaceRig(state, promptDeps());

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
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    let resolveSteer!: (value: unknown) => void;
    apiMock.submitPrompt.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSteer = resolve; }),
    );
    const ws = createWorkspaceRig(state, promptDeps());

    const steer = ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    expect(promptStore().queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
    ]);

    promptStore().setInFlight('sess_1', false);
    ws.resumeQueueIfIdle('sess_1');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(promptStore().queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
    ]);

    resolveSteer({ promptId: sentPromptId(), userMessageId: sentPromptId(), status: 'queued' });
    await steer;
    expect(apiMock.steerPrompts).toHaveBeenCalledWith('sess_1', [sentPromptId()]);

    endMainTurn(ws);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2));
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'second queued' }] }),
    );
  });

  it('serializes consecutive queued steers so the daemon sees them in click order', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    let resolveFirst!: (value: unknown) => void;
    apiMock.submitPrompt
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(echoPromptSubmit('queued'));
    const ws = createWorkspaceRig(state, promptDeps());

    const s1 = ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    const s2 = ws.steerQueued(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(promptStore().queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
    ]);

    resolveFirst({ promptId: sentPromptId(0), userMessageId: sentPromptId(0), status: 'queued' });
    await Promise.all([s1, s2]);
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2);
    expect(apiMock.submitPrompt).toHaveBeenNthCalledWith(
      2,
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'second queued' }] }),
    );
    expect(apiMock.steerPrompts).toHaveBeenNthCalledWith(1, 'sess_1', [sentPromptId(0)]);
    expect(apiMock.steerPrompts).toHaveBeenNthCalledWith(2, 'sess_1', [sentPromptId(1)]);
    expect(promptStore().queuedBySession.sess_1 ?? []).toEqual([]);
  });

  it('sendPrompt enqueues behind an in-flight steer without flushing early', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'first queued', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    let resolveSteer!: (value: unknown) => void;
    apiMock.submitPrompt.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSteer = resolve; }),
    );
    const ws = createWorkspaceRig(state, promptDeps());

    const steer = ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());

    await ws.sendPrompt(ws.createPromptEnvelope({ text: 'third' }));
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(promptStore().queuedBySession.sess_1).toEqual([
      { text: 'second queued', attachments: undefined },
      expect.objectContaining({ text: 'third' }),
    ]);

    resolveSteer({ promptId: sentPromptId(), userMessageId: sentPromptId(), status: 'queued' });
    await steer;
    endMainTurn(ws);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2));
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'second queued' }] }),
    );
  });

  it('ignores an empty queued entry without dropping it', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = { sess_1: [{ text: '   ', attachments: undefined }] };
    const ws = createWorkspaceRig(state, promptDeps());

    await ws.steerQueued(0);

    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(promptStore().queuedBySession.sess_1).toEqual([{ text: '   ', attachments: undefined }]);
  });

  it('restores the queued entry when the steer fails before the submit is sent', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = { sess_1: [{ text: 'queued', attachments: undefined }] };
    const ws = createWorkspaceRig(state, promptDeps({
      whenSessionProfileSettled: vi.fn(async () => false),
    }));

    await ws.steerQueued(0);

    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(promptStore().queuedBySession.sess_1).toEqual([{ text: 'queued', attachments: undefined }]);
  });

  it('resumes the queue after a rejected steer once the hold is released', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = { sess_1: [{ text: 'queued', attachments: undefined }] };
    let rejectSteer!: (err: unknown) => void;
    apiMock.submitPrompt.mockImplementationOnce(
      () => new Promise((_, reject) => { rejectSteer = reject; }),
    );
    const activity = ref('working');
    const ws = createWorkspaceRig(state, promptDeps({ activity: computed(() => activity.value) }));

    const steer = ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    activity.value = 'idle';
    promptStore().inFlightBySession = { sess_1: false };
    ws.resumeQueueIfIdle('sess_1');

    rejectSteer(new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }));
    await steer;
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2));
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'queued' }] }),
    );
    expect(promptStore().queuedBySession.sess_1).toEqual([]);
  });

  it('steers the entry locked at click time, not whatever sits at the index later', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'A', attachments: undefined },
        { text: 'B', attachments: undefined },
      ],
    };
    let rejectFirst!: (err: unknown) => void;
    apiMock.submitPrompt
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(echoPromptSubmit('queued'));
    const ws = createWorkspaceRig(state, promptDeps());

    const s1 = ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    const s2 = ws.steerQueued(0);
    rejectFirst(new DaemonApiError({ code: 50000, msg: 'boom', requestId: 'r' }));
    await s1;
    expect(promptStore().queuedBySession.sess_1).toEqual([
      { text: 'A', attachments: undefined },
      { text: 'B', attachments: undefined },
    ]);
    await s2;
    expect(apiMock.submitPrompt).toHaveBeenNthCalledWith(
      2,
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'B' }] }),
    );
    expect(apiMock.steerPrompts).toHaveBeenCalledWith('sess_1', [sentPromptId(1)]);
    expect(promptStore().queuedBySession.sess_1).toEqual([{ text: 'A', attachments: undefined }]);
  });

  it('runs a Ctrl+S merge steer behind an in-flight queued steer', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'A', attachments: undefined },
        { text: 'B', attachments: undefined },
      ],
    };
    let resolveFirst!: (value: unknown) => void;
    apiMock.submitPrompt
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(echoPromptSubmit('queued'));
    const ws = createWorkspaceRig(state, promptDeps());

    const s1 = ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    const s2 = ws.steerPrompt(ws.createPromptEnvelope({ text: 'live' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(promptStore().queuedBySession.sess_1).toEqual([{ text: 'B', attachments: undefined }]);

    resolveFirst({ promptId: sentPromptId(0), userMessageId: sentPromptId(0), status: 'queued' });
    await Promise.all([s1, s2]);
    expect(apiMock.submitPrompt).toHaveBeenNthCalledWith(
      2,
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'B\n\nlive' }] }),
    );
    expect(apiMock.steerPrompts).toHaveBeenNthCalledWith(1, 'sess_1', [sentPromptId(0)]);
    expect(apiMock.steerPrompts).toHaveBeenNthCalledWith(2, 'sess_1', [sentPromptId(1)]);
    expect(promptStore().queuedBySession.sess_1 ?? []).toEqual([]);
  });

  it('sendPrompt falls in line behind an in-flight steer even after the turn ended', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = { sess_1: [{ text: 'steered', attachments: undefined }] };
    let resolveSteer!: (value: unknown) => void;
    apiMock.submitPrompt.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSteer = resolve; }),
    );
    const activity = ref('working');
    const ws = createWorkspaceRig(state, promptDeps({ activity: computed(() => activity.value) }));

    const steer = ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    activity.value = 'idle';
    promptStore().inFlightBySession = { sess_1: false };

    await ws.sendPrompt(ws.createPromptEnvelope({ text: 'new message' }));
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(promptStore().queuedBySession.sess_1).toEqual([
      expect.objectContaining({ text: 'new message' }),
    ]);

    resolveSteer({ promptId: sentPromptId(), userMessageId: sentPromptId(), status: 'queued' });
    await steer;
    endMainTurn(ws);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2));
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'new message' }] }),
    );
  });

  it('forgetLocalTurnState releases the steer-in-flight hold', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'steered', attachments: undefined },
        { text: 'second queued', attachments: undefined },
      ],
    };
    apiMock.submitPrompt.mockImplementationOnce(() => new Promise(() => {}));
    const ws = createWorkspaceRig(state, promptDeps());

    void ws.steerQueued(0);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());

    promptStore().forgetLocalTurnState('sess_1');
    endMainTurn(ws);
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2));
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'second queued' }] }),
    );
  });

  it('maps attachments to the matching content parts on submit (file parts included)', async () => {
    const ws = createWorkspaceRig(createState(), promptDeps());

    await ws.submitPromptInternal('sess_1', {
      text: 'look at these',
      attachments: [
        { fileId: 'f_img', kind: 'image' },
        { fileId: 'f_vid', kind: 'video' },
        { fileId: 'f_history_img', kind: 'image', sessionId: 'sess_1' },
        { fileId: 'f_history_vid', kind: 'video', sessionId: 'sess_1' },
        { fileId: 'f_pdf', kind: 'file', name: 'a.pdf', mediaType: 'application/pdf', size: 42 },
      ],
      skills: [],
      permissionMode: undefined,
    });

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
    const ws = createWorkspaceRig(createState(), promptDeps());

    await ws.submitPromptInternal('sess_1', {
      text: 'look at this',
      attachments: [
        { fileId: 'f_mk', kind: 'file', name: 'Makefile', mediaType: '', size: 10 },
      ],
      skills: [],
      permissionMode: undefined,
    });

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

  it('holds the queue behind an exhausted head until the user removes it', async () => {
    const state = createState();
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'poisoned head', attachments: undefined, id: 'id-bad' },
        { text: 'good next', attachments: undefined, id: 'id-good' },
      ],
    };
    apiMock.submitPrompt
      .mockRejectedValueOnce(new DaemonApiError({ code: 50000, msg: 'gone', requestId: 'r' }))
      .mockRejectedValueOnce(new DaemonApiError({ code: 50000, msg: 'gone', requestId: 'r' }))
      .mockRejectedValueOnce(new DaemonApiError({ code: 50000, msg: 'gone', requestId: 'r' }))
      .mockImplementationOnce(echoPromptSubmit());
    const ws = createWorkspaceRig(state, promptDeps());
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const flushOnce = async () => {
      ws.resumeQueueIfIdle('sess_1');
      await settle();
    };

    for (let i = 0; i < 3; i += 1) {
      await flushOnce();
    }

    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(3);
    expect(promptStore().queuedBySession.sess_1?.map((e) => e.id)).toEqual(['id-bad', 'id-good']);

    await flushOnce();
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(3);

    ws.unqueue(0);
    await settle();
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(4);
    expect(apiMock.submitPrompt).toHaveBeenLastCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'good next' }] }),
    );
    expect(promptStore().queuedBySession.sess_1 ?? []).toEqual([]);
  });

  it('puts a flushed head back at the front of the queue when its submit fails on the network', async () => {
    const state = createState();
    promptStore().queuedBySession = { sess_1: [{ text: 'maybe sent', attachments: undefined, id: 'id-x' }] };
    apiMock.submitPrompt.mockRejectedValue(new TypeError('fetch failed'));
    const ws = createWorkspaceRig(state, promptDeps());

    ws.resumeQueueIfIdle('sess_1');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(promptStore().queuedBySession.sess_1).toEqual([{ text: 'maybe sent', attachments: undefined, id: 'id-x' }]);
    expect(promptStore().optimisticMessagesBySession.sess_1).toBeUndefined();
  });

  it('resets the flush failure budget when the queue head changes', async () => {
    apiMock.submitPrompt.mockRejectedValue(
      new DaemonApiError({ code: 50000, msg: 'turn.agent_busy', requestId: 'r' }),
    );
    const state = createState();
    promptStore().queuedBySession = {
      sess_1: [
        { text: 'first', attachments: undefined, id: 'id-first' },
        { text: 'second', attachments: undefined, id: 'id-second' },
      ],
    };
    const ws = createWorkspaceRig(state, promptDeps());
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const flushOnce = async () => {
      ws.resumeQueueIfIdle('sess_1');
      await settle();
    };

    await flushOnce();
    ws.unqueue(0);
    expect(promptStore().queuedBySession.sess_1?.map((e) => e.text)).toEqual(['second']);

    await flushOnce();
    await flushOnce();
    expect(promptStore().queuedBySession.sess_1?.map((e) => e.text)).toEqual(['second']);
    await flushOnce();
    expect(promptStore().queuedBySession.sess_1?.map((e) => e.text)).toEqual(['second']);
    await flushOnce();
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(4);
    expect(promptStore().queuedBySession.sess_1?.map((e) => e.text)).toEqual(['second']);
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
    promptStore().queuedBySession = {
      sess_1: [{ text: 'doomed', attachments: undefined, id: 'id-doomed' }],
    };
    const ws = createWorkspaceRig(state, promptDeps());

    ws.resumeQueueIfIdle('sess_1');
    expect(promptStore().queuedBySession.sess_1 ?? []).toEqual([]);

    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalled());
    state.sessions = [];
    delete promptStore().queuedBySession.sess_1;
    rejectSubmit(new DaemonApiError({ code: 50000, msg: 'network down', requestId: 'r' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(promptStore().queuedBySession.sess_1).toBeUndefined();
  });
});

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
    sessionsStore().setSessions([{ ...createSession(), usage: liveUsage() }]);
    apiMock.listSessions.mockResolvedValue({
      items: [{ ...createSession(), title: 'Fresh from server' }],
      hasMore: false,
    });
    const ws = createWorkspaceRig(state, createDeps());

    await ws.loadAllSessions();

    expect(sessionsStore().sessions[0]!.title).toBe('Fresh from server');
    expect(sessionsStore().sessions[0]!.usage).toEqual(liveUsage());
  });

  it('takes the server row as-is when there is no live usage to preserve', async () => {
    const state = createState();
    sessionsStore().setSessions([createSession()]);
    apiMock.listSessions.mockResolvedValue({ items: [createSession()], hasMore: false });
    const ws = createWorkspaceRig(state, createDeps());

    await ws.loadAllSessions();

    expect(sessionsStore().sessions[0]!.usage.contextTokens).toBe(0);
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
    sessionsStore().setSessions([...loaded]);
    Object.defineProperty(state, 'sessions', {
      get: () => sessionsStore().sessions,
      set: (next: AppSession[]) => sessionsStore().setSessions(next),
    });
    workspacesStore().sessionsCursorByWorkspace = { [WS]: cursor };
    workspacesStore().sessionsHasMoreByWorkspace = { [WS]: hasMore };
    const deps = {
      ...createDeps(),
      sideChat: { clearSideChatForSession: vi.fn() },
      forgetSession: vi.fn((id: string) => {
        sessionsStore().removeSession(id);
      }),
    } as unknown as WorkspaceRigDeps;
    setSessionListHooks({
      pushOperationFailure: (...args) => pushFailureSpy(...args),
      onSessionsArchivedLocally: async (ids) => {
        for (const id of ids) deps.forgetSession(id);
        if (state.activeSessionId !== undefined && ids.includes(state.activeSessionId)) {
          const next = sessionsStore().sessions[0];
          deps.setActiveSessionId(next?.id);
        }
      },
    });
    return { state, deps, workspaceState: createWorkspaceRig(state, deps) };
  }

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
      hasPrompt: true,
    });
    expect(ids(state.sessions)).toEqual(['s1', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']);
    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s10');
    expect(workspacesStore().sessionsHasMoreByWorkspace[WS]).toBe(true);
  });

  it('re-anchors the cursor first when the archived session was the cursor', async () => {
    const loaded = [1, 2, 3, 4, 5].map((i) => wsSession(`s${i}`, i - 1));
    apiMock.listSessions.mockResolvedValue({ items: [wsSession('s6', 5)], hasMore: false });
    const { state, workspaceState } = createArchiveRig(loaded, 's5', true);

    await workspaceState.archiveSession('s5');
    await flush();

    expect(apiMock.listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      hasPrompt: true,
    });
    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(workspacesStore().sessionsHasMoreByWorkspace[WS]).toBe(false);
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
      hasPrompt: true,
    });
    expect(ids(state.sessions)).toEqual(['s2', 's3']);
    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s3');
    expect(workspacesStore().sessionsHasMoreByWorkspace[WS]).toBe(false);
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
    const { state, workspaceState } = createArchiveRig(loaded, 's5', true);

    await workspaceState.archiveSession('s2');
    await flush();

    expect(apiMock.listSessions).toHaveBeenCalledTimes(1);
    expect(pushFailureSpy).toHaveBeenCalled();
    expect(ids(state.sessions)).toEqual(['s1', 's3', 's4', 's5']);
  });

  it('stops after one attempt when the emptied-workspace reload fails', async () => {
    apiMock.listSessions.mockRejectedValue(new Error('network down'));
    const { state, workspaceState } = createArchiveRig([wsSession('s1', 0)], 's1', true);

    await workspaceState.archiveSession('s1');
    await flush();

    expect(apiMock.listSessions).toHaveBeenCalledTimes(1);
    expect(pushFailureSpy).toHaveBeenCalled();
    expect(state.sessions).toEqual([]);
    expect(workspacesStore().sessionsHasMoreByWorkspace[WS]).toBe(true);
  });

  it('re-anchors to the contiguous predecessor, not an off-page loaded row', async () => {
    const loaded = [1, 2, 3, 4, 5].map((i) => wsSession(`s${i}`, i - 1));
    loaded.push(wsSession('s20', 19));
    apiMock.listSessions.mockResolvedValue({ items: [wsSession('s6', 5)], hasMore: true });
    const { workspaceState } = createArchiveRig(loaded, 's5', true);

    await workspaceState.archiveSession('s5');
    await flush();

    expect(apiMock.listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      hasPrompt: true,
    });
    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s6');
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
    await workspaceState.archiveSession('s5');
    resolvers[0]!({ items: [], hasMore: false });
    await flush();
    expect(apiMock.listSessions).toHaveBeenCalledTimes(2);
    expect(apiMock.listSessions).toHaveBeenNthCalledWith(2, {
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      hasPrompt: true,
    });
    resolvers[1]!({ items: [wsSession('s6', 5)], hasMore: false });
    await pending;
    await flush();

    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(workspacesStore().sessionsHasMoreByWorkspace[WS]).toBe(false);
    expect(ids(state.sessions)).toEqual(['s1', 's2', 's3', 's4', 's6']);
  });

  it('stops after the page budget when backfill pages are all child sessions', async () => {
    const loaded = [1, 2, 3, 4, 5].map((i) => wsSession(`s${i}`, i - 1));
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
    apiMock.archiveSession.mockImplementation(async () => {
      state.sessions = state.sessions.filter((s) => s.id !== 's5');
      return { archived: true };
    });

    await workspaceState.archiveSession('s5');
    await flush();

    expect(apiMock.listSessions).toHaveBeenCalledWith({
      workspaceId: WS,
      pageSize: 5,
      beforeId: 's4',
      hasPrompt: true,
    });
    expect(workspacesStore().sessionsCursorByWorkspace[WS]).toBe('s6');
    expect(ids(state.sessions)).toEqual(['s1', 's2', 's3', 's4', 's6']);
  });
});

describe('useWorkspaceState — upsertWorkspacePreserveOrder hidden ids', () => {
  beforeEach(() => {
    installStorage(createMemoryStorage());
  });

  afterEach(() => {
    installStorage(createMemoryStorage());
  });

  it('clears a hidden entry when the same workspace id is re-added', () => {
    workspacesStore().hiddenWorkspaceIds = ['wd_x'];

    workspacesStore().upsertWorkspacePreserveOrder(workspace('wd_x', 'c:\\users\\foo\\proj', 'proj'));

    expect(workspacesStore().hiddenWorkspaceIds).toEqual([]);
    expect(workspacesStore().workspaces[0]?.root).toBe('c:\\users\\foo\\proj');
  });

  it('keeps hidden entries for different workspace ids, even with the same root', () => {
    workspacesStore().hiddenWorkspaceIds = ['wd_x'];

    workspacesStore().upsertWorkspacePreserveOrder(workspace('wm_y', 'c:\\users\\foo\\proj', 'proj'));

    expect(workspacesStore().hiddenWorkspaceIds).toEqual(['wd_x']);
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
    sessionsStore().setSessions([
      poolSession('a', T.newest),
      poolSession('b', T.middle),
      poolSession('c', T.oldest),
    ]);
    Object.defineProperty(state, 'sessions', {
      get: () => sessionsStore().sessions,
      set: (next: AppSession[]) => sessionsStore().setSessions(next),
    });
    const deps = createDeps();
    deps.upsertSessionSorted = (s: AppSession) => {
      sessionsStore().upsertSessionSorted(s);
    };
    deps.setActiveSessionId = (id: string | undefined) => {
      state.activeSessionId = id;
    };
    const ws = createWorkspaceRig(state, deps);
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

    expect(apiMock.forkSession).toHaveBeenCalledWith('b', { turnIndex: undefined });
    expect(state.sessions.map((s) => s.id)).toEqual(['a', 'b', 'forked', 'c']);
    expect(state.activeSessionId).toBe('forked');
  });
});

describe('kimi.files — searchFiles (fs:suggest with fs:search fallback)', () => {
  beforeEach(() => {
    apiMock.suggestFiles.mockReset();
    apiMock.searchFiles.mockReset();
  });

  function setupSearch() {
    workspacesStore().workspaces = [workspace('ws_1', '/workspace', 'ws_1')];
    sessionsStore().setSessions([createSession()]);
    sessionsStore().setActiveSessionId('sess_1');
  }

  it('prefers fs:suggest and preserves kind + matchPositions', async () => {
    apiMock.suggestFiles.mockResolvedValue({
      items: [{ path: 'src/app.ts', name: 'app.ts', kind: 'file', score: 0.9, matchPositions: [4, 5, 6] }],
      truncated: false,
    });
    setupSearch();

    const items = await filesStore().searchFiles('app');

    expect(apiMock.suggestFiles).toHaveBeenCalledWith('ws_1', { query: 'app', limit: 20 }, { signal: undefined });
    expect(apiMock.searchFiles).not.toHaveBeenCalled();
    expect(items).toEqual([{ path: 'src/app.ts', name: 'app.ts', kind: 'file', matchPositions: [4, 5, 6] }]);
  });

  it('forwards the abort signal to fs:suggest (and to the fs:search fallback)', async () => {
    apiMock.suggestFiles.mockResolvedValue({ items: [], truncated: false });
    setupSearch();
    const controller = new AbortController();

    await filesStore().searchFiles('app', { signal: controller.signal });

    expect(apiMock.suggestFiles).toHaveBeenCalledWith('ws_1', { query: 'app', limit: 20 }, { signal: controller.signal });
  });

  it('falls back to fs:search on a bare 404 and stops probing fs:suggest', async () => {
    apiMock.suggestFiles.mockRejectedValue(
      new DaemonApiError({ code: 404, msg: 'Not Found', requestId: 'r1' }),
    );
    apiMock.searchFiles.mockResolvedValue({
      items: [{ path: 'README.md', name: 'README.md', kind: 'file', score: 1, matchPositions: [0] }],
      truncated: false,
    });
    setupSearch();

    const first = await filesStore().searchFiles('read');
    const second = await filesStore().searchFiles('read');

    expect(first[0]?.path).toBe('README.md');
    expect(apiMock.searchFiles).toHaveBeenCalledTimes(2);
    expect(apiMock.suggestFiles).toHaveBeenCalledTimes(1);
    expect(second[0]?.matchPositions).toEqual([0]);
  });

  it('does not fall back on non-404 suggest errors (defensive [])', async () => {
    apiMock.suggestFiles.mockRejectedValue(
      new DaemonApiError({ code: 500, msg: 'boom', requestId: 'r2' }),
    );
    setupSearch();

    expect(await filesStore().searchFiles('x')).toEqual([]);
    expect(apiMock.searchFiles).not.toHaveBeenCalled();
    expect(await filesStore().searchFiles('x')).toEqual([]);
    expect(apiMock.suggestFiles).toHaveBeenCalledTimes(2);
  });

  it('returns [] when no workspace ref is active', async () => {
    expect(await filesStore().searchFiles('x')).toEqual([]);
    expect(apiMock.suggestFiles).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — grouped initial session load (view=by_workspace)', () => {
  const BASE = Date.parse('2026-02-01T00:00:00.000Z');

  function groupedSession(id: string, index: number, workspaceId: string, cwd: string): AppSession {
    const ts = new Date(BASE - index * 1000).toISOString();
    return {
      id,
      workspaceId,
      cwd,
      title: `title-${id}`,
      lastPrompt: `prompt-${id}`,
      createdAt: ts,
      updatedAt: ts,
      busy: false,
      archived: false,
      model: '',
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

  beforeEach(() => {
    apiMock.getAuth.mockReset().mockResolvedValue({
      modelsReady: true,
      providersCount: 1,
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
    apiMock.listSessionGroups.mockReset();
    apiMock.listWorkspaces.mockReset().mockResolvedValue([
      workspace('ws1', '/repo/ws1', 'ws1'),
      workspace('ws2', '/repo/ws2', 'ws2'),
      workspace('ws3', '/repo/ws3', 'ws3'),
    ]);
  });

  function registerListHooks(state: ExtendedState, deps: WorkspaceRigDeps): void {
    setSessionListHooks({
      pushOperationFailure: (...args) => pushFailureSpy(...args),
      onSessionsArchivedLocally: async (ids) => {
        for (const id of ids) deps.forgetSession(id);
        if (state.activeSessionId !== undefined && ids.includes(state.activeSessionId)) {
          const next = sessionsStore().sessions[0];
          deps.setActiveSessionId(next?.id);
        }
      },
    });
  }

  function createLoadDeps(state: ExtendedState): WorkspaceRigDeps {
    sessionsStore().setSessions(state.sessions);
    Object.defineProperty(state, 'sessions', {
      get: () => sessionsStore().sessions,
      set: (next: AppSession[]) => sessionsStore().setSessions(next),
    });
    Object.defineProperty(state, 'sessionsFullyLoaded', {
      get: () => sessionListStore().sessionsFullyLoaded,
      set: (next: boolean) => {
        sessionListStore().sessionsFullyLoaded = next;
      },
    });
    const deps = {
      ...createDeps(),
      modelProvider: { loadModels: vi.fn().mockResolvedValue(undefined) },
      updateSession: (id: string, update: (s: AppSession) => AppSession) => {
        state.sessions = state.sessions.map((s) => (s.id === id ? update(s) : s));
      },
      appendSession: (session: AppSession) => {
        state.sessions = [...state.sessions, session];
      },
    } as unknown as WorkspaceRigDeps;
    registerListHooks(state, deps);
    return deps;
  }

  it('loads every workspace in one grouped request, with totals driving hasMore', async () => {
    apiMock.listSessionGroups.mockResolvedValue({
      groups: [
        {
          workspaceId: 'ws1',
          sessions: [1, 2, 3, 4, 5].map((i) => groupedSession(`s${i}`, i, 'ws1', '/repo/ws1')),
          total: 7,
        },
        {
          workspaceId: 'ws2',
          sessions: [groupedSession('s6', 6, 'ws2', '/repo/ws2')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();

    expect(apiMock.listSessionGroups).toHaveBeenCalledTimes(1);
    expect(apiMock.listSessionGroups).toHaveBeenCalledWith({
      groupPageSize: 5,
      hasPrompt: true,
    }, { signal: expect.any(AbortSignal) });
    expect(apiMock.listSessions).not.toHaveBeenCalled();
    expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(workspacesStore().sessionsHasMoreByWorkspace).toEqual({ ws1: true, ws2: false, ws3: false });
    expect(workspacesStore().sessionsCursorByWorkspace).toEqual({
      ws1: 's5',
      ws2: 's6',
      ws3: undefined,
    });
    expect(workspacesStore().sessionsInitialCountByWorkspace).toEqual({ ws1: 5, ws2: 5, ws3: 5 });
  });

  it('matches a server-canonicalized alias group to the registered workspace by id', async () => {
    apiMock.listSessionGroups.mockResolvedValue({
      groups: [
        {
          workspaceId: 'ws1',
          sessions: [groupedSession('s1', 1, 'wd_legacy', '/Repo/ws1')],
          total: 3,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();

    expect(state.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(state.sessions[0]?.workspaceId).toBe('wd_legacy');
    expect(workspacesStore().sessionsHasMoreByWorkspace['ws1']).toBe(true);
    expect(workspacesStore().sessionsCursorByWorkspace['ws1']).toBe('s1');
    expect(workspacesStore().sessionsHasMoreByWorkspace['ws2']).toBe(false);
  });

  it('drains follow-up group pages with the opaque token', async () => {
    apiMock.listSessionGroups
      .mockResolvedValueOnce({
        groups: [
          {
            workspaceId: 'ws1',
            sessions: [groupedSession('s1', 1, 'ws1', '/repo/ws1')],
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
            workspaceId: 'ws2',
            sessions: [groupedSession('s2', 2, 'ws2', '/repo/ws2')],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 2,
      });
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();

    await vi.waitFor(() => expect(apiMock.listSessionGroups).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's2']));
    expect(apiMock.listSessionGroups).toHaveBeenNthCalledWith(2, {
      groupPageSize: 5,
      hasPrompt: true,
      pageToken: 'gtok1',
    }, { background: true, signal: expect.any(AbortSignal) });
  });

  it('keeps the previous list when the grouped request fails', async () => {
    apiMock.listSessionGroups.mockRejectedValue(new Error('network down'));
    const state = createState();
    const deps = createLoadDeps(state);
    registerListHooks(state, deps);
    const ws = createWorkspaceRig(state, deps);

    await ws.load();

    expect(apiMock.listSessions).not.toHaveBeenCalled();
    expect(state.sessions.map((s) => s.id)).toEqual(['sess_1']);
    expect(pushFailureSpy).toHaveBeenCalled();
  });

  it('drains group pages until the token exhausts (no page cap)', async () => {
    const workspaces = Array.from({ length: 11 }, (_, i) =>
      workspace(`ws${i + 1}`, `/repo/ws${i + 1}`, `ws${i + 1}`),
    );
    apiMock.listWorkspaces.mockResolvedValue(workspaces);
    for (let i = 0; i < 11; i += 1) {
      const last = i === 10;
      apiMock.listSessionGroups.mockResolvedValueOnce({
        groups: [
          {
            workspaceId: `ws${i + 1}`,
            sessions: [groupedSession(`s${i + 1}`, i + 1, `ws${i + 1}`, `/repo/ws${i + 1}`)],
            total: 1,
          },
        ],
        hasMore: !last,
        nextPageToken: last ? null : `gtok${i + 1}`,
        total: 11,
      });
    }
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();

    await vi.waitFor(() => expect(apiMock.listSessionGroups).toHaveBeenCalledTimes(11));
    await vi.waitFor(() => expect(state.sessions).toHaveLength(11));
    expect(workspacesStore().sessionsHasMoreByWorkspace['ws11']).toBe(false);
  });

  it('gates the first load on the first group page only, merging later pages in the background', async () => {
    let resolvePage2: ((page: unknown) => void) | undefined;
    apiMock.listSessionGroups
      .mockResolvedValueOnce({
        groups: [
          {
            workspaceId: 'ws1',
            sessions: [groupedSession('s1', 1, 'ws1', '/repo/ws1')],
            total: 1,
          },
        ],
        hasMore: true,
        nextPageToken: 'gtok1',
        total: 2,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePage2 = resolve;
          }),
      );
    const state = createState();
    const deps = createLoadDeps(state);
    const ws = createWorkspaceRig(state, deps);

    await ws.load();

    expect(ws.initialized.value).toBe(true);
    expect(apiMock.listSessionGroups).toHaveBeenCalledTimes(2);
    expect(state.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(workspacesStore().sessionsHasMoreByWorkspace).toEqual({ ws1: false, ws2: true, ws3: true });
    expect(workspacesStore().sessionsCursorByWorkspace).toEqual({
      ws1: 's1',
      ws2: undefined,
      ws3: undefined,
    });

    resolvePage2!({
      groups: [
        {
          workspaceId: 'ws2',
          sessions: [groupedSession('s2', 2, 'ws2', '/repo/ws2')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });
    await vi.waitFor(() => expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's2']));
    expect(workspacesStore().sessionsHasMoreByWorkspace).toEqual({ ws1: false, ws2: false, ws3: false });
    expect(workspacesStore().sessionsCursorByWorkspace).toEqual({
      ws1: 's1',
      ws2: 's2',
      ws3: undefined,
    });
  });

  it('keeps the first page when a background group page fails', async () => {
    apiMock.listSessionGroups
      .mockResolvedValueOnce({
        groups: [
          {
            workspaceId: 'ws1',
            sessions: [groupedSession('s1', 1, 'ws1', '/repo/ws1')],
            total: 1,
          },
        ],
        hasMore: true,
        nextPageToken: 'gtok1',
        total: 2,
      })
      .mockRejectedValueOnce(new Error('network down'));
    const state = createState();
    const deps = createLoadDeps(state);
    registerListHooks(state, deps);
    const ws = createWorkspaceRig(state, deps);

    await ws.load();
    await vi.waitFor(() => expect(pushFailureSpy).toHaveBeenCalled());

    expect(state.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(workspacesStore().sessionsHasMoreByWorkspace).toEqual({ ws1: false, ws2: true, ws3: true });
    expect(workspacesStore().sessionsCursorByWorkspace).toEqual({
      ws1: 's1',
      ws2: undefined,
      ws3: undefined,
    });
  });

  it('a superseded background drain never commits', async () => {
    let resolveStale: ((page: unknown) => void) | undefined;
    apiMock.listSessionGroups
      .mockResolvedValueOnce({
        groups: [
          {
            workspaceId: 'ws1',
            sessions: [groupedSession('s1', 1, 'ws1', '/repo/ws1')],
            total: 1,
          },
        ],
        hasMore: true,
        nextPageToken: 'gtok1',
        total: 2,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStale = resolve;
          }),
      )
      .mockResolvedValueOnce({
        groups: [
          {
            workspaceId: 'ws1',
            sessions: [groupedSession('s9', 9, 'ws1', '/repo/ws1')],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      });
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();
    await ws.load();
    expect(state.sessions.map((s) => s.id)).toEqual(['s9']);
    expect(workspacesStore().sessionsHasMoreByWorkspace).toEqual({ ws1: false, ws2: false, ws3: false });

    resolveStale!({
      groups: [
        {
          workspaceId: 'ws2',
          sessions: [groupedSession('s2', 2, 'ws2', '/repo/ws2')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(state.sessions.map((s) => s.id)).toEqual(['s9']);
    expect(workspacesStore().sessionsHasMoreByWorkspace).toEqual({ ws1: false, ws2: false, ws3: false });
  });

  it('keeps a full load that landed during the background drain', async () => {
    let resolvePage2: ((page: unknown) => void) | undefined;
    apiMock.listSessionGroups
      .mockResolvedValueOnce({
        groups: [
          {
            workspaceId: 'ws1',
            sessions: [groupedSession('s1', 1, 'ws1', '/repo/ws1')],
            total: 1,
          },
        ],
        hasMore: true,
        nextPageToken: 'gtok1',
        total: 2,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePage2 = resolve;
          }),
      );
    const fullList = ['s1', 's2', 's3'].map((id, i) => ({
      ...createSession(),
      id,
      busy: false,
      updatedAt: new Date(Date.parse('2026-01-10T00:00:00.000Z') - i * 1000).toISOString(),
    }));
    apiMock.listSessions.mockResolvedValue({ items: fullList, hasMore: false });
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();
    expect(state.sessions.map((s) => s.id)).toEqual(['s1']);
    await ws.loadAllSessions();
    expect(state.sessionsFullyLoaded).toBe(true);
    expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);

    resolvePage2!({
      groups: [
        {
          workspaceId: 'ws2',
          sessions: [groupedSession('s2', 2, 'ws2', '/repo/ws2')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });
    await vi.waitFor(() =>
      expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']),
    );
    expect(state.sessionsFullyLoaded).toBe(true);
    expect(workspacesStore().sessionsHasMoreByWorkspace).toEqual({ ws1: false, ws2: false, ws3: false });
  });

  it('keeps a pinned backfill that lands during the background drain', async () => {
    const store = new Map<string, string>([
      ['kimi-web.pinned-sessions', JSON.stringify(['pin_1'])],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    try {
      let resolvePage2: ((page: unknown) => void) | undefined;
      apiMock.listSessionGroups
        .mockResolvedValueOnce({
          groups: [
            {
              workspaceId: 'ws1',
              sessions: [groupedSession('s1', 1, 'ws1', '/repo/ws1')],
              total: 1,
            },
          ],
          hasMore: true,
          nextPageToken: 'gtok1',
          total: 2,
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePage2 = resolve;
            }),
        );
      apiMock.getSession.mockImplementation((id: string) =>
        id === 'pin_1'
          ? Promise.resolve({ ...createSession(), id, busy: false })
          : Promise.resolve(undefined),
      );
      const state = createState();
      const ws = createWorkspaceRig(state, createLoadDeps(state));

      await ws.load();
      expect(state.sessions.map((s) => s.id)).toContain('pin_1');

      resolvePage2!({
        groups: [
          {
            workspaceId: 'ws2',
            sessions: [groupedSession('s2', 2, 'ws2', '/repo/ws2')],
            total: 1,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 2,
      });
      await vi.waitFor(() => expect(state.sessions.map((s) => s.id)).toContain('s2'));
      expect(state.sessions.map((s) => s.id)).toContain('pin_1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a locally created session through the background drain', async () => {
    let resolvePage2: ((page: unknown) => void) | undefined;
    apiMock.listSessionGroups
      .mockResolvedValueOnce({
        groups: [
          {
            workspaceId: 'ws1',
            sessions: [groupedSession('s1', 1, 'ws1', '/repo/ws1')],
            total: 1,
          },
        ],
        hasMore: true,
        nextPageToken: 'gtok1',
        total: 2,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePage2 = resolve;
          }),
      );
    apiMock.addWorkspace.mockResolvedValue({
      id: 'ws1',
      root: '/repo/ws1',
      name: 'ws1',
      sessionCount: 1,
    });
    apiMock.createSession.mockResolvedValue({
      ...createSession(),
      id: 's_new',
      workspaceId: 'ws1',
      cwd: '/repo/ws1',
    });
    const state = createState();
    const deps = {
      ...createLoadDeps(state),
      modelProvider: {
        loadModels: vi.fn().mockResolvedValue(undefined),
        skillsBySession: ref({}),
        loadSkillsForSession: vi.fn(),
        activateSkill: vi.fn().mockResolvedValue(undefined),
      },
      upsertSessionSorted: (session: AppSession) => {
        state.sessions = insertSessionByRecency(state.sessions, session);
      },
    } as unknown as WorkspaceRigDeps;
    const ws = createWorkspaceRig(state, deps);

    await ws.load();
    expect(state.sessions.map((s) => s.id)).toEqual(['s1']);
    await ws.startSessionAndActivateSkill('ws1', 'skill-x');
    expect(state.sessions.map((s) => s.id)).toContain('s_new');

    resolvePage2!({
      groups: [
        {
          workspaceId: 'ws2',
          sessions: [groupedSession('s2', 2, 'ws2', '/repo/ws2')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });
    await vi.waitFor(() => expect(state.sessions.map((s) => s.id)).toContain('s2'));
    expect(state.sessions.map((s) => s.id)).toContain('s_new');
  });

  it('does not resurrect a session deleted while the drain was in flight', async () => {
    let resolvePage2: ((page: unknown) => void) | undefined;
    apiMock.listSessionGroups
      .mockResolvedValueOnce({
        groups: [
          {
            workspaceId: 'ws1',
            sessions: [groupedSession('s1', 1, 'ws1', '/repo/ws1')],
            total: 1,
          },
        ],
        hasMore: true,
        nextPageToken: 'gtok1',
        total: 2,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePage2 = resolve;
          }),
      );
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();
    ws.noteSessionDeleted('s2');

    resolvePage2!({
      groups: [
        {
          workspaceId: 'ws2',
          sessions: [groupedSession('s2', 2, 'ws2', '/repo/ws2')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(state.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('keeps event-fresh rows when the background drain commits a stale snapshot', async () => {
    let resolvePage2: ((page: unknown) => void) | undefined;
    apiMock.listSessionGroups
      .mockResolvedValueOnce({
        groups: [
          {
            workspaceId: 'ws1',
            sessions: [groupedSession('s1', 1, 'ws1', '/repo/ws1')],
            total: 1,
          },
        ],
        hasMore: true,
        nextPageToken: 'gtok1',
        total: 2,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePage2 = resolve;
          }),
      );
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();
    state.sessions = [{ ...state.sessions[0]!, busy: true, title: 'live-title' }];
    connectionStore().noteSessionEvent('s1');

    resolvePage2!({
      groups: [
        {
          workspaceId: 'ws2',
          sessions: [groupedSession('s2', 2, 'ws2', '/repo/ws2')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const row = state.sessions.find((s) => s.id === 's1')!;
    expect(row.busy).toBe(true);
    expect(row.title).toBe('live-title');
    expect(state.sessions.map((s) => s.id)).toContain('s2');
  });

  it('preserves a session created during the drain via notePoolInsert', async () => {
    let resolvePage2: ((page: unknown) => void) | undefined;
    apiMock.listSessionGroups
      .mockResolvedValueOnce({
        groups: [
          {
            workspaceId: 'ws1',
            sessions: [groupedSession('s1', 1, 'ws1', '/repo/ws1')],
            total: 1,
          },
        ],
        hasMore: true,
        nextPageToken: 'gtok1',
        total: 2,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePage2 = resolve;
          }),
      );
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();
    const created = { ...createSession(), id: 's_evt', busy: false };
    state.sessions = [created, ...state.sessions];
    ws.notePoolInsert('s_evt');

    resolvePage2!({
      groups: [
        {
          workspaceId: 'ws2',
          sessions: [groupedSession('s2', 2, 'ws2', '/repo/ws2')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });
    await vi.waitFor(() => expect(state.sessions.map((s) => s.id)).toContain('s2'));
    expect(state.sessions.map((s) => s.id)).toContain('s_evt');
  });

  it('expands a pending workspace by paging from the top (no cursor yet)', async () => {
    const first = { ...createSession(), id: 'sess_a', workspaceId: 'ws1' };
    apiMock.listSessions.mockResolvedValue({ items: [first], hasMore: true });
    const state = createState();
    workspacesStore().sessionsHasMoreByWorkspace = { ws1: true };
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.loadMoreSessions('ws1');

    expect(apiMock.listSessions).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      pageSize: expect.any(Number),
      beforeId: undefined,
      hasPrompt: true,
    });
    expect(state.sessions.map((s) => s.id)).toEqual(['sess_1', 'sess_a']);
    expect(workspacesStore().sessionsCursorByWorkspace['ws1']).toBe('sess_a');
    expect(workspacesStore().sessionsHasMoreByWorkspace['ws1']).toBe(true);
  });

  it('fires the first group page concurrently with the workspace registry', async () => {
    let resolveWorkspaces: ((items: unknown) => void) | undefined;
    apiMock.listWorkspaces.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWorkspaces = resolve;
        }),
    );
    apiMock.listSessionGroups.mockResolvedValue({
      groups: [
        {
          workspaceId: 'ws1',
          sessions: [groupedSession('s1', 1, 'ws1', '/repo/ws1')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    const pending = ws.load();
    await vi.waitFor(() => expect(apiMock.listSessionGroups).toHaveBeenCalledTimes(1));
    resolveWorkspaces!([workspace('ws1', '/repo/ws1', 'ws1')]);
    await pending;

    expect(state.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(workspacesStore().sessionsHasMoreByWorkspace).toEqual({ ws1: false });
    expect(workspacesStore().sessionsCursorByWorkspace).toEqual({ ws1: 's1' });
  });

  it('rehydrates live rows from the v1 read (restores mainTurnActive)', async () => {
    apiMock.listSessionGroups.mockResolvedValue({
      groups: [
        {
          workspaceId: 'ws1',
          sessions: [
            { ...groupedSession('s_run', 1, 'ws1', '/repo/ws1'), busy: true },
            groupedSession('s_idle', 2, 'ws1', '/repo/ws1'),
          ],
          total: 2,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    apiMock.getSession.mockReset().mockResolvedValue({
      ...createSession(),
      id: 's_run',
      title: 'Stale snapshot title',
      busy: true,
      mainTurnActive: true,
    });
    const state = createState();
    state.activeSessionId = 's_run';
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();

    expect(apiMock.getSession).toHaveBeenCalledTimes(1);
    expect(apiMock.getSession).toHaveBeenCalledWith('s_run', {
      background: false,
      signal: expect.any(AbortSignal),
    });
    const run = state.sessions.find((s) => s.id === 's_run');
    expect(run?.mainTurnActive).toBe(true);
    expect(run?.title).toBe('title-s_run');
    expect(state.sessions.find((s) => s.id === 's_idle')?.mainTurnActive).toBeUndefined();
  });

  it('adopts a cleared activity state when the turn ended before the hydration read', async () => {
    apiMock.listSessionGroups.mockResolvedValue({
      groups: [
        {
          workspaceId: 'ws1',
          sessions: [
            { ...groupedSession('s_run', 1, 'ws1', '/repo/ws1'), busy: true },
          ],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    apiMock.getSession.mockReset().mockResolvedValue({
      ...createSession(),
      id: 's_run',
      busy: false,
      mainTurnActive: false,
    });
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();

    const run = state.sessions.find((s) => s.id === 's_run');
    expect(run?.busy).toBe(false);
    expect(run?.mainTurnActive).toBe(false);
  });

  it('skips the hydration merge when a live event lands during the read', async () => {
    apiMock.listSessionGroups.mockResolvedValue({
      groups: [
        {
          workspaceId: 'ws1',
          sessions: [
            { ...groupedSession('s_run', 1, 'ws1', '/repo/ws1'), busy: true },
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
    state.activeSessionId = 's_run';
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    const pending = ws.load();
    await vi.waitFor(() => expect(apiMock.getSession).toHaveBeenCalled());
    connectionStore().noteSessionEvent('s_run');
    resolveGet!({ ...createSession(), id: 's_run', busy: false, mainTurnActive: false });
    await pending;

    const run = state.sessions.find((s) => s.id === 's_run');
    expect(run?.busy).toBe(true);
  });

  it('keeps the live model when a v2 row replaces a pooled session', async () => {
    apiMock.listSessionGroups.mockResolvedValue({
      groups: [
        {
          workspaceId: 'ws1',
          sessions: [groupedSession('sess_1', 1, 'ws1', '/repo/ws1')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();

    expect(state.sessions.find((s) => s.id === 'sess_1')?.model).toBe('kimi-code');
  });

  it('backfills the active session into the swapped pool when it falls outside the first pages', async () => {
    apiMock.listSessionGroups.mockResolvedValue({
      groups: [
        {
          workspaceId: 'ws1',
          sessions: [1, 2, 3, 4, 5].map((i) => groupedSession(`s${i}`, i, 'ws1', '/repo/ws1')),
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
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();

    expect(apiMock.getSession).toHaveBeenCalledWith('sess_1', { signal: expect.any(AbortSignal) });
    expect(state.sessions.map((s) => s.id)).toContain('sess_1');
  });

  it('clears the active id when the backfill confirms the session was deleted', async () => {
    apiMock.listSessionGroups.mockResolvedValue({
      groups: [
        {
          workspaceId: 'ws1',
          sessions: [groupedSession('s1', 1, 'ws1', '/repo/ws1')],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    apiMock.getSession.mockReset().mockRejectedValue(
      new DaemonApiError({ code: 40401, msg: 'session does not exist', requestId: 'r' }),
    );
    const state = createState();
    state.activeSessionId = 'sess_gone';
    const deps = createLoadDeps(state);
    const ws = createWorkspaceRig(state, deps);

    await ws.load();

    expect(deps.setActiveSessionId).toHaveBeenCalledWith(undefined);
  });

  it('filters archive tombstones out of grouped rows and cursors', async () => {
    apiMock.listSessionGroups.mockResolvedValue({
      groups: [
        {
          workspaceId: 'ws1',
          sessions: [
            groupedSession('s1', 1, 'ws1', '/repo/ws1'),
            groupedSession('s2', 2, 'ws1', '/repo/ws1'),
            groupedSession('s3', 3, 'ws1', '/repo/ws1'),
          ],
          total: 4,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.applyRemoteSessionArchived('s3');
    await ws.load();

    expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(workspacesStore().sessionsCursorByWorkspace['ws1']).toBe('s2');
    expect(workspacesStore().sessionsHasMoreByWorkspace['ws1']).toBe(true);
  });

  it('falls back to the matched workspace root when a v2 row has no cwd', async () => {
    apiMock.listSessionGroups.mockResolvedValue({
      groups: [
        {
          workspaceId: 'ws1',
          sessions: [
            { ...groupedSession('s1', 1, 'ws1', ''), cwd: '' },
          ],
          total: 1,
        },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    const state = createState();
    const ws = createWorkspaceRig(state, createLoadDeps(state));

    await ws.load();

    expect(state.sessions.find((s) => s.id === 's1')?.cwd).toBe('/repo/ws1');
  });
});

describe('useWorkspaceState — tower/swarm mutual exclusion', () => {
  it('enabling swarm disables tower for the active session', async () => {
    const state = createState();
    state.towerModeBySession = { sess_1: true };
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    ws.setSwarmMode(true);

    await vi.waitFor(() => expect(state.swarmModeBySession['sess_1']).toBe(true));
    expect(state.towerModeBySession['sess_1']).toBe(false);
    expect(deps.persistSessionProfile).toHaveBeenCalledWith(expect.objectContaining({ swarmMode: true }));
    expect(deps.persistSessionProfile).toHaveBeenCalledWith(expect.objectContaining({ towerMode: false }));
  });

  it('enabling tower disables swarm for the active session', async () => {
    const state = createState();
    state.swarmModeBySession = { sess_1: true };
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    void ws.setTowerMode(true);

    await vi.waitFor(() => expect(state.towerModeBySession['sess_1']).toBe(true));
    expect(state.swarmModeBySession['sess_1']).toBe(false);
    expect(deps.persistSessionProfile).toHaveBeenCalledWith(expect.objectContaining({ towerMode: true }), 'sess_1');
    expect(deps.persistSessionProfile).toHaveBeenCalledWith(expect.objectContaining({ swarmMode: false }), 'sess_1');
  });

  it('enabling tower sends the disarm fields even when the local mirror shows them off', async () => {
    const state = createState();
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    void ws.setTowerMode(true);

    await vi.waitFor(() => expect(state.towerModeBySession['sess_1']).toBe(true));
    expect(deps.persistSessionProfile).toHaveBeenCalledWith({ towerMode: true, swarmMode: false, planMode: false }, 'sess_1');
  });

  it('enabling swarm sends towerMode:false even when the local mirror shows tower off', async () => {
    const state = createState();
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    ws.setSwarmMode(true);

    await vi.waitFor(() => expect(state.swarmModeBySession['sess_1']).toBe(true));
    expect(deps.persistSessionProfile).toHaveBeenCalledWith({ swarmMode: true, towerMode: false });
  });

  it('a send right after enabling swarm waits for the mutual-exclusion write to land', async () => {
    let resolveProfile!: (value: boolean) => void;
    const profileGate = new Promise<boolean>((resolve) => { resolveProfile = resolve; });
    const deps = {
      ...createDeps(),
      activity: computed(() => 'idle' as const),
      modelProvider: {
        models: ref([]),
        resolveThinkingForPrompt: () => undefined,
      } as unknown as WorkspaceRigDeps['modelProvider'],
      persistSessionProfile: vi.fn().mockReturnValue(profileGate),
      whenSessionProfileSettled: vi.fn(async () => { await profileGate; return true; }),
    };
    setModeHooks({ persistSessionProfile: deps.persistSessionProfile });
    apiMock.submitPrompt.mockReset();
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'p1', userMessageId: 'm1' });
    const state = createState();
    state.towerModeBySession = { sess_1: true };
    const ws = createWorkspaceRig(state, deps);

    ws.setSwarmMode(true);
    const send = ws.sendPrompt(ws.createPromptEnvelope({ text: 'run in swarm' }));

    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();

    resolveProfile(true);
    await send;
    expect(deps.persistSessionProfile).toHaveBeenCalledWith({ swarmMode: true, towerMode: false });
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(deps.persistSessionProfile.mock.invocationCallOrder[0]!).toBeLessThan(
      apiMock.submitPrompt.mock.invocationCallOrder[0]!,
    );
  });

  it('mutual exclusion applies to draft modes when there is no active session', () => {
    const state = createState();
    state.activeSessionId = null;
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    void ws.setTowerMode(true);
    expect(modeStore().draftModes.towerMode).toBe(true);
    expect(modeStore().draftModes.swarmMode).toBe(false);

    ws.setSwarmMode(true);
    expect(modeStore().draftModes.swarmMode).toBe(true);
    expect(modeStore().draftModes.towerMode).toBe(false);
  });

  it('a failed mode write rejects the send instead of running it in the old mode', async () => {
    const state = createState();
    state.towerModeBySession = { sess_1: true };
    const deps = {
      ...createDeps(),
      activity: computed(() => 'idle' as const),
      modelProvider: {
        models: ref([]),
        resolveThinkingForPrompt: () => undefined,
      } as unknown as WorkspaceRigDeps['modelProvider'],
      whenSessionProfileSettled: vi.fn(async () => false),
    };
    apiMock.submitPrompt.mockReset();
    const ws = createWorkspaceRig(state, deps);

    ws.setSwarmMode(true);
    const outcome = await ws.sendPrompt(ws.createPromptEnvelope({ text: 'run in swarm' }));

    expect(outcome).toBe('rejected');
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(promptStore().optimisticMessagesBySession['sess_1'] ?? []).toHaveLength(0);
    expect(promptStore().inFlightBySession['sess_1']).toBe(false);
  });
});

describe('useWorkspaceState — tower/plan mutual exclusion', () => {
  it('enabling tower disarms an armed plan intent in the same profile write', async () => {
    const state = createState();
    state.planArmedBySession = { sess_1: true };
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    void ws.setTowerMode(true);

    await vi.waitFor(() => expect(state.towerModeBySession['sess_1']).toBe(true));
    expect(state.planArmedBySession['sess_1']).toBe(false);
    expect(deps.persistSessionProfile).toHaveBeenCalledTimes(1);
    expect(deps.persistSessionProfile).toHaveBeenCalledWith({ towerMode: true, swarmMode: false, planMode: false }, 'sess_1');
  });

  it('enabling tower disables a live daemon-side plan mode', async () => {
    const state = createState();
    state.planModeBySession = { sess_1: true };
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    void ws.setTowerMode(true);

    await vi.waitFor(() => expect(state.towerModeBySession['sess_1']).toBe(true));
    expect(state.planModeBySession['sess_1']).toBe(false);
    expect(deps.persistSessionProfile).toHaveBeenCalledTimes(1);
    expect(deps.persistSessionProfile).toHaveBeenCalledWith({ towerMode: true, swarmMode: false, planMode: false }, 'sess_1');
  });

  it('enabling tower with a base forwards towerBase on the same profile write', async () => {
    const state = createState();
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    void ws.setTowerMode(true, 'add-new-feature');

    await vi.waitFor(() => expect(state.towerModeBySession['sess_1']).toBe(true));
    expect(deps.persistSessionProfile).toHaveBeenCalledWith({ towerMode: true, towerBase: 'add-new-feature', swarmMode: false, planMode: false }, 'sess_1');
  });

  it('a draft tower base is recorded with the draft mode and cleared on disable', () => {
    const state = createState();
    state.activeSessionId = null;
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    void ws.setTowerMode(true, 'add-new-feature');
    expect(modeStore().draftModes.towerMode).toBe(true);
    expect(modeStore().draftModes.towerBase).toBe('add-new-feature');

    void ws.setTowerMode(false);
    expect(modeStore().draftModes.towerMode).toBe(false);
    expect(modeStore().draftModes.towerBase).toBeUndefined();
  });

  it('arming plan disables tower through the real shielded write, unconditionally', async () => {
    const state = createState();
    state.towerModeBySession = { sess_1: true };
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    ws.setPlanMode(true);

    expect(state.planArmedBySession['sess_1']).toBe(true);
    expect(state.towerModeBySession['sess_1']).toBe(false);
    expect(deps.persistSessionProfile).toHaveBeenCalledWith({ towerMode: false }, 'sess_1');
  });

  it('arming plan persists the tower disarm even when the local mirror shows tower off', async () => {
    const state = createState();
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    ws.setPlanMode(true);

    expect(deps.persistSessionProfile).toHaveBeenCalledWith({ towerMode: false }, 'sess_1');
    expect(state.towerModeBySession['sess_1']).toBe(false);
  });

  it('mutual exclusion applies to draft modes when there is no active session', () => {
    const state = createState();
    state.activeSessionId = null;
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    void ws.setTowerMode(true);
    expect(modeStore().draftModes.towerMode).toBe(true);

    ws.setPlanMode(true);
    expect(modeStore().draftModes.planMode).toBe(true);
    expect(modeStore().draftModes.towerMode).toBe(false);

    void ws.setTowerMode(true);
    expect(modeStore().draftModes.towerMode).toBe(true);
    expect(modeStore().draftModes.planMode).toBe(false);
  });

  it('swarm and plan stay compatible — arming plan keeps swarm on', () => {
    const state = createState();
    state.swarmModeBySession = { sess_1: true };
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    ws.setPlanMode(true);

    expect(state.planArmedBySession['sess_1']).toBe(true);
    expect(state.swarmModeBySession['sess_1']).toBe(true);
  });
});

describe('useWorkspaceState — queued prompt keeps the editable draft (editText)', () => {
  it('stores the daemon-bound wire text AND the pre-rewrite draft separately', async () => {
    const state = createState();
    const ws = createWorkspaceRig(state, createDeps());
    const wire = '> 引用';
    const draft = '[引用](kimi-code-composer://quote/%E5%BC%95%E7%94%A8) ';

    await ws.sendPrompt(ws.createPromptEnvelope({ text: wire }), draft);

    const entry = promptStore().queuedBySession['sess_1']?.[0];
    expect(entry?.text).toBe(wire);
    expect(entry?.editText).toBe(draft);
  });
});

describe('useWorkspaceState — setPermission owns the pick per session', () => {
  it('writes the session entry, updates the new-session default, and patches the profile', () => {
    const state = createState();
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    ws.setPermission('yolo');

    expect(permissionsStore().explicit['sess_1']).toBe('yolo');
    expect(permissionsStore().sticky).toBe('yolo');
    expect(deps.persistSessionProfile).toHaveBeenCalledWith({ permissionMode: 'yolo' });
  });

  it('a pick in the draft touches no session and awaits materialization', () => {
    const state = createState();
    state.activeSessionId = undefined;
    const deps = createDeps();
    const ws = createWorkspaceRig(state, deps);

    ws.setPermission('auto');

    expect(permissionsStore().draftPick).toBe('auto');
    expect(permissionsStore().sticky).toBe('auto');
    expect(permissionsStore().explicit).toEqual({});
    expect(permissionsStore().modes).toEqual({});
    expect(deps.persistSessionProfile).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — tower mode steers sends into the live turn', () => {
  beforeEach(() => {
    apiMock.submitPrompt.mockReset();
    apiMock.submitPrompt.mockImplementation(echoPromptSubmit('queued'));
    apiMock.steerPrompts.mockReset();
    apiMock.steerPrompts.mockResolvedValue({});
    promptStore().forgetLocalTurnState('sess_1');
  });

  function towerPromptDeps(): WorkspaceRigDeps {
    return {
      ...createDeps(),
      modelProvider: {
        models: ref([]),
        resolveThinkingForPrompt: () => undefined,
      } as unknown as WorkspaceRigDeps['modelProvider'],
    };
  }

  it('steers a normal send instead of queueing when tower mode is on and the session is busy', async () => {
    const state = createState();
    state.towerModeBySession = { sess_1: true };
    promptStore().inFlightBySession = { sess_1: true };
    const ws = createWorkspaceRig(state, towerPromptDeps());

    const outcome = await ws.sendPrompt(ws.createPromptEnvelope({ text: 'hello tower' }));

    expect(outcome).toBe('ok');
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ content: [{ type: 'text', text: 'hello tower' }] }),
    );
    expect(apiMock.steerPrompts).toHaveBeenCalledWith('sess_1', [sentPromptId()]);
    expect(promptStore().queuedBySession.sess_1 ?? []).toHaveLength(0);
  });

  it('keeps queueing a busy-session send when tower mode is off', async () => {
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    const ws = createWorkspaceRig(state, towerPromptDeps());

    const outcome = await ws.sendPrompt(ws.createPromptEnvelope({ text: 'plain' }));

    expect(outcome).toBe('queued');
    expect(apiMock.steerPrompts).not.toHaveBeenCalled();
    expect(promptStore().queuedBySession.sess_1).toHaveLength(1);
  });

  it('a busy-session send right after enabling tower waits for the write before steering', async () => {
    let resolveSettle!: (value: boolean) => void;
    const settleGate = new Promise<boolean>((resolve) => { resolveSettle = resolve; });
    const deps = {
      ...towerPromptDeps(),
      whenSessionProfileSettled: vi.fn(async () => settleGate),
    };
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    const ws = createWorkspaceRig(state, deps);

    void ws.setTowerMode(true);
    sessionRuntimeStore().profileWriteChainBySid.set('sess_1', settleGate);
    const send = ws.sendPrompt(ws.createPromptEnvelope({ text: 'into the fleet' }));

    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(apiMock.steerPrompts).not.toHaveBeenCalled();

    resolveSettle(true);
    const outcome = await send;
    expect(outcome).toBe('ok');
    expect(apiMock.steerPrompts).toHaveBeenCalledWith('sess_1', [sentPromptId()]);
  });

  it('rejects the send when the tower enable write fails before a steer', async () => {
    const deps = {
      ...towerPromptDeps(),
      whenSessionProfileSettled: vi.fn(async () => false),
    };
    const state = createState();
    promptStore().inFlightBySession = { sess_1: true };
    const ws = createWorkspaceRig(state, deps);

    void ws.setTowerMode(true);
    sessionRuntimeStore().profileWriteChainBySid.set('sess_1', Promise.resolve(false));
    const outcome = await ws.sendPrompt(ws.createPromptEnvelope({ text: 'into the fleet' }));

    expect(outcome).toBe('rejected');
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(apiMock.steerPrompts).not.toHaveBeenCalled();
  });

  it('rejects instead of steering into another session when the user switches mid-settle', async () => {
    let resolveSettle!: (value: boolean) => void;
    const settleGate = new Promise<boolean>((resolve) => { resolveSettle = resolve; });
    const deps = {
      ...towerPromptDeps(),
      whenSessionProfileSettled: vi.fn(async () => settleGate),
    };
    const state = createState();
    state.sessions = [createSession(), { ...createSession(), id: 'sess_2' }];
    promptStore().inFlightBySession = { sess_1: true };
    const ws = createWorkspaceRig(state, deps);

    void ws.setTowerMode(true);
    sessionRuntimeStore().profileWriteChainBySid.set('sess_1', settleGate);
    const send = ws.sendPrompt(ws.createPromptEnvelope({ text: 'into the fleet' }));
    state.activeSessionId = 'sess_2';

    resolveSettle(true);
    const outcome = await send;
    expect(outcome).toBe('rejected');
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(apiMock.steerPrompts).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — draft tower mode persists on session creation', () => {
  const newSession = { ...createSession(), id: 'sess_new', workspaceId: 'wd_1', cwd: '/abs/path' };

  beforeEach(() => {
    apiMock.createSession.mockReset();
    apiMock.createSession.mockResolvedValue(newSession);
    apiMock.submitPrompt.mockReset();
    apiMock.submitPrompt.mockImplementation(echoPromptSubmit());
  });

  it('writes tower mode to the new session profile so a stale agent frame cannot wipe it', async () => {
    const persistSessionProfile = vi.fn().mockResolvedValue(true);
    const state = createState();
    workspacesStore().workspaces = [workspace('wd_1', '/abs/path', 'A')];
    const deps: WorkspaceRigDeps = {
      ...createDeps(),
      modelProvider: {
        draftModel: ref(null),
        skillsBySession: ref({}),
        loadSkillsForSession: vi.fn(),
        activateSkill: vi.fn(),
        resolveThinkingForPrompt: () => undefined,
      } as unknown as WorkspaceRigDeps['modelProvider'],
      upsertSessionSorted: vi.fn((s) => {
        state.sessions = [s, ...state.sessions.filter((x) => x.id !== s.id)];
      }),
      persistSessionProfile,
    };
    modeStore().draftModes.towerMode = true;
    const ws = createWorkspaceRig(state, deps);

    const sid = await ws.startSessionAndSendPrompt('wd_1', ws.createPromptEnvelope({ text: 'hello' }));

    expect(sid).toEqual({ sessionId: 'sess_new', promptRejected: false });
    expect(persistSessionProfile).toHaveBeenCalledWith({ towerMode: true }, 'sess_new');
    expect(persistSessionProfile.mock.invocationCallOrder[0]).toBeLessThan(
      apiMock.submitPrompt.mock.invocationCallOrder[0]!,
    );
    expect(state.towerModeBySession['sess_new']).toBe(true);
    expect(state.pendingTowerBySession['sess_new']).toBeDefined();
    expect(modeStore().draftModes.towerMode).toBe(false);
  });

  it('sendTowerPrompt from the empty composer creates the session instead of dropping the command', async () => {
    const state = createState();
    state.activeSessionId = null;
    workspacesStore().workspaces = [workspace('wd_1', '/abs/path', 'A')];
    const deps: WorkspaceRigDeps = {
      ...createDeps(),
      modelProvider: {
        draftModel: ref(null),
        skillsBySession: ref({}),
        loadSkillsForSession: vi.fn(),
        activateSkill: vi.fn(),
        resolveThinkingForPrompt: () => undefined,
      } as unknown as WorkspaceRigDeps['modelProvider'],
      upsertSessionSorted: vi.fn((s) => {
        state.sessions = [s, ...state.sessions.filter((x) => x.id !== s.id)];
      }),
    };
    const ws = createWorkspaceRig(state, deps);

    await ws.sendTowerPrompt('tower status please');

    expect(apiMock.createSession).toHaveBeenCalledOnce();
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_new',
      expect.objectContaining({ content: [{ type: 'text', text: 'tower status please' }] }),
    );
  });
});

describe('setNotifyUserEnabled', () => {
  beforeEach(() => {
    apiMock.setConfig.mockReset();
    apiMock.getMeta.mockReset();
    configStore().resetConfig();
  });

  it('does not update notify_user flag when the config write fails', async () => {
    apiMock.setConfig.mockRejectedValueOnce(new Error('write conflict'));
    expect(await configStore().setNotifyUserEnabled(true)).toBe(false);
    expect(configStore().experimentalFlags['notify_user']).toBeUndefined();
  });

  it('updates notify_user flag only after a successful write', async () => {
    apiMock.setConfig.mockResolvedValue({ providers: {}, defaultModel: 'model-new' });
    apiMock.getMeta.mockResolvedValue(null);
    expect(await configStore().setNotifyUserEnabled(true)).toBe(true);
    expect(configStore().experimentalFlags['notify_user']).toBe(true);
  });

  it('keeps restart-timed tower inactive in experimentalFlags until server restart while updating beta master non-destructively', async () => {
    const { useContextInspector } = await import('@moonshot-ai/app-core');
    useContextInspector().setContextInspectorEnabled(false);

    apiMock.getMeta.mockResolvedValueOnce({
      serverVersion: '1.0.0',
      openInApps: [],
      dangerousBypassAuth: false,
      experimentalFlags: { notify_user: false, tower: true },
      experimentalBeta: {
        enabled: false,
        source: 'default',
        env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
      },
      experimentalFeatures: [
        {
          id: 'notify_user',
          title: 'NotifyUser tool',
          description: 'Progress updates',
          env: 'KIMI_CODE_EXPERIMENTAL_NOTIFY_USER',
          stage: 'beta',
          effectTiming: 'next-session',
          enabled: false,
          active: false,
          source: 'config',
          configValue: false,
        },
        {
          id: 'tower',
          title: 'Tower mode',
          description: 'Multi-agent mode',
          env: 'KIMI_CODE_EXPERIMENTAL_TOWER',
          stage: 'experimental',
          effectTiming: 'restart',
          enabled: true,
          active: false,
          source: 'config',
          configValue: true,
        },
      ],
      backend: 'v2',
      webTitle: '',
      homeDir: '/tmp/home',
    });

    await configStore().refreshServerMeta();
    expect(configStore().experimentalFlags['tower']).toBe(false);
    expect(useContextInspector().contextInspectorEnabled.value).toBe(false);

    apiMock.setConfig.mockResolvedValue({ providers: {} });
    apiMock.getMeta.mockResolvedValue(null);

    expect(await configStore().setBetaFeaturesEnabled(true)).toBe(true);
    expect(apiMock.setConfig).toHaveBeenCalledWith({ experimental: { beta: true } });
    expect(useContextInspector().contextInspectorEnabled.value).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.contextInspector)).toBeNull();
    expect(configStore().experimentalFlags['notify_user']).toBe(true);
    expect(configStore().experimentalFlags['tower']).toBe(false);

    expect(await configStore().setBetaFeaturesEnabled(false)).toBe(true);
    expect(useContextInspector().contextInspectorEnabled.value).toBe(false);
    expect(configStore().experimentalFlags['notify_user']).toBe(false);
  });

  it('migrates legacy localStorage context_inspector and session_mentions into config.toml once without overriding existing configValue', async () => {
    const { useContextInspector, useSessionMentions } = await import('@moonshot-ai/app-core');
    localStorage.setItem(STORAGE_KEYS.contextInspector, 'true');
    localStorage.setItem(STORAGE_KEYS.sessionMentions, '1');
    configStore().resetConfig();

    expect(useContextInspector().contextInspectorEnabled.value).toBe(true);
    expect(useSessionMentions().sessionMentions.value).toBe(true);

    apiMock.getMeta.mockRejectedValueOnce(new Error('transient offline'));
    await configStore().refreshServerMeta();
    expect(useContextInspector().contextInspectorEnabled.value).toBe(true);
    expect(useSessionMentions().sessionMentions.value).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.contextInspector)).toBe('true');
    expect(localStorage.getItem(STORAGE_KEYS.sessionMentions)).toBe('1');

    apiMock.getMeta.mockResolvedValueOnce({
      serverVersion: '1.0.0',
      openInApps: [],
      dangerousBypassAuth: false,
      experimentalFlags: {},
      backend: 'v2',
      webTitle: '',
      homeDir: '/tmp/home',
    });
    await configStore().refreshServerMeta();
    expect(useContextInspector().contextInspectorEnabled.value).toBe(true);
    expect(useSessionMentions().sessionMentions.value).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.contextInspector)).toBe('true');
    expect(localStorage.getItem(STORAGE_KEYS.sessionMentions)).toBe('1');

    apiMock.setConfig.mockResolvedValue({ providers: {} });
    apiMock.getMeta
      .mockResolvedValueOnce({
        serverVersion: '1.0.0',
        openInApps: [],
        dangerousBypassAuth: false,
        experimentalFlags: { context_inspector: false, session_mentions: false },
        experimentalBeta: {
          enabled: false,
          source: 'default',
          env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
        },
        experimentalFeatures: [
          {
            id: 'context_inspector',
            title: 'Context usage',
            description: 'Context inspector',
            env: 'KIMI_CODE_EXPERIMENTAL_CONTEXT_INSPECTOR',
            stage: 'beta',
            effectTiming: 'immediate',
            enabled: false,
            active: false,
            source: 'default',
          },
          {
            id: 'session_mentions',
            title: 'Session mentions',
            description: 'Reference sessions',
            env: 'KIMI_CODE_EXPERIMENTAL_SESSION_MENTIONS',
            stage: 'experimental',
            effectTiming: 'immediate',
            enabled: false,
            active: false,
            source: 'default',
          },
        ],
        backend: 'v2',
        webTitle: '',
        homeDir: '/tmp/home',
      })
      .mockResolvedValueOnce({
        serverVersion: '1.0.0',
        openInApps: [],
        dangerousBypassAuth: false,
        experimentalFlags: { context_inspector: true, session_mentions: true },
        experimentalBeta: {
          enabled: false,
          source: 'default',
          env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
        },
        experimentalFeatures: [
          {
            id: 'context_inspector',
            title: 'Context usage',
            description: 'Context inspector',
            env: 'KIMI_CODE_EXPERIMENTAL_CONTEXT_INSPECTOR',
            stage: 'beta',
            effectTiming: 'immediate',
            enabled: true,
            active: true,
            source: 'config',
            configValue: true,
          },
          {
            id: 'session_mentions',
            title: 'Session mentions',
            description: 'Reference sessions',
            env: 'KIMI_CODE_EXPERIMENTAL_SESSION_MENTIONS',
            stage: 'experimental',
            effectTiming: 'immediate',
            enabled: true,
            active: true,
            source: 'config',
            configValue: true,
          },
        ],
        backend: 'v2',
        webTitle: '',
        homeDir: '/tmp/home',
      });

    await configStore().refreshServerMeta();
    expect(apiMock.setConfig).toHaveBeenCalledWith({
      experimental: {
        context_inspector: true,
        session_mentions: true,
      },
    });
    expect(localStorage.getItem(STORAGE_KEYS.contextInspector)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.sessionMentions)).toBeNull();
    expect(useContextInspector().contextInspectorEnabled.value).toBe(true);
    expect(useSessionMentions().sessionMentions.value).toBe(true);

    apiMock.setConfig.mockClear();
    localStorage.setItem(STORAGE_KEYS.contextInspector, 'true');
    apiMock.getMeta.mockResolvedValueOnce({
      serverVersion: '1.0.0',
      openInApps: [],
      dangerousBypassAuth: false,
      experimentalFlags: { context_inspector: false },
      experimentalBeta: {
        enabled: false,
        source: 'default',
        env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
      },
      experimentalFeatures: [
        {
          id: 'context_inspector',
          title: 'Context usage',
          description: 'Context inspector',
          env: 'KIMI_CODE_EXPERIMENTAL_CONTEXT_INSPECTOR',
          stage: 'beta',
          effectTiming: 'immediate',
          enabled: false,
          active: false,
          source: 'config',
          configValue: false,
        },
      ],
      backend: 'v2',
      webTitle: '',
      homeDir: '/tmp/home',
    });

    await configStore().refreshServerMeta();
    expect(apiMock.setConfig).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.contextInspector)).toBeNull();
    expect(useContextInspector().contextInspectorEnabled.value).toBe(false);
  });

  it('ignores stale out-of-order refreshServerMeta responses across rapid Lab toggles', async () => {
    const { useContextInspector } = await import('@moonshot-ai/app-core');
    useContextInspector().setContextInspectorEnabled(false);
    configStore().experimentalBeta = {
      enabled: false,
      source: 'default',
      env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
    };

    let resolveFirstMeta!: (value: unknown) => void;
    let resolveSecondMeta!: (value: unknown) => void;
    apiMock.setConfig.mockResolvedValue({ providers: {} });
    apiMock.getMeta
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstMeta = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondMeta = resolve;
          }),
      );

    const firstToggle = configStore().setBetaFeaturesEnabled(true);
    await Promise.resolve();
    const secondToggle = configStore().setBetaFeaturesEnabled(false);

    await vi.waitFor(() => expect(resolveSecondMeta).toBeDefined());

    resolveSecondMeta({
      serverVersion: '1.0.0',
      openInApps: [],
      dangerousBypassAuth: false,
      experimentalFlags: { notify_user: false },
      experimentalBeta: {
        enabled: false,
        source: 'config',
        env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
        configValue: false,
      },
      experimentalFeatures: [
        {
          id: 'notify_user',
          title: 'NotifyUser tool',
          description: 'Progress updates',
          env: 'KIMI_CODE_EXPERIMENTAL_NOTIFY_USER',
          stage: 'beta',
          effectTiming: 'next-session',
          enabled: false,
          active: false,
          source: 'default',
        },
      ],
      backend: 'v2',
      webTitle: '',
      homeDir: '/tmp/home',
    });
    await secondToggle;

    resolveFirstMeta({
      serverVersion: '1.0.0',
      openInApps: [],
      dangerousBypassAuth: false,
      experimentalFlags: { notify_user: true },
      experimentalBeta: {
        enabled: true,
        source: 'config',
        env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
        configValue: true,
      },
      experimentalFeatures: [
        {
          id: 'notify_user',
          title: 'NotifyUser tool',
          description: 'Progress updates',
          env: 'KIMI_CODE_EXPERIMENTAL_NOTIFY_USER',
          stage: 'beta',
          effectTiming: 'next-session',
          enabled: true,
          active: true,
          source: 'beta-config',
        },
      ],
      backend: 'v2',
      webTitle: '',
      homeDir: '/tmp/home',
    });
    await firstToggle;

    expect(configStore().experimentalBeta?.enabled).toBe(false);
    expect(configStore().experimentalFlags['notify_user']).toBe(false);
    expect(useContextInspector().contextInspectorEnabled.value).toBe(false);
  });

  it('retains local toggle state when toggling against a server whose meta omits experimentalFeatures', async () => {
    const { useContextInspector, useSessionMentions } = await import('@moonshot-ai/app-core');
    apiMock.setConfig.mockResolvedValue({ providers: {} });
    apiMock.getMeta.mockResolvedValue({
      serverVersion: '0.9.0',
      openInApps: [],
      dangerousBypassAuth: false,
      experimentalFlags: {},
      backend: 'v2',
      webTitle: '',
      homeDir: '/tmp/home',
    });

    expect(await configStore().setExperimentalFlag('context_inspector', true)).toBe(true);
    expect(useContextInspector().contextInspectorEnabled.value).toBe(true);
    expect(globalThis.localStorage.getItem(STORAGE_KEYS.contextInspector)).toBe('true');

    expect(await configStore().setExperimentalFlag('session_mentions', true)).toBe(true);
    expect(useSessionMentions().sessionMentions.value).toBe(true);
    expect(globalThis.localStorage.getItem(STORAGE_KEYS.sessionMentions)).toBe('1');

    expect(await configStore().setExperimentalFlag('context_inspector', false)).toBe(true);
    expect(useContextInspector().contextInspectorEnabled.value).toBe(false);
    expect(globalThis.localStorage.getItem(STORAGE_KEYS.contextInspector)).toBeNull();

    expect(await configStore().setExperimentalFlag('session_mentions', false)).toBe(true);
    expect(useSessionMentions().sessionMentions.value).toBe(false);
    expect(globalThis.localStorage.getItem(STORAGE_KEYS.sessionMentions)).toBeNull();

    apiMock.setConfig.mockClear();
    expect(await configStore().setBetaFeaturesEnabled(true)).toBe(false);
    expect(apiMock.setConfig).not.toHaveBeenCalled();
  });

  it('drains a second legacy localStorage key added while the first migration write is in flight without deadlocking', async () => {
    const { useContextInspector, useSessionMentions } = await import('@moonshot-ai/app-core');
    localStorage.setItem(STORAGE_KEYS.contextInspector, 'true');
    configStore().resetConfig();

    let serverContextConfigured = false;
    let serverMentionsConfigured = false;

    apiMock.setConfig.mockImplementation(async (patch: { experimental?: Record<string, boolean> }) => {
      if (patch.experimental?.['context_inspector'] === true) {
        serverContextConfigured = true;
        localStorage.setItem(STORAGE_KEYS.sessionMentions, '1');
      }
      if (patch.experimental?.['session_mentions'] === true) {
        serverMentionsConfigured = true;
      }
      return { providers: {} };
    });

    apiMock.getMeta.mockImplementation(async () => ({
      serverVersion: '1.0.0',
      openInApps: [],
      dangerousBypassAuth: false,
      experimentalFlags: {
        context_inspector: serverContextConfigured,
        session_mentions: serverMentionsConfigured,
      },
      experimentalBeta: {
        enabled: false,
        source: 'default',
        env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
      },
      experimentalFeatures: [
        {
          id: 'context_inspector',
          title: 'Context usage',
          description: 'Context inspector',
          env: 'KIMI_CODE_EXPERIMENTAL_CONTEXT_INSPECTOR',
          stage: 'beta',
          effectTiming: 'immediate',
          enabled: serverContextConfigured,
          active: serverContextConfigured,
          source: serverContextConfigured ? 'config' : 'default',
          ...(serverContextConfigured ? { configValue: true } : {}),
        },
        {
          id: 'session_mentions',
          title: 'Session mentions',
          description: 'Session mentions',
          env: 'KIMI_CODE_EXPERIMENTAL_SESSION_MENTIONS',
          stage: 'experimental',
          effectTiming: 'immediate',
          enabled: serverMentionsConfigured,
          active: serverMentionsConfigured,
          source: serverMentionsConfigured ? 'config' : 'default',
          ...(serverMentionsConfigured ? { configValue: true } : {}),
        },
      ],
      backend: 'v2',
      webTitle: '',
      homeDir: '/tmp/home',
    }));

    await configStore().refreshServerMeta();

    expect(apiMock.setConfig).toHaveBeenNthCalledWith(1, {
      experimental: { context_inspector: true },
    });
    expect(apiMock.setConfig).toHaveBeenNthCalledWith(2, {
      experimental: { session_mentions: true },
    });
    expect(localStorage.getItem(STORAGE_KEYS.contextInspector)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.sessionMentions)).toBeNull();
    expect(useContextInspector().contextInspectorEnabled.value).toBe(true);
    expect(useSessionMentions().sessionMentions.value).toBe(true);
  });
});

describe('setPromptPredictionEnabled', () => {
  beforeEach(() => {
    apiMock.setConfig.mockReset();
    apiMock.getMeta.mockReset();
    configStore().resetConfig();
  });

  it('does not update prompt_prediction flag when the config write fails', async () => {
    apiMock.setConfig.mockRejectedValueOnce(new Error('write conflict'));
    expect(await configStore().setPromptPredictionEnabled(true)).toBe(false);
    expect(configStore().experimentalFlags['prompt_prediction']).toBeUndefined();
  });

  it('updates prompt_prediction flag only after a successful write', async () => {
    apiMock.setConfig.mockResolvedValue({ providers: {}, defaultModel: 'model-new' });
    apiMock.getMeta.mockResolvedValue(null);
    expect(await configStore().setPromptPredictionEnabled(true)).toBe(true);
    expect(configStore().experimentalFlags['prompt_prediction']).toBe(true);
  });
});
