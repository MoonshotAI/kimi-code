import { afterEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { AppConfig, AppEvent, AppGoal, AppSession, AppSkill, KimiEventHandlers, KimiWebApi, PromptSubmission, PromptSubmitResult, ReadRequestOptions } from '@moonshot-ai/app-core/api';
import type { CompactionItem, ConversationFrame, ConversationTurn, ToolCallItem } from '@moonshot-ai/app-core/conversation';
import clientSource from '../src/client/useKimiWebClient.ts?raw';
import { agentState } from './agentFrames';

const AT = '2026-01-01T00:00:00.000Z';

function compactionItem(trigger: 'manual' | 'auto'): CompactionItem {
  return { type: 'system', kind: 'compaction', item_id: 'compaction-1', status: 'ended', outcome: 'completed', created_at: AT, trigger };
}

function waitForItem(callId: string, input: unknown): ToolCallItem {
  return { type: 'tool_call', item_id: callId, status: 'running', created_at: AT, started_at: AT, name: 'WaitFor', input };
}

const goalDefaults = {
  goalId: 'goal-a',
  tokensUsed: 0,
  budget: {
    tokenBudget: null, remainingTokens: null, turnBudget: null, remainingTurns: null,
    wallClockBudgetMs: null, remainingWallClockMs: null, overBudget: false,
  },
};

function echoPromptSubmit(status: PromptSubmitResult['status']) {
  return async (_sid: string, input: PromptSubmission): Promise<PromptSubmitResult> => ({
    promptId: input.promptId!,
    userMessageId: input.promptId!,
    status,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup() {
  vi.resetModules();
  vi.stubGlobal('WebSocket', class {});
  const { setKimiClientDeps, resetKimiClientDeps } = await import('../src/client/deps');
  const { sessionsStore } = await import('../src/stores/sessions');
  const { sessionListStore } = await import('../src/stores/sessionList');
  const { configStore } = await import('../src/stores/config');
  const { sessionViewsStore } = await import('../src/stores/sessionViews');
  const { workspacesStore } = await import('../src/stores/workspaces');
  const { filesStore } = await import('../src/stores/files');
  const { goalStore } = await import('../src/stores/goal');
  const { approvalsStore } = await import('../src/stores/approvals');
  const { modelsStore } = await import('../src/stores/models');
  const { tasksStore } = await import('../src/stores/tasks');
  const { warningsStore } = await import('../src/stores/warnings');
  const scopes = await import('../src/client/observationScope');
  const clockModule = await import('../src/client/useTaskClock');
  const createClock = vi.spyOn(clockModule, 'useTaskClock');
  const sessions = ['a', 'b', 'c'].map((id): AppSession => ({
    id, title: id, cwd: '/workspace', workspaceId: 'ws1', busy: false,
    archived: false, model: 'model', messageCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      totalCostUsd: 0, contextTokens: 0, contextLimit: 0, turnCount: 0 },
  }));
  let handlers!: KimiEventHandlers;
  const baselines = new Map<string, ConversationTurn[]>();
  const remoteApi = {
    listModels: vi.fn(async () => [{ id: 'remote-model', model: 'remote-model', provider: 'managed:kimi-code' }]),
    getConfig: vi.fn(async () => ({ providers: {}, defaultModel: 'remote-model' })),
  };
  const api = {
    deviceApi: (deviceId: string | undefined) => (deviceId === 'dev' ? remoteApi : api),
    connectEvents: vi.fn((next: KimiEventHandlers) => {
      handlers = next;
      return {
        subscribeConversation: vi.fn((sid: string, agentId: string) => {
          queueMicrotask(() => handlers.onConversation?.(sid, agentId, {
            type: 'turns',
            turns: agentId === 'main' ? baselines.get(sid) ?? [] : [],
            has_more: false,
          }));
        }),
        unsubscribeConversation: vi.fn(),
        health: () => ({ connected: true, open: true, stale: false }), close: vi.fn(),
      };
    }),
    getSession: vi.fn(async (id: string) => sessions.find(s => s.id === id)!),
    listSkills: vi.fn().mockResolvedValue([]),
    listSkillsForWorkspace: vi.fn().mockResolvedValue([]),
    updateWorkspace: vi.fn(),
    setWorkspacePrimary: vi.fn(),
    trustWorkspace: vi.fn().mockResolvedValue({ trusted: true }),
    getGitStatus: vi.fn().mockResolvedValue({ available: true, entries: [], pullRequest: null }),
    respondApproval: vi.fn().mockResolvedValue({}),
    getSessionWarnings: vi.fn().mockResolvedValue([]),
    generateSessionTitle: vi.fn<KimiWebApi['generateSessionTitle']>().mockResolvedValue(null),
    getFileUrl: (id: string) => `file:${id}`,
  };
  setKimiClientDeps({ api: () => api as unknown as KimiWebApi, t: key => key });
  sessionsStore().setSessions(sessions);
  workspacesStore().workspaces = [{ id: 'ws1', root: '/workspace', name: 'workspace', sessionCount: 3 }];
  workspacesStore().storedActiveWorkspaceId = 'ws1';
  vi.spyOn(warningsStore(), 'pushOperationFailure').mockImplementation(() => {});
  const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
  const client = useKimiWebClient();
  const clock = createClock.mock.results[0]!.value as ReturnType<typeof clockModule.useTaskClock>;
  cleanups.push(() => {
    clock.dispose();
    sessionsStore().setActiveSessionId(undefined);
    sessionListStore().cancelBackgroundReads();
    sessionViewsStore().stopSessionTimeClock();
    resetKimiClientDeps();
  });
  const turn = async (
    state: 'running' | 'completed',
    options: { turnId?: string; ordinal?: number } = {},
  ) => {
    const ordinal = (options.ordinal ?? 1) - 1;
    const header = {
      turn_id: options.turnId ?? 'turn-a', ordinal, turn_number: ordinal + 1, kind: 'agent' as const,
      status: state === 'running' ? 'running' as const : 'ended' as const,
      ...(state === 'completed' ? { outcome: 'completed' as const, ended_at: '2026-01-01T00:00:01.000Z' } : {}),
      started_at: '2026-01-01T00:00:00.000Z', steps: [],
    };
    if (state === 'running') handlers.onAgentState?.('a', 'main', agentState('running'));
    handlers.onConversation?.('a', 'main', { type: state === 'running' ? 'turn.started' : 'turn.ended', turn: header });
    if (state === 'completed') handlers.onAgentState?.('a', 'main', agentState('idle'));
    await new Promise(resolve => setTimeout(resolve, 60));
  };
  const conversation = (sid: string, frame: ConversationFrame, agentId = 'main') => {
    handlers.onConversation?.(sid, agentId, frame);
  };
  const compaction = (sid: string, phase: 'started' | 'completed' | 'cancelled', trigger: 'manual' | 'auto' = 'manual') => {
    if (phase === 'started') {
      handlers.onAgentState?.(sid, 'main', agentState('idle', { compacting: true }));
      return;
    }
    if (phase === 'completed') {
      const header = { turn_id: 'compaction-turn', ordinal: 50, kind: 'system' as const, started_at: AT, steps: [] };
      conversation(sid, { type: 'turn.started', turn: { ...header, status: 'running' } });
      conversation(sid, { type: 'item.ended', turn_id: 'compaction-turn', item: compactionItem(trigger) });
      conversation(sid, { type: 'turn.ended', turn: { ...header, status: 'ended', outcome: 'completed' } });
    } else {
      conversation(sid, { type: 'notice', level: 'warning', title: 'Context compaction did not finish', code: 'compaction.cancelled' });
    }
    handlers.onAgentState?.(sid, 'main', agentState('idle'));
  };
  const waitFor = (sid: string, callId: string, waiting: boolean, agentId = 'main') => {
    conversation(sid, { type: 'turn.started', turn: { turn_id: 'turn-a', ordinal: 0, turn_number: 1, kind: 'agent', status: 'running', started_at: AT, steps: [] } }, agentId);
    handlers.onAgentState?.(sid, agentId, agentState('running'));
    conversation(sid, {
      type: 'item.started',
      turn_id: 'turn-a',
      item: waitForItem(callId, waiting ? { timeout: 60 } : undefined),
    }, agentId);
  };
  const event = (sid: string, appEvent: AppEvent) => {
    handlers.onEvent(appEvent, { sessionId: sid });
  };
  const deviceEvent = (deviceId: string, appEvent: AppEvent) => {
    handlers.onEvent(appEvent, { sessionId: '', deviceId });
  };
  const goal = (sid: string, next: AppGoal | null) => {
    handlers.onAgentGoal?.(sid, 'main', next);
  };
  return { client, api, remoteApi, clock, scopes, goal, deviceEvent, turn, conversation, compaction, waitFor, baselines, event, filesStore, goalStore, approvalsStore, modelsStore, tasksStore, warningsStore, sessionsStore, sessionViewsStore, configStore };
}

async function addRemoteWorkspace() {
  const { workspacesStore } = await import('../src/stores/workspaces');
  const { devicesStore } = await import('../src/stores/devices');
  devicesStore().applySnapshot([{ id: 'dev', connection: 'ssh', host: 'dev', status: 'ready' }]);
  workspacesStore().workspaces = [
    ...workspacesStore().workspaces,
    { id: 'remote-ws', root: '/srv/project', name: 'remote', sessionCount: 0, deviceId: 'dev' },
  ];
  return workspacesStore();
}

it('shows the model catalog of the selected device without reloading local settings', async () => {
  const h = await setup();
  await addRemoteWorkspace();

  h.client.selectWorkspace('remote-ws');
  await vi.waitFor(() => expect(h.modelsStore().activeModels.map((model) => model.id)).toEqual(['remote-model']));
  expect(h.modelsStore().resolveSendModel(null)).toBe('remote-model');
  expect(h.remoteApi.listModels).toHaveBeenCalledTimes(1);
  await nextTick();
  expect(h.api.getConfig).toBeUndefined();
});

it('applies account events from a device to that device only', async () => {
  const h = await setup();
  await addRemoteWorkspace();
  h.modelsStore().setDefaultModel('local-model');
  await h.client.selectSession('a');
  h.client.selectWorkspace('remote-ws');
  await vi.waitFor(() => expect(h.modelsStore().activeModels.map((model) => model.id)).toEqual(['remote-model']));
  const configWrites = vi.spyOn(h.configStore(), 'noteConfigWrite');

  h.remoteApi.listModels.mockResolvedValue([{ id: 'remote-next', model: 'remote-next', provider: 'managed:kimi-code' }]);
  h.deviceEvent('dev', { type: 'modelCatalogChanged', changed: [], unchanged: [], failed: [] });
  await vi.waitFor(() => expect(h.modelsStore().activeModels.map((model) => model.id)).toEqual(['remote-next']));

  h.deviceEvent('dev', { type: 'configChanged', changedFields: ['defaultModel'], config: { providers: {}, defaultModel: 'remote-next' } });
  expect(h.modelsStore().activeDefaultModel).toBe('remote-next');
  expect(h.modelsStore().defaultModel).toBe('local-model');
  expect(configWrites).not.toHaveBeenCalled();
});

it('keeps the order of projects on a device that cannot be reached', async () => {
  await setup();
  const { devicesStore } = await import('../src/stores/devices');
  const workspacesStore = await addRemoteWorkspace();
  const [local] = workspacesStore.workspaces;
  workspacesStore.reorderWorkspaces(['remote-ws', 'ws1']);

  devicesStore().applySnapshot([{ id: 'dev', connection: 'ssh', host: 'dev', status: 'disconnected' }]);
  workspacesStore.workspaces = [local!];
  await nextTick();
  expect(workspacesStore.workspaceOrder).toEqual(['remote-ws', 'ws1']);

  devicesStore().applySnapshot([{ id: 'dev', connection: 'ssh', host: 'dev', status: 'ready' }]);
  await nextTick();
  expect(workspacesStore.workspaceOrder).toEqual(['ws1']);
});

it('lists the projects and sessions of a device again once it is reachable', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  await h.client.selectSession('a');
  const [local] = workspacesStore().workspaces;
  const remote = { id: 'remote-ws', root: '/srv/project', name: 'remote', sessionCount: 1, deviceId: 'dev' };
  const remoteSession: AppSession = {
    ...h.sessionsStore().sessions[0]!,
    id: 's-remote',
    title: 's-remote',
    cwd: '/srv/project',
    workspaceId: 'remote-ws',
    deviceId: 'old-dev',
    lastPrompt: 'hi',
  };
  h.sessionsStore().setSessions([...h.sessionsStore().sessions, remoteSession]);
  const listSessions = vi.fn(async () => ({
    items: [{ ...remoteSession, deviceId: 'dev', title: '' }],
    hasMore: false,
  }));
  Object.assign(h.api, {
    listWorkspaces: vi.fn(async () => [local!, remote]),
    getFsHome: vi.fn(async () => ({ home: '/home', recentRoots: [] })),
    listSessions,
  });

  h.event('', { type: 'devicesChanged', devices: [{ id: 'dev', connection: 'ssh', host: 'dev', status: 'ready' }] });
  h.remoteApi.listModels.mockClear();

  await vi.waitFor(() => expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'remote-ws' })));
  expect(workspacesStore().workspaces.map((workspace) => workspace.id)).toEqual(['ws1', 'remote-ws']);
  expect(h.sessionsStore().sessions.find((s) => s.id === 's-remote')?.deviceId).toBe('dev');
  expect(
    h.sessionViewsStore().workspaceGroups.find((g) => g.workspace.id === 'remote-ws')?.sessions.map((s) => s.id),
  ).toEqual(['s-remote']);
  expect(h.remoteApi.listModels).not.toHaveBeenCalled();

  h.client.selectWorkspace('remote-ws');
  await vi.waitFor(() => expect(h.remoteApi.listModels).toHaveBeenCalledTimes(1));
});

