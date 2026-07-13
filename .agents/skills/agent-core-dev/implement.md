# Stage 3 — Implement

Write the contract leaf, implementation leaf (with its registration), and the package-entry lines that load them. Each section below introduces one DI building block as you need it. Source lives in `src/_base/di/`.

## Standard recipe for a new `IXxxService`

1. **Contract leaf** — `src/<domain>/<domain>.ts`: interface (with `_serviceBrand`) + `createDecorator` identity.
2. **Impl leaf** — `src/<domain>/<domain>Service.ts`: class with `@IX` constructor deps; top-level `registerScopedService(scope, IX, Impl, type, '<domain>')`.
3. **Entry** — `src/index.ts`: load each leaf precisely — `export * from './<domain>/<domain>';` for the contract and `import './<domain>/<domain>Service';` for the impl (importing the impl runs the registration). **No `src/<domain>/index.ts` barrel.**
4. **Tests** — see test.md.

There is **no central wiring file**: bindings live in each domain's impl file and are collected through import side effects.

## §1 Interface + identity (a global service, no deps)

```ts
// greet/greet.ts
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IGreeter {
  readonly _serviceBrand: undefined;   // type marker: tells DI "this is a service"
  hello(): string;
}

export const IGreeter: ServiceIdentifier<IGreeter> = createDecorator<IGreeter>('greeter');
```

`createDecorator(name)` produces a `ServiceIdentifier` that is three things at once: a runtime key, a parameter decorator, and a compile-time carrier of the `IGreeter` type.

> **The identity name is globally unique.** `createDecorator` caches by `name`; two domains using the same string collide and share one identity.

```ts
// greet/greetService.ts
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IGreeter } from './greet';

export class Greeter implements IGreeter {
  declare readonly _serviceBrand: undefined;   // mirrors the interface marker
  hello(): string { return 'hi'; }
}

registerScopedService(
  LifecycleScope.App,     // lifetime: process-wide
  IGreeter,                // identity
  Greeter,                 // implementation
  InstantiationType.Eager, // when to construct: immediately
  'greet',                 // domain name (for diagnostics)
);
```

The scope a class binds to is an **intrinsic property of the class**, decided at the registration point, not the call site.

The impl's top-level `registerScopedService` runs as soon as the module is imported. There is no `greet/index.ts` barrel — instead, add the leafs to the package entry `src/index.ts`, one line per leaf:

```ts
// src/index.ts
export * from './greet/greet';
import './greet/greetService';   // this import runs registerScopedService
```

Anyone can now `accessor.get(IGreeter)` the single global instance.

## §2 Constructor injection (your service uses others)

```ts
export class SessionMetadata extends Disposable implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }
}
```

`@ISessionContext` records "parameter 0 needs `ISessionContext`" on the class metadata; the container fills it when constructing.

Three inviolable constraints:

1. **Do not `new` a class with `@IService` deps** — `new` bypasses registration, scope, and the singleton cache. Inject with `@IX` or `accessor.get(IX)`.
2. **`@IX` decorates constructor parameters only.** Decorating a field/method throws at runtime.
3. **Parameter order depends on how the object is built** — for `createInstance` non-singletons, static params come first (see §7); for scoped services, `@IX` params are conventionally first and any static params need defaults. See service-authoring.md §constructor-conventions.

Consumers resolve by interface and never import the impl class:

```ts
const meta = accessor.get(ISessionMetadata);   // type is ISessionMetadata
```

> If you need "a config" rather than "a service", model it as a service (e.g. `IConfigService`) and inject it. If you need a per-turn, parameterized, non-singleton object, see §7.

## §3 Scoped registration (not global)

Swap the `scope` argument to bind to a different tier:

```ts
registerScopedService(LifecycleScope.Session, ISessionMetadata, SessionMetadata, InstantiationType.Delayed, 'sessionMetadata');
```

Remember the visibility rule from orient.md: a service may inject services from its own scope or any ancestor; never from a descendant.

## §4 Releasing resources (`Disposable`)

