import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppWorkspace, WorktreeLookup } from '@moonshot-ai/app-core/api';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { ToastOptions } from '@moonshot-ai/app-ui';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { onToast } from '../src/client/toast';
import { resetWorktreeManageDialogs, useWorktreeManageDialogs } from '../src/composables/useWorktreeManageDialogs';
import { noopProductTracker, setProductTracker } from '../src/contracts';
import { sessionsStore } from '../src/stores/sessions';
import { workspacesStore } from '../src/stores/workspaces';
import { memoryStorage } from '../src/testing/worktreeFixtures';

const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', memoryStorage(memStorage));

const i18n = createKimiI18n({ locale: 'en' });

const api = {
  addWorkspace: vi.fn<(input: { root: string; name?: string; hostId?: string }) => Promise<AppWorkspace>>(),
  lookupWorktree: vi.fn<(path: string) => Promise<WorktreeLookup | null>>(),
};

function makeWorkspace(id: string, root: string, extra?: Partial<AppWorkspace>): AppWorkspace {
  return {
    id,
    root,
    name: root.split('/').pop() ?? root,
    kind: 'managed',
    sessionCount: 0,
    additionalDirs: [],
    ...extra,
  } as AppWorkspace;
}

const dialogs = useWorktreeManageDialogs();
const project = makeWorkspace('wm_repo', '/code/repo');
let toasts: ToastOptions[];
let offToast: () => void;

async function prompted(): Promise<void> {
  await vi.waitFor(() => expect(dialogs.projectPrompt.value).not.toBeNull());
}

beforeEach(() => {
  memStorage.clear();
  for (const mock of Object.values(api)) mock.mockReset();
  api.addWorkspace.mockImplementation(async (input) => makeWorkspace('wm_new', input.root));
  api.lookupWorktree.mockResolvedValue(null);
  setKimiClientDeps({
    api: () => api as never,
    t: (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params)),
  });
  setProductTracker(noopProductTracker);
  const store = workspacesStore();
  store.workspaces = [project];
  store.storedActiveWorkspaceId = null;
  store.hiddenWorkspaceIds = [];
  store.resetCreateWorkspaceAttempt();
  sessionsStore().setSessions([]);
  resetWorktreeManageDialogs();
  toasts = [];
  offToast = onToast((event) => {
    if (event.type === 'show' && event.options !== undefined) toasts.push(event.options);
  });
});

afterEach(() => {
  offToast();
  resetWorktreeManageDialogs();
  resetKimiClientDeps();
});

