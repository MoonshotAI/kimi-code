import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IGitService } from '#/app/git/git';
import { discoverRepository } from '#/app/git/repository';
import { GitService } from '#/app/git/gitService';
import { findGitWorkTree } from '#/app/git/workTree';
import { ErrorCodes, isError2 } from '#/errors';
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

  describe('discoverRepository', () => {
    function outside(): string {
      const path = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-discovery-')));
      onTestFinished(() => rmSync(path, { recursive: true, force: true }));
      return path;
    }

    it('identifies a repository before its first commit, including subdirectories', async () => {
      const root = realpathSync.native(repo);
      const child = join(root, 'child');
      mkdirSync(child);
      expect(await discoverRepository(child)).toEqual({
        vcs: { type: 'git', store: join(root, '.git') },
        checkoutRoot: root,
        defaultDirectory: { kind: 'checkout', cwd: root },
      });
    });

    it('discovers the parent checkout across device boundaries only when Git is configured to cross them', async () => {
      const root = realpathSync.native(repo);
      const child = join(root, 'mounted');
      mkdirSync(child);
      const original = fsPromises.stat;
      const stub = vi.spyOn(fsPromises, 'stat').mockImplementation(async (path, options) => {
        const entry = await original(path, options);
        if (path === child) Object.defineProperty(entry, 'dev', { value: -1 });
        return entry;
      });
      syncBuiltinESMExports();
      try {
        for (const value of [undefined, '', 'off', '0']) {
          vi.stubEnv('GIT_DISCOVERY_ACROSS_FILESYSTEM', value);
          await expect(discoverRepository(child)).resolves.toBeNull();
        }
        for (const value of ['ON', '1', '2']) {
          vi.stubEnv('GIT_DISCOVERY_ACROSS_FILESYSTEM', value);
          await expect(discoverRepository(child)).resolves.toMatchObject({ checkoutRoot: root });
        }
      } finally {
        stub.mockRestore();
        syncBuiltinESMExports();
        vi.unstubAllEnvs();
      }
    });

    it('honors Git discovery ceilings when opening a child, the ceiling itself, or a nested checkout', async () => {
      const root = realpathSync.native(repo);
      const child = join(root, 'child');
      const nested = join(child, 'nested');
      mkdirSync(nested, { recursive: true });
      git(nested, 'init');
      vi.stubEnv('GIT_CEILING_DIRECTORIES', root);
      try {
        expect(() => git(child, 'rev-parse', '--show-toplevel')).toThrow();
        await expect(discoverRepository(child)).resolves.toBeNull();
        await expect(discoverRepository(root)).resolves.toMatchObject({ checkoutRoot: root });
        await expect(discoverRepository(nested)).resolves.toMatchObject({ checkoutRoot: nested });
        vi.stubEnv('GIT_CEILING_DIRECTORIES', child);
        await expect(discoverRepository(child)).resolves.toMatchObject({ checkoutRoot: root });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('preserves literal Git ceiling paths after an empty entry', async () => {
      const root = realpathSync.native(repo);
      const child = join(root, 'child');
      const gitRoot = root.split(sep).join('/');
      mkdirSync(child);
      try {
        vi.stubEnv('GIT_CEILING_DIRECTORIES', `${delimiter}${gitRoot}/`);
        expect(() => git(child, 'rev-parse', '--show-toplevel')).toThrow();
        await expect(discoverRepository(child)).resolves.toBeNull();
        const differentSpellings = [gitRoot.toUpperCase(), `${gitRoot}/child/..`];
        if (sep === '\\') differentSpellings.push(root);
        for (const entry of differentSpellings) {
          vi.stubEnv('GIT_CEILING_DIRECTORIES', `${delimiter}${entry}`);
          expect(realpathSync.native(git(child, 'rev-parse', '--show-toplevel'))).toBe(root);
          await expect(discoverRepository(child)).resolves.toMatchObject({ checkoutRoot: root });
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.runIf(process.platform === 'win32').each(['cmd', 'bat'])('uses Git from a trusted .%s shim in PATH', async (ext) => {
      const install = outside();
      const bin = join(install, 'bin & %PATH%');
      mkdirSync(bin);
      const nativeGit = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).split(/\r?\n/, 1)[0]!;
      writeFileSync(join(bin, `git.${ext}`), `@setlocal EnableDelayedExpansion\r\n@if not exist ".git" if not exist "HEAD" exit /b 90\r\n@"${nativeGit}" %*\r\n`);
      const root = join(outside(), 'work tree & %PATH% !literal!');
      mkdirSync(root);
      git(root, 'init');
      vi.stubEnv('PATH', bin);
      vi.stubEnv('PATHEXT', `.${ext.toUpperCase()}`);
      try {
        await expect(discoverRepository(root)).resolves.toMatchObject({ checkoutRoot: root });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('uses the bare store as the default from the store and from a linked checkout', async () => {
      const parent = outside();
      const bare = join(parent, 'bare');
      const tree = join(parent, 'linked tree');
      git(repo, 'commit', '--allow-empty', '-m', 'initial');
      git(repo, 'clone', '--bare', repo, bare);
      git(bare, 'worktree', 'add', '--detach', tree);
      const marker = join(tree, '.git');
      writeFileSync(marker, readFileSync(marker, 'utf8').replace(/\r?\n$/, '\r\n'), { flag: 'r+' });
      const store = { vcs: { type: 'git', store: bare }, defaultDirectory: { kind: 'bare', cwd: bare } };
      expect(await discoverRepository(tree)).toEqual({ ...store, checkoutRoot: tree });
      expect(await discoverRepository(bare)).toEqual({ ...store, checkoutRoot: null });
    });

    it.each(['local', 'worktree', 'included', 'worktree-include'])('uses the submodule checkout from %s configuration for its linked trees', async (config) => {
      const parent = outside();
      const module = join(parent, 'module');
      const tree = join(parent, 'linked');
      git(repo, 'commit', '--allow-empty', '-m', 'initial');
      git(parent, 'init');
      git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', repo, 'module');
      git(module, 'worktree', 'add', '--detach', tree);
      const control = join(parent, '.git', 'modules', 'module');
      if (config !== 'local') {
        const target = git(control, 'config', '--local', '--get', 'core.worktree');
        git(control, 'config', '--local', '--unset', 'core.worktree');
        const perWorktree = config.startsWith('worktree');
        if (perWorktree) git(control, 'config', '--local', 'extensions.worktreeConfig', 'true');
        const file = join(control, perWorktree ? 'config.worktree' : 'config');
        if (config === 'worktree') {
          git(control, 'config', '--file', file, 'core.worktree', target);
        } else {
          git(control, 'config', '--file', file, 'include.path', 'checkout-config');
          git(control, 'config', '--file', join(control, 'checkout-config'), 'core.worktree', target);
        }
      }
      const store = { vcs: { type: 'git', store: control }, defaultDirectory: { kind: 'checkout', cwd: module } };
      expect(await discoverRepository(tree)).toEqual({ ...store, checkoutRoot: tree });
      expect(await discoverRepository(module)).toEqual({ ...store, checkoutRoot: module });
      expect(await discoverRepository(parent)).toMatchObject({ vcs: { store: join(parent, '.git') } });
    });

    it('reports a worktree moved outside Git until its registration is repaired', async () => {
      const parent = outside();
      const tree = join(parent, 'original');
      const moved = join(parent, 'moved');
      git(repo, 'commit', '--allow-empty', '-m', 'initial');
      git(repo, 'worktree', 'add', '--detach', tree);
      renameSync(tree, moved);
      await expect(discoverRepository(moved)).rejects.toMatchObject({ code: ErrorCodes.FS_GIT_UNAVAILABLE });
      git(repo, 'worktree', 'repair', moved);
      expect(await discoverRepository(moved)).toMatchObject({ checkoutRoot: moved, defaultDirectory: { cwd: realpathSync.native(repo) } });
    });

    it('treats ordinary HEAD and refs files as contents of the opened directory', async () => {
      const child = join(repo, 'data');
      mkdirSync(child);
      const plain = outside();
      for (const folder of [child, plain]) {
        writeFileSync(join(folder, 'HEAD'), 'title');
        writeFileSync(join(folder, 'refs'), 'references');
        writeFileSync(join(folder, 'objects'), 'objects');
      }
      expect(await discoverRepository(child)).toMatchObject({ checkoutRoot: realpathSync.native(repo) });
      expect(await discoverRepository(plain)).toBeNull();
    });

    it('opens ordinary directories with HEAD and only one of the Git storage directories', async () => {
      for (const name of ['objects', 'refs']) {
        const child = join(repo, name);
        const plain = outside();
        mkdirSync(child);
        for (const folder of [child, plain]) {
          writeFileSync(join(folder, 'HEAD'), 'ref: refs/heads/main\n');
          mkdirSync(join(folder, name));
        }
        expect(await discoverRepository(child)).toMatchObject({ checkoutRoot: realpathSync.native(repo) });
        expect(await discoverRepository(plain)).toBeNull();
      }
    });

    it('reports a damaged bare repository inside a checkout', async () => {
      for (const missing of ['refs', 'objects']) {
        const bare = join(repo, 'bare-without-' + missing);
        git(repo, 'init', '--bare', bare);
        rmSync(join(bare, missing), { recursive: true });
        await expect(discoverRepository(bare)).rejects.toMatchObject({ code: ErrorCodes.FS_GIT_UNAVAILABLE });
      }
    });

    it('reports broken markers even in a parent repository', async () => {
      const nested = join(repo, 'nested');
      mkdirSync(nested);
      writeFileSync(join(nested, '.git'), 'gitdir: missing\n');
      await expect(discoverRepository(nested)).rejects.toMatchObject({ code: ErrorCodes.FS_GIT_UNAVAILABLE });
      rmSync(join(nested, '.git'));
      mkdirSync(join(nested, '.git'));
      await expect(discoverRepository(nested)).rejects.toMatchObject({ code: ErrorCodes.FS_GIT_UNAVAILABLE });
    });

    it('allows plain directories without Git and reports its absence for a repository', async () => {
      const plain = outside();
      vi.stubEnv('PATH', '');
      try {
        expect(await discoverRepository(plain)).toBeNull();
        await expect(discoverRepository(repo)).rejects.toMatchObject({ code: ErrorCodes.FS_GIT_UNAVAILABLE });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('respects the installed Git ownership policy and its selected global config', async () => {
      const config = join(outside(), 'gitconfig');
      vi.stubEnv('GIT_CONFIG_GLOBAL', config);
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      vi.stubEnv('GIT_TEST_ASSUME_DIFFERENT_OWNER', '1');
      try {
        for (const trusted of ['', '*']) {
          writeFileSync(config, `[safe]\n directory = ${trusted}\n`);
          const direct = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: repo });
          const discovered = await discoverRepository(repo).then(
            (found) => found?.checkoutRoot,
            (error: unknown) => isError2(error) ? error.code : error,
          );
          expect(discovered).toBe(direct.status === 0 ? realpathSync.native(repo) : ErrorCodes.FS_GIT_UNAVAILABLE);
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('uses the opened directory even when the parent process has selected a different repository', async () => {
      const other = outside();
      git(other, 'init');
      vi.stubEnv('GIT_DIR', join(other, '.git'));
      vi.stubEnv('GIT_WORK_TREE', other);
      vi.stubEnv('GIT_COMMON_DIR', join(other, '.git'));
      try {
        expect(await discoverRepository(repo)).toMatchObject({ vcs: { store: join(realpathSync.native(repo), '.git') } });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

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