For a service that subscribes to events, starts timers, or holds handles:

```ts
import { Disposable } from '#/_base/di/lifecycle';

export class WSBroadcastService extends Disposable implements IWSBroadcastService {
  declare readonly _serviceBrand: undefined;

  constructor(@IEventService event: IEventService) {
    super();
    this._register(event.subscribe(() => { /* … */ }));   // collect child resources
  }
}
```

- Extend `Disposable`, collect any `IDisposable` with `this._register(d)` (event subscriptions, `toDisposable(fn)`, etc.).
- The container calls `dispose()` automatically when the service is torn down; child resources release in turn.
- Disposal order is deterministic (orient.md): child scopes first, then reverse construction order within a scope.

## §5 Eager vs delayed instantiation

```ts
// Eager: constructed when the scope is created
registerScopedService(LifecycleScope.App, ILogService, LogService, InstantiationType.Eager, 'log');

// Delayed: constructed on first get
registerScopedService(LifecycleScope.App, IScopeRegistry, ScopeRegistry, InstantiationType.Delayed, 'gateway');
```

A `Delayed` service returns a **Proxy** that constructs the real instance on first property access. Listeners registered on its `onDid…` / `onWill…` events before construction are not lost — the container records them and replays the subscriptions once the instance exists.

> Rule of thumb: `Eager` for dependency-free, frequently-used, or "early side effect" services (e.g. `ILogService`); default to `Delayed` otherwise.

## §6 Using a service inside a plain function (`invokeFunction`)

When you do not want a new class and just need a service once, or when you expose a `ServicesAccessor` to the outside:

```ts
const accessor: ServicesAccessor = {
  get: <T>(id: ServiceIdentifier<T>): T => instantiation.invokeFunction((a) => a.get(id)),
};
```

`invokeFunction(fn)` hands `fn` a `ServicesAccessor` valid **only during that call**.

> **The accessor is valid only during the invocation.** Calling `accessor.get()` after `invokeFunction` returns throws `"service accessor is only valid during the invocation"`. Do not stash it for async use — inject the service in the constructor (§2) if you need it long-term.

## §7 Creating a non-singleton object with deps (`createInstance`)

For a per-turn executor that also has `@IService` deps:

```ts
class TurnRunner {
  constructor(
    private readonly input: string,                 // static param: passed by caller
    private readonly turn: number,                  // static param: passed by caller
    @ILogService private readonly log: ILogService, // service param: injected by container
  ) {}
}

const runner = instantiation.createInstance(TurnRunner, 'hello', 1);
```

Static params come first (you pass them), service params follow (the container fills them), then `Reflect.construct` builds the instance. This object is **not** placed in any scope's singleton cache — every call is a fresh instance.

> This is why service params must follow static params **for `createInstance`**: the container sorts by the parameter positions recorded via `@IX`. `_serviceBrand` lets the compiler tell the two kinds apart. Scoped services built by `registerScopedService` follow a different convention (`@IX` params first, optional static params after) — see service-authoring.md §constructor-conventions.

## §8 Spawning a child scope / child container

For a service that "starts a new session / agent" and needs a child scope, inject `IInstantiationService` itself (every container binds itself as `IInstantiationService`):

```ts
export class ScopeRegistry implements IScopeRegistry {
  declare readonly _serviceBrand: undefined;

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {}

  createSession(opts: CreateSessionOptions): Promise<IScopeHandle> {
    const collection = new ServiceCollection();
    for (const entry of getScopedServiceDescriptors(LifecycleScope.Session)) {
      collection.set(entry.id, entry.descriptor);   // collect Session-tier descriptors
    }
    const child = this.instantiation.createChild(collection);   // spawn child container
    const accessor: ServicesAccessor = {
      get: <T>(id: ServiceIdentifier<T>): T => child.invokeFunction((a) => a.get(id)),
    };
    const handle: IScopeHandle = { id: opts.sessionId, kind: LifecycleScope.Session, accessor };
    this.sessions.set(opts.sessionId, handle);
    return Promise.resolve(handle);
  }
}
```

