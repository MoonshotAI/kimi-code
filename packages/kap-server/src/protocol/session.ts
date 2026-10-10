import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';
import {
  permissionRuleSchema,
  sessionAgentConfigPartialSchema,
  sessionAgentConfigSchema,
  sessionMetadataSchema,
} from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

import { workspaceIdSchema } from './workspace';

export const sessionUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative().optional(),
  context_tokens: z.number().int().nonnegative(),
  context_limit: z.number().int().nonnegative().optional(),
  turn_count: z.number().int().nonnegative().optional(),
});

export type SessionUsage = z.infer<typeof sessionUsageSchema>;

export function emptySessionUsage(): SessionUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  };
}

export const sessionPendingInteractionSchema = z.enum(['none', 'approval', 'question']);
export type SessionPendingInteraction = z.infer<typeof sessionPendingInteractionSchema>;

export const sessionSchema = z.object({
  id: z.string().min(1),
  workspace_id: workspaceIdSchema,
  title: z.string(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  busy: z.boolean(),
  main_turn_active: z.boolean().optional(),
  pending_interaction: sessionPendingInteractionSchema.optional(),
  last_turn_reason: z.enum(['completed', 'cancelled', 'failed']).optional(),
  archived: z.boolean().optional(),
  archived_at: isoDateTimeSchema.optional(),
  current_prompt_id: z.string().min(1).optional(),
  last_prompt: z.string().optional(),
  metadata: sessionMetadataSchema,
  agent_config: sessionAgentConfigSchema,
  usage: sessionUsageSchema,
  permission_rules: z.array(permissionRuleSchema),
  message_count: z.number().int().nonnegative(),
  last_seq: z.number().int().nonnegative(),
});

export type Session = z.infer<typeof sessionSchema>;

export const sessionCreateSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: sessionMetadataSchema.optional(),
  agent_config: sessionAgentConfigPartialSchema.optional(),
  workspace_id: workspaceIdSchema.optional(),
});

export type SessionCreate = z.infer<typeof sessionCreateSchema>;

export const sessionForkSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type SessionFork = z.infer<typeof sessionForkSchema>;

export const sessionChildCreateSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type SessionChildCreate = z.infer<typeof sessionChildCreateSchema>;
