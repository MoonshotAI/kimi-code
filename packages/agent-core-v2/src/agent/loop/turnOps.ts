/**
 * `loop` domain (L4) — wire Model (`TurnModel`) and the Ops that bookkeep the
 * agent's turn lifecycle on the wire.
 *
 * Declares the next turn id as a wire Model (initial `0`). The persisted
 * `turn.prompt` record carries exactly v1's field set (`{ input, origin }` —
 * no `turnId`), and `apply` mirrors v1's `restorePrompt()`: every record
 * advances the counter by one, so the counter is restored by counting
 * turn starts. Every turn is started by `loopService.enqueue` admitting a
 * request that creates a new Turn, which dispatches one
 * `turn.prompt` per start. As a belt-and-suspenders for v1-written logs whose
 * internally-driven turns (goal continuations) have no `turn.prompt` record,
 * `TurnModel` also registers a cross-model reducer on
 * `context.append_loop_event` that raises the counter past any `turnId`
 * observed in a replayed loop event — the v1 `observeRestoredTurnId`
 * semantics. The `turn.started` / `turn.ended` / `error` signals are not part
 * of this Op set and remain on their existing path (published by the loop
 * service around a run). Consumed by the Agent-scope `loopService` (which
 * reads the next turn id on admission).
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';
import type { ContentPart } from '#/kosong/contract/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';

export interface TurnModelState {
  readonly nextTurnId: number;
}

export const TurnModel = defineModel<TurnModelState>('turn', () => ({ nextTurnId: 0 }), {
  reducers: {
    'context.append_loop_event': (state, { event }) => {
      if (event.type === 'tool.result' || event.turnId === undefined) {
        return state;
      }

      const turnId = Number.parseInt(event.turnId, 10);
      return Number.isInteger(turnId) && turnId >= state.nextTurnId
        ? { nextTurnId: turnId + 1 }
        : state;
    },
  },
});

const turnInputShape = {
  input: z.custom<readonly ContentPart[]>(),
  origin: z.custom<PromptOrigin>(),
};

declare module '#/wire/types' {
  interface PersistedOpMap {
    'turn.prompt': typeof promptTurn;
    'turn.steer': typeof steerTurn;
    'turn.cancel': typeof cancelTurn;
  }
}

export const promptTurn = TurnModel.defineOp('turn.prompt', {
  schema: z.object(turnInputShape),
  apply: (s) => ({ nextTurnId: s.nextTurnId + 1 }),
});

export const steerTurn = TurnModel.defineOp('turn.steer', {
  schema: z.object(turnInputShape),
  apply: (s) => s,
});

export const cancelTurn = TurnModel.defineOp('turn.cancel', {
  schema: z.object({ turnId: z.number().optional() }),
  apply: (s) => s,
});