describe('adding a directory that is a worktree of an existing project', () => {
  it('adds an ordinary directory without asking', async () => {
    const store = workspacesStore();

    expect(await store.addWorkspaceByPath('/code/other')).toBe(true);

    expect(api.lookupWorktree).toHaveBeenCalledWith('/code/other');
    expect(dialogs.projectPrompt.value).toBeNull();
    expect(api.addWorkspace).toHaveBeenCalledOnce();
    expect(store.storedActiveWorkspaceId).toBe('wm_new');
    expect(toasts).toEqual([]);
  });

  it('does not ask for a worktree whose repository is not a project', async () => {
    api.lookupWorktree.mockResolvedValue({ repoRoot: '/code/unknown', branch: 'kimi/a', sessionCount: 1 });

    expect(await workspacesStore().addWorkspaceByPath('/wt/a')).toBe(true);

    expect(dialogs.projectPrompt.value).toBeNull();
    expect(api.addWorkspace).toHaveBeenCalledOnce();
  });

  it('still adds the directory when the lookup fails', async () => {
    api.lookupWorktree.mockRejectedValue(new Error('offline'));

    expect(await workspacesStore().addWorkspaceByPath('/wt/a')).toBe(true);

    expect(api.addWorkspace).toHaveBeenCalledOnce();
  });

  it('does not ask again for a directory that is already a project', async () => {
    const store = workspacesStore();
    store.workspaces = [project, makeWorkspace('wm_wt', '/wt/a')];
    api.lookupWorktree.mockResolvedValue({ repoRoot: '/code/repo', branch: 'kimi/a', workspace: project, sessionCount: 0 });

    expect(await store.addWorkspaceByPath('/wt/a')).toBe(true);

    expect(api.lookupWorktree).not.toHaveBeenCalled();
    expect(dialogs.projectPrompt.value).toBeNull();
  });

  it('asks with the project, branch and session count, then switches to the existing project', async () => {
    api.lookupWorktree.mockResolvedValue({ repoRoot: '/code/repo', branch: 'kimi/a', workspace: project, sessionCount: 2 });
    const store = workspacesStore();

    const adding = store.addWorkspaceByPath('/wt/a');
    await prompted();
    expect(dialogs.projectPrompt.value).toEqual({ project: 'repo', branch: 'kimi/a', sessionCount: 2 });
    expect(api.addWorkspace).not.toHaveBeenCalled();

    dialogs.answerExistingWorktreeProject('switch');

    expect(await adding).toBe(true);
    expect(api.addWorkspace).not.toHaveBeenCalled();
    expect(store.storedActiveWorkspaceId).toBe('wm_repo');
    expect(store.takeAddWorkspaceCancelled()).toBe(false);
    expect(toasts.map((entry) => [entry.layout, entry.title, entry.duration])).toEqual([
      ['bar', 'Switched to repo.', 8000],
    ]);
  });

  it('creates the new project when the user insists', async () => {
    api.lookupWorktree.mockResolvedValue({ repoRoot: '/code/repo', workspace: project, sessionCount: 0 });
    const store = workspacesStore();

    const adding = store.addWorkspaceByPath('/wt/a');
    await prompted();
    expect(dialogs.projectPrompt.value).toEqual({ project: 'repo', sessionCount: 0 });
    dialogs.answerExistingWorktreeProject('create');

    expect(await adding).toBe(true);
    expect(api.addWorkspace).toHaveBeenCalledWith({ root: '/wt/a', idempotencyKey: expect.any(String) });
    expect(store.storedActiveWorkspaceId).toBe('wm_new');
    expect(toasts).toEqual([]);
  });

  it('adds nothing when the prompt is dismissed and reports the cancellation once', async () => {
    api.lookupWorktree.mockResolvedValue({ repoRoot: '/code/repo', branch: 'kimi/a', workspace: project, sessionCount: 0 });
    const store = workspacesStore();

    const adding = store.addWorkspaceByPath('/wt/a');
    await prompted();
    dialogs.answerExistingWorktreeProject('dismiss');

    expect(await adding).toBe(false);
    expect(api.addWorkspace).not.toHaveBeenCalled();
    expect(store.storedActiveWorkspaceId).toBeNull();
    expect(store.takeAddWorkspaceCancelled()).toBe(true);
    expect(store.takeAddWorkspaceCancelled()).toBe(false);
  });

  it('applies the same prompt to the project dialog', async () => {
    api.lookupWorktree.mockResolvedValue({ repoRoot: '/code/repo', branch: 'kimi/a', workspace: project, sessionCount: 0 });
    const store = workspacesStore();

    const switching = store.createWorkspace({ paths: ['/wt/a'], name: 'Mine' });
    await prompted();
    dialogs.answerExistingWorktreeProject('switch');
    expect(await switching).toEqual(project);
    expect(api.addWorkspace).not.toHaveBeenCalled();

    const cancelling = store.createWorkspace({ paths: ['/wt/a'], name: 'Mine' });
    await prompted();
    dialogs.answerExistingWorktreeProject('dismiss');
    expect(await cancelling).toBeUndefined();
    expect(api.addWorkspace).not.toHaveBeenCalled();

    const creating = store.createWorkspace({ paths: ['/wt/a'], name: 'Mine' });
    await prompted();
    dialogs.answerExistingWorktreeProject('create');
    expect((await creating)?.id).toBe('wm_new');
  });

  it('skips the lookup for a project on a remote host', async () => {
    const store = workspacesStore();

    await store.createWorkspace({ paths: ['/wt/a'], hostId: 'devbox' });

    expect(api.lookupWorktree).not.toHaveBeenCalled();
    expect(api.addWorkspace).toHaveBeenCalledOnce();
  });
});
