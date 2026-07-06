/**
 * `turn` domain (L4) — wire Model (`TurnModel`) and the `turn.launch` Op
 * (`launchTurn`) that advances the agent's monotonically-increasing turn id.
 *
 * Declares the next turn id as a wire Model (initial `0`) plus the single Op
 * whose `apply` is the pure extraction of the former live `restoreLaunch` and its
 * `record.define('turn.launch', { resume })` facet: `nextTurnId` becomes
 * `max(current, turnId + 1)` for an integer payload, returning the same reference
 * when the payload does not advance the counter (so the wire's reference-equality
 * gate stays quiet). The `turn.started` / `turn.ended` / `error` signals are not
 * part of this Op and remain on their existing path. Consumed by the Agent-scope
 * `turnService`.
 */

import { defineModel, defineOp } from '#/wire';

export interface TurnModelState {
  readonly nextTurnId: number;
}

export const TurnModel = defineModel<TurnModelState>('turn', () => ({ nextTurnId: 0 }));

export const launchTurn = defineOp(TurnModel, 'turn.launch', {
  apply: (s, p: { turnId: number }): TurnModelState => {
    if (Number.isInteger(p.turnId) && p.turnId >= s.nextTurnId) {
      return { nextTurnId: p.turnId + 1 };
    }
    return s;
  },
  toEvent: (p) => ({ type: 'turn.started' as const, turnId: p.turnId }),
});
