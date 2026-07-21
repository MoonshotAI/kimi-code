import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createWorktree,
  findGitRoot,
  listWorktrees,
  normalizeWorktreeName,
  removeWorktree,
  WorktreeError,
} from '#/utils/git/worktree';

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

  it('auto-generates a three-word slug when none is given', () => {
    const dir = makeTempDir('kimi-auto-wt-');
    initRepo(dir);

    const wt = createWorktree(dir);

    expect(existsSync(wt)).toBe(true);
    const baseName = wt.split('/').pop();
    expect(baseName).toMatch(/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
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

  it('rejects names with invalid characters', () => {
    const dir = makeTempDir('kimi-invalid-wt-');
    initRepo(dir);

    expect(() => createWorktree(dir, 'hello world')).toThrow(WorktreeError);
    expect(() => createWorktree(dir, 'foo:bar')).toThrow(WorktreeError);
    expect(() => createWorktree(dir, 'foo@bar')).toThrow(WorktreeError);
  });

  it('rejects names with path separators', () => {
    const dir = makeTempDir('kimi-sep-wt-');
    initRepo(dir);

    expect(() => createWorktree(dir, 'foo/bar')).toThrow(WorktreeError);
    expect(() => createWorktree(dir, '/foo')).toThrow(WorktreeError);
  });

  it('rejects names with dot segments', () => {
    const dir = makeTempDir('kimi-dot-wt-');
    initRepo(dir);

    expect(() => createWorktree(dir, '.')).toThrow(WorktreeError);
    expect(() => createWorktree(dir, '..')).toThrow(WorktreeError);
    expect(() => createWorktree(dir, 'foo/./bar')).toThrow(WorktreeError);
  });

  it('rejects names longer than 64 characters', () => {
    const dir = makeTempDir('kimi-long-wt-');
    initRepo(dir);

    const longName = 'a'.repeat(65);
    expect(() => createWorktree(dir, longName)).toThrow(WorktreeError);
    expect(() => createWorktree(dir, longName)).toThrow('64 characters');
  });

  it('can create multiple auto-generated worktrees in the same repo', () => {
    const dir = makeTempDir('kimi-multi-wt-');
    initRepo(dir);

    const wt1 = createWorktree(dir);
    const wt2 = createWorktree(dir);

    expect(existsSync(wt1)).toBe(true);
    expect(existsSync(wt2)).toBe(true);
    expect(wt1).not.toBe(wt2);
  });

  it('keeps the worktree storage out of the parent git index', () => {
    const dir = makeTempDir('kimi-clean-wt-');
    initRepo(dir);

    createWorktree(dir, 'feature-x');

    expect(existsSync(join(dir, '.kimi', 'worktrees', '.gitignore'))).toBe(true);
    const status = execSync('git status --short', { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    expect(status.trim()).toBe('');
  });

  it('adds .kimi/worktrees/ to .git/info/exclude so the parent checkout stays clean', () => {
    const dir = makeTempDir('kimi-exclude-wt-');
    initRepo(dir);

    createWorktree(dir, 'feature-x');

    const excludePath = join(dir, '.git', 'info', 'exclude');
    expect(existsSync(excludePath)).toBe(true);
    const exclude = execSync('git check-ignore -v .kimi/worktrees/', {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(exclude).toContain('.git/info/exclude');
    expect(exclude).toContain('.kimi/worktrees/');
  });

  it('leaves unrelated .kimi/ content visible to git status', () => {
    const dir = makeTempDir('kimi-exclude-unrelated-');
    initRepo(dir);

    createWorktree(dir, 'feature-x');

    // Another tool's untracked file under .kimi/ must NOT be hidden: the
    // exclude marker is scoped to the worktree storage dir, not all of .kimi/.
    // (-uall reports files individually rather than collapsing the dir.)
    writeFileSync(join(dir, '.kimi', 'other-tool-data'), 'keep me visible\n');
    const status = execSync('git status --porcelain -uall', {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(status).toContain('.kimi/other-tool-data');
    expect(status).not.toContain('.kimi/worktrees/');
  });

  it('excludes .kimi/worktrees/ via the common git dir when repoRoot is a linked worktree', () => {
    const dir = makeTempDir('kimi-exclude-mainwt-');
    initRepo(dir);
    // From a linked worktree, `git rev-parse --git-dir` points at
    // `.git/worktrees/<name>`, but Git reads info/exclude from the common dir.
    const linked = join(makeTempDir('kimi-linkedwt-'), 'linked');
    execSync(`git worktree add ${linked}`, { cwd: dir, stdio: 'ignore' });

    createWorktree(linked, 'feature-x');

    // check-ignore from inside the linked worktree only matches if
    // .kimi/worktrees/ was written to the common info/exclude (not the
    // per-worktree git dir).
    const exclude = execSync('git check-ignore -v .kimi/worktrees/', {
      cwd: linked,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(exclude).toContain('info/exclude');
    expect(exclude).toContain('.kimi/worktrees/');
  });
});

describe('normalizeWorktreeName', () => {
  it('trims whitespace', () => {
    expect(normalizeWorktreeName('  feature-x  ')).toBe('feature-x');
  });

  it('normalizes #123 to pr-123', () => {
    expect(normalizeWorktreeName('#123')).toBe('pr-123');
    expect(normalizeWorktreeName('  #42  ')).toBe('pr-42');
  });

  it('accepts letters, digits, dots, underscores, and hyphens', () => {
    expect(normalizeWorktreeName('feature_2.1-x')).toBe('feature_2.1-x');
  });

  it('rejects empty names', () => {
    expect(() => normalizeWorktreeName('')).toThrow(WorktreeError);
    expect(() => normalizeWorktreeName('   ')).toThrow(WorktreeError);
  });

  it('rejects names with slashes', () => {
    expect(() => normalizeWorktreeName('foo/bar')).toThrow(WorktreeError);
  });

  it('rejects dot segments', () => {
    expect(() => normalizeWorktreeName('.')).toThrow(WorktreeError);
    expect(() => normalizeWorktreeName('..')).toThrow(WorktreeError);
  });

  it('rejects invalid characters', () => {
    expect(() => normalizeWorktreeName('foo bar')).toThrow(WorktreeError);
    expect(() => normalizeWorktreeName('foo:bar')).toThrow(WorktreeError);
    expect(() => normalizeWorktreeName('foo@bar')).toThrow(WorktreeError);
  });

  it('rejects names longer than 64 characters', () => {
    expect(() => normalizeWorktreeName('a'.repeat(65))).toThrow(WorktreeError);
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

    expect(() => {
      removeWorktree(dir, missing);
    }).not.toThrow();
  });

  it('does not delete a dirty registered worktree', () => {
    const dir = makeTempDir('kimi-rm-dirty-');
    initRepo(dir);
    const wt = createWorktree(dir, 'dirty');
    const dirtyFile = join(wt, 'dirty-file.txt');
    execSync('touch dirty-file.txt', { cwd: wt, stdio: 'ignore' });

    expect(() => {
      removeWorktree(dir, wt);
    }).toThrow(WorktreeError);
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(dirtyFile)).toBe(true);
  });
});

describe('listWorktrees', () => {
  it('lists created worktrees', () => {
    const dir = makeTempDir('kimi-list-wt-');
    initRepo(dir);
    const wt1 = createWorktree(dir, 'wt1');
    const wt2 = createWorktree(dir, 'wt2');

    const list = listWorktrees(dir);
    expect(list).not.toBeNull();
    const paths = list!.map((w) => w.path);

    expect(paths).toContain(wt1);
    expect(paths).toContain(wt2);
  });
});
