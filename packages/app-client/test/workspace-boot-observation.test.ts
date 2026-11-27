import { afterEach, expect, it, vi } from 'vitest';
import type { AppSession, AppSkill, KimiWebApi, ReadRequestOptions, SessionGroupsPage } from '@moonshot-ai/app-core/api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

it('restarts same-session and same-workspace observations after boot', async () => {
  vi.resetModules();
  const { setKimiClientDeps, resetKimiClientDeps } = await import('../src/client/deps');
  const { sessionsStore } = await import('../src/stores/sessions');
  const { sessionListStore } = await import('../src/stores/sessionList');
  const { sessionViewsStore } = await import('../src/stores/sessionViews');
  const { workspacesStore } = await import('../src/stores/workspaces');
  const { modelsStore } = await import('../src/stores/models');
  const { authStore } = await import('../src/stores/auth');
  const { configStore } = await import('../src/stores/config');
  const { filesStore } = await import('../src/stores/files');
  const { warningsStore } = await import('../src/stores/warnings');
  const { sessionReadScope, workspaceReadScope } = await import('../src/client/observationScope');
  const oldSessionSkills = deferred<AppSkill[]>();
  const oldWorkspaceSkills = deferred<AppSkill[]>();
  const newSessionSkills = deferred<AppSkill[]>();
  const newWorkspaceSkills = deferred<AppSkill[]>();
  const groups = deferred<SessionGroupsPage>();
  const session: AppSession = {
    id: 'same', title: 'same', cwd: '/workspace', workspaceId: 'ws1', busy: false,
    archived: false, model: 'model', messageCount: 1, lastPrompt: 'prompt',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      totalCostUsd: 0, contextTokens: 0, contextLimit: 0, turnCount: 0 },
  };
  const api = {
    connectEvents: vi.fn(() => ({
      subscribeConversation: vi.fn(), unsubscribeConversation: vi.fn(),
      health: () => ({ connected: false, open: false, stale: false }), close: vi.fn(),
    })),
    getHealth: vi.fn().mockResolvedValue({ ok: true }),
    getWorkspaceTrust: vi.fn().mockResolvedValue({ trusted: true }),
    listModels: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue(session),
    listSessionGroups: vi.fn().mockReturnValue(groups.promise),
    listSkills: vi.fn().mockReturnValueOnce(oldSessionSkills.promise).mockReturnValueOnce(newSessionSkills.promise),
    listSkillsForWorkspace: vi.fn().mockReturnValueOnce(oldWorkspaceSkills.promise).mockReturnValueOnce(newWorkspaceSkills.promise),
  };
  setKimiClientDeps({ api: () => api as unknown as KimiWebApi, t: key => key });
  cleanups.push(() => {
    sessionsStore().setActiveSessionId(undefined);
    sessionListStore().cancelBackgroundReads();
    sessionViewsStore().stopSessionTimeClock();
    resetKimiClientDeps();
  });
  sessionsStore().setSessions([session]);
  workspacesStore().workspaces = [{ id: 'ws1', root: '/workspace', name: 'workspace', sessionCount: 1 }];
  workspacesStore().storedActiveWorkspaceId = 'ws1';
  vi.spyOn(authStore(), 'checkAuth').mockResolvedValue('proceed');
  vi.spyOn(configStore(), 'refreshServerMeta').mockResolvedValue(undefined);
  vi.spyOn(configStore(), 'loadConfig').mockResolvedValue('committed');
  vi.spyOn(workspacesStore(), 'loadWorkspaces').mockResolvedValue(undefined);
  vi.spyOn(warningsStore(), 'pushOperationFailure').mockImplementation(() => {});
  const git = vi.spyOn(filesStore(), 'loadGitStatus').mockResolvedValue(undefined);
  const warnings = vi.spyOn(warningsStore(), 'refreshSessionWarnings').mockImplementation(() => {});
  const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
  const client = useKimiWebClient();
  await client.selectSession('same');
  await vi.waitFor(() => {
    expect(api.listSkills).toHaveBeenCalledOnce();
    expect(api.listSkillsForWorkspace).toHaveBeenCalledOnce();
  });
  const oldSessionOptions = api.listSkills.mock.calls[0]![1] as ReadRequestOptions;
  const oldWorkspaceOptions = api.listSkillsForWorkspace.mock.calls[0]![1] as ReadRequestOptions;
  const oldLoads = [
    modelsStore().loadSkillsForSession('same', oldSessionOptions),
    modelsStore().loadSkillsForWorkspace('ws1', oldWorkspaceOptions),
  ];

  const boot = client.load();
  expect(oldSessionOptions.signal?.aborted).toBe(true);
  expect(oldWorkspaceOptions.signal?.aborted).toBe(true);
  await vi.waitFor(() => expect(api.listSessionGroups).toHaveBeenCalledOnce());
  expect(api.listSkills).toHaveBeenCalledOnce();
  expect(api.listSkillsForWorkspace).toHaveBeenCalledOnce();
  groups.resolve({
    groups: [{ workspaceId: 'ws1', total: 1, sessions: [session] }],
    hasMore: false, nextPageToken: null, total: 1,
  });
  await boot;
  await vi.waitFor(() => {
    expect(api.listSkills).toHaveBeenCalledTimes(2);
    expect(api.listSkillsForWorkspace).toHaveBeenCalledTimes(2);
  });
  expect(client.activeSessionId.value).toBe('same');
  expect(client.activeWorkspaceId.value).toBe('ws1');
  const newSessionOptions = api.listSkills.mock.calls[1]![1] as ReadRequestOptions;
  const newWorkspaceOptions = api.listSkillsForWorkspace.mock.calls[1]![1] as ReadRequestOptions;
  expect(newSessionOptions.signal).toBe(sessionReadScope.options('same').signal);
  expect(newWorkspaceOptions.signal).toBe(workspaceReadScope.options('ws1').signal);
  expect(newSessionOptions.signal).not.toBe(oldSessionOptions.signal);
  expect(newWorkspaceOptions.signal).not.toBe(oldWorkspaceOptions.signal);
  expect(newSessionOptions.signal?.aborted).toBe(false);
  expect(newWorkspaceOptions.signal?.aborted).toBe(false);
  expect(git).toHaveBeenLastCalledWith('same', newSessionOptions);
  expect(warnings).toHaveBeenLastCalledWith('same', newSessionOptions);

  oldSessionSkills.resolve([{ name: 'obsolete session skill' } as AppSkill]);
  oldWorkspaceSkills.resolve([{ name: 'obsolete workspace skill' } as AppSkill]);
  await Promise.all(oldLoads);
  expect(modelsStore().skillsBySession.same).toBeUndefined();
  expect(modelsStore().skillsByWorkspace.ws1).toBeUndefined();
  newSessionSkills.resolve([{ name: 'new session skill' } as AppSkill]);
  newWorkspaceSkills.resolve([{ name: 'new workspace skill' } as AppSkill]);
  await vi.waitFor(() => {
    expect(client.skillsLoaded.value).toBe(true);
    expect(client.skills.value.map(skill => skill.name)).toEqual(['new session skill']);
    expect(modelsStore().skillsFetchedByWorkspace.ws1).toBe(true);
    expect(modelsStore().skillsByWorkspace.ws1?.map(skill => skill.name)).toEqual(['new workspace skill']);
  });
});

