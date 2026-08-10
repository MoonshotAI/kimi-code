/**
 * `workspaceDirs` domain — Workspace-scoped additional-directory set
 * contract.
 *
 * Defines `IWorkspaceDirs`, the handler-level owner of the workspace's
 * `{root, additionalDirs[]}` set: at handler materialization it loads the
 * project-local `.kimi-code/local.toml` set; afterwards `addDir` / `removeDir`
 * mutations (persisted edits or session-caller in-memory changes) and fs watch on
 * `local.toml` (cross-process edits) refresh the set, fanning the change
 * out to every session of the handler through the `ISessionWorkspaceInfo`
 * seed (`sessionInfo()`). The set is shared by all sessions of the
 * workspace and persisted entries survive restarts; non-persisted entries
 * live in handler memory only. Bound at Workspace scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';

export interface WorkspaceAddDirInput {
  readonly path: string;
  readonly persist?: boolean;
}

export interface WorkspaceRemoveDirInput {
  readonly path: string;
  readonly forget?: boolean;
}

export interface WorkspaceAdditionalDirsResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
  readonly persisted: boolean;
}

export interface WorkspaceRemoveDirResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
  readonly forgotten: boolean;
}

export interface IWorkspaceDirs {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly additionalDirs: readonly string[];
  readonly onDidChange: Event<void>;
  addDir(input: WorkspaceAddDirInput): Promise<WorkspaceAdditionalDirsResult>;
  removeDir(input: WorkspaceRemoveDirInput): Promise<WorkspaceRemoveDirResult>;
  mergeAdditionalDirs(baseDir: string, dirs: readonly string[]): Promise<void>;
  sessionInfo(): ISessionWorkspaceInfo;
}

export const IWorkspaceDirs: ServiceIdentifier<IWorkspaceDirs> =
  createDecorator<IWorkspaceDirs>('workspaceDirs');
