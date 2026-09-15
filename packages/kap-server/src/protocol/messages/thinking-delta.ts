import { z } from 'zod';

import { timelineMessageBase } from './base';

export const thinkingDeltaMessageSchema = z.object({
  type: z.literal('thinking.delta'),
  ...timelineMessageBase,
  message_id: z.string().min(1),
  text: z.string(),
});

export type ThinkingDelta = z.infer<typeof thinkingDeltaMessageSchema>;
