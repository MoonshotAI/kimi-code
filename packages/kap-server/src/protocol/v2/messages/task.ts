import { z } from 'zod';
import { stepUsageSchema, timelineBaseFields } from './base';

export const taskMessageSchema = z.object({
  type: z.literal('task'),
  ...timelineBaseFields,
  task_id: z.string(),
  kind: z.enum(['shell', 'subagent', 'tool', 'other']),
  state: z.enum(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
  detached: z.boolean(),
  description: z.string().optional(),
  child_agent_id: z.string().optional(),
  output_tail: z.string(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  result_summary: z.string().optional(),
  error: z.string().optional(),
  state_reason: z.string().optional(),
  usage: stepUsageSchema.optional(),
  model: z.string().optional(),
  thinking_effort: z.string().optional(),
});
export type TaskMessage = z.infer<typeof taskMessageSchema>;
