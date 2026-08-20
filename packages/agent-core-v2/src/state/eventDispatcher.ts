import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event2 } from '#/app/event/event2';
import type { Hooks } from '#/hooks';

import type { PatchEntry, ReplayableStateKey } from './state';

export type EventDispatcherHooks = {
  readonly onDidRestore: Record<string, never>;
};

export interface ModelCheckpointDepth {
  readonly id: string;
  readonly depth: number;
}

export interface IEventDispatcher {
  readonly _serviceBrand: undefined;

  readonly hooks: Hooks<EventDispatcherHooks>;

  dispatch(event: Event2<any>): Promise<void>;
  history<S>(key: ReplayableStateKey<S>): readonly PatchEntry[];
  checkpointDepth(key: ReplayableStateKey<any>): number;
  modelCheckpointDepths(): readonly ModelCheckpointDepth[];
  undo<S>(key: ReplayableStateKey<S>, patchId: number): void;
  restore(): Promise<void>;
  flush(): Promise<void>;
}

export const IEventDispatcher: ServiceIdentifier<IEventDispatcher> =
  createDecorator<IEventDispatcher>('eventDispatcher');
