/**
 * `loop` domain — the `turnKey` state and the durable `turn.prompt`
 * (`TurnPrompt`) / `turn.steer` (`TurnSteer`) / `turn.cancel` (`TurnCancel`) /
 * `turn.ended` (`TurnEnded`) events behind monotonically increasing turn
 * identity.
 *
 * The state owns the next available turn id, including cancelled queued
 * reservations and legacy loop-event observations (the
 * `ContextAppendLoopEvent` fold), plus the terminal `lastEnded` outcome
 * (reason / error / durationMs) so downstream history rebuilds and
 * cold-resumed read models (e.g. the activity view) can recover how the last
 * turn ended. The durable classes are the wire-protocol record vocabulary:
 * their `serialize()` output is the on-disk record (flat payload, epoch-ms
 * `time`), byte-compatible with the retired op encoding. `TurnEnded` merges
 * the retired op with the same-named bus fact: it is durable AND observable,
 * and carries the bus-only `interruptReason` alongside the persisted fields —
 * its `serialize()` override emits exactly the op's record shape, so the
 * journal stays byte-identical and replay never republishes. Consumed by the
 * Agent-scope `loopService`.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import type { KimiErrorPayload } from '#/_base/errors/serialize';
import { ContextAppendLoopEvent } from '#/agent/contextMemory/contextEvents';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { Event2, type SerializedEvent2 } from '#/app/event/event2';
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
  input: z.custom<readonly ContentPart[]>(),
  origin: z.custom<PromptOrigin>(),
};

const turnPromptSchema = z.object(turnInputShape);

export class TurnPrompt extends Event2<z.infer<typeof turnPromptSchema>> {
  static override readonly type = 'turn.prompt';
  static override readonly durable = true;
  static override readonly schema = turnPromptSchema;
}
export interface TurnPrompt extends z.infer<typeof turnPromptSchema> {}

const turnSteerSchema = z.object(turnInputShape);

export class TurnSteer extends Event2<z.infer<typeof turnSteerSchema>> {
  static override readonly type = 'turn.steer';
  static override readonly durable = true;
  static override readonly schema = turnSteerSchema;
}
export interface TurnSteer extends z.infer<typeof turnSteerSchema> {}

const turnCancelSchema = z.object({
  turnId: z.number().optional(),
  target: z.enum(['active', 'queued']).optional(),
  reason: z.enum(['user_cancelled', 'aborted']).optional(),
});

export class TurnCancel extends Event2<z.infer<typeof turnCancelSchema>> {
  static override readonly type = 'turn.cancel';
  static override readonly durable = true;
  static override readonly schema = turnCancelSchema;
}
export interface TurnCancel extends z.infer<typeof turnCancelSchema> {}

const turnEndedSchema = z.object({
  turnId: z.number(),
  reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
  error: z.custom<KimiErrorPayload>().optional(),
  durationMs: z.number().optional(),
});

export interface TurnEndedPayload {
  readonly turnId: number;
  readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
  readonly error?: KimiErrorPayload;
  readonly durationMs?: number;
  readonly interruptReason?: TurnInterruptReason;
}

export class TurnEnded extends Event2<TurnEndedPayload> {
  static override readonly type = 'turn.ended';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = turnEndedSchema;

  override serialize(): SerializedEvent2 {
    const record: Record<string, unknown> = {
      type: this.type,
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
