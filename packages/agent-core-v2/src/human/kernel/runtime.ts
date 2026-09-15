import { computed, effectScope, shallowReactive, shallowRef, toValue } from '@vue/reactivity';
import type { ComputedRef, EffectScope, MaybeRefOrGetter, ShallowRef } from '@vue/reactivity';

import { createToken, watchEffect, type CollectionToken, type Token } from './primitives';

export interface RuntimeEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type EventHandler<E extends RuntimeEvent = RuntimeEvent> = (event: E) => void;

export type Unsubscribe = () => void;

export const EventContext = createToken<Record<string, unknown>>('kernel.eventContext');

export const AgentScope = createToken<EffectScope>('kernel.agentScope');

export interface NodeRef {
  readonly name: string;
  readonly parent: NodeRef | null;
  mount(recipe: KernelRecipe, props?: unknown): UnitHandle;
  provide<T>(token: Token<T>, value: T): Unsubscribe;
  providerRef<T>(token: Token<T>): ShallowRef<readonly ProviderEntry<T>[]>;
  resolve<T>(token: Token<T>): T;
  contribute<T>(collection: CollectionToken<T>, value: T, priority: number): Unsubscribe;
  fold<T>(collection: CollectionToken<T>): readonly T[];
  fire(event: RuntimeEvent): void;
  on(type: string, handler: EventHandler, opts?: { once?: boolean; capture?: boolean }): Unsubscribe;
  unmount(): Promise<void>;
}

export interface UnitContext {
  readonly node: NodeRef;
  readonly name: string;
}

export type UnitSetup<P> = (props: P, ctx: UnitContext) => unknown;

export interface UnitRecipe<P = void> {
  readonly name: string;
  readonly setup: UnitSetup<P>;
}

export interface FaceEventMeta {
  readonly type: string;
  readonly payloadKey: string;
  readonly name: string;
}

export interface RecipeExtension {
  readonly faceEvent?: FaceEventMeta;
  readonly onMount?: (recipe: UnitRecipe<any>, node: UnitNode) => void;
}

export type KernelRecipe = UnitRecipe<any> & RecipeExtension;

export type UnitState = 'pending' | 'active' | 'failed' | 'unmounted';

export interface StackEntry {
  cleanup: () => void | Promise<void>;
}

export interface UnitHandle {
  readonly name: string;
  readonly state: UnitState;
  readonly node: NodeRef;
  update(props: unknown): void;
  unmount(): Promise<void>;
}

export interface ProviderEntry<T = unknown> {
  readonly value: T;
  readonly node: UnitNode;
}

interface ContributionEntry {
  value: unknown;
  priority: number;
  order: number;
}

interface HandlerEntry {
  handler: EventHandler;
  capture: boolean;
  once: boolean;
}

let contributionOrder = 0;

export class UnitNode implements NodeRef {
  readonly recipe: UnitRecipe<unknown>;
  parent: UnitNode | null;
  readonly children: UnitNode[] = [];
  readonly internals = new Map<string, unknown>();
  props: unknown;
  readonly propsRef: ShallowRef<unknown>;
  state: UnitState = 'pending';
  setupResult: unknown;
  readonly scope: EffectScope;
  readonly postSetup: Array<() => void> = [];
  stack: StackEntry[] = [];
  faceWatchers: Set<(face: unknown) => void> | undefined;
  private readonly provisions = new Map<Token<unknown>, ProviderEntry[]>();
  private directory: Map<Token<unknown>, ShallowRef<readonly ProviderEntry[]>> | undefined;
  private readonly contributions = shallowReactive(
    new Map<CollectionToken<unknown>, ContributionEntry[]>(),
  );
  private readonly handlers = new Map<string, HandlerEntry[]>();

  constructor(recipe: UnitRecipe<unknown>, props: unknown, parent: UnitNode | null) {
    this.recipe = recipe;
    this.props = props;
    this.propsRef = shallowRef(props);
    this.parent = parent;
    this.scope = effectScope();
    parent?.children.push(this);
  }

  get name(): string {
    return this.recipe.name;
  }

  mount(recipe: KernelRecipe, props?: unknown): UnitHandle {
    return mountChild(this, recipe, props);
  }

