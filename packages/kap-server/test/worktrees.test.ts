import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  IAgentEnvironmentBindingService,
  IAgentEnvironmentService,
  IAgentLoopService,
  IWorkspaceTrust,
  closeSessionById,
  getLiveSessionById,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import type { Session } from '../src/protocol/session';
import { repointSession } from '../src/services/worktrees/sessionRepoint';
import { SessionWorktreeService } from '../src/services/worktrees/sessionWorktreeService';
import { commitAll, git, hangingRemote } from './helpers/gitRepo';
import { type Envelope, useWorktreeServer } from './helpers/worktreeServer';

interface ScriptWire {
  path: string;
  exists: boolean;
  content?: string;
  needs_confirmation?: boolean;
}

describe('server-v2 session worktrees', () => {
  const fixture = useWorktreeServer('worktrees');
  const {
    request,
    post,
    get,
    addRemote,
    commitOnRemote,
    createWorkspace,
    project,
    createWorktreeSession,
    settled,
    settledWorktree,
    untilStep,
    branchOf,
    forceRunning,
    stored,
    sessionEvents,
    mainAgent,
    worktreeDirectories,
    expectNothingLeft,
  } = fixture;

  function readScript(workspaceId: string): Promise<Envelope<ScriptWire>> {
    return get<ScriptWire>(`/workspaces/${workspaceId}/worktree-setup-script`);
  }

  function saveScript(workspaceId: string, content: string): Promise<Envelope<ScriptWire>> {
    return request<ScriptWire>('PUT', `/workspaces/${workspaceId}/worktree-setup-script`, { content });
  }

  it('re-points a fresh session at another directory and back to the workspace root', async () => {
    const { root, workspaceId } = await project('repoint');
    const worktree = join(fixture.scratch, 'repoint-wt');
    git(root, 'worktree', 'add', '-q', '-b', 'side', worktree);
    await writeFile(join(worktree, 'only-here.txt'), 'x\n');
    const created = await post<Session>('/sessions', { workspace_id: workspaceId });
    const id = created.data.id;
    expect(created.data.cwd).toBe(root);
    expect(mainAgent(id).accessor.get(IAgentLoopService).getSystemPrompt()).not.toContain(worktree);

    await repointSession(fixture.server.core, id, worktree);

    const moved = await get<Session>(`/sessions/${id}`);
    expect(moved.data.cwd).toBe(worktree);
    expect(moved.data.workspace_id).toBe(workspaceId);
    const status = await post<{ branch: string; entries: Record<string, string> }>(
      `/sessions/${id}/fs:git_status`,
      { include_pull_request: false },
    );
    expect(status.data.branch).toBe('side');
    expect(status.data.entries).toEqual({ 'only-here.txt': 'untracked' });
    const main = mainAgent(id);
    expect(main.accessor.get(IAgentEnvironmentBindingService).current.cwd).toBe(worktree);
    expect(main.accessor.get(IAgentEnvironmentService).workspaceRoots().workDir).toBe(worktree);
    expect(main.accessor.get(IAgentLoopService).getSystemPrompt()).toContain(worktree);

    await repointSession(fixture.server.core, id, undefined);

    const back = await get<Session>(`/sessions/${id}`);
    expect(back.data.cwd).toBe(root);
    expect(await branchOf(id)).toBe('main');
    const restored = mainAgent(id);
    expect(restored.accessor.get(IAgentEnvironmentService).workspaceRoots().workDir).toBe(root);
    expect(restored.accessor.get(IAgentLoopService).getSystemPrompt()).not.toContain(worktree);
  });

  it('creates a worktree from a local branch and moves the session into it', async () => {
    const { root, workspaceId } = await project('local-create');
    await post(`/workspaces/${workspaceId}/trust`);
    const events = await sessionEvents();

    const created = await createWorktreeSession(workspaceId, { source_branch: 'main' });

    expect(created.cwd).toBe(root);
    expect(created.metadata).toBeUndefined();
    expect(created.worktree).toMatchObject({
      setup: {
        status: 'running',
        purpose: 'create',
        request: { source_branch: 'main' },
        commands_ran: 0,
        script: 'none',
      },
    });
    expect(created.worktree?.path).toBeUndefined();
    expect(created.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create']);

    const ready = await settled(created.id);
    const worktree = ready.worktree!;
    expect(worktree.setup.status).toBe('ready');
    expect(worktree.setup.commands_ran).toBe(1);
    expect(worktree.setup.ended_at).toBeDefined();
    expect(worktree.branch).toMatch(/^kimi\/\d{4}-[0-9a-f]{4}$/);
    expect(worktree.path).toBe(
      join(fixture.home, 'worktrees', 'local-create', worktree.branch!.slice('kimi/'.length)),
    );
    expect(worktree.base).toEqual({ ref: 'main', remote: false, commit: git(root, 'rev-parse', 'main') });
    expect(worktree.included_local_changes).toBe(false);
    expect(worktree.missing).toBeUndefined();
    expect(worktree.setup.steps).toEqual([
      {
        kind: 'create',
        state: 'done',
        ref: 'main',
        command: `git worktree add --no-track -b ${worktree.branch} ${worktree.path} main`,
      },
    ]);
    expect(ready.cwd).toBe(worktree.path);
    expect(ready.workspace_id).toBe(workspaceId);
    expect(git(worktree.path!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(worktree.branch);

    expect(await branchOf(created.id)).toBe(worktree.branch);
    const main = mainAgent(created.id);
    expect(main.accessor.get(IAgentEnvironmentService).workspaceRoots().workDir).toBe(worktree.path);
    expect(main.accessor.get(IAgentLoopService).getSystemPrompt()).toContain(worktree.path);
    const live = getLiveSessionById(fixture.server.core.accessor, created.id)!;
    expect(live.accessor.get(IWorkspaceTrust).isTrusted()).toBe(true);

    await expect.poll(() => events.at(-1)?.session.worktree?.setup.status).toBe('ready');
    const mine = events.filter((event) => event.session.id === created.id);
    expect(mine[0]).toMatchObject({ change: 'created', session: { worktree: { setup: { status: 'running' } } } });
    expect(mine.slice(1).every((event) => event.change === 'updated')).toBe(true);
    expect(
      mine.some((event) => event.session.worktree?.setup.steps[0]?.state === 'running'),
    ).toBe(true);
    expect(mine.at(-1)?.session.cwd).toBe(worktree.path);

    const listed = await get<{ items: Session[] }>(`/sessions?workspace_id=${workspaceId}`);
    expect(listed.data.items.find((item) => item.id === created.id)?.worktree?.path).toBe(worktree.path);
    const registry = JSON.parse(await readFile(join(fixture.home, 'worktrees', 'registry.json'), 'utf-8')) as {
      worktrees: { path: string; branch: string; workspace_id: string; repo_root: string }[];
    };
    expect(registry.worktrees.find((entry) => entry.path === worktree.path)).toMatchObject({
      branch: worktree.branch,
      workspace_id: workspaceId,
      repo_root: root,
    });
  });

  it('starts from the freshly fetched remote branch without moving the local branch', async () => {
    const { root, workspaceId } = await project('remote-create');
    const bare = addRemote(root);
    const localTip = git(root, 'rev-parse', 'main');
    const remoteTip = await commitOnRemote(bare, 'remote.txt', 'from remote\n');

    const created = await createWorktreeSession(workspaceId, { use_remote: true });
    expect(created.worktree?.setup.steps).toMatchObject([
      {
        kind: 'fetch',
        state: 'pending',
        ref: 'origin/main',
        command: 'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
      },
      { kind: 'create', state: 'pending', ref: 'origin/main' },
    ]);

    const ready = await settled(created.id);
    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', commands_ran: 2 });
    expect(ready.worktree?.base).toEqual({ ref: 'origin/main', remote: true, commit: remoteTip });
    expect(git(ready.worktree!.path!, 'rev-parse', 'HEAD')).toBe(remoteTip);
    expect(existsSync(join(ready.worktree!.path!, 'remote.txt'))).toBe(true);
    expect(git(root, 'rev-parse', 'main')).toBe(localTip);
    expect(
      git(root, 'for-each-ref', '--format=%(upstream)', `refs/heads/${ready.worktree!.branch}`),
    ).toBe('');
  });

  it('creates nothing when the fetch fails, then retries from the local branch', async () => {
    const { root, workspaceId } = await project('fetch-failure');
    const bare = addRemote(root);
    await rm(bare, { recursive: true, force: true });
    const before = await worktreeDirectories();

    const created = await createWorktreeSession(workspaceId, { use_remote: true });
    const failed = await settled(created.id);

    expect(failed.worktree?.setup).toMatchObject({
      status: 'failed',
      stopped_step: 'fetch',
      failure: { kind: 'fetch_failed', remote_ref: 'origin/main' },
    });
    expect(failed.worktree?.setup.steps[0]).toMatchObject({ kind: 'fetch', state: 'failed' });
    expect(failed.worktree?.setup.steps[0]?.output).toMatch(/fatal|not appear to be a git repository/);
    expect(failed.worktree?.setup.steps[1]).toMatchObject({ kind: 'create', state: 'pending' });
    expect(failed.worktree?.path).toBeUndefined();
    expect(failed.cwd).toBe(root);
    await expectNothingLeft(root, before);

    const retried = await post<Session>(`/sessions/${created.id}/worktree:retry`, { use_remote: false });
    expect(retried.code).toBe(0);
    expect(retried.data.worktree?.setup).toMatchObject({
      status: 'running',
      request: { source_branch: 'main', use_remote: false },
    });
    expect(retried.data.worktree?.setup.failure).toBeUndefined();
    expect(retried.data.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create']);
    const ready = await settled(created.id);
    expect(ready.worktree?.setup.status).toBe('ready');
    expect(ready.worktree?.base).toMatchObject({ ref: 'main', remote: false });
    expect(ready.cwd).toBe(ready.worktree?.path);
  });

  it('treats a branch that vanished from the remote as having no remote', async () => {
    const { root, workspaceId } = await project('stale-remote');
    const bare = addRemote(root);
    git(root, 'checkout', '-q', '-b', 'feature');
    git(root, 'push', '-q', '-u', 'origin', 'feature');
    git(root, 'checkout', '-q', 'main');
    git(bare, 'branch', '-D', 'feature');

    const created = await createWorktreeSession(workspaceId, { source_branch: 'feature', use_remote: true });
    expect(created.worktree?.setup.steps[0]).toMatchObject({ kind: 'fetch', ref: 'origin/feature' });
    const ready = await settled(created.id);

    expect(ready.worktree?.setup.status).toBe('ready');
    expect(ready.worktree?.setup.steps).toMatchObject([
      { kind: 'fetch', state: 'skipped' },
      { kind: 'create', state: 'done', ref: 'feature' },
    ]);
    expect(ready.worktree?.setup.steps[1]?.command).toMatch(/ feature$/);
    expect(ready.worktree?.base).toMatchObject({ ref: 'feature', remote: false });
  });

  it('carries uncommitted work into the worktree unstaged and leaves the main directory untouched', async () => {
    const { root, workspaceId } = await project('local-changes');
    await writeFile(join(root, 'README.md'), 'hello\nedited\n');
    await writeFile(join(root, 'staged.txt'), 'staged\n');
    git(root, 'add', 'staged.txt');
    await rm(join(root, 'notes.txt'));
    await writeFile(join(root, 'untracked.txt'), 'new\n');
    await writeFile(join(root, '.gitignore'), 'ignored.log\n');
    await writeFile(join(root, 'ignored.log'), 'noise\n');
    const statusBefore = git(root, 'status', '--porcelain');
    const indexBefore = await readFile(join(root, '.git', 'index'));

    const created = await createWorktreeSession(workspaceId, { include_local_changes: true });
    expect(created.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create', 'changes']);
    const ready = await settled(created.id);

    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', commands_ran: 2 });
    expect(ready.worktree?.included_local_changes).toBe(true);
    expect(ready.worktree?.setup.steps[1]).toMatchObject({ kind: 'changes', state: 'done' });
    expect(ready.worktree?.setup.steps[1]?.command).toMatch(/^git cherry-pick --no-commit [0-9a-f]{10}$/);
    const path = ready.worktree!.path!;
    expect(git(path, 'status', '--porcelain').split('\n').toSorted()).toEqual([
      ' D notes.txt',
      ' M README.md',
      '?? .gitignore',
      '?? staged.txt',
      '?? untracked.txt',
    ]);
    expect(await readFile(join(path, 'README.md'), 'utf-8')).toBe('hello\nedited\n');
    expect(existsSync(join(path, 'ignored.log'))).toBe(false);
    expect(git(path, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(root, 'status', '--porcelain')).toBe(statusBefore);
    expect((await readFile(join(root, '.git', 'index'))).equals(indexBefore)).toBe(true);
  });

  it('skips the changes step when the main directory is clean', async () => {
    const { workspaceId } = await project('clean-changes');

    const created = await createWorktreeSession(workspaceId, { include_local_changes: true });

    expect(created.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create']);
    expect((await settled(created.id)).worktree?.included_local_changes).toBe(false);
  });

  it('reports conflicting files and leaves nothing behind when local changes do not apply', async () => {
    const { root, workspaceId } = await project('conflict');
    const bare = addRemote(root);
    await commitOnRemote(bare, 'notes.txt', 'remote rewrite\n');
    await writeFile(join(root, 'notes.txt'), 'local rewrite\n');
    const before = await worktreeDirectories();

    const created = await createWorktreeSession(workspaceId, {
      use_remote: true,
      include_local_changes: true,
    });
    const failed = await settled(created.id);

    expect(failed.worktree?.setup).toMatchObject({
      status: 'failed',
      stopped_step: 'changes',
      failure: { kind: 'conflict', conflict_files: ['notes.txt'], remote_ref: 'origin/main' },
    });
    expect(failed.worktree?.setup.steps.map((step) => step.state)).toEqual(['done', 'done', 'failed']);
    expect(failed.worktree?.path).toBeUndefined();
    expect(failed.cwd).toBe(root);
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('local rewrite\n');
    await expectNothingLeft(root, before);

    const local = await post<Session>(`/sessions/${created.id}/worktree:use_local`);
    expect(local.data.worktree).toMatchObject({ setup: { status: 'local' } });
    expect(local.data.worktree?.path).toBeUndefined();
    expect(local.data.cwd).toBe(root);
    const again = await post<Session>(`/sessions/${created.id}/worktree:retry`);
    expect(again.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
  });

  it('cancels a running setup, leaving nothing behind', async () => {
    const { root, workspaceId } = await project('cancel');
    hangingRemote(root);
    const before = await worktreeDirectories();

    const created = await createWorktreeSession(workspaceId, { use_remote: true });
    await untilStep(created.id, 'fetch', 'running');
    const cancelled = await post<Session>(`/sessions/${created.id}/worktree:cancel`);

    expect(cancelled.code).toBe(0);
    expect(cancelled.data.worktree?.setup).toMatchObject({ status: 'stopped', stopped_step: 'fetch' });
    expect(cancelled.data.worktree?.setup.steps).toMatchObject([
      { kind: 'fetch', state: 'stopped' },
      { kind: 'create', state: 'pending' },
    ]);
    expect(cancelled.data.cwd).toBe(root);
    await expectNothingLeft(root, before);
    const twice = await post<Session>(`/sessions/${created.id}/worktree:cancel`);
    expect(twice.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
  });

  it('rejects worktree requests it cannot serve', async () => {
    const plain = join(fixture.scratch, 'not-a-repo');
    await mkdir(plain, { recursive: true });
    const plainWorkspace = await createWorkspace(plain);
    const unsupported = await post<Session>('/sessions', {
      workspace_id: plainWorkspace,
      worktree: { source_branch: 'main' },
    });
    expect(unsupported.code).toBe(ErrorCode.WORKTREE_UNSUPPORTED);

    const { workspaceId } = await project('rejections');
    const unknownBranch = await post<Session>('/sessions', {
      workspace_id: workspaceId,
      worktree: { source_branch: 'nope' },
    });
    expect(unknownBranch.code).toBe(ErrorCode.VALIDATION_FAILED);

    const local = await post<Session>('/sessions', { workspace_id: workspaceId });
    expect(local.data.worktree).toBeUndefined();
    const noSetup = await post<Session>(`/sessions/${local.data.id}/worktree:cancel`);
    expect(noSetup.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
    const missing = await post<Session>('/sessions/nope/worktree:cancel');
    expect(missing.code).toBe(ErrorCode.SESSION_NOT_FOUND);

    const ready = await settledWorktree(workspaceId);
    for (const action of ['retry', 'cancel', 'use_local', 'recreate']) {
      const refused = await post<Session>(`/sessions/${ready.id}/worktree:${action}`);
      expect(refused.code, action).toBe(ErrorCode.WORKTREE_STATE_INVALID);
    }
    const profile = await post<{ session: Session }>(`/sessions/${ready.id}/profile`, {
      metadata: { worktree: { setup: { status: 'local' } }, note: 'kept' },
    });
    expect(profile.data.session.metadata).toEqual({ note: 'kept' });
    expect(profile.data.session.worktree).toEqual(ready.worktree);
  });

  it('settles a setup that a previous server process left running', async () => {
    const { root, workspaceId } = await project('interrupted');
    const ready = await settledWorktree(workspaceId);
    const leftoverPath = join(fixture.home, 'worktrees', 'interrupted', 'left-over');
    git(root, 'worktree', 'add', '-q', '-b', 'kimi/left-over', leftoverPath);
    const plain = await post<Session>('/sessions', { workspace_id: workspaceId });
    await forceRunning(
      plain.data.id,
      { ...ready.worktree!.setup, steps: [{ kind: 'create', state: 'running' }] },
      { repo_root: root, pending: { path: leftoverPath, branch: 'kimi/left-over' } },
    );

    await new SessionWorktreeService(fixture.server.core).recoverInterrupted();

    const recovered = await get<Session>(`/sessions/${plain.data.id}`);
    expect(recovered.data.worktree?.setup).toMatchObject({
      status: 'stopped',
      stopped_step: 'create',
      steps: [{ kind: 'create', state: 'stopped' }],
    });
    expect(existsSync(leftoverPath)).toBe(false);
    expect(git(root, 'branch', '--list', 'kimi/left-over')).toBe('');
    expect((await get<Session>(`/sessions/${ready.id}`)).data.worktree?.setup.status).toBe('ready');
    expect((await stored(plain.data.id))?.pending).toBeUndefined();

    await forceRunning(ready.id, {
      ...ready.worktree!.setup,
      script: 'pending',
      steps: [...ready.worktree!.setup.steps, { kind: 'script', state: 'running' }],
    });
    await new SessionWorktreeService(fixture.server.core).recoverInterrupted();
    const paused = await get<Session>(`/sessions/${ready.id}`);
    expect(paused.data.worktree?.setup).toMatchObject({ status: 'stopped', stopped_step: 'script' });
    expect(paused.data.worktree?.path).toBe(ready.worktree!.path);
    expect(existsSync(ready.worktree!.path!)).toBe(true);
    const resumed = await post<Session>(`/sessions/${ready.id}/worktree:skip_script`);
    expect(resumed.data.worktree?.setup).toMatchObject({ status: 'ready', script: 'skipped' });
  });

  it('lists local branches by latest commit with their remote branch and the dirty flag', async () => {
    interface Branches {
      is_repo: boolean;
      head_branch?: string;
      dirty: boolean;
      remotes: string[];
      branches: {
        name: string;
        committed_at: string;
        remote_ref?: string;
        remote?: string;
        remote_source?: 'upstream' | 'same_name';
      }[];
    }
    const plain = join(fixture.scratch, 'branches-plain');
    await mkdir(plain, { recursive: true });
    const plainBranches = await get<Branches>(`/workspaces/${await createWorkspace(plain)}/git/branches`);
    expect(plainBranches.data).toEqual({ is_repo: false, dirty: false, remotes: [], branches: [] });

    const { root, workspaceId } = await project('branches');
    addRemote(root);
    const commitAt = (branch: string, date: string) => {
      git(root, 'checkout', '-q', '-b', branch, 'main');
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', branch], {
        cwd: root,
        env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
      });
    };
    commitAt('older', '2030-01-01T00:00:00Z');
    commitAt('newest', '2031-06-01T12:00:00Z');
    git(root, 'checkout', '-q', 'main');
    await mkdir(join(root, 'nested'));
    const nestedWorkspaceId = await createWorkspace(join(root, 'nested'));

    const clean = await get<Branches>(`/workspaces/${workspaceId}/git/branches`);
    expect(clean.code).toBe(0);
    expect(clean.data).toMatchObject({ is_repo: true, head_branch: 'main', dirty: false, remotes: ['origin'] });
    expect(clean.data.branches.map((branch) => branch.name)).toEqual(['newest', 'older', 'main']);
    expect(clean.data.branches[0]).toEqual({ name: 'newest', committed_at: '2031-06-01T12:00:00.000Z' });
    expect(clean.data.branches[2]).toMatchObject({
      name: 'main',
      remote_ref: 'origin/main',
      remote: 'origin',
      remote_source: 'upstream',
    });

    git(root, 'remote', 'add', 'fork', join(fixture.scratch, 'branches-fork-does-not-exist.git'));
    git(root, 'update-ref', 'refs/remotes/fork/older', 'older');
    const forked = await get<Branches>(`/workspaces/${workspaceId}/git/branches`);
    expect(forked.data.remotes).toEqual(['fork', 'origin']);
    expect(forked.data.branches[1]).toMatchObject({
      name: 'older',
      remote_ref: 'fork/older',
      remote: 'fork',
      remote_source: 'same_name',
    });
    expect(forked.data.branches[0]).not.toHaveProperty('remote');

    await writeFile(join(root, 'untracked.txt'), 'x\n');
    git(root, 'checkout', '-q', '--detach');
    const dirty = await get<Branches>(`/workspaces/${workspaceId}/git/branches`);
    expect(dirty.data.dirty).toBe(true);
    expect(dirty.data).not.toHaveProperty('head_branch');

    const nested = await get<Branches>(`/workspaces/${nestedWorkspaceId}/git/branches`);
    expect(nested.data.is_repo).toBe(false);
    const unknown = await get<Branches>('/workspaces/wd_missing_000000000000/git/branches');
    expect(unknown.code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
  });

  it('recreates a missing worktree from its recorded branch', async () => {
    const { workspaceId } = await project('recreate');
    const session = await settledWorktree(workspaceId);
    const { path, branch } = session.worktree as { path: string; branch: string };
    await writeFile(join(path, 'kept.txt'), 'committed in the worktree\n');
    commitAll(path, 'work');
    await rm(path, { recursive: true, force: true });
    await closeSessionById(fixture.server.core.accessor, session.id);

    const missing = await get<Session>(`/sessions/${session.id}`);
    expect(missing.data.worktree).toMatchObject({ path, branch, missing: true });
    expect(missing.data.worktree?.branch_missing).toBeUndefined();
    expect((await get<{ turns: unknown[] }>(`/sessions/${session.id}/agents/main/turns`)).code).toBe(0);
    expect((await post(`/sessions/${session.id}/fs:git_status`, {})).code).toBe(
      ErrorCode.FS_DIRECTORY_NOT_FOUND,
    );

    const started = await post<Session>(`/sessions/${session.id}/worktree:recreate`);
    expect(started.code).toBe(0);
    expect(started.data.worktree?.setup).toMatchObject({ status: 'running', purpose: 'recreate' });
    expect(started.data.worktree?.setup.steps).toMatchObject([
      { kind: 'prune', command: 'git worktree prune' },
      { kind: 'create', ref: branch, command: `git worktree add ${path} ${branch}` },
    ]);
    const ready = await settled(session.id);

    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', purpose: 'recreate', commands_ran: 2 });
    expect(ready.worktree?.setup.steps.map((step) => step.state)).toEqual(['done', 'done']);
    expect(ready.worktree?.missing).toBeUndefined();
    expect(ready.worktree?.path).toBe(path);
    expect(ready.cwd).toBe(path);
    expect(await readFile(join(path, 'kept.txt'), 'utf-8')).toBe('committed in the worktree\n');
    expect(await branchOf(session.id)).toBe(branch);
  });

  it('falls back to the workspace root when a missing worktree cannot be recreated', async () => {
    const { root, workspaceId } = await project('recreate-failure');
    const session = await settledWorktree(workspaceId);
    const { path, branch } = session.worktree as { path: string; branch: string };
    await rm(path, { recursive: true, force: true });
    git(root, 'worktree', 'prune');
    git(root, 'branch', '-D', branch);

    const missing = await get<Session>(`/sessions/${session.id}`);
    expect(missing.data.worktree).toMatchObject({ missing: true, branch_missing: true });
    await post<Session>(`/sessions/${session.id}/worktree:recreate`);
    const failed = await settled(session.id);

    expect(failed.worktree?.setup).toMatchObject({
      status: 'failed',
      purpose: 'recreate',
      stopped_step: 'create',
      failure: { kind: 'create_failed' },
    });
    expect(failed.worktree?.setup.steps[1]?.output).toMatch(/invalid reference|not a valid|fatal/);
    expect(failed.worktree?.path).toBe(path);
    expect(existsSync(path)).toBe(false);
    const retried = await post<Session>(`/sessions/${session.id}/worktree:retry`);
    expect(retried.data.worktree?.setup).toMatchObject({ status: 'running', purpose: 'recreate' });
    await settled(session.id);

    const local = await post<Session>(`/sessions/${session.id}/worktree:use_local`);

    expect(local.code).toBe(0);
    expect(local.data.cwd).toBe(root);
    expect(local.data.worktree?.setup.status).toBe('local');
    expect(local.data.worktree?.path).toBeUndefined();
    expect(local.data.worktree?.branch).toBeUndefined();
    expect(local.data.worktree?.missing).toBeUndefined();
    const main = mainAgent(session.id);
    expect(main.accessor.get(IAgentEnvironmentService).workspaceRoots().workDir).toBe(root);
    expect(main.accessor.get(IAgentEnvironmentBindingService).current.cwd).toBeUndefined();
    expect(main.accessor.get(IAgentLoopService).getSystemPrompt()).not.toContain(path);
    expect(await branchOf(session.id)).toBe('main');
  });


  it('runs a setup script saved on this machine as the last step', async () => {
    const { root, workspaceId } = await project('script-saved');
    const none = await readScript(workspaceId);
    expect(none.data).toEqual({ path: join(root, '.kimi', 'setup.sh'), exists: false });
    const content = '#!/bin/sh\necho "$KIMI_PROJECT_DIR" > project-dir.txt\npwd -P > cwd.txt\n';

    const saved = await saveScript(workspaceId, content);

    expect(saved.data).toEqual({
      path: join(root, '.kimi', 'setup.sh'),
      exists: true,
      content,
      needs_confirmation: false,
    });
    expect(await readFile(join(root, '.kimi', 'setup.sh'), 'utf-8')).toBe(content);
    expect((await readScript(workspaceId)).data).toEqual(saved.data);

    const created = await createWorktreeSession(workspaceId);
    expect(created.worktree?.setup.script).toBe('pending');
    expect(created.worktree?.setup.steps).toMatchObject([
      { kind: 'create', state: 'pending' },
      { kind: 'script', state: 'pending', command: `/bin/sh ${join(root, '.kimi', 'setup.sh')}` },
    ]);
    const ready = await settled(created.id);

    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', script: 'ran', commands_ran: 2 });
    expect(ready.worktree?.setup.steps.map((step) => step.state)).toEqual(['done', 'done']);
    const path = ready.worktree!.path!;
    expect((await readFile(join(path, 'project-dir.txt'), 'utf-8')).trim()).toBe(root);
    expect((await readFile(join(path, 'cwd.txt'), 'utf-8')).trim()).toBe(path);

    const skipped = await settledWorktree(workspaceId, { run_setup_script: false });
    expect(skipped.worktree?.setup).toMatchObject({ status: 'ready', script: 'skipped', commands_ran: 1 });
    expect(skipped.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create']);
    expect(existsSync(join(skipped.worktree!.path!, 'cwd.txt'))).toBe(false);

    const cleared = await saveScript(workspaceId, '');
    expect(cleared.data).toEqual({ path: join(root, '.kimi', 'setup.sh'), exists: false });
    expect(existsSync(join(root, '.kimi', 'setup.sh'))).toBe(false);
    const without = await settledWorktree(workspaceId);
    expect(without.worktree?.setup).toMatchObject({ status: 'ready', script: 'none' });
  });

  it('asks before running a setup script that came from the repository', async () => {
    const { root, workspaceId } = await project('script-repository');
    await mkdir(join(root, '.kimi'));
    const content = 'echo ran >> script.log\n';
    await writeFile(join(root, '.kimi', 'setup.sh'), content);
    commitAll(root, 'add setup script');
    expect((await readScript(workspaceId)).data).toMatchObject({
      exists: true,
      needs_confirmation: true,
    });

    const waiting = await settledWorktree(workspaceId);

    expect(waiting.worktree?.setup).toMatchObject({
      status: 'awaiting_script_confirmation',
      script: 'pending',
      script_content: content,
      commands_ran: 1,
    });
    expect(waiting.worktree?.setup.steps).toMatchObject([
      { kind: 'create', state: 'done' },
      { kind: 'script', state: 'pending', command: `sh ${join(root, '.kimi', 'setup.sh')}` },
    ]);
    const path = waiting.worktree!.path!;
    expect(waiting.cwd).toBe(path);
    expect(existsSync(join(path, 'script.log'))).toBe(false);
    for (const action of ['retry', 'cancel', 'use_local']) {
      const refused = await post<Session>(`/sessions/${waiting.id}/worktree:${action}`);
      expect(refused.code, action).toBe(ErrorCode.WORKTREE_STATE_INVALID);
    }

    const running = await post<Session>(`/sessions/${waiting.id}/worktree:run_script`);
    expect(running.data.worktree?.setup).toMatchObject({ status: 'running', script: 'pending' });
    expect(running.data.worktree?.setup.script_content).toBeUndefined();
    const ready = await settled(waiting.id);
    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', script: 'ran', commands_ran: 2 });
    expect(await readFile(join(path, 'script.log'), 'utf-8')).toBe('ran\n');

    const trusted = await settledWorktree(workspaceId);
    expect(trusted.worktree?.setup).toMatchObject({ status: 'ready', script: 'ran' });

    await writeFile(join(root, '.kimi', 'setup.sh'), 'echo changed >> script.log\n');
    const changed = await settledWorktree(workspaceId);
    expect(changed.worktree?.setup).toMatchObject({
      status: 'awaiting_script_confirmation',
      script_content: 'echo changed >> script.log\n',
    });
    await writeFile(join(root, '.kimi', 'setup.sh'), 'echo changed again >> script.log\n');
    const stale = await post<Session>(`/sessions/${changed.id}/worktree:run_script`);
    expect(stale.code).toBe(0);
    expect((await settled(changed.id)).worktree?.setup).toMatchObject({
      status: 'awaiting_script_confirmation',
      script_content: 'echo changed again >> script.log\n',
    });
    const skipped = await post<Session>(`/sessions/${changed.id}/worktree:skip_script`);
    expect(skipped.data.worktree?.setup).toMatchObject({ status: 'ready', script: 'skipped' });
    expect(skipped.data.worktree?.setup.script_content).toBeUndefined();
    expect(skipped.data.worktree?.setup.steps.at(-1)).toMatchObject({ kind: 'script', state: 'skipped' });
    expect(existsSync(join(changed.worktree!.path!, 'script.log'))).toBe(false);
  });

  it('keeps the worktree when the setup script fails or is stopped', async () => {
    const { workspaceId } = await project('script-failure');
    await saveScript(workspaceId, 'echo "no lockfile" >&2\nexit 3\n');

    const failed = await settledWorktree(workspaceId);

    expect(failed.worktree?.setup).toMatchObject({
      status: 'failed',
      stopped_step: 'script',
      failure: { kind: 'script_failed', exit_code: 3 },
      script: 'pending',
    });
    expect(failed.worktree?.setup.steps.at(-1)).toMatchObject({
      kind: 'script',
      state: 'failed',
      output: 'no lockfile\n',
    });
    const path = failed.worktree!.path!;
    expect(existsSync(path)).toBe(true);
    expect(failed.cwd).toBe(path);
    for (const action of ['retry', 'use_local']) {
      const refused = await post<Session>(`/sessions/${failed.id}/worktree:${action}`);
      expect(refused.code, action).toBe(ErrorCode.WORKTREE_STATE_INVALID);
    }

    await saveScript(workspaceId, 'echo started > started.txt\nsleep 30\n');
    const rerun = await post<Session>(`/sessions/${failed.id}/worktree:run_script`);
    expect(rerun.data.worktree?.setup).toMatchObject({ status: 'running' });
    expect(rerun.data.worktree?.setup.failure).toBeUndefined();
    await expect.poll(() => existsSync(join(path, 'started.txt')), { timeout: 5_000 }).toBe(true);
    const stopped = await post<Session>(`/sessions/${failed.id}/worktree:cancel`);
    expect(stopped.data.worktree?.setup).toMatchObject({ status: 'stopped', stopped_step: 'script' });
    expect(stopped.data.worktree?.setup.steps.at(-1)).toMatchObject({ kind: 'script', state: 'stopped' });
    expect(existsSync(path)).toBe(true);
    expect(stopped.data.cwd).toBe(path);

    await saveScript(workspaceId, 'echo ok > ok.txt\n');
    await post<Session>(`/sessions/${failed.id}/worktree:run_script`);
    const ready = await settled(failed.id);
    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', script: 'ran' });
    expect(ready.worktree?.setup.failure).toBeUndefined();
    expect(ready.worktree?.setup.stopped_step).toBeUndefined();
    expect(existsSync(join(path, 'ok.txt'))).toBe(true);
    const done = await post<Session>(`/sessions/${failed.id}/worktree:skip_script`);
    expect(done.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
  });
});
