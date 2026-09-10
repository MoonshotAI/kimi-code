import { z } from 'zod';

import { timelineMessageBase } from './base';

export const toolCallDeltaMessageSchema = z.object({
  type: z.literal('tool_call.delta'),
  ...timelineMessageBase,
  tool_call_id: z.string().min(1),
  input_text: z.string(),
});

export type ToolCallDelta = z.infer<typeof toolCallDeltaMessageSchema>;
