import { z } from 'zod';

import { timelineMessageBase } from './base';

export const assistantMessageSchema = z.object({
  type: z.literal('assistant'),
  ...timelineMessageBase,
  message_id: z.string().min(1),
  turn_id: z.string().min(1),
  step_id: z.string().min(1),
  status: z.enum(['streaming', 'completed']),
  text: z.string(),
});

export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
