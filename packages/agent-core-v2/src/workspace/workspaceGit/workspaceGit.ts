import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { FsDiffResponse, FsGitStatusResponse, FsPullRequest, GitStatusOptions } from '#/app/git/git';

export interface IWorkspaceGitService {
  readonly _serviceBrand: undefined;

  status(cwd: string, options?: GitStatusOptions): Promise<FsGitStatusResponse>;
  pullRequest(cwd: string): Promise<FsPullRequest | null>;
  diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse>;
}

export const IWorkspaceGitService: ServiceIdentifier<IWorkspaceGitService> =
  createDecorator<IWorkspaceGitService>('workspaceGitService');
