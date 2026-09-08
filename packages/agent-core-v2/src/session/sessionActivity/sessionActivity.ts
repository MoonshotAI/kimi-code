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

  state(): SessionActivityState;

  readonly onDidChange: Event<SessionActivityChangedEvent>;
}

export const ISessionActivityView: ServiceIdentifier<ISessionActivityView> =
  createDecorator<ISessionActivityView>('sessionActivityView');