it('cascades cleanup when an SSH device is removed and restores sessions when re-added with a new device id', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  const { sessionListStore } = await import('../src/stores/sessionList');
  await h.client.selectSession('a');
  const [local] = workspacesStore().workspaces;
  const remote = { id: 'remote-ws', root: '/srv/project', name: 'remote', sessionCount: 2, deviceId: 'old-dev' };
  const remoteSession: AppSession = {
    ...h.sessionsStore().sessions[0]!,
    id: 's-remote',
    title: 's-remote',
    cwd: '/srv/project',
    workspaceId: 'remote-ws',
    deviceId: 'old-dev',
    lastPrompt: 'hi',
  };
  const remoteDone: AppSession = {
    ...remoteSession,
    id: 's-remote-done',
    title: 's-remote-done',
  };
  h.event('', { type: 'devicesChanged', devices: [{ id: 'old-dev', connection: 'ssh', host: 'dev', status: 'ready' }] });
  workspacesStore().workspaces = [local!, remote];
  workspacesStore().storedActiveWorkspaceId = 'remote-ws';
  workspacesStore().trustErrorByWorkspaceId = {
    'remote-ws': { operation: 'read', message: 'boom', originalError: new Error('boom') },
  };
  workspacesStore().trustLoadingByWorkspaceId = { 'remote-ws': true };
  h.sessionsStore().setSessions([...h.sessionsStore().sessions, remoteSession]);
  sessionListStore().doneSessions = [remoteDone];
  h.modelsStore().setSkillsForSession('s-remote', [{ name: 'old-skill', description: '', source: 'project' } as never]);
  h.sessionsStore().setActiveSessionId('s-remote');

  let resolveStalePage!: (value: { items: AppSession[]; hasMore: boolean }) => void;
  Object.assign(h.api, {
    listSessions: vi.fn(() => new Promise((resolve) => { resolveStalePage = resolve; })),
  });
  const stalePage = sessionListStore().loadFirstWorkspacePage('remote-ws');

  h.event('', { type: 'devicesChanged', devices: [] });
  expect(h.sessionsStore().activeSessionId).toBeUndefined();
  expect(workspacesStore().activeWorkspaceId).toBe('ws1');
  expect(workspacesStore().workspaces.map((w) => w.id)).toEqual(['ws1']);
  expect(workspacesStore().trustErrorByWorkspaceId['remote-ws']).toBeUndefined();
  expect(workspacesStore().trustLoadingByWorkspaceId['remote-ws']).toBe(false);
  expect(h.sessionsStore().sessions.some((s) => s.id === 's-remote')).toBe(false);
  expect(sessionListStore().doneSessions).toEqual([]);
  expect(h.modelsStore().skillsBySession['s-remote']).toBeUndefined();

  resolveStalePage({ items: [remoteSession], hasMore: false });
  await expect(stalePage).resolves.toBe(false);
  expect(h.sessionsStore().sessions.some((s) => s.id === 's-remote')).toBe(false);

  const readdedRemote = { ...remote, deviceId: 'new-dev' };
  const listSessions = vi.fn(async () => ({
    items: [{ ...remoteSession, deviceId: 'new-dev', title: '' }],
    hasMore: false,
  }));
  Object.assign(h.api, {
    listWorkspaces: vi.fn(async () => [local!, readdedRemote]),
    getFsHome: vi.fn(async () => ({ home: '/home', recentRoots: [] })),
    listSessions,
  });

  h.event('', { type: 'devicesChanged', devices: [{ id: 'new-dev', connection: 'ssh', host: 'dev', status: 'ready' }] });
  await vi.waitFor(() => expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'remote-ws' })));
  expect(workspacesStore().workspaces.map((w) => w.id)).toEqual(['ws1', 'remote-ws']);
  expect(h.sessionsStore().sessions.find((s) => s.id === 's-remote')?.deviceId).toBe('new-dev');
  expect(
    h.sessionViewsStore().workspaceGroups.find((g) => g.workspace.id === 'remote-ws')?.sessions.map((s) => s.id),
  ).toEqual(['s-remote']);
});

