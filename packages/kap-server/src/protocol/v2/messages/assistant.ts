import { z } from 'zod';
import { timelineBaseFields } from './base';

const streamingTextFields = {
  ...timelineBaseFields,
  message_id: z.string(),
  turn_id: z.string(),
  step_id: z.string(),
  status: z.enum(['streaming', 'completed']),
  text: z.string(),
} as const;

export const assistantMessageSchema = z.object({
  type: z.literal('assistant'),
  ...streamingTextFields,
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const thinkingMessageSchema = z.object({
  type: z.literal('thinking'),
  ...streamingTextFields,
});
export type ThinkingMessage = z.infer<typeof thinkingMessageSchema>;
