/**
 * Module-global service registry. Modules (or top-level files) register their
 * service implementations at import-time via `registerSingleton`; the daemon
 * bootstrap then seeds the root `ServiceCollection` from
 * `getSingletonServiceDescriptors()`.
 *
 * Modelled after VSCode's `extensions.ts` — same shape, same intent.
 *
 * Registry shape: `Array<[ServiceIdentifier<any>, SyncDescriptor<any>]>`. Each
 * entry pairs an id with the `SyncDescriptor` that captures both the
 * constructor + static args AND the `supportsDelayedInstantiation` flag.
 * Later registrations of the same id overwrite earlier ones — override
 * semantics live in the `ServiceCollection` stage; this layer is intentionally
 * permissive so module load order can be reshuffled without surprise.
 */

import { InstantiationType, SyncDescriptor } from './descriptors';
import type { ServiceIdentifier } from './instantiation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _registry: Array<[ServiceIdentifier<any>, SyncDescriptor<any>]> = [];

/**
 * Register a service implementation under its identifier. Typically called
 * at module top-level.
 *
 * Two call shapes are supported:
 *
 * - `registerSingleton(id, ctor, instantiationType?)` — the back-compat ctor
 *   overload. Internally wraps `ctor` in `new SyncDescriptor(ctor, [],
 *   supportsDelayedInstantiation)` where
 *   `supportsDelayedInstantiation = (instantiationType === InstantiationType.Delayed)`.
 * - `registerSingleton(id, descriptor)` — the descriptor overload. Stores the
 *   descriptor as-is; the caller owns `staticArguments` and
 *   `supportsDelayedInstantiation`.
 *
 * If `id` was previously registered, the new entry replaces the old one
 * (matching VS Code semantics — no throw).
 */
export function registerSingleton<T>(
  id: ServiceIdentifier<T>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor: new (...args: any[]) => T,
  instantiationType?: InstantiationType,
): void;
export function registerSingleton<T>(
  id: ServiceIdentifier<T>,
  descriptor: SyncDescriptor<T>,
): void;
export function registerSingleton<T>(
  id: ServiceIdentifier<T>,
  ctorOrDescriptor:
    | SyncDescriptor<T>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | (new (...args: any[]) => T),
  instantiationType: InstantiationType = InstantiationType.Eager,
): void {
  const descriptor =
    ctorOrDescriptor instanceof SyncDescriptor
      ? ctorOrDescriptor
      : new SyncDescriptor<T>(
          ctorOrDescriptor,
          [],
          instantiationType === InstantiationType.Delayed,
        );

  const existing = _registry.findIndex(([existingId]) => existingId === id);
  if (existing >= 0) {
    _registry[existing] = [id, descriptor];
  } else {
    _registry.push([id, descriptor]);
  }
}

/**
 * Snapshot the registry as a list suitable for `ServiceCollection`
 * construction.
 *
 * Shape: `ReadonlyArray<readonly [ServiceIdentifier<any>, SyncDescriptor<any>]>`
 * — two-tuple, matching VS Code's `getSingletonServiceDescriptors()`. The
 * `supportsDelayedInstantiation` flag travels on the descriptor itself, not
 * as a separate registry slot.
 *
 * The returned array is a fresh shallow copy on each call: subsequent
 * registrations do not retroactively mutate prior snapshots.
 */
export function getSingletonServiceDescriptors(): ReadonlyArray<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [ServiceIdentifier<any>, SyncDescriptor<any>]
> {
  return _registry.map(([id, descriptor]) => [id, descriptor] as const);
}

/**
 * Test-only escape hatch: empty the registry. Real code must never call this
 * — module-load registrations are intended to be permanent for the lifetime
 * of the process.
 */
export function _clearRegistryForTests(): void {
  _registry.length = 0;
}
