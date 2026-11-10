import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

export const conversationStatusSchema = z.enum(['running', 'ended']);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const conversationOutcomeSchema = z.enum(['completed', 'interrupted', 'failed']);
export type ConversationOutcome = z.infer<typeof conversationOutcomeSchema>;

export const turnEndReasonSchema = z.enum([
  'user_cancelled',
  'aborted',
  'max_steps',
  'error',
  'filtered',
  'blocked',
]);
export type TurnEndReason = z.infer<typeof turnEndReasonSchema>;

export const errorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  name: z.string().optional(),
  status_code: z.number().int().optional(),
  request_id: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type ErrorInfo = z.infer<typeof errorInfoSchema>;

export const retryStateSchema = z.object({
  attempt: z.number().int().positive(),
  next_attempt: z.number().int().positive(),
  max_attempts: z.number().int().positive(),
  delay_ms: z.number().nonnegative(),
  error: z.object({
    name: z.string(),
    message: z.string(),
    status_code: z.number().int().optional(),
  }),
});
export type RetryState = z.infer<typeof retryStateSchema>;

export const usageSchema = z.object({
  input_other: z.number().nonnegative(),
  output: z.number().nonnegative(),
  input_cache_read: z.number().nonnegative(),
  input_cache_creation: z.number().nonnegative(),
});
export type Usage = z.infer<typeof usageSchema>;

export const stepSummarySchema = z.object({
  index: z.number().int().positive(),
  outcome: conversationOutcomeSchema,
  started_at: isoDateTimeSchema,
  ended_at: isoDateTimeSchema.optional(),
  finish_reason: z.string().optional(),
  usage: usageSchema.optional(),
});
export type StepSummary = z.infer<typeof stepSummarySchema>;

export const requestTimingSchema = z.object({
  first_token_ms: z.number().optional(),
  stream_ms: z.number().optional(),
  request_build_ms: z.number().optional(),
  server_first_token_ms: z.number().optional(),
  server_decode_ms: z.number().optional(),
  client_consume_ms: z.number().optional(),
  client_blocked_ms: z.number().optional(),
});
export type RequestTiming = z.infer<typeof requestTimingSchema>;

export const requestDebugSchema = z.object({
  finish_reason: z.string().optional(),
  usage: usageSchema.optional(),
  timing: requestTimingSchema.optional(),
});
export type RequestDebug = z.infer<typeof requestDebugSchema>;

const itemFields = {
  item_id: z.string().min(1),
  step_index: z.number().int().positive().optional(),
  debug: requestDebugSchema.optional(),
  status: conversationStatusSchema,
  outcome: conversationOutcomeSchema.optional(),
  created_at: isoDateTimeSchema,
};

export const userMessageOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('skill'), name: z.string(), path: z.string().optional(), args: z.string().optional() }),
  z.object({
    kind: z.literal('plugin_command'),
    plugin_id: z.string(),
    command: z.string(),
    args: z.string().optional(),
  }),
  z.object({
    kind: z.literal('cron'),
    job_id: z.string(),
    schedule: z.string(),
    recurring: z.boolean(),
    coalesced_count: z.number().int().nonnegative(),
    stale: z.boolean(),
  }),
  z.object({ kind: z.literal('hook'), hook_event: z.string() }),
  z.object({ kind: z.literal('goal') }),
  z.object({ kind: z.literal('retry') }),
  z.object({ kind: z.literal('system') }),
]);
export type UserMessageOrigin = z.infer<typeof userMessageOriginSchema>;

