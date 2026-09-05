import { z } from 'zod';

import { isoDateTimeSchema, timelineMessageBase } from './base';
import { stepUsageSchema } from './step-usage';

export const taskMessageSchema = z.object({
  type: z.literal('task'),
  ...timelineMessageBase,
  task_id: z.string().min(1),
  kind: z.enum(['shell', 'subagent', 'tool', 'other']),
  state: z.enum(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
  detached: z.boolean(),
  description: z.string().optional(),
  child_agent_id: z.string().min(1).optional(),
  output_tail: z.string(),
  started_at: isoDateTimeSchema.optional(),
  ended_at: isoDateTimeSchema.optional(),
  result_summary: z.string().optional(),
  error: z.string().optional(),
  state_reason: z.string().optional(),
  usage: stepUsageSchema.optional(),
  model: z.string().optional(),
  thinking_effort: z.string().optional(),
});

export type TaskMessage = z.infer<typeof taskMessageSchema>;
