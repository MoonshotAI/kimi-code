import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from '@vue/reactivity';

import { watchEffect, type CollectionToken, type Token } from './primitives';
import {
  currentUnit,
  pushCleanup,
  type EventHandler,
  type KernelRecipe,
  type RuntimeEvent,
  type UnitHandle,
  type UnitNode,
} from './runtime';

export function useReady(operation: Promise<unknown>): void {
  const node = currentUnit();
  let cancel = (): void => {};
  const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
  node.signal.addEventListener('abort', cancel, { once: true });
  if (node.signal.aborted) cancel();
  node.trackReady(Promise.race([operation, cancelled]).finally(() => node.signal.removeEventListener('abort', cancel)));
}

export function provide<T>(token: Token<T>, value: T): void {
  currentUnit().provide(token, value);
}

export function useExpose<T>(token: Token<T>, value: T): void {
  const node = currentUnit();
  if (node.parent === null) {
    provide(token, value);
    return;
  }
  pushCleanup(node, node.parent.provide(token, value));
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

export function useChildren(source: MaybeRefOrGetter<Array<ChildEntry | null>>): { ready(): Promise<void> } {
  const node = currentUnit();
  const mounts = new Map<string, ChildMount>();
  let desired = new Map<string, ChildEntry>();
  let pending: Promise<void> | undefined;
  const reconcile = (): void => {
    if (node.state === 'unmounted' || pending !== undefined) return;
    const removals: Promise<void>[] = [];
    for (const [key, child] of mounts) {
      if (desired.get(key)?.recipe !== child.recipe) {
        mounts.delete(key);
        removals.push(child.handle.unmount());
      }
    }
    if (removals.length > 0) {
      pending = Promise.all(removals).then(() => {
        pending = undefined;
        reconcile();
      });
      node.trackReady(pending);
      return;
    }
    for (const entry of desired.values()) {
      const current = mounts.get(entry.key);
      if (current === undefined) {
        const handle = node.mount(entry.recipe, entry.props);
        mounts.set(entry.key, { recipe: entry.recipe, props: entry.props, handle });
      } else if (!Object.is(current.props, entry.props)) {
        current.props = entry.props;
        current.handle.update(entry.props);
      }
    }
  };
  watchEffect(() => {
    const next = new Map<string, ChildEntry>();
    for (const entry of toValue(source)) {
      if (entry === null) continue;
      if (next.has(entry.key)) throw new Error(`duplicate child key '${entry.key}' in unit '${node.recipe.name}'`);
      next.set(entry.key, entry);
    }
    desired = next;
    reconcile();
  });
  return {
    ready: async () => {
      for (;;) {
        if (node.state === 'unmounted') throw new Error(`unit '${node.name}' is unmounted`);
        await pending;
        const snapshot = [...mounts.values()];
        await Promise.all(snapshot.map((child) => child.handle.ready().catch(async (error: unknown) => {
          if (child.handle.state !== 'unmounted') throw error;
          await child.handle.unmount();
        })));
        if (pending === undefined && snapshot.length === mounts.size && snapshot.every((child) => [...mounts.values()].includes(child))) return;
      }
    },
  };
}
