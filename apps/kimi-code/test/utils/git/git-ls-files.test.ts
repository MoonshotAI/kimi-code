import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createGitLsFilesCache } from '#/utils/git/git-ls-files';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function commit(cwd: string, message: string): void {
  git(cwd, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message);
}

describe('createGitLsFilesCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-ls-files-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a non-git directory', () => {
    const cache = createGitLsFilesCache(dir);
    expect(cache.isGitRepo()).toBe(false);
    expect(cache.list()).toBeNull();
  });

  it('lists tracked files in a git repo', () => {
    git(dir, 'init');
    writeFileSync(join(dir, 'a.ts'), '');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/b.ts'), '');
    git(dir, 'add', '.');
    commit(dir, 'init');

    const cache = createGitLsFilesCache(dir);
    expect(cache.isGitRepo()).toBe(true);
    const snap = cache.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.files).toContain('a.ts');
    expect(snap!.files).toContain('src/b.ts');
    expect(snap!.dirs).toEqual(['src']);
    expect(snap!.mtimeByPath.has('a.ts')).toBe(true);
    expect(snap!.mtimeByPath.get('a.ts')!).toBeGreaterThan(0);
    expect(cache.getSnapshot()).toBe(snap);
  });

  it('includes untracked-but-not-ignored files', () => {
    git(dir, 'init');
    writeFileSync(join(dir, '.gitignore'), 'ignored.ts\n');
    writeFileSync(join(dir, 'tracked.ts'), '');
    git(dir, 'add', 'tracked.ts');
    commit(dir, 'init');

    // Create both an untracked file and one that matches .gitignore.
    writeFileSync(join(dir, 'new.ts'), '');
    writeFileSync(join(dir, 'ignored.ts'), '');

    const cache = createGitLsFilesCache(dir);
    const files = cache.list()!;
    expect(files).toContain('tracked.ts');
    expect(files).toContain('new.ts');
    expect(files).not.toContain('ignored.ts');
  });

  it('builds a recency order from recent commits', () => {
    git(dir, 'init');
    writeFileSync(join(dir, 'old.ts'), '');
    git(dir, 'add', 'old.ts');
    commit(dir, 'old');
    writeFileSync(join(dir, 'new.ts'), '');
    git(dir, 'add', 'new.ts');
    commit(dir, 'new');

    const cache = createGitLsFilesCache(dir);
    const snap = cache.getSnapshot()!;
    const newRank = snap.recencyOrder.get('new.ts');
    const oldRank = snap.recencyOrder.get('old.ts');
    expect(newRank).toBeDefined();
    expect(oldRank).toBeDefined();
    expect(newRank!).toBeLessThan(oldRank!);
  });

  it('invalidates when .git/index mtime changes', () => {
    git(dir, 'init');
    writeFileSync(join(dir, 'a.ts'), '');
    git(dir, 'add', '.');
    commit(dir, 'init');

    const cache = createGitLsFilesCache(dir);
    const first = cache.list()!;
    expect(first).toContain('a.ts');

    // Touch .git/index forward to simulate a new commit / add.
    const indexPath = join(dir, '.git', 'index');
    const s = statSync(indexPath);
    const future = new Date(s.mtimeMs + 5000);
    utimesSync(indexPath, future, future);

    writeFileSync(join(dir, 'b.ts'), '');
    git(dir, 'add', 'b.ts');

    const second = cache.list()!;
    expect(second).not.toBe(first); // new snapshot
    expect(second).toContain('b.ts');
  });
});
