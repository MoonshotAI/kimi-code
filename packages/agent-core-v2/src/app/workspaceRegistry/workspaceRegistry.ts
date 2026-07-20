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

export interface IWorkspaceRegistry {
  readonly _serviceBrand: undefined;

  list(): Promise<readonly Workspace[]>;
  get(id: string): Promise<Workspace | undefined>;
  /**
   * Every persisted id that addresses the same physical directory as `id`:
   * registered entries whose `workspaceRootKey` identity matches, plus
   * session-index-only spellings (`session_index.jsonl` workDirs never seen by
   * the registry, i.e. legacy split buckets). Read-only — ids/buckets are never
   * rewritten. An unknown `id` resolves to `[id]` so callers keep their
   * existing not-found semantics.
   */
  resolveAliasIds(id: string): Promise<readonly string[]>;
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
