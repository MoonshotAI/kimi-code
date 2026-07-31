/**
 * `workspaceDirs` domain (L3) — Workspace-scoped additional-directory set
 * contract.
 *
 * Defines `IWorkspaceDirs`, the handler-level owner of the workspace's
 * `{root, additionalDirs[]}` set: at handler materialization it loads the
 * project-local `.kimi-code/local.toml` set; afterwards `addDir` mutations
 * (persisted appends or session-caller in-memory unions) and fs watch on
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
  /** Persist to `.kimi-code/local.toml` (default true); false keeps the dir in handler memory only. */
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
  /**
   * Union caller-provided dirs (session create/resume options, resolved
   * against `baseDir`) into the shared in-memory set — never persisted.
   */
  mergeAdditionalDirs(baseDir: string, dirs: readonly string[]): Promise<void>;
  sessionInfo(): ISessionWorkspaceInfo;
}

export const IWorkspaceDirs: ServiceIdentifier<IWorkspaceDirs> =
  createDecorator<IWorkspaceDirs>('workspaceDirs');
