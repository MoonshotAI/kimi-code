/**
 * `tower` domain (protocol) — git plumbing for tower. Engine-internal
 * operations (worktree add/remove, merge, diff) run through `execFile` with a
 * hard timeout — these are not agent-invoked shell commands, so they do not
 * go through the Bash tool.
 */

import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 60_000;

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || 'unknown error'}`);
    this.name = 'GitError';
  }
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new GitError(args, stderr || error.message));
          return;
        }
        resolve(stdout.trimEnd());
      },
    );
  });
}

/** `git` that returns null instead of throwing when the command fails. */
export async function tryGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

export async function isInsideRepo(cwd: string): Promise<boolean> {
  return (await tryGit(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
}

export async function hasAnyCommit(cwd: string): Promise<boolean> {
  return (await tryGit(cwd, ['rev-list', '-n', '1', '--all'])) !== null;
}

export async function currentBranch(cwd: string): Promise<string> {
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') throw new Error('cannot determine base branch from a detached HEAD');
  return branch;
}

export async function branchTip(cwd: string, ref: string): Promise<string> {
  return git(cwd, ['rev-parse', ref]);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (
    (await tryGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !== null
  );
}

export async function worktreeAdd(
  cwd: string,
  path: string,
  branch: string,
  base: string,
): Promise<void> {
  if (await branchExists(cwd, branch)) {
    await git(cwd, ['worktree', 'add', path, branch]);
    return;
  }
  await git(cwd, ['worktree', 'add', path, '-b', branch, base]);
}

/**
 * Removal is always `--force`: the caller's dirty check is the data-loss gate.
 * A plain `git worktree remove` additionally refuses clean worktrees that
 * contain initialized submodules, which must not strand a clean teardown.
 */
export async function worktreeRemove(cwd: string, path: string): Promise<void> {
  await git(cwd, ['worktree', 'remove', '--force', path]);
}

export async function isWorktreeDirty(path: string): Promise<boolean> {
  const status = await tryGit(path, ['status', '--porcelain']);
  return status !== null && status.trim().length > 0;
}

export async function mergeNoFf(cwd: string, branch: string): Promise<string> {
  await git(cwd, ['merge', '--no-ff', branch]);
  return branchTip(cwd, 'HEAD');
}

/** Changed files of `ref` relative to `base` (three-dot, i.e. since merge-base). */
export async function diffNameOnly(
  cwd: string,
  base: string,
  ref: string,
): Promise<readonly string[]> {
  const out = await git(cwd, ['diff', '--name-only', `${base}...${ref}`]);
  return out.length === 0 ? [] : out.split('\n').filter((line) => line.trim().length > 0);
}
