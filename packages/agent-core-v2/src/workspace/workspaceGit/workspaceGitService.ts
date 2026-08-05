/**
 * `workspaceGit` domain — `IWorkspaceGitService` implementation.
 *
 * Delegates every call to the App-scope `IGitService` with `cwd` pinned to
 * the handler's workspace root (`IWorkspaceContext.cwd`). Owns no state.
 * Bound at Workspace scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { type FsDiffResponse, type FsGitStatusResponse, IGitService } from '#/app/git/git';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { IWorkspaceGitService } from './workspaceGit';

export class WorkspaceGitService implements IWorkspaceGitService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IGitService private readonly git: IGitService,
  ) {}

  status(pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse> {
    return this.git.status(this.workspace.cwd, pathFilter);
  }

  diff(relPath: string, absPath: string): Promise<FsDiffResponse> {
    return this.git.diff(this.workspace.cwd, relPath, absPath);
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceGitService,
  WorkspaceGitService,
  ScopeActivation.OnScopeCreated,
  'workspaceGit',
);
