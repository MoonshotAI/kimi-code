import { computed, customRef, shallowRef, toValue, watch } from '@vue/reactivity';
import type {
  ComputedRef,
  MaybeRefOrGetter,
  Ref,
  ShallowRef,
  WatchEffect,
  WatchHandle,
  WatchOptions,
} from '@vue/reactivity';

import { createActor } from '#/xstate2';
import type { Actor, AnyActorLogic, EventFromLogic, InputFrom, SnapshotFrom } from '#/xstate2';

import type { EventHandler, RuntimeEvent } from './events';
import {
  currentUnit,
  pushCleanup,
  type KernelRecipe,
  type UnitHandle,
  type UnitNode,
} from './runtime';
import type { CollectionToken, Token } from './tokens';
import { EventStoreService } from './tokens';

export {
  computed,
  effectScope,
  isRef,
  reactive,
  ref,
  shallowRef,
  toValue,
  unref,
  watch,
} from '@vue/reactivity';
export type { ComputedRef, EffectScope, Ref, ShallowRef } from '@vue/reactivity';

export function watchEffect(effect: WatchEffect, options?: WatchOptions): WatchHandle {
  return watch(effect, null, options);
}

export function provide<T>(token: Token<T>, value: T): void {
  currentUnit().provide(token, value);
}

export function inject<T>(token: Token<T>): T {
  return currentUnit().resolve(token);
}

export function useNode(): UnitNode {
  return currentUnit();
}

export function useFire(): (event: RuntimeEvent) => void {
  const node = currentUnit();
  return (event) => node.fire(event);
}

export function useOn<E extends RuntimeEvent>(
  type: E['type'],
  handler: EventHandler<E>,
  opts?: { once?: boolean; capture?: boolean },
): void {
  const node = currentUnit();
  pushCleanup(node, node.on(type, handler as EventHandler, opts));
}

export function useContribute<T>(
  collection: CollectionToken<T>,
  value: T,
  priority = 0,
): void {
  const node = currentUnit();
  pushCleanup(node, node.contribute(collection, value, priority));
}

export function useCollection<T>(collection: CollectionToken<T>): ComputedRef<readonly T[]> {
  const node = currentUnit();
  return computed(() => node.fold(collection));
}

export interface ChildEntry {
  readonly key: string;
  readonly recipe: KernelRecipe;
  readonly props?: unknown;
}

interface ChildMount {
  recipe: KernelRecipe;
  props: unknown;
  handle: UnitHandle;
}

export function useChildren(source: MaybeRefOrGetter<Array<ChildEntry | null>>): void {
  const node = currentUnit();
  const mounts = new Map<string, ChildMount>();
  watchEffect(() => {
    const entries = toValue(source);
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry === null) {
        continue;
      }
      if (seen.has(entry.key)) {
        throw new Error(`duplicate child key '${entry.key}' in unit '${node.recipe.name}'`);
      }
      seen.add(entry.key);
      const existing = mounts.get(entry.key);
      if (existing !== undefined && existing.recipe !== entry.recipe) {
        void existing.handle.unmount();
        mounts.delete(entry.key);
      }
      const current = mounts.get(entry.key);
      if (current === undefined) {
        const handle = node.mount(entry.recipe, entry.props);
        mounts.set(entry.key, { recipe: entry.recipe, props: entry.props, handle });
      } else if (!Object.is(current.props, entry.props)) {
        current.props = entry.props;
        current.handle.update(entry.props);
      }
    }
    for (const [key, child] of Array.from(mounts)) {
      if (!seen.has(key)) {
        mounts.delete(key);
        void child.handle.unmount();
      }
    }
  });
}

export interface DurableManager {
  readonly sliceName: string;
  readonly entries: Map<string, ShallowRef<unknown>>;
  dispatch(patch: Record<string, unknown>): void;
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
  let unregister: (() => void) | undefined;
  let registered = false;
  let inFlight = 0;
  const pending: Record<string, unknown>[] = [];
  const resync = (): void => {
    if (!registered || inFlight > 0) {
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
  const trackedDispatch = (patch: Record<string, unknown>): void => {
    inFlight += 1;
    void backend
      .dispatch({ type: 'store.patched', store: sliceName, patch })
      .catch(report)
      .finally(() => {
        inFlight -= 1;
        resync();
      });
  };
  void backend
    .registerSlice({
      name: sliceName,
      initialState: () =>
        Object.fromEntries([...entries].map(([key, slot]) => [key, slot.value])),
      reducers: {
        'store.patched': (draft, event) => {
          if ((event as { store?: unknown }).store === sliceName) {
            Object.assign(draft, (event as { patch?: Record<string, unknown> }).patch);
          }
        },
      },
    })
    .then(async (dispose) => {
      unregister = dispose;
      for (const patch of pending.splice(0)) {
        inFlight += 1;
        await backend.dispatch({ type: 'store.patched', store: sliceName, patch }).catch(report);
        inFlight -= 1;
      }
      registered = true;
      resync();
    })
    .catch(report);
  const unsubscribe = backend.subscribe(() => resync());
  const manager: DurableManager = {
    sliceName,
    entries,
    dispatch: (patch) => {
      if (!registered) {
        pending.push(patch);
        return;
      }
      trackedDispatch(patch);
    },
  };
  node.internals.set('durables', manager);
  pushCleanup(node, () => {
    unsubscribe();
    unregister?.();
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
      manager.dispatch({ [key]: next });
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
