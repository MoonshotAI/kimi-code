/**
 * `agentActivityView` — the agent's folded activity snapshot. Mirrors
 * `agent-core-v2/agent/activityView/activityView.ts`. The `turn.origin`
 * deep `PromptOrigin` union is mirrored as `unknown` (parity pins the
 * engine → wire direction only, like `agentContextData.history`).
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const turnPhaseSchema = z.enum(['running', 'streaming', 'tool_call', 'retrying']);

export const approvalRefSchema = z.object({
  approvalId: z.string(),
  toolCallId: z.string().optional(),
  since: z.number(),
});

export const toolCallRefSchema = z.object({
  toolCallId: z.string(),
  name: z.string(),
  since: z.number(),
});

export const activityRetryStateSchema = z.object({
  failedAttempt: z.number(),
  nextAttempt: z.number(),
  maxAttempts: z.number(),
  delayMs: z.number(),
  errorName: z.string().optional(),
  statusCode: z.number().optional(),
});

export const activityTurnStateSchema = z.object({
  turnId: z.number(),
  origin: z.unknown(),
  phase: turnPhaseSchema,
  stream: z.enum(['assistant', 'thinking', 'tool_call']).optional(),
  step: z.number(),
  ending: z.boolean(),
  endingReason: z.enum(['aborted', 'max_steps', 'error']).optional(),
  retry: activityRetryStateSchema.optional(),
  pendingApprovals: z.array(approvalRefSchema),
  activeToolCalls: z.array(toolCallRefSchema),
  since: z.number(),
});

export const turnEndReasonSchema = z.enum(['completed', 'cancelled', 'failed', 'blocked']);

export const activityLastTurnStateSchema = z.object({
  turnId: z.number(),
  reason: turnEndReasonSchema,
  durationMs: z.number().optional(),
  at: z.number(),
});

export const backgroundRefSchema = z.object({
  kind: z.string(),
  id: z.string(),
  since: z.number(),
});

export const activityViewLifecycleSchema = z.enum(['ready', 'disposed']);

export const agentActivityStateSchema = z.object({
  lifecycle: activityViewLifecycleSchema,
  turn: activityTurnStateSchema.optional(),
  lastTurn: activityLastTurnStateSchema.optional(),
  background: z.array(backgroundRefSchema),
});

export const agentActivityViewContract = {
  state: { input: z.tuple([]), output: agentActivityStateSchema },
} satisfies ServiceContract;
