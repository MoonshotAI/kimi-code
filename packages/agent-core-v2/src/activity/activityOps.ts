/**
 * `activity` domain (L4) — Session activity lane wire state.
 *
 * The Session kernel projects its live lane and active lease count into the
 * non-persisted `SessionLaneModel`. Agent activity state is owned directly by
 * `IAgentActivityService` and is not duplicated in wire state.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type { SessionLane } from './activity';

declare module '#/wire/types' {
  interface TransientOpMap {
    'activity.set_session_lane': typeof setSessionLane;
  }
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
