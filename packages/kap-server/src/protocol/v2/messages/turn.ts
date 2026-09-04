import { z } from 'zod';
import { timelineBaseFields, turnUsageSchema } from './base';

export const turnOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('cron'), cron_id: z.string(), schedule: z.string().optional() }),
  z.object({ kind: z.literal('task'), task_id: z.string() }),
  z.object({ kind: z.literal('skill'), skill_name: z.string().optional() }),
  z.object({ kind: z.literal('hook'), name: z.string().optional() }),
  z.object({ kind: z.literal('compaction') }),
  z.object({ kind: z.literal('side') }),
  z.object({ kind: z.literal('goal') }),
  z.object({ kind: z.literal('other'), name: z.string().optional() }),
]);
export type TurnOrigin = z.infer<typeof turnOriginSchema>;

export const turnMessageSchema = z.object({
  type: z.literal('turn'),
  ...timelineBaseFields,
  turn_id: z.string(),
  ordinal: z.number(),
  state: z.enum(['running', 'completed']),
  origin: turnOriginSchema,
  user_message_id: z.string().optional(),
  attachment_ids: z.array(z.string()).optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  usage: turnUsageSchema.optional(),
  duration_ms: z.number().optional(),
});
export type TurnMessage = z.infer<typeof turnMessageSchema>;
