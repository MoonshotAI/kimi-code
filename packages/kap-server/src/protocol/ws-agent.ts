import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

const agentFrameFields = {
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  event_created_at: isoDateTimeSchema,
};

export const agentStateSchema = z.object({
  status: z.enum(['idle', 'running']),
  compacting: z.boolean(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  permission_mode: z.enum(['manual', 'yolo', 'auto']).optional(),
  plan_mode: z.boolean(),
  swarm_mode: z.boolean(),
  tower_mode: z.boolean(),
});
export type AgentState = z.infer<typeof agentStateSchema>;

export const agentEventMessageSchema = agentStateSchema.extend({
  type: z.literal('agent'),
  ...agentFrameFields,
});
export type AgentEventMessage = z.infer<typeof agentEventMessageSchema>;

export const usageStateSchema = z.object({
  context_tokens: z.number().int().nonnegative(),
  max_context_tokens: z.number().int().positive().optional(),
});
export type UsageState = z.infer<typeof usageStateSchema>;

export const usageEventMessageSchema = usageStateSchema.extend({
  type: z.literal('usage'),
  ...agentFrameFields,
});
export type UsageEventMessage = z.infer<typeof usageEventMessageSchema>;

export const goalStateSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'blocked', 'complete']),
  completion_criterion: z.string().optional(),
  turns_used: z.number().int().nonnegative(),
  tokens_used: z.number().int().nonnegative(),
  wall_clock_ms: z.number().nonnegative(),
});
export type GoalState = z.infer<typeof goalStateSchema>;

export const goalEventMessageSchema = z.object({
  type: z.literal('goal'),
  ...agentFrameFields,
  goal: goalStateSchema.optional(),
});
export type GoalEventMessage = z.infer<typeof goalEventMessageSchema>;

export const todoItemSchema = z.object({
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done']),
});
export type TodoItemState = z.infer<typeof todoItemSchema>;

export const todoEventMessageSchema = z.object({
  type: z.literal('todo'),
  ...agentFrameFields,
  items: z.array(todoItemSchema),
});
export type TodoEventMessage = z.infer<typeof todoEventMessageSchema>;

export type AgentFeedMessage =
  | AgentEventMessage
  | UsageEventMessage
  | GoalEventMessage
  | TodoEventMessage;
