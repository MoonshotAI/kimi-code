/**
 * `fs` domain barrel — re-exports the filesystem contract (`fs`) and its scoped
 * services (`fsService`). Importing this barrel registers the `IFsService`,
 * `IFsSearchService`, and `IFsGitService` bindings into the scope registry.
 */

export * from './fs';
export * from './fsService';
