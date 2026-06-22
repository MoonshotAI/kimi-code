/**
 * Process-wide registry for scoped services (Pattern 1 of the di-v3 scope
 * mechanism) plus the `registerScopedService` entry point.
 *
 * Normative source:
 * `.agents/skills/service-skill/explanation/scope-mechanism.md`
 * (`ScopeRegistry`, `registerScopedService`).
 *
 * Shape: `Map<LifecycleScope, Map<ServiceId, SyncDescriptor>>`. Each scope owns
 * a table of `id -> SyncDescriptor`. Writes are lazy — only the descriptor is
 * stored, nothing is instantiated. `ScopeBuilder` (P1.3) is the sole reader;
 * business code registers, it never reads.
 *
 * The registry is a module-level singleton: one per process, permanent for the
 * lifetime of the process. A test-only reset exists so cases stay isolated.
 */

import { SyncDescriptor } from '../di/descriptors';
import type { ServiceIdentifier } from '../di/instantiation';
import { InstantiationType, registerSingleton } from '../di/extensions';
import { LifecycleScope } from './lifecycle';

/**
 * Read entry for a single scope's table: the service id paired with the
 * descriptor `ScopeBuilder` installs into the scope's `ServiceCollection`.
 */
export type ScopedServiceEntry = readonly [
  ServiceIdentifier<unknown>,
  SyncDescriptor<unknown>,
];

/**
 * Process-wide, two-level registry of scoped service descriptors.
 *
 * Lazy: `register` stores the `SyncDescriptor` only — it never `new`s the
 * service. Instantiation happens later, inside the scope's child
 * `InstantiationService`.
 */
export class ScopeRegistry {
  private readonly tables = new Map<
    LifecycleScope,
    Map<ServiceIdentifier<unknown>, SyncDescriptor<unknown>>
  >();

  /**
   * Write `descriptor` for `id` under `scope`, overwriting any prior entry
   * (last-write-wins). Does not instantiate.
   */
  register<T>(
    scope: LifecycleScope,
    id: ServiceIdentifier<T>,
    descriptor: SyncDescriptor<T>,
  ): void {
    let table = this.tables.get(scope);
    if (table === undefined) {
      table = new Map<ServiceIdentifier<unknown>, SyncDescriptor<unknown>>();
      this.tables.set(scope, table);
    }
    table.set(id as ServiceIdentifier<unknown>, descriptor as SyncDescriptor<unknown>);
  }

  /** True if `id` is already registered under `scope`. */
  has<T>(scope: LifecycleScope, id: ServiceIdentifier<T>): boolean {
    return this.tables.get(scope)?.has(id as ServiceIdentifier<unknown>) ?? false;
  }

  /**
   * Snapshot of the `(id, descriptor)` entries registered under `scope`.
   * Empty when the scope has no registrations. This is the read entry point
   * for `ScopeBuilder`; business code must not consume it.
   */
  descriptors(scope: LifecycleScope): ReadonlyArray<ScopedServiceEntry> {
    const table = this.tables.get(scope);
    if (table === undefined) {
      return [];
    }
    return Array.from(table.entries());
  }

  /** Test-only: drop every scope table. */
  clear(): void {
    this.tables.clear();
  }
}

/** The single process-wide registry instance. */
export const scopeRegistry = new ScopeRegistry();

/**
 * Set on the first `ScopeBuilder.build()`. After it flips, further
 * registrations are rejected (warn + ignore) because the already-built
 * collection will not re-read the registry.
 */
let built = false;

/** Called by `ScopeBuilder.build()` (P1.3) on its first invocation. */
export function markBuilt(): void {
  built = true;
}

/** True once the first `ScopeBuilder.build()` has run. */
export function isBuilt(): boolean {
  return built;
}

function warn(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[registerScopedService] ${message}`);
}

/**
 * Register a service implementation under `id` for a given `scope`.
 *
 * Behavior contract (per scope-mechanism.md):
 *
 * 1. **Lazy write**: stores `new SyncDescriptor(ctor, [], supportsDelayed)`
 *    under `(scope, id)`; nothing is instantiated.
 * 2. **Core alias**: `registerScopedService(Core, id, ctor, type)` routes
 *    straight to the existing `registerSingleton(id, ctor, type)` — reuse, not
 *    duplication — so all five scopes share one registration API.
 * 3. **Duplicate, last-write-wins + warn**: re-registering the same
 *    `(scope, id)` warns and overwrites.
 * 4. **`{ replace: true }`**: silent overwrite (plugin overriding builtin).
 * 5. **After first build**: registration warns and is ignored — the built
 *    collection will not re-read the registry.
 */
export function registerScopedService<T>(
  scope: LifecycleScope,
  id: ServiceIdentifier<T>,
  ctor: new (...args: never[]) => T,
  type: InstantiationType,
  options?: { replace?: boolean },
): void {
  if (built) {
    warn(
      `registration of ${String(id)} in scope "${scope}" happened after the first ` +
        `ScopeBuilder.build(); ignoring because the built collection will not re-read the registry`,
    );
    return;
  }

  // Core scope is an alias for the existing singleton registry.
  if (scope === LifecycleScope.Core) {
    registerSingleton(id, ctor, type);
    return;
  }

  if (!options?.replace && scopeRegistry.has(scope, id)) {
    warn(
      `duplicate registration of ${String(id)} in scope "${scope}"; last write wins`,
    );
  }

  const descriptor = new SyncDescriptor<T>(
    ctor as new (...args: unknown[]) => T,
    [],
    type === InstantiationType.Delayed,
  );
  scopeRegistry.register(scope, id, descriptor);
}

/**
 * Read the descriptors registered under `scope`. Used by `ScopeBuilder`
 * (P1.3) to install statically registered services into the scope.
 */
export function getScopedServiceDescriptors(
  scope: LifecycleScope,
): ReadonlyArray<ScopedServiceEntry> {
  return scopeRegistry.descriptors(scope);
}

/**
 * Test-only escape hatch: clear every scope table and reset the `built` flag.
 * Real code must never call this — registrations are permanent for the
 * lifetime of the process.
 */
export function _resetScopeRegistryForTests(): void {
  scopeRegistry.clear();
  built = false;
}
