/**
 * DI Scope layer.
 *
 * Builds a tree of `createChild` InstantiationServices on top of the base
 * container. Each scope is one of four global `LifecycleScope` layers
 * (`Core < Session < Agent < Turn`). A scope is assembled by selecting the
 * module-global scoped registry entries for its layer, seeding them (plus any
 * caller-provided context tokens) into a `ServiceCollection`, and creating a
 * child `InstantiationService` from its parent. Children resolve their own
 * services first and fall back to ancestors via `createChild` — which is what
 * lets a Turn-scope tool inject a Session-scope `ICronService`.
 *
 * See `plan/di-scope-refactor.md` §1.1 and `plan/PLAN.md` §1.
 */

import { SyncDescriptor } from './descriptors';
import { InstantiationType } from './extensions';
import type { ServiceIdentifier, ServicesAccessor, IInstantiationService } from './instantiation';
import { InstantiationService } from './instantiationService';
import { DisposableStore, type IDisposable } from './lifecycle';
import { ServiceCollection } from './serviceCollection';

/**
 * The four global scope layers. Lower-numbered layers are ancestors of
 * higher-numbered ones; a child scope's `kind` must be strictly greater than
 * its parent's.
 */
export enum LifecycleScope {
  Core = 0,
  Session = 1,
  Agent = 2,
  Turn = 3,
}

/**
 * A single module-load registration: which layer the service belongs to,
 * which `ServiceIdentifier` it is bound under, the descriptor that builds it,
 * and the owning business `domain` (used for layering validation).
 */
export interface ScopedEntry {
  readonly scope: LifecycleScope;
  readonly id: ServiceIdentifier<unknown>;
  readonly descriptor: SyncDescriptor<unknown>;
  readonly domain: string;
}

// Module-global scoped registry. Populated at import time by
// `registerScopedService(...)` calls at the bottom of each domain file.
const _scopedRegistry: ScopedEntry[] = [];

/**
 * Register a service implementation under a scope layer. Typically called at
 * module top-level (bottom of a `<domain>Service.ts` file).
 *
 * `domain` is the owning business domain and is informational at runtime; it
 * is consumed by the layering validator (see `plan/PLAN.md` §5) to reject
 * low→high imports.
 */
export function registerScopedService<T>(
  scope: LifecycleScope,
  id: ServiceIdentifier<T>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor: new (...args: any[]) => T,
  type: InstantiationType = InstantiationType.Delayed,
  domain: string = 'unknown',
): void {
  const descriptor = new SyncDescriptor<T>(
    ctor,
    [],
    type === InstantiationType.Delayed,
  );
  _scopedRegistry.push({
    scope,
    id: id as ServiceIdentifier<unknown>,
    descriptor: descriptor as SyncDescriptor<unknown>,
    domain,
  });
}

/** Return the scoped-registry entries for a single layer (live view). */
export function getScopedServiceDescriptors(scope: LifecycleScope): ReadonlyArray<ScopedEntry> {
  return _scopedRegistry.filter((entry) => entry.scope === scope);
}

/**
 * Test-only escape hatch: empty the scoped registry. Real code must never
 * call this — module-load registrations are permanent for the process.
 */
export function _clearScopedRegistryForTests(): void {
  _scopedRegistry.length = 0;
}

/** Extra entries (e.g. context tokens) seeded into a scope's collection. */
export type ScopeSeed = ReadonlyArray<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [ServiceIdentifier<any>, unknown]
>;

export interface ScopeOptions {
  /** Override the scope id (defaults to the layer name). */
  readonly id?: string;
  /** Extra entries (e.g. context tokens) seeded into this scope. */
  readonly extra?: ScopeSeed;
}

/**
 * Lightweight, read-only handle to a child scope. Higher-layer domains obtain
 * handles to lower (child) scopes via `IAgentLifecycleService` /
 * `IScopeRegistry` and reach into the child's services through `accessor`.
 */
export interface IScopeHandle {
  readonly id: string;
  readonly kind: LifecycleScope;
  readonly accessor: ServicesAccessor;
}

function buildCollection(kind: LifecycleScope, extra?: ScopeSeed): ServiceCollection {
  const collection = new ServiceCollection();
  for (const entry of _scopedRegistry) {
    if (entry.scope === kind) {
      collection.set(entry.id, entry.descriptor);
    }
  }
  if (extra) {
    for (const [id, value] of extra) {
      collection.set(id, value);
    }
  }
  return collection;
}

export class Scope implements IDisposable {
  readonly children = new Map<string, Scope>();
  readonly accessor: ServicesAccessor;

  private readonly _store = new DisposableStore();
  private _disposed = false;

  private constructor(
    readonly id: string,
    readonly kind: LifecycleScope,
    readonly instantiation: IInstantiationService,
    private readonly _parent?: Scope,
  ) {
    this.accessor = {
      get: <T>(serviceId: ServiceIdentifier<T>): T =>
        instantiation.invokeFunction((a) => a.get(serviceId)),
    };
  }

  /** Build the root (Core) scope. */
  static createCore(options: ScopeOptions = {}): Scope {
    const kind = LifecycleScope.Core;
    const collection = buildCollection(kind, options.extra);
    const instantiation = new InstantiationService(collection, true);
    return new Scope(options.id ?? 'core', kind, instantiation);
  }

  private _assertNotDisposed(): void {
    if (this._disposed) {
      throw new Error(`Scope '${this.id}' has been disposed`);
    }
  }

  /**
   * Create a child scope of `kind` under this scope. `kind` must be strictly
   * greater than this scope's `kind`. Returns the child `Scope`.
   */
  createChild(kind: LifecycleScope, id: string, options: ScopeOptions = {}): Scope {
    this._assertNotDisposed();
    if (kind <= this.kind) {
      throw new Error(
        `child scope kind ${LifecycleScope[kind]}(${kind}) must be greater than parent kind ${LifecycleScope[this.kind]}(${this.kind})`,
      );
    }
    if (this.children.has(id)) {
      throw new Error(`Scope '${this.id}' already has a child with id '${id}'`);
    }
    const collection = buildCollection(kind, options.extra);
    const childInstantiation = this.instantiation.createChild(collection);
    const child = new Scope(id, kind, childInstantiation, this);
    this.children.set(id, child);
    return child;
  }

  /** A read-only handle for parent domains to reach into this scope. */
  toHandle(): IScopeHandle {
    return { id: this.id, kind: this.kind, accessor: this.accessor };
  }

  /**
   * Dispose this scope and all of its descendants. Children are disposed
   * before this scope's own services so a child never outlives its parent.
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    const kids = Array.from(this.children.values());
    this.children.clear();
    for (const child of kids) {
      child.dispose();
    }

    this._store.dispose();
    this.instantiation.dispose();

    if (this._parent) {
      this._parent.children.delete(this.id);
    }
  }
}

/** Build the root (Core) scope. Convenience wrapper around `Scope.createCore`. */
export function createCoreScope(options: ScopeOptions = {}): Scope {
  return Scope.createCore(options);
}
