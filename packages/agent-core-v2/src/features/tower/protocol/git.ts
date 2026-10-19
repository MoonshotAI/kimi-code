import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

const GIT_TIMEOUT_MS = 60_000;

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode?: number,
  ) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || 'unknown error'}`);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  readonly env?: Readonly<Record<string, string>>;
}

export async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new GitError(
              args,
              stderr || error.message,
              typeof error.code === 'number' ? error.code : undefined,
            ),
          );
          return;
        }
        resolve(stdout.trimEnd());
      },
    );
  });
}

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
  return (await git(cwd, ['rev-list', '-n', '1', '--all'])).length > 0;
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
  try {
    await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return false;
    throw error;
  }
}

const ADD_PATHS_CHUNK = 100;

export async function initRepository(cwd: string): Promise<void> {
  await git(cwd, ['init']);
}

async function gitCommit(cwd: string, args: readonly string[]): Promise<void> {
  try {
    await git(cwd, args);
  } catch (error) {
    if (!(error instanceof GitError) || !/identity unknown/.test(error.stderr)) {
      throw error;
    }
    await git(cwd, [
      '-c',
      'user.name=Kimi Tower',
      '-c',
      'user.email=kimi-tower@localhost',
      ...args,
    ]);
  }
}

export async function checkoutNewLocalBranch(cwd: string, branch: string): Promise<void> {
  await git(cwd, ['checkout', '-b', branch]);
}

export async function commitAllowEmpty(cwd: string, message: string): Promise<void> {
  await gitCommit(cwd, ['commit', '--allow-empty', '-m', message]);
}

export async function commitPaths(
  cwd: string,
  paths: readonly string[],
  message: string,
): Promise<void> {
  for (let i = 0; i < paths.length; i += ADD_PATHS_CHUNK) {
    await git(cwd, ['add', '-A', '--', ...paths.slice(i, i + ADD_PATHS_CHUNK)]);
  }
  await gitCommit(cwd, ['commit', '-m', message]);
}

export async function isAncestor(cwd: string, ancestor: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, ref]);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return false;
    throw error;
  }
}

export async function worktreeAdd(cwd: string, path: string, branch: string): Promise<void> {
  await git(cwd, ['worktree', 'add', path, branch]);
}

export async function worktreeAddNewBranch(
  cwd: string,
  path: string,
  branch: string,
  base: string,
): Promise<void> {
  await git(cwd, ['worktree', 'add', path, '-b', branch, base]);
}

export async function worktreeRemove(cwd: string, path: string): Promise<void> {
  await git(cwd, ['worktree', 'remove', '--force', path]);
}

export async function isRegisteredWorktree(repoRoot: string, path: string): Promise<boolean> {
  const gitDir = await tryGit(path, ['rev-parse', '--git-dir']);
  if (gitDir === null) return false;
  const commonDir = await tryGit(repoRoot, ['rev-parse', '--git-common-dir']);
  if (commonDir === null) return false;
  const adminRoot = join(
    await realpath(resolve(await realpath(repoRoot), commonDir.trim())),
    'worktrees',
  );
  const resolved = resolve(await realpath(path), gitDir.trim());
  const inside = relative(adminRoot, resolved);
  return inside.length > 0 && !inside.startsWith('..') && !isAbsolute(inside);
}

export async function isWorktreeDirty(path: string): Promise<boolean> {
  return (await git(path, ['status', '--porcelain'])).trim().length > 0;
}

async function hasMergeHead(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return false;
    throw error;
  }
}

export async function mergeNoFf(cwd: string, revision: string, message?: string): Promise<string> {
  if (await hasMergeHead(cwd)) {
    throw new GitError(
      ['merge', '--no-ff', revision],
      'cannot start a tower merge while MERGE_HEAD already exists; finish or abort the existing merge first',
    );
  }
  const headBefore = await branchTip(cwd, 'HEAD');
  const statusBefore = await git(cwd, ['status', '--porcelain']);
  try {
    await git(cwd, [
      'merge',
      '--no-ff',
      ...(message === undefined ? [] : ['-m', message]),
      revision,
    ]);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    let mergeLeftBehind: boolean;
    try {
      mergeLeftBehind = await hasMergeHead(cwd);
    } catch (inspectionError) {
      throw new GitError(
        ['merge', '--abort'],
        `recovery-required: could not inspect MERGE_HEAD after the merge failed: ${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}`,
      );
    }
    if (mergeLeftBehind) {
      try {
        await git(cwd, ['merge', '--abort']);
      } catch (abortError) {
        throw new GitError(
          ['merge', '--abort'],
          `recovery-required: ${abortError instanceof Error ? abortError.message : String(abortError)}`,
        );
      }
      const problems: string[] = [];
      if (await hasMergeHead(cwd)) problems.push('MERGE_HEAD still exists');
      if ((await branchTip(cwd, 'HEAD')) !== headBefore) {
        problems.push('HEAD was not restored to the pre-merge commit');
      }
      if ((await git(cwd, ['status', '--porcelain'])) !== statusBefore) {
        problems.push('the index or worktree differs from its pre-merge state');
      }
      if (problems.length > 0) {
        throw new GitError(
          ['merge', '--abort'],
          `recovery-required: merge abort did not restore the checkout (${problems.join('; ')})`,
        );
      }
    }
    throw error;
  }
  return branchTip(cwd, 'HEAD');
}

export async function diffNameOnly(
  cwd: string,
  base: string,
  ref: string,
): Promise<readonly string[]> {
  const out = await git(cwd, ['diff', '--name-only', `${base}...${ref}`]);
  return out.length === 0 ? [] : out.split('\n').filter((line) => line.trim().length > 0);
}
