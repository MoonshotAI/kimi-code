/**
 * `loop` domain — persists and restores monotonically increasing turn
 * identity.
 *
 * Owns the next available turn id, including cancelled queued reservations and
 * legacy loop-event observations. Also persists the terminal `turn.ended`
 * record (reason / error / durationMs) so downstream history rebuilds can
 * recover how a turn ended; the record carries no engine-restorable state, so
 * its `apply` is a no-op. Consumed by the Agent-scope `loopService`; the
 * `interruptionReminder` domain projects `turn.cancel` into its own model.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';
import type { KimiErrorPayload } from '#/_base/errors/serialize';
import type { ContentPart } from '#/kosong/contract/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';

export interface TurnModelState {
  readonly nextTurnId: number;
  readonly cancelledTurnIds: readonly number[];
}

export const TurnModel = defineModel<TurnModelState>(
  'turn',
  () => ({ nextTurnId: 0, cancelledTurnIds: [] }),
  {
    reducers: {
      'context.append_loop_event': (state, { event }) => {
        if (event.type === 'tool.result' || event.turnId === undefined) {
          return state;
        }

        const turnId = Number.parseInt(event.turnId, 10);
        return Number.isInteger(turnId) && turnId >= state.nextTurnId
          ? advanceTurnClock(state, turnId + 1)
          : state;
      },
    },
  },
);

const turnInputShape = {
  input: z.custom<readonly ContentPart[]>(),
  origin: z.custom<PromptOrigin>(),
};

declare module '#/wire/types' {
  interface PersistedOpMap {
    'turn.prompt': typeof promptTurn;
    'turn.steer': typeof steerTurn;
    'turn.cancel': typeof cancelTurn;
    'turn.ended': typeof endTurn;
  }
}

export const promptTurn = TurnModel.defineOp('turn.prompt', {
  schema: z.object(turnInputShape),
  apply: (s) => advanceTurnClock(s, s.nextTurnId + 1),
});

export const steerTurn = TurnModel.defineOp('turn.steer', {
  schema: z.object(turnInputShape),
  apply: (s) => s,
});

export const cancelTurn = TurnModel.defineOp('turn.cancel', {
  schema: z.object({
    turnId: z.number().optional(),
    target: z.enum(['active', 'queued']).optional(),
    reason: z.enum(['user_cancelled', 'aborted']).optional(),
  }),
  apply: (s, { turnId, target }) => {
    if (target === undefined || turnId === undefined) return s;
    if (turnId < s.nextTurnId) return s;
    return advanceTurnClock(s, s.nextTurnId, [...s.cancelledTurnIds, turnId]);
  },
});

export const endTurn = TurnModel.defineOp('turn.ended', {
  schema: z.object({
    turnId: z.number(),
    reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
    error: z.custom<KimiErrorPayload>().optional(),
    durationMs: z.number().optional(),
  }),
  apply: (s) => s,
});

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
    nextTurnId,
    cancelledTurnIds: [...pendingCancellations].toSorted((a, b) => a - b),
  };
}
