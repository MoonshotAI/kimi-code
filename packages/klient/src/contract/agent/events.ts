import { z } from 'zod';

import type { EventRegistration } from '../types.js';

interface StreamEventRegistration {
  readonly kind: 'stream';
  readonly name: string;
  readonly type?: string;
  readonly schema: z.ZodType;
}

type AgentEventRegistration = EventRegistration | StreamEventRegistration;

export const turnStartedEventSchema = z.object({
  type: z.literal('turn.started'),
  time: z.number().optional(),
  turnId: z.number(),
  origin: z.unknown(),
  prompt: z.string().optional(),
  promptId: z.string().optional(),
});

export const turnEndedEventSchema = z.object({
  type: z.literal('turn.ended'),
  time: z.number().optional(),
  turnId: z.number(),
  reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
  error: z.unknown().optional(),
  durationMs: z.number().optional(),
  interruptReason: z
    .enum(['user_cancelled', 'aborted', 'max_steps', 'error', 'filtered', 'blocked'])
    .optional(),
  traceId: z.string().optional(),
});

export const assistantDeltaEventSchema = z.object({
  type: z.literal('assistant.delta'),
  time: z.number().optional(),
  turnId: z.number(),
  delta: z.string(),
});

export const thinkingDeltaEventSchema = z.object({
  type: z.literal('thinking.delta'),
  time: z.number().optional(),
  turnId: z.number(),
  delta: z.string(),
});

export const toolCallStartedEventSchema = z.object({
  type: z.literal('tool.call.started'),
  time: z.number().optional(),
  turnId: z.number(),
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
  description: z.string().optional(),
  display: z.unknown().optional(),
});

export const toolCallDeltaEventSchema = z.object({
  type: z.literal('tool.call.delta'),
  time: z.number().optional(),
  turnId: z.number(),
  toolCallId: z.string(),
  name: z.string().optional(),
  argumentsPart: z.string().optional(),
});

export const toolProgressEventSchema = z.object({
  type: z.literal('tool.progress'),
  time: z.number().optional(),
  turnId: z.number(),
  toolCallId: z.string(),
  update: z.object({
    kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
    text: z.string().optional(),
    percent: z.number().optional(),
    customKind: z.string().optional(),
    customData: z.unknown().optional(),
    replace: z.boolean().optional(),
  }),
});

export const toolResultEventSchema = z.object({
  type: z.literal('tool.result'),
  time: z.number().optional(),
  turnId: z.number(),
  toolCallId: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
  synthetic: z.boolean().optional(),
});

export const promptCompletedEventSchema = z.object({
  type: z.literal('prompt.completed'),
  time: z.number().optional(),
  promptId: z.string(),
  finishedAt: z.string(),
  reason: z.enum(['completed', 'failed', 'blocked']).optional(),
});

export const promptAbortedEventSchema = z.object({
  type: z.literal('prompt.aborted'),
  time: z.number().optional(),
  promptId: z.string(),
  abortedAt: z.string(),
});

export const compactionStartedEventSchema = z.object({
  type: z.literal('compaction.started'),
  time: z.number().optional(),
  trigger: z.enum(['manual', 'auto']),
  instruction: z.string().optional(),
});

export const compactionBlockedEventSchema = z.object({
  type: z.literal('compaction.blocked'),
  time: z.number().optional(),
  turnId: z.number().optional(),
});

export const compactionCancelledEventSchema = z.object({
  type: z.literal('compaction.cancelled'),
  time: z.number().optional(),
});

export const compactionCompletedEventSchema = z.object({
  type: z.literal('compaction.completed'),
  time: z.number().optional(),
  result: z.object({
    summary: z.string(),
    compactedCount: z.number(),
    tokensBefore: z.number(),
    tokensAfter: z.number(),
    keptUserMessageCount: z.number().optional(),
    keptHeadUserMessageCount: z.number().optional(),
    droppedCount: z.number().optional(),
  }),
});

export const permissionApprovalRequestedEventSchema = z.looseObject({
  time: z.number().optional(),
  turnId: z.number(),
  toolCallId: z.string(),
  toolName: z.string(),
  action: z.string(),
});

export const permissionApprovalResolvedEventSchema = z.looseObject({
  time: z.number().optional(),
  turnId: z.number(),
  toolCallId: z.string(),
});

export const errorEventSchema = z.looseObject({
  time: z.number().optional(),
  message: z.string(),
});

export const warningEventSchema = z.object({
  type: z.literal('warning'),
  time: z.number().optional(),
  message: z.string(),
  code: z.string().optional(),
});

