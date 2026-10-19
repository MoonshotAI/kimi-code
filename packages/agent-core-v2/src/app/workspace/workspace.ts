import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface Workspace {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface WorkspaceUpdate {
  readonly name?: string;
}

export interface IWorkspaceService {
  readonly _serviceBrand: undefined;

  list(): Promise<readonly Workspace[]>;
  get(id: string): Promise<Workspace | undefined>;
  createOrTouch(root: string, name?: string): Promise<Workspace>;
  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined>;
  delete(id: string): Promise<void>;
}

export const IWorkspaceService: ServiceIdentifier<IWorkspaceService> =
  createDecorator<IWorkspaceService>('workspaceService');
