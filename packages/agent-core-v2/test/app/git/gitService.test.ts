import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
        reg.define(IHostFileSystem, HostFileSystem);
        reg.define(IGitService, GitService);
      },
    });
    service = ix.get(IGitService);
  });

  afterEach(() => {
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

      const result = await service.status(repo, new Set(['a.txt']));
      expect(result.entries).toEqual({ 'a.txt': 'modified' });
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
