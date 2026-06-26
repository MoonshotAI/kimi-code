export type {
  ServiceIdentifier,
  ServicesAccessor,
  ServiceCollectionLike,
  BrandedService,
  IConstructorSignature,
  GetLeadingNonServiceArgs,
} from './instantiation';
export {
  createDecorator,
  refineServiceDecorator,
  IInstantiationService,
} from './instantiation';
export { SyncDescriptor } from './descriptors';
export type { SyncDescriptor0 } from './descriptors';
export { ServiceCollection } from './serviceCollection';
export { InstantiationService } from './instantiationService';
export {
  Disposable,
  DisposableStore,
  DisposableMap,
  DisposableSet,
  MutableDisposable,
  MandatoryMutableDisposable,
  RefCountedDisposable,
  ReferenceCollection,
  AsyncReferenceCollection,
  ImmortalReference,
  DisposableTracker,
  combinedDisposable,
  toDisposable,
  dispose,
  disposeIfDisposable,
  disposeOnReturn,
  thenIfNotDisposed,
  thenRegisterOrDispose,
  isDisposable,
  markAsSingleton,
  setDisposableTracker,
  trackDisposable,
  markAsDisposed,
} from './lifecycle';
export type { IDisposable, IDisposableTracker, IReference } from './lifecycle';
export { CyclicDependencyError } from './errors';
export {
  InstantiationType,
  registerSingleton,
  getSingletonServiceDescriptors,
  _clearRegistryForTests,
} from './extensions';
