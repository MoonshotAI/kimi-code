# Stage 4 — Test

Exercise the **same path production uses**: a service is reached by its interface through the container, its `@IService` dependencies are resolved from the container, and — where the scope layer matters — through the scope tree. Tests that `new` a service and paper over its constructor with hand-rolled objects bypass that path and let the `registerScopedService(IX → Impl)` binding rot untested.

`@IService` parameter decorators run under vitest (the build uses `experimentalDecorators`), so fixtures declare dependencies exactly like production code. There is **no** `param()` helper, no manual `(Id as …)(Ctor, '', 0)`, and no capturing `accessor` inside a constructor to synchronously `.get()` a peer.

## The one rule

**Resolve the system under test by its interface, through the container. Never call `new` on a production service whose constructor carries `@IService` dependencies.**

```ts
// ✅ resolve by interface — the IX → Sut binding is exercised
ix.set(IMessageService, new SyncDescriptor(MessageService));
const svc = ix.get(IMessageService);

// ❌ construct the implementation directly — the registration is never run
const svc = new MessageService(stubContext);
```

Resolving by interface is what makes `registerScopedService(ISut, Sut, …)` part of the test. Constructing the class directly (or via `ix.createInstance(Sut)`) tests the class in isolation but leaves the binding, the scope layer, and the delayed/eager flag unverified.

Pure functions, value objects, and services with **no** `@IService` dependencies may be constructed directly.

The only other exception is a test that genuinely needs **two independent instances** of the same service with different dependencies (e.g. constructing two `TurnService`s with different `ILoopRunner`s). A singleton-per-container resolution cannot produce both, so `ix.createInstance(Impl)` is acceptable there — annotate it with a comment explaining why.

## Two harnesses

Pick the harness by *whether the scope layer is part of what you are testing*.

| Under test | Harness | Resolve the SUT with |
|---|---|---|
| A single service's behavior (unit) | `TestInstantiationService` (flat) | `ix.get(ISut)` after `ix.set(ISut, new SyncDescriptor(Sut))` |
| Cross-scope wiring, or which layer a service lives in | `createScopedTestHost` (scope tree) | `host.<scope>.accessor.get(ISut)` |

### Unit harness — `TestInstantiationService`

Default for domain service unit tests. It is an `InstantiationService` that also implements `ServicesAccessor` (so you can `ix.get(...)` directly) and owns sinon (so `dispose()` restores stubs).

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { registerRecordsServices } from '../records/stubs';

describe('XxxService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerRecordsServices],
      additionalServices: (reg) => {
        reg.define(IContextService, ContextService);   // 1. real collaborator, by interface
        reg.define(IXxxService, XxxService);           // 2. system under test, by interface
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('does the thing', () => {
    const svc = ix.get(IXxxService);                 // 3. resolve by interface
    expect(svc.thing()).toBe('…');
  });
});
```

`createServices` builds the container from domain **service groups** plus per-test overrides (see Service groups). Reach for `ix.stub(...)` / `ix.set(...)` directly only inside an `it` when a single test needs to swap a registration:

- whole service, partial object: `ix.stub(IId, { method() { return … } })`;
- single method: `ix.stub(IId, 'method', value)` returns a sinon stub; `ix.spy(IId, 'method')` returns a spy;
- a prebuilt instance or descriptor: `ix.set(IId, instance)` / `ix.set(IId, new SyncDescriptor(Impl))`;
- when a collaborator's behavior must vary per test, model it as a `Test*Service` subclass whose methods read suite-scoped `let` variables rather than rebuilding the container each test.

### Scope harness — `createScopedTestHost`

Reach for this only when *which layer a service lives in* is itself the thing being asserted, or when the SUT reads from parent/child scopes. It builds the real `Scope` tree and resolves through it.

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';

describe('XxxService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Agent,
      IXxxService,
      XxxService,
      InstantiationType.Delayed,
      'xxx',
    );
  });

  it('resolves from the Agent scope with ancestor deps injected', () => {
    const host = createScopedTestHost([stubPair(ILogService, stubLog())]);
    const agent = host.child(LifecycleScope.Agent, 'main');
    const svc = agent.accessor.get(IXxxService);   // by interface
    expect(svc.thing()).toBe('…');
    host.dispose();
  });
});
```