Key points:

- `getScopedServiceDescriptors(scope)` returns every descriptor registered at that tier; load them into a `ServiceCollection`.
- `instantiation.createChild(collection)` builds a child container whose parent pointer is the current container — so the child resolves upward to `App` services (the visibility rule).
- Expose the child to the outside by wrapping it in a `ServicesAccessor` via `invokeFunction` (§6).

> Higher-level code usually calls `Scope.createChild(kind, id)` (it does the "filter descriptors + build child" for you). Drop to the manual `ServiceCollection` form only when you need explicit control.

## §9 Cyclic dependencies (forbidden — refactor)

Business rule: **no cyclic dependencies.** The container rejects them; the correct response is to refactor, not to make it run.

### The container rejects synchronous cycles

If A needs B while being created and B needs A while being created, the container throws `CyclicDependencyError` with a `path` like `['A', 'B', 'A']`. Self-cycles (A depends on itself) are also rejected. This is a protection mechanism telling you the two services' responsibilities are mis-drawn.

### Why cycles are disallowed

- Scope layering makes normal dependencies a DAG (Agent → Session → App, resolving upward); a cycle is almost always a design smell.
- "Making the cycle happen to work" turns construction order into an implicit contract — hard to debug.

v2's stance: **the dependency graph must be acyclic.**

### How to refactor (in priority order)

1. **Extract a third service C.** Move the part A and B both need into C; let A and B both depend on C instead of each other. The most common fix.
2. **Decouple with an event.** If A only needs to know about a change in B, have B emit via `IEventService` and A subscribe, rather than A holding a reference to B.
3. **Re-partition scope.** One of them may belong at a different tier — moving it makes the cycle disappear.

### Delayed as a cycle-breaker (legacy escape hatch — forbidden)

A legacy mechanism lets a `Delayed` edge turn a "soft cycle" into a non-synchronous Proxy. **Do not use it to bypass cyclic dependencies** — it exists for historical compatibility, not to paper over your design. On `CyclicDependencyError`, refactor per the above.

## Interface cheat sheet

| Interface | Section | Role |
|---|---|---|
| `createDecorator<T>(name)` → `ServiceIdentifier<T>` | §1 | identity (runtime key + compile-time type + param decorator) |
| `@IService` | §2, §7 | declare a dependency on a constructor param |
| `registerScopedService(scope, id, ctor, type, domain)` | §1, §3, §5 | bind an impl to a lifetime tier |
| `ServicesAccessor.get(IX)` | §2, §6 | resolve an instance by interface |
| `IInstantiationService.invokeFunction(fn, …)` | §6, §8 | obtain a temporary accessor inside a function |
| `IInstantiationService.createInstance(ctor, …args)` | §7 | build a non-singleton object with deps injected |
| `IInstantiationService.createChild(collection)` | §8 | spawn a child container |
| `getScopedServiceDescriptors(scope)` | §8 | retrieve all descriptors registered at a tier |
| `Disposable` / `DisposableStore` / `IDisposable` | §4 | resource management and disposal |
| `Scope` / `LifecycleScope` | §3, §8 | the lifetime tree |
| `SyncDescriptor` | (tests / low-level) | package a constructor + static args into a pending descriptor |

> Legacy export (not used in v2, just recognize it): `refineServiceDecorator` is a VS Code leftover DI helper. v2 src/test has zero references; always use `registerScopedService`.

## Red lines (this stage)

- No `new` on a class whose constructor carries `@IService` deps — inject or `accessor.get(IX)`.
- `@IX` decorates constructor params only; parameter order depends on construction (static-first for `createInstance`, `@IX`-first for scoped services — see service-authoring.md).
- Both interface and impl carry `_serviceBrand`; the `createDecorator` name is globally unique.
- `ServicesAccessor` is valid only during `invokeFunction` — never stash it for async use.
- No cyclic dependencies — refactor (extract / event / re-scope); do not break the cycle with `Delayed`.
