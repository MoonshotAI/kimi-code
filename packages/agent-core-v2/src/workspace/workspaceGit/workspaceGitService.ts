import { ref, type LiveRef } from '#/_base/di/instantiation';
import { type FsDiffResponse, type FsGitStatusResponse, type GitStatusOptions, IGitService } from '#/app/git/git';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { IWorkspaceGitService } from './workspaceGit';

export class WorkspaceGitService implements IWorkspaceGitService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @ref(IGitService) private readonly git: LiveRef<IGitService>,
  ) {}

  status(cwd: string, options?: GitStatusOptions): Promise<FsGitStatusResponse> {
    return this.git.current!.status(cwd, options);
  }

  diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse> {
    return this.git.current!.diff(cwd, relPath, absPath);
  }
}

