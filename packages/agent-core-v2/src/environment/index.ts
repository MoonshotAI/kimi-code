/**
 * `environment` domain barrel — re-exports the `environment` contract and its
 * scoped service (`environmentService`). Importing this barrel registers the
 * `IEnvironmentService` binding into the scope registry.
 */

export * from './environment';
export * from './environmentService';
