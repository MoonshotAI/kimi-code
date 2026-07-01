/**
 * Runtime lifecycle for the `--worktree` flag.
 *
 * Keeps worktree creation, cleanup, and session-metadata derivation in one
 * feature module so the central CLI files (`main.ts`, `run-prompt.ts`,
 * `run-shell.ts`) only carry one-line integration hooks. This narrows the
 * surface that collides when those churn-heavy files change for unrelated
 * reasons.
 */

import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import type { JsonObject } from '@moonshot-ai/kimi-code-sdk';
import { log } from '@moonshot-ai/kimi-code-sdk';

import { createWorktree, findGitRoot, removeWorktree, WorktreeError } from '#/utils/git/worktree';

/**
 * The live worktree a session runs in. Unlike the parsed CLI options, this is
 * runtime state produced after git has registered the worktree and the process
 * has entered it, so it is threaded as an explicit execution context rather
 * than stored back on `CLIOptions`.
 */
export interface WorktreeRuntime {
  readonly worktreePath: string;
  readonly parentRepoPath: string;
  /** The directory the process changed into (the worktree-relative cwd). */
  readonly effectiveCwd: string;
}

/**
 * Creates the git worktree for `--worktree [name]` and enters it.
 *
 * Throws {@link WorktreeError} when the cwd is not inside a git repository or
 * when entering the created worktree fails (in which case the worktree is
 * removed again before throwing). On success the process cwd has been changed
 * to {@link WorktreeRuntime.effectiveCwd}.
 */
export function prepareWorktreeRuntime(worktreeName: string): WorktreeRuntime {
  const cwd = process.cwd();
  const repoRoot = findGitRoot(cwd);
  if (repoRoot === null) {
    throw new WorktreeError('--worktree requires the working directory to be inside a git repository.');
  }
  const worktreePath = createWorktree(repoRoot, worktreeName || undefined);
  const relativeCwd = relative(repoRoot, cwd);
  const targetCwd =
    relativeCwd.length > 0 && relativeCwd !== '.'
      ? resolve(worktreePath, relativeCwd)
      : worktreePath;

  // If the caller was inside an ignored or untracked subdirectory, the
  // mirrored path may not exist in the detached worktree. Fall back to the
  // worktree root rather than fail after git has already registered the
  // worktree.
  const effectiveCwd = existsSync(targetCwd) ? targetCwd : worktreePath;
  try {
    process.chdir(effectiveCwd);
  } catch {
    removeWorktree(repoRoot, worktreePath);
    throw new WorktreeError(
      `Failed to enter worktree directory: ${effectiveCwd}. The worktree has been removed.`,
    );
  }
  return { worktreePath, parentRepoPath: repoRoot, effectiveCwd };
}

/**
 * Removes a worktree that never held session content. Best-effort: a cleanup
 * failure is logged but never surfaced, so it cannot mask the original error
 * path that triggered the cleanup. A no-op when no worktree is active.
 */
export function cleanupEmptyWorktree(runtime: WorktreeRuntime | undefined): void {
  if (runtime === undefined) {
    return;
  }
  try {
    removeWorktree(runtime.parentRepoPath, runtime.worktreePath);
  } catch (cleanupError) {
    log.warn('Failed to clean up git worktree', cleanupError);
  }
}

/**
 * The flat session metadata persisted for a worktree session, or `undefined`
 * when no worktree is active. Mirrors the shape recovered from existing
 * sessions so a `/new` replacement stays in the same worktree context.
 */
export function metadataFromWorktree(runtime: WorktreeRuntime | undefined): JsonObject | undefined {
  if (runtime === undefined) {
    return undefined;
  }
  return {
    worktreePath: runtime.worktreePath,
    parentRepoPath: runtime.parentRepoPath,
  };
}
