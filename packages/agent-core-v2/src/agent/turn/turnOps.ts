/**
 * `turn` domain (L4) — wire Model (`TurnModel`) and the `turn.prompt` Op
 * (`promptTurn`) that advances the agent's monotonically-increasing turn id.
 *
 * Declares the next turn id as a wire Model (initial `0`) plus the Op whose
 * `apply` is the pure extraction of the former live `restorePrompt` facet:
 * `nextTurnId` becomes `max(current, turnId + 1)` for an integer payload,
 * returning the same reference when the payload does not advance the counter
 * (so the wire's reference-equality gate stays quiet). Every turn is launched
 * through `turnService.launch`, so the counter is fully restored from `turn.prompt`
 * records alone (no separate observe mechanism is needed). The `turn.started` /
 * `turn.ended` / `error` signals are not part of this Op and remain on their
 * existing path. Consumed by the Agent-scope `turnService`.
 *
 * `turn.launch` (`launchTurn`) is the pre-1.4 record type: it stays registered so
 * sessions written at wire protocol 1.5 still replay (restored via the
 * newer-version passthrough, no migration), but the live write path no longer
 * emits it.
 */

import { defineModel } from '#/wire/model';
import { defineOp } from '#/wire/op';
import type { ContentPart } from '#/app/llmProtocol/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';

export interface TurnModelState {
  readonly nextTurnId: number;
}

export const TurnModel = defineModel<TurnModelState>('turn', () => ({ nextTurnId: 0 }));

function advanceTurnId(s: TurnModelState, turnId: number): TurnModelState {
  if (Number.isInteger(turnId) && turnId >= s.nextTurnId) {
    return { nextTurnId: turnId + 1 };
  }
  return s;
}

export interface PromptTurnPayload {
  readonly turnId: number;
  readonly input?: unknown;
  readonly origin?: unknown;
  readonly steer?: unknown;
}

export const promptTurn = defineOp(TurnModel, 'turn.prompt', {
  apply: (s, p: PromptTurnPayload): TurnModelState => {
    if (Number.isInteger(p.turnId) && p.turnId >= s.nextTurnId) {
      return { nextTurnId: p.turnId + 1 };
    }
    if (!Number.isInteger(p.turnId)) {
      return { nextTurnId: s.nextTurnId + 1 };
    }
    return s;
  },
});

/** @deprecated Legacy 1.5 record type; kept registered for replay of old sessions. */
export const launchTurn = defineOp(TurnModel, 'turn.launch', {
  apply: (s, p: { turnId: number }): TurnModelState => advanceTurnId(s, p.turnId),
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
    'turn.launch': { readonly turnId: number };
    'turn.steer': SteerTurnPayload;
    'turn.cancel': CancelTurnPayload;
  }
}
