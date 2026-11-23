import { z } from 'zod';

import { workspaceSchema } from './workspace';
import {
  gitBranchSchema,
  worktreeRiskSchema,
  worktreeSchema,
  worktreeSetupRequestSchema,
} from './worktree';

export const workspaceGitBranchesResponseSchema = z.object({
  is_repo: z.boolean(),
  head_branch: z.string().min(1).optional(),
  dirty: z.boolean(),
  remotes: z.array(z.string().min(1)),
  branches: z.array(gitBranchSchema),
});
export type WorkspaceGitBranchesResponse = z.infer<typeof workspaceGitBranchesResponseSchema>;

export const listWorktreesQuerySchema = z.object({
  refresh: z.literal('sizes').optional(),
});
export type ListWorktreesQuery = z.infer<typeof listWorktreesQuerySchema>;

export const listWorktreesResponseSchema = z.object({
  items: z.array(worktreeSchema),
  total_size_bytes: z.number().int().nonnegative().optional(),
});
export type ListWorktreesResponse = z.infer<typeof listWorktreesResponseSchema>;

export const inspectWorktreesRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(256),
});
export type InspectWorktreesRequest = z.infer<typeof inspectWorktreesRequestSchema>;

export const inspectWorktreesResponseSchema = z.object({
  items: z.array(worktreeRiskSchema),
  errors: z.record(z.string(), z.object({ code: z.number().int(), msg: z.string() })),
});
export type InspectWorktreesResponse = z.infer<typeof inspectWorktreesResponseSchema>;

export const removeWorktreeRequestSchema = z.object({
  path: z.string().min(1),
  delete_branch: z.boolean().optional(),
});
export type RemoveWorktreeRequest = z.infer<typeof removeWorktreeRequestSchema>;

export const removeWorktreeResponseSchema = z.object({
  removed: z.literal(true),
  branch_deleted: z.boolean(),
});
export type RemoveWorktreeResponse = z.infer<typeof removeWorktreeResponseSchema>;

export const worktreeRemoveFailedDetailsSchema = z.object({
  reason: z.enum(['in_use', 'session_busy', 'unknown']),
  output: z.string(),
});
export type WorktreeRemoveFailedDetails = z.infer<typeof worktreeRemoveFailedDetailsSchema>;

export const lookupWorktreeRequestSchema = z.object({
  path: z.string().min(1),
});
export type LookupWorktreeRequest = z.infer<typeof lookupWorktreeRequestSchema>;

export const lookupWorktreeResponseSchema = z.object({
  worktree: z
    .object({
      repo_root: z.string().min(1),
      branch: z.string().min(1).optional(),
      workspace: workspaceSchema.optional(),
      session_count: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type LookupWorktreeResponse = z.infer<typeof lookupWorktreeResponseSchema>;

export const sessionWorktreeActionSchema = z.enum([
  'retry',
  'cancel',
  'use_local',
  'recreate',
]);
export type SessionWorktreeAction = z.infer<typeof sessionWorktreeActionSchema>;

export const sessionWorktreeRetryRequestSchema = worktreeSetupRequestSchema
  .pick({ include_local_changes: true, use_remote: true })
  .partial();
export type SessionWorktreeRetryRequest = z.infer<typeof sessionWorktreeRetryRequestSchema>;

export const deleteSessionRequestSchema = z.object({
  remove_worktree: z.boolean().optional(),
  delete_branch: z.boolean().optional(),
});
export type DeleteSessionRequest = z.infer<typeof deleteSessionRequestSchema>;

export const deleteSessionWorktreeOutcomeSchema = z.object({
  outcome: z.enum(['removed', 'kept_in_use', 'missing', 'failed']),
  branch_deleted: z.boolean().optional(),
  other_sessions: z.number().int().nonnegative().optional(),
  output: z.string().optional(),
});
export type DeleteSessionWorktreeOutcome = z.infer<typeof deleteSessionWorktreeOutcomeSchema>;
