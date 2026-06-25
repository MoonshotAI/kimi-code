# `@moonshot-ai/agent-core` Dependency Injection Container

A VSCode-style DI container for the agent-core / server stack. Provides:

- **Service identifiers** — branded callable values minted by `createDecorator`,
  singleton-per-name.
- **Registration** — `ServiceCollection` (per-container) and `registerSingleton`
  (module-global registry).
- **Resolution** — `InstantiationService` with singleton-per-container
  semantics, scoped child containers (`createChild`), idempotent
  `dispose()`, Graph-based cycle detection, and `@IFoo`-style
  constructor-parameter auto-injection.
- **Delayed instantiation** — services flagged
  `supportsDelayedInstantiation: true` materialise lazily behind a `Proxy`.
- **Testing** — `TestInstantiationService` (subpath
  `@moonshot-ai/agent-core/di/test`) exposes direct `.get` / `.stub` so
  test bodies don't have to thread an `invokeFunction` accessor.

The design intentionally mirrors VSCode's `vs/platform/instantiation` API so
the conceptual model carries over.

## Why this and not a DI library?

Two reasons:

1. **Zero runtime dependencies** — the container is ~600 LoC of plain
   TypeScript; pulling in `tsyringe` / `inversify` would dwarf the entire
   subsystem.
2. **Familiar shape** — most kimi-code contributors have seen VSCode's
   service pattern. Same identifier-as-decorator trick, same `accessor.get`
   call site idiom, same `createChild` scope story.

## Core concepts

| Term                         | Lives in                  | Role                                                                |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------- |
| `ServiceIdentifier<T>`       | `createDecorator<T>()`    | Branded callable + parameter decorator; serves as the `Map` key.    |
| `SyncDescriptor<T>`          | `descriptors.ts`          | Wraps a ctor + static args + `supportsDelayedInstantiation` flag.   |
| `ServiceCollection`          | `serviceCollection.ts`    | Per-container map of id → (descriptor \| instance).                 |
| `InstantiationService`       | `instantiationService.ts` | Runtime container: resolves, caches, scopes, traces, disposes.      |
| `IDisposable` / `Disposable` | `lifecycle.ts`            | Teardown contract (services with a `dispose` method get called).    |
| `registerSingleton`          | `extensions.ts`           | Module-global registry consulted at bootstrap time.                 |
| `Graph<T>`                   | `graph.ts`                | Dependency subtree used for cycle detection + leaves-first build.   |
| `TestInstantiationService`   | `testInstantiationService.ts` | Subpath-only test container with `.stub` / `.get` / `.set`.     |

## Complete bootstrap example

```ts
import {
  createDecorator,
  registerSingleton,
  getSingletonServiceDescriptors,
  InstantiationService,
  ServiceCollection,
  SyncDescriptor,
} from '@moonshot-ai/agent-core';

// 1. Declare a service interface and identifier.
interface ILogger {
  readonly _serviceBrand: undefined; // brand required by the container
  log(message: string): void;
}
const ILogger = createDecorator<ILogger>('logger');

// 2. Implement it.
class ConsoleLogger implements ILogger {
  declare readonly _serviceBrand: undefined;
  log(message: string): void {
    // eslint-disable-next-line no-console
    console.log(`[log] ${message}`);
  }
}

// 3. Register at module load time.
registerSingleton(ILogger, ConsoleLogger);

// 4. At bootstrap, build the root container from the registry.
const services = new ServiceCollection(
  ...getSingletonServiceDescriptors().map(
    ([id, descriptor]) => [id, descriptor] as const,
  ),
);
const ix = new InstantiationService(services);

// 5. Use it via invokeFunction.
ix.invokeFunction((accessor) => {
  const logger = accessor.get(ILogger);
  logger.log('hello world');
});

// 6. Teardown — disposes children transitively, in reverse construction order.
ix.dispose();
```

## Service composition (`@IFoo` constructor-arg injection)

Any constructor parameter decorated with a `ServiceIdentifier` is auto-
resolved from the container at construction time. Static (non-decorated)
parameters come first; service parameters last. `createInstance(Ctor, …)`
infers the leading non-service prefix via `GetLeadingNonServiceArgs` so
callers only pass the static portion.

