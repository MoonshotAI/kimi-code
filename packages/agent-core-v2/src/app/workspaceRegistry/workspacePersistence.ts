/**
 * `workspaceRegistry` domain (L1) — `IWorkspacePersistence` contract.
 *
 * Domain-specific persistence Store for the known-workspaces catalog. It hides
 * the on-disk document layout (`<homeDir>/workspaces.json`, the v1-compatible
 * `{ version, workspaces: { [id]: entry } }` shape) and its serialization
 * concerns (ISO ↔ epoch-ms, record ↔ array) from the registry. The generic
 * `IAtomicDocumentStore` it builds on stays schema-agnostic.
 *
 * `load()` returns `undefined` to mean "no usable catalog". `withWriteLock()`
 * serializes a fresh load and atomic replacement across processes that share
 * the same home directory.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { Workspace } from './workspaceRegistry';

export interface PersistedWorkspaceEntry {
  readonly root: string;
  readonly name: string;
  readonly created_at: string;
  readonly last_opened_at: string;
}

export interface PersistedWorkspaceFile {
  readonly version: number;
  readonly workspaces: Record<string, PersistedWorkspaceEntry>;
  readonly deleted_workspace_ids?: readonly string[];
  readonly deleted_workspace_roots?: Readonly<Record<string, string>>;
}

export interface WorkspaceCatalog {
  readonly workspaces: readonly Workspace[];
  readonly deletedWorkspaceIds: readonly string[];
  readonly deletedWorkspaceRoots: Readonly<Record<string, string>>;
}

export interface IWorkspacePersistence {
  readonly _serviceBrand: undefined;

  load(): Promise<WorkspaceCatalog | undefined>;
  save(catalog: WorkspaceCatalog): Promise<void>;
  withWriteLock<T>(operation: () => Promise<T>): Promise<T>;
}

export const IWorkspacePersistence: ServiceIdentifier<IWorkspacePersistence> =
  createDecorator<IWorkspacePersistence>('workspacePersistence');