it.each(['revisit', 'stay-offscreen'] as const)('owns background turn-end sidecars through %s without stale writes', async (action) => {
  const h = await setup();
  h.api.listSkills.mockRejectedValueOnce(new Error('initial skills unavailable'));
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  await h.client.selectSession('b');
  h.goal('a', { ...goalDefaults, objective: 'initial', status: 'active', turnsUsed: 0, wallClockMs: 0 });
  await h.turn('running');
  const oldGit = deferred<unknown>();
  const oldSkills = deferred<AppSkill[]>();
  const oldWarnings = deferred<unknown[]>();
  h.api.getGitStatus.mockReturnValueOnce(oldGit.promise);
  h.api.listSkills.mockReturnValueOnce(oldSkills.promise);
  h.api.getSessionWarnings.mockReturnValueOnce(oldWarnings.promise);
  await h.turn('completed');
  const backgroundOptions = h.api.getSessionWarnings.mock.calls.at(-1)![1] as ReadRequestOptions;
  expect(backgroundOptions).toEqual({ background: true, signal: expect.any(AbortSignal) });
  expect(backgroundOptions.signal).toBe(h.scopes.sessionReadScope.offscreenOptions('a').signal);
  expect(backgroundOptions.signal?.aborted).toBe(false);
  expect(h.api.getGitStatus).toHaveBeenLastCalledWith('a', undefined, backgroundOptions);
  expect(h.api.listSkills).toHaveBeenLastCalledWith('a', backgroundOptions);

  await h.client.selectSession('c');
  expect(backgroundOptions.signal?.aborted).toBe(false);
  const freshGit = { available: true, branch: 'fresh', entries: [], pullRequest: null };
  const freshSkills = [{ name: 'current' } as AppSkill];
  h.api.getGitStatus.mockResolvedValue(freshGit);
  h.api.listSkills.mockResolvedValue(freshSkills);
  h.api.getSessionWarnings.mockResolvedValue([{ code: 'current', message: 'current', severity: 'warning' }]);
  if (action === 'revisit') {
    await h.client.selectSession('a');
    expect(backgroundOptions.signal?.aborted).toBe(true);
    const currentOptions = h.api.listSkills.mock.calls.at(-1)![1] as ReadRequestOptions;
    expect(currentOptions.signal).toBe(h.scopes.sessionReadScope.options('a').signal);
    expect(currentOptions.signal).not.toBe(backgroundOptions.signal);
    expect(currentOptions.signal?.aborted).toBe(false);
    await vi.waitFor(() => expect(h.filesStore().gitStatusBySession.a).toEqual(freshGit));
  }
  const backgroundGit = { available: true, branch: 'background', entries: [], pullRequest: null };
  const backgroundSkills = [{ name: 'background' } as AppSkill];
  oldGit.resolve(backgroundGit);
  oldSkills.resolve(backgroundSkills);
  oldWarnings.resolve([{ code: 'background', message: 'background', severity: 'warning' }]);
  await Promise.all([oldGit.promise, oldSkills.promise, oldWarnings.promise]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.filesStore().gitStatusBySession.a).toEqual(action === 'revisit' ? freshGit : backgroundGit);
  expect(h.modelsStore().skillsBySession.a).toEqual(action === 'revisit' ? freshSkills : backgroundSkills);
  expect(h.warningsStore().warnings.map(w => typeof w === 'string' ? w : w.title)).toContain(`warnings.noteLabel: ${action === 'revisit' ? 'current' : 'background'}`);
  if (action === 'revisit') expect(h.warningsStore().warnings.map(w => typeof w === 'string' ? w : w.title)).not.toContain('warnings.noteLabel: background');
});

