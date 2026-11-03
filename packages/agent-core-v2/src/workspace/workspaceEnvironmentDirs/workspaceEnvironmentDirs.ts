import type { Event } from '#/_base/event';
import type { WorkspaceEnvironmentDir } from '#/app/workspace/workspace';

export interface WorkspaceAddEnvironmentDirInput {
  readonly environmentId: string;
  readonly path: string;
  readonly persist?: boolean;
}

export interface WorkspaceEnvironmentDirsView {
  readonly dirs: readonly WorkspaceEnvironmentDir[];
  readonly onDidChange: Event<void>;
}

export interface IWorkspaceEnvironmentDirs extends WorkspaceEnvironmentDirsView {
  readonly ready: Promise<void>;
  add(input: WorkspaceAddEnvironmentDirInput): Promise<WorkspaceEnvironmentDir>;
}
