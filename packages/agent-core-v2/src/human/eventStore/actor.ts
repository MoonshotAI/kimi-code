import { fromCallback } from '#/xstate2';

import type { CombinedState, EventStore, SliceMap } from './eventStore';

export type StoreActorEvent = {
  type: 'store.append';
  event: { type: string } & Record<string, unknown> | readonly ({ type: string } & Record<string, unknown>)[];
};

export type StoreActorEmitted<SM extends SliceMap = SliceMap> =
  | { type: 'store.ready'; state: CombinedState<SM>; branch: string }
  | { type: 'store.changed'; state: CombinedState<SM> }
  | { type: 'store.reset'; state: CombinedState<SM>; branch: string }
  | { type: 'store.error'; error: unknown };

export function fromEventStore<SM extends SliceMap>(store: EventStore<SM>) {
  return fromCallback<StoreActorEvent, unknown, StoreActorEmitted<SM>>(({ emit, sendBack, receive }) => {
    const publish = (event: StoreActorEmitted<SM>): void => {
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
      }
    });
    return unsubscribe;
  });
}

export type StoreActorLogic<SM extends SliceMap = SliceMap> = ReturnType<typeof fromEventStore<SM>>;
