import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createWorktree, findGitRoot, listWorktrees, removeWorktree, WorktreeError } from '#/utils/git/worktree';

function initRepo(path: string): void {
  execSync('git init', { cwd: path, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: path, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: path, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "initial"', { cwd: path, stdio: 'ignore' });
}

function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe('findGitRoot', () => {
  it('returns null outside a git repository', () => {
    const dir = makeTempDir('kimi-not-git-');
    expect(findGitRoot(dir)).toBeNull();
  });

  it('finds the repo root from the repo root', () => {
    const dir = makeTempDir('kimi-git-root-');
    initRepo(dir);
    expect(findGitRoot(dir)).toBe(dir);
  });

  it('finds the repo root from a subdirectory', () => {
    const dir = makeTempDir('kimi-git-sub-');
    initRepo(dir);
    const subdir = join(dir, 'a', 'b');
    execSync('mkdir -p a/b', { cwd: dir, stdio: 'ignore' });
    expect(findGitRoot(subdir)).toBe(dir);
  });
});

describe('createWorktree', () => {
  it('creates a detached worktree with the given name', () => {
    const dir = makeTempDir('kimi-create-wt-');
    initRepo(dir);

    const wt = createWorktree(dir, 'feature-x');

    expect(existsSync(wt)).toBe(true);
    expect(wt).toContain(join('.kimi', 'worktrees', 'feature-x'));
    const branch = execSync('git branch --show-current', { cwd: wt, encoding: 'utf8', stdio: 'pipe' });
    expect(branch.trim()).toBe('');
  });

  it('auto-generates a kimi-prefixed name when none is given', () => {
    const dir = makeTempDir('kimi-auto-wt-');
    initRepo(dir);

    const wt = createWorktree(dir);

    expect(existsSync(wt)).toBe(true);
    const baseName = wt.split('/').pop();
    expect(baseName).toMatch(/^kimi-\d{8}-\d{6}$/);
  });

  it('raises when the worktree directory already exists', () => {
    const dir = makeTempDir('kimi-dup-wt-');
    initRepo(dir);
    createWorktree(dir, 'dup');

    expect(() => createWorktree(dir, 'dup')).toThrow(WorktreeError);
    expect(() => createWorktree(dir, 'dup')).toThrow('already exists');
  });

  it('raises outside a git repository', () => {
    const dir = makeTempDir('kimi-no-git-');
    expect(() => createWorktree(dir, 'x')).toThrow(WorktreeError);
  });
});

describe('removeWorktree', () => {
  it('removes a created worktree', () => {
    const dir = makeTempDir('kimi-rm-wt-');
    initRepo(dir);
    const wt = createWorktree(dir, 'to-remove');
    expect(existsSync(wt)).toBe(true);

    removeWorktree(dir, wt);

    expect(existsSync(wt)).toBe(false);
  });

  it('does not throw for a missing worktree path', () => {
    const dir = makeTempDir('kimi-rm-missing-');
    initRepo(dir);
    const missing = join(dir, '.kimi', 'worktrees', 'ghost');

    expect(() => removeWorktree(dir, missing)).not.toThrow();
  });
});

describe('listWorktrees', () => {
  it('lists created worktrees', () => {
    const dir = makeTempDir('kimi-list-wt-');
    initRepo(dir);
    const wt1 = createWorktree(dir, 'wt1');
    const wt2 = createWorktree(dir, 'wt2');

    const list = listWorktrees(dir);
    const paths = list.map((w) => w.path);

    expect(paths).toContain(wt1);
    expect(paths).toContain(wt2);
  });
});
