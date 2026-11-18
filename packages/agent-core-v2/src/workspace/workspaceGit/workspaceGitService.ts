import { ref, type LiveRef } from '#/_base/di/instantiation';
import { type FsDiffResponse, type FsGitStatusResponse, type FsPullRequest, type GitStatusOptions, IGitService } from '#/app/git/git';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';

import { IWorkspaceGitService } from './workspaceGit';

export class WorkspaceGitService implements IWorkspaceGitService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceDirs private readonly dirs: Pick<IWorkspaceDirs, 'primary'>,
    @ref(IGitService) private readonly git: LiveRef<IGitService>,
  ) {}

  status(pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse> {
    return this.git.current!.status(this.dirs.primary, { pathFilter });
  }

  statusAt(cwd: string, options?: GitStatusOptions): Promise<FsGitStatusResponse> {
    return this.git.current!.status(cwd, options);
  }

  pullRequestAt(cwd: string): Promise<FsPullRequest | null> {
    return this.git.current!.pullRequest(cwd);
  }

  diff(relPath: string, absPath: string): Promise<FsDiffResponse> {
    return this.git.current!.diff(this.dirs.primary, relPath, absPath);
  }

  diffAt(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse> {
    return this.git.current!.diff(cwd, relPath, absPath);
  }
}
