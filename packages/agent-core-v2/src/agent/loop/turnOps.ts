/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { isUserCancellation } from '#/_base/utils/abort';
import type { KimiErrorPayload } from '#/_base/errors/serialize';
import {
  ContextAppendLoopEvent,
  ContextApplyCompaction,
  ContextClear,
  ContextUndo,
} from '#/agent/contextMemory/contextEvents';
import { isUndoAnchorTurnPrompt, isValidUndoCount } from '#/agent/undo/turnUndo';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { AgentEvent2, type SerializedEvent2 } from '#/app/event/event2';
import type { ContentPart, ToolDescription } from '@moonshot-ai/core/llm/message';
import type { TurnContinuation } from '@moonshot-ai/core/loop/index';
import { ErrorCodes, isError2 } from '#/errors';
import { defineState, registerUndoableProtocol } from '#/state/state';

import { isMaxStepsExceededError, type TurnResult } from './loop';
import type { TurnEndReason, TurnInterruptReason } from './turnEvents';

const settledToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.custom<Record<string, unknown>>(),
  deferred: z.literal(true).optional(),
});

const toolsSettledSchema = z.object({
  agentId: z.string(),
  tools: z.array(settledToolSchema).readonly(),
});

export class ToolsSettled extends AgentEvent2<z.infer<typeof toolsSettledSchema>> {
  static override readonly type = 'tools.settled';
  static override readonly durable = true;
  static override readonly schema = toolsSettledSchema;
}
export interface ToolsSettled {
  readonly agentId: string;
  readonly tools: readonly ToolDescription[];
}

export interface TurnModelState {
  readonly nextTurnId: number;
  readonly cancelledTurnIds: readonly number[];
  readonly anchorTurnIds: readonly number[];
  readonly lastEnded?: {
    readonly turnId: number;
    readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
    readonly durationMs?: number;
  };
}

const turnPromptSchema = z.object({
  agentId: z.string(),
  input: z.custom<readonly ContentPart[]>(),
  origin: z.custom<PromptOrigin>(),
  promptId: z.string().optional(),
  turnId: z.number().optional(),
  trigger: z.enum(['normal', 'notify', 'continue']).optional(),
});

export class TurnPrompt extends AgentEvent2<z.infer<typeof turnPromptSchema>> {
  static override readonly type = 'turn.prompt';
  static override readonly durable = true;
  static override readonly schema = turnPromptSchema;
}
export interface TurnPrompt {
  readonly agentId: string;
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
  readonly promptId?: string;
  readonly turnId?: number;
  readonly trigger?: 'normal' | 'notify' | 'continue';
}

const turnSteerSchema = z.object({
  agentId: z.string(),
  input: z.custom<readonly ContentPart[]>(),
  origin: z.custom<PromptOrigin>(),
  messageId: z.string().optional(),
  promptIds: z.array(z.string()).optional(),
  turnId: z.number().optional(),
});

export class TurnSteer extends AgentEvent2<z.infer<typeof turnSteerSchema>> {
  static override readonly type = 'turn.steer';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = turnSteerSchema;
}
export interface TurnSteer {
  readonly agentId: string;
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
  readonly messageId?: string;
  readonly promptIds?: readonly string[];
  readonly turnId?: number;
}

const turnCancelSchema = z.object({
  agentId: z.string(),
  turnId: z.number().optional(),
  target: z.enum(['active', 'queued']).optional(),
  reason: z.enum(['user_cancelled', 'aborted']).optional(),
});

export class TurnCancel extends AgentEvent2<z.infer<typeof turnCancelSchema>> {
  static override readonly type = 'turn.cancel';
  static override readonly durable = true;
  static override readonly schema = turnCancelSchema;
}
export interface TurnCancel {
  readonly agentId: string;
  readonly turnId?: number;
  readonly target?: 'active' | 'queued';
  readonly reason?: 'user_cancelled' | 'aborted';
}

const turnModelSchema = z.object({ provider: z.string(), model: z.string() });
export type TurnReplyModel = z.infer<typeof turnModelSchema>;

export const turnModelStepSchema = z.object({
  step: z.int(),
  role: z.enum(['step', 'subagent']),
  model: z.string(),
  provider: z.string(),
  isKfc: z.boolean(),
  requestId: z.string().optional(),
});
export type TurnModelStep = z.infer<typeof turnModelStepSchema>;
export type RequestModel = Pick<TurnModelStep, 'model' | 'provider' | 'isKfc'>;

const turnEndedSchema = z.object({
  agentId: z.string(),
  turnId: z.number(),
  reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
  error: z.custom<KimiErrorPayload>().optional(),
  durationMs: z.number().optional(),
  stopReason: z.string().optional(),
  requestId: z.string().optional(),
  replyModel: turnModelSchema.optional(),
  modelSteps: z.array(turnModelStepSchema).optional(),
  continuation: z.enum(['turn', 'background', 'none']).optional(),
});

export interface TurnEndedPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
  readonly error?: KimiErrorPayload;
  readonly durationMs?: number;
  readonly interruptReason?: TurnInterruptReason;
  readonly stopReason?: string;
  readonly requestId?: string;
  readonly replyModel?: TurnReplyModel;
  readonly modelSteps?: TurnModelStep[];
  readonly continuation?: TurnContinuation;
}

