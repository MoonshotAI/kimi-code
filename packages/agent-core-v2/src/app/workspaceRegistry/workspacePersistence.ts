/**
 * `workspaceRegistry` domain (L1) — `IWorkspacePersistence` contract.
 *
 * Domain-specific persistence Store for the known-workspaces catalog. It hides
 * the on-disk document layout (`<homeDir>/workspaces.json`, the v1-compatible
 * `{ version, workspaces: { [id]: entry } }` shape) and its serialization
 * concerns (ISO ↔ epoch-ms, record ↔ array) from the registry. The generic
 * `IAtomicDocumentStore` it builds on stays schema-agnostic.
 *
 * `load()` returns `undefined` to mean "no usable catalog" so the registry can
 * trigger a one-shot rebuild from the legacy session index; an empty array is
 * a valid, already-materialized catalog and must NOT trigger a rebuild.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { Workspace } from './workspaceRegistry';

/** On-disk entry shape — v1 `workspaces.json` compatible (ISO timestamps). */
export interface PersistedWorkspaceEntry {
  readonly root: string;
  readonly name: string;
  readonly created_at: string;
  readonly last_opened_at: string;
}

/** On-disk document shape — v1 `workspaces.json` compatible. */
export interface PersistedWorkspaceFile {
  readonly version: number;
  readonly workspaces: Record<string, PersistedWorkspaceEntry>;
}

export interface IWorkspacePersistence {
  readonly _serviceBrand: undefined;

  /**
   * Load the persisted catalog.
   *
   * - `undefined` → no usable catalog exists (absent or malformed); the caller
   *   should rebuild.
   * - `Workspace[]` (possibly empty) → a materialized catalog; do not rebuild.
   */
  load(): Promise<Workspace[] | undefined>;
  /** Atomically replace the persisted catalog. */
  save(workspaces: readonly Workspace[]): Promise<void>;
}

export const IWorkspacePersistence: ServiceIdentifier<IWorkspacePersistence> =
  createDecorator<IWorkspacePersistence>('workspacePersistence');
