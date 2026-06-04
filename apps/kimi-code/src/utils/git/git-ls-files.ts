/**
 * Git-aware file listing + relevance signals with a short-TTL cache.
 * Used as the cross-directory `@file` completion source when `fd` is
 * not installed.
 *
 * Tracks three things per snapshot, all refreshed atomically:
 *   - `files`            deduped (tracked + untracked-not-ignored), capped at 1000
 *   - `mtimeByPath`      relative path → fs mtime (ms), for recency ranking
 *   - `recencyOrder`     file path → position in recent git history (0-indexed; smaller = more recent)
 *
 * Rebuild strategy: 2s TTL plus `.git/index` mtime invalidation so
 * rapid edits surface without paying the full spawn+stat cost on every
 * keystroke. When outside a git worktree,
 * `getSnapshot()` returns `null` and callers fall back further.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TTL_MS = 2000;
const MAX_ENTRIES = 1000;
// Number of most-recent commits to scan for "recently edited" hotness.
// 200 is enough to cover a week of active work in a typical repo while
// staying fast (<100ms even on large repos).
const RECENT_COMMIT_DEPTH = 200;

export interface GitSnapshot {
  readonly files: readonly string[];
  /** Relative path → mtime (ms). Missing entries = stat failed. */
  readonly mtimeByPath: ReadonlyMap<string, number>;
  /** Path → 0-indexed recency rank (earlier = more recent). */
  readonly recencyOrder: ReadonlyMap<string, number>;
  /** Derived parent directories, sorted and deduped. */
  readonly dirs: readonly string[];
}

export interface GitLsFilesCache {
  /** Full snapshot, or `null` when the work dir is not a git repo. */
  getSnapshot(): GitSnapshot | null;
  /** Convenience shortcut; identical to `getSnapshot()?.files ?? null`. */
  list(): string[] | null;
  isGitRepo(): boolean;
}

interface SnapshotState {
  snapshot: GitSnapshot;
  fetchedAt: number;
  indexMtime: number;
}

export function createGitLsFilesCache(workDir: string): GitLsFilesCache {
  const gitRoot = resolveGitRoot(workDir);
  const indexPath = gitRoot === null ? null : join(gitRoot, '.git', 'index');
  let state: SnapshotState | undefined;

  return {
    isGitRepo: () => gitRoot !== null,
    getSnapshot: () => {
      if (gitRoot === null) return null;

      const now = Date.now();
      const currentIndexMtime = indexMtime(indexPath);
      const fresh =
        state !== undefined &&
        now - state.fetchedAt < TTL_MS &&
        state.indexMtime === currentIndexMtime;
      if (fresh) return state!.snapshot;

      const snapshot = fetchSnapshot(gitRoot);
      if (snapshot === null) return null; // transient git failure — retry next call

      state = { snapshot, fetchedAt: now, indexMtime: currentIndexMtime };
      return snapshot;
    },
    list: function listCompat() {
      return this.getSnapshot()?.files.slice() ?? null;
    },
  };
}

function resolveGitRoot(workDir: string): string | null {
  try {
    const result = spawnSync('git', ['-C', workDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    });
    if (result.status !== 0) return null;
    const stdout = result.stdout.trim();
    return stdout.length > 0 ? stdout : null;
  } catch {
    return null;
  }
}

function indexMtime(indexPath: string | null): number {
  if (indexPath === null || !existsSync(indexPath)) return 0;
  try {
    return statSync(indexPath).mtimeMs;
  } catch {
    return 0;
  }
}

function fetchSnapshot(gitRoot: string): GitSnapshot | null {
  const tracked = runLsFiles(gitRoot, ['-z']);
  if (tracked === null) return null;
  const untracked = runLsFiles(gitRoot, ['-z', '--others', '--exclude-standard']);
  if (untracked === null) return null;

  const seen = new Set<string>();
  for (const path of tracked) seen.add(path);
  for (const path of untracked) seen.add(path);
  const merged = [...seen].toSorted();
  const files = merged.length > MAX_ENTRIES ? merged.slice(0, MAX_ENTRIES) : merged;
  const dirs = collectDirs(files);

  const mtimeByPath = collectMtimes(gitRoot, files);
  const recencyOrder = collectRecencyOrder(gitRoot, new Set(files));

  return { files, dirs, mtimeByPath, recencyOrder };
}

function runLsFiles(gitRoot: string, args: readonly string[]): string[] | null {
  try {
    const result = spawnSync('git', ['-C', gitRoot, 'ls-files', ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) return null;
    return result.stdout.split('\0').filter((entry) => entry.length > 0);
  } catch {
    return null;
  }
}

function collectMtimes(gitRoot: string, files: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const path of files) {
    try {
      const stat = statSync(join(gitRoot, path));
      result.set(path, stat.mtimeMs);
    } catch {
      // File was deleted between ls-files and stat, or permission error.
      // Missing entry → ranker treats it as "no mtime signal".
    }
  }
  return result;
}

/**
 * Walk the last RECENT_COMMIT_DEPTH commits and record the first time
 * each path is seen (a file touched in HEAD wins over a file touched
 * 50 commits ago). Runs on the whole repo, not the work dir, so rename
 * tracking stays consistent even when the user cd's into a subdir.
 *
 * `trackedSet` filters out paths that were renamed away / deleted — we
 * only care about files that still appear in `ls-files`, since those
 * are the ones we could actually complete.
 */
function collectRecencyOrder(gitRoot: string, trackedSet: Set<string>): Map<string, number> {
  const result = new Map<string, number>();
  try {
    const proc = spawnSync(
      'git',
      [
        '-C',
        gitRoot,
        'log',
        `-n`,
        String(RECENT_COMMIT_DEPTH),
        '--name-only',
        '--pretty=format:',
        '--no-renames',
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (proc.status !== 0) return result;
    let rank = 0;
    for (const raw of proc.stdout.split('\n')) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (result.has(line)) continue; // keep the earliest (most recent) occurrence
      if (!trackedSet.has(line)) continue; // drop deleted / renamed-away paths
      result.set(line, rank);
      rank += 1;
    }
  } catch {
    // Fall through with whatever we've collected — an incomplete
    // recency map just means fewer entries get a hotness boost.
  }
  return result;
}

function collectDirs(files: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const file of files) {
    const segments = file.split('/');
    if (segments.length <= 1) continue;
    let current = '';
    for (const segment of segments.slice(0, -1)) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      if (seen.has(current)) continue;
      seen.add(current);
      dirs.push(current);
    }
  }
  return dirs;
}
