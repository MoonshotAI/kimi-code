import { z } from 'zod';

import { fsPullRequestSchema } from './rest/fs';

/**
 * A single git worktree belonging to a workspace's repository. Worktrees are
 * not persisted by us — `git worktree list --porcelain` is the source of truth.
 * The enrichment fields (dirty / ahead / behind / session_id / pull_request)
 * are best-effort: they degrade to false / null when the underlying git or
 * `gh` call fails, and never fail the request on their own.
 */
export const worktreeSchema = z.object({
  /** Absolute path of the worktree checkout. */
  path: z.string().min(1),
  /** Current branch name. Empty string when detached or no commits yet. */
  branch: z.string(),
  /** HEAD commit SHA. Empty string when the worktree has no commits. */
  head: z.string(),
  /** True for the primary (main) checkout of the repository. */
  is_main: z.boolean(),
  /** True when the worktree is locked (`git worktree lock`). */
  locked: z.boolean(),
  /** True when the worktree is prunable (e.g. its directory is missing). */
  prunable: z.boolean(),

  /** True when the worktree has uncommitted changes (including untracked). */
  dirty: z.boolean(),
  /** Commits ahead of the upstream tracking branch (0 when none). */
  ahead: z.number().int().nonnegative(),
  /** Commits behind the upstream tracking branch (0 when none). */
  behind: z.number().int().nonnegative(),
  /** Id of a session whose cwd falls inside this worktree, if any. */
  session_id: z.string().nullable(),
  /** GitHub pull request for the current branch, looked up via `gh pr view`. */
  pull_request: fsPullRequestSchema.nullable(),
});

export type Worktree = z.infer<typeof worktreeSchema>;
