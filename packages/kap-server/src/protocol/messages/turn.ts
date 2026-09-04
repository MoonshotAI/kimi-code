import { z } from 'zod';

import { isoDateTimeSchema, timelineMessageBase } from './base';
import { turnOriginSchema } from './turn-origin';

export const turnUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cached_tokens: z.number().int().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
});

export type TurnUsage = z.infer<typeof turnUsageSchema>;

export const turnMessageSchema = z.object({
  type: z.literal('turn'),
  ...timelineMessageBase,
  turn_id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  state: z.enum(['running', 'completed']),
  origin: turnOriginSchema,
  user_message_id: z.string().min(1).optional(),
  attachment_ids: z.array(z.string().min(1)).optional(),
  started_at: isoDateTimeSchema.optional(),
  ended_at: isoDateTimeSchema.optional(),
  usage: turnUsageSchema.optional(),
  duration_ms: z.number().nonnegative().optional(),
});

export type TurnMessage = z.infer<typeof turnMessageSchema>;
