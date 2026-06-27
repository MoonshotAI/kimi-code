/**
 * `hostFs` domain barrel — re-exports the host-filesystem contract
 * (`hostFs`) and its scoped service (`hostFsService`). Importing this barrel
 * registers the `IHostFileSystem` binding into the scope registry.
 */

export * from './hostFs';
export * from './hostFsService';
