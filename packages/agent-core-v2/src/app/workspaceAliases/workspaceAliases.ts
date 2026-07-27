/**
 * `workspaceAliases` domain (L2) — workspace id-spelling resolution contract.
 *
 * Defines the App-scoped `IWorkspaceAliases`: the read-side counterpart to the
 * workspace write-path folding. One physical folder may be addressable by
 * several id spellings (legacy split buckets); this service enumerates them so
 * readers can query every sibling session bucket at once. App-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IWorkspaceAliases {
  readonly _serviceBrand: undefined;

  /**
   * Every persisted id that addresses the same physical directory as `id`:
   * registered entries whose `workspaceRootKey` identity matches, plus
   * session-index-only spellings (`session_index.jsonl` workDirs never seen by
   * the workspace catalog, i.e. legacy split buckets). Read-only — ids/buckets
   * are never rewritten. An unknown `id` resolves to `[id]` so callers keep
   * their existing not-found semantics.
   */
  resolveAliasIds(id: string): Promise<readonly string[]>;
}

export const IWorkspaceAliases: ServiceIdentifier<IWorkspaceAliases> =
  createDecorator<IWorkspaceAliases>('workspaceAliases');
