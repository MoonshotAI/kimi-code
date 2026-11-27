import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';
import {
  sessionAgentConfigPartialSchema,
  sessionMetadataSchema,
} from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

import { workspaceIdSchema } from './workspace';
import { sessionWorktreeSchema, worktreeSetupRequestSchema } from './worktree';

export const sessionPendingInteractionSchema = z.enum(['none', 'approval', 'question']);
export type SessionPendingInteraction = z.infer<typeof sessionPendingInteractionSchema>;

export const sessionActivitySchema = z.enum(['idle', 'turn', 'background']);
export type SessionActivity = z.infer<typeof sessionActivitySchema>;

export const sessionPullRequestSchema = z.object({
  number: z.number().int(),
  state: z.enum(['open', 'closed', 'merged']),
  url: z.string(),
});
export type SessionPullRequest = z.infer<typeof sessionPullRequestSchema>;

export const sessionGitSchema = z.object({
  branch: z.string().optional(),
  pull_request: sessionPullRequestSchema.optional(),
});
export type SessionGit = z.infer<typeof sessionGitSchema>;

export const sessionLastTurnOutcomeSchema = z.enum(['completed', 'interrupted', 'failed']);
export type SessionLastTurnOutcome = z.infer<typeof sessionLastTurnOutcomeSchema>;

export const sessionSchema = z.object({
  id: z.string().min(1),
  workspace_id: workspaceIdSchema,
  workspace_root: z.string().optional(),
  cwd: z.string().meta({ deprecated: true }),
  environment_id: z.string().optional(),
  environment_cwd: z.string().optional(),
  title: z.string(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  activity: sessionActivitySchema,
  pending_interaction: sessionPendingInteractionSchema.optional(),
  last_turn_outcome: sessionLastTurnOutcomeSchema.optional(),
  archived: z.boolean().optional(),
  archived_at: isoDateTimeSchema.optional(),
  last_prompt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  git: sessionGitSchema.optional(),
  worktree: sessionWorktreeSchema.optional(),
  host_id: z.string().optional(),
});

export type Session = z.infer<typeof sessionSchema>;

export const creationOnlyProfileSchema = z
  .never({ error: 'choose the agent profile with agent_config.profile when creating the session' })
  .optional();

export const sessionCreateSchema = z
  .object({
    title: z.string().min(1).optional(),
    cwd: z.string().min(1).optional().meta({ deprecated: true }),
    metadata: sessionMetadataSchema.partial().optional(),
    agent_config: sessionAgentConfigPartialSchema
      .extend({ profile: z.string().min(1).optional() })
      .optional(),
    workspace_id: workspaceIdSchema.optional(),
    workspace_root: z.string().min(1).optional(),
    environment_id: z.string().min(1).optional(),
    environment_cwd: z.string().min(1).optional(),
    worktree: worktreeSetupRequestSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.worktree !== undefined && value.environment_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'worktree cannot be combined with environment_id',
        path: ['worktree'],
      });
    }
    if (value.environment_cwd !== undefined && value.environment_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'environment_cwd requires environment_id',
        path: ['environment_cwd'],
      });
    }
    if (value.agent_config?.tower_mode === true) {
      ctx.addIssue({
        code: 'custom',
        message: 'tower_mode cannot be enabled while creating a session; enable it through the session profile afterwards',
        path: ['agent_config', 'tower_mode'],
      });
    }
  });

export type SessionCreate = z.infer<typeof sessionCreateSchema>;

export const sessionForkSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  turn_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export type SessionFork = z.infer<typeof sessionForkSchema>;