Always `_clearScopedRegistryForTests()` and re-register explicitly in `beforeEach`. Do not rely on a production module's top-level `registerScopedService(...)` side effect: import order then becomes part of the test, and another suite's `_clearScopedRegistryForTests()` can wipe it.

## Register the SUT by interface

Whichever harness you use, the SUT is registered under its interface (`ix.set(IX, new SyncDescriptor(Impl))` or `registerScopedService(scope, IX, Impl, …)`) and resolved by that interface. This is non-negotiable: it is the only thing that keeps the production registration honest.

A test that does `ix.createInstance(Impl)` is testing the class, not the service. Convert those (see Migration).

## Shared stubs

Hand-rolled stubs (`noopLog`, `noneEvent`, `unusedRecords`, …) must not be copied between test files. Each domain that owns a frequently-stubbed interface exports a stub from a `stubs.ts` **in the `test/` tree**, never from `src/`:

```text
test/log/stubs.ts         →  stubLog() / stubLogger()
test/turn/stubs.ts        →  stubTurn()
test/records/stubs.ts     →  stubAgentRecords()
test/environment/stubs.ts →  stubEnvironment()
```

All test support lives under `test/` so test-only code stays out of the production source tree. Because `tsdown` builds from `src/index.ts`, anything under `test/` is unreachable from the entry and is never bundled into `dist/`.

Conventions:

- export a **factory** (`stubXxx()`), not a shared singleton, so tests cannot leak state through a stub;
- name it `stub<Interface>` — e.g. `stubAgentRecords`;
- the stub satisfies the full interface so the compiler, not a cast, guarantees it stays in sync;
- import it with a **relative path** — `./stubs` from the same domain's tests, `../<domain>/stubs` from another domain. Never import stubs from `#/…` (that alias is for production `src/`) and never import one test file from another;
- a `stubs.ts` may import its domain's production types via `#/<domain>/…`.

If a stub is needed by two test files, it belongs in that domain's `test/<domain>/stubs.ts`.

## Service groups

Most unit tests stub the same handful of collaborators (`ILogService`, `IAgentRecords`, `IConfigService`, `ITelemetryService`, …). Rather than repeat `ix.stub(...)` lines in every `beforeEach`, each domain exports a `register*Services` function from its `stubs.ts` that registers the default test doubles for that domain:

```ts
// test/log/stubs.ts
export function registerLogServices(reg: ServiceRegistration): void {
  reg.defineInstance(ILogService, stubLog());
}
```

`createServices(disposables, { base, additionalServices })` composes them:

- `base` — an ordered list of service groups. Each group's registrations are deduped (first writer wins), so groups supply safe defaults without clobbering each other.
- `additionalServices` — applied after `base`. Registrations here **overwrite** any base default, so a test can swap a stub for a spy, register the system under test, or supply a one-off collaborator.

```ts
ix = createServices(disposables, {
  base: [registerLogServices, registerConfigServices, registerRecordsServices],
  additionalServices: (reg) => {
    reg.definePartialInstance(IAgentKaos, {});        // one-off collaborator
    reg.define(IAgentRecords, spyRecords);             // override a base default
    reg.define(IXxxService, XxxService);               // system under test
  },
});
```

`ServiceRegistration` offers three verbs:

- `define(id, Ctor)` — lazy `SyncDescriptor`; the service is instantiated on first resolve. Use for real collaborators and the system under test.
- `defineInstance(id, instance)` — a fully-built instance (a fake such as `stubLog()`, or `new ConfigRegistry()`).
- `definePartialInstance(id, { ... })` — a partial mock; only the supplied members are provided. Use for collaborators the test does not exercise.

Conventions:

