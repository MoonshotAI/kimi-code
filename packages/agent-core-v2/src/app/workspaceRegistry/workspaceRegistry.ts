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
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface WorkspaceUpdate {
  readonly name?: string;
}

export interface WorkspaceRegistrySnapshot {
  readonly workspaces: readonly Workspace[];
  readonly deletedWorkspaceIds: ReadonlySet<string>;
  readonly deletedWorkspaceRoots: ReadonlyMap<string, string>;
}

export interface IWorkspaceRegistry {
  readonly _serviceBrand: undefined;

  list(): Promise<readonly Workspace[]>;
  snapshot(): Promise<WorkspaceRegistrySnapshot>;
  get(id: string): Promise<Workspace | undefined>;
  createOrTouch(root: string, name?: string): Promise<Workspace>;
  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined>;
  delete(id: string, root?: string): Promise<void>;
}

export const IWorkspaceRegistry: ServiceIdentifier<IWorkspaceRegistry> =
  createDecorator<IWorkspaceRegistry>('workspaceRegistry');
