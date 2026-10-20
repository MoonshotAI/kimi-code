import { computed, toValue, watch, type ComputedRef, type MaybeRefOrGetter } from '@vue/reactivity';

import type { WaitOpts } from '../utils/wait';

import type { CertainToken, CollectionToken, FacadeToken, ShallowRef, Token } from './primitives';
import {
  currentUnit,
  report,
  type EventHandler,
  type ListenOpts,
  type RuntimeEvent,
  type UnitNode,
  type UnitRecipe,
} from './runtime';

export function useReady(operation: Promise<unknown>): void {
  const node = currentUnit();
  node.track(
    new Promise<void>((resolve) => {
      node.signal.addEventListener('abort', () => resolve(), { once: true });
      operation.then(
        () => resolve(),
        (error: unknown) => {
          if (!node.signal.aborted) {
            node.fail(error);
          }
          resolve();
        },
      );
    }),
  );
}

export function provide<T>(token: Token<T>, value: T): void {
  const node = currentUnit();
  node.own(node.register(token, value));
}

export function useExpose<T>(token: FacadeToken<T>, value: T): void {
  if (token.kind !== 'facade') {
    throw new Error(`useExpose requires a facade token ('${token.key ?? 'unknown'}')`);
  }
  currentUnit().expose(token, value);
}

export function useInject<T>(token: CertainToken<T>): T;
export function useInject<T>(token: FacadeToken<T>): Readonly<ShallowRef<T | undefined>>;
export function useInject<T>(
  token: CertainToken<T> | FacadeToken<T>,
): T | Readonly<ShallowRef<T | undefined>> {
  const node = currentUnit();
  if (token.kind === 'certain') {
    return node.resolve(token);
  }
  return computed(() => node.lookup(token)?.value as T | undefined);
}

export function useMounted(callback: () => void): void {
  const node = currentUnit();
  node.afterMount(() => {
    try {
      callback();
    } catch (error) {
      node.fail(error);
    }
  });
}

export function useCleanup(cleanup: () => void | Promise<void>): void {
  currentUnit().own(cleanup);
}

export function useFire(): (event: RuntimeEvent) => void {
  const node = currentUnit();
  return (event) => {
    node.fire(event);
  };
}

export function useOn<E extends RuntimeEvent>(
  type: E['type'] | '*',
  handler: EventHandler<E>,
  opts?: ListenOpts,
): void {
  const node = currentUnit();
  node.own(node.listen(type, handler as EventHandler, opts));
}

export function useWait<E extends RuntimeEvent>(type: E['type'] | '*', opts?: WaitOpts<E>): Promise<E> {
  return currentUnit().wait(type, opts as WaitOpts<RuntimeEvent>) as Promise<E>;
}

export function useContribute<T>(collection: CollectionToken<T>, value: T, priority = 0): void {
  const node = currentUnit();
  node.own(node.register(collection, value, priority));
}

export function useCollection<T>(collection: CollectionToken<T>): ComputedRef<readonly T[]> {
  const node = currentUnit();
  return computed(() => node.fold(collection));
}

export interface ChildEntry {
  readonly key: string;
  readonly recipe: UnitRecipe<any>;
  readonly props?: unknown;
}

interface Slot {
  recipe?: UnitRecipe<any>;
  props?: unknown;
  child?: UnitNode;
  queued: boolean;
  chain: Promise<void>;
}

export function useChildren(source: MaybeRefOrGetter<ReadonlyArray<ChildEntry | null>>): void {
  const node = currentUnit();
  const slots = new Map<string, Slot>();
  let entries: ReadonlyArray<ChildEntry | null> = [];
  let desired = new Map<string, ChildEntry>();
  let scheduled = false;

  const apply = async (key: string, slot: Slot): Promise<void> => {
    slot.queued = false;
    if (node.state !== 'active') {
      return;
    }
    const entry = desired.get(key);
    const child = slot.child;
    if (child !== undefined && entry?.recipe === slot.recipe) {
      if (Object.is(entry?.props, slot.props)) {
        return;
      }
      if (child.state === 'active') {
        slot.props = entry?.props;
        child.update(entry?.props);
        return;
      }
    }
    if (child !== undefined) {
      slot.child = undefined;
      const initiated = child.state === 'active';
      await child.dispose().catch((error: unknown) => {
        if (initiated) {
          report(node, error);
        }
      });
      if (node.state !== 'active') {
        return;
      }
    }
    const next = desired.get(key);
    if (next === undefined) {
      if (!slot.queued) {
        slots.delete(key);
      }
      return;
    }
    slot.recipe = next.recipe;
    slot.props = next.props;
    slot.child = node.mount(next.recipe, next.props);
  };

  const flush = (): void => {
    scheduled = false;
    if (node.state !== 'active') {
      return;
    }
    const next = new Map<string, ChildEntry>();
    for (const entry of entries) {
      if (entry === null) {
        continue;
      }
      if (next.has(entry.key)) {
        report(node, new Error(`duplicate child key '${entry.key}' in unit '${node.name}'`));
        return;
      }
      next.set(entry.key, entry);
    }
    desired = next;
    for (const key of new Set([...slots.keys(), ...desired.keys()])) {
      const slot = slots.get(key) ?? { queued: false, chain: Promise.resolve() };
      slots.set(key, slot);
      if (slot.queued) {
        continue;
      }
      slot.queued = true;
      slot.chain = slot.chain
        .then(() => apply(key, slot))
        .catch((error: unknown) => {
          report(node, error);
        });
      node.track(slot.chain);
    }
  };

  watch(
    () => [...toValue(source)],
    (next) => {
      entries = next;
      if (!scheduled) {
        scheduled = true;
        node.track(Promise.resolve().then(flush));
      }
    },
    { immediate: true },
  );
}
