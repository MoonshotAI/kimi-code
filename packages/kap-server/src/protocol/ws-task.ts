import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

export const taskEventMessageSchema = z.object({
  type: z.literal('task'),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  event_created_at: isoDateTimeSchema,
  task_id: z.string().min(1),
  kind: z.enum(['shell', 'subagent', 'tool', 'other']),
  status: z.enum(['running', 'ended']),
  outcome: z.enum(['completed', 'failed', 'timed_out', 'killed', 'lost']).optional(),
  phase: z.enum(['working', 'suspended']).optional(),
  detached: z.boolean(),
  description: z.string().optional(),
  child_agent_id: z.string().optional(),
  parent_tool_call_id: z.string().optional(),
  command: z.string().optional(),
  started_at: isoDateTimeSchema.optional(),
  ended_at: isoDateTimeSchema.optional(),
  result_summary: z.string().optional(),
  error: z.string().optional(),
  state_reason: z.string().optional(),
  usage: z
    .object({
      input_other: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      input_cache_read: z.number().int().nonnegative(),
      input_cache_creation: z.number().int().nonnegative(),
    })
    .optional(),
  model: z.string().optional(),
  thinking: z.string().optional(),
});
export type TaskEventMessage = z.infer<typeof taskEventMessageSchema>;

export const taskAttachMessageSchema = z.object({
  type: z.literal('task.attach'),
  request_id: z.string(),
  session_id: z.string().min(1),
  task_id: z.string().min(1),
  since_offset: z.number().int().nonnegative().optional(),
});
export type TaskAttachMessage = z.infer<typeof taskAttachMessageSchema>;

export const taskDetachMessageSchema = z.object({
  type: z.literal('task.detach'),
  request_id: z.string(),
  session_id: z.string().min(1),
  task_id: z.string().min(1),
});

export const taskOutputMessageSchema = z.object({
  type: z.literal('task.output'),
  session_id: z.string().min(1),
  task_id: z.string().min(1),
  offset: z.number().int().nonnegative(),
  text: z.string(),
});
export type TaskOutputMessage = z.infer<typeof taskOutputMessageSchema>;

export const taskResponseMessageSchema = z.object({
  type: z.literal('response'),
  request_id: z.string(),
  code: z.number().int(),
  msg: z.string().optional(),
});
export type TaskResponseMessage = z.infer<typeof taskResponseMessageSchema>;
