import { customRef, shallowRef } from '@vue/reactivity';
import type { Ref, ShallowRef } from '@vue/reactivity';

import { createActor } from '#/xstate2';
import type { Actor, AnyActorLogic, EventFromLogic, InputFrom, SnapshotFrom } from '#/xstate2';

import { createToken } from './primitives';
import { currentUnit, pushCleanup, type RuntimeEvent, type UnitNode } from './runtime';

export interface DurableSlice {
  readonly name: string;
  readonly initialState: () => unknown;
  readonly reducers: Record<string, (draft: any, event: any) => unknown>;
}

export interface DurableBackend {
  registerSlice(slice: DurableSlice): () => void;
  dispatch(event: { type: string } & Record<string, unknown>): Promise<unknown>;
  subscribe(listener: (state: unknown) => void): () => void;
  getState(): unknown;
}

export const EventStoreService = createToken<DurableBackend>('kernel.eventStore');

export interface DurableManager {
  readonly sliceName: string;
  readonly entries: Map<string, ShallowRef<unknown>>;
  readonly initials: Map<string, unknown>;
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

export function acquireDurableManager(node: UnitNode): DurableManager {
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
  const entries = new Map<string, ShallowRef<unknown>>();
  const initials = new Map<string, unknown>();
  let inFlight = 0;
  const resync = (): void => {
    if (inFlight > 0) {
      return;
    }
    const combined = backend.getState() as Record<string, unknown> | undefined;
    const sliceState = combined?.[sliceName];
    if (sliceState === undefined || typeof sliceState !== 'object') {
      return;
    }
    for (const [key, slot] of entries) {
      if (
        key in (sliceState as Record<string, unknown>) &&
        !sameValue((sliceState as Record<string, unknown>)[key], slot.value)
      ) {
        slot.value = (sliceState as Record<string, unknown>)[key];
      }
    }
  };
  const trackedDispatch = (patch: Record<string, unknown>): Promise<void> => {
    inFlight += 1;
    const op = backend
      .dispatch({ type: 'store.patched', store: sliceName, patch })
      .then(() => undefined)
      .catch((error: unknown) => {
        report(error);
        throw error;
      })
      .finally(() => {
        inFlight -= 1;
        resync();
      });
    void op.catch(() => {});
    return op;
  };
  const extraReducers = node.internals.get('durableReducers') as
    | ReadonlyMap<string, (draft: any, event: any) => void>
    | undefined;
  const unregister = backend.registerSlice({
    name: sliceName,
    initialState: () =>
      Object.fromEntries([...entries.keys()].map((key) => [key, initials.get(key)])),
    reducers: {
      'store.patched': (draft, event) => {
        if ((event as { store?: unknown }).store === sliceName) {
          Object.assign(draft, (event as { patch?: Record<string, unknown> }).patch);
        }
      },
      ...(extraReducers === undefined ? {} : Object.fromEntries(extraReducers)),
    },
  });
  const unsubscribe = backend.subscribe(() => resync());
  const manager: DurableManager = {
    sliceName,
    entries,
    initials,
    dispatch: trackedDispatch,
  };
  node.internals.set('durables', manager);
  pushCleanup(node, () => {
    unsubscribe();
    unregister();
  });
  return manager;
}

export function useDurable<S>(key: string, initial: S): Ref<S> {
  const node = currentUnit();
  const manager = acquireDurableManager(node);
  let backing = manager.entries.get(key) as ShallowRef<S> | undefined;
  if (backing === undefined) {
    const created: ShallowRef<unknown> = shallowRef(initial);
    manager.entries.set(key, created);
    manager.initials.set(key, initial);
    backing = created as ShallowRef<S>;
  }
  const state = backing;
  return customRef<S>((track, trigger) => ({
    get: () => {
      track();
      return state.value;
    },
    set: (next: S) => {
      if (Object.is(next, state.value)) {
        return;
      }
      state.value = next;
      trigger();
      void manager.dispatch({ [key]: next });
    },
  }));
}

export function useMachine<TLogic extends AnyActorLogic>(
  factory: () => TLogic,
  options: { key: string; input: InputFrom<TLogic>; enrich?: (event: RuntimeEvent) => RuntimeEvent },
): [Ref<SnapshotFrom<TLogic> | undefined>, (event: EventFromLogic<TLogic>) => void, Actor<TLogic>] {
  const node = currentUnit();
  const snapshotRef: ShallowRef<SnapshotFrom<TLogic> | undefined> = shallowRef(undefined);
  const actor = createActor(factory(), { input: options.input });
  actor.on('*', (event) => {
    const emitted = event as RuntimeEvent;
    node.fire(options.enrich !== undefined ? options.enrich(emitted) : emitted);
  });
  actor.subscribe((snapshot) => {
    snapshotRef.value = snapshot as SnapshotFrom<TLogic>;
  });
  node.postSetup.push(() => {
    actor.start();
    snapshotRef.value = actor.getSnapshot() as SnapshotFrom<TLogic>;
  });
  pushCleanup(node, () => {
    actor.stop();
  });
  return [snapshotRef, (event) => actor.send(event), actor];
}

function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
}

function report(error: unknown): void {
  console.error(error);
}
