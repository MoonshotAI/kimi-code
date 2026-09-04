import { z } from 'zod';

import { agentPhaseSchema } from './agent-phase';
import { sessionMessageBase } from './base';
import { stepUsageSchema } from './step-usage';

export const sessionStateUsageSchema = z.object({
  by_model: z.record(z.string(), stepUsageSchema).optional(),
  current_turn: stepUsageSchema.optional(),
  total: stepUsageSchema.optional(),
});

export type SessionStateUsage = z.infer<typeof sessionStateUsageSchema>;

export const sessionStateGoalSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'blocked', 'complete']),
  completion_criterion: z.string().optional(),
  budget_used: z.number().optional(),
  budget_limit: z.number().optional(),
});

export type SessionStateGoal = z.infer<typeof sessionStateGoalSchema>;

export const sessionStateModesSchema = z.object({
  plan: z
    .object({
      review_path: z.string().optional(),
      version: z.number().int().optional(),
    })
    .optional(),
  swarm: z
    .object({
      trigger: z.string().optional(),
    })
    .optional(),
});

export type SessionStateModes = z.infer<typeof sessionStateModesSchema>;

export const sessionStateMessageSchema = z.object({
  type: z.literal('session.state'),
  ...sessionMessageBase,
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
  context_tokens: z.number().int().nonnegative().optional(),
  max_context_tokens: z.number().int().nonnegative().optional(),
  context_usage: z.number().optional(),
  goal: sessionStateGoalSchema.optional(),
  modes: sessionStateModesSchema.optional(),
});

export type SessionStateMessage = z.infer<typeof sessionStateMessageSchema>;
