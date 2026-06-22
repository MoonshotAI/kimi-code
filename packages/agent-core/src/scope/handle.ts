/**
 * Scope handle for the di-v3 scope mechanism.
 *
 * Normative source:
 * `.agents/skills/service-skill/explanation/scope-mechanism.md` (`Scope handle`,
 * `dispose()` flow + manager `onDid*` pairing).
 *
 * A `ScopeBuilder` (P1.3) returns an {@link IScopeHandle} for every scope it
 * builds. The handle is the public face of a scope: it carries the scope
 * identity (`id` / `scope`), the child container's `accessor` (used to resolve
 * services lazily), and the two dispose events that bracket teardown.
 *
 * Dispose event semantics (strong contract):
 *
 * - `onWillDispose` fires **before** the child container is torn down — scoped
 *   services are still resolvable, so listeners may snapshot / flush (final
 *   usage, transcript flush, final goal state). `dispose()` awaits every
 *   listener (including async ones) before continuing.
 * - `onDidDispose` fires **after** the child container is disposed — the data
 *   is gone. Subscribers must only update their own state and must NOT touch
 *   child services (resolving them throws because the container is disposed).
 */

import { Emitter, type Event } from '../_base/event';
import type { IInstantiationService, ServiceIdentifier } from '../_base/di';
import type { LifecycleScope } from './lifecycle';

/**
 * Read-only accessor over a scope's child container. Resolves services lazily:
 * the first `get(id)` instantiates a `SyncDescriptor`-backed service; later
 * `get`s return the cached instance. After {@link IScopeHandle.dispose} the
 * underlying container is disposed and `get` throws.
 */
export interface IServiceAccessor {
  get<T>(id: ServiceIdentifier<T>): T;
}

/**
 * Public handle returned by a `ScopeBuilder` for a built scope.
 */
export interface IScopeHandle {
  /** This scope's identity id (== the injected context's `id`). */
  readonly id: string;
  /** Which lifecycle scope this handle represents. */
  readonly scope: LifecycleScope;
  /** Lazy accessor over the scope's child container. */
  readonly accessor: IServiceAccessor;
  /** Fires before teardown; scoped services are still resolvable. Awaited. */
  readonly onWillDispose: Event<void>;
  /** Fires after teardown; scoped services are gone. Do not resolve them. */
  readonly onDidDispose: Event<void>;
  /**
   * Tears the scope down: fires `onWillDispose` (awaiting every listener),
   * disposes the child container (which disposes each scoped service in reverse
   * construction order), then fires `onDidDispose`. Idempotent.
   *
   * `reason` is accepted for forward compatibility (e.g. cancellation /
   * abort); the void events do not carry it in this version.
   */
  dispose(reason?: string): Promise<void>;
}

/**
 * Concrete {@link IScopeHandle} produced by the builders in `./builder`.
 *
 * Wraps a child `IInstantiationService`. The `accessor` resolves through the
 * child via `invokeFunction`, so resolution walks the DI parent chain and stays
 * lazy. `onWillDispose` is the stock `Emitter<void>` augmented so that async
 * listeners' returned promises are collected and awaited by `dispose()`;
 * `onDidDispose` is the stock `Emitter<void>` fired synchronously.
 */
export class ScopeHandle implements IScopeHandle {
  readonly id: string;
  readonly scope: LifecycleScope;
  readonly accessor: IServiceAccessor;
  readonly onWillDispose: Event<void>;
  readonly onDidDispose: Event<void>;

  private readonly _onWillDispose = new Emitter<void>();
  private readonly _onDidDispose = new Emitter<void>();
  /** Promises returned by async `onWillDispose` listeners, awaited in dispose. */
  private readonly _willDisposeWork: Promise<unknown>[] = [];
  private _disposed = false;

  constructor(
    scope: LifecycleScope,
    id: string,
    private readonly child: IInstantiationService,
  ) {
    this.scope = scope;
    this.id = id;

    this.accessor = {
      get: <T>(serviceId: ServiceIdentifier<T>): T =>
        child.invokeFunction((accessor) => accessor.get(serviceId)),
    };

    // Wrap the stock Emitter so async listeners' promises are captured and can
    // be awaited by dispose() — the Emitter itself only fires synchronously.
    this.onWillDispose = (listener, thisArg, disposables) =>
      this._onWillDispose.event(
        (e) => {
          const result = listener.call(thisArg, e);
          if (
            result !== null &&
            result !== undefined &&
            typeof (result as PromiseLike<unknown>).then === 'function'
          ) {
            this._willDisposeWork.push(Promise.resolve(result));
          }
        },
        undefined,
        disposables,
      );

    this.onDidDispose = this._onDidDispose.event;
  }

  async dispose(_reason?: string): Promise<void> {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    // [1] fire onWillDispose and await every listener (data still present).
    this._onWillDispose.fire();
    await Promise.allSettled(this._willDisposeWork);

    // [2] dispose the child container — DI disposes each scoped service in
    // reverse construction order, then recurses into grandchildren.
    this.child.dispose();

    // [3] fire onDidDispose synchronously (data gone).
    this._onDidDispose.fire();

    this._onWillDispose.dispose();
    this._onDidDispose.dispose();
  }

  get isDisposed(): boolean {
    return this._disposed;
  }
}