  provide<T>(token: Token<T>, value: T): Unsubscribe {
    const entry: ProviderEntry = { value, node: this };
    const key = token as Token<unknown>;
    const stack = this.provisions.get(key) ?? [];
    stack.push(entry);
    this.provisions.set(key, stack);
    const slot = this.directorySlot(key);
    slot.value = [...slot.value, entry];
    const withdraw = (): void => {
      const index = stack.indexOf(entry);
      if (index < 0) {
        return;
      }
      stack.splice(index, 1);
      slot.value = slot.value.filter((item) => item !== entry);
    };
    pushCleanup(this, withdraw);
    return withdraw;
  }

  providerRef<T>(token: Token<T>): ShallowRef<readonly ProviderEntry<T>[]> {
    return this.directorySlot(token as Token<unknown>) as ShallowRef<readonly ProviderEntry<T>[]>;
  }

  private directorySlot(token: Token<unknown>): ShallowRef<readonly ProviderEntry[]> {
    const root = [...lineage(this)].at(-1) as UnitNode;
    root.directory ??= new Map();
    let slot = root.directory.get(token);
    if (slot === undefined) {
      slot = shallowRef<readonly ProviderEntry[]>([]);
      root.directory.set(token, slot);
    }
    return slot;
  }

  resolve<T>(token: Token<T>): T {
    const found = this.resolveEntry(token as Token<unknown>);
    if (found === undefined) {
      throw new Error(`no provider for token '${token.key ?? 'unknown'}'`);
    }
    return found.entry.value as T;
  }

  resolveEntry(
    token: Token<unknown>,
  ): { entry: ProviderEntry; source: UnitNode } | undefined {
    for (const node of lineage(this)) {
      const stack = node.provisions.get(token);
      const entry = stack?.at(-1);
      if (entry !== undefined) {
        return { entry, source: node };
      }
    }
    return undefined;
  }

  contribute<T>(collection: CollectionToken<T>, value: T, priority: number): Unsubscribe {
    const entry: ContributionEntry = { value, priority, order: contributionOrder++ };
    const key = collection as CollectionToken<unknown>;
    let list = this.contributions.get(key);
    if (list === undefined) {
      list = shallowReactive<ContributionEntry[]>([]);
      this.contributions.set(key, list);
    }
    list.push(entry);
    return () => {
      const index = list.indexOf(entry);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }

  fold<T>(collection: CollectionToken<T>): readonly T[] {
    const entries: ContributionEntry[] = [];
    for (const unit of [...lineage(this)].toReversed()) {
      entries.push(...(unit.contributions.get(collection as CollectionToken<unknown>) ?? []));
    }
    entries.sort((a, b) => a.priority - b.priority || a.order - b.order);
    return entries.map((entry) => entry.value as T);
  }

  fire(event: RuntimeEvent): void {
    const path = [...lineage(this)];
    const inherited: Record<string, unknown> = {};
    for (let i = path.length - 1; i >= 0; i--) {
      const entries = (path[i] as UnitNode).provisions.get(EventContext as Token<unknown>);
      if (entries !== undefined) {
        for (const provided of entries) {
          Object.assign(inherited, provided.value);
        }
      }
    }
    const enriched = { ...inherited, ...event } as RuntimeEvent;
    for (let i = path.length - 1; i >= 0; i--) {
      (path[i] as UnitNode).dispatch(enriched, true);
    }
    for (const unit of path) {
      unit.dispatch(enriched, false);
    }
  }

  private dispatch(event: RuntimeEvent, capture: boolean): void {
    const lists = [this.handlers.get(event.type), this.handlers.get('*')];
    for (const list of lists) {
      if (list === undefined) {
        continue;
      }
      for (const entry of Array.from(list)) {
        if (entry.capture !== capture) {
          continue;
        }
        entry.handler(event);
        if (entry.once) {
          const index = list.indexOf(entry);
          if (index >= 0) {
            list.splice(index, 1);
          }
        }
      }
    }
  }

  on(type: string, handler: EventHandler, opts?: { once?: boolean; capture?: boolean }): Unsubscribe {
    const entry: HandlerEntry = {
      handler,
      capture: opts?.capture ?? false,
      once: opts?.once ?? false,
    };
    const list = this.handlers.get(type) ?? [];
    list.push(entry);
    this.handlers.set(type, list);
    return () => {
      const index = list.indexOf(entry);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }

  private unmountPromise: Promise<void> | undefined;

  unmount(): Promise<void> {
    this.unmountPromise ??= this.performUnmount();
    return this.unmountPromise;
  }

  private async performUnmount(): Promise<void> {
    this.state = 'unmounted';
    for (const child of this.children.toReversed()) {
      await child.unmount();
    }
    this.scope.stop();
    while (this.stack.length > 0) {
      const entry = this.stack.pop() as StackEntry;
      await entry.cleanup();
    }
    if (this.parent !== null) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) {
        this.parent.children.splice(index, 1);
      }
      this.parent = null;
    }
  }
}

