/**
 * `di` domain — `InstantiationService` container (instantiation, child scopes, cycle detection).
 */

import { SyncDescriptor } from './descriptors';
import { CascadeEngine, CascadeTree, type CascadeChange, type CascadeHost } from './cascadeEngine';
import { DependencyGraph } from './dependencyGraph';
import { CascadeConflictError, CyclicDependencyError } from './errors';
import { Graph } from './graph';
import {
  IInstantiationService as IInstantiationServiceDecorator,
  _util,
  type IInstantiationService,
  type ProvideHandle,
  type ProvideOptions,
  type ServiceIdentifier,
  type ServicesAccessor,
} from './instantiation';
import { isDisposable, type DisposableStore } from './lifecycle';
import { onUnexpectedError } from '../errors/unexpectedError';
import { Ledger, type LedgerEntry } from '../lifecycle/ledger';
import { ServiceCollection } from './serviceCollection';

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
    return !_enableTracing
      ? Trace._None
      : new Trace(
          TraceType.Invocation,
          fn.name ?? new Error('Trace invocation').stack!.split('\n').slice(3, 4).join('\n'),
        );
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
      const prefix = '\t'.repeat(n);
      for (const [id, first, child] of trace._dep) {
        if (first && child) {
          causedCreation = true;
          res.push(`${prefix}CREATES -> ${String(id)}`);
          const nested = printChild(n + 1, child);
          if (nested) {
            res.push(nested);
          }
        } else {
          res.push(`${prefix}uses -> ${String(id)}`);
        }
      }
      return res.join('\n');
    }

    const lines = [
      `${this.type === TraceType.Creation ? 'CREATE' : 'CALL'} ${this.name}`,
      printChild(1, this),
      `DONE, took ${dur.toFixed(2)}ms (grand total ${Trace._totals.toFixed(2)}ms)`,
    ];

    if (dur > 2 || causedCreation) {
      Trace.all.add(lines.join('\n'));
    }
  }

}

export class InstantiationService implements IInstantiationService {
  declare readonly _serviceBrand: undefined;

  readonly _globalGraph?: Graph<string>;

  protected readonly _parent?: InstantiationService;

  protected readonly _ledger = new Ledger('InstantiationService');

  /** Tree-global persistent dependency graph (shared by the whole scope tree). */
  get dependencyGraph(): DependencyGraph {
    return this._tree.graph;
  }

  private readonly _tree: CascadeTree;

  /** Cascade engine (L2): one per container; tree-wide orchestrated transactions. */
  readonly cascade: CascadeEngine;

  private _parentLedgerEntry: LedgerEntry | undefined;

  /** Materialized instance → its ledger entry (for individual retirement). */
  private readonly _instanceEntries = new Map<unknown, LedgerEntry>();

  /** Token → the ledger entry of its latest provide (generation-guarded). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _provideEntries = new Map<ServiceIdentifier<any>, LedgerEntry>();

  /** Set while the cascade engine itself resolves — bypasses the in-flight guard. */
  private _cascadeResolving = false;

