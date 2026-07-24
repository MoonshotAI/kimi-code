/**
 * `workspace` domain (L2) — `IWorkspacePersistence` contract.
 *
 * Domain-specific persistence Store for the known-workspaces catalog. It hides
 * the on-disk document layout (`<homeDir>/workspaces.json`, the v1-compatible
 * `{ version, workspaces: { [id]: entry }, deleted_workspace_ids: string[] }`
 * shape — shared with agent-core, which reads and writes the same file) and
 * its serialization concerns (ISO ↔ epoch-ms, record ↔ array) from the
 * workspace service. The generic `IAtomicDocumentStore` it builds on stays
 * schema-agnostic.
 *
 * `deleted_workspace_ids` is the soft-delete tombstone list: ids the user
 * explicitly removed. Tombstoned entries are absent from `workspaces`, but
 * their ids must survive load/save round-trips so the session-index merge
 * never resurrects them.
 *
 * `load()` returns `undefined` to mean "no usable catalog" so the workspace
 * service can trigger a one-shot rebuild from the legacy session index; an
 * empty catalog is a valid, already-materialized state and must NOT trigger a
 * rebuild.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { Workspace } from './workspace';

export interface PersistedWorkspaceEntry {
  readonly root: string;
  readonly name: string;
  readonly created_at: string;
  readonly last_opened_at: string;
}

export interface PersistedWorkspaceFile {
  readonly version: number;
  readonly workspaces: Record<string, PersistedWorkspaceEntry>;
  readonly deleted_workspace_ids: string[];
}

export interface WorkspaceCatalog {
  readonly workspaces: readonly Workspace[];
  readonly deletedIds: readonly string[];
}

export interface IWorkspacePersistence {
  readonly _serviceBrand: undefined;

  load(): Promise<WorkspaceCatalog | undefined>;
  save(catalog: WorkspaceCatalog): Promise<void>;
}

export const IWorkspacePersistence: ServiceIdentifier<IWorkspacePersistence> =
  createDecorator<IWorkspacePersistence>('workspacePersistence');