function* lineage(start: UnitNode): Generator<UnitNode, void, unknown> {
  let node: UnitNode | null = start;
  while (node !== null) {
    yield node;
    node = node.parent;
  }
}

export function pushCleanup(
  node: UnitNode,
  cleanup: () => void | Promise<void>,
): StackEntry {
  const entry: StackEntry = { cleanup };
  node.stack.push(entry);
  return entry;
}

export function removeCleanup(node: UnitNode, entry: StackEntry): void {
  const index = node.stack.indexOf(entry);
  if (index >= 0) {
    node.stack.splice(index, 1);
  }
}

export function mountChild(
  parent: UnitNode,
  recipe: KernelRecipe,
  props?: unknown,
): UnitHandle {
  if (parent.state === 'unmounted') {
    throw new Error(`unit '${parent.recipe.name}' is unmounted`);
  }
  let child: UnitNode | undefined;
  parent.scope.run(() => {
    child = new UnitNode(recipe as unknown as UnitRecipe<unknown>, props, parent);
  });
  if (child === undefined) {
    throw new Error(`cannot mount child unit '${recipe.name}' into an inactive effect scope`);
  }
  try {
    runUnit(child);
  } catch (error) {
    const index = parent.children.indexOf(child);
    if (index >= 0) {
      parent.children.splice(index, 1);
    }
    void child.unmount();
    throw error;
  }
  recipe.onMount?.(recipe, child);
  return handleFor(child);
}

export interface MountRootOptions {
  readonly scope?: EffectScope;
}

export function mountRoot(
  recipe: KernelRecipe,
  props?: unknown,
  opts?: MountRootOptions,
): {
  node: UnitNode;
  handle: UnitHandle;
} {
  let node: UnitNode | undefined;
  const mount = (): void => {
    const created = new UnitNode(recipe as unknown as UnitRecipe<unknown>, props, null);
    try {
      runUnit(created);
    } catch (error) {
      void created.unmount();
      throw error;
    }
    node = created;
  };
  const external = opts?.scope;
  if (external === undefined) {
    mount();
  } else {
    external.run(mount);
  }
  if (node === undefined) {
    throw new Error(`cannot mount root unit '${recipe.name}' into an inactive effect scope`);
  }
  recipe.onMount?.(recipe, node);
  return { node, handle: handleFor(node) };
}

export function handleFor(node: UnitNode): UnitHandle {
  return {
    get name() {
      return node.recipe.name;
    },
    get state() {
      return node.state;
    },
    get node() {
      return node;
    },
    update(props: unknown) {
      if (node.state === 'unmounted' || node.state === 'failed') {
        return;
      }
      node.props = props;
      node.propsRef.value = props;
    },
    async unmount() {
      await node.unmount();
    },
  };
}

const unitStack: UnitNode[] = [];

export function currentUnit(): UnitNode {
  const node = unitStack.at(-1);
  if (node === undefined) {
    throw new Error('hook called outside of a unit setup');
  }
  return node;
}

export function hasCurrentUnit(): boolean {
  return unitStack.length > 0;
}

export function runUnit(node: UnitNode): void {
  if (node.state === 'unmounted' || node.state === 'failed') {
    return;
  }
  const ctx: UnitContext = { node, name: node.recipe.name };
  unitStack.push(node);
  let result: unknown;
  try {
    result = node.scope.run(() => node.recipe.setup(node.props, ctx));
  } catch (error) {
    node.state = 'failed';
    throw error;
  } finally {
    unitStack.pop();
  }
  node.setupResult = result;
  if (typeof result === 'function') {
    pushCleanup(node, result as () => void);
  }
  try {
    const queued = node.postSetup.splice(0);
    for (const fn of queued) {
      fn();
    }
  } catch (error) {
    node.state = 'failed';
    throw error;
  }
  if (node.state === 'pending') {
    node.state = 'active';
  }
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

export function createUnit<P = void>(name: string, setup: UnitSetup<P>): UnitRecipe<P> {
  return { name, setup };
}
