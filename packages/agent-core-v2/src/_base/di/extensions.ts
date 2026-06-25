/**
 * `di` domain (L0) — module-global singleton registry (`registerSingleton` / `getSingletonServiceDescriptors`).
 */

import { SyncDescriptor } from './descriptors';
import type { BrandedService, ServiceIdentifier } from './instantiation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _registry: Array<[ServiceIdentifier<any>, SyncDescriptor<any>]> = [];

export enum InstantiationType {
  Eager = 0,
  Delayed = 1,
}

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

export function getSingletonServiceDescriptors(): ReadonlyArray<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [ServiceIdentifier<any>, SyncDescriptor<any>]
> {
  return _registry;
}

export function _clearRegistryForTests(): void {
  _registry.length = 0;
}
