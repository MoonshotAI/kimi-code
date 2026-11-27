import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppWorkspace, WorkspaceGitBranches } from '@moonshot-ai/app-core/api';
import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { clientNewSessionEnvironmentHost } from '../src/composables/useNewSessionEnvironment';
import { useNewSessionEnvironmentStore } from '../src/stores/newSessionEnvironment';
import { workspacesStore } from '../src/stores/workspaces';
import { memoryStorage } from '../src/testing/worktreeFixtures';

const getWorkspaceGitBranches = vi.fn<(workspaceId: string) => Promise<WorkspaceGitBranches>>();

function workspace(id: string, overrides: Partial<AppWorkspace> = {}): AppWorkspace {
  return { id, root: `/${id}`, name: id, kind: 'managed', additionalDirs: [], sessionCount: 0, ...overrides };
}

function repo(overrides: Partial<WorkspaceGitBranches> = {}): WorkspaceGitBranches {
  return {
    isRepo: true,
    remotes: ['origin'],
    headBranch: 'main',
    dirty: false,
    branches: [
      { name: 'topic', committedAt: '2026-11-18T00:00:00.000Z' },
      { name: 'main', committedAt: '2026-11-17T00:00:00.000Z', remoteRef: 'origin/main' },
    ],
    ...overrides,
  };
}

function freshStore(environment?: 'worktree') {
  const store = useNewSessionEnvironmentStore(createPinia());
  store.bindHost(clientNewSessionEnvironmentHost);
  if (environment !== undefined) store.selectEnvironment(environment);
  return store;
}

let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', memoryStorage(storage));
  getWorkspaceGitBranches.mockReset();
  getWorkspaceGitBranches.mockResolvedValue(repo());
  setKimiClientDeps({
    api: () => ({ getWorkspaceGitBranches }) as never,
    t: (key) => key,
  });
  const store = workspacesStore();
  store.workspaces = [workspace('git'), workspace('plain'), workspace('remote', { hostId: 'dev' })];
  store.hiddenWorkspaceIds = [];
  store.storedActiveWorkspaceId = 'git';
});

afterEach(() => {
  workspacesStore().workspaces = [];
  workspacesStore().storedActiveWorkspaceId = null;
  resetKimiClientDeps();
  vi.unstubAllGlobals();
});

