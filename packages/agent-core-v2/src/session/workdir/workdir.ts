import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import type { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';

export interface ISessionWorkdir {
  readonly _serviceBrand: undefined;

  readonly environmentId: string;
  readonly cwd?: string;
  readonly fs: IWorkspaceFsService;
  readonly dirs: IWorkspaceDirs;
}

export const ISessionWorkdir: ServiceIdentifier<ISessionWorkdir> =
  createDecorator<ISessionWorkdir>('sessionWorkdir');
