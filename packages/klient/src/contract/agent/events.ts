/**
 * Klient-level agent-scope events — the public, typed, namespaced event
 * surface of one agent. All registrations filter the per-agent `events`
 * scope stream by `type`; the payload is the whole flat `{ type, ... }`
 * event (schemas keep the `type` literal so listeners receive it intact).
 * Payload shapes mirror `protocol/src/events.ts`; events that are loose in
 * the engine (or absent from the protocol union) are `z.looseObject`s.
 */

import { z } from 'zod';

import type { EventRegistration } from '../types.js';

/**
 * Scope-stream registration (`kind: 'stream'`). Declared structurally here
 * until `EventRegistration` in `../types.js` gains the `stream` variant;
 * compatible with `src/core/events/hub.ts`, which already switches on it.
 */
interface StreamEventRegistration {
  readonly kind: 'stream';
  readonly name: string;
  readonly type?: string;
  readonly schema: z.ZodType;
}

type AgentEventRegistration = EventRegistration | StreamEventRegistration;

// ── payload schemas ─────────────────────────────────────────────────────────

export const turnStartedEventSchema = z.object({
  type: z.literal('turn.started'),
  turnId: z.number(),
  /** Protocol `PromptOrigin` union — mirrored as `unknown`. */
  origin: z.unknown(),
  /** The turn's extracted prompt text (present when the turn opened with a text part). */
  prompt: z.string().optional(),
});

export const turnEndedEventSchema = z.object({
  type: z.literal('turn.ended'),
  turnId: z.number(),
  reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
  /** Protocol `KimiErrorPayload` — mirrored as `unknown`. */
  error: z.unknown().optional(),
  durationMs: z.number().optional(),
});

export const assistantDeltaEventSchema = z.object({
  type: z.literal('assistant.delta'),
  turnId: z.number(),
  delta: z.string(),
});

export const thinkingDeltaEventSchema = z.object({
  type: z.literal('thinking.delta'),
  turnId: z.number(),
  delta: z.string(),
});

export const toolCallStartedEventSchema = z.object({
  type: z.literal('tool.call.started'),
  turnId: z.number(),
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
  description: z.string().optional(),
  /** Protocol `ToolInputDisplay` — mirrored as `unknown`. */
  display: z.unknown().optional(),
});

export const toolResultEventSchema = z.object({
  type: z.literal('tool.result'),
  turnId: z.number(),
  toolCallId: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
  synthetic: z.boolean().optional(),
});

export const promptCompletedEventSchema = z.object({
  type: z.literal('prompt.completed'),
  promptId: z.string(),
  /** ISO 8601 datetime string on the wire. */
  finishedAt: z.string(),
  reason: z.enum(['completed', 'failed', 'blocked']).optional(),
});

export const promptAbortedEventSchema = z.object({
  type: z.literal('prompt.aborted'),
  promptId: z.string(),
  /** ISO 8601 datetime string on the wire. */
  abortedAt: z.string(),
});

/** Engine `permission.approval.requested` — not in the protocol union; loose. */
export const permissionApprovalRequestedEventSchema = z.looseObject({
  turnId: z.number(),
  toolCallId: z.string(),
  toolName: z.string(),
  action: z.string(),
});

/** Engine `permission.approval.resolved` — not in the protocol union; loose. */
export const permissionApprovalResolvedEventSchema = z.looseObject({
  turnId: z.number(),
  toolCallId: z.string(),
});

/** `error` payloads carry the full `KimiErrorPayload`; kept loose. */
export const errorEventSchema = z.looseObject({
  message: z.string(),
});

export const warningEventSchema = z.object({
  type: z.literal('warning'),
  message: z.string(),
  code: z.string().optional(),
});

/** `agent.status.updated` carries a wide optional status bag; kept loose. */
export const agentStatusUpdatedEventSchema = z.looseObject({
  phase: z.string().optional(),
});

// ── registrations ───────────────────────────────────────────────────────────

/** Public event name → payload type. Keys must stay in sync with `agentEvents`. */
export interface AgentEventPayloads {
  'turn.started': z.infer<typeof turnStartedEventSchema>;
  'turn.ended': z.infer<typeof turnEndedEventSchema>;
  'assistant.delta': z.infer<typeof assistantDeltaEventSchema>;
  'thinking.delta': z.infer<typeof thinkingDeltaEventSchema>;
  'tool.call.started': z.infer<typeof toolCallStartedEventSchema>;
  'tool.result': z.infer<typeof toolResultEventSchema>;
  'prompt.completed': z.infer<typeof promptCompletedEventSchema>;
  'prompt.aborted': z.infer<typeof promptAbortedEventSchema>;
  'permission.approval.requested': z.infer<typeof permissionApprovalRequestedEventSchema>;
  'permission.approval.resolved': z.infer<typeof permissionApprovalResolvedEventSchema>;
  error: z.infer<typeof errorEventSchema>;
  warning: z.infer<typeof warningEventSchema>;
  'agent.status.updated': z.infer<typeof agentStatusUpdatedEventSchema>;
}

export type AgentEventName = keyof AgentEventPayloads;

/** Public event name → stream binding + payload schema. */
export const agentEvents = {
  'turn.started': { kind: 'stream', name: 'events', type: 'turn.started', schema: turnStartedEventSchema },
  'turn.ended': { kind: 'stream', name: 'events', type: 'turn.ended', schema: turnEndedEventSchema },
  'assistant.delta': { kind: 'stream', name: 'events', type: 'assistant.delta', schema: assistantDeltaEventSchema },
  'thinking.delta': { kind: 'stream', name: 'events', type: 'thinking.delta', schema: thinkingDeltaEventSchema },
  'tool.call.started': { kind: 'stream', name: 'events', type: 'tool.call.started', schema: toolCallStartedEventSchema },
  'tool.result': { kind: 'stream', name: 'events', type: 'tool.result', schema: toolResultEventSchema },
  'prompt.completed': { kind: 'stream', name: 'events', type: 'prompt.completed', schema: promptCompletedEventSchema },
  'prompt.aborted': { kind: 'stream', name: 'events', type: 'prompt.aborted', schema: promptAbortedEventSchema },
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
