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

export interface PersistedWorkspaceEntry {
  readonly root: string;
  readonly name: string;
  readonly created_at: string;
  readonly last_opened_at: string;
}

export interface PersistedWorkspaceFile {
  readonly version: number;
  readonly workspaces: Record<string, PersistedWorkspaceEntry>;
}

export interface IWorkspacePersistence {
  readonly _serviceBrand: undefined;

  load(): Promise<Workspace[] | undefined>;
  save(workspaces: readonly Workspace[]): Promise<void>;
}

export const IWorkspacePersistence: ServiceIdentifier<IWorkspacePersistence> =
  createDecorator<IWorkspacePersistence>('workspacePersistence');
