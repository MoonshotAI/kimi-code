import { z } from 'zod';

import { isoDateTimeSchema } from '#/_base/utils/isoDateTime';
import type { SessionPendingInteraction, SessionTurnOutcome } from '#/session/sessionActivity/sessionActivity';

export const sessionWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
});
export type SessionWarning = z.infer<typeof sessionWarningSchema>;

export const sessionWarningsResponseSchema = z.object({
  warnings: z.array(sessionWarningSchema),
});
export type SessionWarningsResponse = z.infer<typeof sessionWarningsResponseSchema>;

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
  tower_mode: z.boolean().optional(),
  tower_base: z.string().min(1).optional(),
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

export const updateSessionProfileRequestSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: sessionMetadataSchema.partial().optional(),
  agent_config: sessionAgentConfigPartialSchema.optional(),
  permission_rules: z.array(permissionRuleSchema).optional(),
});
export type UpdateSessionProfileRequest = z.infer<typeof updateSessionProfileRequestSchema>;

export const sessionStatusResponseSchema = z.object({
  busy: z.boolean(),
  model: z.string().optional(),
  thinking_level: z.string(),
  permission: z.string(),
  plan_mode: z.boolean(),
  swarm_mode: z.boolean(),
  tower_mode: z.boolean().optional(),
  context_tokens: z.number().int().nonnegative(),
  max_context_tokens: z.number().int().nonnegative().optional(),
  context_usage: z.number().min(0).max(1).optional(),
});
export type SessionStatusResponse = z.infer<typeof sessionStatusResponseSchema>;

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd?: number;
  context_tokens: number;
  context_limit?: number;
  turn_count?: number;
}

export interface Session {
  id: string;
  workspace_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  busy: boolean;
  main_turn_active?: boolean;
  pending_interaction?: SessionPendingInteraction;
  last_turn_reason?: SessionTurnOutcome;
  archived?: boolean;
  archived_at?: string;
  current_prompt_id?: string;
  last_prompt?: string;
  metadata: SessionMetadata;
  agent_config: SessionAgentConfig;
  usage: SessionUsage;
  permission_rules: PermissionRule[];
  message_count: number;
  last_seq: number;
}

export interface SessionCreatedEvent {
  readonly type: 'event.session.created';
  readonly session: Session;
}

export interface SessionStatusChangedEvent {
  readonly type: 'event.session.status_changed';
  readonly status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
  readonly previous_status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
  readonly current_prompt_id?: string;
}

export interface SessionWorkChangedEvent {
  readonly type: 'event.session.work_changed';
  readonly busy: boolean;
  readonly main_turn_active?: boolean;
  readonly pending_interaction?: SessionPendingInteraction;
  readonly last_turn_reason?: SessionTurnOutcome;
}