it('loads workspace skills only for a current trusted workspace', async () => {
  vi.resetModules();
  const { setKimiClientDeps, resetKimiClientDeps } = await import('../src/client/deps');
  const { workspacesStore } = await import('../src/stores/workspaces');
  const { sessionListStore } = await import('../src/stores/sessionList');
  const { sessionViewsStore } = await import('../src/stores/sessionViews');
  const { warningsStore } = await import('../src/stores/warnings');
  const reads = new Map([
    ['ws1', deferred<{ trusted: boolean }>()],
    ['ws3', deferred<{ trusted: boolean }>()],
    ['ws4', deferred<{ trusted: boolean }>()],
  ]);
  const listSkillsForWorkspace = vi.fn(async () => []);
  const trustWorkspace = vi.fn(async () => ({ trusted: true }));
  const failure = new Error('trust read failed');
  const api = {
    getWorkspaceTrust: vi.fn((id: string) =>
      id === 'ws2' ? Promise.reject(failure) : reads.get(id)!.promise),
    listSkillsForWorkspace,
    trustWorkspace,
  };
  setKimiClientDeps({ api: () => api as unknown as KimiWebApi, t: key => key });
  vi.spyOn(warningsStore(), 'pushOperationFailure').mockImplementation(() => {});
  const store = workspacesStore();
  store.workspaces = ['ws1', 'ws2', 'ws3', 'ws4'].map(id => ({
    id,
    root: `/${id}`,
    name: id,
    sessionCount: 0,
  }));
  store.storedActiveWorkspaceId = 'ws1';
  cleanups.push(() => {
    store.storedActiveWorkspaceId = null;
    sessionListStore().cancelBackgroundReads();
    sessionViewsStore().stopSessionTimeClock();
    resetKimiClientDeps();
  });
  const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
  const client = useKimiWebClient();

  await vi.waitFor(() => expect(api.getWorkspaceTrust).toHaveBeenCalledWith('ws1', expect.anything()));
  reads.get('ws1')!.resolve({ trusted: false });
  await vi.waitFor(() => expect(client.activeWorkspaceTrust.value).toBe(false));
  expect(listSkillsForWorkspace).not.toHaveBeenCalled();

  client.selectWorkspace('ws2');
  await vi.waitFor(() => expect(client.activeWorkspaceTrustError.value).toBeDefined());
  expect(listSkillsForWorkspace).not.toHaveBeenCalled();

  client.selectWorkspace('ws3');
  await vi.waitFor(() => expect(api.getWorkspaceTrust).toHaveBeenCalledWith('ws3', expect.anything()));
  client.selectWorkspace('ws4');
  await vi.waitFor(() => expect(api.getWorkspaceTrust).toHaveBeenCalledWith('ws4', expect.anything()));
  reads.get('ws3')!.resolve({ trusted: true });
  await Promise.resolve();
  expect(listSkillsForWorkspace).not.toHaveBeenCalled();

  reads.get('ws4')!.resolve({ trusted: true });
  await vi.waitFor(() => expect(listSkillsForWorkspace).toHaveBeenCalledTimes(1));
  expect(listSkillsForWorkspace).toHaveBeenLastCalledWith('ws4', expect.anything());

  await client.trustWorkspace('ws4');
  await vi.waitFor(() => expect(listSkillsForWorkspace).toHaveBeenCalledTimes(2));
  expect(listSkillsForWorkspace).toHaveBeenLastCalledWith('ws4');
});
