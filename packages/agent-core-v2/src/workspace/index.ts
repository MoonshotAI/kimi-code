/**
 * `workspace` domain barrel — re-exports the workspace contract (`workspace`)
 * and its scoped services (`workspaceService`). Importing this barrel registers
 * the `IWorkspaceRegistry` and `IWorkspaceFsService` bindings into the scope
 * registry.
 */

export * from './workspace';
export * from './workspaceService';
