/**
 * `workspaceGit` domain — handler-root-bound git facade contract.
 *
 * Defines the `IWorkspaceGitService`, a thin facade over the App-scope
 * `IGitService` pinned to this handler's workspace root: callers pass
 * repo-relative paths only, never a `cwd`. Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { FsDiffResponse, FsGitStatusResponse } from '#/app/git/git';

export interface IWorkspaceGitService {
  readonly _serviceBrand: undefined;

  status(pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse>;
  diff(relPath: string, absPath: string): Promise<FsDiffResponse>;
}

export const IWorkspaceGitService: ServiceIdentifier<IWorkspaceGitService> =
  createDecorator<IWorkspaceGitService>('workspaceGitService');