it('requests an auto session title only when the first turn ends', async () => {
  const h = await setup();
  h.configStore().config = {} as AppConfig;
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  await h.turn('running', { turnId: 'turn-0', ordinal: 1 });
  await h.turn('completed', { turnId: 'turn-0', ordinal: 1 });
  expect(h.api.generateSessionTitle).toHaveBeenCalledExactlyOnceWith('a', { source: 'first_turn' });

  h.api.generateSessionTitle.mockClear();
  await h.turn('running', { turnId: 'turn-1', ordinal: 2 });
  await h.turn('completed', { turnId: 'turn-1', ordinal: 2 });
  expect(h.api.generateSessionTitle).not.toHaveBeenCalled();
});

it('applies goal frames for an offscreen session', async () => {
  const h = await setup();
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  await h.client.selectSession('b');
  const goal = { ...goalDefaults, objective: 'background goal', status: 'active' as const, turnsUsed: 2, wallClockMs: 20 };
  h.goal('a', goal);
  expect(h.goalStore().goalBySession.a).toEqual(goal);
  h.goal('a', null);
  expect(h.goalStore().goalBySession.a).toBeUndefined();
});

it('executes the registered HMR cleanup against the real module-owned task clock', async () => {
  const h = await setup();
  await h.client.selectSession('a');
  const offscreen = h.scopes.sessionReadScope.offscreenOptions('background');
  const dispose = vi.spyOn(h.clock, 'dispose');
  const cancel = vi.fn();
  const match = clientSource.match(/if \(import\.meta\.hot\) \{\s*import\.meta\.hot\.dispose\(\(\) => \{([\s\S]*?)\n  \}\);/);
  expect(match).not.toBeNull();
  const cleanup = new Function('taskClock', 'workspaceBoot', 'sessionReadScope', 'workspaceReadScope', 'sessionViewsStore', match![1]!);
  cleanup(h.clock, { cancel }, h.scopes.sessionReadScope, h.scopes.workspaceReadScope, h.sessionViewsStore);
  expect(dispose).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(offscreen.signal?.aborted).toBe(true);
});

it('keeps sends queued while the main agent’s WaitFor waits and steers only on request', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & { submitPrompt: ReturnType<typeof vi.fn>; steerPrompts: ReturnType<typeof vi.fn> };
  api.submitPrompt = vi.fn(echoPromptSubmit('queued'));
  api.steerPrompts = vi.fn().mockResolvedValue({});
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');
  promptStore().queuedBySession = { a: [{ text: 'queued note', attachments: undefined }] };

  h.waitFor('a', 'call-wait', true);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(api.submitPrompt).not.toHaveBeenCalled();

  expect(await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'later note' }))).toBe('queued');
  expect(api.submitPrompt).not.toHaveBeenCalled();
  expect(promptStore().queuedBySession['a']?.map((entry) => entry.text)).toEqual(['queued note', 'later note']);

  expect(await h.client.steerQueued(0)).toBe('ok');
  expect(api.submitPrompt).toHaveBeenCalledTimes(1);
  expect(api.submitPrompt).toHaveBeenCalledWith('a', expect.objectContaining({ content: [{ type: 'text', text: 'queued note' }] }));
  expect(api.steerPrompts).toHaveBeenCalledWith('a', [api.submitPrompt.mock.calls[0]![1].promptId]);
  expect(promptStore().queuedBySession['a']?.map((entry) => entry.text)).toEqual(['later note']);
});

it('tracks session busy windows across active session changes', async () => {
  const h = await setup();
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { nextTick } = await import('vue');
  const { promptStore } = await import('../src/stores/prompt');
  const { setProductTracker, noopProductTracker } = await import('../src/contracts');
  const trackMock = vi.fn();
  let now = 0;
  let longtaskCallback!: (list: { getEntries(): Array<{ duration: number }> }) => void;
  const emitLongtask = (duration: number) => longtaskCallback({ getEntries: () => [{ duration }] });
  vi.stubGlobal('PerformanceObserver', class {
    static supportedEntryTypes = ['longtask'];
    constructor(callback: typeof longtaskCallback) {
      longtaskCallback = callback;
    }
    observe() {}
  });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  setProductTracker({ track: trackMock });
  cleanups.push(() => setProductTracker(noopProductTracker));
  const busyEvents = () => trackMock.mock.calls.filter(([event]) => event === 'session_busy_longtasks');

  promptStore().setInFlight('a', true);
  await nextTick();
  now = 100;
  emitLongtask(80);
  await h.client.selectSession('b');
  await nextTick();

  expect(busyEvents()).toEqual([]);

  promptStore().setInFlight('b', true);
  await nextTick();

  expect(busyEvents()).toEqual([[
    'session_busy_longtasks',
    { session_id: 'a', longtask_count: 1, longtask_total_ms: 80, longtask_max_ms: 80, busy_duration_ms: 100 },
  ]]);

  now = 250;
  emitLongtask(50);
  await h.client.selectSession('a');
  await nextTick();

  expect(busyEvents()[1]).toEqual([
    'session_busy_longtasks',
    { session_id: 'b', longtask_count: 1, longtask_total_ms: 50, longtask_max_ms: 50, busy_duration_ms: 150 },
  ]);
  promptStore().setInFlight('b', false);

  now = 400;
  emitLongtask(60);
  promptStore().setInFlight('a', false);
  await nextTick();
  now = 500;
  promptStore().setInFlight('a', true);
  await nextTick();
  now = 700;
  emitLongtask(40);
  await h.client.selectSession('b');
  await nextTick();

  expect(busyEvents()).toHaveLength(2);

  promptStore().setInFlight('b', true);
  await nextTick();

  expect(busyEvents()).toHaveLength(3);
  expect(busyEvents()[2]).toEqual([
    'session_busy_longtasks',
    { session_id: 'a', longtask_count: 2, longtask_total_ms: 100, longtask_max_ms: 60, busy_duration_ms: 450 },
  ]);
});

it('queues /compact while busy, rejects duplicates, fires it FIFO, and holds the flush until compaction ends', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & {
    compactSession: ReturnType<typeof vi.fn>;
    submitPrompt: ReturnType<typeof vi.fn>;
  };
  api.compactSession = vi.fn().mockResolvedValue({});
  api.submitPrompt = vi.fn(echoPromptSubmit('running'));
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');

  promptStore().inFlightBySession = { a: true };
  expect(h.client.compact('shorter')).toBe('queued');
  expect(api.compactSession).not.toHaveBeenCalled();
  expect(h.client.compact()).toBe('duplicate');
  const queued = promptStore().queuedBySession['a'] ?? [];
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ kind: 'compact', instruction: 'shorter' });

  promptStore().inFlightBySession = {};
  const outcome = await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'follow up' }));
  expect(outcome).toBe('queued');
  await vi.waitFor(() => expect(api.compactSession).toHaveBeenCalledWith('a', 'shorter'));
  expect(api.submitPrompt).not.toHaveBeenCalled();
  expect(h.client.compact()).toBe('compacting');
  expect(promptStore().queuedBySession['a'] ?? []).toHaveLength(1);

  const third = await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'third' }));
  expect(third).toBe('queued');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.submitPrompt).not.toHaveBeenCalled();

  h.compaction('a', 'started');
  h.compaction('a', 'completed');
  await vi.waitFor(() =>
    expect(api.submitPrompt).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ content: [{ type: 'text', text: 'follow up' }] }),
    ),
  );
  expect(api.compactSession.mock.invocationCallOrder[0]!).toBeLessThan(
    api.submitPrompt.mock.invocationCallOrder[0]!,
  );
});