  protected readonly _children = new Set<InstantiationService>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _inProgress: ServiceIdentifier<any>[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _activeInstantiations = new Set<ServiceIdentifier<any>>();

  private _disposed = false;

  constructor(
    private readonly _services: ServiceCollection = new ServiceCollection(),
    private readonly _strict: boolean = false,
    parent?: InstantiationService,
    protected readonly _enableTracing: boolean = false,
  ) {
    this._parent = parent;
    this._globalGraph = _enableTracing ? parent?._globalGraph ?? new Graph(e => e) : undefined;
    this._services.set(IInstantiationServiceDecorator, this);
    this._tree = parent?._tree ?? new CascadeTree(new DependencyGraph());
    const host: CascadeHost = {
      isRegistered: (token) => this._getServiceInstanceOrDescriptor(token) !== undefined,
      ownerScopeOf: (token) => this._ownerOf(token),
      isMaterialized: (token) => {
        const value = this._services.get(token);
        return value !== undefined && !(value instanceof SyncDescriptor);
      },
      materialize: (token) => {
        this._cascadeResolving = true;
        try {
          return this._getOrCreateServiceInstance(
            token,
            Trace.traceCreation(false, CascadeEngine),
          );
        } finally {
          this._cascadeResolving = false;
        }
      },
      retire: (token) => this._retireUnit(token),
      applyProvide: (token, descriptor, pinned) => {
        this._services.set(token, descriptor, { pinned });
        return this._services.uidOf(token)!;
      },
      applyProvideInstance: (token, instance, pinned) => {
        this._services.set(token, instance, { pinned });
        return this._services.uidOf(token)!;
      },
      applyUnprovide: (token) => {
        this._services.delete(token);
      },
      recipeOf: (token) => {
        const entry = this._services.entry(token);
        if (entry === undefined) return undefined;
        return entry.value instanceof SyncDescriptor ? entry.value : entry.recipe;
      },
      dependenciesOf: (recipe) =>
        _util.getServiceDependencies(recipe.ctor).map((dependency) => dependency.id),
    };
    this.cascade = new CascadeEngine(host, this, this._tree);
  }

  /** Structural handle for the cascade engine's scoped tokens. */
  get cascadeDisposed(): boolean {
    return this._disposed;
  }

  /** Distance from the tree root (root = 0). */
  get cascadeDepth(): number {
    return (this._parent?.cascadeDepth ?? -1) + 1;
  }

  /** The container owning a token in this container's resolution chain. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _ownerOf(id: ServiceIdentifier<any>): InstantiationService | undefined {
    if (this._services.has(id)) {
      return this;
    }
    return this._parent?._ownerOf(id);
  }

  invokeFunction<R, TS extends any[] = []>(
    fn: (accessor: ServicesAccessor, ...args: TS) => R,
    ...args: TS
  ): R {
    this._assertNotDisposed();
    const _trace = Trace.traceInvocation(this._enableTracing, fn);
    let done = false;
    try {
      const accessor: ServicesAccessor = {
        get: <T>(id: ServiceIdentifier<T>): T => {
          if (done) {
            throw new Error(
              'service accessor is only valid during the invocation of its target method',
            );
          }
          const result = this._getOrCreateServiceInstance(id, _trace);
          if (!result) {
            this._throwIfStrict(`[invokeFunction] unknown service '${String(id)}'`, false);
          }
          return result;
        },
      };
      return fn(accessor, ...args);
    } finally {
      done = true;
      _trace.stop();
    }
  }

  provide<T>(
    id: ServiceIdentifier<T>,
    instanceOrDescriptor: T | SyncDescriptor<T>,
    options?: ProvideOptions,
  ): ProvideHandle {
    this._assertNotDisposed();
    this._releaseProvideEntry(id);

    if (
      !(instanceOrDescriptor instanceof SyncDescriptor) &&
      this._services.get(id) === instanceOrDescriptor
    ) {
      // Re-affirming the very instance already materialized under this token:
      // refresh the registration, no retirement, no cascade.
      this._services.set(id, instanceOrDescriptor, { pinned: options?.pinned });
      const uid = this._services.uidOf(id)!;
      const entry = this._ledger.register(() => {
        if (this._services.uidOf(id) === uid) {
          this.unprovide(id);
        }
      }, `provide:${String(id)}`);
      this._provideEntries.set(id, entry);
      return {
        uid,
        dispose: () => {
          void entry.dispose();
        },
      };
    }

    // Everything else — a recipe or a replacing instance — is one cascade
    // transaction, so live dependents are torn down and rebuilt (D1/D4).
    const beforeUid = this._services.uidOf(id);
    let appliedUid: number | undefined;
    const noteApplied = (): void => {
      const uid = this._services.uidOf(id);
      if (uid !== undefined && uid !== beforeUid) {
        appliedUid = uid;
      }
    };
    const change: CascadeChange =
      instanceOrDescriptor instanceof SyncDescriptor
        ? {
            action: 'provide',
            token: id,
            descriptor: instanceOrDescriptor,
            pinned: options?.pinned,
            activation: options?.activation,
            reason: `provide ${String(id)}`,
          }
        : {
            action: 'provide',
            token: id,
            instance: instanceOrDescriptor,
            pinned: options?.pinned,
            reason: `provide ${String(id)}`,
          };
    noteApplied();
    this.cascade.submit(change).then(noteApplied, onUnexpectedError);
    noteApplied(); // the sync fast path has already applied the change
    const entry = this._ledger.register(() => {
      // Generation guard: only unprovide the generation this entry provided.
      if (appliedUid !== undefined && this._services.uidOf(id) === appliedUid) {
        this.unprovide(id);
      }
    }, `provide:${String(id)}`);
    this._provideEntries.set(id, entry);
    return {
      get uid(): number {
        if (appliedUid === undefined) {
          throw new Error(
            `provide of '${String(id)}' has not been applied yet (cascade in flight)`,
          );
        }
        return appliedUid;
      },
      dispose: () => {
        void entry.dispose();
      },
    };
  }

  unprovide<T>(id: ServiceIdentifier<T>): void {
    if (this._disposed) {
      return;
    }
    this._releaseProvideEntry(id);
    if (this._services.get(id) === undefined) {
      return;
    }
    this.cascade
      .submit({ action: 'unprovide', token: id, reason: `unprovide ${String(id)}` })
      .catch(onUnexpectedError);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _releaseProvideEntry(id: ServiceIdentifier<any>): void {
    const entry = this._provideEntries.get(id);
    if (entry !== undefined) {
      this._provideEntries.delete(id);
      entry.release();
    }
  }

  /** Retire the live instance of a token and reset its entry to the recipe. */
  private _retireUnit<T>(id: ServiceIdentifier<T>): void | Promise<void> {
    const instance = this._services.get(id);
    if (instance === undefined || instance instanceof SyncDescriptor) {
      return undefined;
    }
    this._services.unmaterialize(id);
    const entry = this._instanceEntries.get(instance);
    if (entry === undefined) {
      return undefined;
    }
    this._instanceEntries.delete(instance);
    return entry.dispose();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createInstance<T>(descriptor: SyncDescriptor<T>, ...rest: any[]): T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createInstance<T>(ctor: new (...args: any[]) => T, ...rest: any[]): T;
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

  createChild(services: ServiceCollection, store?: DisposableStore): IInstantiationService {
    this._assertNotDisposed();
    if (!(services instanceof ServiceCollection)) {
      throw new TypeError(
        'createChild requires a ServiceCollection instance (got something else)',
      );
    }
    const child = this._createChildService(services);
    this._children.add(child);
    child._parentLedgerEntry = this._ledger.register(() => {
      child.dispose();
    }, 'child-instantiation');
    store?.add(child);
    return child;
  }

  protected _createChildService(services: ServiceCollection): InstantiationService {
    return new InstantiationService(services, this._strict, this, this._enableTracing);
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    try {
      // Children first (forward creation order): their services may depend on
      // this container's instances, so they must die before them. Each child
      // releases its ledger entry, so the ledger teardown below skips them.
      for (const child of Array.from(this._children)) {
        child.dispose();
      }
      this._children.clear();
      void this._ledger.teardown('scope-close');
      this._services.dispose();
      this.cascade.dispose();
    } finally {
      this._children.clear();
      this._parentLedgerEntry?.release();
      this._parentLedgerEntry = undefined;
      if (this._parent) {
        this._parent._children.delete(this);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _createInstance<T>(ctor: any, args: unknown[], _trace: Trace): T {
    const serviceDependencies = _util.getServiceDependencies(ctor).toSorted((a, b) => a.index - b.index);
    const serviceArgs: unknown[] = [];
    for (const dependency of serviceDependencies) {
        const service = this._getOrCreateServiceInstance(dependency.id, _trace);
        if (!service) {
          this._throwIfStrict(
            `[createInstance] ${ctor.name} depends on UNKNOWN service ${String(dependency.id)}.`,
            false,
          );
        }
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
        args = args.concat(Array.from({ length: delta }));
      } else {
        args = args.slice(0, firstServiceArgPos);
      }
    }

    return Reflect.construct<unknown[], T>(ctor, args.concat(serviceArgs));
  }

  protected _getOrCreateServiceInstance<T>(id: ServiceIdentifier<T>, _trace: Trace): T {
    if (!this._cascadeResolving) {
      if (this.cascade.isInFlight(id)) {
        // The sync resolution path cannot suspend; the async path
        // (cascade.resolveWhenAvailable) waits for the transaction instead.
        throw new CascadeConflictError(
          String(id),
          'token is inside an in-flight cascade transaction',
        );
      }
      const failure = this.cascade.unitFailure(id);
      if (failure !== undefined) {
        // D5: Failed is sticky — resolving a failed unit rethrows its error.
        throw failure as Error;
      }
    }
    const entry = this._getServiceInstanceOrDescriptor(id);

    if (entry instanceof SyncDescriptor) {
      const root = this._root();
      if (root._inProgress.includes(id)) {
        const path = [...root._inProgress, id].map(String);
        throw new CyclicDependencyError(path);
      }

      return this._safeCreateAndCacheServiceInstance(id, entry, _trace.branch(id, true));
    }

    _trace.branch(id, false);
    return entry as T;
  }

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
    while (stack.length > 0) {
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
        if (!instanceOrDesc) {
          this._throwIfStrict(
            `[createInstance] ${String(item.id)} depends on ${String(dependency.id)} which is NOT registered.`,
            true,
          );
        }

        this._globalGraph?.insertEdge(String(item.id), String(dependency.id));

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
        const instanceOrDesc = this._getServiceInstanceOrDescriptor(data.id);
        if (instanceOrDesc instanceof SyncDescriptor) {
          const instance = this._createServiceInstanceWithOwner(
            data.id,
            data.desc.ctor,
            data.desc.staticArguments,
            data._trace,
          );
          this._setCreatedServiceInstance(data.id, instance);
        }
        graph.removeNode(data);
      }
    }
    return this._getServiceInstanceOrDescriptor(id) as T;
  }

  private _createServiceInstanceWithOwner<T>(
    id: ServiceIdentifier<T>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctor: any,
    args: ReadonlyArray<unknown> = [],
    _trace: Trace,
  ): T {
    if (this._services.get(id) instanceof SyncDescriptor) {
      return this._createServiceInstance(id, ctor, args, _trace);
    }
    if (this._parent) {
      return this._parent._createServiceInstanceWithOwner(
        id,
        ctor,
        args,
        _trace,
      );
    }
    throw new Error(`illegalState - creating UNKNOWN service instance ${ctor.name}`);
  }

  private _createServiceInstance<T>(
    id: ServiceIdentifier<T>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctor: any,
    args: ReadonlyArray<unknown> = [],
    _trace: Trace,
  ): T {
    const root = this._root();
    root._inProgress.push(id);
    try {
      const result = this._createInstance<T>(ctor, args.slice(), _trace);
      // Persistent tree-global graph: record the instance and its
      // constructor-injection (instance) edges, both ends scope-tagged; the
      // ledger entry removes them again at teardown. Edges point child →
      // parent (a dependency's owner is always this container or an ancestor).
      this.dependencyGraph.addInstance(result as object, this, id);
      for (const dependency of _util.getServiceDependencies(ctor)) {
        const owner = this._ownerOf(dependency.id);
        if (owner !== undefined) {
          this.dependencyGraph.addEdge(
            result as object,
            { scope: owner, token: dependency.id },
            'instance',
          );
        }
      }
      const entry = this._ledger.register(() => {
        this._instanceEntries.delete(result);
        this.dependencyGraph.removeInstance(result as object);
        if (isDisposable(result)) {
          // Propagate a (runtime) async disposer so cascade teardown can
          // await it serially; statically `dispose()` is typed void.
          const out = result.dispose() as unknown as void | Promise<void>;
          return out;
        }
        return undefined;
      }, `service:${String(id)}`);
      this._instanceEntries.set(result, entry);
      this.cascade.observedMaterialization(id);
      return result;
    } finally {
      const popIdx = root._inProgress.lastIndexOf(id);
      if (popIdx >= 0) {
        root._inProgress.splice(popIdx, 1);
      }
    }
  }

  private _setCreatedServiceInstance<T>(id: ServiceIdentifier<T>, instance: T): void {
    if (this._services.get(id) instanceof SyncDescriptor) {
      // Keeps the recipe on the entry so a cascade teardown can unmaterialize
      // back to it (and rebuild later).
      this._services.materialize(id, instance);
    } else if (this._parent) {
      this._parent._setCreatedServiceInstance(id, instance);
    } else {
      throw new Error(
        `illegal state - setting UNKNOWN service instance '${String(id)}'`,
      );
    }
  }

  private _getServiceInstanceOrDescriptor<T>(
    id: ServiceIdentifier<T>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): T | SyncDescriptor<T> | undefined {
    const instanceOrDesc = this._services.get(id);
    if (instanceOrDesc === undefined && this._parent) {
      return this._parent._getServiceInstanceOrDescriptor(id);
    }
    return instanceOrDesc;
  }

  private _throwIfStrict(msg: string, printWarning: boolean): void {
    if (printWarning) {
      // eslint-disable-next-line no-console
      globalThis.console.warn(msg);
    }
    if (this._strict) {
      throw new Error(msg);
    }
  }

  private _root(): InstantiationService {
    return this._parent?._root() ?? this;
  }

  private _assertNotDisposed(): void {
    if (this._disposed) {
      throw new Error('InstantiationService has been disposed');
    }
  }
}
