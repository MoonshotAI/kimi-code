/**
 * Runtime container for the DI subsystem. See `./README.md` for usage.
 * Modelled after VSCode's `InstantiationService`.
 *
 * History:
 * - W2.2: basic single-level container.
 * - W2.3: `createChild` scopes + `dispose` lifecycle.
 * - W2.4: cyclic dependency detection across the parent chain
 *         (linear `_inProgress` tree-stack).
 * - P0.2: `Trace` class + `_enableTracing` flag installed (not yet wired).
 * - P0.5: `IInstantiationService` self-registers in every container.
 * - P1.1: `_util.getServiceDependencies` is now consumed — `@IFoo`-decorated
 *         constructor parameters auto-inject from the container; Graph-based
 *         dependency-subtree resolution catches cycles that the linear
 *         `_inProgress` stack would miss (e.g. detected statically before
 *         any ctor body runs). Both defensive layers are preserved per
 *         PLAN D3: `_inProgress` still catches ctor-body re-entry where a
 *         ctor synchronously calls `accessor.get(self)`. LIFO dispose order
 *         via `_constructionOrder` is preserved per PLAN D8.
 * - P1.2: `SyncDescriptor.supportsDelayedInstantiation === true` now returns
 *         a `Proxy` that defers real construction until the first non-event
 *         property access. `onDid*`/`onWill*` subscriptions made BEFORE
 *         materialisation are parked in a `LinkedList` and rebound to the
 *         real event when the proxy resolves. Proxy-materialised instances
 *         join `_servicesToMaybeDispose` so dispose() tears them down in
 *         addition to the eager `_constructionOrder` set.
 */

import { SyncDescriptor } from './descriptors';
import { CyclicDependencyError } from './errors';
import { Graph } from './graph';
import {
  IInstantiationService as IInstantiationServiceDecorator,
  _util,
  type IInstantiationService,
  type ServiceCollectionLike,
  type ServiceIdentifier,
  type ServicesAccessor,
} from './instantiation';
import type { IDisposable } from './lifecycle';
import { ServiceCollection } from './serviceCollection';
import { GlobalIdleValue } from './util/idleValue';
import { LinkedList } from './util/linkedList';

// #region -- tracing ---
//
// `Trace` is vendored verbatim from krow
// `packages/core/src/platform/instantiation/instantiationService.ts:7-83`
// (which in turn is the VSCode original). P1.1 wires the call sites:
// `invokeFunction` opens an Invocation trace; `createInstance` opens a
// Creation trace; `_safeCreateAndCacheServiceInstance` opens a Creation
// trace per-service; and `_getOrCreateServiceInstance` calls
// `_trace.branch(id, first)` to record dependency edges. The `_enableTracing`
// flag remains opt-in; when false, every call returns `Trace._None` which
// is a no-op sentinel — zero overhead in the default path.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const enum TraceType {
  None = 0,
  Creation = 1,
  Invocation = 2,
  Branch = 3,
}

export class Trace {

  static readonly all = new Set<string>();

