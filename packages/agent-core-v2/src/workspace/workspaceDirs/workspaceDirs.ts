import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';

export interface WorkspaceAddDirInput {
  readonly path: string;
  readonly persist?: boolean;
}

export interface WorkspaceAdditionalDirsResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
  readonly persisted: boolean;
}

export interface IWorkspaceDirs {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly additionalDirs: readonly string[];
  readonly onDidChange: Event<void>;
  addDir(input: WorkspaceAddDirInput): Promise<WorkspaceAdditionalDirsResult>;
  mergeAdditionalDirs(baseDir: string, dirs: readonly string[]): Promise<void>;
  sessionInfo(): ISessionWorkspaceInfo;
}

export const IWorkspaceDirs: ServiceIdentifier<IWorkspaceDirs> =
  createDecorator<IWorkspaceDirs>('workspaceDirs');
