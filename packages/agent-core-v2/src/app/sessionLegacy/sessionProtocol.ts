/**
 * `sessionLegacy` domain — the v1 session wire DTO schemas.
 *
 * These zod schemas define the request/response shapes of the v1 session
 * endpoints this adapter backs (`POST /sessions/{id}/profile`,
 * `GET /sessions/{id}/status`, session warnings); the transports validate
 * against them and the adapter's contract consumes the inferred types.
 * Field-level changes here are wire breaks — see the schema-fidelity rule in
 * `server-align.md`.
 */

import { z } from 'zod';

import { isoDateTimeSchema } from '#/_base/utils/isoDateTime';

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
  context_tokens: z.number().int().nonnegative(),
  max_context_tokens: z.number().int().nonnegative(),
  context_usage: z.number().min(0).max(1),
});
export type SessionStatusResponse = z.infer<typeof sessionStatusResponseSchema>;
