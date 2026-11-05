import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';
import type { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';
import type { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import type { WorkspaceEnvironmentDirsView } from '#/workspace/workspaceEnvironmentDirs/workspaceEnvironmentDirs';

export interface SessionEnvironmentWorkdir {
  readonly skills: IWorkspaceSkillCatalog;
  readonly instructions: IWorkspaceInstructionsService;
  dispose(): void;
}

export interface ISessionWorkdir {
  readonly _serviceBrand: undefined;

  readonly environmentId: string;
  readonly cwd?: string;
  readonly fs: IWorkspaceFsService;
  readonly environmentDirs: WorkspaceEnvironmentDirsView;
  acquireEnvironmentWorkdir(environmentId: string, cwd: string): Promise<SessionEnvironmentWorkdir>;
}

export const ISessionWorkdir: ServiceIdentifier<ISessionWorkdir> =
  createDecorator<ISessionWorkdir>('sessionWorkdir');
