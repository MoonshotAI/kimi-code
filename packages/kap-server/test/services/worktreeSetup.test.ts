import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listLocalBranches, resolveRemoteRef } from '../../src/services/worktrees/gitRefs';
import { runSetupScript } from '../../src/services/worktrees/setupScript';
import {
  WorktreeCreation,
  abbreviateHome,
  displayCommand,
  projectDirectoryName,
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

  it('turns a workspace name into a directory name', () => {
    expect(projectDirectoryName('kimi-code')).toBe('kimi-code');
    expect(projectDirectoryName('  my app: v2/next  ')).toBe('my-app-v2-next');
    expect(projectDirectoryName('项目 一')).toBe('项目-一');
    expect(projectDirectoryName('..')).toBe('project');
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

  it('stops a setup script that runs past its time limit', async () => {
    const root = await createRepo('script-timeout');
    await mkdir(join(root, '.kimi'));
    const content = '#!/bin/sh\necho before\nsleep 30\n';
    await writeFile(join(root, '.kimi', 'setup.sh'), content);
    const progress: SetupProgress = {
      steps: [{ kind: 'script', state: 'pending' }],
      commandsRan: 0,
      notify: () => {},
    };

    const outcome = await runSetupScript(
      { repoRoot: root, worktreePath: root, content, osHomeDir: scratch, timeoutMs: 400 },
      progress,
      new AbortController().signal,
    );

    expect(outcome).toEqual({
      kind: 'failed',
      step: 'script',
      failure: { kind: 'script_timeout', timeout_seconds: 1 },
    });
    expect(progress.steps).toEqual([
      {
        kind: 'script',
        state: 'failed',
        command: '/bin/sh ~/script-timeout/.kimi/setup.sh',
        output: 'before\n',
        timed_out: true,
      },
    ]);
    expect(progress.commandsRan).toBe(1);
  });
});
