import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';

export interface ISessionWorkdir {
  readonly _serviceBrand: undefined;

  readonly environmentId: string;
  readonly cwd?: string;
  readonly fs: IWorkspaceFsService;
}

export const ISessionWorkdir: ServiceIdentifier<ISessionWorkdir> =
  createDecorator<ISessionWorkdir>('sessionWorkdir');
