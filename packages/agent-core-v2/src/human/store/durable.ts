import { computed, shallowRef } from '@vue/reactivity';
import type { Ref, ShallowRef } from '@vue/reactivity';

import { isEqual } from 'radashi';

import { z } from 'zod';

import { createToken, currentUnit, pushCleanup, useReady, type UnitNode } from '#/kernel/index';

import { defineEvent, type EventStore, type SliceMap } from './log';

export type DurableStore = Pick<EventStore<SliceMap>, 'registerSlice' | 'ready' | 'flush' | 'dispatch' | 'subscribe' | 'getState'>;

export const EventStoreService = createToken<DurableStore>('store.eventStore');

const storePatched = defineEvent({
  type: 'store.patched',
  schema: z.object({ store: z.string(), patch: z.record(z.string(), z.unknown()) }),
});

interface DurableManager {
  readonly sliceName: string;
  readonly state: ShallowRef<Record<string, unknown>>;
  readonly initials: Map<string, unknown>;
  readonly ready: Promise<void>;
  dispatch(patch: Record<string, unknown>): Promise<void>;
}

export function useDurableReducer(type: string, reducer: (draft: any, event: any) => void): void {
  const node = currentUnit();
  if (node.internals.has('durables')) {
    throw new Error(
      `useDurableReducer for event '${type}' must run before the first useDurable in unit '${node.recipe.name}'`,
    );
  }
  let reducers = node.internals.get('durableReducers') as
    | Map<string, (draft: any, event: any) => void>
    | undefined;
  if (reducers === undefined) {
    reducers = new Map();
    node.internals.set('durableReducers', reducers);
  }
  reducers.set(type, reducer);
}

function acquireDurableManager(node: UnitNode): DurableManager {
  const existing = node.internals.get('durables');
  if (existing !== undefined) {
    return existing as DurableManager;
  }
  const backend = (() => {
    try {
      return node.resolve(EventStoreService);
    } catch {
      throw new Error(
        `useDurable requires an event store backend, none resolvable from unit '${node.recipe.name}'`,
      );
    }
  })();
  const sliceName = node.recipe.name;
  const state = shallowRef<Record<string, unknown>>({});
  const initials = new Map<string, unknown>();
  const pending = new Set<Promise<void>>();
  const resync = (): void => {
    if (pending.size > 0) return;
    const combined = backend.getState() as Record<string, unknown> | undefined;
    const sliceState = combined?.[sliceName];
    if (sliceState === null || typeof sliceState !== 'object') return;
    const next = { ...Object.fromEntries(initials), ...sliceState };
    if (!isEqual(next, state.value)) state.value = next;
  };
  const extraReducers = node.internals.get('durableReducers') as
    | ReadonlyMap<string, (draft: any, event: any) => void>
    | undefined;
  const unregister = backend.registerSlice({
    name: sliceName,
    initialState: () => Object.fromEntries(initials),
    reducers: {
      'store.patched': (draft, event) => {
        if ((event as { store?: unknown }).store === sliceName) {
          Object.assign(draft, (event as { patch?: Record<string, unknown> }).patch);
        }
      },
      ...(extraReducers === undefined ? {} : Object.fromEntries(extraReducers)),
    },
  });
  const unsubscribe = backend.subscribe(resync);
  let restored = false;
  const ready = Promise.resolve().then(() => backend.ready()).then(() => {
    restored = true;
    resync();
  });
  useReady(ready);
  const manager: DurableManager = {
    sliceName,
    state,
    initials,
    ready,
    dispatch: (patch) => {
      if (node.state === 'unmounted') return Promise.reject(new Error(`unit '${node.name}' is unmounted`));
      for (const key of Object.keys(patch)) {
        if (!initials.has(key)) return Promise.reject(new Error(`unknown durable key '${key}' in '${sliceName}'`));
      }
      const op = ready
        .then(() => backend.dispatch(storePatched({ store: sliceName, patch })))
        .then(() => undefined)
        .finally(() => {
          pending.delete(op);
          resync();
        });
      pending.add(op);
      return op;
    },
  };
  node.internals.set('durables', manager);
  pushCleanup(node, async () => {
    if (!restored) unregister();
    try {
      await Promise.allSettled(pending);
      if (restored) await backend.flush();
    } finally {
      unsubscribe();
      unregister();
    }
  });
  return manager;
}

export function useDurable<S>(key: string, initial: S): Ref<S> {
  const manager = acquireDurableManager(currentUnit());
  if (!manager.initials.has(key)) {
    manager.initials.set(key, initial);
    manager.state.value = { ...manager.state.value, [key]: initial };
  }
  return computed({
    get: () => manager.state.value[key] as S,
    set: (next: S) => {
      if (Object.is(next, manager.state.value[key])) return;
      manager.state.value = { ...manager.state.value, [key]: next };
      void manager.dispatch({ [key]: next }).catch(report);
    },
  });
}

export function useDurableAction<S extends object>(): (patch: Partial<S>) => Promise<void> {
  const manager = acquireDurableManager(currentUnit());
  return (patch) => manager.dispatch(patch);
}

function report(error: unknown): void {
  console.error(error);
}
