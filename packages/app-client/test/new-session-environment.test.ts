import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppWorkspace, WorkspaceGitBranches, WorktreeSetupScript } from '@moonshot-ai/app-core/api';
import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { useNewSessionEnvironmentStore } from '../src/stores/newSessionEnvironment';
import { workspacesStore } from '../src/stores/workspaces';
import { memoryStorage } from '../src/testing/worktreeFixtures';

const getWorkspaceGitBranches = vi.fn<(workspaceId: string) => Promise<WorkspaceGitBranches>>();
const getWorktreeSetupScript = vi.fn<(workspaceId: string) => Promise<WorktreeSetupScript>>();
const saveWorktreeSetupScript = vi.fn<(workspaceId: string, content: string) => Promise<WorktreeSetupScript>>();

const NO_SCRIPT: WorktreeSetupScript = { path: '/git/.kimi/setup.sh', exists: false };
const SCRIPT: WorktreeSetupScript = {
  path: '/git/.kimi/setup.sh',
  exists: true,
  content: 'pnpm install',
  needsConfirmation: false,
};

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

function freshStore() {
  return useNewSessionEnvironmentStore(createPinia());
}

let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', memoryStorage(storage));
  getWorkspaceGitBranches.mockReset();
  getWorkspaceGitBranches.mockResolvedValue(repo());
  getWorktreeSetupScript.mockReset();
  getWorktreeSetupScript.mockResolvedValue(NO_SCRIPT);
  saveWorktreeSetupScript.mockReset();
  setKimiClientDeps({
    api: () => ({ getWorkspaceGitBranches, getWorktreeSetupScript, saveWorktreeSetupScript }) as never,
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
    const store = freshStore();
    store.selectEnvironment('worktree');

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
    const store = freshStore();
    store.selectEnvironment('worktree');
    await Promise.all([store.ensureBranches('git'), store.ensureBranches('plain')]);

    expect(store.availability('plain')).toBe('notGitRepo');
    expect(store.effectiveEnvironment('plain')).toBe('local');
    expect(store.worktreeRequest('plain')).toBeUndefined();
    expect(store.preferred).toBe('worktree');
    expect(store.effectiveEnvironment('git')).toBe('worktree');
    expect(store.worktreeRequest('git')).toEqual({ sourceBranch: 'main' });
  });

  it('never offers Worktree for a project on a remote host', async () => {
    const store = freshStore();
    store.selectEnvironment('worktree');
    await store.ensureBranches('remote');

    expect(getWorkspaceGitBranches).not.toHaveBeenCalledWith('remote');
    expect(store.availability('remote')).toBe('remoteHost');
    expect(store.effectiveEnvironment('remote')).toBe('local');
  });

  it('reports a failed git check and recovers on refresh', async () => {
    getWorkspaceGitBranches.mockRejectedValueOnce(new Error('offline'));
    const store = freshStore();
    store.selectEnvironment('worktree');
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
    const store = freshStore();
    store.selectEnvironment('worktree');
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
    const store = freshStore();
    store.selectEnvironment('worktree');
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

  it('loads the project setup script once and exposes it', async () => {
    getWorktreeSetupScript.mockResolvedValue(SCRIPT);
    const store = freshStore();
    expect(store.setupScript('git')).toBeNull();

    await Promise.all([store.ensureSetupScript('git'), store.ensureSetupScript('git')]);
    await store.ensureSetupScript('git');

    expect(getWorktreeSetupScript).toHaveBeenCalledExactlyOnceWith('git');
    expect(store.setupScript('git')).toEqual(SCRIPT);
    expect(store.view('git')).toMatchObject({ setupScript: SCRIPT, runSetupScript: true });

    await store.ensureSetupScript('git', { force: true });
    expect(getWorktreeSetupScript).toHaveBeenCalledTimes(2);
  });

  it('does not ask a remote host for a setup script', async () => {
    const store = freshStore();
    await store.ensureSetupScript('remote');
    expect(getWorktreeSetupScript).not.toHaveBeenCalled();
    expect(store.setupScript('remote')).toBeNull();
  });

  it('keeps the raw error when the script cannot be read and clears it once it can', async () => {
    getWorktreeSetupScript.mockRejectedValueOnce(new Error('offline'));
    const store = freshStore();
    await store.ensureSetupScript('git');
    expect(store.setupScript('git')).toBeNull();
    expect(store.setupScriptError('git')).toBe('offline');

    await store.ensureSetupScript('git');
    expect(store.setupScript('git')).toEqual(NO_SCRIPT);
    expect(store.setupScriptError('git')).toBeNull();
  });

  it('saves the script and adopts what the server returns, including a deletion', async () => {
    const store = freshStore();
    await store.ensureSetupScript('git');
    saveWorktreeSetupScript.mockResolvedValueOnce(SCRIPT);

    expect(await store.saveSetupScript('git', 'pnpm install')).toBe(true);
    expect(saveWorktreeSetupScript).toHaveBeenCalledExactlyOnceWith('git', 'pnpm install');
    expect(store.setupScript('git')).toEqual(SCRIPT);

    saveWorktreeSetupScript.mockResolvedValueOnce(NO_SCRIPT);
    expect(await store.saveSetupScript('git', '')).toBe(true);
    expect(store.setupScript('git')).toEqual(NO_SCRIPT);
  });

  it('keeps the previous script and reports the error when saving fails', async () => {
    getWorktreeSetupScript.mockResolvedValue(SCRIPT);
    const store = freshStore();
    await store.ensureSetupScript('git');
    saveWorktreeSetupScript.mockRejectedValueOnce(new Error('content too large'));

    expect(await store.saveSetupScript('git', 'x')).toBe(false);
    expect(store.setupScript('git')).toEqual(SCRIPT);
    expect(store.setupScriptError('git')).toBe('content too large');
  });

  it('sends the script opt-out only when a script exists and the toggle is off', async () => {
    const store = freshStore();
    store.selectEnvironment('worktree');
    await store.ensureBranches('git');
    await store.ensureSetupScript('git');
    expect(store.runSetupScript).toBe(true);
    expect(store.worktreeRequest('git')).toEqual({ sourceBranch: 'main' });

    store.setRunSetupScript(false);
    expect(store.runSetupScript).toBe(false);
    expect(store.worktreeRequest('git')).toEqual({ sourceBranch: 'main' });

    saveWorktreeSetupScript.mockResolvedValueOnce(SCRIPT);
    await store.saveSetupScript('git', 'pnpm install');
    expect(store.worktreeRequest('git')).toEqual({ sourceBranch: 'main', runSetupScript: false });

    store.setRunSetupScript(true);
    expect(store.worktreeRequest('git')).toEqual({ sourceBranch: 'main' });
    store.setRunSetupScript(false);
    store.setRunSetupScript(undefined);
    expect(store.runSetupScript).toBe(true);
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