export const agentStatusUpdatedEventSchema = z.looseObject({
  time: z.number().optional(),
  phase: z.string().optional(),
});

export interface AgentEventPayloads {
  'turn.started': z.infer<typeof turnStartedEventSchema>;
  'turn.ended': z.infer<typeof turnEndedEventSchema>;
  'assistant.delta': z.infer<typeof assistantDeltaEventSchema>;
  'thinking.delta': z.infer<typeof thinkingDeltaEventSchema>;
  'tool.call.started': z.infer<typeof toolCallStartedEventSchema>;
  'tool.call.delta': z.infer<typeof toolCallDeltaEventSchema>;
  'tool.progress': z.infer<typeof toolProgressEventSchema>;
  'tool.result': z.infer<typeof toolResultEventSchema>;
  'prompt.completed': z.infer<typeof promptCompletedEventSchema>;
  'prompt.aborted': z.infer<typeof promptAbortedEventSchema>;
  'compaction.started': z.infer<typeof compactionStartedEventSchema>;
  'compaction.blocked': z.infer<typeof compactionBlockedEventSchema>;
  'compaction.cancelled': z.infer<typeof compactionCancelledEventSchema>;
  'compaction.completed': z.infer<typeof compactionCompletedEventSchema>;
  'permission.approval.requested': z.infer<typeof permissionApprovalRequestedEventSchema>;
  'permission.approval.resolved': z.infer<typeof permissionApprovalResolvedEventSchema>;
  error: z.infer<typeof errorEventSchema>;
  warning: z.infer<typeof warningEventSchema>;
  'agent.status.updated': z.infer<typeof agentStatusUpdatedEventSchema>;
}

export type AgentEventName = keyof AgentEventPayloads;

export const agentEvents = {
  'turn.started': { kind: 'stream', name: 'events', type: 'turn.started', schema: turnStartedEventSchema },
  'turn.ended': { kind: 'stream', name: 'events', type: 'turn.ended', schema: turnEndedEventSchema },
  'assistant.delta': { kind: 'stream', name: 'events', type: 'assistant.delta', schema: assistantDeltaEventSchema },
  'thinking.delta': { kind: 'stream', name: 'events', type: 'thinking.delta', schema: thinkingDeltaEventSchema },
  'tool.call.started': { kind: 'stream', name: 'events', type: 'tool.call.started', schema: toolCallStartedEventSchema },
  'tool.call.delta': { kind: 'stream', name: 'events', type: 'tool.call.delta', schema: toolCallDeltaEventSchema },
  'tool.progress': { kind: 'stream', name: 'events', type: 'tool.progress', schema: toolProgressEventSchema },
  'tool.result': { kind: 'stream', name: 'events', type: 'tool.result', schema: toolResultEventSchema },
  'prompt.completed': { kind: 'stream', name: 'events', type: 'prompt.completed', schema: promptCompletedEventSchema },
  'prompt.aborted': { kind: 'stream', name: 'events', type: 'prompt.aborted', schema: promptAbortedEventSchema },
  'compaction.started': {
    kind: 'stream',
    name: 'events',
    type: 'compaction.started',
    schema: compactionStartedEventSchema,
  },
  'compaction.blocked': {
    kind: 'stream',
    name: 'events',
    type: 'compaction.blocked',
    schema: compactionBlockedEventSchema,
  },
  'compaction.cancelled': {
    kind: 'stream',
    name: 'events',
    type: 'compaction.cancelled',
    schema: compactionCancelledEventSchema,
  },
  'compaction.completed': {
    kind: 'stream',
    name: 'events',
    type: 'compaction.completed',
    schema: compactionCompletedEventSchema,
  },
  'permission.approval.requested': {
    kind: 'stream',
    name: 'events',
    type: 'permission.approval.requested',
    schema: permissionApprovalRequestedEventSchema,
  },
  'permission.approval.resolved': {
    kind: 'stream',
    name: 'events',
    type: 'permission.approval.resolved',
    schema: permissionApprovalResolvedEventSchema,
  },
  error: { kind: 'stream', name: 'events', type: 'error', schema: errorEventSchema },
  warning: { kind: 'stream', name: 'events', type: 'warning', schema: warningEventSchema },
  'agent.status.updated': {
    kind: 'stream',
    name: 'events',
    type: 'agent.status.updated',
    schema: agentStatusUpdatedEventSchema,
  },
} satisfies Record<AgentEventName, AgentEventRegistration>;