it('queues prompts behind a held or active compaction instead of submitting them directly', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & { submitPrompt: ReturnType<typeof vi.fn> };
  api.submitPrompt = vi.fn(echoPromptSubmit('running'));
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');

  promptStore().holdCompactFlush('a');
  const held = await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'during compact' }));
  expect(held).toBe('queued');
  expect(api.submitPrompt).not.toHaveBeenCalled();

  promptStore().releaseCompactFlush('a');
  h.compaction('a', 'started');
  const active = await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'still busy' }));
  expect(active).toBe('queued');
  expect(api.submitPrompt).not.toHaveBeenCalledWith(
    'a',
    expect.objectContaining({ content: [{ type: 'text', text: 'still busy' }] }),
  );
});

it('settles a registered compaction wait as request-failed when a queued compact exhausts its retries', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & {
    compactSession: ReturnType<typeof vi.fn>;
    submitPrompt: ReturnType<typeof vi.fn>;
  };
  api.compactSession = vi.fn().mockRejectedValue(new Error('500'));
  api.submitPrompt = vi.fn(echoPromptSubmit('running'));
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');
  const { modelSwitchConfirmStore } = await import('../src/stores/modelSwitchConfirm');
  modelSwitchConfirmStore().resetForTest();
  const wait = modelSwitchConfirmStore().waitCompactionSettled('a', 30_000);

  promptStore().inFlightBySession = { a: true };
  expect(h.client.compact()).toBe('queued');
  promptStore().inFlightBySession = {};
  const follow = await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'follow up' }));
  expect(follow).toBe('queued');
  await vi.waitFor(() => expect(api.compactSession).toHaveBeenCalledTimes(1));

  await vi.waitFor(() => expect(api.compactSession).toHaveBeenCalledTimes(3), { timeout: 10_000 });
  await expect(wait).resolves.toBe('request-failed');
  await vi.waitFor(() =>
    expect(api.submitPrompt).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ content: [{ type: 'text', text: 'follow up' }] }),
    ),
  );
});

it('settles a registered compaction wait from the compaction item and leaves the queue resume to the waiter', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & { submitPrompt: ReturnType<typeof vi.fn> };
  api.submitPrompt = vi.fn(echoPromptSubmit('running'));
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');
  const { modelSwitchConfirmStore } = await import('../src/stores/modelSwitchConfirm');
  modelSwitchConfirmStore().resetForTest();

  promptStore().queuedBySession = { a: [{ text: 'follow up', attachments: undefined }] };
  promptStore().holdCompactFlush('a');
  const wait = modelSwitchConfirmStore().waitCompactionSettled('a', 1_000);

  h.compaction('a', 'started');
  h.compaction('a', 'completed');

  await expect(wait).resolves.toBe('completed');
  expect(api.submitPrompt).not.toHaveBeenCalled();
  expect(promptStore().isCompactFlushHeld('a')).toBe(true);
});

it('rejects /compact while a compaction is running and sends directly once it ends', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & { compactSession: ReturnType<typeof vi.fn> };
  api.compactSession = vi.fn().mockResolvedValue({});
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');

  h.compaction('a', 'started');
  expect(h.client.compact()).toBe('compacting');
  expect(api.compactSession).not.toHaveBeenCalled();
  expect(promptStore().queuedBySession['a'] ?? []).toHaveLength(0);

  h.compaction('a', 'completed');
  expect(h.client.compact('shorter')).toBe('sent');
  await vi.waitFor(() => expect(api.compactSession).toHaveBeenCalledWith('a', 'shorter'));
});

it('reports compaction as running immediately while compactSession is in flight and clears on failure', async () => {
  const h = await setup();
  let rejectCompact!: (error: Error) => void;
  const api = h.api as typeof h.api & { compactSession: ReturnType<typeof vi.fn> };
  api.compactSession = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        rejectCompact = reject;
      }),
  );
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));

  expect(h.client.compaction.value).toBeNull();
  expect(h.client.wouldEnqueuePrompt()).toBe(false);
  expect(h.client.compact()).toBe('sent');
  expect(h.client.compaction.value).toEqual({ status: 'running' });
  expect(h.client.wouldEnqueuePrompt()).toBe(true);
  expect(h.client.compact()).toBe('compacting');
  expect(api.compactSession).toHaveBeenCalledTimes(1);

  rejectCompact(new Error('network down'));
  await vi.waitFor(() => expect(h.client.compaction.value).toBeNull());
  expect(h.client.wouldEnqueuePrompt()).toBe(false);
});

it('skips a queued /compact when an auto compaction completed while it waited', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & {
    compactSession: ReturnType<typeof vi.fn>;
    submitPrompt: ReturnType<typeof vi.fn>;
  };
  api.compactSession = vi.fn().mockResolvedValue({});
  api.submitPrompt = vi.fn(echoPromptSubmit('running'));
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');

  promptStore().enqueueCompactForSession('a', 'focus on tools');
  const head = (promptStore().queuedBySession['a'] ?? [])[0]!;
  promptStore().setQueuedEntries('a', [{ ...head, enqueuedAt: Date.now() - 60_000 }]);
  h.compaction('a', 'started', 'auto');
  h.compaction('a', 'completed', 'auto');

  await vi.waitFor(() => expect(promptStore().queuedBySession['a'] ?? []).toHaveLength(0));
  expect(api.compactSession).not.toHaveBeenCalled();
  const titles = h.warningsStore().warnings.map((w) => (typeof w === 'string' ? w : w.title));
  expect(titles).toContain('commands.compactQueue.skippedAuto');

  const outcome = await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'follow up' }));
  expect(outcome).toBe('ok');
  await vi.waitFor(() =>
    expect(api.submitPrompt).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ content: [{ type: 'text', text: 'follow up' }] }),
    ),
  );
});

