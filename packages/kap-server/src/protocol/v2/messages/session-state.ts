import { z } from 'zod';
import { globalBaseFields, sessionBaseFields, stepUsageSchema } from './base';

export const agentPhaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({
    kind: z.literal('running'),
    turn_id: z.number(),
    step: z.number(),
    step_id: z.string().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('awaiting_approval'),
    turn_id: z.number(),
    step: z.number(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('awaiting_question'),
    turn_id: z.number(),
    step: z.number(),
    since: z.number(),
  }),
]);
export type AgentPhase = z.infer<typeof agentPhaseSchema>;

export const sessionGoalSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'blocked', 'complete']),
  completion_criterion: z.string().optional(),
  budget_used: z.number().optional(),
  budget_limit: z.number().optional(),
});
export type SessionGoal = z.infer<typeof sessionGoalSchema>;

export const sessionModesSchema = z.object({
  plan: z
    .object({
      review_path: z.string().optional(),
      version: z.number().optional(),
    })
    .optional(),
  swarm: z.object({ trigger: z.string().optional() }).optional(),
});
export type SessionModes = z.infer<typeof sessionModesSchema>;

export const sessionStateUsageSchema = z.object({
  by_model: z.record(z.string(), stepUsageSchema).optional(),
  current_turn: stepUsageSchema.optional(),
  total: stepUsageSchema.optional(),
});
export type SessionStateUsage = z.infer<typeof sessionStateUsageSchema>;

export const sessionStateMessageSchema = z.object({
  type: z.literal('session.state'),
  ...sessionBaseFields,
  busy: z.boolean(),
  main_turn_active: z.boolean(),
  pending_interaction: z.enum(['none', 'approval', 'question']).optional(),
  last_turn_reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']).optional(),
  activity: z.enum(['idle', 'turn', 'disposing', 'unknown']),
  phase: agentPhaseSchema.optional(),
  model: z.string().optional(),
  thinking_effort: z.string().optional(),
  permission: z.enum(['manual', 'yolo', 'auto']).optional(),
  usage: sessionStateUsageSchema.optional(),
  context_tokens: z.number().optional(),
  max_context_tokens: z.number().optional(),
  context_usage: z.number().optional(),
  goal: sessionGoalSchema.optional(),
  modes: sessionModesSchema.optional(),
});
export type SessionStateMessage = z.infer<typeof sessionStateMessageSchema>;

export const sessionInfoSchema = z.object({
  session_id: z.string(),
  workspace_id: z.string().optional(),
  title: z.string(),
  status: z.string(),
  model: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  turn_count: z.number().optional(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const sessionMessageSchema = z.object({
  type: z.literal('session'),
  ...globalBaseFields,
  subtype: z.enum(['created', 'updated', 'archived', 'deleted']),
  session: sessionInfoSchema,
  changed_fields: z.array(z.string()).optional(),
});
export type SessionMessage = z.infer<typeof sessionMessageSchema>;
