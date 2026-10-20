import { effectScope, onScopeDispose, pauseTracking, resetTracking, shallowReactive } from '@vue/reactivity';
import type { EffectScope } from '@vue/reactivity';

import { waitEvent, type WaitOpts } from '../utils/wait';

import { createCollection, type CertainToken, type CollectionToken, type FacadeToken, type Token } from './primitives';

export interface RuntimeEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface UnitErrorEvent extends RuntimeEvent {
  readonly type: 'unit.error';
  readonly unit: string;
  readonly error: unknown;
}

export type EventHandler<E extends RuntimeEvent = RuntimeEvent> = (event: E) => void;

export interface ListenOpts {
  readonly once?: boolean;
}

export const EventContext = createCollection<Record<string, unknown>>('kernel.eventContext');

export interface UnitContext {
  readonly name: string;
  readonly signal: AbortSignal;
}

export type UnitSetup<P> = (props: P, ctx: UnitContext) => void;

export interface UnitRecipe<P = void> {
  readonly name: string;
  readonly setup: UnitSetup<P>;
}

export type UnitState = 'mounting' | 'active' | 'disposing' | 'disposed';

export interface UnitHandle<P = void> {
  readonly name: string;
  readonly state: UnitState;
  resolve<T>(token: CertainToken<T>): T;
  resolve<T>(token: FacadeToken<T>): T | undefined;
  update(props: P): void;
  ready(): Promise<void>;
  unmount(): Promise<void>;
}

export interface MountRootOptions {
  readonly scope?: EffectScope;
}

interface Entry {
  readonly value: unknown;
  readonly priority: number;
}

interface Listener {
  readonly handler: EventHandler;
  readonly once: boolean;
  live: boolean;
}

interface Owned {
  readonly release: () => unknown;
}

function isProps(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || (typeof value === 'object' && value !== null);
}

export function* lineage(start: UnitNode): Generator<UnitNode, void, unknown> {
  let node: UnitNode | null = start;
  while (node !== null) {
    yield node;
    node = node.parent;
  }
}

const setups: UnitNode[] = [];

export function currentUnit(): UnitNode {
  const node = setups.at(-1);
  if (node === undefined) {
    throw new Error('hook called outside of a unit setup');
  }
  return node;
}

