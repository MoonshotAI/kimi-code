/**
 * `TestInstantiationService` — a test-friendly extension of
 * `InstantiationService` that exposes direct `get` / `set` / `stub`
 * helpers so test bodies don't have to thread an `invokeFunction(a => …)`
 * accessor through every assertion.
 *
 * Adapted from krow `testInstantiationService.ts` (in turn the VSCode
 * original). Two divergences from krow:
 *
 *   1. **Ctor signature**: follows the runtime container's VS Code order
 *      `(services, strict, parent, _enableTracing)`.
 *   2. **`createServices` factory**: krow uses `DisposableStore` /
 *      `toDisposable` from `base/`. kimi's `Disposable` class is a
 *      different shape (LIFO subdisposable owner, not a Set). The factory
 *      is therefore omitted from the initial port — `TestInstantiationService`
 *      alone covers >95% of the test surface daemon will need in Phase 2.
 *      Add `createServices` if/when a test fixture needs it.
 *
 * Exported via the subpath barrel `@moonshot-ai/agent-core/di/test` so
 * the main `@moonshot-ai/agent-core` entry stays free of test-only code
 * (no test code leaks into the daemon bundle).
 */

import { SyncDescriptor } from './descriptors';
import {
  type ServiceIdentifier,
  type ServicesAccessor,
} from './instantiation';
import { InstantiationService, Trace } from './instantiationService';
import { ServiceCollection } from './serviceCollection';

/**
 * A test-friendly extension of {@link InstantiationService}.
 *
 * Convenience surface for tests:
 *  - {@link get} — directly resolve a service without going through an
 *    accessor.
 *  - {@link set} — register or replace a service instance / descriptor.
 *  - {@link stub} — semantic alias for {@link set}, intended for test
 *    overrides where the intent is "replace the real impl with a mock".
 *  - {@link createChild} — return a child `TestInstantiationService`
 *    (krow returns `IInstantiationService`; we narrow to the test type so
 *    callers can keep calling `.stub` / `.get` on the child).
 *
 * Example:
 * ```ts
 * import { TestInstantiationService } from '@moonshot-ai/agent-core/di/test';
 *
 * const ix = new TestInstantiationService();
 * ix.stub(ILogger, { log: vi.fn() } as ILogger);
 * const target = ix.createInstance(SomeClass, 'static-arg');
 * ```
 */
export class TestInstantiationService extends InstantiationService implements ServicesAccessor {
  private readonly _serviceCollection: ServiceCollection;

  constructor(
    serviceCollection: ServiceCollection = new ServiceCollection(),
    strict: boolean = false,
    parent?: InstantiationService,
    enableTracing: boolean = false,
  ) {
    super(serviceCollection, strict, parent, enableTracing);
    this._serviceCollection = serviceCollection;
  }

  /**
   * Directly resolve a service. Calls the protected
   * `_getOrCreateServiceInstance` on the base class with a no-op
   * `Trace._None`-equivalent (`Trace.traceCreation(false, …)` returns the
   * sentinel) so the public test API matches accessor.get semantics
   * without forcing every test to open an `invokeFunction` closure.
   */
  public get<T>(id: ServiceIdentifier<T>): T {
    return super._getOrCreateServiceInstance(
      id,
      Trace.traceCreation(false, TestInstantiationService),
    );
  }

  /**
   * Register or replace a service instance in the underlying collection.
   * Accepts a pre-built instance OR a `SyncDescriptor` for lazy
   * construction.
   *
   * Returns the previous binding (or `undefined` if none) so test
   * fixtures can save-and-restore.
   */
  public set<T>(
    id: ServiceIdentifier<T>,
    instanceOrDescriptor: T | SyncDescriptor<T>,
  ): T | SyncDescriptor<T> | undefined {
    return this._serviceCollection.set(id, instanceOrDescriptor);
  }

  /**
   * Semantic alias for {@link set}. Use this in tests when you want to
   * *override* an existing service with a mock or stub — the verb makes
   * intent obvious at the call site.
   */
  public stub<T>(
    id: ServiceIdentifier<T>,
    instanceOrDescriptor: T | SyncDescriptor<T>,
  ): T | SyncDescriptor<T> | undefined {
    return this.set(id, instanceOrDescriptor);
  }

  /**
   * Create a child `TestInstantiationService` that inherits services from
   * this one. The return type is narrowed from `IInstantiationService`
   * to `TestInstantiationService` so chained test calls (`.stub`, `.get`)
   * remain ergonomic on the child.
   */
  public override createChild(services: ServiceCollection): TestInstantiationService {
    if (!(services instanceof ServiceCollection)) {
      throw new TypeError(
        'createChild requires a ServiceCollection instance (got something else)',
      );
    }
    const child = new TestInstantiationService(services, false, this);
    // The base class tracks children for cascade-dispose via its private
    // `_children` set; we mirror by relying on the parent's `_children`
    // being populated through the base ctor's parent reference. But the
    // base `createChild` we shadow here also registered the child into
    // `_children` — we duplicate that registration manually because the
    // `super.createChild` call would have built an `InstantiationService`
    // (not `TestInstantiationService`).
    (this as unknown as { _children: Set<InstantiationService> })._children.add(child);
    return child;
  }
}
