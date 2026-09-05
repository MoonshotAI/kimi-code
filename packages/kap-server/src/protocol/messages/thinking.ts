import { z } from 'zod';

import { timelineMessageBase } from './base';

export const thinkingMessageSchema = z.object({
  type: z.literal('thinking'),
  ...timelineMessageBase,
  message_id: z.string().min(1),
  turn_id: z.string().min(1),
  step_id: z.string().min(1),
  status: z.enum(['streaming', 'completed']),
  text: z.string(),
});

export type ThinkingMessage = z.infer<typeof thinkingMessageSchema>;
