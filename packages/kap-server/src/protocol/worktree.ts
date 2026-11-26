import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

import { messageContentSchema } from './message';

export const worktreeBaseSchema = z.object({
  ref: z.string().min(1),
  remote: z.boolean(),
  commit: z.string().min(1).optional(),
});
export type WorktreeBase = z.infer<typeof worktreeBaseSchema>;

export const worktreeSetupRequestSchema = z.object({
  source_branch: z.string().min(1),
  include_local_changes: z.boolean().optional(),
  use_remote: z.boolean().optional(),
});
export type WorktreeSetupRequest = z.infer<typeof worktreeSetupRequestSchema>;

export const worktreeSetupStepKindSchema = z.enum(['fetch', 'prune', 'create', 'changes', 'include']);
export type WorktreeSetupStepKind = z.infer<typeof worktreeSetupStepKindSchema>;

export const worktreeSetupStepStateSchema = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'stopped',
  'skipped',
]);
export type WorktreeSetupStepState = z.infer<typeof worktreeSetupStepStateSchema>;

export const worktreeSetupStepSchema = z.object({
  kind: worktreeSetupStepKindSchema,
  state: worktreeSetupStepStateSchema,
  ref: z.string().optional(),
  command: z.string().optional(),
  output: z.string().optional(),
  timed_out: z.boolean().optional(),
});
export type WorktreeSetupStep = z.infer<typeof worktreeSetupStepSchema>;

export const worktreeSetupFailureKindSchema = z.enum([
  'fetch_failed',
  'fetch_timeout',
  'conflict',
  'disk_full',
  'create_failed',
]);
export type WorktreeSetupFailureKind = z.infer<typeof worktreeSetupFailureKindSchema>;

export const worktreeSetupFailureSchema = z.object({
  kind: worktreeSetupFailureKindSchema,
  remote_ref: z.string().optional(),
  conflict_files: z.array(z.string()).optional(),
  timeout_seconds: z.number().int().positive().optional(),
});
export type WorktreeSetupFailure = z.infer<typeof worktreeSetupFailureSchema>;

export const worktreeSetupStatusSchema = z.enum([
  'running',
  'ready',
  'failed',
  'stopped',
  'local',
]);
export type WorktreeSetupStatus = z.infer<typeof worktreeSetupStatusSchema>;

export const worktreeSetupSchema = z.object({
  status: worktreeSetupStatusSchema,
  purpose: z.enum(['create', 'recreate']),
  request: worktreeSetupRequestSchema,
  steps: z.array(worktreeSetupStepSchema),
  commands_ran: z.number().int().nonnegative(),
  started_at: isoDateTimeSchema,
  ended_at: isoDateTimeSchema.optional(),
  stopped_step: worktreeSetupStepKindSchema.optional(),
  failure: worktreeSetupFailureSchema.optional(),
});
export type WorktreeSetup = z.infer<typeof worktreeSetupSchema>;

export const worktreeHeldPromptSchema = z.object({
  prompt_id: z.string().min(1),
  kind: z.enum(['prompt', 'skill']),
  created_at: isoDateTimeSchema,
  content: z.array(messageContentSchema),
  skill: z
    .object({ name: z.string().min(1), path: z.string().optional(), args: z.string().optional() })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  failure: z.object({ code: z.number().int(), msg: z.string() }).optional(),
});
export type WorktreeHeldPrompt = z.infer<typeof worktreeHeldPromptSchema>;

export const sessionWorktreeSchema = z.object({
  path: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  base: worktreeBaseSchema.optional(),
  included_local_changes: z.boolean().optional(),
  missing: z.boolean().optional(),
  branch_missing: z.boolean().optional(),
  setup: worktreeSetupSchema,
  held_prompt: worktreeHeldPromptSchema.optional(),
});
export type SessionWorktree = z.infer<typeof sessionWorktreeSchema>;

export const worktreeSessionRefSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  archived: z.boolean(),
  busy: z.boolean(),
});
export type WorktreeSessionRef = z.infer<typeof worktreeSessionRefSchema>;

export const worktreeSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  repo_root: z.string().min(1),
  workspace_id: z.string().min(1).optional(),
  workspace_name: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  origin: z.enum(['product', 'external']),
  size_bytes: z.number().int().nonnegative().optional(),
  sessions: z.array(worktreeSessionRefSchema),
});
export type Worktree = z.infer<typeof worktreeSchema>;

export const worktreeRiskSchema = z.object({
  path: z.string().min(1),
  branch: z.string().min(1).optional(),
  uncommitted_files: z.number().int().nonnegative(),
  unpushed_commits: z.number().int().nonnegative(),
  sessions: z.array(worktreeSessionRefSchema),
});
export type WorktreeRisk = z.infer<typeof worktreeRiskSchema>;

export const gitBranchSchema = z.object({
  name: z.string().min(1),
  committed_at: isoDateTimeSchema,
  remote_ref: z.string().min(1).optional(),
  remote: z.string().min(1).optional(),
  remote_source: z.enum(['upstream', 'same_name']).optional(),
});
export type GitBranch = z.infer<typeof gitBranchSchema>;
