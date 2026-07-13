/**
 * `activity` domain (L4) — wire Model (`LaneModel`) and the `activity.set_lane`
 * Op that holds the Agent activity lane.
 *
 * The lane is a live-only Model (`persist: false`): nothing is persisted or
 * replayed, so a resumed agent starts back at `idle`. The Agent kernel
 * (`agentActivityService`) is the sole dispatcher of `setLane`; `apply` returns
 * the SAME reference when the incoming state is unchanged under `laneEqual`
 * (which ignores the `since` / `at` timestamps) so redundant dispatches do not
 * flood subscribers. The Op derives no event here — the outward snapshot event
 * is emitted by the projector so there is a single event source (PR5). The
 * initial lane is `idle` (fresh agents accept turns immediately); the
 * half-replay window is gated at the Session kernel (`restoring`), not here.
 * Consumed by the Agent-scope `agentActivityService` and (PR5) the projector.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';
import type { PromptOrigin } from '#/agent/contextMemory/types';

import type { AgentLane, BackgroundActivityRef, SessionLane } from './activity';

export interface LaneTurnState {
  readonly turnId: number;
  readonly origin: PromptOrigin;
  readonly ending: boolean;
  readonly endingReason?: 'aborted' | 'max_steps' | 'error';
  readonly since: number;
}

export interface LaneLastTurnState {
  readonly turnId: number;
  readonly reason: 'completed' | 'cancelled' | 'failed';
  readonly at: number;
}

export interface LaneModelState {
  readonly lane: AgentLane;
  readonly turn?: LaneTurnState;
  readonly lastTurn?: LaneLastTurnState;
  readonly background: readonly BackgroundActivityRef[];
}

export const LaneModel = defineModel<LaneModelState>('activityLane', () => ({
  lane: 'idle',
  background: [],
}));

declare module '#/wire/types' {
  interface TransientOpMap {
    'activity.set_lane': typeof setLane;
    'activity.set_session_lane': typeof setSessionLane;
  }
}

export const setLane = LaneModel.defineOp('activity.set_lane', {
  schema: z.object({ next: z.custom<LaneModelState>() }),
  persist: false,
  apply: (s, p) => (laneEqual(s, p.next) ? s : p.next),
});

export function laneEqual(a: LaneModelState, b: LaneModelState): boolean {
  if (a.lane !== b.lane) return false;
  if (a.background.length !== b.background.length) return false;
  if ((a.turn === undefined) !== (b.turn === undefined)) return false;
  if (a.turn !== undefined && b.turn !== undefined) {
    if (
      a.turn.turnId !== b.turn.turnId ||
      a.turn.ending !== b.turn.ending ||
      a.turn.endingReason !== b.turn.endingReason
    ) {
      return false;
    }
  }
  if ((a.lastTurn === undefined) !== (b.lastTurn === undefined)) return false;
  if (a.lastTurn !== undefined && b.lastTurn !== undefined) {
    if (a.lastTurn.turnId !== b.lastTurn.turnId || a.lastTurn.reason !== b.lastTurn.reason) {
      return false;
    }
  }
  return true;
}

export interface SessionLaneModelState {
  readonly lane: SessionLane;
  readonly activeLeases: number;
}

export const SessionLaneModel = defineModel<SessionLaneModelState>('sessionActivityLane', () => ({
  lane: 'restoring',
  activeLeases: 0,
}));

export const setSessionLane = SessionLaneModel.defineOp('activity.set_session_lane', {
  schema: z.object({ next: z.custom<SessionLaneModelState>() }),
  persist: false,
  apply: (s, p) => (s.lane === p.next.lane && s.activeLeases === p.next.activeLeases ? s : p.next),
});