export const attachmentSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'file']),
  file_id: z.string().optional(),
  url: z.string().optional(),
  name: z.string().optional(),
  media_type: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  ordinal: z.number().int().positive(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const mediaSchema = z.object({
  kind: z.enum(['image', 'video', 'audio']),
  file_id: z.string().optional(),
  url: z.string().optional(),
  media_type: z.string().optional(),
});
export type Media = z.infer<typeof mediaSchema>;

export const userMessageItemSchema = z.object({
  type: z.literal('user_message'),
  ...itemFields,
  prompt_ids: z.array(z.string().min(1)),
  placement: z.enum(['opener', 'steer']),
  origin: userMessageOriginSchema,
  text: z.string(),
  attachments: z.array(attachmentSchema),
  skills: z.array(z.object({ name: z.string(), path: z.string().optional(), args: z.string().optional() })),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UserMessageItem = z.infer<typeof userMessageItemSchema>;

export const assistantMessageItemSchema = z.object({
  type: z.literal('assistant_message'),
  ...itemFields,
  text: z.string(),
});
export type AssistantMessageItem = z.infer<typeof assistantMessageItemSchema>;

export const reasoningItemSchema = z.object({
  type: z.literal('reasoning'),
  ...itemFields,
  text: z.string(),
  started_at: isoDateTimeSchema,
  duration_ms: z.number().int().nonnegative().optional(),
});
export type ReasoningItem = z.infer<typeof reasoningItemSchema>;

export const toolStageSchema = z.enum(['input', 'awaiting_approval', 'executing']);
export type ToolStage = z.infer<typeof toolStageSchema>;

export const toolProgressSchema = z.object({
  percent: z.number().optional(),
  status: z.string().optional(),
  custom_kind: z.string().optional(),
  custom_data: z.unknown().optional(),
});
export type ToolProgress = z.infer<typeof toolProgressSchema>;

export const agentRefSchema = z.object({
  agent_id: z.string().min(1),
  role: z.enum(['child', 'member']),
  swarm_index: z.number().int().nonnegative().optional(),
  task_id: z.string().optional(),
});
export type AgentRef = z.infer<typeof agentRefSchema>;

export const planReviewDisplaySchema = z.object({
  kind: z.literal('plan_review'),
  plan: z.string(),
  path: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string() })),
  review: z.object({
    state: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
    selected_option: z.string().optional(),
    feedback: z.string().optional(),
  }),
});
export type PlanReviewDisplay = z.infer<typeof planReviewDisplaySchema>;

export const toolCallItemSchema = z.object({
  type: z.literal('tool_call'),
  ...itemFields,
  name: z.string(),
  stage: toolStageSchema.optional(),
  input: z.unknown().optional(),
  input_text: z.string().optional(),
  display: z.unknown().optional(),
  output: z.string().optional(),
  media: z.array(mediaSchema).optional(),
  error: z.string().optional(),
  note: z.string().optional(),
  progress: toolProgressSchema.optional(),
  task_id: z.string().optional(),
  interaction_id: z.string().optional(),
  agent_refs: z.array(agentRefSchema).optional(),
  started_at: isoDateTimeSchema,
  ended_at: isoDateTimeSchema.optional(),
});
export type ToolCallItem = z.infer<typeof toolCallItemSchema>;

