import { z } from 'zod';

import { timelineMessageBase } from './base';
import { toolProgressPayloadSchema } from './tool-progress';

export const toolCallAgentRefSchema = z.object({
  agent_id: z.string().min(1),
  role: z.enum(['child', 'member']).optional(),
});

export type ToolCallAgentRef = z.infer<typeof toolCallAgentRefSchema>;

export const toolCallMessageSchema = z.object({
  type: z.literal('tool_call'),
  ...timelineMessageBase,
  tool_call_id: z.string().min(1),
  turn_id: z.string().min(1),
  step_id: z.string().min(1),
  name: z.string().min(1),
  view: z.string().optional(),
  state: z.enum(['running', 'done', 'error']),
  input: z.unknown().optional(),
  input_text: z.string().optional(),
  output: z.unknown().optional(),
  display: z.unknown().optional(),
  error: z.string().optional(),
  progress: toolProgressPayloadSchema.optional(),
  task_id: z.string().min(1).optional(),
  approval_id: z.string().min(1).optional(),
  todo_id: z.string().min(1).optional(),
  agent_refs: z.array(toolCallAgentRefSchema).optional(),
});

export type ToolCallMessage = z.infer<typeof toolCallMessageSchema>;
