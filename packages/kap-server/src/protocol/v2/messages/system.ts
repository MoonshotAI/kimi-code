import { z } from 'zod';
import { timelineBaseFields } from './base';

const openPayload = z.record(z.string(), z.unknown()).optional();

const systemBase = {
  type: z.literal('system'),
  ...timelineBaseFields,
  system_id: z.string(),
  at: z.string().optional(),
} as const;

export const compactionSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('compaction'),
  payload: z.object({
    before_tokens: z.number(),
    after_tokens: z.number(),
    summarized_through_turn: z.string().optional(),
  }),
});

export const undoSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('undo'),
  payload: z.object({ undo_turn_id: z.string() }),
});

export const clearSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('clear'),
  payload: openPayload,
});

export const goalSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('goal'),
  payload: z.object({
    status: z.string(),
    objective: z.string().optional(),
  }),
});

export const planEnterSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('plan.enter'),
  payload: z.object({ mode: z.string() }).optional(),
});

export const planExitSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('plan.exit'),
  payload: z.object({
    approved: z.boolean(),
    version: z.number().optional(),
    key: z.string().optional(),
  }),
});

export const planRevisionSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('plan.revision'),
  payload: z.object({
    version: z.number(),
    key: z.string().optional(),
    summary: z.string().optional(),
  }),
});

export const swarmEnterSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('swarm.enter'),
  payload: openPayload,
});

export const swarmExitSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('swarm.exit'),
  payload: openPayload,
});

export const skillSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('skill'),
  payload: z.object({
    skill_name: z.string().optional(),
    status: z.string().optional(),
  }).optional(),
});

export const noticeSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('notice'),
  payload: z.object({
    severity: z.enum(['info', 'warning', 'error']).optional(),
    message: z.string().optional(),
  }).optional(),
});

export const hookSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('hook'),
  payload: openPayload,
});

export const interruptionSystemMessageSchema = z.object({
  ...systemBase,
  subtype: z.literal('interruption'),
  payload: z.object({
    reason: z.string(),
    turn_id: z.string().optional(),
  }),
});

export const systemMessageSchema = z.discriminatedUnion('subtype', [
  compactionSystemMessageSchema,
  undoSystemMessageSchema,
  clearSystemMessageSchema,
  goalSystemMessageSchema,
  planEnterSystemMessageSchema,
  planExitSystemMessageSchema,
  planRevisionSystemMessageSchema,
  swarmEnterSystemMessageSchema,
  swarmExitSystemMessageSchema,
  skillSystemMessageSchema,
  noticeSystemMessageSchema,
  hookSystemMessageSchema,
  interruptionSystemMessageSchema,
]);
export type SystemMessage = z.infer<typeof systemMessageSchema>;
