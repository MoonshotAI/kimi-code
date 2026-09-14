import { z } from 'zod';

import { timelineMessageBase } from './base';

export const toolProgressPayloadSchema = z.object({
  kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
  text: z.string().optional(),
  percent: z.number().optional(),
  custom_kind: z.string().optional(),
  custom_data: z.unknown().optional(),
});

export type ToolProgressPayload = z.infer<typeof toolProgressPayloadSchema>;

export const toolProgressMessageSchema = z.object({
  type: z.literal('tool.progress'),
  ...timelineMessageBase,
  tool_call_id: z.string().min(1),
  progress: toolProgressPayloadSchema,
});

export type ToolProgress = z.infer<typeof toolProgressMessageSchema>;
