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
 * Registrations are appended as-is. Override semantics live in the
 * `ServiceCollection` stage that consumes the registry, matching VS Code's
 * permissive module-load registry.
 */

import { SyncDescriptor } from './descriptors';
import type { BrandedService, ServiceIdentifier } from './instantiation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _registry: Array<[ServiceIdentifier<any>, SyncDescriptor<any>]> = [];

export enum InstantiationType {
  Eager = 0,
  Delayed = 1,
}

/**
 * Register a service implementation under its identifier. Typically called
 * at module top-level.
 *
 * Two call shapes are supported:
 *
 * - `registerSingleton(id, ctor, instantiationType?)` — the back-compat ctor
 *   overload. Internally wraps `ctor` in `new SyncDescriptor(ctor, [],
 *   supportsDelayedInstantiation)` where
 *   `supportsDelayedInstantiation = Boolean(instantiationType)`.
 * - `registerSingleton(id, descriptor)` — the descriptor overload. Stores the
 *   descriptor as-is; the caller owns `staticArguments` and
 *   `supportsDelayedInstantiation`.
 *
 * If `id` was previously registered, the new entry is appended. Consumers
 * that seed a `ServiceCollection` decide the effective binding by insertion
 * order.
 */
export function registerSingleton<T, Services extends BrandedService[]>(
  id: ServiceIdentifier<T>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor: new (...services: Services) => T,
  instantiationType?: InstantiationType,
): void;
export function registerSingleton<T>(
  id: ServiceIdentifier<T>,
  descriptor: SyncDescriptor<any>,
): void;
export function registerSingleton<T, Services extends BrandedService[]>(
  id: ServiceIdentifier<T>,
  ctorOrDescriptor:
    | SyncDescriptor<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | (new (...services: Services) => T),
  instantiationType?: boolean | InstantiationType,
): void {
  const descriptor =
    ctorOrDescriptor instanceof SyncDescriptor
      ? ctorOrDescriptor
      : new SyncDescriptor<T>(
          ctorOrDescriptor as new (...args: unknown[]) => T,
          [],
          Boolean(instantiationType),
        );

  _registry.push([id, descriptor]);
}

/**
 * Return the registry as a list suitable for `ServiceCollection`
 * construction.
 *
 * Shape: `ReadonlyArray<readonly [ServiceIdentifier<any>, SyncDescriptor<any>]>`
 * — two-tuple, matching VS Code's `getSingletonServiceDescriptors()`. The
 * `supportsDelayedInstantiation` flag travels on the descriptor itself, not
 * as a separate registry slot.
 *
 * The returned array is the live registry, matching VS Code.
 */
export function getSingletonServiceDescriptors(): ReadonlyArray<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [ServiceIdentifier<any>, SyncDescriptor<any>]
> {
  return _registry;
}

/**
 * Test-only escape hatch: empty the registry. Real code must never call this
 * — module-load registrations are intended to be permanent for the lifetime
 * of the process.
 */
export function _clearRegistryForTests(): void {
  _registry.length = 0;
}
