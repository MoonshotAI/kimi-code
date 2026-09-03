import { z } from 'zod';
import { timelineBaseFields } from './base';
import { toolProgressPayloadSchema } from './delta';

export const toolCallAgentRefSchema = z.object({
  agent_id: z.string(),
  role: z.enum(['child', 'member']).optional(),
});
export type ToolCallAgentRef = z.infer<typeof toolCallAgentRefSchema>;

export const toolCallMessageSchema = z.object({
  type: z.literal('tool_call'),
  ...timelineBaseFields,
  tool_call_id: z.string(),
  turn_id: z.string(),
  step_id: z.string(),
  name: z.string(),
  view: z.string().optional(),
  state: z.enum(['running', 'done', 'error']),
  input: z.unknown().optional(),
  input_text: z.string().optional(),
  output: z.unknown().optional(),
  display: z.unknown().optional(),
  error: z.string().optional(),
  progress: toolProgressPayloadSchema.optional(),
  task_id: z.string().optional(),
  approval_id: z.string().optional(),
  todo_id: z.string().optional(),
  agent_refs: z.array(toolCallAgentRefSchema).optional(),
});
export type ToolCallMessage = z.infer<typeof toolCallMessageSchema>;
