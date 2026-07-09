/**
 * `turn` domain (L4) — wire Model (`TurnModel`) and the `turn.prompt` Op
 * (`promptTurn`) that advances the agent's monotonically-increasing turn id.
 *
 * Declares the next turn id as a wire Model (initial `0`). The persisted
 * `turn.prompt` record carries exactly v1's field set (`{ input, origin }` —
 * no `turnId`), and `apply` mirrors v1's `restorePrompt()`: every record
 * advances the counter by one, so the counter is restored by counting launches.
 * Every turn is launched through `turnService.launch`, which dispatches one
 * `turn.prompt` per launch. As a belt-and-suspenders for v1-written logs whose
 * internally-driven turns (goal continuations) have no `turn.prompt` record,
 * `TurnModel` also registers a cross-model reducer on
 * `context.append_loop_event` that raises the counter past any `turnId`
 * observed in a replayed loop event — the v1 `observeRestoredTurnId` semantics.
 * The `turn.started` / `turn.ended` / `error` signals are not part of this Op
 * and remain on their existing path. Consumed by the Agent-scope `turnService`.
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
      if (raw === undefined) return s;
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

export const promptTurn = defineOp(TurnModel, 'turn.prompt', {
  apply: (s, _p: PromptTurnPayload): TurnModelState => ({ nextTurnId: s.nextTurnId + 1 }),
});

export interface SteerTurnPayload {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export const steerTurn = defineOp(TurnModel, 'turn.steer', {
  apply: (s, _p: SteerTurnPayload): TurnModelState => s,
});

export interface CancelTurnPayload {
  readonly turnId?: number;
}

export const cancelTurn = defineOp(TurnModel, 'turn.cancel', {
  apply: (s, _p: CancelTurnPayload): TurnModelState => s,
});

declare module '#/agent/wireRecord/wireRecord' {
  interface WireRecordMap {
    'turn.prompt': PromptTurnPayload;
    'turn.steer': SteerTurnPayload;
    'turn.cancel': CancelTurnPayload;
  }
}
