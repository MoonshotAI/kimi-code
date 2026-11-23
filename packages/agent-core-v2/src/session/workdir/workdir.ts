import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IProjectFsService } from '#/project/projectFs/fs';

export interface ISessionWorkdir {
  readonly _serviceBrand: undefined;

  readonly environmentId: string;
  readonly cwd?: string;
  readonly fs: IProjectFsService;
}

export const ISessionWorkdir: ServiceIdentifier<ISessionWorkdir> =
  createDecorator<ISessionWorkdir>('sessionWorkdir');
