/**
 * Git worktree management for isolated agent sessions.
 *
 * Mirrors the upstream kimi-cli worktree feature:
 *   - Worktrees are created under <repo-root>/.kimi/worktrees/<name>
 *   - Default name is kimi-<timestamp>
 *   - Default checkout is detached HEAD at current HEAD
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const GIT_TIMEOUT_MS = 30_000;
const WORKTREE_SUBDIR = '.kimi/worktrees';

export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export interface WorktreeInfo {
  readonly path: string;
  readonly branch?: string;
}

function runGit(cwd: string, args: readonly string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
  });
  return {
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
    status: result.status,
  };
}

export function findGitRoot(cwd: string): string | null {
  const { stdout, status } = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (status !== 0 || stdout.length === 0) {
    return null;
  }
  return resolve(stdout);
}

function isInsideGitRepo(cwd: string): boolean {
  const { stdout, status } = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return status === 0 && stdout === 'true';
}

function generateDefaultWorktreeName(): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `kimi-${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export function createWorktree(repoRoot: string, name?: string): string {
  if (!isInsideGitRepo(repoRoot)) {
    throw new WorktreeError(`Not a git repository: ${repoRoot}`);
  }

  const worktreeName = name && name.trim().length > 0 ? name.trim() : generateDefaultWorktreeName();
  const worktreesDir = resolve(repoRoot, WORKTREE_SUBDIR);
  const worktreePath = resolve(worktreesDir, worktreeName);

  if (resolve(worktreePath) === resolve(repoRoot)) {
    throw new WorktreeError(`Worktree path cannot be the repository root: ${worktreePath}`);
  }

  // git worktree add will fail if the path already exists, but check early
  // to give a clearer error and avoid partial git state.
  if (existsSync(worktreePath)) {
    throw new WorktreeError(
      `Worktree directory already exists: ${worktreePath}\n` +
        'Use --worktree to choose a different name, or remove the existing directory.',
    );
  }

  // Ensure parent directory exists; git does not create nested parent dirs.
  mkdirSync(worktreesDir, { recursive: true });

  const { stderr, status } = runGit(repoRoot, ['worktree', 'add', '--detach', worktreePath]);
  if (status !== 0) {
    // Clean up partial directory if git created it
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    throw new WorktreeError(
      `Failed to create git worktree at ${worktreePath}${stderr ? `\n${stderr}` : ''}`,
      stderr,
    );
  }

  return worktreePath;
}

export function removeWorktree(repoRoot: string, worktreePath: string): void {
  const canonicalRepoRoot = findGitRoot(repoRoot);
  if (canonicalRepoRoot === null) {
    // Repository is gone; best-effort remove the directory itself.
    rmSync(worktreePath, { recursive: true, force: true });
    return;
  }

  const { stderr, status } = runGit(canonicalRepoRoot, ['worktree', 'remove', worktreePath]);
  if (status !== 0) {
    // Git may complain if the worktree is not registered; fall back to rm.
    rmSync(worktreePath, { recursive: true, force: true });
    // Only surface an error if the directory is still there after fallback.
    if (existsSync(worktreePath)) {
      throw new WorktreeError(
        `Failed to remove worktree at ${worktreePath}${stderr ? `\n${stderr}` : ''}`,
        stderr,
      );
    }
  }

  // Prune stale worktree metadata (best-effort).
  runGit(canonicalRepoRoot, ['worktree', 'prune']);
}

export function listWorktrees(repoRoot: string): WorktreeInfo[] {
  const { stdout, status } = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (status !== 0) {
    return [];
  }

  const worktrees: WorktreeInfo[] = [];
  let current: { path?: string; branch?: string } = {};
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path !== undefined) {
        worktrees.push({ path: current.path, branch: current.branch });
      }
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line === 'detached') {
      current.branch = '(detached HEAD)';
    }
  }
  if (current.path !== undefined) {
    worktrees.push({ path: current.path, branch: current.branch });
  }
  return worktrees;
}
