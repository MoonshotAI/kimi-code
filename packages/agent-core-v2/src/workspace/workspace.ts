/**
 * `workspace` domain (cross-cutting) — core-scope workspace registry + fs.
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
