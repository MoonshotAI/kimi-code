import { z } from 'zod';
import { timelineBaseFields } from './base';

export const toolProgressPayloadSchema = z.object({
  kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
  text: z.string().optional(),
  percent: z.number().optional(),
  custom_kind: z.string().optional(),
  custom_data: z.unknown().optional(),
});
export type ToolProgressPayload = z.infer<typeof toolProgressPayloadSchema>;

export const assistantDeltaMessageSchema = z.object({
  type: z.literal('assistant.delta'),
  ...timelineBaseFields,
  message_id: z.string(),
  text: z.string(),
});
export type AssistantDeltaMessage = z.infer<typeof assistantDeltaMessageSchema>;

export const thinkingDeltaMessageSchema = z.object({
  type: z.literal('thinking.delta'),
  ...timelineBaseFields,
  message_id: z.string(),
  text: z.string(),
});
export type ThinkingDeltaMessage = z.infer<typeof thinkingDeltaMessageSchema>;

export const toolCallDeltaMessageSchema = z.object({
  type: z.literal('tool_call.delta'),
  ...timelineBaseFields,
  tool_call_id: z.string(),
  input_text: z.string(),
});
export type ToolCallDeltaMessage = z.infer<typeof toolCallDeltaMessageSchema>;

export const toolProgressMessageSchema = z.object({
  type: z.literal('tool.progress'),
  ...timelineBaseFields,
  tool_call_id: z.string(),
  progress: toolProgressPayloadSchema,
});
export type ToolProgressMessage = z.infer<typeof toolProgressMessageSchema>;

export const deltaMessageSchema = z.discriminatedUnion('type', [
  assistantDeltaMessageSchema,
  thinkingDeltaMessageSchema,
  toolCallDeltaMessageSchema,
  toolProgressMessageSchema,
]);
export type DeltaMessage = z.infer<typeof deltaMessageSchema>;
