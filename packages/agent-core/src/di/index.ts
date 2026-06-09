/**
 * Barrel for `@moonshot-ai/agent-core` DI subsystem. This file is the only
 * surface that should be imported from outside the `di/` directory.
 *
 * Modelled after VSCode's `vs/platform/instantiation`. See `./README.md` for
 * usage (lands in W2.5).
 */

export type {
  ServiceIdentifier,
  ServicesAccessor,
  ServiceCollectionLike,
  BrandedService,
  GetLeadingNonServiceArgs,
} from './instantiation';
export {
  createDecorator,
  refineServiceDecorator,
  // Re-export `IInstantiationService` as a regular export — this single
  // binding carries BOTH the interface (type position) and the
  // ServiceIdentifier value (value position) declared under the same name
  // in `./instantiation.ts`, so consumers can write either `: IInstantiationService`
  // or `accessor.get(IInstantiationService)`.
  IInstantiationService,
} from './instantiation';
export { InstantiationType, SyncDescriptor, SyncDescriptor0 } from './descriptors';
export { ServiceCollection } from './serviceCollection';
export { InstantiationService } from './instantiationService';
export {
  Disposable,
  DisposableStore,
  MutableDisposable,
  combinedDisposable,
  toDisposable,
} from './lifecycle';
export type { IDisposable } from './lifecycle';
export { CyclicDependencyError } from './errors';
export {
  registerSingleton,
  getSingletonServiceDescriptors,
  _clearRegistryForTests,
} from './extensions';