export function report(node: UnitNode, error: unknown): void {
  const event: UnitErrorEvent = { type: 'unit.error', unit: node.name, error };
  if (!node.deliver(event)) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

export class UnitNode {
  readonly recipe: UnitRecipe<any>;
  parent: UnitNode | null;
  readonly children: UnitNode[] = [];
  state: UnitState = 'mounting';
  reason: unknown;
  readonly props: Record<string, unknown>;
  readonly host: UnitNode;
  private readonly lifetime = new AbortController();
  readonly signal: AbortSignal = this.lifetime.signal;
  private readonly scope = effectScope(true);
  private readonly stack: Owned[] = [];
  private readonly registry = shallowReactive(new Map<object, Entry[]>());
  private readonly handlers = new Map<string, Listener[]>();
  private readonly commits: Array<() => void> = [];
  private readonly outbox: RuntimeEvent[] = [];
  private readonly exposures: Array<() => void> = [];
  private readonly pending = new Set<Promise<unknown>>();
  private readonly faults: unknown[] = [];
  private version = 0;
  private released: Promise<unknown[]> | undefined;
  private disposal: Promise<void> | undefined;

  constructor(recipe: UnitRecipe<any>, props: unknown, parent: UnitNode | null, attach = false) {
    if (!isProps(props)) {
      throw new TypeError(`props of unit '${recipe.name}' must be an object`);
    }
    this.recipe = recipe;
    this.props = shallowReactive({ ...props });
    this.parent = parent;
    this.host = attach && parent !== null ? parent.host : this;
    if (parent !== null) {
      parent.children.push(this);
      parent.bump();
    }
  }

  get name(): string {
    return this.recipe.name;
  }

  own(release: () => unknown): () => void {
    if (this.state === 'disposed') {
      throw new Error(`unit '${this.name}' is unmounted`);
    }
    const entry: Owned = { release };
    this.stack.push(entry);
    return () => {
      const index = this.stack.indexOf(entry);
      if (index < 0) {
        return;
      }
      this.stack.splice(index, 1);
      void entry.release();
    };
  }

  register(key: object, value: unknown, priority = 0): () => void {
    if (this.host !== this) return this.host.register(key, value, priority);
    const list = this.registry.get(key) ?? shallowReactive<Entry[]>([]);
    if (!this.registry.has(key)) {
      this.registry.set(key, list);
    }
    const entry: Entry = { value, priority };
    list.push(entry);
    return () => {
      const index = list.indexOf(entry);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }

  expose(token: Token<unknown>, value: unknown): void {
    const parent = this.parent;
    if (parent === null) {
      this.own(this.register(token, value));
      return;
    }
    this.commits.push(() => {
      this.exposures.push(this.own(parent.register(token, value)));
    });
  }

  afterMount(callback: () => void): void {
    if (this.state === 'mounting') this.commits.push(callback);
    else if (this.state === 'active') callback();
  }

  lookup(token: Token<unknown>): { value: unknown } | undefined {
    for (const unit of lineage(this)) {
      const entry = unit.registry.get(token)?.at(-1);
      if (entry !== undefined) {
        return { value: entry.value };
      }
    }
    return undefined;
  }

  resolve<T>(token: CertainToken<T>): T;
  resolve<T>(token: FacadeToken<T>): T | undefined;
  resolve<T>(token: Token<T>): T | undefined {
    const found = this.lookup(token as Token<unknown>);
    if (found !== undefined) {
      return found.value as T;
    }
    if (token.kind === 'facade') {
      return undefined;
    }
    throw new Error(`no provider for token '${token.key ?? 'unknown'}'`);
  }

  fold<T>(collection: CollectionToken<T>): readonly T[] {
    const entries: Entry[] = [];
    for (const unit of [...lineage(this)].toReversed()) {
      entries.push(...(unit.registry.get(collection) ?? []));
    }
    return entries.sort((a, b) => a.priority - b.priority).map((entry) => entry.value as T);
  }

  listen(type: string, handler: EventHandler, opts?: ListenOpts): () => void {
    if (this.host !== this) return this.host.listen(type, handler, opts);
    const list = this.handlers.get(type) ?? [];
    this.handlers.set(type, list);
    const listener: Listener = { handler, live: true, once: opts?.once ?? false };
    list.push(listener);
    return () => {
      listener.live = false;
      const index = list.indexOf(listener);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }

  fire(event: RuntimeEvent): void {
    if (this.state === 'mounting') {
      this.outbox.push(event);
      return;
    }
    this.deliver(event);
  }

  deliver(event: RuntimeEvent): boolean {
    const enriched = { ...Object.assign({}, ...this.fold(EventContext)), ...event } as RuntimeEvent;
    let handled = false;
    for (const unit of [...lineage(this)]) {
      if (unit.state !== 'active') {
        continue;
      }
      const lists = [unit.handlers.get(event.type), unit.handlers.get('*')];
      for (const list of lists) {
        if (list === undefined) {
          continue;
        }
        for (const listener of [...list]) {
          if (!listener.live || unit.state !== 'active') {
            continue;
          }
          handled = true;
          try {
            listener.handler(enriched);
          } catch (error) {
            if (event.type === 'unit.error') {
              queueMicrotask(() => {
                throw error;
              });
            } else {
              report(unit, error);
            }
          }
          if (listener.once) {
            listener.live = false;
            const index = list.indexOf(listener);
            if (index >= 0) {
              list.splice(index, 1);
            }
          }
        }
      }
    }
    return handled;
  }

  wait(type: string, opts?: WaitOpts<RuntimeEvent>): Promise<RuntimeEvent> {
    const signal = opts?.signal === undefined ? this.signal : AbortSignal.any([this.signal, opts.signal]);
    return waitEvent<RuntimeEvent>((handler) => this.listen(type, handler), { ...opts, signal }).catch(
      (error: unknown) => {
        if (this.signal.aborted) {
          throw new Error(`unit '${this.name}' is unmounted`);
        }
        throw error;
      },
    );
  }

  track(operation: Promise<unknown>): void {
    this.pending.add(operation);
    this.bump();
    const settle = (): void => {
      this.pending.delete(operation);
    };
    operation.then(settle, settle);
  }

  mount(recipe: UnitRecipe<any>, props: unknown, opts?: { readonly attach?: boolean }): UnitNode {
    if (this.state !== 'active') {
      throw new Error(`unit '${this.name}' is not active`);
    }
    const child = new UnitNode(recipe, props, this, opts?.attach === true);
    child.run();
    return child;
  }

  run(): void {
    let failure: { error: unknown } | undefined;
    setups.push(this);
    pauseTracking();
    try {
      const result: unknown = this.scope.run(() =>
        this.recipe.setup(this.props, { name: this.name, signal: this.signal }),
      );
      if (result !== undefined) {
        throw new TypeError(`setup of unit '${this.name}' must return undefined`);
      }
    } catch (error) {
      failure = { error };
    } finally {
      resetTracking();
      setups.pop();
    }
    if (failure !== undefined) {
      this.fail(failure.error);
      return;
    }
    if (this.state !== 'mounting') {
      return;
    }
    this.state = 'active';
    for (const commit of this.commits.splice(0)) {
      commit();
    }
    for (const event of this.outbox.splice(0)) {
      this.deliver(event);
    }
  }

  update(props: unknown): void {
    if (this.state !== 'active') {
      return;
    }
    if (!isProps(props)) {
      throw new TypeError(`props of unit '${this.name}' must be an object`);
    }
    const next = props ?? {};
    for (const key of Object.keys(this.props)) {
      if (!(key in next)) {
        delete this.props[key];
      }
    }
    Object.assign(this.props, next);
  }

  fail(reason: unknown): void {
    if (this.state !== 'mounting' && this.state !== 'active') {
      return;
    }
    this.reason = reason;
    const parent = this.parent;
    this.dispose().catch((error: unknown) => {
      report(parent ?? this, error);
    });
    if (parent !== null) {
      report(parent, reason);
    }
  }

  dispose(): Promise<void> {
    if (this.disposal === undefined) {
      if (this.state === 'mounting' || this.state === 'active') {
        this.freeze();
        for (const withdraw of this.exposures.splice(0)) {
          withdraw();
        }
      }
      this.disposal = this.releaseOnce().then((errors) => {
        if (errors.length > 0) {
          throw new AggregateError(errors, `failed to unmount '${this.name}'`);
        }
      });
    }
    return this.disposal;
  }

  async ready(): Promise<void> {
    for (;;) {
      if (this.state === 'disposing' || this.state === 'disposed') {
        await this.releaseOnce();
        throw this.reason ?? new Error(`unit '${this.name}' is unmounted`);
      }
      const version = this.version;
      await Promise.all([
        ...this.pending,
        ...this.children.map((child) => child.ready().catch(() => undefined)),
      ]);
      if (version === this.version && this.pending.size === 0) {
        return;
      }
    }
  }

  private bump(): void {
    for (const unit of lineage(this)) {
      unit.version += 1;
    }
  }

  private freeze(): void {
    const frozen: UnitNode[] = [];
    const visit = (node: UnitNode): void => {
      if (node.state === 'disposing' || node.state === 'disposed') {
        return;
      }
      node.state = 'disposing';
      frozen.push(node);
      node.children.forEach(visit);
    };
    visit(this);
    for (const node of frozen) {
      node.lifetime.abort();
      try {
        node.scope.stop();
      } catch (error) {
        node.faults.push(error);
      }
    }
  }

  private releaseOnce(): Promise<unknown[]> {
    this.released ??= this.release();
    return this.released;
  }

  private async release(): Promise<unknown[]> {
    const errors = this.faults;
    const nested = await Promise.all(this.children.map((child) => child.releaseOnce()));
    errors.push(...nested.flat());
    for (let entry = this.stack.pop(); entry !== undefined; entry = this.stack.pop()) {
      try {
        await entry.release();
      } catch (error) {
        errors.push(error);
      }
    }
    this.handlers.clear();
    const parent = this.parent;
    if (parent !== null) {
      const index = parent.children.indexOf(this);
      if (index >= 0) {
        parent.children.splice(index, 1);
      }
      parent.bump();
      this.parent = null;
    }
    this.state = 'disposed';
    return errors;
  }
}

function handleFor<P>(node: UnitNode): UnitHandle<P> {
  return {
    get name() {
      return node.name;
    },
    get state() {
      return node.state;
    },
    resolve: ((token: CertainToken<unknown> | FacadeToken<unknown>) =>
      token.kind === 'facade' ? node.resolve(token) : node.resolve(token)) as UnitHandle<P>['resolve'],
    update: (props) => {
      node.update(props);
    },
    ready: () => node.ready(),
    unmount: () => node.dispose(),
  };
}

export function mountRoot<P extends object | void = void>(
  recipe: UnitRecipe<P>,
  props?: P,
  opts?: MountRootOptions,
): UnitHandle<P> {
  const external = opts?.scope;
  if (external !== undefined && !external.active) {
    throw new Error(`cannot mount root unit '${recipe.name}' into an inactive effect scope`);
  }
  const node = new UnitNode(recipe, props, null);
  external?.run(() => {
    onScopeDispose(() => {
      if (node.state === 'mounting' || node.state === 'active') {
        node.dispose().catch((error: unknown) => {
          report(node, error);
        });
      }
    });
  });
  node.run();
  return handleFor<P>(node);
}

export function createUnit<P extends object | void = void>(name: string, setup: UnitSetup<P>): UnitRecipe<P> {
  return { name, setup };
}