export class TurnEnded extends AgentEvent2<TurnEndedPayload> {
  static override readonly type = 'turn.ended';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = turnEndedSchema;

  override serialize(): SerializedEvent2 {
    const record: Record<string, unknown> = {
      type: this.type,
      agentId: this.agentId,
      turnId: this.turnId,
      reason: this.reason,
    };
    if (this.error !== undefined) record['error'] = this.error;
    if (this.durationMs !== undefined) record['durationMs'] = this.durationMs;
    if (this.stopReason !== undefined) record['stopReason'] = this.stopReason;
    if (this.requestId !== undefined) record['requestId'] = this.requestId;
    if (this.replyModel !== undefined) record['replyModel'] = this.replyModel;
    if (this.modelSteps !== undefined) record['modelSteps'] = this.modelSteps;
    if (this.continuation !== undefined) record['continuation'] = this.continuation;
    record['time'] = this.time;
    return record as SerializedEvent2;
  }
}
export interface TurnEnded extends TurnEndedPayload {}

export function turnInterruptReason(
  result: Extract<TurnResult, { readonly type: 'cancelled' | 'failed' }>,
): TurnInterruptReason {
  if (result.type === 'cancelled') return isUserCancellation(result.reason) ? 'user_cancelled' : 'aborted';
  if (isMaxStepsExceededError(result.error)) return 'max_steps';
  if (isError2(result.error) && result.error.code === ErrorCodes.PROVIDER_FILTERED) return 'filtered';
  return 'error';
}

export const turnKey = defineState(
  'turn',
  (): TurnModelState => ({ nextTurnId: 0, cancelledTurnIds: [], anchorTurnIds: [] }),
).replayable({ schema: z.custom<TurnModelState>() })
  .on(ContextAppendLoopEvent, (s, e) => {
    const { event } = e;
    if (event.type === 'tool.result' || event.turnId === undefined) return;
    const turnId = Number.parseInt(event.turnId, 10);
    if (!Number.isInteger(turnId)) return;
    let next: TurnModelState = s;
    if (turnId >= next.nextTurnId) next = advanceTurnClock(next, turnId + 1);
    if (next.lastEnded !== undefined && turnId > next.lastEnded.turnId) {
      next = { ...next, lastEnded: undefined };
    }
    if (next !== s) return next;
  })
  .on(TurnPrompt, (s, e) => {
    const assigned = e.turnId ?? s.nextTurnId;
    const next = advanceTurnClock(s, assigned + 1);
    if (!isUndoAnchorTurnPrompt(e)) return next;
    return { ...next, anchorTurnIds: [...s.anchorTurnIds, assigned] };
  })
  .on(TurnSteer, () => {})
  .on(ToolsSettled, () => {})
  .on(ContextUndo, (s, e) => {
    const firstRemoved = s.anchorTurnIds[s.anchorTurnIds.length - e.count];
    const lastEnded = s.lastEnded;
    return {
      ...s,
      anchorTurnIds: s.anchorTurnIds.slice(0, Math.max(0, s.anchorTurnIds.length - e.count)),
      lastEnded:
        lastEnded !== undefined &&
        (firstRemoved === undefined || lastEnded.turnId >= firstRemoved)
          ? undefined
          : lastEnded,
    };
  })
  .on(ContextApplyCompaction, (s) => ({ ...s, anchorTurnIds: [] }))
  .on(ContextClear, (s) => ({ ...s, anchorTurnIds: [] }))
  .on(TurnCancel, (s, e) => {
    if (e.target === undefined || e.turnId === undefined) return;
    if (e.turnId < s.nextTurnId) return;
    return advanceTurnClock(s, s.nextTurnId, [...s.cancelledTurnIds, e.turnId]);
  })
  .on(TurnEnded, (s, e) => ({
    ...s,
    lastEnded: { turnId: e.turnId, reason: e.reason, durationMs: e.durationMs },
  }));

export interface TurnEndedEvent {
  readonly type: 'turn.ended';
  readonly time?: number;
  readonly turnId: number;
  readonly reason: TurnEndReason;
  readonly error?: KimiErrorPayload;
  readonly durationMs?: number;
  readonly interruptReason?: TurnInterruptReason;
  readonly requestId?: string;
  readonly continuation?: TurnContinuation;
}

function advanceTurnClock(
  state: TurnModelState,
  nextTurnId: number,
  cancelledTurnIds: readonly number[] = state.cancelledTurnIds,
): TurnModelState {
  const pendingCancellations = new Set(
    cancelledTurnIds.filter((turnId) => turnId >= nextTurnId),
  );
  while (pendingCancellations.delete(nextTurnId)) nextTurnId += 1;
  return {
    ...state,
    nextTurnId,
    cancelledTurnIds: [...pendingCancellations].toSorted((a, b) => a - b),
  };
}

registerUndoableProtocol({
  events: {
    appendLoopEvent: ContextAppendLoopEvent,
    turnPrompt: TurnPrompt,
    turnSteer: TurnSteer,
    turnEnded: TurnEnded,
    applyCompaction: ContextApplyCompaction,
    clear: ContextClear,
    undo: ContextUndo,
  },
  isUndoAnchor: (prompt) => isUndoAnchorTurnPrompt(prompt as TurnPrompt),
  isValidUndoCount,
});
