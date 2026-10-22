import { useAgent, useSession } from './units';
import {
  computed,
  shallowRef,
  useCleanup,
  useFire,
  useReady,
  type ComputedRef,
  type ShallowRef,
} from '#/composition-api/index';
import type { Log, Projection } from '@moonshot-ai/agent-core/store/index';
import type { RuntimeEvent } from '#/composition-api/index';

export type FeatureEvent = RuntimeEvent;

export interface FeatureStore<S, E extends FeatureEvent> {
  readonly state: ComputedRef<S>;
  readonly ready: Promise<void>;
  dispatch(events: readonly E[]): Promise<void>;
}

export function useFeatureStore<S, E extends FeatureEvent>(
  scope: 'agent' | 'session',
  name: string,
  projection: Projection<S, E>,
): FeatureStore<S, E> {
  const session = useSession();
  const agent = scope === 'agent' ? useAgent() : undefined;
  const log = (agent === undefined ? session.log : agent.log) as unknown as Log<E>;
  const fire = useFire();
  const state = shallowRef(projection.initial()) as ShallowRef<S>;
  const view = log.replica.view(projection);
  state.value = view.getState();
  view.subscribe((next) => {
    state.value = next;
  });
  let disposed = false;
  const ready = Promise.resolve();
  useReady(ready);
  useCleanup(() => {
    disposed = true;
    view.dispose();
  });
  return {
    state: computed(() => state.value),
    ready,
    dispatch: async (events) => {
      await ready;
      if (disposed) throw new Error(`feature store '${name}' is closed`);
      await log.commit({ events });
      if (disposed) return;
      for (const event of events) fire({ ...event });
    },
  };
}
