/**
 * `workspace` domain (cross-cutting) — core-scope workspace registry + fs.
 *
 * Defines the public contracts of workspace management: the `WorkspaceInfo`
 * model, the `IWorkspaceRegistry` used to register and look up workspaces, and
 * the `IWorkspaceFsService` used to resolve paths within a workspace.
 * Core-scoped — shared across the application.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface WorkspaceInfo {
  readonly id: string;
  readonly root: string;
}

export interface IWorkspaceRegistry {
  readonly _serviceBrand: undefined;
  register(root: string): WorkspaceInfo;
  get(id: string): WorkspaceInfo | undefined;
  list(): readonly WorkspaceInfo[];
}

export const IWorkspaceRegistry: ServiceIdentifier<IWorkspaceRegistry> =
  createDecorator<IWorkspaceRegistry>('workspaceRegistry');

export interface IWorkspaceFsService {
  readonly _serviceBrand: undefined;
  resolve(workspaceId: string, rel: string): string;
}

export const IWorkspaceFsService: ServiceIdentifier<IWorkspaceFsService> =
  createDecorator<IWorkspaceFsService>('workspaceFsService');
