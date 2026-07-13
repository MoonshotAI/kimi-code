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
 * service around a run). Consumed by the Agent-scope `loopService` and by the
 * `activity` kernel (which reads the next turn id on admission).
 */

import { defineModel } from '#/wire/model';
import { defineOp } from '#/wire/op';
import type { ContentPart } from '#/app/llmProtocol/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';

export interface TurnModelState {
  readonly nextTurnId: number;
}

export const TurnModel = defineModel<TurnModelState>('turn', () => ({ nextTurnId: 0 }), {
  reducers: {
    'context.append_loop_event': (s, p: { event?: { turnId?: unknown } }): TurnModelState => {
      const raw = p?.event?.turnId;
      if (typeof raw !== 'string' && typeof raw !== 'number') return s;
      const turnId = Number.parseInt(String(raw), 10);
      if (Number.isInteger(turnId) && turnId >= s.nextTurnId) {
        return { nextTurnId: turnId + 1 };
      }
      return s;
    },
  },
});

export interface PromptTurnPayload {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export interface SteerTurnPayload {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export interface CancelTurnPayload {
  readonly turnId?: number;
}

declare module '#/wire/types' {
  interface PersistedOpMap {
    'turn.prompt': PromptTurnPayload;
    'turn.steer': SteerTurnPayload;
    'turn.cancel': CancelTurnPayload;
  }
}

export const promptTurn = defineOp(TurnModel, 'turn.prompt', {
  apply: (s, _p) => ({ nextTurnId: s.nextTurnId + 1 }),
});

export const steerTurn = defineOp(TurnModel, 'turn.steer', {
  apply: (s, _p) => s,
});

export const cancelTurn = defineOp(TurnModel, 'turn.cancel', {
  apply: (s, _p) => s,
});