- a group registers the domain's services **as dependencies** (a fake, or a `{}` partial when no fake exists yet). When a service is the system under test, the test registers the real implementation via `additionalServices` and does not rely on the group's default for it;
- keep groups small and domain-local. A service that is almost always the system under test, or that every consumer configures differently, should not have a group — register it inline via `additionalServices`;
- import groups with a **relative path** (`../<domain>/stubs`), never from `#/…`.

`createServices` defaults to `strict: false` (missing dependencies warn rather than throw), matching `new TestInstantiationService()`. Pass `strict: true` to surface unregistered `@IService` dependencies.

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

Because the decorator runs when the class is defined, the `createDecorator` identifier must be initialized **before** the class that uses it. Declare the identifier, then the class:

```ts
const IDep = createDecorator<IDep>('dep');
class Consumer {
  constructor(@IDep private readonly dep: IDep) {}
}
```

For two services that depend on each other (a cycle), declare both identifiers first, then both classes, so neither class references an uninitialized binding.

Declare fixtures at module top, interface + decorator + implementation co-located, and keep `_serviceBrand` on the interface when it represents a real service — `GetLeadingNonServiceArgs` relies on the brand to tell service parameters apart from static ones. Pure throwaway fixtures may omit `_serviceBrand`.

## Lifecycle / teardown

One `DisposableStore` per suite. Add the **container** and any event subscriptions to it; dispose in `afterEach`.

```ts
beforeEach(() => { disposables = new DisposableStore(); /* … */ });
afterEach(() => disposables.dispose());
```

Do **not** add the system-under-test itself to the store. `TestInstantiationService` disposes every service it creates when the container is disposed, so `ix.get(IX)` instances are cleaned up automatically via `disposables.add(ix)`. Wrapping the SUT in `disposables.add(...)` would double-dispose it. For the same reason, do not call `svc.dispose()` at the end of a test unless you are asserting something about disposal itself.

Scope-host tests call `host.dispose()` in `afterEach` (or at the end of the `it`). Route teardown through the store so ordering is deterministic and nothing leaks when a test fails mid-way.

## Assertions and naming

- One behavior per `it`; describe observable behavior (`child shadows parent registration`), not implementation (`calls _getOrCreateServiceInstance`).
- For cycles, assert `CyclicDependencyError` and its `path` array (e.g. `['A', 'B', 'A']`), not merely `toThrow`.
- For disposal order, capture events in an array and assert the sequence (`['C', 'B', 'A']` — children before parents).

## Migrating existing tests

Most legacy tests build the SUT with `ix.createInstance(Impl)`. Converting one is mechanical:

1. import the interface (`IX`) and the descriptor;
2. register the SUT by interface — `reg.define(IX, Impl)` inside `additionalServices` (or `ix.set(IX, new SyncDescriptor(Impl))`);
3. replace `ix.createInstance(Impl)` with `ix.get(IX)`;
4. drop the `disposables.add(...)` wrapper around the SUT and any trailing `svc.dispose()` — the container disposes it;
5. replace any hand-rolled collaborator object with the domain's shared stub or service group (or add one to `test/<domain>/stubs.ts` if it does not exist);
6. delete now-unused imports.

Before / after:

```ts
// before
const svc = ix.createInstance(MessageService);

// after — registration in beforeEach additionalServices
reg.define(IMessageService, MessageService);
// after — resolution in the test body
const svc = ix.get(IMessageService);
```

## Red lines (this stage)

- Resolve the SUT by interface — never `new` a production service with `@IService` deps; prefer `ix.get(IX)` over `ix.createInstance(Impl)`.
- Shared stubs live in `test/<domain>/stubs.ts` (never `src/`); import by relative path, never `#/...`.
- Scope tests call `_clearScopedRegistryForTests()` and re-register explicitly in `beforeEach`; do not rely on production import-order side effects.
- One `DisposableStore` per suite; add the container, dispose in `afterEach`; do not add the SUT itself.
- Declare fixture dependencies with `@IService`; initialize `createDecorator` identifiers before the classes that use them.
