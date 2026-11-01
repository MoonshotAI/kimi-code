import { ref, type LiveRef } from '#/_base/di/instantiation';
import { type FsDiffResponse, type FsGitStatusResponse, type FsPullRequest, type GitStatusOptions, IGitService } from '#/app/git/git';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { IWorkspaceGitService } from './workspaceGit';

export class WorkspaceGitService implements IWorkspaceGitService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceContext private readonly workspace: Pick<IWorkspaceContext, 'cwd'>,
    @ref(IGitService) private readonly git: LiveRef<IGitService>,
  ) {}

  status(pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse> {
    return this.git.current!.status(this.workspace.cwd, { pathFilter });
  }

  statusAt(cwd: string, options?: GitStatusOptions): Promise<FsGitStatusResponse> {
    return this.git.current!.status(cwd, options);
  }

  pullRequestAt(cwd: string): Promise<FsPullRequest | null> {
    return this.git.current!.pullRequest(cwd);
  }

  diff(relPath: string, absPath: string): Promise<FsDiffResponse> {
    return this.git.current!.diff(this.workspace.cwd, relPath, absPath);
  }

  diffAt(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse> {
    return this.git.current!.diff(cwd, relPath, absPath);
  }
}

