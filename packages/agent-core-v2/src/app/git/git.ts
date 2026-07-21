/**
 * `git` domain (L1) — git integration for a repository on the local disk.
 *
 * Defines the `IGitService` that runs `git status` / `git diff` (plus `gh pr
 * view`) against a repository identified by an absolute `cwd`. App-scoped; it
 * spawns `git` / `gh` through the `os/interface` process service rather than a
 * Session's execution environment, so it never depends on a Session. Path
 * confinement is the caller's responsibility — the service receives
 * already-resolved absolute `cwd` and repo-relative paths.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const fsGitStatusSchema = z.enum([
  'clean',
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
  'ignored',
  'conflicted',
]);
export type FsGitStatus = z.infer<typeof fsGitStatusSchema>;

export const fsPullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'merged', 'closed', 'draft']),
  url: z.string().url(),
});
export type FsPullRequest = z.infer<typeof fsPullRequestSchema>;

export const fsGitStatusRequestSchema = z.object({
  paths: z.array(z.string().min(1)).optional(),
});
export type FsGitStatusRequest = z.infer<typeof fsGitStatusRequestSchema>;

export const fsGitStatusResponseSchema = z.object({
  branch: z.string(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  entries: z.record(z.string(), fsGitStatusSchema),
  // Aggregate working-tree diff against HEAD (`git diff --numstat HEAD`):
  // summed added/deleted lines across all changed files. Binary files (numstat
  // `-`) contribute 0. Both 0 for a clean tree or a repo with no commits yet.
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  // GitHub pull request for the current branch, looked up via `gh pr view`.
  // Null when not a GitHub repo, `gh` is unavailable/unauthenticated, the
  // branch has no PR, or the lookup failed/timed out. Never fails the request.
  pullRequest: fsPullRequestSchema.nullable(),
});
export type FsGitStatusResponse = z.infer<typeof fsGitStatusResponseSchema>;

export const fsDiffRequestSchema = z.object({
  path: z.string().min(1),
});
export type FsDiffRequest = z.infer<typeof fsDiffRequestSchema>;

export const fsDiffResponseSchema = z.object({
  path: z.string(),
  diff: z.string(),
  truncated: z.boolean(),
});
export type FsDiffResponse = z.infer<typeof fsDiffResponseSchema>;

export interface IGitService {
  readonly _serviceBrand: undefined;

  status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse>;
  diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse>;
}

export const IGitService: ServiceIdentifier<IGitService> =
  createDecorator<IGitService>('gitService');
