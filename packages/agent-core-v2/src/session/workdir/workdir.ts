import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';
import type { IWorkspaceGitService } from '#/workspace/workspaceGit/workspaceGit';

export interface ISessionWorkdir {
  readonly _serviceBrand: undefined;

  readonly environmentId: string;
  readonly cwd?: string;
  readonly fs: IWorkspaceFsService;
  readonly git?: IWorkspaceGitService;
}

export const ISessionWorkdir: ServiceIdentifier<ISessionWorkdir> =
  createDecorator<ISessionWorkdir>('sessionWorkdir');