it('requeues a failed queued /compact at the head and drops it after the retry budget', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & {
    compactSession: ReturnType<typeof vi.fn>;
    submitPrompt: ReturnType<typeof vi.fn>;
  };
  api.compactSession = vi.fn().mockRejectedValue(new Error('COMPACTION_UNABLE'));
  api.submitPrompt = vi.fn(echoPromptSubmit('running'));
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');

  promptStore().enqueueCompactForSession('a');
  await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'follow up' }));
  await vi.waitFor(() =>
    expect((promptStore().queuedBySession['a'] ?? [])[0]?.compactRetries).toBe(1),
  );
  expect(api.compactSession).toHaveBeenCalledTimes(1);
  expect(api.submitPrompt).not.toHaveBeenCalled();

  promptStore().setQueuedEntries('a', []);
  promptStore().enqueueCompactForSession('a');
  const head = (promptStore().queuedBySession['a'] ?? [])[0]!;
  promptStore().setQueuedEntries('a', [{ ...head, compactRetries: 2 }]);
  await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'after drop' }));
  await vi.waitFor(() =>
    expect(api.submitPrompt).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ content: [{ type: 'text', text: 'after drop' }] }),
    ),
  );
  expect(api.compactSession).toHaveBeenCalledTimes(2);
  expect(promptStore().queuedBySession['a'] ?? []).toHaveLength(0);
  expect(h.warningsStore().pushOperationFailure).toHaveBeenCalledWith(
    'compact',
    expect.any(Error),
    { sessionId: 'a' },
  );
});

it('settles a running compaction from the page a reconnect delivers', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & {
    compactSession: ReturnType<typeof vi.fn>;
    submitPrompt: ReturnType<typeof vi.fn>;
  };
  api.compactSession = vi.fn().mockResolvedValue({});
  api.submitPrompt = vi.fn(echoPromptSubmit('running'));
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');

  promptStore().inFlightBySession = { a: true };
  expect(h.client.compact('shorter')).toBe('queued');
  promptStore().inFlightBySession = {};
  expect(await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'follow up' }))).toBe('queued');
  await vi.waitFor(() => expect(api.compactSession).toHaveBeenCalledWith('a', 'shorter'));
  h.compaction('a', 'started');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.submitPrompt).not.toHaveBeenCalled();

  h.conversation('a', {
    type: 'turns',
    turns: [{
      turn_id: 'compaction-turn', ordinal: 50, kind: 'system', status: 'ended', outcome: 'completed', started_at: AT, steps: [],
      items: [compactionItem('manual')],
    }],
    has_more: false,
  });
  await vi.waitFor(() =>
    expect(api.submitPrompt).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ content: [{ type: 'text', text: 'follow up' }] }),
    ),
  );
});

it('retries a failed queued /compact once the turn that kept the session busy ends', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & { compactSession: ReturnType<typeof vi.fn> };
  api.compactSession = vi.fn().mockRejectedValue(new Error('COMPACTION_UNABLE'));
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');

  vi.useFakeTimers();
  try {
    promptStore().enqueueCompactForSession('a');
    expect(await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'follow up' }))).toBe('queued');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.compactSession).toHaveBeenCalledTimes(1);
    expect((promptStore().queuedBySession['a'] ?? [])[0]?.compactRetries).toBe(1);

    const running = h.turn('running');
    await vi.advanceTimersByTimeAsync(5_000);
    await running;
    expect(api.compactSession).toHaveBeenCalledTimes(1);
    expect((promptStore().queuedBySession['a'] ?? [])[0]?.compactRetries).toBe(1);

    const ended = h.turn('completed');
    await vi.advanceTimersByTimeAsync(100);
    await ended;
    expect(api.compactSession).toHaveBeenCalledTimes(2);
    expect((promptStore().queuedBySession['a'] ?? [])[0]?.compactRetries).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it('waits for an active compaction before firing a queued /compact', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & {
    compactSession: ReturnType<typeof vi.fn>;
    submitPrompt: ReturnType<typeof vi.fn>;
  };
  api.compactSession = vi.fn().mockResolvedValue({});
  api.submitPrompt = vi.fn(echoPromptSubmit('running'));
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');

  h.compaction('a', 'started');
  promptStore().enqueueCompactForSession('a', 'focus');
  expect(await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'follow up' }))).toBe('queued');
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(api.compactSession).not.toHaveBeenCalled();
  expect(api.submitPrompt).not.toHaveBeenCalled();
  expect(promptStore().queuedBySession['a'] ?? []).toHaveLength(2);

  h.compaction('a', 'completed');
  await vi.waitFor(
    () => expect(api.compactSession).toHaveBeenCalledWith('a', 'focus'),
    { timeout: 3000, interval: 50 },
  );
  expect(api.submitPrompt).not.toHaveBeenCalled();
});

it('does not requeue a /compact whose POST rejects after the compaction ended and released the hold', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & {
    compactSession: ReturnType<typeof vi.fn>;
    submitPrompt: ReturnType<typeof vi.fn>;
  };
  let rejectCompact!: (err: Error) => void;
  api.compactSession = vi.fn(() => new Promise((_, reject) => { rejectCompact = reject; }));
  api.submitPrompt = vi.fn(echoPromptSubmit('running'));
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');

  promptStore().enqueueCompactForSession('a', 'focus');
  expect(await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'follow up' }))).toBe('queued');
  await vi.waitFor(() => expect(api.compactSession).toHaveBeenCalledWith('a', 'focus'));

  h.compaction('a', 'started');
  h.compaction('a', 'completed');
  await vi.waitFor(() =>
    expect(api.submitPrompt).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ content: [{ type: 'text', text: 'follow up' }] }),
    ),
  );

  rejectCompact(new Error('connection lost'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(api.compactSession).toHaveBeenCalledTimes(1);
  expect((promptStore().queuedBySession['a'] ?? []).some((entry) => entry.kind === 'compact')).toBe(false);
  expect(h.warningsStore().pushOperationFailure).not.toHaveBeenCalledWith(
    'compact',
    expect.anything(),
    expect.anything(),
  );
});

it('keeps the live draft editText when the compact barrier reroutes it to the queue tail', async () => {
  const h = await setup();
  const api = h.api as typeof h.api & { submitPrompt: ReturnType<typeof vi.fn>; steerPrompts: ReturnType<typeof vi.fn> };
  api.submitPrompt = vi.fn(echoPromptSubmit('queued'));
  api.steerPrompts = vi.fn().mockResolvedValue({});
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  const { promptStore } = await import('../src/stores/prompt');
  promptStore().enqueueCompactForSession('a', 'focus');
  h.waitFor('a', 'call-wait', true);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const outcome = await h.client.sendPrompt(
    h.client.createPromptEnvelope({ text: 'live draft' }),
    'live draft edit text',
  );
  expect(outcome).toBe('queued');
  expect(api.submitPrompt).not.toHaveBeenCalled();
  const queued = promptStore().queuedBySession['a'] ?? [];
  expect(queued).toHaveLength(2);
  expect(queued[0]?.kind).toBe('compact');
  expect(queued[1]).toMatchObject({ text: 'live draft', editText: 'live draft edit text' });
});

