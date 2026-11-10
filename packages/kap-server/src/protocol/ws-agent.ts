import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';
import { messageContentSchema } from './message';

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

export const queuedInputSchema = z.object({
  prompt_id: z.string().min(1),
  user_message_id: z.string().min(1),
  kind: z.enum(['input', 'compact']),
  delivery: z.enum(['steer', 'queue']),
  content: z.array(messageContentSchema),
  skills: z.array(z.object({ name: z.string(), args: z.string().optional() })).optional(),
  client_metadata: z.record(z.string(), z.unknown()).optional(),
  instruction: z.string().optional(),
  created_at: isoDateTimeSchema,
});
export type QueuedInput = z.infer<typeof queuedInputSchema>;

export const queueEventMessageSchema = z.object({
  type: z.literal('queue'),
  ...agentFrameFields,
  inputs: z.array(queuedInputSchema),
});
export type QueueEventMessage = z.infer<typeof queueEventMessageSchema>;

export type AgentFeedMessage =
  | AgentEventMessage
  | UsageEventMessage
  | GoalEventMessage
  | TodoEventMessage
  | QueueEventMessage;
