import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

export const taskStateSchema = z.object({
  task_id: z.string().min(1),
  kind: z.enum(['shell', 'subagent', 'other']),
  status: z.enum(['running', 'ended']),
  outcome: z.enum(['completed', 'failed', 'timed_out', 'killed', 'lost']).optional(),
  phase: z.enum(['working', 'suspended']).optional(),
  detached: z.boolean(),
  description: z.string().optional(),
  child_agent_id: z.string().optional(),
  parent_tool_call_id: z.string().optional(),
  swarm_index: z.number().int().nonnegative().optional(),
  command: z.string().optional(),
  started_at: isoDateTimeSchema.optional(),
  ended_at: isoDateTimeSchema.optional(),
  result_summary: z.string().optional(),
  error: z.string().optional(),
  state_reason: z.string().optional(),
  model: z.string().optional(),
  thinking: z.string().optional(),
});
export type TaskState = z.infer<typeof taskStateSchema>;

export const taskEventMessageSchema = taskStateSchema.extend({
  type: z.literal('task'),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  event_created_at: isoDateTimeSchema,
});
export type TaskEventMessage = z.infer<typeof taskEventMessageSchema>;

export const taskListMessageSchema = z.object({
  type: z.literal('task.list'),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  tasks: z.array(taskStateSchema),
});
export type TaskListMessage = z.infer<typeof taskListMessageSchema>;

export const TASK_OUTPUT_DEFAULT_TAIL_BYTES = 32 * 1024;
export const TASK_OUTPUT_MAX_TAIL_BYTES = 1024 * 1024;

const taskTargetFields = {
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
};

export const taskWatchMessageSchema = z.object({
  type: z.literal('task.watch'),
  ...taskTargetFields,
  since_offset: z.number().int().nonnegative().optional(),
  tail_bytes: z.number().int().min(1).max(TASK_OUTPUT_MAX_TAIL_BYTES).optional(),
});
export type TaskWatchMessage = z.infer<typeof taskWatchMessageSchema>;

export const taskUnwatchMessageSchema = z.object({
  type: z.literal('task.unwatch'),
  ...taskTargetFields,
});

export const taskStopMessageSchema = z.object({
  type: z.literal('task.stop'),
  ...taskTargetFields,
});

export const taskBackgroundMessageSchema = z.object({
  type: z.literal('task.background'),
  ...taskTargetFields,
});

export const taskOutputMessageSchema = z.object({
  type: z.literal('task.output'),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
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
  task: taskStateSchema.optional(),
});
export type TaskResponseMessage = z.infer<typeof taskResponseMessageSchema>;