it('refreshes workspace and active session skills with scoped reads when source dirs change', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  workspacesStore().trustByWorkspaceId = { ws1: true, ws2: true };
  workspacesStore().workspaces = [
    ...workspacesStore().workspaces,
    { id: 'ws2', root: '/other', name: 'other', sessionCount: 0 },
  ];
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  h.api.listSkillsForWorkspace.mockClear();
  h.api.listSkills.mockClear();

  h.event('a', {
    type: 'workspaceUpdated',
    workspace: {
      id: 'ws1',
      root: '/workspace',
      name: 'workspace',
      sessionCount: 3,
      additionalDirs: ['/additional'],
    },
  });

  await vi.waitFor(() => {
    expect(h.api.listSkillsForWorkspace).toHaveBeenCalledWith('ws1', expect.anything());
    expect(h.api.listSkills).toHaveBeenCalledWith('a', expect.anything());
  });
  const workspaceOptions = h.api.listSkillsForWorkspace.mock.calls.at(-1)![1] as ReadRequestOptions;
  const sessionOptions = h.api.listSkills.mock.calls.at(-1)![1] as ReadRequestOptions;
  expect(workspaceOptions.signal).toBe(h.scopes.workspaceReadScope.options('ws1').signal);
  expect(sessionOptions.signal).toBe(h.scopes.sessionReadScope.options('a').signal);

  h.client.selectWorkspace('ws2');
  await vi.waitFor(() => expect(workspaceOptions.signal?.aborted).toBe(true));
});

it('refreshes skills once when a local save responds before its workspace event', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  workspacesStore().trustByWorkspaceId = { ws1: true };
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  h.api.listSkillsForWorkspace.mockClear();
  h.api.listSkills.mockClear();
  const current = workspacesStore().workspaces.find((workspace) => workspace.id === 'ws1')!;
  const updated = { ...current, additionalDirs: ['/rest-first'] };
  h.api.updateWorkspace.mockResolvedValue(updated);

  await expect(
    workspacesStore().saveWorkspace({ id: 'ws1', additionalDirs: ['/rest-first'] }),
  ).resolves.toBe(true);
  await vi.waitFor(() => {
    expect(h.api.listSkillsForWorkspace).toHaveBeenCalledTimes(1);
    expect(h.api.listSkills).toHaveBeenCalledTimes(1);
  });
  h.event('a', { type: 'workspaceUpdated', workspace: updated });
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(h.api.listSkillsForWorkspace).toHaveBeenCalledTimes(1);
  expect(h.api.listSkills).toHaveBeenCalledTimes(1);
});

it('refreshes skills once when a workspace event precedes a local primary response', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  workspacesStore().trustByWorkspaceId = { ws1: true };
  const current = {
    ...workspacesStore().workspaces.find((workspace) => workspace.id === 'ws1')!,
    additionalDirs: ['/primary'],
  };
  workspacesStore().workspaces = [current];
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  h.api.listSkillsForWorkspace.mockClear();
  h.api.listSkills.mockClear();
  const updated = { ...current, root: '/primary', additionalDirs: ['/workspace'] };
  const response = deferred<Awaited<ReturnType<KimiWebApi['setWorkspacePrimary']>>>();
  h.api.setWorkspacePrimary.mockReturnValue(response.promise);
  const saving = workspacesStore().setWorkspacePrimary({ id: 'ws1', path: '/primary' });
  await vi.waitFor(() => expect(h.api.setWorkspacePrimary).toHaveBeenCalledOnce());

  h.event('a', { type: 'workspaceUpdated', workspace: updated });
  await vi.waitFor(() => {
    expect(h.api.listSkillsForWorkspace).toHaveBeenCalledTimes(1);
    expect(h.api.listSkills).toHaveBeenCalledTimes(1);
  });
  response.resolve(updated);
  await expect(saving).resolves.toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(h.api.listSkillsForWorkspace).toHaveBeenCalledTimes(1);
  expect(h.api.listSkills).toHaveBeenCalledTimes(1);
});

it('reloads stale workspace and session skills when revisiting a background workspace', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  workspacesStore().trustByWorkspaceId = { ws1: true, ws2: true };
  workspacesStore().workspaces = [
    ...workspacesStore().workspaces,
    { id: 'ws2', root: '/other', name: 'other', sessionCount: 0 },
  ];
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  await h.modelsStore().loadSkillsForWorkspace('ws1');
  await h.modelsStore().loadSkillsForSession('a');
  h.client.selectWorkspace('ws2');
  await vi.waitFor(() => expect(h.client.activeWorkspaceId.value).toBe('ws2'));
  h.api.listSkillsForWorkspace.mockClear();
  h.api.listSkills.mockClear();

  h.event('a', {
    type: 'workspaceUpdated',
    workspace: {
      id: 'ws1',
      root: '/workspace',
      name: 'workspace',
      sessionCount: 3,
      additionalDirs: ['/background'],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.api.listSkillsForWorkspace).not.toHaveBeenCalledWith('ws1', expect.anything());
  expect(h.api.listSkills).not.toHaveBeenCalledWith('a', expect.anything());

  h.client.selectWorkspace('ws1');
  await h.client.selectSession('a');
  await vi.waitFor(() => {
    expect(h.api.listSkillsForWorkspace).toHaveBeenCalledWith('ws1', expect.anything());
    expect(h.api.listSkills).toHaveBeenCalledWith('a', expect.anything());
  });
});

it('retries stale workspace skills after a roots refresh is cancelled by a workspace switch', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  workspacesStore().trustByWorkspaceId = { ws1: true, ws2: true };
  workspacesStore().workspaces = [
    ...workspacesStore().workspaces,
    { id: 'ws2', root: '/other', name: 'other', sessionCount: 0 },
  ];
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  await h.modelsStore().loadSkillsForWorkspace('ws1');
  h.api.listSkillsForWorkspace.mockClear();
  const workspaceRequest = deferred<AppSkill[]>();
  h.api.listSkillsForWorkspace.mockReturnValueOnce(workspaceRequest.promise);

  h.event('a', {
    type: 'workspaceUpdated',
    workspace: {
      id: 'ws1',
      root: '/workspace',
      name: 'workspace',
      sessionCount: 3,
      additionalDirs: ['/cancelled'],
    },
  });
  await vi.waitFor(() => expect(h.api.listSkillsForWorkspace).toHaveBeenCalledTimes(1));
  h.client.selectWorkspace('ws2');
  await vi.waitFor(() => expect(h.client.activeWorkspaceId.value).toBe('ws2'));
  workspaceRequest.resolve([]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.api.listSkillsForWorkspace.mockClear();

  h.client.selectWorkspace('ws1');
  await vi.waitFor(() => {
    expect(h.api.listSkillsForWorkspace).toHaveBeenCalledWith('ws1', expect.anything());
  });
});

it('retries stale session skills after a roots refresh is cancelled by a session switch', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  workspacesStore().trustByWorkspaceId = { ws1: true };
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  await h.modelsStore().loadSkillsForSession('a');
  h.api.listSkills.mockClear();
  const sessionRequest = deferred<AppSkill[]>();
  h.api.listSkills.mockReturnValueOnce(sessionRequest.promise);

  h.event('a', {
    type: 'workspaceUpdated',
    workspace: {
      id: 'ws1',
      root: '/workspace',
      name: 'workspace',
      sessionCount: 3,
      additionalDirs: ['/session-cancelled'],
    },
  });
  await vi.waitFor(() => expect(h.api.listSkills).toHaveBeenCalledTimes(1));
  const cancelledOptions = h.api.listSkills.mock.calls[0]![1] as ReadRequestOptions;
  await h.client.selectSession('b');
  await vi.waitFor(() => expect(cancelledOptions.signal?.aborted).toBe(true));
  sessionRequest.resolve([]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.api.listSkills.mockClear();

  await h.client.selectSession('a');
  await vi.waitFor(() => {
    expect(h.api.listSkills).toHaveBeenCalledWith('a', expect.anything());
  });
});

it('does not reuse stale in-flight skills requests after roots change', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  workspacesStore().trustByWorkspaceId = { ws1: true };
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  await h.modelsStore().loadSkillsForWorkspace('ws1');
  await h.modelsStore().loadSkillsForSession('a');
  h.api.listSkillsForWorkspace.mockClear();
  h.api.listSkills.mockClear();
  const oldWorkspaceRequest = deferred<AppSkill[]>();
  const oldSessionRequest = deferred<AppSkill[]>();
  h.api.listSkillsForWorkspace.mockReturnValueOnce(oldWorkspaceRequest.promise);
  h.api.listSkills.mockReturnValueOnce(oldSessionRequest.promise);
  const oldWorkspaceLoad = h.modelsStore().loadSkillsForWorkspace(
    'ws1',
    h.scopes.workspaceReadScope.options('ws1'),
  );
  const oldSessionLoad = h.modelsStore().loadSkillsForSession(
    'a',
    h.scopes.sessionReadScope.options('a'),
  );

  h.event('a', {
    type: 'workspaceUpdated',
    workspace: {
      id: 'ws1',
      root: '/workspace',
      name: 'workspace',
      sessionCount: 3,
      additionalDirs: ['/fresh'],
    },
  });
  oldWorkspaceRequest.resolve([{ name: 'stale-workspace' } as AppSkill]);
  oldSessionRequest.resolve([{ name: 'stale-session' } as AppSkill]);
  await Promise.all([oldWorkspaceLoad, oldSessionLoad]);
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(h.api.listSkillsForWorkspace).toHaveBeenCalledTimes(2);
  expect(h.api.listSkills).toHaveBeenCalledTimes(2);
  expect(h.modelsStore().skillsByWorkspace.ws1?.map((skill) => skill.name)).not.toContain(
    'stale-workspace',
  );
  expect(h.modelsStore().skillsBySession.a?.map((skill) => skill.name)).not.toContain(
    'stale-session',
  );
});

