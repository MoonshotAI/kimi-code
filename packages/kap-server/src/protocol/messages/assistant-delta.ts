import { z } from 'zod';

import { timelineMessageBase } from './base';

export const assistantDeltaMessageSchema = z.object({
  type: z.literal('assistant.delta'),
  ...timelineMessageBase,
  message_id: z.string().min(1),
  text: z.string(),
});

export type AssistantDelta = z.infer<typeof assistantDeltaMessageSchema>;
