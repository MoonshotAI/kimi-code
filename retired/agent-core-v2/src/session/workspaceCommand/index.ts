/**
 * `workspaceCommand` domain barrel — re-exports the workspace-command contract
 * (`workspaceCommand`) and its scoped service (`workspaceCommandService`).
 * Importing this barrel registers the `ISessionWorkspaceCommandService`
 * binding into the scope registry.
 */

export * from './workspaceCommand';
export * from './workspaceCommandService';
