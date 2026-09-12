import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event2, Event2Class } from '#/app/event/event2';
import type { Hooks } from '#/hooks';

import type { StateFold } from './state';

export type EventDispatcherHooks = {
  readonly onDidRestore: Record<string, never>;
};

export type RestorePhase = 'new' | 'restoring' | 'ready' | 'failed';

export interface DurableAgentRuntimeParticipant<State = any> {
  readonly id: string;
  readonly events: readonly Event2Class<any, any>[];
  readonly undoable: boolean;
  readonly transition: StateFold<State>;
  getState(): State;
  commit(state: State): void;
}

export interface DurableRuntimeParticipantHost {
  attach(participant: DurableAgentRuntimeParticipant): IDisposable;
}

export interface IEventDispatcher extends DurableRuntimeParticipantHost {
  readonly _serviceBrand: undefined;

  readonly hooks: Hooks<EventDispatcherHooks>;

  readonly restorePhase: RestorePhase;

  dispatch(event: Event2<any>): Promise<void>;
  attachLate(participant: DurableAgentRuntimeParticipant): Promise<IDisposable>;
  restore(): Promise<void>;
  flush(): Promise<void>;
}

export const IEventDispatcher: ServiceIdentifier<IEventDispatcher> =
  createDecorator<IEventDispatcher>('eventDispatcher');