export const notificationItemSchema = z.object({
  type: z.literal('notification'),
  ...itemFields,
  notification_id: z.string(),
  title: z.string(),
  body: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  notification_type: z.string(),
  source: z.object({ kind: z.string(), id: z.string() }),
  task_id: z.string().optional(),
  agent_id: z.string().optional(),
  output: z
    .object({
      file: z.string().optional(),
      preview: z.string().optional(),
      bytes: z.number().int().nonnegative().optional(),
      truncated: z.boolean().optional(),
    })
    .optional(),
  answer: z
    .object({
      answers: z.record(z.string(), z.union([z.string(), z.literal(true)])),
      note: z.string().optional(),
    })
    .optional(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const compactionItemSchema = z.object({
  type: z.literal('system'),
  ...itemFields,
  kind: z.literal('compaction'),
  trigger: z.enum(['manual', 'auto']),
  instruction: z.string().optional(),
  tokens_before: z.number().nonnegative().optional(),
  tokens_after: z.number().nonnegative().optional(),
  compacted_count: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
});
export type CompactionItem = z.infer<typeof compactionItemSchema>;

export const forkBoundaryItemSchema = z.object({
  type: z.literal('system'),
  ...itemFields,
  kind: z.literal('fork_boundary'),
  source: z.enum(['btw', 'fork']),
  forked_from: z.object({ agent_id: z.string().min(1) }),
});
export type ForkBoundaryItem = z.infer<typeof forkBoundaryItemSchema>;

export const conversationItemSchema = z.union([
  userMessageItemSchema,
  assistantMessageItemSchema,
  reasoningItemSchema,
  toolCallItemSchema,
  notificationItemSchema,
  compactionItemSchema,
  forkBoundaryItemSchema,
]);
export type ConversationItem = z.infer<typeof conversationItemSchema>;

export const conversationTurnHeaderSchema = z.object({
  turn_id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(['agent', 'system']),
  status: conversationStatusSchema,
  outcome: conversationOutcomeSchema.optional(),
  end_reason: turnEndReasonSchema.optional(),
  error: errorInfoSchema.optional(),
  retry: retryStateSchema.optional(),
  turn_number: z.number().int().nonnegative().optional(),
  started_at: isoDateTimeSchema,
  ended_at: isoDateTimeSchema.optional(),
  duration_ms: z.number().nonnegative().optional(),
  usage: usageSchema.optional(),
  steps: z.array(stepSummarySchema),
});
export type ConversationTurnHeader = z.infer<typeof conversationTurnHeaderSchema>;

export const conversationTurnSchema = conversationTurnHeaderSchema.extend({
  items: z.array(conversationItemSchema),
});
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;

export const conversationTurnsPageSchema = z.object({
  turns: z.array(conversationTurnSchema),
  has_more: z.boolean(),
});
export type ConversationTurnsPage = z.infer<typeof conversationTurnsPageSchema>;

export const noticeSchema = z.object({
  level: z.enum(['info', 'warning', 'error']),
  title: z.string(),
  detail: z.string().optional(),
  code: z.string().optional(),
});
export type Notice = z.infer<typeof noticeSchema>;

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
  type: z.enum(['turn.started', 'turn.ended']),
  ...conversationFrameFields,
  turn: conversationTurnHeaderSchema,
});

export const turnUpdatedMessageSchema = z.object({
  type: z.literal('turn.updated'),
  ...conversationFrameFields,
  turn_id: z.string().min(1),
  step: stepSummarySchema.optional(),
  retry: retryStateSchema.optional(),
});

export const itemMessageSchema = z.object({
  type: z.enum(['item.started', 'item.ended']),
  ...conversationFrameFields,
  turn_id: z.string().min(1),
  item: conversationItemSchema,
});

export const itemUpdatedMessageSchema = z.object({
  type: z.literal('item.updated'),
  ...conversationFrameFields,
  turn_id: z.string().min(1),
  item_id: z.string().min(1),
  set: toolCallItemSchema.omit({ type: true, item_id: true }).partial(),
});

export const itemDeltaFieldSchema = z.enum(['text', 'input_text', 'output']);
export type ItemDeltaField = z.infer<typeof itemDeltaFieldSchema>;

export const itemDeltaMessageSchema = z.object({
  type: z.literal('item.delta'),
  ...conversationFrameFields,
  turn_id: z.string().min(1),
  item_id: z.string().min(1),
  field: itemDeltaFieldSchema,
  delta: z.string(),
});

export const itemRemovedMessageSchema = z.object({
  type: z.literal('item.removed'),
  ...conversationFrameFields,
  turn_id: z.string().min(1),
  item_id: z.string().min(1),
});

export const turnsRemovedMessageSchema = z.object({
  type: z.literal('turns.removed'),
  ...conversationFrameFields,
  turn_ids: z.array(z.string().min(1)),
});

export const turnsFailedMessageSchema = z.object({
  type: z.literal('turns.failed'),
  ...conversationFrameFields,
  code: z.number().int(),
  msg: z.string(),
});

export const noticeMessageSchema = noticeSchema.extend({
  type: z.literal('notice'),
  ...conversationFrameFields,
});

export type TurnsMessage = z.infer<typeof turnsMessageSchema>;
export type TurnMessage = z.infer<typeof turnMessageSchema>;
export type TurnUpdatedMessage = z.infer<typeof turnUpdatedMessageSchema>;
export type ItemMessage = z.infer<typeof itemMessageSchema>;
export type ItemUpdatedMessage = z.infer<typeof itemUpdatedMessageSchema>;
export type ItemDeltaMessage = z.infer<typeof itemDeltaMessageSchema>;
export type ItemRemovedMessage = z.infer<typeof itemRemovedMessageSchema>;
export type TurnsRemovedMessage = z.infer<typeof turnsRemovedMessageSchema>;
export type TurnsFailedMessage = z.infer<typeof turnsFailedMessageSchema>;
export type NoticeMessage = z.infer<typeof noticeMessageSchema>;

export type ConversationMessage =
  | TurnsMessage
  | TurnMessage
  | TurnUpdatedMessage
  | ItemMessage
  | ItemUpdatedMessage
  | ItemDeltaMessage
  | ItemRemovedMessage
  | TurnsRemovedMessage
  | TurnsFailedMessage
  | NoticeMessage;
