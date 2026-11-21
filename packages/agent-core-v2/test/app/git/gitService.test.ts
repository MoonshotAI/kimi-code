import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { IWorkspaceInstanceManager, type WorkspaceInstanceChange } from '#/workspace/workspaceInstance/workspaceInstanceManager';
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

    it('stops at a .git file without a gitdir pointer instead of walking up to the outer repo', async () => {
      const inner = join(repo, 'inner');
      mkdirSync(join(inner, 'src'), { recursive: true });
      writeFileSync(join(inner, '.git'), 'not a pointer\n');

      await expect(service.findWorkTree(inner)).resolves.toBeNull();
      await expect(service.findWorkTree(join(inner, 'src'))).resolves.toBeNull();
    });

    it('stops at a dangling .git symlink instead of walking up to the outer repo', async () => {
      const inner = join(repo, 'inner');
      mkdirSync(inner, { recursive: true });
      symlinkSync(join(repo, 'missing-git-dir'), join(inner, '.git'));

      await expect(service.findWorkTree(inner)).resolves.toBeNull();
    });

    it('keeps treating a .git directory without HEAD as the work tree', async () => {
      const inner = join(repo, 'inner');
      mkdirSync(join(inner, '.git'), { recursive: true });

      const result = await service.findWorkTree(inner);

      expect(result).toEqual({
        root: normalize(inner),
        dotGitPath: normalize(join(inner, '.git')),
        controlDirPath: normalize(join(inner, '.git')),
      });
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

  function grouped(
    layout: string,
    checkoutRoot: string,
    mainDir: string,
    canonicalMainDir = real(mainDir),
  ): CheckoutLocation {
    return {
      kind: 'grouped',
      layout,
      checkoutRoot: normalize(checkoutRoot),
      mainDir: normalize(mainDir),
      canonicalMainDir,
    } as CheckoutLocation;
  }

  it('leaves a directory outside any checkout on its own', async () => {
    await expect(locate(lab.dir('plain', 'nested'))).resolves.toEqual({ kind: 'own', reason: 'not-a-repo' });
  });

  it('groups a main checkout and its subdirectories under the literal checkout path', async () => {
    const main = mainCheckout(lab.dir('app'));

    await expect(locate(main)).resolves.toEqual(grouped('main', main, main));
    await expect(locate(lab.dir('app', 'src', 'lib'))).resolves.toEqual(grouped('main', main, main));
  });

  it.each([
    ['an absolute pointer', {}],
    ['a CRLF pointer', { lineEnding: '\r\n' as const }],
    ['a BOM-prefixed pointer', { bom: true }],
  ])('groups a linked worktree written with %s into its main checkout', async (_label, style) => {
    const main = mainCheckout(lab.dir('app'));
    const worktree = linkedWorktree(`${main}/.git`, lab.dir('app-fix'), style);

    await expect(locate(worktree)).resolves.toEqual(grouped('linked', worktree, real(main)));
    await expect(locate(lab.dir('app-fix', 'src'))).resolves.toEqual(grouped('linked', worktree, real(main)));
  });

  it('keeps the literal main checkout path a relative worktree pointer leads to', async () => {
    const main = mainCheckout(lab.dir('app'));
    const worktree = linkedWorktree(`${main}/.git`, lab.dir('app-fix'), { relative: true });

    await expect(locate(worktree)).resolves.toEqual(grouped('linked', worktree, main));
  });

  it('groups a .bare container and its worktrees under the container', async () => {
    const container = lab.dir('layout');
    const bare = bareContainer(container);
    const worktree = linkedWorktree(bare, lab.dir('layout', 'feat'));

    await expect(locate(container)).resolves.toEqual(grouped('main', container, container));
    await expect(locate(worktree)).resolves.toEqual(grouped('linked', worktree, real(container)));
  });

  it('groups a worktree of an independent bare repository under the bare repository', async () => {
    const bare = bareRepository(lab.dir('repo.git'));
    const worktree = linkedWorktree(bare, lab.dir('repo-wt'));

    await expect(locate(worktree)).resolves.toEqual(grouped('bare', worktree, real(bare)));
  });

  it('treats a submodule as its own checkout and groups its worktrees under it', async () => {
    const superproject = mainCheckout(lab.dir('super'));
    const modules = submodule(superproject, 'sub');
    const checkout = `${superproject}/sub`;
    const worktree = linkedWorktree(modules, lab.dir('sub-wt'));

    await expect(locate(checkout)).resolves.toEqual(grouped('main', checkout, checkout));
    await expect(locate(worktree)).resolves.toEqual(grouped('core-worktree', worktree, real(checkout)));
  });

  it('groups a separate-git-dir checkout under itself and leaves its worktrees on their own', async () => {
    const checkout = lab.dir('sep');
    const gitDir = separateGitDirCheckout(checkout, lab.dir('gitdirs', 'sep.git'));
    const worktree = linkedWorktree(gitDir, lab.dir('sep-fix'));

    await expect(locate(checkout)).resolves.toEqual(grouped('main', checkout, checkout));
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

    await expect(locate(mainLink)).resolves.toEqual(grouped('main', mainLink, mainLink, real(main)));
    await expect(locate(worktreeLink)).resolves.toEqual(grouped('linked', worktreeLink, real(main)));
  });

  it('groups worktrees whose paths hold spaces and non-ASCII names', async () => {
    const main = mainCheckout(lab.dir('中文 目录', '项目'));
    const worktree = linkedWorktree(`${main}/.git`, lab.dir('中文 目录', '项目-修复'));

    await expect(locate(worktree)).resolves.toEqual(grouped('linked', worktree, real(main)));
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

      await expect(locate(evil)).resolves.toEqual(grouped('main', evil, evil));
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

    it('treats a .git directory without HEAD as the checkout of its own directory', async () => {
      mainCheckout(lab.dir('outer'));
      const inner = lab.dir('outer', 'inner');
      mkdirSync(`${inner}/.git`);

      await expect(locate(inner)).resolves.toEqual(grouped('main', inner, inner));
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
      { kind: 'grouped', layout: 'main', checkoutRoot, mainDir: checkoutRoot, canonicalMainDir: checkoutRoot },
    ];

    expect(results.map(isDegradedLocation)).toEqual([false, false, true, true, true, true, false]);
    const degraded = results.find(isDegradedLocation);
    expectTypeOf(degraded?.checkoutRoot).toEqualTypeOf<AbsoluteDir | undefined>();
  });
});
