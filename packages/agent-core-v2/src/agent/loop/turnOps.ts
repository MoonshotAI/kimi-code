/**
 * `loop` domain (L4) — persists and restores monotonically increasing turn
 * identity.
 *
 * Owns the next available turn id, cancelled queued reservations, and pending
 * user-interruption reminders. Consumed by the Agent-scope `loopService`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';
import type { ContentPart } from '#/kosong/contract/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';

export interface TurnModelState {
  readonly nextTurnId: number;
  readonly cancelledTurnIds: readonly number[];
  readonly pendingUserInterruptionTurnIds: readonly number[];
}

export const TurnModel = defineModel<TurnModelState>(
  'turn',
  () => ({ nextTurnId: 0, cancelledTurnIds: [], pendingUserInterruptionTurnIds: [] }),
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
    'turn.interruption_reminded': typeof interruptionReminderRecorded;
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
  apply: (s, { turnId, target, reason }) => {
    if (target === undefined || turnId === undefined) return s;
    const withPendingInterruption =
      target === 'active' && reason === 'user_cancelled'
        ? addPendingUserInterruption(s, turnId)
        : s;
    if (turnId < s.nextTurnId) return withPendingInterruption;
    return advanceTurnClock(withPendingInterruption, s.nextTurnId, [
      ...s.cancelledTurnIds,
      turnId,
    ]);
  },
});

export const interruptionReminderRecorded = TurnModel.defineOp(
  'turn.interruption_reminded',
  {
    schema: z.object({ turnId: z.number().int().nonnegative() }),
    apply: (s, { turnId }) => {
      if (!s.pendingUserInterruptionTurnIds.includes(turnId)) return s;
      return {
        ...s,
        pendingUserInterruptionTurnIds: s.pendingUserInterruptionTurnIds.filter(
          (pendingTurnId) => pendingTurnId !== turnId,
        ),
      };
    },
  },
);

function addPendingUserInterruption(state: TurnModelState, turnId: number): TurnModelState {
  if (state.pendingUserInterruptionTurnIds.includes(turnId)) return state;
  return {
    ...state,
    pendingUserInterruptionTurnIds: [...state.pendingUserInterruptionTurnIds, turnId].toSorted(
      (a, b) => a - b,
    ),
  };
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
    nextTurnId,
    cancelledTurnIds: [...pendingCancellations].toSorted((a, b) => a - b),
    pendingUserInterruptionTurnIds: state.pendingUserInterruptionTurnIds,
  };
}