  private static readonly _None = new class extends Trace {
    constructor() { super(TraceType.None, null); }
    override stop() { }
    override branch() { return this; }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static traceInvocation(_enableTracing: boolean, fn: any): Trace {
    return !_enableTracing ? Trace._None : new Trace(TraceType.Invocation, fn.name || new Error().stack!.split('\n').slice(3, 4).join('\n'));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static traceCreation(_enableTracing: boolean, ctor: any): Trace {
    return !_enableTracing ? Trace._None : new Trace(TraceType.Creation, ctor.name);
  }

  private static _totals: number = 0;
  private readonly _start: number = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _dep: [ServiceIdentifier<any>, boolean, Trace?][] = [];

  private constructor(
    readonly type: TraceType,
    readonly name: string | null
  ) { }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  branch(id: ServiceIdentifier<any>, first: boolean): Trace {
    const child = new Trace(TraceType.Branch, id.toString());
    this._dep.push([id, first, child]);
    return child;
  }

  stop() {
    const dur = Date.now() - this._start;
    Trace._totals += dur;

    let causedCreation = false;

    function printChild(n: number, trace: Trace) {
      const res: string[] = [];
      const prefix = new Array(n + 1).join('\t');
      for (const [id, first, child] of trace._dep) {
        if (first && child) {
          causedCreation = true;
          res.push(`${prefix}CREATES -> ${id}`);
          const nested = printChild(n + 1, child);
          if (nested) {
            res.push(nested);
          }
        } else {
          res.push(`${prefix}uses -> ${id}`);
        }
      }
      return res.join('\n');
    }

    const lines = [
      `${this.type === TraceType.Creation ? 'CREATE' : 'CALL'} ${this.name}`,
      `${printChild(1, this)}`,
      `DONE, took ${dur.toFixed(2)}ms (grand total ${Trace._totals.toFixed(2)}ms)`
    ];

    if (dur > 2 || causedCreation) {
      Trace.all.add(lines.join('\n'));
    }
  }
}

// #endregion

export class InstantiationService implements IInstantiationService {
  /** Phantom brand so the class satisfies the `IInstantiationService` interface. */
  declare readonly _serviceBrand: undefined;

  /** Parent container in the scope chain (root container has no parent). */
  protected readonly _parent: InstantiationService | null;

  /**
   * Cached instances per identifier. First `get(id)` constructs and caches;
   * subsequent calls return the same reference (singleton-per-container).
   *
   * Note: as of P1.1 the "constructed instance" for a registration lives
   * inside `services` itself (the SyncDescriptor entry is replaced with the
   * built instance once construction completes) — this is the krow shape.
   * `_instances` is kept as a lookup fast path AND remains the source of
   * truth for the LIFO `_constructionOrder` (PLAN D8); `_setCreatedServiceInstance`
   * writes BOTH so dispose() can walk the construction order without
   * re-querying `services`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly _instances = new Map<ServiceIdentifier<any>, any>();

  /**
   * Order in which identifiers were first constructed in this container.
   * Used to teardown in reverse order on `dispose`. Preserved per PLAN D8.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly _constructionOrder: ServiceIdentifier<any>[] = [];

  /** Live children created via `createChild`. Disposed transitively. */
  protected readonly _children = new Set<InstantiationService>();

  /**
   * Per-tree construction stack (only mutated/read on the ROOT container of
   * the tree). Tracks ids currently mid-construction across the entire
   * parent/child tree, so a cycle expressed via a ctor body that calls
   * `accessor.get(peer)` synchronously is still caught — even if the Graph
   * walk in `_createAndCacheServiceInstance` could not have predicted the
   * edge from static `@IFoo` metadata alone.
   *
   * Order matters: array (not Set) so the `path` reported by
   * `CyclicDependencyError` reflects the actual construction sequence.
   *
   * Preserved per PLAN D3 as the second defensive layer; the primary check
   * is now the Graph walk in `_createAndCacheServiceInstance`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _inProgress: ServiceIdentifier<any>[] = [];

  /**
   * Per-container guard: catches the case where a `SyncDescriptor` ctor
   * synchronously triggers re-construction of the SAME id (e.g. a service
   * whose @IFoo dependency loops back to itself transitively through the
   * Graph). Throws an illegal-state error rather than a CyclicDependencyError
   * because this represents an internal invariant violation — the Graph walk
   * should have caught the cycle first.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _activeInstantiations = new Set<ServiceIdentifier<any>>();

  /**
   * Instances materialised via the delayed-instantiation Proxy path. The
   * Proxy itself is what callers see (and what was placed into the owning
   * container by `_setCreatedServiceInstance`), but the underlying real
   * instance lives behind `idle.value` and is not part of
   * `_constructionOrder`. We add it here so `dispose()` can still tear it
   * down — see `dispose()` for the LIFO-first / set-second order (PLAN D8
   * preserves the kimi LIFO order; krow ONLY has this set).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _servicesToMaybeDispose = new Set<any>();

  private _disposed = false;

  constructor(
    public readonly services: ServiceCollection = new ServiceCollection(),
    parent: InstantiationService | null = null,
    protected readonly _enableTracing: boolean = false,
  ) {
    this._parent = parent;
    // Self-register so `@IInstantiationService`-decorated ctor params resolve
    // to the live container that constructed them (krow / VSCode parity:
    // `instantiationService.ts:110`). Each container — root and every child
    // — stamps its OWN slot, so `child.invokeFunction(a => a.get(I)) === child`
    // even when the parent already registered itself. The Graph rewrite
    // preserves this invariant per Phase-0 reviewer note #4: the
    // self-registration lives in the local `services` map, so
    // `_getServiceInstanceOrDescriptor(IInstantiationService)` in the child
    // finds the child's own slot before walking to the parent.
    this.services.set(IInstantiationServiceDecorator, this);
  }

  invokeFunction<R>(fn: (accessor: ServicesAccessor) => R): R {
    this._assertNotDisposed();
    const _trace = Trace.traceInvocation(this._enableTracing, fn);
    try {
      const accessor: ServicesAccessor = {
        get: <T>(id: ServiceIdentifier<T>): T => this._getOrCreateServiceInstance(id, _trace),
      };
      return fn(accessor);
    } finally {
      _trace.stop();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createInstance<T>(descriptor: SyncDescriptor<T>, ...rest: any[]): T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createInstance<T>(ctor: new (...args: any[]) => T, ...rest: any[]): T;
  // Implementation. Two-way overload: either a `SyncDescriptor` packaging
  // ctor + static args (rest is appended after the static args) or a bare
  // `ctor` plus rest args. Constructor-arg `@IFoo` injection is now live —
  // any service-decorated trailing parameters are auto-resolved from the
  // container via `_util.getServiceDependencies`.
  createInstance<T>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctorOrDescriptor: SyncDescriptor<T> | (new (...args: any[]) => T),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...rest: any[]
  ): T {
    this._assertNotDisposed();
    let _trace: Trace;
    let result: T;
    if (ctorOrDescriptor instanceof SyncDescriptor) {
      _trace = Trace.traceCreation(this._enableTracing, ctorOrDescriptor.ctor);
      result = this._createInstance(
        ctorOrDescriptor.ctor,
        ctorOrDescriptor.staticArguments.concat(rest),
        _trace,
      );
    } else {
      _trace = Trace.traceCreation(this._enableTracing, ctorOrDescriptor);
      result = this._createInstance(ctorOrDescriptor, rest, _trace);
    }
    _trace.stop();
    return result;
  }

  /**
   * Create a scoped child container. The child sees parent registrations
   * transparently; if the child has its own registration for an id, it
   * shadows the parent for resolution. Construction always happens in the
   * owning container, so both child-as-seen-from-parent and parent-as-seen-
   * from-child have a single source of truth.
   *
   * Tracing flag is inherited from the parent so a deep child can't
   * accidentally suppress tracing the parent enabled.
   */
  createChild(services: ServiceCollectionLike): IInstantiationService {
    this._assertNotDisposed();
    // Defensive: only accept real ServiceCollection instances. The
    // `ServiceCollectionLike` alias exists for the interface surface to avoid
    // a circular type import, but at runtime the child needs a real Map.
    if (!(services instanceof ServiceCollection)) {
      throw new TypeError(
        'createChild requires a ServiceCollection instance (got something else)',
      );
    }
    const child = new InstantiationService(services, this, this._enableTracing);
    this._children.add(child);
    return child;
  }

  /**
   * Tear down this container and all children. Disposes any cached instance
   * with a `dispose()` method, in REVERSE construction order (PLAN D8).
   * Idempotent: a second call is a no-op. Also notifies parent if any (so
   * parent can drop its back-reference) and disposes children transitively.
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    // 1) Dispose children first (depth-first). Iterating a Set we mutate is
    //    unsafe; snapshot then iterate.
    const childSnapshot = Array.from(this._children);
    this._children.clear();
    for (const child of childSnapshot) {
      try {
        child.dispose();
      } catch {
        // Continue tearing down siblings even if one throws.
      }
    }

    // 2) Dispose own instances in reverse construction order, duck-typed
    //    against the `IDisposable` shape.
    for (let i = this._constructionOrder.length - 1; i >= 0; i--) {
      const id = this._constructionOrder[i]!;
      const instance = this._instances.get(id);
      if (instance && typeof (instance as Partial<IDisposable>).dispose === 'function') {
        try {
          (instance as IDisposable).dispose();
        } catch {
          // Swallow: a single failed teardown shouldn't strand siblings.
        }
        this._servicesToMaybeDispose.delete(instance);
      }
    }
    this._instances.clear();
    this._constructionOrder.length = 0;

    // 3) Dispose any Proxy-materialised instances that were NOT seen by the
    //    LIFO `_constructionOrder` loop (P1.2). Eager services are written
    //    to `_constructionOrder` via `_setCreatedServiceInstance` and are
    //    therefore covered above; the lazy Proxy path adds the real instance
    //    to `_servicesToMaybeDispose` from inside the `GlobalIdleValue`
    //    executor, but the Proxy itself doesn't carry a `dispose` method —
    //    so this set is the only handle to the underlying instance. Order
    //    among Proxy-materialised instances is insertion order; the LIFO
    //    invariant is intentionally not extended here (PLAN D8 ties LIFO to
    //    `_constructionOrder`, which only tracks eager construction).
    for (const candidate of this._servicesToMaybeDispose) {
      if (candidate && typeof (candidate as Partial<IDisposable>).dispose === 'function') {
        try {
          (candidate as IDisposable).dispose();
        } catch {
          // Swallow: dispose() must be forgiving.
        }
      }
    }
    this._servicesToMaybeDispose.clear();

    // 3) Drop our back-reference from parent so parent doesn't double-dispose
    //    us later.
    if (this._parent) {
      this._parent._children.delete(this);
    }
  }

  /**
   * Build an instance of `ctor`, auto-injecting any `@IFoo`-decorated
   * trailing parameters from the container. Static args (the caller-supplied
   * prefix) come first; service args come after, sorted by their decorator
   * position. Mirrors krow `instantiationService.ts:194-218`.
   *
   * If the caller passed fewer (or more) static args than the position of
   * the first service-decorated parameter, we log a `console.trace` warning
   * and pad / truncate so the constructor signature still lines up — same
   * behavior as krow / VSCode.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _createInstance<T>(ctor: any, args: unknown[], _trace: Trace): T {
    const serviceDependencies = _util.getServiceDependencies(ctor).sort((a, b) => a.index - b.index);
    const serviceArgs: unknown[] = [];
    for (const dependency of serviceDependencies) {
      const service = this._getOrCreateServiceInstance(dependency.id, _trace);
      serviceArgs.push(service);
    }

    const firstServiceArgPos =
      serviceDependencies.length > 0 ? serviceDependencies[0]!.index : args.length;

    if (args.length !== firstServiceArgPos) {
      // eslint-disable-next-line no-console
      globalThis.console.trace(
        `[createInstance] First service dependency of ${(ctor as { name?: string }).name} at position ${firstServiceArgPos + 1} conflicts with ${args.length} static arguments`,
      );
      const delta = firstServiceArgPos - args.length;
      if (delta > 0) {
        args = args.concat(new Array(delta));
      } else {
        args = args.slice(0, firstServiceArgPos);
      }
    }

    return Reflect.construct<unknown[], T>(ctor, args.concat(serviceArgs));
  }

  /**
   * Resolve an identifier in the current container, walking up the parent
   * chain if not registered locally. Construction happens in the OWNING
   * container so its cache holds the singleton.
   *
   * P1.1 makes this a thin router that delegates to the Graph-based
   * `_safeCreateAndCacheServiceInstance` whenever the resolved entry is a
   * `SyncDescriptor`. The Graph walk is the PRIMARY cycle-detection path —
   * it builds the entire dependency subtree before constructing anything,
   * so cycles expressed via `@IFoo` decorator metadata are caught
   * statically (no ctor body need run).
   *
   * The legacy linear `_inProgress` stack (mutated below) is preserved as
   * the SECONDARY defensive layer per PLAN D3: it catches the case where a
   * ctor body synchronously calls `accessor.get(peer)` — a ctor-time
   * dynamic edge that the Graph walk cannot predict.
   */
  protected _getOrCreateServiceInstance<T>(id: ServiceIdentifier<T>, _trace: Trace): T {
    const cached = this._instances.get(id);
    if (cached !== undefined) {
      _trace.branch(id, false);
      return cached as T;
    }

    const entry = this._getServiceInstanceOrDescriptor(id);
    if (entry === undefined) {
      throw new Error(`No service registered for identifier '${String(id)}'`);
    }

    if (entry instanceof SyncDescriptor) {
      // Linear tree-wide cycle check (PLAN D3, second defensive layer):
      // a ctor body calling `accessor.get(peer)` synchronously will reach
      // here while `peer` is mid-construction. The Graph walk inside
      // `_createAndCacheServiceInstance` cannot predict ctor-body edges
      // since they aren't expressed via `@IFoo` metadata; this stack catches
      // them. Mutated only on the ROOT container so cycles across
      // parent/child boundaries (parent A→B, child B→A) are still caught.
      const root = this._root();
      if (root._inProgress.includes(id)) {
        const path = [...root._inProgress, id].map((x) => String(x));
        throw new CyclicDependencyError(path);
      }

      // The descriptor lives somewhere in this container or an ancestor;
      // construct via the owner so the cache is on the owning container.
      // `_safeCreateAndCacheServiceInstance` is invoked on THIS container —
      // the Graph walk then uses `_getServiceInstanceOrDescriptor` (which
      // walks parents) to find each transitive dependency's owner, and
      // `_setCreatedServiceInstance` deposits the built instance into the
      // owning container. This preserves the self-register invariant:
      // `IInstantiationService` resolves locally before the parent walk
      // begins.
      return this._safeCreateAndCacheServiceInstance(id, entry, _trace.branch(id, true));
    }
    // Pre-built instance shorthand — cache locally and return.
    _trace.branch(id, false);
    this._setCreatedServiceInstance(id, entry as T);
    return entry as T;
  }

  /**
   * Per-container guard against same-id recursive construction (e.g. a ctor
   * that synchronously triggers construction of its own id). Wraps
   * `_createAndCacheServiceInstance` with try/finally so the guard always
   * clears. Mirrors krow `instantiationService.ts:254-264`.
   */
  private _safeCreateAndCacheServiceInstance<T>(
    id: ServiceIdentifier<T>,
    desc: SyncDescriptor<T>,
    _trace: Trace,
  ): T {
    if (this._activeInstantiations.has(id)) {
      throw new Error(`illegal state - RECURSIVELY instantiating service '${String(id)}'`);
    }
    this._activeInstantiations.add(id);
    try {
      return this._createAndCacheServiceInstance(id, desc, _trace);
    } finally {
      this._activeInstantiations.delete(id);
    }
  }

  /**
   * Build the full dependency subtree rooted at `(id, desc)` as a
   * `Graph<{id, desc, _trace}>`, then repeatedly consume `graph.roots()`
   * (leaves first) so each node is constructed AFTER all of its dependencies
   * are cached. If `graph.roots()` becomes empty while the graph is
   * non-empty, a cycle exists — throw `CyclicDependencyError(graph)`. The
   * legacy `_inProgress` stack also catches ctor-body-induced cycles
   * directly inside `_getOrCreateServiceInstance` below; both layers are
   * preserved per PLAN D3.
   *
   * Mirrors krow `instantiationService.ts:266-323`.
   */
  private _createAndCacheServiceInstance<T>(
    id: ServiceIdentifier<T>,
    desc: SyncDescriptor<T>,
    _trace: Trace,
  ): T {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Triple = { id: ServiceIdentifier<any>; desc: SyncDescriptor<any>; _trace: Trace };
    const graph = new Graph<Triple>(data => data.id.toString());

    let cycleCount = 0;
    const stack: Triple[] = [{ id, desc, _trace }];
    const seen = new Set<string>();
    while (stack.length) {
      const item = stack.pop()!;

      if (seen.has(String(item.id))) {
        continue;
      }
      seen.add(String(item.id));

      graph.lookupOrInsertNode(item);

      if (cycleCount++ > 1000) {
        throw new CyclicDependencyError(graph);
      }

      for (const dependency of _util.getServiceDependencies(item.desc.ctor)) {
        const instanceOrDesc = this._getServiceInstanceOrDescriptor(dependency.id);
        if (instanceOrDesc === undefined) {
          // Mirror krow: warn but don't throw — the constructor will get
          // `undefined` for that arg and either crash with a more useful
          // message or work if the dependency is optional.
          // eslint-disable-next-line no-console
          globalThis.console.warn(
            `[createInstance] ${String(item.id)} depends on ${String(dependency.id)} which is NOT registered.`,
          );
        }

        if (instanceOrDesc instanceof SyncDescriptor) {
          const d: Triple = {
            id: dependency.id,
            desc: instanceOrDesc,
            _trace: item._trace.branch(dependency.id, true),
          };
          graph.insertEdge(item, d);
          stack.push(d);
        }
      }
    }

    while (true) {
      const roots = graph.roots();

      if (roots.length === 0) {
        if (!graph.isEmpty()) {
          throw new CyclicDependencyError(graph);
        }
        break;
      }

      for (const { data } of roots) {
        // Re-check on each iteration: an earlier root in THIS round may have
        // satisfied the descriptor for this id (multiple nodes can share an
        // identifier across nested subgraphs).
        const instanceOrDesc = this._getServiceInstanceOrDescriptor(data.id);
        if (instanceOrDesc instanceof SyncDescriptor) {
          const lazy = data.desc.supportsDelayedInstantiation;
          const instance = this._createServiceInstance(
            data.id,
            data.desc,
            lazy,
            data._trace,
          );
          // For lazy services, the returned value is a Proxy; the real
          // instance lands in `_servicesToMaybeDispose` only after
          // materialisation. We deposit the Proxy without touching
          // `_constructionOrder` so dispose() does not accidentally trigger
          // materialisation just to call a non-existent `.dispose()`.
          this._setCreatedServiceInstance(data.id, instance, lazy);
        }
        graph.removeNode(data);
      }
    }
    return this._getServiceInstanceOrDescriptor(id) as T;
  }

  /**
   * Construct a service instance — either eagerly (the default) or wrapped
   * in a `Proxy` that defers real construction until the first non-event
   * property access (P1.2).
   *
   * Eager path: pushes `id` onto the root-tree `_inProgress` stack so a ctor
   * body calling `accessor.get(self)` synchronously is caught by
   * `_getOrCreateServiceInstance` as a cycle (PLAN D3 second defensive
   * layer). Returns the real instance immediately; the caller writes it
   * into the owning container via `_setCreatedServiceInstance` which also
   * stamps `_constructionOrder` for LIFO dispose (PLAN D8).
   *
   * Lazy path (`supportsDelayedInstantiation: true`): returns a `Proxy`
   * over `Object.create(null)` whose `get` trap:
   *   - For `onDid*` / `onWill*` string keys accessed BEFORE materialisation,
   *     returns a wrapped `Event` function that parks the listener into a
   *     `LinkedList<EarlyListenerData>` keyed by the event name. When the
   *     real instance materialises, every parked listener is replayed by
   *     calling the real `event(callback, thisArg, disposables)`.
   *   - For any other key, reads `idle.value` (constructs the real
   *     instance), caches function references on the proxy target so
   *     repeat reads short-circuit, and returns the value.
   *   - `getPrototypeOf` returns `ctor.prototype` so `instanceof Ctor`
   *     works against the Proxy.
   *
   * The real instance is added to `_servicesToMaybeDispose` inside the
   * `GlobalIdleValue` executor so `dispose()` can tear it down (lazy
   * instances do not appear in `_constructionOrder`).
   *
   * Mirrors krow `instantiationService.ts:335-421`.
   */
  private _createServiceInstance<T>(
    id: ServiceIdentifier<T>,
    desc: SyncDescriptor<T>,
    supportsDelayedInstantiation: boolean,
    _trace: Trace,
  ): T {
    if (!supportsDelayedInstantiation) {
      const root = this._root();
      root._inProgress.push(id);
      try {
        return this._createInstance<T>(desc.ctor, desc.staticArguments.slice(), _trace);
      } finally {
        const popIdx = root._inProgress.lastIndexOf(id);
        if (popIdx >= 0) {
          root._inProgress.splice(popIdx, 1);
        }
      }
    }

    // Delayed instantiation: build a Proxy backed by a GlobalIdleValue.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type EventLike = (callback: (e: any) => void, thisArg?: unknown, disposables?: IDisposable[]) => IDisposable;
    type EarlyListenerData = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listener: Parameters<EventLike>;
      disposable?: IDisposable;
    };
    const earlyListeners = new Map<string, LinkedList<EarlyListenerData>>();
    const _ctor = desc.ctor;
    const _args = desc.staticArguments.slice();
    // Capture references the executor needs.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const idle = new GlobalIdleValue<T>(() => {
      const root = self._root();
      root._inProgress.push(id);
      let result: T;
      try {
        result = self._createInstance<T>(_ctor, _args.slice(), _trace);
      } finally {
        const popIdx = root._inProgress.lastIndexOf(id);
        if (popIdx >= 0) {
          root._inProgress.splice(popIdx, 1);
        }
      }
      // Replay parked event subscriptions against the real instance.
      for (const [key, values] of earlyListeners) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const candidate = (result as any)[key] as EventLike | undefined;
        if (typeof candidate === 'function') {
          for (const value of values) {
            value.disposable = candidate.apply(result, value.listener);
          }
        }
      }
      earlyListeners.clear();
      self._servicesToMaybeDispose.add(result);
      return result;
    });

    return new Proxy(Object.create(null), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get(target: any, key: PropertyKey): unknown {
        if (!idle.isInitialized) {
          // Event-shape keys: park the subscription until the real instance
          // materialises (e.g. via a non-event get).
          if (
            typeof key === 'string' &&
            (key.startsWith('onDid') || key.startsWith('onWill'))
          ) {
            let list = earlyListeners.get(key);
            if (!list) {
              list = new LinkedList<EarlyListenerData>();
              earlyListeners.set(key, list);
            }
            const event: EventLike = (callback, thisArg, disposables) => {
              if (idle.isInitialized) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (idle.value as any)[key](callback, thisArg, disposables);
              }
              const entry: EarlyListenerData = {
                listener: [callback, thisArg, disposables],
                disposable: undefined,
              };
              const rm = list!.push(entry);
              return {
                dispose() {
                  rm();
                  entry.disposable?.dispose();
                },
              };
            };
            return event;
          }
        }

        // Method/value already memoised on the proxy target.
        if (key in target) {
          return target[key];
        }

        // Materialise + cache. Function values are bound to the real
        // instance so `this` reads work.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const obj = idle.value as any;
        let prop = obj[key];
        if (typeof prop !== 'function') {
          return prop;
        }
        prop = prop.bind(obj);
        target[key] = prop;
        return prop;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set(_target: T, p: PropertyKey, value: any): boolean {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (idle.value as any)[p] = value;
        return true;
      },
      getPrototypeOf(_target: T): object {
        return _ctor.prototype as object;
      },
    }) as T;
  }

  /**
   * Deposit a constructed instance into the owning container (the one whose
   * local `services` map holds a `SyncDescriptor` for this id). Walks the
   * parent chain so a child can deposit a parent-owned service back into the
   * parent's cache. Mirrors krow `instantiationService.ts:220-228`.
   *
   * Also stamps the local `_instances` + (eager path only) `_constructionOrder`
   * so dispose() can walk teardown in reverse construction order (PLAN D8).
   * Lazy (Proxy-wrapped) services are intentionally NOT added to
   * `_constructionOrder` — disposing them would require reading a property
   * of the Proxy, which would force materialisation. Lazy disposal is
   * handled by `_servicesToMaybeDispose` once the Proxy materialises.
   */
  private _setCreatedServiceInstance<T>(
    id: ServiceIdentifier<T>,
    instance: T,
    lazy: boolean = false,
  ): void {
    if (this.services.get(id) instanceof SyncDescriptor) {
      // Replace the descriptor in-place with the constructed instance so a
      // second lookup short-circuits via the `_instances` cache OR the
      // services map directly.
      this.services.set(id, instance);
      this._instances.set(id, instance);
      if (!lazy) {
        this._constructionOrder.push(id);
      }
    } else if (this.services.has(id)) {
      // Pre-built instance shorthand — already cached locally.
      this._instances.set(id, instance);
      // Don't add to `_constructionOrder` again if it was already pushed.
      if (!lazy && !this._constructionOrder.includes(id)) {
        this._constructionOrder.push(id);
      }
    } else if (this._parent) {
      this._parent._setCreatedServiceInstance(id, instance, lazy);
    } else {
      throw new Error(
        `illegal state - setting UNKNOWN service instance '${String(id)}'`,
      );
    }
  }

  /**
   * Find the instance OR descriptor for `id` by walking the parent chain.
   * Returns `undefined` if no container in the chain has a registration.
   * Mirrors krow `instantiationService.ts:230-237`.
   */
  private _getServiceInstanceOrDescriptor<T>(
    id: ServiceIdentifier<T>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): T | SyncDescriptor<T> | undefined {
    const instanceOrDesc = this.services.get(id);
    if (instanceOrDesc === undefined && this._parent) {
      return this._parent._getServiceInstanceOrDescriptor(id);
    }
    return instanceOrDesc as T | SyncDescriptor<T> | undefined;
  }

  /** Walk up to the tree root. Used for the shared in-progress stack. */
  private _root(): InstantiationService {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let cur: InstantiationService = this;
    while (cur._parent) {
      cur = cur._parent;
    }
    return cur;
  }

  private _assertNotDisposed(): void {
    if (this._disposed) {
      throw new Error('InstantiationService has been disposed');
    }
  }
}
