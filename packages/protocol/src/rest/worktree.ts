/**
 *   GET    /v1/workspaces/{workspace_id}/worktrees            → ListWorktreesResponse { worktrees }
 *   POST   /v1/workspaces/{workspace_id}/worktrees            body: CreateWorktreeRequest      → Worktree
 *   POST   /v1/workspaces/{workspace_id}/worktrees/remove     body: RemoveWorktreeRequest      → { removed: true }
 *   POST   /v1/workspaces/{workspace_id}/worktrees/open-in    body: OpenWorktreeInAppRequest   → { opened: true }
 *
 * Errors:
 *   - 40001 validation.failed        (bad branch name, path escapes repo, etc.)
 *   - 40410 workspace.not_found      (unknown workspace_id)
 *   - 40416 worktree.not_found       (remove/open target missing)
 *   - 40908 fs.git_unavailable       (workspace root is not a git repository)
 *   - 40913 worktree.conflict        (branch already in use, worktree dirty on remove, etc.)
 */

import { z } from 'zod';

import { worktreeSchema } from '../worktree';

export const listWorktreesResponseSchema = z.object({
  worktrees: z.array(worktreeSchema),
});
export type ListWorktreesResponse = z.infer<typeof listWorktreesResponseSchema>;

export const createWorktreeRequestSchema = z.object({
  /** New branch name to create. Defaults to a slug derived from the path or a timestamp. */
  branch: z.string().min(1).max(200).optional(),
  /**
   * Base ref to branch from. Defaults to the remote default branch
   * (`origin/HEAD`); when no remote is available the caller should fall back
   * to the local `HEAD`.
   */
  base_ref: z.string().min(1).max(200).optional(),
  /**
   * Absolute path for the new worktree. Defaults to `<repo>/.worktrees/<slug>`.
   * Must not already exist and must not escape the repository's parent area.
   */
  path: z.string().min(1).optional(),
});
export type CreateWorktreeRequest = z.infer<typeof createWorktreeRequestSchema>;

export const createWorktreeResponseSchema = worktreeSchema;
export type CreateWorktreeResponse = z.infer<typeof createWorktreeResponseSchema>;

export const removeWorktreeRequestSchema = z.object({
  /** Absolute path of the worktree to remove. */
  path: z.string().min(1),
  /** Force removal even when the worktree has uncommitted changes. */
  force: z.boolean().optional(),
  /** Also delete the associated branch after removing the worktree. */
  delete_branch: z.boolean().optional(),
});
export type RemoveWorktreeRequest = z.infer<typeof removeWorktreeRequestSchema>;

export const removeWorktreeResponseSchema = z.object({
  removed: z.literal(true),
});
export type RemoveWorktreeResponse = z.infer<typeof removeWorktreeResponseSchema>;

/** External applications a worktree folder can be opened in. Mirrors `fsOpenInAppIdSchema`. */
export const openWorktreeInAppIdSchema = z.enum([
  'finder',
  'cursor',
  'vscode',
  'iterm',
  'terminal',
]);
export type OpenWorktreeInAppId = z.infer<typeof openWorktreeInAppIdSchema>;

export const openWorktreeInAppRequestSchema = z.object({
  /** External application to open the worktree folder in. */
  app_id: openWorktreeInAppIdSchema,
  /** Absolute path of the worktree to open. Must belong to the workspace. */
  path: z.string().min(1),
});
export type OpenWorktreeInAppRequest = z.infer<typeof openWorktreeInAppRequestSchema>;

export const openWorktreeInAppResponseSchema = z.object({
  opened: z.literal(true),
});
export type OpenWorktreeInAppResponse = z.infer<typeof openWorktreeInAppResponseSchema>;
