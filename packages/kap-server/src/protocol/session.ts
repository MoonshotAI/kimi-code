import { z } from 'zod';

import { isoDateTimeSchema } from './message';
import { workspaceIdSchema } from './workspace';

/**
 * Locally-owned wire schemas (stage 4: protocol localisation) — copied from
 * the v2 sessionLegacy/sessionProtocol + _base/utils/isoDateTime so kap-server
 * no longer imports those modules.
 */
export { isoDateTimeSchema };

export const promptThinkingSchema = z.string().min(1);
export type PromptThinking = z.infer<typeof promptThinkingSchema>;

export const promptPermissionModeSchema = z.enum(['manual', 'yolo', 'auto']);
export type PromptPermissionMode = z.infer<typeof promptPermissionModeSchema>;

export const sessionMetadataSchema = z
  .object({
    cwd: z.string().min(1),
  })
  .catchall(z.unknown());
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export const sessionAgentConfigSchema = z.object({
  model: z.string(),
  system_prompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(z.string()).optional(),
  thinking: promptThinkingSchema.optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_mode: z.boolean().optional(),
  swarm_mode: z.boolean().optional(),
  goal_objective: z.string().optional(),
  goal_control: z.enum(['pause', 'resume', 'cancel']).optional(),
});
export type SessionAgentConfig = z.infer<typeof sessionAgentConfigSchema>;

export const sessionAgentConfigPartialSchema = sessionAgentConfigSchema.partial();
export type SessionAgentConfigPartial = z.infer<typeof sessionAgentConfigPartialSchema>;

export const permissionRuleMatcherSchema = z.object({
  kind: z.enum(['command_prefix', 'path_glob', 'exact_input', 'always']),
  value: z.string().optional(),
});
export type PermissionRuleMatcher = z.infer<typeof permissionRuleMatcherSchema>;

export const permissionRuleSchema = z.object({
  id: z.string().min(1),
  tool_name: z.string().min(1),
  matcher: permissionRuleMatcherSchema.optional(),
  decision: z.literal('approved'),
  created_at: isoDateTimeSchema,
  created_by: z.enum(['user', 'agent']),
});
export type PermissionRule = z.infer<typeof permissionRuleSchema>;

export const sessionUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative(),
  context_tokens: z.number().int().nonnegative(),
  context_limit: z.number().int().nonnegative(),
  turn_count: z.number().int().nonnegative(),
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
  /** Any agent in the session holds an active turn or background lease. */
  busy: z.boolean(),
  /** Whether the main agent currently owns an active turn. */
  main_turn_active: z.boolean().optional(),
  /** Highest-priority pending human interaction. */
  pending_interaction: sessionPendingInteractionSchema.optional(),
  /** Outcome of the main agent's most recent turn. */
  last_turn_reason: z.enum(['completed', 'cancelled', 'failed']).optional(),
  archived: z.boolean().optional(),
  current_prompt_id: z.string().min(1).optional(),
  /** Text of the most recent user prompt, for search/preview. Absent for empty sessions. */
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