it('retries failed skills refreshes for the same roots and dedupes after success', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  workspacesStore().trustByWorkspaceId = { ws1: true };
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  h.api.listSkillsForWorkspace.mockClear();
  h.api.listSkills.mockClear();
  const updated = {
    id: 'ws1',
    root: '/workspace',
    name: 'workspace',
    sessionCount: 3,
    additionalDirs: ['/retry'],
  };
  h.api.listSkillsForWorkspace.mockRejectedValueOnce(new Error('workspace unavailable'));
  h.api.listSkills.mockRejectedValueOnce(new Error('session unavailable'));

  h.event('a', { type: 'workspaceUpdated', workspace: updated });
  await vi.waitFor(() => {
    expect(h.api.listSkillsForWorkspace).toHaveBeenCalledTimes(1);
    expect(h.api.listSkills).toHaveBeenCalledTimes(1);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  h.event('a', { type: 'workspaceUpdated', workspace: updated });
  await vi.waitFor(() => {
    expect(h.api.listSkillsForWorkspace).toHaveBeenCalledTimes(2);
    expect(h.api.listSkills).toHaveBeenCalledTimes(2);
  });
  expect(Object.prototype.hasOwnProperty.call(h.modelsStore().skillsByWorkspace, 'ws1')).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(h.modelsStore().skillsBySession, 'a')).toBe(true);

  h.event('a', { type: 'workspaceUpdated', workspace: updated });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.api.listSkillsForWorkspace).toHaveBeenCalledTimes(2);
  expect(h.api.listSkills).toHaveBeenCalledTimes(2);
});

it('refreshes the active session after trusting a workspace with invalidated roots', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  workspacesStore().trustByWorkspaceId = { ws1: false };
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  await h.modelsStore().loadSkillsForSession('a');
  h.api.listSkillsForWorkspace.mockClear();
  h.api.listSkills.mockClear();
  const updated = {
    id: 'ws1',
    root: '/workspace',
    name: 'workspace',
    sessionCount: 3,
    additionalDirs: ['/pending-trust'],
  };
  h.event('a', { type: 'workspaceUpdated', workspace: updated });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.api.listSkillsForWorkspace).not.toHaveBeenCalled();
  expect(h.api.listSkills).not.toHaveBeenCalled();

  await h.client.trustWorkspace('ws1');

  await vi.waitFor(() => {
    expect(h.api.listSkillsForWorkspace).toHaveBeenCalledWith('ws1');
    expect(h.api.listSkills).toHaveBeenCalledWith('a', expect.anything());
  });
});

it('does not refresh skills for metadata-only workspace updates', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  workspacesStore().trustByWorkspaceId = { ws1: true };
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  h.api.listSkillsForWorkspace.mockClear();
  h.api.listSkills.mockClear();

  h.event('a', {
    type: 'workspaceUpdated',
    workspace: {
      id: 'ws1',
      root: '/workspace',
      name: 'renamed',
      sessionCount: 4,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(h.api.listSkillsForWorkspace).not.toHaveBeenCalled();
  expect(h.api.listSkills).not.toHaveBeenCalled();
});

it('does not refresh skills for untrusted or non-current workspaces', async () => {
  const h = await setup();
  const { workspacesStore } = await import('../src/stores/workspaces');
  workspacesStore().trustByWorkspaceId = { ws1: false, ws2: true };
  workspacesStore().workspaces = [
    ...workspacesStore().workspaces,
    { id: 'ws2', root: '/other', name: 'other', sessionCount: 0 },
  ];
  await h.client.selectSession('a');
  await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
  h.api.listSkillsForWorkspace.mockClear();
  h.api.listSkills.mockClear();

  h.event('a', {
    type: 'workspaceUpdated',
    workspace: {
      id: 'ws1',
      root: '/workspace',
      name: 'workspace',
      sessionCount: 3,
      additionalDirs: ['/additional'],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.api.listSkillsForWorkspace).not.toHaveBeenCalled();
  expect(h.api.listSkills).not.toHaveBeenCalled();

  workspacesStore().trustByWorkspaceId = { ws1: true, ws2: true };
  h.client.selectWorkspace('ws2');
  await vi.waitFor(() => expect(h.client.activeWorkspaceId.value).toBe('ws2'));
  await vi.waitFor(() => expect(h.api.listSkillsForWorkspace).toHaveBeenCalledWith('ws2', expect.anything()));
  h.api.listSkillsForWorkspace.mockClear();
  h.api.listSkills.mockClear();
  h.event('a', {
    type: 'workspaceUpdated',
    workspace: {
      id: 'ws1',
      root: '/workspace',
      name: 'workspace',
      sessionCount: 3,
      additionalDirs: ['/additional'],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.api.listSkillsForWorkspace).not.toHaveBeenCalled();
  expect(h.api.listSkills).not.toHaveBeenCalled();
});
