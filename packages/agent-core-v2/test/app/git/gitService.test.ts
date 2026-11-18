import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IGitService } from '#/app/git/git';
import { GitService } from '#/app/git/gitService';
import { findGitWorkTree } from '#/app/git/workTree';
import { ErrorCodes } from '#/errors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IWorkspaceInstanceManager, type WorkspaceInstanceChange } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import { Event } from '#/_base/event';
import type { Environment } from '#/environment/environment';
import { normalize } from 'pathe';

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
        reg.definePartialInstance(IWorkspaceInstanceManager, {
          findContaining: () => ({ id: 'workspace-1' } as never),
          onDidChange: Event.None as Event<WorkspaceInstanceChange>,
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

    it('counts the lines of untracked text files as additions', async () => {
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

      const all = await service.status(repo, { includePullRequest: false });
      expect(all.additions).toBe(1 + 3 + 2 + 1);
      expect(all.deletions).toBe(0);
      expect(all.stats_error).toBeUndefined();

      const scoped = await service.status(join(repo, 'fresh'), {
        scopeToCwd: true,
        includePullRequest: false,
      });
      expect(scoped.additions).toBe(3);
      const filtered = await service.status(repo, {
        pathFilter: new Set(['no-newline.txt']),
        includePullRequest: false,
      });
      expect(filtered.additions).toBe(2);
    });

    it('counts untracked files from a subdirectory and in a repository without commits', async () => {
      mkdirSync(join(repo, 'sub'), { recursive: true });
      writeFileSync(join(repo, 'top.txt'), 'one\ntwo\n');
      writeFileSync(join(repo, 'sub/in.txt'), 'one\n');

      const result = await service.status(join(repo, 'sub'), { includePullRequest: false });

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
