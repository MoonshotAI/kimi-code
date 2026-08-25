import { computed, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { useWorkspaceState } from '../src/client/useWorkspaceState';
import { ackThinkingPending, foldDaemonThinkingLevel } from '@moonshot-ai/app-core/lib';

const getKimiWebApiMock = vi.fn();

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
    lastSeq: 0,
    workspaceId: 'workspace',
  };
}

// Fake daemon: the effective level is the profile patch's thinking override,
// else the model default; the chain tail folds via the real guarded helper.
function createWorkspaceState() {
  const rawState = {
    sessions: [] as AppSession[],
    activeSessionId: undefined as string | undefined,
    activeWorkspaceId: 'workspace',
    sessionLoading: false,
    unreadBySession: {} as Record<string, boolean>,
    gitStatusBySession: {},
    hiddenWorkspaceRoots: [],
    thinking: DRAFT_PICK_LEVEL as string | undefined,
    thinkingBySession: {} as Record<string, string>,
    pendingThinkingBySession: {} as Record<string, number>,
    planModeBySession: {} as Record<string, boolean>,
    planArmedBySession: {} as Record<string, boolean>,
    pendingPlanBySession: {} as Record<string, number>,
    swarmModeBySession: {} as Record<string, boolean>,
    pendingSwarmBySession: {} as Record<string, number>,
    goalModeBySession: {} as Record<string, boolean>,
    goalBySession: {} as Record<string, unknown>,
    optimisticMessagesBySession: {} as Record<string, unknown[]>,
    permission: 'auto',
    defaultModel: 'kimi-k3',
  };
  let daemonProfileThinking: string | undefined;
  // The session's thinking entry as seen when its selection begins.
  const seedAtSelection: { thinking: string | undefined } = { thinking: undefined };
  // Lets a test hold the in-flight persist open.
  const persistControl: { gate?: Promise<void> } = {};
  const api = {
    addWorkspace: vi.fn().mockRejectedValue(new Error('older daemon')),
    createSession: vi.fn(async () => createdSession('session-1')),
    getSession: vi.fn(async () => createdSession('session-1')),
    getGitStatus: vi.fn().mockRejectedValue(new Error('not needed')),
    updateSession: vi.fn(async (..._args: unknown[]) => ({})),
    submitPrompt: vi.fn(async () => ({ promptId: 'p_1', userMessageId: 'u_1' })),
  };
  getKimiWebApiMock.mockReturnValue(api);

  const refreshSessionStatus = vi.fn(async () => {});
  const subscribeSessionEvents = vi.fn((sessionId: string) => {
    seedAtSelection.thinking = rawState.thinkingBySession[sessionId];
  });
  const persistSessionProfile = vi.fn(
    async (patch: { thinking?: string }, sessionId?: string) => {
      const sid = sessionId ?? rawState.activeSessionId;
      // Mirror the real success path: the applied patch acks its write token,
      // then the chain tail folds the daemon's level.
      const token = patch.thinking !== undefined && sid !== undefined
        ? rawState.pendingThinkingBySession[sid]
        : undefined;
      if (patch.thinking !== undefined) daemonProfileThinking = patch.thinking;
      if (persistControl.gate !== undefined) await persistControl.gate;
      if (sid !== undefined) {
        ackThinkingPending(rawState as never, sid, token);
        foldDaemonThinkingLevel(rawState as never, sid, daemonProfileThinking ?? MODEL_DEFAULT_LEVEL);
      }
      return true;
    },
  );
  const modelProvider = {
    skillsBySession: ref({}),
    loadSkillsForSession: vi.fn(),
    draftModel: ref<string | null>('kimi-k3'),
    // Mirrors the real gated read: the session's own entry wins.
    resolveThinkingForPrompt: vi.fn(
      async (sessionId: string | null | undefined) =>
        sessionId == null ? undefined : rawState.thinkingBySession[sessionId],
    ),
    activateSkill: vi.fn(async () => true),
  };

  const deps = {
    taskPoller: { loadTasksForSession: vi.fn() },
    sideChat: {},
    modelProvider,
    pushOperationFailure: vi.fn(),
    activity: computed(() => ({ state: 'idle' })),
    sessionsKnownEmpty: new Set<string>(),
    setSessions: (sessions: AppSession[]) => {
      rawState.sessions = sessions;
    },
    updateSession: vi.fn(),
    upsertSessionSorted: (next: AppSession) => rawState.sessions.unshift(next),
    appendSession: (next: AppSession) => rawState.sessions.push(next),
    forgetSession: vi.fn(),
    unpinSessions: vi.fn(),
    setActiveSessionId: (id: string | undefined) => {
      rawState.activeSessionId = id;
    },
    nextOptimisticMsgId: vi.fn(() => 'optimistic'),
    lastMainUserPromptText: vi.fn(() => null),
    getEventConn: vi.fn(() => null),
    subscribeSessionEvents,
    refreshMainTranscript: vi.fn(async () => {}),
    hasLoadedMessages: vi.fn(() => false),
    refreshSessionStatus,
    refreshSessionGoal: vi.fn(async () => {}),
    refreshSessionPlans: vi.fn(async () => {}),
    persistSessionProfile,
    mergedWorkspaces: computed(() => [{ id: 'workspace', root: '/workspace' }]),
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

  return {
    rawState,
    api,
    modelProvider,
    persistSessionProfile,
    persistControl,
    refreshSessionStatus,
    subscribeSessionEvents,
    seedAtSelection,
    ws: useWorkspaceState(rawState as never, deps as never),
  };
}

describe('startSessionAndActivateSkill', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
    setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  });

  afterEach(() => {
    resetKimiClientDeps();
  });

  it('persists the seeded draft thinking level so the profile /status fold cannot clobber it', async () => {
    const { rawState, modelProvider, persistSessionProfile, ws } = createWorkspaceState();

    const result = await ws.startSessionAndActivateSkill('workspace', 'agent-browser', undefined);

    expect(result).toEqual({ sessionId: 'session-1', activated: true });
    expect(rawState.thinkingBySession['session-1']).toBe(DRAFT_PICK_LEVEL);
    expect(persistSessionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'kimi-k3', thinking: DRAFT_PICK_LEVEL }),
      'session-1',
    );
    expect(modelProvider.resolveThinkingForPrompt).toHaveBeenCalledWith('session-1', 'kimi-k3');
    // The activation runs at the profile effort, so the persist must land first.
    const persistOrder = persistSessionProfile.mock.invocationCallOrder[0]!;
    const activateOrder = modelProvider.activateSkill.mock.invocationCallOrder[0]!;
    expect(persistOrder).toBeLessThan(activateOrder);
    expect(modelProvider.activateSkill).toHaveBeenCalledWith('agent-browser', undefined, undefined, 'session-1', {
      skipThinkingPersist: true,
    });
    // The chain-tail fold reported the persisted level back — pick acked.
    expect(rawState.pendingThinkingBySession['session-1']).toBeUndefined();
  });

  it('cashes an armed plan intent through the profile patch and consumes it', async () => {
    const { rawState, modelProvider, persistSessionProfile, ws } = createWorkspaceState();
    rawState.planArmedBySession['session-1'] = true;

    const result = await ws.startSessionAndActivateSkill('workspace', 'agent-browser', undefined);

    expect(result).toEqual({ sessionId: 'session-1', activated: true });
    expect(persistSessionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ planMode: true }),
      'session-1',
    );
    // The successful persist cashed the intent: consumed, and the fact mirrored.
    expect(rawState.planArmedBySession['session-1']).toBe(false);
    expect(rawState.planModeBySession['session-1']).toBe(true);
    expect(modelProvider.activateSkill).toHaveBeenCalledWith('agent-browser', undefined, undefined, 'session-1', {
      skipThinkingPersist: true,
    });
  });

  it('forwards composer attachments to the activation', async () => {    const { modelProvider, ws } = createWorkspaceState();
    const attachments = [
      { fileId: 'f_1', kind: 'image' as const, name: 'shot.png', mediaType: 'image/png', size: 10 },
      { fileId: 'f_2', kind: 'file' as const, name: 'notes.txt', mediaType: 'text/plain', size: 20 },
    ];

    const result = await ws.startSessionAndActivateSkill('workspace', 'agent-browser', 'go', attachments);

    expect(result).toEqual({ sessionId: 'session-1', activated: true });
    expect(modelProvider.activateSkill).toHaveBeenCalledWith('agent-browser', 'go', attachments, 'session-1', {
      skipThinkingPersist: true,
    });
  });

  it('seeds the draft pick before the session is selected, and skips the fresh /status fold', async () => {
    const { seedAtSelection, refreshSessionStatus, subscribeSessionEvents, ws } = createWorkspaceState();

    await ws.startSessionAndActivateSkill('workspace', 'agent-browser', undefined);

    expect(seedAtSelection.thinking).toBe(DRAFT_PICK_LEVEL);
    // A fresh-session /status fold would only report daemon defaults over the
    // seeds — the open path skips the sidecar status refresh.
    expect(refreshSessionStatus).not.toHaveBeenCalled();
    expect(subscribeSessionEvents).toHaveBeenCalledWith('session-1');
  });

  it('shields the pending pick from daemon reports that predate the persist', async () => {
    const { rawState, persistControl, ws } = createWorkspaceState();
    let release!: () => void;
    persistControl.gate = new Promise<void>((r) => {
      release = r;
    });

    const pending = ws.startSessionAndActivateSkill('workspace', 'agent-browser', undefined);
    // Reach the in-flight persist: the pick is seeded but unacknowledged.
    await new Promise((r) => setTimeout(r, 0));
    expect(rawState.pendingThinkingBySession['session-1']).toBeDefined();
    // A stale daemon report must not fold over the unacknowledged pick.
    foldDaemonThinkingLevel(rawState as never, 'session-1', MODEL_DEFAULT_LEVEL);
    expect(rawState.thinkingBySession['session-1']).toBe(DRAFT_PICK_LEVEL);

    release();
    await pending;

    expect(rawState.thinkingBySession['session-1']).toBe(DRAFT_PICK_LEVEL);
    expect(rawState.pendingThinkingBySession['session-1']).toBeUndefined();
  });

  it('acks the pending pick when a first prompt carries it to the daemon', async () => {
    const { rawState, api, ws } = createWorkspaceState();

    const sid = await ws.startSessionAndSendPrompt('workspace', 'hello');

    expect(sid).toBe('session-1');
    expect(api.submitPrompt).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ thinking: DRAFT_PICK_LEVEL }),
    );
    expect(rawState.thinkingBySession['session-1']).toBe(DRAFT_PICK_LEVEL);
    expect(rawState.pendingThinkingBySession['session-1']).toBeUndefined();
  });

  it('drops the shield and re-reads status when the first prompt fails', async () => {
    const { rawState, api, refreshSessionStatus, ws } = createWorkspaceState();
    api.submitPrompt.mockRejectedValueOnce(new Error('daemon down'));

    const sid = await ws.startSessionAndSendPrompt('workspace', 'hello');

    expect(sid).toBe('session-1');
    expect(rawState.pendingThinkingBySession['session-1']).toBeUndefined();
    expect(refreshSessionStatus).toHaveBeenCalledWith('session-1');
  });
});
