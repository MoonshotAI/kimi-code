/**
 * `workspaceContext` domain barrel — re-exports the workspace-context
 * contract (`workspaceContext`) and its scoped service
 * (`workspaceContextService`). Importing this barrel registers the
 * `IWorkspaceContext` binding into the scope registry.
 */

export * from './workspaceContext';
export * from './workspaceContextService';
