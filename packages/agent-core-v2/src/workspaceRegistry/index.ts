/**
 * `workspaceRegistry` domain barrel — re-exports the workspace-registry
 * contract (`workspaceRegistry`) and its scoped service
 * (`workspaceRegistryService`). Importing this barrel registers the
 * `IWorkspaceRegistry` binding into the scope registry.
 */

export * from './workspaceRegistry';
export * from './workspaceRegistryService';
