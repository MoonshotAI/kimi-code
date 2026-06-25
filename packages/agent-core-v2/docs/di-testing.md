# DI testing

> Conventions for testing services built on the DI × Scope architecture. Mirrors the way VS Code tests `src/vs/platform/instantiation` and its consumers: declare dependencies with `@IService` decorators, build the container through the public API, stub collaborators through `TestInstantiationService`.

`@IService` parameter decorators run under vitest (the build uses `experimentalDecorators`), so test fixtures declare dependencies exactly like production code. There is **no** `param()` helper, no manual `(Id as …)(Ctor, '', 0)`, and no capturing `accessor` inside a constructor to synchronously `.get()` a peer — those are all workarounds for a decorator transform we already have.

## Three kinds of tests

Pick the helper by *what is under test*, not by habit.

| Under test | Lives in | Helper | Build the container with |
|---|---|---|---|
| The container / Scope machinery itself | `test/di/*` | the plain `InstantiationService` / `Scope` API | flat: `new InstantiationService(new ServiceCollection([Id, new SyncDescriptor(Impl)]))`; scoped: `createCoreScope()` + `registerScopedService()` |
| A real domain service (unit) | `test/<domain>/*` | `TestInstantiationService` | `disposables.add(new TestInstantiationService())` + `ix.stub(...)` + `ix.createInstance(Sut)` |
| Cross-scope wiring (integration) | `test/<domain>/*` or `test/di/*` | `createScopedTestHost` | `createScopedTestHost([[ILog, stub]])` → `host.child(LifecycleScope.Session, 's1', …)` |

Rule of thumb: testing the **container** → use the container; testing a **service** → use `TestInstantiationService`; only reach for the scope host when *which layer a service lives in* is itself the thing being asserted. Never `new` a production service in a unit test and paper over its dependencies with `undefined as never`.

## Declaring dependencies

Always use `@IService` constructor decorators — in fixtures and in production services alike.

```ts
// ✅
class Consumer {
  constructor(@IGreeter private readonly greeter: IGreeter) {}
}

// ❌ no param() helper, no inline cast
class Consumer {
  constructor(private readonly greeter: IGreeter) {}
}
param(IGreeter, Consumer, 0);
```

This holds for cycle tests too. Declare the loop with real constructor dependencies (`ServiceLoop1(@IService2)` ↔ `ServiceLoop2(@IService1)`); do not capture `accessor` inside a constructor and call `.get(peer)` to force an edge.

Because the decorator runs when the class is defined, the `createDecorator` identifier must be initialized **before** the class that uses it. Declare the identifier, then the class:

```ts
const IDep = createDecorator<IDep>('dep');
class Consumer {
  constructor(@IDep private readonly dep: IDep) {}
}
```

For two services that depend on each other (a cycle), declare both identifiers first, then both classes, so neither class references an uninitialized binding.

Declare fixtures at module top, interface + decorator + implementation co-located, and keep `_serviceBrand` on the interface when it represents a real service:

```ts
const IGreeter = createDecorator<IGreeter>('greeter');
interface IGreeter {
  readonly _serviceBrand: undefined;
  greet(): string;
}
class Greeter implements IGreeter {
  declare readonly _serviceBrand: undefined;
  greet(): string { return 'hi'; }
}
```

Pure throwaway fixtures may omit `_serviceBrand`.

## Domain service unit tests

`TestInstantiationService` (from `#/_base/di/test`) is the default harness. It is an `InstantiationService` that also implements `ServicesAccessor`, so you can `.get()` directly, and it owns sinon so `dispose()` restores stubs.

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';

describe('FlagService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, { log() {} });
    ix.stub(IConfigService, { get: () => ({}), onDidChange: () => () => {} });
  });
  afterEach(() => disposables.dispose());

  it('reads a flag', () => {
    const svc = disposables.add(ix.createInstance(FlagService));
    expect(svc.isEnabled('x')).toBe(false);
  });
});
```

Stubbing:

- stub a whole service with a partial: `ix.stub(IId, { method() { return … } })`;
- stub / assert a single method: `ix.stub(IId, 'method', value)` returns a sinon stub; `ix.spy(IId, 'method')` returns a spy;
- replace with a prebuilt instance or descriptor: `ix.set(IId, instance)` / `ix.set(IId, new SyncDescriptor(Impl))`;
- when a collaborator's behavior must vary per test, model it as a `Test*Service` subclass whose methods read suite-scoped `let` variables (the `configurationValue` / `updateArgs` pattern in VS Code) rather than rebuilding the container each test.

Create the system-under-test through DI (`ix.createInstance(Sut)`) so its `@IService` dependencies are resolved from the container, exactly as in production.

## Lifecycle / teardown

One `DisposableStore` per suite. Add the container, the system-under-test, and any event subscriptions to it; dispose in `afterEach`.

```ts
beforeEach(() => { disposables = new DisposableStore(); /* … */ });
afterEach(() => disposables.dispose());
```

Scope-host tests call `host.dispose()` in `afterEach` (or at the end of the `it`). Do not scatter bare `ix.dispose()` / `core.dispose()` calls through test bodies — route teardown through the store so ordering is deterministic and nothing leaks when a test fails mid-way.

## Assertions and naming

- One behavior per `it`; describe observable behavior (`child shadows parent registration`), not implementation (`calls _getOrCreateServiceInstance`).
- For cycles, assert `CyclicDependencyError` and its `path` array (e.g. `['A', 'B', 'A']`), not merely `toThrow`.
- For disposal order, capture events in an array and assert the sequence (`['C', 'B', 'A']` — children before parents).
