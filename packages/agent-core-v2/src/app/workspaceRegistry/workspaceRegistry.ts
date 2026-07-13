/**
 * `workspaceRegistry` domain (L1) — process-wide catalog of known workspaces.
 *
 * Defines the `IWorkspaceRegistry` used by the program side to remember the
 * folders the user has opened (backed by the app's own persistence). This is
 * a host-side catalog, distinct from the session-scoped `workspaceContext`
 * that describes one Agent's active work directory. App-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface Workspace {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  /** Epoch ms when the workspace was first registered in this process. */
  readonly createdAt: number;
  /** Epoch ms of the most recent `createOrTouch` (open) for this workspace. */
  readonly lastOpenedAt: number;
}

export interface WorkspaceUpdate {
  readonly name?: string;
}

export interface IWorkspaceRegistry {
  readonly _serviceBrand: undefined;

  list(): Promise<readonly Workspace[]>;
  get(id: string): Promise<Workspace | undefined>;
  /**
   * Register (or refresh `lastOpenedAt` for) a workspace rooted at `root`.
   * Throws `fs.path_not_found` when `root` is missing or not a directory —
   * callers opening a session must ensure the directory exists first.
   */
  createOrTouch(root: string, name?: string): Promise<Workspace>;
  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined>;
  delete(id: string): Promise<void>;
}

export const IWorkspaceRegistry: ServiceIdentifier<IWorkspaceRegistry> =
  createDecorator<IWorkspaceRegistry>('workspaceRegistry');
