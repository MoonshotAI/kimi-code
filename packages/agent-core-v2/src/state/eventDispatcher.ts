/**
 * `state` domain — the single Agent-scoped event dispatcher contract.
 *
 * The dispatcher is the unified event pipeline for one Agent: `dispatch`
 * folds the event into every subscribed replayable state key (immer prepare
 * on the current value held by the Agent state service, all-or-nothing write
 * back), appends the serialized record for durable events, publishes the
 * event for observable ones, then drains queued follow-up events. `restore`
 * rebuilds all state silently from the journal (no journal writes, no
 * publish) and runs the ordered restore hook. State reads go through the
 * Agent state service's `get`; patch `history`, `undo`, and
 * `checkpointDepth` expose the conversation-undo building blocks keyed by
 * state key. Callers do not coordinate journal and state through separate
 * services.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event2 } from '#/app/event/event2';
import type { Hooks } from '#/hooks';

import type { PatchEntry, ReplayableStateKey } from './state';

export type EventDispatcherHooks = {
  readonly onDidRestore: Record<string, never>;
};

export interface IEventDispatcher {
  readonly _serviceBrand: undefined;

  readonly hooks: Hooks<EventDispatcherHooks>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatch(event: Event2<any>): Promise<void>;
  history<S>(key: ReplayableStateKey<S>): readonly PatchEntry[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkpointDepth(key: ReplayableStateKey<any>): number;
  undo<S>(key: ReplayableStateKey<S>, patchId: number): void;
  restore(): Promise<void>;
  flush(): Promise<void>;
}

export const IEventDispatcher: ServiceIdentifier<IEventDispatcher> =
  createDecorator<IEventDispatcher>('eventDispatcher');
