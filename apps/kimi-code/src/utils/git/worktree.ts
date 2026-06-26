/**
 * Git worktree management for isolated agent sessions.
 *
 * Mirrors the upstream kimi-cli worktree feature:
 *   - Worktrees are created under <repo-root>/.kimi/worktrees/<name>
 *   - Default name is a random three-word slug from the worktree name database
 *     (e.g. amber-drifting-cloud, moyu-qianshui-xiongmao)
 *   - Default checkout is detached HEAD at current HEAD
 */

import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ADJECTIVES_RAW from './worktree-adjectives.txt?raw';
import VERBS_RAW from './worktree-verbs.txt?raw';
import NOUNS_RAW from './worktree-nouns.txt?raw';

const GIT_TIMEOUT_MS = 30_000;
const WORKTREE_SUBDIR = '.kimi/worktrees';
const MAX_SLUG_LENGTH = 64;
const VALID_SLUG_SEGMENT = /^[A-Za-z0-9._-]+$/;
const PR_REF_PREFIX = /^#(\d+)$/;
const NAME_RETRY_ATTEMPTS = 10;

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

function parseWordList(raw: string): readonly string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

const ADJECTIVES = parseWordList(ADJECTIVES_RAW);
const VERBS = parseWordList(VERBS_RAW);
const NOUNS = parseWordList(NOUNS_RAW);

function pick<T>(list: readonly T[]): T {
  if (list.length === 0) {
    throw new WorktreeError('Worktree name word list is empty.');
  }
  return list[randomInt(list.length)]!;
}

function generateDefaultWorktreeName(): string {
  return `${pick(ADJECTIVES)}-${pick(VERBS)}-${pick(NOUNS)}`;
}

/**
 * Validates and normalizes a user-supplied worktree name.
 *
 * Rules:
 *   - Non-empty after trimming.
 *   - At most 64 characters.
 *   - No forward slashes.
 *   - May contain only letters, digits, '.', '_', and '-'.
 *   - The names '.' and '..' are rejected.
 *   - A leading '#' followed by digits is normalized to "pr-<digits>".
 */
export function normalizeWorktreeName(input: string): string {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    throw new WorktreeError('Worktree name cannot be empty.');
  }

  const prMatch = PR_REF_PREFIX.exec(trimmed);
  const name = prMatch !== null ? `pr-${prMatch[1]}` : trimmed;

  if (name.length > MAX_SLUG_LENGTH) {
    throw new WorktreeError(`Worktree name must be ${MAX_SLUG_LENGTH} characters or fewer.`);
  }

  if (name === '.' || name === '..') {
    throw new WorktreeError(`Worktree name cannot be "." or "..": ${name}`);
  }

  if (name.includes('/')) {
    throw new WorktreeError(`Worktree name cannot contain "/": ${name}`);
  }

  if (!VALID_SLUG_SEGMENT.test(name)) {
    throw new WorktreeError(
      `Worktree name contains invalid characters (allowed: letters, digits, '.', '_', '-'): ${name}`,
    );
  }

  return name;
}

function generateUniqueWorktreeName(worktreesDir: string): string {
  for (let attempt = 0; attempt < NAME_RETRY_ATTEMPTS; attempt++) {
    const name = generateDefaultWorktreeName();
    const worktreePath = resolve(worktreesDir, name);
    if (!existsSync(worktreePath)) {
      return name;
    }
  }
  throw new WorktreeError(
    `Failed to generate a unique worktree name after ${NAME_RETRY_ATTEMPTS} attempts.`,
  );
}

function realpathOrNull(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

function isRegisteredWorktree(repoRoot: string, worktreePath: string): boolean | null {
  const worktrees = listWorktrees(repoRoot);
  if (worktrees === null) {
    return null;
  }
  const target = realpathOrNull(worktreePath);
  if (target === null) {
    return false;
  }
  return worktrees.some((info) => {
    const registeredPath = realpathOrNull(info.path);
    return registeredPath !== null && registeredPath === target;
  });
}

function ensureWorktreeStorageIgnored(worktreesDir: string): void {
  const gitignorePath = resolve(worktreesDir, '.gitignore');
  if (existsSync(gitignorePath)) {
    return;
  }
  writeFileSync(gitignorePath, '*\n', { encoding: 'utf8' });
}

/**
 * Ensures the worktree storage dir does not dirty the repository checkout.
 *
 * We add `.kimi/worktrees/` to `.git/info/exclude` (local to this clone) rather
 * than modifying any tracked `.gitignore` file. This keeps the worktree storage
 * out of `git status` without polluting the repo with untracked ignore rules.
 *
 * The marker is scoped to `.kimi/worktrees/` rather than the whole `.kimi/`
 * directory so unrelated untracked content another tool may keep under `.kimi/`
 * still shows up in `git status` instead of being silently hidden.
 */
function ensureWorktreeStorageExcluded(repoRoot: string): void {
  // Resolve the exclude file via `--git-path` so that when `repoRoot` is itself
  // a linked worktree we target the common git dir's `info/exclude` (where Git
  // actually reads it from) rather than `.git/worktrees/<name>/info/exclude`,
  // which Git would never consult.
  const excludePathResult = runGit(repoRoot, ['rev-parse', '--git-path', 'info/exclude']);
  if (excludePathResult.status !== 0 || excludePathResult.stdout.length === 0) {
    return;
  }
  const excludePath = resolve(repoRoot, excludePathResult.stdout);
  const marker = `${WORKTREE_SUBDIR}/`;

  let existing = '';
  if (existsSync(excludePath)) {
    try {
      existing = readFileSync(excludePath, { encoding: 'utf8' });
      const lines = existing.split('\n');
      if (lines.some((line) => line.trim() === marker)) {
        return;
      }
    } catch {
      // Fall through to best-effort append.
    }
  }

  mkdirSync(resolve(excludePath, '..'), { recursive: true });
  writeFileSync(excludePath, `${existing}${existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''}${marker}\n`, {
    encoding: 'utf8',
  });
}

export function createWorktree(repoRoot: string, name?: string): string {
  if (!isInsideGitRepo(repoRoot)) {
    throw new WorktreeError(`Not a git repository: ${repoRoot}`);
  }

  const worktreesDir = resolve(repoRoot, WORKTREE_SUBDIR);
  const worktreeName =
    name !== undefined && name.trim().length > 0
      ? normalizeWorktreeName(name)
      : generateUniqueWorktreeName(worktreesDir);
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
  ensureWorktreeStorageIgnored(worktreesDir);
  ensureWorktreeStorageExcluded(repoRoot);

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

  const registered = isRegisteredWorktree(canonicalRepoRoot, worktreePath);

  // Only fall back to rm for worktrees that are proven not to be registered
  // with git. If registration status is unknown (list failed) or the worktree
  // is registered, run git worktree remove, which fails safe on dirty/locked
  // worktrees instead of bypassing the safety check with force-rm.
  if (registered === false) {
    rmSync(worktreePath, { recursive: true, force: true });
    runGit(canonicalRepoRoot, ['worktree', 'prune']);
    return;
  }

  const { stderr, status } = runGit(canonicalRepoRoot, ['worktree', 'remove', worktreePath]);
  if (status !== 0) {
    throw new WorktreeError(
      `Failed to remove worktree at ${worktreePath}${stderr ? `\n${stderr}` : ''}`,
      stderr,
    );
  }

  // Prune stale worktree metadata (best-effort).
  runGit(canonicalRepoRoot, ['worktree', 'prune']);
}

export function listWorktrees(repoRoot: string): WorktreeInfo[] | null {
  const { stdout, status } = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (status !== 0) {
    return null;
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
