/**
 * `sessionActivity` domain (L6) — the session's aggregated work projection.
 *
 * Defines `ISessionActivityView`: a Session-scoped, read-only, event-folded
 * aggregate of "what this session is doing" — `busy` (any agent with an
 * active turn or live background work), the main agent's turn activity and
 * latest outcome, and the session's pending-interaction slice. The fold
 * inputs are each agent's `activityView` projection (consumed through the
 * agent event bus) and the session's `interaction` kernel; the view owns no
 * authoritative state and can be discarded and rebuilt at any time. Change
 * notifications carry the domain `cause` so consumers can schedule their own
 * rendering around related facts (the v1 WS edge orders its
 * `event.session.work_changed` frame before `turn.started` but after
 * `turn.ended`). Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export type SessionPendingInteraction = 'none' | 'approval' | 'question';

export type SessionTurnOutcome = 'completed' | 'cancelled' | 'failed';

export interface SessionActivityState {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: SessionTurnOutcome;
}

/** What folded input produced a change — scheduling information for consumers. */
export type SessionActivityCause =
  | 'turn_started'
  | 'turn_ended'
  | 'background'
  | 'interaction'
  | 'agent_lifecycle';

export interface SessionActivityChangedEvent {
  readonly state: SessionActivityState;
  readonly cause: SessionActivityCause;
}

export interface ISessionActivityView {
  readonly _serviceBrand: undefined;

  /** The current aggregate (cheap to recompute; do not cache long-term). */
  state(): SessionActivityState;

  /** Fires only when the aggregate tuple actually changes. */
  readonly onDidChange: Event<SessionActivityChangedEvent>;
}

export const ISessionActivityView: ServiceIdentifier<ISessionActivityView> =
  createDecorator<ISessionActivityView>('sessionActivityView');
