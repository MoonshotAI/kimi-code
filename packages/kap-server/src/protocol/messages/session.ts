import { z } from 'zod';

import { globalMessageBase, isoDateTimeSchema } from './base';
import { workspaceIdSchema } from './workspace';

const sessionInfoMetadataSchema = z
  .object({
    cwd: z.string().min(1),
  })
  .catchall(z.unknown());

const sessionInfoAgentConfigSchema = z.object({
  model: z.string(),
  system_prompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(z.string()).optional(),
  thinking: z.string().min(1).optional(),
  permission_mode: z.enum(['manual', 'yolo', 'auto']).optional(),
  plan_mode: z.boolean().optional(),
  swarm_mode: z.boolean().optional(),
  tower_mode: z.boolean().optional(),
  tower_base: z.string().min(1).optional(),
  goal_objective: z.string().optional(),
  goal_control: z.enum(['pause', 'resume', 'cancel']).optional(),
});

const sessionInfoUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative().optional(),
  context_tokens: z.number().int().nonnegative(),
  context_limit: z.number().int().nonnegative().optional(),
  turn_count: z.number().int().nonnegative().optional(),
});

const sessionInfoPermissionRuleSchema = z.object({
  id: z.string().min(1),
  tool_name: z.string().min(1),
  matcher: z
    .object({
      kind: z.enum(['command_prefix', 'path_glob', 'exact_input', 'always']),
      value: z.string().optional(),
    })
    .optional(),
  decision: z.literal('approved'),
  created_at: isoDateTimeSchema,
  created_by: z.enum(['user', 'agent']),
});

export const sessionInfoSchema = z.object({
  id: z.string().min(1),
  workspace_id: workspaceIdSchema,
  title: z.string(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  busy: z.boolean(),
  main_turn_active: z.boolean().optional(),
  pending_interaction: z.enum(['none', 'approval', 'question']).optional(),
  last_turn_reason: z.enum(['completed', 'cancelled', 'failed']).optional(),
  archived: z.boolean().optional(),
  archived_at: isoDateTimeSchema.optional(),
  current_prompt_id: z.string().min(1).optional(),
  last_prompt: z.string().optional(),
  metadata: sessionInfoMetadataSchema,
  agent_config: sessionInfoAgentConfigSchema,
  usage: sessionInfoUsageSchema,
  permission_rules: z.array(sessionInfoPermissionRuleSchema),
  message_count: z.number().int().nonnegative(),
  last_seq: z.number().int().nonnegative(),
});

export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const sessionMessageSchema = z.object({
  type: z.literal('session'),
  ...globalMessageBase,
  subtype: z.enum(['created', 'updated', 'archived', 'deleted']),
  session: sessionInfoSchema,
  changed_fields: z.array(z.string().min(1)).optional(),
});

export type SessionMessage = z.infer<typeof sessionMessageSchema>;
