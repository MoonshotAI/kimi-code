import { SyncDescriptor } from './descriptors';
import { CyclicDependencyError } from './errors';
import { Graph } from './graph';
import {
  IInstantiationService as IInstantiationServiceDecorator,
  _util,
  type IInstantiationService,
  type ServiceIdentifier,
  type ServicesAccessor,
} from './instantiation';
import {
  dispose,
  isDisposable,
  toDisposable,
  type DisposableStore,
  type IDisposable,
} from './lifecycle';
import { ServiceCollection } from './serviceCollection';
import { GlobalIdleValue } from './util/idleValue';
import { LinkedList } from './util/linkedList';

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
  private _globalGraphImplicitDependency?: string;

  protected readonly _parent?: InstantiationService;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly _constructionOrder: any[] = [];

  protected readonly _children = new Set<InstantiationService>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _inProgress: ServiceIdentifier<any>[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _activeInstantiations = new Set<ServiceIdentifier<any>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _servicesToMaybeDispose = new Set<any>();

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
    const child = new InstantiationService(services, this._strict, this, this._enableTracing);
    this._children.add(child);
    store?.add(child);
    return child;
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    const childSnapshot = Array.from(this._children);
    this._children.clear();

    const ownInstances: IDisposable[] = [];
    for (let i = this._constructionOrder.length - 1; i >= 0; i--) {
      const instance = this._constructionOrder[i]!;
      if (isDisposable(instance)) {
        ownInstances.push(instance);
        this._servicesToMaybeDispose.delete(instance);
      }
    }

    const remainingInstances: IDisposable[] = [];
    for (const candidate of this._servicesToMaybeDispose) {
      if (isDisposable(candidate)) {
        remainingInstances.push(candidate);
      }
    }

    try {
      dispose([...childSnapshot, ...ownInstances, ...remainingInstances]);
    } finally {
      this._constructionOrder.length = 0;
      this._servicesToMaybeDispose.clear();
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
    if (this._globalGraph && this._globalGraphImplicitDependency) {
      this._globalGraph.insertEdge(this._globalGraphImplicitDependency, String(id));
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
            data.desc.supportsDelayedInstantiation,
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
    supportsDelayedInstantiation: boolean,
    _trace: Trace,
  ): T {
    if (this._services.get(id) instanceof SyncDescriptor) {
      return this._createServiceInstance(
        id,
        ctor,
        args,
        supportsDelayedInstantiation,
        _trace,
        this._servicesToMaybeDispose,
      );
    }
    if (this._parent) {
      return this._parent._createServiceInstanceWithOwner(
        id,
        ctor,
        args,
        supportsDelayedInstantiation,
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
    supportsDelayedInstantiation: boolean,
    _trace: Trace,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    disposeBucket: Set<any>,
  ): T {
    if (!supportsDelayedInstantiation) {
      const root = this._root();
      root._inProgress.push(id);
      try {
        const result = this._createInstance<T>(ctor, args.slice(), _trace);
        disposeBucket.add(result);
        this._constructionOrder.push(result);
        return result;
      } finally {
        const popIdx = root._inProgress.lastIndexOf(id);
        if (popIdx >= 0) {
          root._inProgress.splice(popIdx, 1);
        }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type EventLike = (callback: (e: any) => void, thisArg?: unknown, disposables?: IDisposable[]) => IDisposable;
    type EarlyListenerData = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listener: Parameters<EventLike>;
      disposable?: IDisposable;
    };
    const earlyListeners = new Map<string, LinkedList<EarlyListenerData>>();
    const child = new InstantiationService(undefined, this._strict, this, this._enableTracing);
    child._globalGraphImplicitDependency = String(id);
    const _ctor = ctor;
    const _args = args.slice();
    const idle = new GlobalIdleValue<T>(() => {
      const result = child._createInstance<T>(_ctor, _args.slice(), _trace);
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
      disposeBucket.add(result);
      this._constructionOrder.push(result);
      return result;
    });

    return new Proxy(Object.create(null), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get(target: any, key: PropertyKey): unknown {
        if (!idle.isInitialized) {
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
              const rm = list.push(entry);
              return toDisposable(() => {
                rm();
                entry.disposable?.dispose();
              });
            };
            return event;
          }
        }

        if (key in target) {
          return target[key];
        }

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

  private _setCreatedServiceInstance<T>(id: ServiceIdentifier<T>, instance: T): void {
    if (this._services.get(id) instanceof SyncDescriptor) {
      this._services.set(id, instance);
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
