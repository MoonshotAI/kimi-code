/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import type { KimiErrorPayload } from '#/_base/errors/serialize';
import { ContextAppendLoopEvent } from '#/agent/contextMemory/contextEvents';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { AgentEvent2, type SerializedEvent2 } from '#/app/event/event2';
import type { ContentPart } from '#/kosong/contract/message';
import { defineState } from '#/state/state';

import type { TurnInterruptReason } from './turnEvents';

export interface TurnModelState {
  readonly nextTurnId: number;
  readonly cancelledTurnIds: readonly number[];
  readonly lastEnded?: {
    readonly turnId: number;
    readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
    readonly durationMs?: number;
  };
}

const turnInputShape = {
  agentId: z.string(),
  input: z.custom<readonly ContentPart[]>(),
  origin: z.custom<PromptOrigin>(),
};

const turnPromptSchema = z.object(turnInputShape);

export class TurnPrompt extends AgentEvent2<z.infer<typeof turnPromptSchema>> {
  static override readonly type = 'turn.prompt';
  static override readonly durable = true;
  static override readonly schema = turnPromptSchema;
}
export interface TurnPrompt {
  readonly agentId: string;
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

const turnSteerSchema = z.object(turnInputShape);

export class TurnSteer extends AgentEvent2<z.infer<typeof turnSteerSchema>> {
  static override readonly type = 'turn.steer';
  static override readonly durable = true;
  static override readonly schema = turnSteerSchema;
}
export interface TurnSteer {
  readonly agentId: string;
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
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

const turnEndedSchema = z.object({
  agentId: z.string(),
  turnId: z.number(),
  reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
  error: z.custom<KimiErrorPayload>().optional(),
  durationMs: z.number().optional(),
});

export interface TurnEndedPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
  readonly error?: KimiErrorPayload;
  readonly durationMs?: number;
  readonly interruptReason?: TurnInterruptReason;
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
    record['time'] = this.time;
    return record as SerializedEvent2;
  }
}
export interface TurnEnded extends TurnEndedPayload {}

export const turnKey = defineState(
  'turn',
  (): TurnModelState => ({ nextTurnId: 0, cancelledTurnIds: [] }),
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
  .on(TurnPrompt, (s) => advanceTurnClock(s, s.nextTurnId + 1))
  .on(TurnSteer, () => {})
  .on(TurnCancel, (s, e) => {
    if (e.target === undefined || e.turnId === undefined) return;
    if (e.turnId < s.nextTurnId) return;
    return advanceTurnClock(s, s.nextTurnId, [...s.cancelledTurnIds, e.turnId]);
  })
  .on(TurnEnded, (s, e) => ({
    ...s,
    lastEnded: { turnId: e.turnId, reason: e.reason, durationMs: e.durationMs },
  }));

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
