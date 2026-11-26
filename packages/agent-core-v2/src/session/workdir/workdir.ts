import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IProjectFsService } from '#/project/projectFs/fs';
import type { IProjectGitService } from '#/project/projectGit/projectGit';

export interface ISessionWorkdir {
  readonly _serviceBrand: undefined;

  readonly environmentId: string;
  readonly cwd?: string;
  readonly fs: IProjectFsService;
  readonly git?: IProjectGitService;
}

export const ISessionWorkdir: ServiceIdentifier<ISessionWorkdir> =
  createDecorator<ISessionWorkdir>('sessionWorkdir');
