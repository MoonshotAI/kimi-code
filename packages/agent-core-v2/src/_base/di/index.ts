/**
 * `di` domain barrel — re-exports the dependency-injection primitives:
 * service identifiers and decorators, descriptors, the instantiation service,
 * scope registration, the service collection, and disposable lifecycle.
 */

export * from './descriptors';
export * from './errors';
export * from './extensions';
export * from './graph';
export * from './instantiation';
export * from './instantiationService';
export * from './lifecycle';
export * from './scope';
export * from './serviceCollection';
