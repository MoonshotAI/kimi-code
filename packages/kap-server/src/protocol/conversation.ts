import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

import { messageContentSchema } from './message';

export const conversationItemStatusSchema = z.enum(['running', 'ended']);
export type ConversationItemStatus = z.infer<typeof conversationItemStatusSchema>;

export const conversationTurnOutcomeSchema = z.enum([
  'completed',
  'cancelled',
  'failed',
  'blocked',
  'interrupted',
]);
export type ConversationTurnOutcome = z.infer<typeof conversationTurnOutcomeSchema>;

export const conversationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  name: z.string().optional(),
  retryable: z.boolean().optional(),
  status_code: z.number().optional(),
  request_id: z.string().optional(),
});
export type ConversationError = z.infer<typeof conversationErrorSchema>;

export const userMessageItemSchema = z.object({
  type: z.literal('user_message'),
  item_id: z.string().min(1),
  status: z.literal('ended'),
  placement: z.enum(['opener', 'steer']),
  prompt_ids: z.array(z.string().min(1)),
  origin: z.record(z.string(), z.unknown()).optional(),
  content: z.array(messageContentSchema),
  created_at: isoDateTimeSchema.optional(),
});
export type UserMessageItem = z.infer<typeof userMessageItemSchema>;

export const assistantMessageItemSchema = z.object({
  type: z.literal('assistant_message'),
  item_id: z.string().min(1),
  status: conversationItemStatusSchema,
  step_index: z.number().int().optional(),
  text: z.string(),
});
export type AssistantMessageItem = z.infer<typeof assistantMessageItemSchema>;

export const reasoningItemSchema = z.object({
  type: z.literal('reasoning'),
  item_id: z.string().min(1),
  status: conversationItemStatusSchema,
  step_index: z.number().int().optional(),
  text: z.string(),
  started_at: isoDateTimeSchema.optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});
export type ReasoningItem = z.infer<typeof reasoningItemSchema>;

export const agentRefSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  swarm_index: z.number().int().optional(),
  run_in_background: z.boolean().optional(),
});
export type AgentRef = z.infer<typeof agentRefSchema>;

export const toolInteractionSchema = z.object({
  interaction_id: z.string().min(1),
  kind: z.enum(['approval', 'question', 'user_tool']),
  status: z.enum(['pending', 'ended']),
  request: z.unknown().optional(),
  response: z.unknown().optional(),
});
export type ToolInteraction = z.infer<typeof toolInteractionSchema>;

export const toolCallItemSchema = z.object({
  type: z.literal('tool_call'),
  item_id: z.string().min(1),
  status: conversationItemStatusSchema,
  step_index: z.number().int().optional(),
  name: z.string(),
  input: z.unknown().optional(),
  display: z.unknown().optional(),
  output: z.unknown().optional(),
  is_error: z.boolean().optional(),
  duration_ms: z.number().optional(),
  agent_refs: z.array(agentRefSchema).optional(),
  interaction: toolInteractionSchema.optional(),
});
export type ToolCallItem = z.infer<typeof toolCallItemSchema>;