```ts
interface IClock {
  readonly _serviceBrand: undefined;
  now(): number;
}
const IClock = createDecorator<IClock>('clock');

class SystemClock implements IClock {
  declare readonly _serviceBrand: undefined;
  now(): number { return Date.now(); }
}

// Foo declares a static `prefix: string` and TWO service dependencies.
// The container injects `logger` + `clock` automatically.
class Foo {
  constructor(
    public readonly prefix: string,
    @ILogger private readonly _logger: ILogger,
    @IClock private readonly _clock: IClock,
  ) {}

  ping(): void {
    this._logger.log(`${this.prefix} @ ${this._clock.now()}`);
  }
}
const IFoo = createDecorator<Foo>('foo');

const ix = new InstantiationService(new ServiceCollection(
  [ILogger, new SyncDescriptor(ConsoleLogger)],
  [IClock, new SyncDescriptor(SystemClock)],
  [IFoo, new SyncDescriptor(Foo, ['hello'])], // static prefix is the only arg here
));

// Via the container's registry (IFoo registered above):
ix.invokeFunction((a) => a.get(IFoo).ping());

// OR via `createInstance` directly — the static prefix is the only argument
// the caller has to provide; `@ILogger` and `@IClock` are auto-injected.
const direct = ix.createInstance(Foo, 'direct');
direct.ping();
```

### Factory pattern via `@IInstantiationService`

`IInstantiationService` is itself a registered identifier. Decorating a
ctor param with `@IInstantiationService` receives the OWNING container —
useful for per-request scope factories:

```ts
class WidgetFactory {
  constructor(@IInstantiationService private readonly _ix: IInstantiationService) {}
  build(label: string): Widget {
    return this._ix.createInstance(Widget, label);
  }
}
```

A child container resolving `@IInstantiationService` receives the CHILD,
not the parent — so a factory built inside a child sees the scoped
container.

## Delayed instantiation

`new SyncDescriptor(Foo, [], true)` (third ctor arg flips
`supportsDelayedInstantiation` on). On first `accessor.get(IFoo)` the
container returns a `Proxy` that does NOT construct `Foo` yet. The real
ctor runs on the FIRST non-event property access:

```ts
const ix = new InstantiationService(new ServiceCollection(
  [IFoo, new SyncDescriptor(Foo, [], /* supportsDelayedInstantiation */ true)],
));
const proxy = ix.invokeFunction((a) => a.get(IFoo));
// Foo's ctor has NOT run yet.
proxy.ping();
// Foo's ctor ran exactly once; subsequent calls hit the cached real instance.
```

### `onDid*` / `onWill*` early-listener contract

Subscribing to an `onDidChange` (or `onWill…`) event on the proxy BEFORE
the real instance materialises parks the listener internally. When the
real instance is constructed, every parked listener is rebound against
the real event — so events fired post-materialisation are delivered as
if the subscription had happened against the real instance directly.

```ts
const proxy = ix.invokeFunction((a) => a.get(IFoo));
const sub = proxy.onDidChange((payload) => console.log('got', payload));
proxy.someMethod(); // triggers real construction
// Subscription was parked then replayed; future `fire(...)` calls go to the listener.
```

Use `instanceof Foo` against the proxy — `getPrototypeOf` is trapped so
the proxy's prototype IS `Foo.prototype`.

## Cycle detection

`InstantiationService` runs two complementary checks:

1. **Graph walk (primary)** — `_createAndCacheServiceInstance` builds the
   full `@IFoo` dependency subtree via `_util.getServiceDependencies`,
   then constructs leaves-first by repeatedly consuming `graph.roots()`.
   If the graph becomes stuck (`roots()` empty over a non-empty graph),
   `CyclicDependencyError` is thrown with `findCycleSlow()` formatting
   the cycle path (`A -> B -> A`). Cycles are caught **before any ctor
   body runs**.
2. **Tree-wide construction stack (defensive)** — `_inProgress` lives on
   the root container and catches cycles expressed via ctor BODY re-entry
   (`A.ctor` calling `accessor.get(IB)` whose `B.ctor` calls back to
   `accessor.get(IA)`). The Graph walk can't predict these edges because
   they aren't expressed via `@IFoo` metadata.

```ts
try {
  ix.invokeFunction((a) => a.get(IA));
} catch (e) {
  if (e instanceof CyclicDependencyError) {
    console.error(e.message); // 'cyclic dependency between services: A -> B -> A'
    console.error(e.path);    // ['A', 'B', 'A']
  }
}
```

Cycles that cross parent/child boundaries are caught because both checks
operate at the root container.

