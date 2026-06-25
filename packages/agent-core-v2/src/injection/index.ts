/**
 * `injection` domain barrel — re-exports the injection contract
 * (`injection`) and its scoped service (`injectionService`). Importing this
 * barrel registers the `IInjectionService` and `IInjectionQueue` bindings into
 * the scope registry.
 */

export * from './injection';
export * from './injectionService';