export const notificationItemSchema = z.object({
  type: z.literal('notification'),
  item_id: z.string().min(1),
  status: z.literal('ended'),
  origin: z.record(z.string(), z.unknown()).optional(),
  text: z.string(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const compactionItemSchema = z.object({
  type: z.literal('compaction'),
  item_id: z.string().min(1),
  status: conversationItemStatusSchema,
  trigger: z.enum(['manual', 'auto']).optional(),
  outcome: z.enum(['completed', 'cancelled']).optional(),
  summary: z.string().optional(),
  tokens_before: z.number().optional(),
  tokens_after: z.number().optional(),
});
export type CompactionItem = z.infer<typeof compactionItemSchema>;

export const conversationItemSchema = z.discriminatedUnion('type', [
  userMessageItemSchema,
  assistantMessageItemSchema,
  reasoningItemSchema,
  toolCallItemSchema,
  notificationItemSchema,
  compactionItemSchema,
]);
export type ConversationItem = z.infer<typeof conversationItemSchema>;

export const conversationStepSchema = z.object({
  step_id: z.string().min(1),
  index: z.number().int(),
  started_at: isoDateTimeSchema.optional(),
  ended_at: isoDateTimeSchema.optional(),
  finish_reason: z.string().optional(),
  usage: z.record(z.string(), z.number()).optional(),
  llm_timing: z.record(z.string(), z.number()).optional(),
});
export type ConversationStep = z.infer<typeof conversationStepSchema>;

export const conversationTurnHeaderSchema = z.object({
  turn_id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  turn_number: z.number().int().nonnegative().optional(),
  kind: z.enum(['agent', 'system']),
  status: conversationItemStatusSchema,
  outcome: conversationTurnOutcomeSchema.optional(),
  error: conversationErrorSchema.optional(),
  started_at: isoDateTimeSchema.optional(),
  ended_at: isoDateTimeSchema.optional(),
  duration_ms: z.number().optional(),
  steps: z.array(conversationStepSchema),
});
export type ConversationTurnHeader = z.infer<typeof conversationTurnHeaderSchema>;

export const conversationTurnSchema = conversationTurnHeaderSchema.extend({
  items: z.array(conversationItemSchema),
});
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;

export const conversationTurnsPageSchema = z.object({
  agent_id: z.string().min(1),
  turns: z.array(conversationTurnSchema),
  has_more: z.boolean(),
});
export type ConversationTurnsPage = z.infer<typeof conversationTurnsPageSchema>;

export const planReviewSchema = z.object({
  state: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  selected_option: z.string().optional(),
  feedback: z.string().optional(),
});

export const planEntrySchema = z.object({
  tool_call_id: z.string(),
  turn_id: z.string(),
  source: z.enum(['interaction', 'display', 'output']),
  plan: z.string(),
  path: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  review: planReviewSchema.optional(),
});
export type PlanEntry = z.infer<typeof planEntrySchema>;

export const agentPlansSchema = z.object({
  agent_id: z.string().min(1),
  plans: z.array(planEntrySchema),
});

const conversationFrameFields = {
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  event_created_at: isoDateTimeSchema,
};

export const turnsMessageSchema = conversationTurnsPageSchema.extend({
  type: z.literal('turns'),
  ...conversationFrameFields,
});

export const turnMessageSchema = z.object({
  type: z.enum(['turn.started', 'turn.updated', 'turn.ended']),
  ...conversationFrameFields,
  turn: conversationTurnHeaderSchema,
});

export const itemMessageSchema = z.object({
  type: z.enum(['item.started', 'item.updated', 'item.ended']),
  ...conversationFrameFields,
  turn_id: z.string().min(1),
  item: conversationItemSchema,
});

export const itemDeltaMessageSchema = z.object({
  type: z.literal('item.delta'),
  ...conversationFrameFields,
  turn_id: z.string().min(1),
  item_id: z.string().min(1),
  delta: z.string(),
});

export const itemRemovedMessageSchema = z.object({
  type: z.literal('item.removed'),
  ...conversationFrameFields,
  turn_id: z.string().min(1),
  item_id: z.string().min(1),
});

export const turnsFailedMessageSchema = z.object({
  type: z.literal('turns.failed'),
  ...conversationFrameFields,
  code: z.number().int(),
  msg: z.string(),
});

export const noticeMessageSchema = z.object({
  type: z.literal('notice'),
  ...conversationFrameFields,
  level: z.enum(['error', 'warning']),
  message: z.string(),
  code: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type TurnsMessage = z.infer<typeof turnsMessageSchema>;
export type TurnMessage = z.infer<typeof turnMessageSchema>;
export type ItemMessage = z.infer<typeof itemMessageSchema>;
export type ItemDeltaMessage = z.infer<typeof itemDeltaMessageSchema>;
export type ItemRemovedMessage = z.infer<typeof itemRemovedMessageSchema>;
export type TurnsFailedMessage = z.infer<typeof turnsFailedMessageSchema>;
export type NoticeMessage = z.infer<typeof noticeMessageSchema>;

export type ConversationMessage =
  | TurnsMessage
  | TurnMessage
  | ItemMessage
  | ItemDeltaMessage
  | ItemRemovedMessage
  | TurnsFailedMessage
  | NoticeMessage;
