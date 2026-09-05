import { z } from 'zod';
import { timelineBaseFields, stepUsageSchema } from './base';

export const agentStateSchema = z.enum([
  'queued',
  'running',
  'suspended',
  'completed',
  'failed',
  'cancelled',
]);
export type AgentState = z.infer<typeof agentStateSchema>;

export const agentMessageSchema = z.object({
  type: z.literal('agent'),
  ...timelineBaseFields,
  subagent_id: z.string(),
  parent_tool_call_id: z.string().optional(),
  subagent_type: z.string(),
  description: z.string().optional(),
  model: z.string().optional(),
  thinking_effort: z.string().optional(),
  swarm_index: z.number().optional(),
  detached: z.boolean(),
  state: agentStateSchema,
  task_id: z.string().optional(),
  suspended_reason: z.string().optional(),
  result_summary: z.string().optional(),
  usage: stepUsageSchema.optional(),
  error: z.string().optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;
