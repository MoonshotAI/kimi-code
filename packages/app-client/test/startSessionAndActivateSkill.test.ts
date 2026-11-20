import { computed, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@moonshot-ai/app-core/api';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { createWorkspaceRig } from '../src/testing/workspaceRig';
import { modelsStore } from '../src/stores/models';
import { modeStore } from '../src/stores/mode';
import { permissionsStore } from '../src/stores/permissions';
import { sessionsStore } from '../src/stores/sessions';
import { promptStore } from '../src/stores/prompt';
import { workspacesStore } from '../src/stores/workspaces';
import { ackThinkingPending, foldDaemonThinkingLevel } from '@moonshot-ai/app-core/lib';

const getKimiWebApiMock = vi.fn();

function resetStores(): void {
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
  modeStore().resetMode();
  const prompt = promptStore();
  prompt.queuedBySession = {};
  prompt.inFlightBySession = {};
  prompt.optimisticMessagesBySession = {};
  prompt.setDraftEntry('newChat');
}

const MODEL_DEFAULT_LEVEL = 'high';
const DRAFT_PICK_LEVEL = 'max';

function createdSession(id: string): AppSession {
  return {
    id,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    busy: false,
    archived: false,
    cwd: '/workspace',
    model: 'kimi-k3',
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
    workspaceId: 'workspace',
  };
}

function createWorkspaceState() {
  const rawState = {
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
    sessionLoading: false,
    gitStatusBySession: {},
    get thinking() {
      return modeStore().thinking;
    },
    set thinking(next: string | undefined) {
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
    set thinkingBySession(next: Record<string, string>) {
      modeStore().thinkingBySession = next as never;
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
    get goalModeBySession() {
      return modeStore().goalModeBySession;
    },
    set goalModeBySession(next: Record<string, boolean>) {
      modeStore().goalModeBySession = next;
    },
    goalBySession: {} as Record<string, unknown>,
  };
  modeStore().thinking = DRAFT_PICK_LEVEL as never;
  modeStore().draftThinkingExplicit = true;
  let daemonProfileThinking: string | undefined;
  const seedAtSelection: { thinking: string | undefined } = { thinking: undefined };
  const persistControl: { gate?: Promise<void>; fail?: boolean } = {};
  const api = {
    addWorkspace: vi.fn().mockRejectedValue(new Error('older daemon')),
    createSession: vi.fn(async () => createdSession('session-1')),
    getSession: vi.fn(async () => createdSession('session-1')),
    getGitStatus: vi.fn().mockRejectedValue(new Error('not needed')),
    updateSession: vi.fn(async (..._args: unknown[]) => ({})),
    submitPrompt: vi.fn(async (_sid: string, input: { promptId?: string }) => ({ promptId: input.promptId!, userMessageId: input.promptId! })),
  };
  getKimiWebApiMock.mockReturnValue(api);

  const setActiveSessionId = vi.fn((id: string | undefined) => {
    if (id !== undefined) seedAtSelection.thinking = rawState.thinkingBySession[id];
    rawState.activeSessionId = id;
  });
  const profileWrites: Array<Promise<boolean>> = [];
  const persistSessionProfile = vi.fn((patch: { thinking?: string }, sessionId?: string) => {
    const write = (async () => {
      const sid = sessionId ?? rawState.activeSessionId;
      const token = patch.thinking !== undefined && sid !== undefined
        ? rawState.pendingThinkingBySession[sid]
        : undefined;
      if (patch.thinking !== undefined) daemonProfileThinking = patch.thinking;
      if (persistControl.gate !== undefined) await persistControl.gate;
      if (persistControl.fail === true) return false;
      if (sid !== undefined) {
        ackThinkingPending(rawState as never, sid, token);
        foldDaemonThinkingLevel(rawState as never, sid, daemonProfileThinking ?? MODEL_DEFAULT_LEVEL);
      }
      return true;
    })();
    profileWrites.push(write);
    return write;
  });
  const whenSessionProfileSettled = vi.fn(
    async () => (await Promise.all(profileWrites)).every(Boolean),
  );
  const modelProvider = {
    skillsBySession: ref({}),
    loadSkillsForSession: vi.fn(),
    draftModel: ref<string | null>('kimi-k3'),
    resolveThinkingForPrompt: vi.fn(
      (sessionId: string | null | undefined) =>
        sessionId == null ? undefined : rawState.thinkingBySession[sessionId],
    ),
    activateSkill: vi.fn(async () => true),
    setSessionModel: vi.fn(async () => true),
    normalizeSessionModel: vi.fn(async (sessionId: string, model: string) => {
      rawState.sessions = rawState.sessions.map((session) =>
        session.id === sessionId ? { ...session, model } : session,
      );
      return persistSessionProfile({ model, thinking: rawState.thinkingBySession[sessionId] }, sessionId);
    }),
  };

  const deps = {
    sideChat: {},
    modelProvider,
    pushOperationFailure: vi.fn(),
    activity: computed(() => 'idle' as const),
    setSessions: (sessions: AppSession[]) => {
      rawState.sessions = sessions;
    },
    updateSession: vi.fn(),
    upsertSessionSorted: (next: AppSession) => rawState.sessions.unshift(next),
    appendSession: (next: AppSession) => rawState.sessions.push(next),
    forgetSession: vi.fn(),
    unpinSessions: vi.fn(),
    setActiveSessionId,
    nextOptimisticMsgId: vi.fn(() => 'optimistic'),
    mainUndoTarget: vi.fn(() => null),
    refreshMainTranscript: vi.fn(async () => {}),
    hasLoadedMessages: vi.fn(() => false),
    persistSessionProfile,
    whenSessionProfileSettled,
    markSessionStatusSettled: vi.fn(),
    savePermissionToStorage: vi.fn(),
    goalErrorMessage: vi.fn(),
    initialized: ref(true),
    bootStage: ref('auth'),
    bootRetries: ref(0),
    connectIssue: ref(null),
  };

  const store = workspacesStore();
  store.workspaces = [{ id: 'workspace', root: '/workspace', name: 'workspace', sessionCount: 0 }];
  store.storedActiveWorkspaceId = 'workspace';

  return {
    rawState,
    api,
    modelProvider,
    persistSessionProfile,
    persistControl,
    setActiveSessionId,
    seedAtSelection,
    ws: createWorkspaceRig(rawState as never, deps as never),
  };
}

describe('startSessionAndActivateSkill', () => {
  beforeEach(() => {
    resetStores();
    getKimiWebApiMock.mockReset();
    setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
    modelsStore().setModels([
      { id: 'kimi-k3', provider: 'managed:kimi-code', model: 'kimi-k3', maxContextSize: 0 },
    ]);
    modelsStore().setDraftModel(null);
    modelsStore().setDefaultModel(null);
    permissionsStore().$reset();
    permissionsStore().pickInDraft('auto');
  });

  afterEach(() => {
    resetKimiClientDeps();
  });

  it('reuses the selected multi-root project when sending the first prompt', async () => {
    const { api, ws } = createWorkspaceState();
    const store = workspacesStore();
    const singleRoot = { id: 'wm_single', root: '/repo/astro', name: 'astro', additionalDirs: [], sessionCount: 0 };
    const multiRoot = { id: 'wm_multi', root: '/repo/astro', name: 'astro', additionalDirs: ['/repo/starlight'], sessionCount: 0 };
    store.workspaces = [singleRoot, multiRoot];
    store.storedActiveWorkspaceId = multiRoot.id;
    const session = { ...createdSession('session-1'), cwd: multiRoot.root, workspaceId: multiRoot.id };
    api.createSession.mockResolvedValue(session);
    api.getSession.mockResolvedValue(session);
    api.addWorkspace.mockResolvedValue(singleRoot);

    const started = await ws.startSessionAndSendPrompt(
      multiRoot.id,
      ws.createPromptEnvelope({ text: 'hello' }),
    );

    expect(started).toEqual({ sessionId: 'session-1', promptRejected: false });
    expect(api.addWorkspace).not.toHaveBeenCalled();
    expect(api.createSession.mock.calls[0]?.[0]).toEqual({ workspaceId: multiRoot.id, cwd: multiRoot.root });
    expect(store.workspaces).toEqual([singleRoot, multiRoot]);
  });

  it('keeps the session-only project id without registering it again', async () => {
    const { api, ws } = createWorkspaceState();
    const store = workspacesStore();
    const id = 'wd_legacy_123456789abc';
    store.workspaces = [];
    store.storedActiveWorkspaceId = id;
    sessionsStore().setSessions([{ ...createdSession('existing'), cwd: '/repo/legacy', workspaceId: id }]);
    const session = { ...createdSession('session-1'), cwd: '/repo/legacy', workspaceId: id };
    api.createSession.mockResolvedValue(session);
    api.getSession.mockResolvedValue(session);

    const started = await ws.startSessionAndSendPrompt(
      id,
      ws.createPromptEnvelope({ text: 'hello' }),
    );

    expect(started).toEqual({ sessionId: 'session-1', promptRejected: false });
    expect(api.addWorkspace).not.toHaveBeenCalled();
    expect(api.createSession.mock.calls[0]?.[0]).toEqual({ workspaceId: id, cwd: '/repo/legacy' });
  });

  it('passes an immutable composer snapshot through new-session skill activation', async () => {
    const { modelProvider, ws } = createWorkspaceState();
    const snapshot = { version: 1 as const, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'original' }] }] }, attachments: [], attachmentOrder: [] };
    const pending = ws.startSessionAndActivateSkill('workspace', 'example-skill', 'args', [], snapshot);
    snapshot.doc.content[0]!.content[0]!.text = 'changed';
    await pending;
    expect(modelProvider.activateSkill).toHaveBeenCalledWith('example-skill', 'args', [], 'session-1', expect.objectContaining({ snapshot: expect.objectContaining({ doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'original' }] }] } }) }));
  });

  it('writes the seeded draft settings before activating the skill', async () => {
    const { rawState, modelProvider, persistSessionProfile, ws } = createWorkspaceState();

    const result = await ws.startSessionAndActivateSkill('workspace', 'agent-browser', undefined);

    expect(result).toEqual({ sessionId: 'session-1', activated: true });
    expect(rawState.thinkingBySession['session-1']).toBe(DRAFT_PICK_LEVEL);
    expect(persistSessionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: DRAFT_PICK_LEVEL, permissionMode: 'auto' }),
      'session-1',
    );
    const persistOrder = persistSessionProfile.mock.invocationCallOrder[0]!;
    const activateOrder = modelProvider.activateSkill.mock.invocationCallOrder[0]!;
    expect(persistOrder).toBeLessThan(activateOrder);
    await vi.waitFor(() => expect(rawState.pendingThinkingBySession['session-1']).toBeUndefined());
  });

  it('arms a draft plan intent for the activation to cash', async () => {
    const { rawState, modelProvider, ws } = createWorkspaceState();
    modeStore().draftModes.planMode = true;

    const result = await ws.startSessionAndActivateSkill('workspace', 'agent-browser', undefined);

    expect(result).toEqual({ sessionId: 'session-1', activated: true });
    expect(rawState.planArmedBySession['session-1']).toBe(true);
    expect(modelProvider.activateSkill).toHaveBeenCalledWith('agent-browser', undefined, undefined, 'session-1', {
      snapshot: undefined,
    });
  });

  it('forwards composer attachments to the activation', async () => {
    const { modelProvider, ws } = createWorkspaceState();
    const attachments = [
      { fileId: 'f_1', kind: 'image' as const, name: 'shot.png', mediaType: 'image/png', size: 10 },
      { fileId: 'f_2', kind: 'file' as const, name: 'notes.txt', mediaType: 'text/plain', size: 20 },
    ];

    const result = await ws.startSessionAndActivateSkill('workspace', 'agent-browser', 'go', attachments);

    expect(result).toEqual({ sessionId: 'session-1', activated: true });
    expect(modelProvider.activateSkill).toHaveBeenCalledWith('agent-browser', 'go', attachments, 'session-1', {
      snapshot: undefined,
    });
  });

  it('seeds the draft pick before the session is selected', async () => {
    const { seedAtSelection, setActiveSessionId, ws } = createWorkspaceState();

    await ws.startSessionAndActivateSkill('workspace', 'agent-browser', undefined);

    expect(seedAtSelection.thinking).toBe(DRAFT_PICK_LEVEL);
    expect(setActiveSessionId).toHaveBeenCalledWith('session-1');
  });

  it('shields the pending pick from daemon reports that predate the persist', async () => {
    const { rawState, persistControl, ws } = createWorkspaceState();
    let release!: () => void;
    persistControl.gate = new Promise<void>((r) => {
      release = r;
    });

    const pending = ws.startSessionAndActivateSkill('workspace', 'agent-browser', undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(rawState.pendingThinkingBySession['session-1']).toBeDefined();
    foldDaemonThinkingLevel(rawState as never, 'session-1', MODEL_DEFAULT_LEVEL);
    expect(rawState.thinkingBySession['session-1']).toBe(DRAFT_PICK_LEVEL);

    release();
    await pending;

    expect(rawState.thinkingBySession['session-1']).toBe(DRAFT_PICK_LEVEL);
    expect(rawState.pendingThinkingBySession['session-1']).toBeUndefined();
  });

  it('sends the first prompt after the draft settings write, without settings of its own', async () => {
    const { rawState, api, persistSessionProfile, ws } = createWorkspaceState();

    const started = await ws.startSessionAndSendPrompt(
      'workspace',
      ws.createPromptEnvelope({ text: 'hello' }),
    );

    expect(started).toEqual({ sessionId: 'session-1', promptRejected: false });
    expect(persistSessionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: DRAFT_PICK_LEVEL, permissionMode: 'auto' }),
      'session-1',
    );
    const request = (api.submitPrompt.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(['content', 'metadata', 'promptId', 'skills']);
    expect(request['promptId']).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(persistSessionProfile.mock.invocationCallOrder[0]!).toBeLessThan(
      api.submitPrompt.mock.invocationCallOrder[0]!,
    );
    expect(rawState.thinkingBySession['session-1']).toBe(DRAFT_PICK_LEVEL);
    expect(rawState.pendingThinkingBySession['session-1']).toBeUndefined();
  });

  it('preserves the draft thinking level when the first prompt normalizes the session model id', async () => {
    const { rawState, api, modelProvider, persistSessionProfile, ws } = createWorkspaceState();
    modelsStore().setDefaultModel('kimi-k3');
    const session = { ...createdSession('session-1'), model: 'legacy-k3' };
    api.createSession.mockResolvedValue(session);
    api.getSession.mockResolvedValue(session);

    const started = await ws.startSessionAndSendPrompt(
      'workspace',
      ws.createPromptEnvelope({ text: 'hello' }),
    );

    expect(started).toEqual({ sessionId: 'session-1', promptRejected: false });
    expect(modelProvider.normalizeSessionModel).toHaveBeenCalledWith('session-1', 'kimi-k3');
    expect(modelProvider.setSessionModel).not.toHaveBeenCalled();
    expect(persistSessionProfile).toHaveBeenCalledWith(
      { model: 'kimi-k3', thinking: DRAFT_PICK_LEVEL },
      'session-1',
    );
    expect(rawState.thinkingBySession['session-1']).toBe(DRAFT_PICK_LEVEL);
  });

  it('rejects the first prompt when the draft settings write fails', async () => {
    const { api, persistControl, ws } = createWorkspaceState();
    persistControl.fail = true;

    const started = await ws.startSessionAndSendPrompt(
      'workspace',
      ws.createPromptEnvelope({ text: 'hello' }),
    );

    expect(started).toEqual({ sessionId: 'session-1', promptRejected: true });
    expect(api.submitPrompt).not.toHaveBeenCalled();
  });

  it('reports a definitive daemon refusal with the created session id', async () => {
    const { api, ws } = createWorkspaceState();
    api.submitPrompt.mockRejectedValueOnce(
      new DaemonApiError({ code: 50000, msg: 'skill.not_found', requestId: 'r' }),
    );

    const started = await ws.startSessionAndSendPrompt(
      'workspace',
      ws.createPromptEnvelope({ text: 'hello' }),
    );

    expect(started).toEqual({ sessionId: 'session-1', promptRejected: true });
  });

  it('marks a concurrent first-prompt call instead of reporting a failure', async () => {
    const { api, ws } = createWorkspaceState();
    let resolveCreate!: (value: AppSession) => void;
    api.createSession.mockImplementationOnce(
      () => new Promise<AppSession>((resolve) => { resolveCreate = resolve; }),
    );

    const first = ws.startSessionAndSendPrompt(
      'workspace',
      ws.createPromptEnvelope({ text: 'hello' }),
    );
    await vi.waitFor(() => expect(api.createSession).toHaveBeenCalledOnce());
    const second = await ws.startSessionAndSendPrompt(
      'workspace',
      ws.createPromptEnvelope({ text: 'hello again' }),
    );

    expect(second).toEqual({ sessionId: null, promptRejected: false, concurrent: true });

    resolveCreate(createdSession('session-1'));
    await expect(first).resolves.toMatchObject({ sessionId: 'session-1', promptRejected: false });
  });

  it('creates a goal without dropping the initial prompt media or snapshot', async () => {
    const { api, ws } = createWorkspaceState();
    const snapshot = { version: 1 as const, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inspect image' }] }] }, attachments: [], attachmentOrder: [] };
    const result = await ws.createGoal({ text: 'Inspect image', snapshot, attachments: [{ kind: 'image', fileId: 'image-file', name: 'shot.png' }] });
    expect(result.promptRejected).toBe(false);
    expect(api.submitPrompt).toHaveBeenCalledWith('session-1', expect.objectContaining({
      content: [{ type: 'text', text: 'Inspect image' }, { type: 'image', source: { kind: 'file', fileId: 'image-file' }, name: 'shot.png' }],
      metadata: expect.objectContaining({ kimi_code_composer: snapshot }),
    }));
  });

  it('createGoal reports a rejected objective prompt', async () => {
    const { api, ws } = createWorkspaceState();
    api.submitPrompt.mockRejectedValueOnce(
      new DaemonApiError({ code: 40113, msg: 'model gone', requestId: 'req_1' }),
    );

    const started = await ws.createGoal('ship it');

    expect(started).toEqual({ sessionId: 'session-1', promptRejected: true });
  });

  it('createGoal reports a failed goal write as rejected', async () => {
    const { api, ws } = createWorkspaceState();
    api.updateSession.mockRejectedValueOnce(new Error('daemon down'));

    const started = await ws.createGoal('ship it');

    expect(started).toEqual({ sessionId: 'session-1', promptRejected: true });
  });
});
