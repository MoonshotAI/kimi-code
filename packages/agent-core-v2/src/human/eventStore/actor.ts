import { fromCallback } from '#/xstate2';

import type { CombinedState, EventStore, SliceMap } from './eventStore';
import type { ExternalEvent } from './events';
import type { StoreJournal } from './journal';

export type StoreActorEvent =
  | { type: 'store.append'; event: ExternalEvent | readonly ExternalEvent[] }
  | { type: 'store.switch'; journal: StoreJournal };

export type StoreActorEmitted<SM extends SliceMap = SliceMap> =
  | { type: 'store.ready'; state: CombinedState<SM>; branch: string }
  | { type: 'store.changed'; state: CombinedState<SM> }
  | { type: 'store.reset'; state: CombinedState<SM>; branch: string }
  | { type: 'store.error'; error: unknown };

export const storeActor = fromCallback<
  StoreActorEvent,
  { store: EventStore<SliceMap> },
  StoreActorEmitted
>(({ input, emit, sendBack, receive }) => {
  const store = input.store;
  const publish = (event: StoreActorEmitted): void => {
    sendBack(event);
    emit(event);
  };
  publish({ type: 'store.ready', state: store.getState(), branch: store.ref.branch });
  const unsubscribe = store.subscribe((state, cause) => {
    if (cause.kind === 'reset') {
      publish({ type: 'store.reset', state, branch: store.ref.branch });
    } else {
      publish({ type: 'store.changed', state });
    }
  });
  receive((event) => {
    if (event.type === 'store.append') {
      void store.dispatch(event.event).catch((error: unknown) => {
        publish({ type: 'store.error', error });
      });
    } else if (event.type === 'store.switch') {
      void store.reset(event.journal).catch((error: unknown) => {
        publish({ type: 'store.error', error });
      });
    }
  });
  return unsubscribe;
});

export type StoreActorLogic = typeof storeActor;
