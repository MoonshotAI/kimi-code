import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IGitService } from '#/app/git/git';
import { GitService } from '#/app/git/gitService';
import {
  findGitWorkTree,
  findNearestGitMarker,
  isDegradedLocation,
  locateCheckout,
  type CheckoutLocation,
} from '#/app/git/workTree';
import { toAbsoluteDir, type AbsoluteDir } from '#/_base/utils/workdir-slug';
import { ErrorCodes } from '#/errors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IProjectInstanceManager, type ProjectInstanceChange } from '#/project/projectInstance/projectInstanceManager';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import { Event } from '#/_base/event';
import type { Environment } from '#/environment/environment';
import { normalize } from 'pathe';

import {
  bareContainer,
  bareRepository,
  createLayoutLab,
  forgedCoreWorktree,
  forgedPointer,
  linkedWorktree,
  mainCheckout,
  separateGitDirCheckout,
  submodule,
  type LayoutLab,
} from './checkoutLayouts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

describe('GitService', () => {
  let repo: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let service: IGitService;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-service-'));
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    disposables = new DisposableStore();
    const process = new HostProcessService();
    const environment = { process } as unknown as Environment;
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
        reg.define(IHostFileSystem, HostFileSystem);
        reg.definePartialInstance(IEnvironmentService, {
          _serviceBrand: undefined,
          inspect: () => environment,
          acquire: () => ({ environment, track: (resource) => resource, dispose: () => {} }),
          acquireWhenReady: async () => ({ environment, track: (resource) => resource, dispose: () => {} }),
        });
        reg.definePartialInstance(IProjectInstanceManager, {
          findContaining: () => ({ id: 'workspace-1' } as never),
          onDidChange: Event.None as Event<ProjectInstanceChange>,
        });
        reg.define(IGitService, GitService);
      },
    });
    service = ix.get(IGitService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    disposables.dispose();
    rmSync(repo, { recursive: true, force: true });
  });

  function commitAll(message: string): void {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', message);
  }

  describe('status', () => {
    it('reports a clean tree', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');

      const result = await service.status(repo);
      expect(typeof result.branch).toBe('string');
      expect(result.entries).toEqual({});
      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(0);
      expect(result.pullRequest).toBeNull();
    }, 15000);

    it('skips the PR process when pull requests are excluded', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');
      const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');

      const result = await service.status(repo, { includePullRequest: false });

      expect(result.branch).not.toBe('');
      expect(result.pullRequest).toBeNull();
      expect(spawn.mock.calls.some(([command]) => basename(command) === 'gh')).toBe(false);
    });

    it('reports a modified file with numstat', async () => {
      writeFileSync(join(repo, 'a.txt'), 'line1\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'line1\nline2\nline3\n');

      const result = await service.status(repo);
      expect(result.entries).toEqual({ 'a.txt': 'modified' });
      expect(result.additions).toBe(2);
      expect(result.deletions).toBe(0);
    });

    it('restricts entries to the path filter', async () => {
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      writeFileSync(join(repo, 'b.txt'), 'b\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'a2\n');
      writeFileSync(join(repo, 'b.txt'), 'b2\n');

      const result = await service.status(repo, { pathFilter: new Set(['a.txt']) });
      expect(result.entries).toEqual({ 'a.txt': 'modified' });
    });

    it('scopes entries and numstat to the selected cwd', async () => {
      mkdirSync(join(repo, 'a'), { recursive: true });
      mkdirSync(join(repo, 'b'), { recursive: true });
      writeFileSync(join(repo, 'a/file.txt'), 'one\n');
      writeFileSync(join(repo, 'a/other.txt'), 'one\n');
      writeFileSync(join(repo, 'b/file.txt'), 'one\n');
      commitAll('init');
      writeFileSync(join(repo, 'a/file.txt'), 'one\ntwo\n');
      writeFileSync(join(repo, 'a/other.txt'), 'one\ntwo\nthree\n');
      writeFileSync(join(repo, 'b/file.txt'), 'one\ntwo\nthree\n');

      const result = await service.status(join(repo, 'a'), {
        scopeToCwd: true,
        pathFilter: new Set(['file.txt']),
        includePullRequest: false,
      });

      expect(result.entries).toEqual({ 'file.txt': 'modified' });
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(0);
    });

    it('preserves a file named __proto__ in a selected cwd', async () => {
      mkdirSync(join(repo, 'sub'), { recursive: true });
      writeFileSync(join(repo, 'sub/__proto__'), 'one\n');
      commitAll('init');
      writeFileSync(join(repo, 'sub/__proto__'), 'one\ntwo\n');

      const result = await service.status(join(repo, 'sub'), {
        scopeToCwd: true,
        includePullRequest: false,
      });

      expect(Object.hasOwn(result.entries, '__proto__')).toBe(true);
      expect(JSON.stringify(result.entries)).toContain('"__proto__"');
    });

    it('preserves whitespace in the selected cwd prefix', async () => {
      mkdirSync(join(repo, ' lead'), { recursive: true });
      writeFileSync(join(repo, ' lead/file.txt'), 'one\n');
      commitAll('init');
      writeFileSync(join(repo, ' lead/file.txt'), 'one\ntwo\n');

      const result = await service.status(join(repo, ' lead'), {
        scopeToCwd: true,
        pathFilter: new Set(['file.txt']),
        includePullRequest: false,
      });

      expect(result.entries).toEqual({ 'file.txt': 'modified' });
    });

    it('reports a non-ASCII path without quoting', async () => {
      const name = 'output/2026-08-31-bilibili-BV175t86pEre-26.8.31-总能等到回踩的.md';
      mkdirSync(join(repo, 'output'), { recursive: true });
      writeFileSync(join(repo, name), 'line1\n');
      commitAll('init');
      writeFileSync(join(repo, name), 'line1\nline2\n');

      const result = await service.status(repo);
      expect(result.entries).toEqual({ [name]: 'modified' });
    });

    it('reports the new path of a non-ASCII rename', async () => {
      writeFileSync(join(repo, '旧名字.md'), 'line1\n');
      commitAll('init');
      git(repo, 'mv', '旧名字.md', '新名字.md');

      const result = await service.status(repo);
      expect(result.entries).toEqual({ '新名字.md': 'renamed' });
    });

    it('spawns git through its resolved PATH entry and never one inside the working directory', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');
      const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');

      await service.status(repo, { includePullRequest: false });
      expect(spawn.mock.calls.every(([command]) => isAbsolute(command))).toBe(true);

      const planted = join(repo, 'bin');
      mkdirSync(planted);
      writeFileSync(join(planted, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      vi.stubEnv('PATH', planted);
      spawn.mockClear();
      try {
        await expect(service.status(repo)).rejects.toMatchObject({ code: ErrorCodes.FS_GIT_UNAVAILABLE });
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('throws FS_GIT_UNAVAILABLE when not a repo', async () => {
      const notRepo = mkdtempSync(join(tmpdir(), 'not-repo-'));
      try {
        await expect(service.status(notRepo)).rejects.toMatchObject({
          code: ErrorCodes.FS_GIT_UNAVAILABLE,
        });
      } finally {
        rmSync(notRepo, { recursive: true, force: true });
      }
    });

    it('reports the head commit, the upstream and a detached HEAD', async () => {
      const unborn = await service.status(repo, { includePullRequest: false });
      expect(unborn).toMatchObject({ detached: false });
      expect(unborn.head).toBeUndefined();
      expect(unborn.upstream).toBeUndefined();

      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');
      const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
      const head = git(repo, 'rev-parse', '--short', 'HEAD');
      await expect(service.status(repo, { includePullRequest: false })).resolves.toMatchObject({
        branch,
        head,
        detached: false,
      });

      git(repo, 'remote', 'add', 'origin', join(repo, 'nowhere.git'));
      git(repo, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
      git(repo, 'branch', `--set-upstream-to=origin/${branch}`);
      writeFileSync(join(repo, 'a.txt'), 'hello\nagain\n');
      commitAll('second');
      await expect(service.status(repo, { includePullRequest: false })).resolves.toMatchObject({
        branch,
        upstream: `origin/${branch}`,
        ahead: 1,
        detached: false,
      });

      git(repo, 'checkout', '-q', '--detach');
      const detached = await service.status(repo, { includePullRequest: false });
      expect(detached).toMatchObject({ branch: '', detached: true, head: git(repo, 'rev-parse', '--short', 'HEAD') });
      expect(detached.upstream).toBeUndefined();
    });

    it('counts the lines of untracked text files as additions when asked', async () => {
      writeFileSync(join(repo, 'a.txt'), 'line1\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'line1\nline2\n');
      mkdirSync(join(repo, 'fresh/deep'), { recursive: true });
      writeFileSync(join(repo, 'fresh/deep/three.txt'), 'one\ntwo\nthree\n');
      writeFileSync(join(repo, 'no-newline.txt'), 'one\ntwo');
      writeFileSync(join(repo, 'empty.txt'), '');
      writeFileSync(join(repo, 'binary.bin'), Buffer.from([0x89, 0x50, 0x00, 0x0a, 0x0a]));
      writeFileSync(join(repo, 'huge.txt'), 'x\n'.repeat(600_000));
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
      writeFileSync(join(repo, 'ignored.txt'), 'a\nb\nc\n');

      const tracked = await service.status(repo, { includePullRequest: false });
      expect(tracked.additions).toBe(1);

      const all = await service.status(repo, { includePullRequest: false, includeUntracked: true });
      expect(all.additions).toBe(1 + 3 + 2 + 1);
      expect(all.deletions).toBe(0);
      expect(all.stats_error).toBeUndefined();

      const scoped = await service.status(join(repo, 'fresh'), {
        scopeToCwd: true,
        includePullRequest: false,
        includeUntracked: true,
      });
      expect(scoped.additions).toBe(3);
      const filtered = await service.status(repo, {
        pathFilter: new Set(['no-newline.txt']),
        includePullRequest: false,
        includeUntracked: true,
      });
      expect(filtered.additions).toBe(2);
    });

    it('counts untracked files from a subdirectory and in a repository without commits', async () => {
      mkdirSync(join(repo, 'sub'), { recursive: true });
      writeFileSync(join(repo, 'top.txt'), 'one\ntwo\n');
      writeFileSync(join(repo, 'sub/in.txt'), 'one\n');

      const result = await service.status(join(repo, 'sub'), {
        includePullRequest: false,
        includeUntracked: true,
      });

      expect(result.additions).toBe(3);
      expect(result.stats_error).toBeUndefined();
    });

    it('returns the raw output instead of zeros when line counting fails', async () => {
      writeFileSync(join(repo, 'a.txt'), 'line1\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'line1\nline2\n');
      const realSpawn = HostProcessService.prototype.spawn;
      vi.spyOn(HostProcessService.prototype, 'spawn').mockImplementation(function (
        this: HostProcessService,
        command,
        args,
        options,
      ) {
        const failing = args?.includes('--numstat') === true;
        return realSpawn.call(this, command, failing ? ['diff', '--no-such-option'] : args, options);
      });

      const result = await service.status(repo, { includePullRequest: false });

      expect(result.entries).toEqual({ 'a.txt': 'modified' });
      expect(result.additions).toBe(0);
      expect(result.stats_error).toMatch(/^git diff --numstat exited with code \d+: .*no-such-option/s);
    });
  });

  describe('pullRequest', () => {
    it('re-reads the pull request after a branch switch and skips gh on a detached HEAD', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');
      const fakeBin = mkdtempSync(join(tmpdir(), 'fake-gh-'));
      writeFileSync(
        join(fakeBin, 'gh'),
        `#!/bin/sh\necho '{"number":7,"url":"https://github.com/acme/repo/pull/7","state":"OPEN","isDraft":false}'\n`,
        { mode: 0o755 },
      );
      vi.stubEnv('PATH', `${fakeBin}${delimiter}${process.env['PATH'] ?? ''}`);
      onTestFinished(() => {
        vi.unstubAllEnvs();
        rmSync(fakeBin, { recursive: true, force: true });
      });
      const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');
      const ghCalls = (): number => spawn.mock.calls.filter(([command]) => basename(command) === 'gh').length;

      await expect(service.pullRequest(repo)).resolves.toMatchObject({ number: 7 });
      await service.status(repo);
      expect(ghCalls()).toBe(1);

      git(repo, 'checkout', '-q', '-b', 'feature');
      await service.pullRequest(repo);
      expect(ghCalls()).toBe(2);

      git(repo, 'checkout', '-q', '--detach');
      await expect(service.pullRequest(repo)).resolves.toBeNull();
      await expect(service.status(repo)).resolves.toMatchObject({ branch: '', pullRequest: null });
      expect(ghCalls()).toBe(2);
    }, 15000);

    it.each([
      {
        name: 'a pull request',
        script: `echo '{"number":7,"url":"https://github.com/acme/repo/pull/7","state":"OPEN","isDraft":true}'`,
        expected: {
          pullRequest: { number: 7, state: 'draft', url: 'https://github.com/acme/repo/pull/7' },
          status: 'found',
        },
      },
      {
        name: 'a branch without a pull request',
        script: `echo 'no pull requests found for branch "main"' >&2; exit 1`,
        expected: { pullRequest: null, status: 'none' },
      },
      {
        name: 'a repository that is not on GitHub',
        script: `echo 'none of the git remotes configured for this repository point to a known GitHub host' >&2; exit 1`,
        expected: { pullRequest: null, status: 'none' },
      },
      {
        name: 'a gh that is not signed in',
        script: `echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4`,
        expected: { pullRequest: null, status: 'unavailable' },
      },
      {
        name: 'a gh failure',
        script: `echo 'HTTP 502: Bad Gateway' >&2; exit 1`,
        expected: {
          pullRequest: null,
          status: 'failed',
          error: 'gh pr view exited with code 1: HTTP 502: Bad Gateway',
        },
      },
      {
        name: 'unreadable gh output',
        script: `echo 'not json'`,
        expected: { pullRequest: null, status: 'failed', error: 'not json' },
      },
    ])('classifies $name', async ({ script, expected }) => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');
      const fakeBin = mkdtempSync(join(tmpdir(), 'fake-gh-'));
      writeFileSync(join(fakeBin, 'gh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      vi.stubEnv('PATH', `${fakeBin}${delimiter}${process.env['PATH'] ?? ''}`);
      onTestFinished(() => {
        vi.unstubAllEnvs();
        rmSync(fakeBin, { recursive: true, force: true });
      });

      await expect(service.pullRequestLookup(repo)).resolves.toEqual(expected);
      const status = await service.status(repo);
      expect(status.pullRequest).toEqual(expected.pullRequest);
      expect(status.pull_request_status).toBe(expected.status);
      expect(status.pull_request_error).toBe('error' in expected ? expected.error : undefined);
    });

    it('reports an unavailable lookup when gh is not installed and none on a detached HEAD', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');
      const gitDir = mkdtempSync(join(tmpdir(), 'only-git-'));
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      writeFileSync(join(gitDir, 'git'), `#!/bin/sh\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
      vi.stubEnv('PATH', gitDir);
      onTestFinished(() => {
        vi.unstubAllEnvs();
        rmSync(gitDir, { recursive: true, force: true });
      });

      await expect(service.pullRequestLookup(repo)).resolves.toEqual({
        pullRequest: null,
        status: 'unavailable',
      });
      await expect(service.status(repo, { includePullRequest: false })).resolves.not.toHaveProperty(
        'pull_request_status',
      );
      git(repo, 'checkout', '-q', '--detach');
      await expect(service.pullRequestLookup(repo)).resolves.toEqual({ pullRequest: null, status: 'none' });
    });

    it('throws FS_GIT_UNAVAILABLE when not a repo', async () => {
      const notRepo = mkdtempSync(join(tmpdir(), 'not-repo-'));
      try {
        await expect(service.pullRequest(notRepo)).rejects.toMatchObject({
          code: ErrorCodes.FS_GIT_UNAVAILABLE,
        });
      } finally {
        rmSync(notRepo, { recursive: true, force: true });
      }
    });
  });

  describe('diff', () => {
    it('returns the unified diff for a tracked modified file', async () => {
      writeFileSync(join(repo, 'a.txt'), 'old\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'new\n');

      const result = await service.diff(repo, 'a.txt', join(repo, 'a.txt'));
      expect(result.path).toBe('a.txt');
      expect(result.diff).toContain('+new');
      expect(result.diff).toContain('-old');
      expect(result.truncated).toBe(false);
    });

    it('returns an all-added diff for an untracked file', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');
      writeFileSync(join(repo, 'b.txt'), 'brand new\n');

      const result = await service.diff(repo, 'b.txt', join(repo, 'b.txt'));
      expect(result.diff).toContain('+brand new');
    });

    it('throws FS_PATH_NOT_FOUND for a missing path', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');

      await expect(
        service.diff(repo, 'missing.txt', join(repo, 'missing.txt')),
      ).rejects.toMatchObject({ code: ErrorCodes.FS_PATH_NOT_FOUND });
    });
  });

  describe('findWorkTree', () => {
    it('finds the repo root from a nested subdirectory', async () => {
      mkdirSync(join(repo, 'a', 'b'), { recursive: true });

      const result = await service.findWorkTree(join(repo, 'a', 'b'));

      expect(result).toEqual({
        root: normalize(repo),
        dotGitPath: normalize(join(repo, '.git')),
        controlDirPath: normalize(join(repo, '.git')),
      });
    });

    it('returns null when no ancestor holds a .git entry', async () => {
      const plain = mkdtempSync(join(tmpdir(), 'git-service-plain-'));
      try {
        await expect(service.findWorkTree(plain)).resolves.toBeNull();
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });

    it('resolves an absolute gitdir pointer in a .git file', async () => {
      const wt = mkdtempSync(join(tmpdir(), 'git-service-wt-'));
      try {
        const control = join(repo, '.git', 'worktrees', 'wt');
        writeFileSync(join(wt, '.git'), `gitdir: ${control}\n`);

        const result = await service.findWorkTree(wt);

        expect(result?.root).toBe(normalize(wt));
        expect(result?.dotGitPath).toBe(normalize(join(wt, '.git')));
        expect(result?.controlDirPath).toBe(normalize(control));
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    });

    it('resolves a relative gitdir pointer against the marker parent', async () => {
      const wt = mkdtempSync(join(tmpdir(), 'git-service-wt-'));
      try {
        writeFileSync(join(wt, '.git'), 'gitdir: ../gitdir-target\n');

        const result = await service.findWorkTree(wt);

        expect(result?.controlDirPath).toBe(normalize(join(wt, '..', 'gitdir-target')));
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    });

    it('parses a BOM-prefixed gitdir pointer', async () => {
      const wt = mkdtempSync(join(tmpdir(), 'git-service-wt-'));
      try {
        writeFileSync(join(wt, '.git'), '\uFEFFgitdir: ../target\n');

        const result = await service.findWorkTree(wt);

        expect(result?.controlDirPath).toBe(normalize(join(wt, '..', 'target')));
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    });

    it('skips a .git file without a gitdir pointer and keeps walking up', async () => {
      const inner = join(repo, 'inner');
      mkdirSync(inner, { recursive: true });
      writeFileSync(join(inner, '.git'), 'not a pointer\n');

      const result = await service.findWorkTree(inner);

      expect(result?.root).toBe(normalize(repo));
    });

    it('returns null for a relative cwd', async () => {
      await expect(findGitWorkTree(new HostFileSystem(), 'some/relative/path')).resolves.toBeNull();
    });
  });
});

describe('findNearestGitMarker', () => {
  let base: string;
  const fs = new HostFileSystem();

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'git-marker-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function dir(...segments: string[]): string {
    const path = join(base, ...segments);
    mkdirSync(path, { recursive: true });
    return path;
  }

  it('returns undefined when no ancestor holds a .git entry', async () => {
    await expect(findNearestGitMarker(fs, dir('plain', 'nested'))).resolves.toBeUndefined();
  });

  it('reports a .git directory with HEAD from a nested directory', async () => {
    const repo = dir('repo');
    git(repo, 'init');

    await expect(findNearestGitMarker(fs, dir('repo', 'a', 'b'))).resolves.toEqual({
      kind: 'directory',
      root: normalize(repo),
      dotGitPath: normalize(join(repo, '.git')),
    });
  });

  it('reports a .git directory without HEAD as a directory marker', async () => {
    const repo = dir('repo');
    dir('repo', '.git');

    await expect(findNearestGitMarker(fs, repo)).resolves.toEqual({
      kind: 'directory',
      root: normalize(repo),
      dotGitPath: normalize(join(repo, '.git')),
    });
  });

  it.each([
    ['an absolute pointer', (target: string) => `gitdir: ${target}\n`],
    ['a relative pointer', () => 'gitdir: ../store/worktrees/wt\n'],
    ['a BOM-prefixed pointer', () => '\uFEFFgitdir: ../store/worktrees/wt\n'],
    ['a CRLF pointer', () => 'gitdir: ../store/worktrees/wt\r\n'],
  ])('resolves %s in a .git file', async (_label, content) => {
    const target = join(base, 'store', 'worktrees', 'wt');
    const wt = dir('wt');
    writeFileSync(join(wt, '.git'), content(target));

    await expect(findNearestGitMarker(fs, dir('wt', 'src'))).resolves.toEqual({
      kind: 'pointer',
      root: normalize(wt),
      dotGitPath: normalize(join(wt, '.git')),
      gitDir: normalize(target),
    });
  });

  it.each([
    ['without a gitdir line', 'not a pointer\n'],
    ['with an empty gitdir', 'gitdir:   \r\n'],
    ['that is empty', ''],
  ])('stops at a .git file %s and reports it invalid', async (_label, content) => {
    const outer = dir('outer');
    git(outer, 'init');
    const inner = dir('outer', 'inner');
    writeFileSync(join(inner, '.git'), content);

    await expect(findNearestGitMarker(fs, dir('outer', 'inner', 'src'))).resolves.toEqual({
      kind: 'invalid',
      root: normalize(inner),
      dotGitPath: normalize(join(inner, '.git')),
    });
  });

  it('stops at a dangling .git symlink and reports it invalid', async () => {
    const outer = dir('outer');
    git(outer, 'init');
    const inner = dir('outer', 'inner');
    symlinkSync(join(base, 'missing'), join(inner, '.git'));

    await expect(findNearestGitMarker(fs, inner)).resolves.toEqual({
      kind: 'invalid',
      root: normalize(inner),
      dotGitPath: normalize(join(inner, '.git')),
    });
  });

  it('prefers the nearest marker over an enclosing repository', async () => {
    const outer = dir('outer');
    git(outer, 'init');
    const nested = dir('outer', 'nested');
    writeFileSync(join(nested, '.git'), 'gitdir: ../.git/worktrees/nested\n');

    await expect(findNearestGitMarker(fs, dir('outer', 'nested', 'src'))).resolves.toMatchObject({
      kind: 'pointer',
      root: normalize(nested),
    });
  });
});

describe('locateCheckout', () => {
  const fs = new HostFileSystem();
  let lab: LayoutLab;

  beforeEach(() => {
    lab = createLayoutLab('locate-checkout-');
  });

  afterEach(() => {
    lab.dispose();
  });

  function locate(path: string): Promise<CheckoutLocation> {
    return locateCheckout(fs, toAbsoluteDir(path)!);
  }

  function real(path: string): string {
    return normalize(realpathSync(path));
  }

  function committedRepository(dir: string): string {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'initial');
    return dir;
  }

  function grouped(
    checkoutRoot: string,
    mainDir: string,
    canonicalMainDir = real(mainDir),
  ): CheckoutLocation {
    return {
      kind: 'grouped',
      checkoutRoot: normalize(checkoutRoot) as AbsoluteDir,
      mainDir: normalize(mainDir) as AbsoluteDir,
      canonicalMainDir: canonicalMainDir as AbsoluteDir,
    };
  }

  it('leaves a directory outside any checkout on its own', async () => {
    await expect(locate(lab.dir('plain', 'nested'))).resolves.toEqual({ kind: 'own', reason: 'not-a-repo' });
  });

  it('groups a main checkout and its subdirectories under the literal checkout path', async () => {
    const main = mainCheckout(lab.dir('app'));

    await expect(locate(main)).resolves.toEqual(grouped(main, main));
    await expect(locate(lab.dir('app', 'src', 'lib'))).resolves.toEqual(grouped(main, main));
  });

  it.each([
    ['an absolute pointer', {}],
    ['a CRLF pointer', { lineEnding: '\r\n' as const }],
    ['a BOM-prefixed pointer', { bom: true }],
  ])('groups a linked worktree written with %s into its main checkout', async (_label, style) => {
    const main = mainCheckout(lab.dir('app'));
    const worktree = linkedWorktree(`${main}/.git`, lab.dir('app-fix'), style);

    await expect(locate(worktree)).resolves.toEqual(grouped(worktree, real(main)));
    await expect(locate(lab.dir('app-fix', 'src'))).resolves.toEqual(grouped(worktree, real(main)));
  });

  it('keeps the literal main checkout path a relative worktree pointer leads to', async () => {
    const main = mainCheckout(lab.dir('app'));
    const worktree = linkedWorktree(`${main}/.git`, lab.dir('app-fix'), { relative: true });

    await expect(locate(worktree)).resolves.toEqual(grouped(worktree, main));
  });

  it('groups a .bare container and its worktrees under the container', async () => {
    const container = lab.dir('layout');
    const bare = bareContainer(container);
    const worktree = linkedWorktree(bare, lab.dir('layout', 'feat'));

    await expect(locate(container)).resolves.toEqual(grouped(container, container));
    await expect(locate(worktree)).resolves.toEqual(grouped(worktree, real(container)));
  });

  it('groups a worktree of an independent bare repository under the bare repository', async () => {
    const bare = bareRepository(lab.dir('repo.git'));
    const worktree = linkedWorktree(bare, lab.dir('repo-wt'));

    await expect(locate(worktree)).resolves.toEqual(grouped(worktree, real(bare)));
  });

  it('treats a submodule as its own checkout and groups its worktrees under it', async () => {
    const superproject = mainCheckout(lab.dir('super'));
    const modules = submodule(superproject, 'sub');
    const checkout = `${superproject}/sub`;
    const worktree = linkedWorktree(modules, lab.dir('sub-wt'));

    await expect(locate(checkout)).resolves.toEqual(grouped(checkout, checkout));
    await expect(locate(worktree)).resolves.toEqual(grouped(worktree, real(checkout)));
  });

  it('keeps grouping the worktrees of a bare repository after git sparse-checkout moved its settings to config.worktree', async () => {
    const source = committedRepository(lab.dir('source'));
    const bare = join(lab.base, 'app.git');
    git(lab.base, 'clone', '-q', '--bare', source, bare);
    const [worktree, sparse] = ['one', 'two'].map((name) => {
      git(bare, 'worktree', 'add', '-q', '-b', name, join(lab.base, name));
      return join(lab.base, name);
    }) as [string, string];

    git(sparse, 'sparse-checkout', 'init', '--cone');

    expect(readFileSync(join(bare, 'config.worktree'), 'utf8')).toContain('bare = true');
    await expect(locate(worktree)).resolves.toEqual(grouped(worktree, real(bare)));
    await expect(locate(sparse)).resolves.toEqual(grouped(sparse, real(bare)));
  });

  it('keeps grouping the worktrees of a submodule after git sparse-checkout moved its settings to config.worktree', async () => {
    const source = committedRepository(lab.dir('source'));
    const superproject = committedRepository(lab.dir('super'));
    git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'sub');
    const checkout = join(superproject, 'sub');
    const worktree = join(lab.base, 'sub-fix');
    git(checkout, 'worktree', 'add', '-q', '-b', 'fix', worktree);

    git(worktree, 'sparse-checkout', 'init', '--cone');

    expect(readFileSync(join(superproject, '.git', 'modules', 'sub', 'config.worktree'), 'utf8')).toContain('worktree = ../../../sub');
    await expect(locate(worktree)).resolves.toEqual(grouped(worktree, real(checkout)));
  });

  it('leaves the worktrees of a submodule on their own when git quotes the path of the submodule in its config', async () => {
    const source = committedRepository(lab.dir('source'));
    const superproject = committedRepository(lab.dir('super'));
    git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'a # b');
    const checkout = join(superproject, 'a # b');
    const worktree = join(lab.base, 'sub-fix');
    git(checkout, 'worktree', 'add', '-q', '-b', 'fix', worktree);

    expect(readFileSync(join(superproject, '.git', 'modules', 'a # b', 'config'), 'utf8')).toContain('worktree = "../../../a # b"');
    await expect(locate(worktree)).resolves.toMatchObject({ kind: 'rejected', reason: 'core-worktree-mismatch' });
  });

  it('lets the core.worktree of config.worktree override a stale one in the shared config, as git does', async () => {
    const superproject = mainCheckout(lab.dir('super'));
    const modules = submodule(superproject, 'sub');
    const checkout = `${superproject}/sub`;
    const worktree = linkedWorktree(modules, lab.dir('sub-wt'));
    writeFileSync(join(modules, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ../../../stale\n');
    writeFileSync(join(modules, 'config.worktree'), '[core]\n\tworktree = ../../../sub\n');

    await expect(locate(worktree)).resolves.toEqual(grouped(worktree, real(checkout)));
  });

  it('groups a separate-git-dir checkout under itself and leaves its worktrees on their own', async () => {
    const checkout = lab.dir('sep');
    const gitDir = separateGitDirCheckout(checkout, lab.dir('gitdirs', 'sep.git'));
    const worktree = linkedWorktree(gitDir, lab.dir('sep-fix'));

    await expect(locate(checkout)).resolves.toEqual(grouped(checkout, checkout));
    await expect(locate(worktree)).resolves.toEqual({
      kind: 'own',
      reason: 'main-unknown',
      checkoutRoot: normalize(worktree),
    });
  });

  it('follows the checkout reached through a symlinked path', async () => {
    const main = mainCheckout(lab.dir('app'));
    const worktree = linkedWorktree(`${main}/.git`, lab.dir('app-fix'));
    const mainLink = `${lab.base}/app-link`;
    const worktreeLink = `${lab.base}/app-fix-link`;
    symlinkSync(main, mainLink, 'dir');
    symlinkSync(worktree, worktreeLink, 'dir');

    await expect(locate(mainLink)).resolves.toEqual(grouped(mainLink, mainLink, real(main)));
    await expect(locate(worktreeLink)).resolves.toEqual(grouped(worktreeLink, real(main)));
  });

  it('groups worktrees whose paths hold spaces and non-ASCII names', async () => {
    const main = mainCheckout(lab.dir('中文 目录', '项目'));
    const worktree = linkedWorktree(`${main}/.git`, lab.dir('中文 目录', '项目-修复'));

    await expect(locate(worktree)).resolves.toEqual(grouped(worktree, real(main)));
  });

  describe('forged pointers', () => {
    function trustedRepository(): string {
      const trusted = mainCheckout(lab.dir('trusted'));
      linkedWorktree(`${trusted}/.git`, lab.dir('trusted-fix'));
      submodule(trusted, 'sub');
      return trusted;
    }

    it.each([
      ['beside the trusted repository', ''],
      ['inside an ignored directory of the trusted repository', 'trusted/ignored/'],
    ])('rejects a borrowed worktree pointer %s', async (_label, prefix) => {
      const trusted = trustedRepository();
      const evil = forgedPointer(lab.dir(`${prefix}evil`), `${trusted}/.git/worktrees/trusted-fix`);

      await expect(locate(evil)).resolves.toEqual({
        kind: 'rejected',
        reason: 'backpointer-mismatch',
        checkoutRoot: normalize(evil),
      });
    });

    it.each([
      ['beside the trusted repository', ''],
      ['inside an ignored directory of the trusted repository', 'trusted/ignored/'],
    ])('keeps a borrowed submodule pointer %s on its own checkout', async (_label, prefix) => {
      const trusted = trustedRepository();
      const evil = forgedPointer(lab.dir(`${prefix}evil`), `${trusted}/.git/modules/sub`);

      await expect(locate(evil)).resolves.toEqual(grouped(evil, evil));
    });

    it.each([
      ['beside the trusted repository', ''],
      ['inside an ignored directory of the trusted repository', 'trusted/ignored/'],
    ])('rejects a forged core.worktree %s', async (_label, prefix) => {
      const trusted = trustedRepository();
      const worktree = forgedCoreWorktree(lab.dir(`${prefix}attacker`), trusted);

      await expect(locate(worktree)).resolves.toEqual({
        kind: 'rejected',
        reason: 'core-worktree-mismatch',
        checkoutRoot: normalize(worktree),
      });
    });

    it('rejects a forged core.worktree that only config.worktree declares', async () => {
      const trusted = trustedRepository();
      const attacker = lab.dir('attacker');
      const worktree = forgedCoreWorktree(attacker, trusted);
      renameSync(join(attacker, 'fake.git', 'config'), join(attacker, 'fake.git', 'config.worktree'));

      await expect(locate(worktree)).resolves.toEqual({
        kind: 'rejected',
        reason: 'core-worktree-mismatch',
        checkoutRoot: normalize(worktree),
      });
    });

    it('rejects worktree metadata whose registered path is not a .git entry', async () => {
      const main = mainCheckout(lab.dir('app'));
      const worktree = linkedWorktree(`${main}/.git`, lab.dir('app-fix'));
      writeFileSync(`${main}/.git/worktrees/app-fix/gitdir`, `${real(worktree)}/elsewhere\n`);

      await expect(locate(worktree)).resolves.toEqual({
        kind: 'rejected',
        reason: 'registered-path-not-dotgit',
        checkoutRoot: normalize(worktree),
      });
    });
  });

  describe('unreadable .git entries', () => {
    it('stops at an unparseable .git file instead of grouping into the enclosing repository', async () => {
      mainCheckout(lab.dir('outer'));
      const inner = lab.dir('outer', 'inner');
      writeFileSync(`${inner}/.git`, 'not a pointer\n');

      await expect(locate(lab.dir('outer', 'inner', 'src'))).resolves.toEqual({
        kind: 'own',
        reason: 'unreadable-dotgit',
        checkoutRoot: normalize(inner),
      });
    });

    it('stops at a .git directory without HEAD, which git does not recognize, instead of grouping under it', async () => {
      mainCheckout(lab.dir('outer'));
      const inner = lab.dir('outer', 'inner');
      mkdirSync(`${inner}/.git`);
      const own = { kind: 'own', reason: 'unreadable-dotgit', checkoutRoot: normalize(inner) };

      await expect(locate(inner)).resolves.toEqual(own);
      await expect(locate(lab.dir('outer', 'inner', 'src'))).resolves.toEqual(own);
    });

    it('keeps a .git directory whose HEAD is a dangling symlink as a checkout', async () => {
      const main = lab.dir('app');
      mkdirSync(`${main}/.git`);
      symlinkSync('refs/heads/main', `${main}/.git/HEAD`);

      await expect(locate(lab.dir('app', 'src'))).resolves.toEqual(grouped(main, main));
    });

    it('reports a pointer to a git directory without HEAD', async () => {
      const checkout = lab.dir('sep');
      const gitDir = separateGitDirCheckout(checkout, lab.dir('gitdirs', 'sep.git'));
      rmSync(`${gitDir}/HEAD`);

      await expect(locate(lab.dir('sep', 'src'))).resolves.toEqual({
        kind: 'own',
        reason: 'invalid-gitdir',
        checkoutRoot: normalize(checkout),
      });
    });

    it('rejects a .git pointer that is a symlink', async () => {
      const main = mainCheckout(lab.dir('app'));
      const worktree = linkedWorktree(`${main}/.git`, lab.dir('app-fix'));
      const link = lab.dir('linked-pointer');
      symlinkSync(`${worktree}/.git`, `${link}/.git`);

      await expect(locate(link)).resolves.toEqual({
        kind: 'own',
        reason: 'unreadable-dotgit',
        checkoutRoot: normalize(link),
      });
    });

    it('reports a pointer to a missing git directory', async () => {
      const worktree = lab.dir('app-fix');
      writeFileSync(`${worktree}/.git`, `gitdir: ${lab.base}/missing/.git/worktrees/app-fix\n`);

      await expect(locate(worktree)).resolves.toEqual({
        kind: 'own',
        reason: 'invalid-gitdir',
        checkoutRoot: normalize(worktree),
      });
    });

    it('reports worktree metadata without its commondir file', async () => {
      const main = mainCheckout(lab.dir('app'));
      const worktree = linkedWorktree(`${main}/.git`, lab.dir('app-fix'));
      rmSync(`${main}/.git/worktrees/app-fix/commondir`);

      await expect(locate(worktree)).resolves.toEqual({
        kind: 'own',
        reason: 'incomplete-worktree-metadata',
        checkoutRoot: normalize(worktree),
      });
    });
  });

  it('reads only the disk and ignores GIT_* variables of the process', async () => {
    const other = mainCheckout(lab.dir('other'));
    const plain = lab.dir('plain');
    vi.stubEnv('GIT_DIR', `${other}/.git`);
    vi.stubEnv('GIT_WORK_TREE', other);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    await expect(locate(plain)).resolves.toEqual({ kind: 'own', reason: 'not-a-repo' });
  });

  it('flags unreadable and rejected results as degraded and narrows them to a checkout root', () => {
    const checkoutRoot = '/repo' as AbsoluteDir;
    const results: readonly CheckoutLocation[] = [
      { kind: 'own', reason: 'not-a-repo' },
      { kind: 'own', reason: 'main-unknown', checkoutRoot },
      { kind: 'own', reason: 'unreadable-dotgit', checkoutRoot },
      { kind: 'own', reason: 'invalid-gitdir', checkoutRoot },
      { kind: 'own', reason: 'incomplete-worktree-metadata', checkoutRoot },
      { kind: 'rejected', reason: 'backpointer-mismatch', checkoutRoot },
      { kind: 'grouped', checkoutRoot, mainDir: checkoutRoot, canonicalMainDir: checkoutRoot },
    ];

    expect(results.map(isDegradedLocation)).toEqual([false, false, true, true, true, true, false]);
    const degraded = results.find(isDegradedLocation);
    expectTypeOf(degraded?.checkoutRoot).toEqualTypeOf<AbsoluteDir | undefined>();
  });
});
