import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listLocalBranches, resolveRemoteRef } from '../../src/services/worktrees/gitRefs';
import {
  WorktreeCreation,
  abbreviateHome,
  displayCommand,
  plannedRecreationSteps,
  recreateWorktree,
  type SetupProgress,
} from '../../src/services/worktrees/worktreeSetup';
import { createRepoTemplate, git, hangingRemote, type RepoTemplate } from '../helpers/gitRepo';

describe('worktree setup engine', () => {
  let scratch: string;
  let template: RepoTemplate;

  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'kimi-worktree-setup-')));
    template = await createRepoTemplate({ 'README.md': 'hello\n' });
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await template.dispose();
  });

  function createRepo(name: string): Promise<string> {
    return template.copyTo(join(scratch, name));
  }

  function progressOf(creation: WorktreeCreation): SetupProgress {
    return { steps: creation.plannedSteps(), commandsRan: 0, notify: () => {} };
  }

  it('abbreviates the home directory and quotes only what needs quoting', () => {
    expect(abbreviateHome('/Users/dev/.kimi-code/worktrees/app/1109-a3f2', '/Users/dev')).toBe(
      '~/.kimi-code/worktrees/app/1109-a3f2',
    );
    expect(abbreviateHome('/Users/dev', '/Users/dev')).toBe('~');
    expect(abbreviateHome('/Users/developer/x', '/Users/dev')).toBe('/Users/developer/x');
    expect(
      displayCommand('git', ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']),
    ).toBe('git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main');
    expect(displayCommand('git', ['worktree', 'add', '~/my project/x', "it's"])).toBe(
      `git worktree add '~/my project/x' 'it'\\''s'`,
    );
  });

  it('avoids names taken by local branches, remote-tracking branches and directories', async () => {
    const root = await createRepo('collide');
    git(root, 'branch', 'kimi/0102-beef');
    git(root, 'update-ref', 'refs/remotes/origin/kimi/0102-beef-2', 'HEAD');
    git(root, 'remote', 'add', 'origin', join(scratch, 'nowhere.git'));
    const projectDir = join(scratch, 'collide-worktrees');
    await mkdir(join(projectDir, '0102-beef-3'), { recursive: true });

    const creation = await WorktreeCreation.plan({
      repoRoot: root,
      projectDir,
      osHomeDir: scratch,
      request: { source_branch: 'main' },
      now: () => new Date(2026, 0, 2),
      randomSuffix: () => 'beef',
    });
    expect(creation.target).toEqual({
      branch: 'kimi/0102-beef-4',
      path: join(projectDir, '0102-beef-4'),
    });
    expect(creation.plannedSteps()).toEqual([
      {
        kind: 'create',
        state: 'pending',
        ref: 'main',
        command: 'git worktree add --no-track -b kimi/0102-beef-4 ~/collide-worktrees/0102-beef-4 main',
      },
    ]);

    const outcome = await creation.run(progressOf(creation), new AbortController().signal);
    expect(outcome).toMatchObject({
      kind: 'done',
      value: { branch: 'kimi/0102-beef-4', base: { ref: 'main', remote: false } },
    });
    expect(git(join(projectDir, '0102-beef-4'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'kimi/0102-beef-4',
    );
  });

  it('leaves the worktree of a setup that picked the same name first untouched', async () => {
    const root = await createRepo('same-name');
    const plan = (): Promise<WorktreeCreation> =>
      WorktreeCreation.plan({
        repoRoot: root,
        projectDir: join(scratch, 'same-name-worktrees'),
        osHomeDir: scratch,
        request: { source_branch: 'main' },
        now: () => new Date(2026, 0, 2),
        randomSuffix: () => 'cafe',
      });
    const [first, second] = [await plan(), await plan()];
    expect(second.target).toEqual(first.target);

    expect(await first.run(progressOf(first), new AbortController().signal)).toMatchObject({ kind: 'done' });
    const progress = progressOf(second);
    expect(await second.run(progress, new AbortController().signal)).toMatchObject({
      kind: 'failed',
      step: 'create',
    });

    expect(progress.steps[0]?.output).toMatch(/EEXIST|already exists/);
    expect(git(first.target.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(first.target.branch);
    expect(git(root, 'branch', '--list', first.target.branch)).toContain(first.target.branch);
  });

  it('leaves a checkout that another recreation already put in place untouched', async () => {
    const root = await createRepo('recreate-twice');
    const path = join(scratch, 'recreate-twice-worktrees', 'feature');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', path);
    await writeFile(join(path, 'edit.txt'), 'new work\n');
    const options = { repoRoot: root, osHomeDir: scratch, path, branch: 'feature' };

    const outcome = await recreateWorktree(
      options,
      { steps: plannedRecreationSteps(options), commandsRan: 0, notify: () => {} },
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({ kind: 'failed', step: 'create' });
    expect(await readFile(join(path, 'edit.txt'), 'utf-8')).toBe('new work\n');
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
  });

  it('keeps a branch of the same name that appeared after planning', async () => {
    const root = await createRepo('late-branch');
    const creation = await WorktreeCreation.plan({
      repoRoot: root,
      projectDir: join(scratch, 'late-branch-worktrees'),
      osHomeDir: scratch,
      request: { source_branch: 'main' },
    });
    git(root, 'branch', creation.target.branch);

    expect(await creation.run(progressOf(creation), new AbortController().signal)).toMatchObject({
      kind: 'failed',
      step: 'create',
    });

    expect(git(root, 'branch', '--list', creation.target.branch)).toContain(creation.target.branch);
    expect(existsSync(creation.target.path)).toBe(false);
  });

  it('stops and removes the worktree when cancelled while the included files are copied', async () => {
    const root = await createRepo('include-cancel');
    await writeFile(join(root, '.worktreeinclude'), '.env\n');
    const controller = new AbortController();
    const creation = await WorktreeCreation.plan({
      repoRoot: root,
      projectDir: join(scratch, 'include-cancel-worktrees'),
      osHomeDir: scratch,
      request: { source_branch: 'main' },
      copyIncludedFiles: async () => {
        controller.abort();
        return [];
      },
    });

    expect(await creation.run(progressOf(creation), controller.signal)).toEqual({ kind: 'stopped', step: 'include' });
    expect(existsSync(creation.target.path)).toBe(false);
    expect(git(root, 'branch', '--list', creation.target.branch)).toBe('');
  });

  it('fails with a timeout and creates nothing when the fetch hangs', async () => {
    const root = await createRepo('fetch-timeout');
    hangingRemote(root);
    const projectDir = join(scratch, 'fetch-timeout-worktrees');
    const creation = await WorktreeCreation.plan({
      repoRoot: root,
      projectDir,
      osHomeDir: scratch,
      request: { source_branch: 'main', use_remote: true },
      fetchTimeoutMs: 50,
    });
    const progress = progressOf(creation);

    const outcome = await creation.run(progress, new AbortController().signal);

    expect(outcome).toEqual({
      kind: 'failed',
      step: 'fetch',
      failure: { kind: 'fetch_timeout', remote_ref: 'origin/main', timeout_seconds: 1 },
    });
    expect(progress.steps).toMatchObject([
      { kind: 'fetch', state: 'failed', timed_out: true },
      { kind: 'create', state: 'pending' },
    ]);
    expect(progress.commandsRan).toBe(1);
    expect(existsSync(creation.target.path)).toBe(false);
    expect(git(root, 'branch', '--list', 'kimi/*')).toBe('');
  });

  it('resolves the remote branch from the upstream, then by name, without the network', async () => {
    const root = await createRepo('remotes');
    const head = git(root, 'rev-parse', 'HEAD');
    for (const remote of ['origin', 'fork', 'mirror']) {
      git(root, 'remote', 'add', remote, join(scratch, `${remote}-does-not-exist.git`));
    }
    const track = (remote: string, branch: string) =>
      git(root, 'update-ref', `refs/remotes/${remote}/${branch}`, head);

    git(root, 'branch', 'tracked');
    track('fork', 'renamed');
    git(root, 'branch', '--set-upstream-to=fork/renamed', 'tracked');
    track('origin', 'tracked');
    expect(await resolveRemoteRef(root, 'tracked')).toEqual({
      remote: 'fork',
      source: 'upstream',
      ref: 'fork/renamed',
      remoteRef: 'refs/heads/renamed',
      trackingRef: 'refs/remotes/fork/renamed',
    });

    git(root, 'branch', 'single');
    track('mirror', 'single');
    expect(await resolveRemoteRef(root, 'single')).toMatchObject({ remote: 'mirror', source: 'same_name', ref: 'mirror/single' });

    git(root, 'branch', 'both');
    track('origin', 'both');
    track('fork', 'both');
    expect((await resolveRemoteRef(root, 'both'))?.ref).toBe('origin/both');
    git(root, 'config', 'remote.pushDefault', 'fork');
    expect((await resolveRemoteRef(root, 'both'))?.ref).toBe('fork/both');
    git(root, 'config', 'checkout.defaultRemote', 'origin');
    expect((await resolveRemoteRef(root, 'both'))?.ref).toBe('origin/both');
    git(root, 'config', '--unset', 'remote.pushDefault');
    git(root, 'config', 'checkout.defaultRemote', 'fork');
    expect((await resolveRemoteRef(root, 'both'))?.ref).toBe('fork/both');

    git(root, 'branch', 'ambiguous');
    track('mirror', 'ambiguous');
    track('origin', 'ambiguous');
    git(root, 'config', 'checkout.defaultRemote', 'elsewhere');
    expect((await resolveRemoteRef(root, 'ambiguous'))?.ref).toBe('origin/ambiguous');
    git(root, 'update-ref', '-d', 'refs/remotes/origin/ambiguous');
    track('fork', 'ambiguous');
    expect(await resolveRemoteRef(root, 'ambiguous')).toBeUndefined();

    git(root, 'branch', 'never-pushed');
    expect(await resolveRemoteRef(root, 'never-pushed')).toBeUndefined();
    git(root, 'branch', 'local-upstream');
    git(root, 'branch', '--set-upstream-to=main', 'local-upstream');
    expect(await resolveRemoteRef(root, 'local-upstream')).toBeUndefined();

    const listed = await listLocalBranches(root);
    expect(listed.headBranch).toBe('main');
    expect(listed.remotes).toEqual(['fork', 'mirror', 'origin']);
    expect(Object.fromEntries(listed.branches.map((branch) => [branch.name, branch.remote?.ref]))).toEqual({
      main: undefined,
      tracked: 'fork/renamed',
      single: 'mirror/single',
      both: 'origin/both',
      ambiguous: undefined,
      'never-pushed': undefined,
      'local-upstream': undefined,
    });
  });
});
