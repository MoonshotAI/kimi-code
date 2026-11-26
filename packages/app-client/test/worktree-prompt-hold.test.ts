import { computed, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonApiError } from '@moonshot-ai/app-core/api';
import type { AppSession, AppSessionWorktree, WorkspaceGitBranches } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { createWorkspaceRig, type WorkspaceRig } from '../src/testing/workspaceRig';
import { appSession, sessionWorktree as worktree } from '../src/testing/worktreeFixtures';
import { configStore } from '../src/stores/config';
import { modelsStore } from '../src/stores/models';
import { modeStore } from '../src/stores/mode';
import { newSessionEnvironmentStore } from '../src/stores/newSessionEnvironment';
import { permissionsStore } from '../src/stores/permissions';
import { promptStore } from '../src/stores/prompt';
import { sessionsStore } from '../src/stores/sessions';
import { warningsStore } from '../src/stores/warnings';
import { workspacesStore } from '../src/stores/workspaces';

const SID = 'session-1';

const BRANCHES: WorkspaceGitBranches = {
  isRepo: true,
  remotes: ['origin'],
  headBranch: 'main',
  dirty: false,
  branches: [{ name: 'main', committedAt: '2026-11-18T00:00:00.000Z', remoteRef: 'origin/main' }],
};

function session(overrides: Partial<AppSession> = {}): AppSession {
  return appSession({ id: SID, title: SID, ...overrides });
}

function setWorktree(next: AppSessionWorktree | undefined, cwd = '/workspace'): void {
  sessionsStore().updateSession(SID, (current) => ({ ...current, cwd, worktree: next }));
}

function resetStores(): void {
  const store = workspacesStore();
  store.workspaces = [];
  store.storedActiveWorkspaceId = null;
  store.hiddenWorkspaceIds = [];
  store.sessionsHasMoreByWorkspace = {};
  sessionsStore().setSessions([]);
  sessionsStore().setActiveSessionId(undefined);
  modeStore().resetMode();
  const prompt = promptStore();
  prompt.queuedBySession = {};
  prompt.inFlightBySession = {};
  prompt.optimisticMessagesBySession = {};
  prompt.heldFirstPromptBySession = {};
  prompt.forgetPromptState(SID);
  prompt.setDraftEntry('newChat');
  newSessionEnvironmentStore().reset();
  warningsStore().resetWarnings();
}