## Lifecycle

- `dispose()` is idempotent.
- Children are torn down first (depth-first); then the container disposes
  its own cached instances in **reverse construction order** (LIFO).
- After the LIFO pass, any Proxy-materialised real instances that didn't
  appear in `_constructionOrder` (i.e. the lazy path) get a second-pass
  dispose via `_servicesToMaybeDispose`.
- Only instances with a `dispose()` method are called (duck-typed); pure
  data services need do nothing. Disposing a Proxy never forces
  materialisation — the lazy path skips `_constructionOrder` for exactly
  this reason.
- `Disposable` base class is provided for the common "I own a stack of
  sub-disposables" case — `this._register(child)` returns the child and
  guarantees LIFO teardown.

## Testing

Test files import from the subpath `@moonshot-ai/agent-core/di/test`
(NOT the main package entry — keeps production bundles clean):

```ts
import { TestInstantiationService } from '@moonshot-ai/agent-core/di/test';

const ix = new TestInstantiationService();
ix.stub(ILogger, { log: vi.fn() } as ILogger);
const target = ix.createInstance(SomeClass, 'static-arg');
expect((ix.get(ILogger) as { log: vi.Mock }).log).toHaveBeenCalled();
```

`TestInstantiationService` extends `InstantiationService` and adds:

- `.get(id)` — resolve without an accessor closure.
- `.set(id, x)` — register or replace an instance / descriptor; returns
  the previous binding so fixtures can save-and-restore.
- `.stub(id, x)` — semantic alias for `.set` (intent: "replace real with
  mock").
- `.createChild(services)` — narrowed to return another
  `TestInstantiationService` so chained `.stub` / `.get` stays ergonomic.

## File layout

```
packages/agent-core/src/di/
├── README.md                    ← you are here
├── index.ts                     ← public barrel (main package entry)
├── test.ts                      ← subpath barrel (`@moonshot-ai/agent-core/di/test`)
├── instantiation.ts             ← createDecorator + IInstantiationService interface + _util
├── descriptors.ts               ← SyncDescriptor + SyncDescriptor0 + InstantiationType enum
├── serviceCollection.ts         ← ServiceCollection
├── instantiationService.ts      ← runtime container (resolution + Graph cycle + Proxy)
├── testInstantiationService.ts  ← TestInstantiationService (subpath-only)
├── lifecycle.ts                 ← IDisposable + Disposable base class
├── errors.ts                    ← CyclicDependencyError (path-form + Graph-form)
├── extensions.ts                ← registerSingleton + getSingletonServiceDescriptors
├── graph.ts                     ← Graph<T> for dependency-subtree walks
└── util/
    ├── idleValue.ts             ← GlobalIdleValue (deferred lazy executor)
    └── linkedList.ts            ← LinkedList<E> for parked event listeners
```

Tests live under `packages/agent-core/test/di/`.

## Migration from prior version (pre-P0 → post-P1)

If you wrote against an earlier internal cut of this container, the
following surface changes need attention:

1. **`$serviceMarker` → `_serviceBrand`** — service interfaces must
   declare `readonly _serviceBrand: undefined;` (krow/VSCode parity).
   Implementations stamp `declare readonly _serviceBrand: undefined;`.
2. **`createDecorator` singleton-per-name** — two calls with the same
   name return the SAME identifier reference. Previously every call
   minted a fresh callable. Use distinct names per service.
3. **`IInstantiationService` is both type AND value** — the same
   exported binding works as a TypeScript interface (`: IInstantiationService`)
   and a ServiceIdentifier value (`a.get(IInstantiationService)`).
4. **`id.serviceName` removed** — use `id.toString()` for diagnostic
   names; structured access via the singleton-per-name `_util.serviceIds`
   map is internal-only.
5. **`createInstance(ctor, ...rest)` auto-injects** — trailing `@IFoo`-
   decorated parameters are resolved from the container. Callers that
   previously wrote `ix.createInstance(Impl, a.get(IDep), …)` can drop
   the `a.get(...)` calls once `Impl` declares the decorator.
6. **`new SyncDescriptor(C, [], true)` is now LAZY** — third ctor arg
   flips the Proxy path on. Existing call sites with `false` (or
   omitted) are unchanged.
7. **`TestInstantiationService` moved to a subpath** —
   `import { TestInstantiationService } from '@moonshot-ai/agent-core/di/test'`
   (NOT from the main entry).