describe('new session environment', () => {
  it('starts every run in Local and never persists the choice', async () => {
    const first = freshStore();
    expect(first.preferred).toBe('local');
    first.selectEnvironment('worktree');
    await first.ensureBranches('git');
    expect(first.effectiveEnvironment('git')).toBe('worktree');

    const restarted = freshStore();
    expect(restarted.preferred).toBe('local');
    expect(restarted.effectiveEnvironment('git')).toBe('local');
    expect(restarted.worktreeRequest('git')).toBeUndefined();
  });


  it('is temporarily unavailable while the git check is loading', async () => {
    const pending = Promise.withResolvers<WorkspaceGitBranches>();
    getWorkspaceGitBranches.mockReturnValueOnce(pending.promise);
    const store = freshStore('worktree');

    const loading = store.ensureBranches('git');
    expect(store.availability('git')).toBe('loading');
    expect(store.effectiveEnvironment('git')).toBe('local');
    expect(store.worktreeRequest('git')).toBeUndefined();

    pending.resolve(repo());
    await loading;
    expect(store.availability('git')).toBe('available');
    expect(store.effectiveEnvironment('git')).toBe('worktree');
  });

  it('uses Local for a non-git project and restores Worktree on a git project', async () => {
    getWorkspaceGitBranches.mockImplementation(async (id) =>
      id === 'plain' ? { isRepo: false, dirty: false, remotes: [], branches: [] } : repo(),
    );
    const store = freshStore('worktree');
    await Promise.all([store.ensureBranches('git'), store.ensureBranches('plain')]);

    expect(store.availability('plain')).toBe('notGitRepo');
    expect(store.effectiveEnvironment('plain')).toBe('local');
    expect(store.worktreeRequest('plain')).toBeUndefined();
    expect(store.preferred).toBe('worktree');
    expect(store.effectiveEnvironment('git')).toBe('worktree');
    expect(store.worktreeRequest('git')).toEqual({ sourceBranch: 'main' });
  });

  it('never offers Worktree for a project on a remote host', async () => {
    const store = freshStore('worktree');
    await store.ensureBranches('remote');

    expect(getWorkspaceGitBranches).not.toHaveBeenCalledWith('remote');
    expect(store.availability('remote')).toBe('remoteHost');
    expect(store.effectiveEnvironment('remote')).toBe('local');
  });

  it('reports a failed git check and recovers on refresh', async () => {
    getWorkspaceGitBranches.mockRejectedValueOnce(new Error('offline'));
    const store = freshStore('worktree');
    await store.ensureBranches('git');
    expect(store.availability('git')).toBe('failed');
    expect(store.effectiveEnvironment('git')).toBe('local');

    await store.refreshBranches('git');
    expect(store.availability('git')).toBe('available');
  });

  it('loads branches once per project and keeps them visible while refreshing', async () => {
    const store = freshStore();
    await Promise.all([store.ensureBranches('git'), store.ensureBranches('git')]);
    await store.ensureBranches('git');
    expect(getWorkspaceGitBranches).toHaveBeenCalledTimes(1);

    const pending = Promise.withResolvers<WorkspaceGitBranches>();
    getWorkspaceGitBranches.mockReturnValueOnce(pending.promise);
    const refreshed = store.refreshBranches('git');
    expect(store.availability('git')).toBe('available');
    expect(store.view('git')).toMatchObject({ branches: repo().branches });
    pending.resolve(repo({ branches: [{ name: 'main', committedAt: '2026-11-19T00:00:00.000Z' }] }));
    await refreshed;
    expect(store.view('git')).toMatchObject({ branches: [{ name: 'main' }] });
  });

  it('loads the active project as soon as Worktree is chosen', async () => {
    freshStore('worktree');
    await vi.waitFor(() => expect(getWorkspaceGitBranches).toHaveBeenCalledWith('git'));
  });

  it('remembers the source branch per project across restarts', async () => {
    const store = freshStore();
    await Promise.all([store.ensureBranches('git'), store.ensureBranches('plain')]);
    expect(store.selectSource('git', { branch: 'topic' })).toBe(true);

    expect(store.selection('git')).toMatchObject({ branch: { name: 'topic' }, isDefault: false });
    expect(store.selection('plain')).toMatchObject({ branch: { name: 'main' }, isDefault: true });
    expect(JSON.parse(storage.get(STORAGE_KEYS.worktreeSourceByWorkspace)!)).toEqual({ git: { branch: 'topic' } });

    const restarted = freshStore();
    await restarted.ensureBranches('git');
    expect(restarted.selection('git')).toMatchObject({ branch: { name: 'topic' }, isDefault: false });
  });

  it('rejects a branch that is not in the list', async () => {
    const store = freshStore();
    await store.ensureBranches('git');
    expect(store.selectSource('git', { branch: 'nope' })).toBe(false);
    expect(store.selectSource('plain', { branch: 'main' })).toBe(false);
  });

  it('offers the local file status only for a dirty main directory', async () => {
    const store = freshStore();
    await store.ensureBranches('git');
    expect(store.view('git').canIncludeLocalChanges).toBe(false);
    store.selectSource('git', { branch: 'main', includeLocalChanges: true });
    expect(store.selection('git')?.includeLocalChanges).toBe(false);

    getWorkspaceGitBranches.mockResolvedValueOnce(repo({ dirty: true }));
    await store.refreshBranches('git');
    expect(store.view('git').canIncludeLocalChanges).toBe(true);
    store.selectSource('git', { branch: 'main', includeLocalChanges: true });
    store.selectEnvironment('worktree');
    expect(store.worktreeRequest('git')).toEqual({ sourceBranch: 'main', includeLocalChanges: true });

    store.selectSource('git', { branch: 'topic', includeLocalChanges: true });
    expect(store.worktreeRequest('git')).toEqual({ sourceBranch: 'topic' });
  });

  it('remembers the remote toggle per project and applies it only to branches with a remote', async () => {
    const store = freshStore('worktree');
    await store.ensureBranches('git');
    expect(store.useRemote('git')).toBe(false);
    expect(store.view('git')).toMatchObject({ remoteAvailable: true, useRemote: false, usesRemote: false });

    store.setUseRemote('git', true);
    expect(store.useRemote('plain')).toBe(false);
    expect(store.worktreeRequest('git')).toEqual({ sourceBranch: 'main', useRemote: true });
    expect(JSON.parse(storage.get(STORAGE_KEYS.worktreeUseRemoteByWorkspace)!)).toEqual({ git: true });

    store.selectSource('git', { branch: 'topic' });
    expect(store.view('git')).toMatchObject({ remoteAvailable: false, useRemote: true, usesRemote: false });
    expect(store.worktreeRequest('git')).toEqual({ sourceBranch: 'topic' });

    const restarted = freshStore();
    expect(restarted.useRemote('git')).toBe(true);
  });

  it('ignores a stale branch response', async () => {
    const slow = Promise.withResolvers<WorkspaceGitBranches>();
    getWorkspaceGitBranches.mockReturnValueOnce(slow.promise);
    const store = freshStore();
    const first = store.ensureBranches('git');
    store.reset();
    getWorkspaceGitBranches.mockResolvedValueOnce(repo({ headBranch: 'topic' }));
    await store.refreshBranches('git');
    slow.resolve(repo({ isRepo: false, branches: [] }));
    await first;

    expect(store.view('git')).toMatchObject({ availability: 'available', headBranch: 'topic' });
  });
});