function sentTexts(submitPrompt: ReturnType<typeof vi.fn>): string[] {
  return submitPrompt.mock.calls.map((call) => {
    const content = (call[1] as { content: Array<{ type: string; text?: string }> }).content;
    return content.find((part) => part.type === 'text')?.text ?? '';
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function start(ws: WorkspaceRig, text = 'hello') {
  return ws.startSessionAndSendPrompt('workspace', ws.createPromptEnvelope({ text }));
}

async function moveTo(ws: WorkspaceRig, next: AppSessionWorktree | undefined, cwd?: string): Promise<void> {
  setWorktree(next, cwd);
  ws.syncWorktreeHold(SID);
  await flush();
}

async function createRig(options: { worktree?: boolean } = {}) {
  const created = session(options.worktree === false ? {} : { worktree: worktree('running') });
  const api = {
    createSession: vi.fn(async () => created),
    getSession: vi.fn(async () => created),
    getGitStatus: vi.fn().mockRejectedValue(new Error('not needed')),
    getSessionWarnings: vi.fn(async () => []),
    getWorkspaceGitBranches: vi.fn(async (): Promise<WorkspaceGitBranches> => BRANCHES),
    updateSession: vi.fn(async () => ({})),
    submitPrompt: vi.fn(async (_sid: string, input: { promptId?: string }) => ({
      promptId: input.promptId!,
      userMessageId: input.promptId!,
    })),
    cancelSession: vi.fn(async () => ({ cancelled: true })),
    sessionWorktreeAction: vi.fn(async (): Promise<AppSession> => session({ worktree: worktree('stopped') })),
  };
  setKimiClientDeps({ api: () => api as never, t: (key) => key });

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
    goalBySession: {},
  };
  const modelProvider = {
    skillsBySession: ref({}),
    loadSkillsForSession: vi.fn(),
    draftModel: ref<string | null>('kimi-k3'),
    resolveThinkingForPrompt: vi.fn(() => undefined),
    activateSkill: vi.fn(async () => true),
    setSessionModel: vi.fn(async () => true),
  };
  let optimisticSeq = 0;
  const deps = {
    sideChat: {},
    modelProvider,
    activity: computed(() => 'idle' as const),
    updateSession: vi.fn(),
    upsertSessionSorted: (next: AppSession) => sessionsStore().upsertSessionSorted(next),
    appendSession: (next: AppSession) => sessionsStore().appendSession(next),
    unpinSessions: vi.fn(),
    setActiveSessionId: (id: string | undefined) => sessionsStore().setActiveSessionId(id),
    nextOptimisticMsgId: () => `optimistic-${(optimisticSeq += 1)}`,
    mainUndoTarget: vi.fn(() => null),
    hasLoadedMessages: vi.fn(() => false),
    persistSessionProfile: vi.fn(async () => true),
    whenSessionProfileSettled: vi.fn(async () => true),
    markSessionStatusSettled: vi.fn(),
  };

  const store = workspacesStore();
  store.workspaces = [
    { id: 'workspace', root: '/workspace', name: 'workspace', kind: 'managed', additionalDirs: [], sessionCount: 0 },
  ];
  store.storedActiveWorkspaceId = 'workspace';

  if (options.worktree !== false) {
    newSessionEnvironmentStore().selectEnvironment('worktree');
    await newSessionEnvironmentStore().ensureBranches('workspace');
  }

  return { api, modelProvider, ws: createWorkspaceRig(rawState as never, deps as never) };
}

describe('worktree first-prompt hold', () => {
  beforeEach(() => {
    resetStores();
    configStore().experimentalFlags = { worktree: true };
    modelsStore().setModels([{ id: 'kimi-k3', provider: 'managed:kimi-code', model: 'kimi-k3', maxContextSize: 0 }]);
    modelsStore().setDraftModel(null);
    modelsStore().setDefaultModel(null);
    permissionsStore().$reset();
    permissionsStore().pickInDraft('auto');
  });

  afterEach(() => {
    resetStores();
    resetKimiClientDeps();
  });

  it('creates the session with the worktree request and holds the first prompt', async () => {
    const { api, ws } = await createRig();

    const started = await start(ws);

    expect(started).toEqual({ sessionId: SID, promptRejected: false });
    expect(api.createSession.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'workspace',
      cwd: '/workspace',
      worktree: { sourceBranch: 'main' },
    });
    expect(api.submitPrompt).not.toHaveBeenCalled();
    expect(promptStore().heldFirstPromptBySession[SID]?.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(promptStore().isStartingFirstPrompt).toBe(false);
  });

  it('sends the held prompt exactly once when the worktree becomes ready', async () => {
    const { api, ws } = await createRig();
    await start(ws);

    ws.syncWorktreeHold(SID);
    await flush();
    expect(api.submitPrompt).not.toHaveBeenCalled();

    setWorktree(worktree('ready', { path: '/wt/a' }), '/wt/a');
    ws.syncWorktreeHold(SID);
    ws.syncWorktreeHold(SID);
    await flush();

    expect(sentTexts(api.submitPrompt)).toEqual(['hello']);
    expect(promptStore().heldFirstPromptBySession[SID]).toBeUndefined();
  });

  it('queues later messages behind the held prompt and flushes them in order', async () => {
    const { api, ws } = await createRig();
    await start(ws, 'first');

    expect(ws.wouldEnqueuePrompt(SID)).toBe(true);
    expect(ws.wouldSteerPrompt(SID)).toBe(false);
    expect(await ws.sendPrompt(ws.createPromptEnvelope({ text: 'second' }))).toBe('queued');
    expect(await ws.sendPrompt(ws.createPromptEnvelope({ text: 'third' }))).toBe('queued');
    ws.flushQueueHead(SID);
    ws.resumeQueueIfIdle(SID);
    await flush();
    expect(api.submitPrompt).not.toHaveBeenCalled();
    expect(promptStore().queuedBySession[SID]?.map((entry) => entry.text)).toEqual(['second', 'third']);

    await moveTo(ws, worktree('ready', { path: '/wt/a' }), '/wt/a');
    expect(sentTexts(api.submitPrompt)).toEqual(['first', 'second', 'third']);
    expect(promptStore().queuedBySession[SID]).toEqual([]);
  });

  it('refuses a direct submit while the worktree is not ready', async () => {
    const { api, ws } = await createRig();
    await start(ws, 'first');

    expect(await ws.submitPromptInternal(SID, ws.createPromptEnvelope({ text: 'sneaky' }))).toBe('rejected');
    expect(api.submitPrompt).not.toHaveBeenCalled();
    expect(promptStore().optimisticMessagesBySession[SID]).toBeUndefined();
  });

  it('queues into an existing session whose worktree is being recreated, then flushes', async () => {
    const { api, ws } = await createRig({ worktree: false });
    sessionsStore().setSessions([session({ cwd: '/wt/a', worktree: worktree('running', { path: '/wt/a', missing: true }) })]);
    sessionsStore().setActiveSessionId(SID);

    expect(await ws.sendPrompt(ws.createPromptEnvelope({ text: 'later' }))).toBe('queued');
    expect(api.submitPrompt).not.toHaveBeenCalled();

    await moveTo(ws, worktree('ready', { path: '/wt/a' }), '/wt/a');
    expect(sentTexts(api.submitPrompt)).toEqual(['later']);
  });

  it('cannot send into a session whose worktree is missing', async () => {
    const { api, ws } = await createRig({ worktree: false });
    sessionsStore().setSessions([session({ cwd: '/wt/a', worktree: worktree('ready', { path: '/wt/a', missing: true }) })]);
    sessionsStore().setActiveSessionId(SID);

    expect(await ws.sendPrompt(ws.createPromptEnvelope({ text: 'hello' }))).toBe('rejected');
    ws.flushQueueHead(SID);
    await flush();
    expect(api.submitPrompt).not.toHaveBeenCalled();
    expect(promptStore().queuedBySession[SID] ?? []).toEqual([]);
  });

  it('applies a worktree action result and releases the hold when it settles', async () => {
    const { api, ws } = await createRig();
    await start(ws);
    setWorktree(worktree('failed'));

    api.sessionWorktreeAction.mockResolvedValueOnce(session({ worktree: worktree('running') }));
    expect(await ws.runSessionWorktreeAction(SID, 'retry', { useRemote: false })).toBe(true);
    expect(api.sessionWorktreeAction).toHaveBeenLastCalledWith(SID, 'retry', { useRemote: false });
    await flush();
    expect(api.submitPrompt).not.toHaveBeenCalled();

    api.sessionWorktreeAction.mockResolvedValueOnce(session({ worktree: worktree('local') }));
    expect(await ws.runSessionWorktreeAction(SID, 'useLocal')).toBe(true);
    await flush();
    expect(sessionsStore().sessions[0]?.worktree?.setup.status).toBe('local');
    expect(sentTexts(api.submitPrompt)).toEqual(['hello']);
  });

  it('reports a failed worktree action and keeps the hold', async () => {
    const { api, ws } = await createRig();
    await start(ws);
    const before = sessionsStore().sessions[0]?.worktree;
    api.sessionWorktreeAction.mockRejectedValueOnce(new Error('offline'));

    expect(await ws.runSessionWorktreeAction(SID, 'retry')).toBe(false);

    expect(warningsStore().warnings).toHaveLength(1);
    expect(sessionsStore().sessions[0]?.worktree).toEqual(before);
    expect(promptStore().heldFirstPromptBySession[SID]).toBeDefined();
  });

  it('drops the held prompt when the session disappears', async () => {
    const { api, ws } = await createRig();
    await start(ws);

    sessionsStore().removeSession(SID);
    ws.syncWorktreeHold(SID);
    await flush();

    expect(promptStore().heldFirstPromptBySession[SID]).toBeUndefined();
    expect(api.submitPrompt).not.toHaveBeenCalled();
  });

  it('puts the first prompt at the head of the queue when its send fails after release', async () => {
    const { api, ws } = await createRig();
    await start(ws, 'first');
    await ws.sendPrompt(ws.createPromptEnvelope({ text: 'second' }));
    api.submitPrompt.mockRejectedValueOnce(Object.assign(new Error('bad request'), { name: 'DaemonApiError', code: 40001 }));

    await moveTo(ws, worktree('ready', { path: '/wt/a' }), '/wt/a');

    expect(api.submitPrompt).toHaveBeenCalledTimes(1);
    expect(promptStore().queuedBySession[SID]?.map((entry) => entry.text)).toEqual(['first', 'second']);
  });

  it('keeps holding while setup is still running, after the session already points at the worktree', async () => {
    const { api, ws } = await createRig();
    await start(ws);

    await moveTo(ws, worktree('running', { path: '/wt/a', branch: 'kimi/a' }), '/wt/a');
    expect(api.submitPrompt).not.toHaveBeenCalled();

    expect(await ws.abortCurrentPrompt()).toBe(true);
    expect(api.sessionWorktreeAction).toHaveBeenCalledExactlyOnceWith(SID, 'cancel', undefined);

    await moveTo(ws, worktree('ready', { path: '/wt/a' }), '/wt/a');
    expect(sentTexts(api.submitPrompt)[0]).toBe('hello');
  });

  it('sends in local mode after a missing worktree is abandoned', async () => {
    const { api, ws } = await createRig({ worktree: false });
    sessionsStore().setSessions([
      session({ cwd: '/wt/a', worktree: worktree('ready', { path: '/wt/a', branch: 'kimi/a', missing: true }) }),
    ]);
    sessionsStore().setActiveSessionId(SID);
    expect(await ws.sendPrompt(ws.createPromptEnvelope({ text: 'blocked' }))).toBe('rejected');

    api.sessionWorktreeAction.mockResolvedValueOnce(session({ cwd: '/workspace', worktree: worktree('local') }));
    expect(await ws.runSessionWorktreeAction(SID, 'useLocal')).toBe(true);

    expect(sessionsStore().sessions[0]).toMatchObject({ cwd: '/workspace', worktree: { setup: { status: 'local' } } });
    expect(sessionsStore().sessions[0]?.worktree?.path).toBeUndefined();
    expect(await ws.sendPrompt(ws.createPromptEnvelope({ text: 'hello' }))).toBe('ok');
    expect(sentTexts(api.submitPrompt)).toEqual(['hello']);
  });

  it('surfaces a rejected source branch as an error, holds nothing and restores the default branch', async () => {
    const { api, ws } = await createRig();
    const environment = newSessionEnvironmentStore();
    api.getWorkspaceGitBranches.mockResolvedValueOnce({
      ...BRANCHES,
      branches: [...BRANCHES.branches, { name: 'gone', committedAt: '2026-11-17T00:00:00.000Z' }],
    });
    await environment.refreshBranches('workspace');
    environment.selectSource('workspace', { branch: 'gone' });
    api.createSession.mockRejectedValueOnce(
      new DaemonApiError({ code: 40001, msg: 'source_branch does not exist', requestId: 'r1' }),
    );

    const started = await start(ws);
    await flush();

    expect(api.createSession.mock.calls[0]![0]).toMatchObject({ worktree: { sourceBranch: 'gone' } });
    expect(started).toEqual({ sessionId: null, promptRejected: false });
    expect(warningsStore().warnings).toHaveLength(1);
    expect(promptStore().heldFirstPromptBySession).toEqual({});
    expect(promptStore().isStartingFirstPrompt).toBe(false);
    expect(sessionsStore().sessions).toEqual([]);
    expect(api.submitPrompt).not.toHaveBeenCalled();
    expect(environment.selection('workspace')).toMatchObject({ branch: { name: 'main' }, isDefault: true });
  });

  it('stops offering Worktree after the server says the project cannot have one', async () => {
    const { api, ws } = await createRig();
    const environment = newSessionEnvironmentStore();
    api.createSession.mockRejectedValueOnce(
      new DaemonApiError({ code: 40938, msg: 'workspace root is not a repository root', requestId: 'r1' }),
    );
    api.getWorkspaceGitBranches.mockResolvedValueOnce({ isRepo: false, dirty: false, remotes: [], branches: [] });

    const started = await start(ws);
    await flush();

    expect(started).toEqual({ sessionId: null, promptRejected: false });
    expect(promptStore().heldFirstPromptBySession).toEqual({});
    expect(environment.availability('workspace')).toBe('notGitRepo');
    expect(environment.effectiveEnvironment('workspace')).toBe('local');

    api.createSession.mockResolvedValueOnce(session());
    const retried = await start(ws);
    expect(retried).toEqual({ sessionId: SID, promptRejected: false });
    expect(Object.hasOwn(api.createSession.mock.calls[1]![0], 'worktree')).toBe(false);
    expect(sentTexts(api.submitPrompt)).toEqual(['hello']);
  });

  it('does not refresh branches for an unrelated create failure', async () => {
    const { api, ws } = await createRig();
    api.getWorkspaceGitBranches.mockClear();
    api.createSession.mockRejectedValueOnce(new Error('network down'));

    const started = await start(ws);
    await flush();

    expect(started).toEqual({ sessionId: null, promptRejected: false });
    expect(api.getWorkspaceGitBranches).not.toHaveBeenCalled();
  });

  it('holds a first skill activation until the worktree is ready', async () => {
    const { modelProvider, ws } = await createRig();

    const started = await ws.startSessionAndActivateSkill('workspace', 'review', 'now');

    expect(started).toEqual({ sessionId: SID, activated: true });
    expect(modelProvider.activateSkill).not.toHaveBeenCalled();
    expect(promptStore().heldFirstPromptBySession[SID]?.content).toEqual([{ type: 'text', text: '/review now' }]);

    setWorktree(worktree('ready', { path: '/wt/a' }), '/wt/a');
    ws.syncWorktreeHold(SID);
    ws.syncWorktreeHold(SID);
    await flush();
    expect(modelProvider.activateSkill).toHaveBeenCalledExactlyOnceWith('review', 'now', undefined, SID, {
      snapshot: undefined,
      skillPath: undefined,
    });
  });
});
