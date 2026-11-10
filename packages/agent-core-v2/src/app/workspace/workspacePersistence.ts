import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { Workspace } from './workspace';

export interface PersistedWorkspaceEntry {
  readonly root: string;
  readonly name: string;
  readonly kind?: string;
  readonly additional_dirs?: readonly string[];
  readonly created_at: string;
  readonly last_opened_at: string;
}

export interface PersistedWorkspaceFile {
  readonly version?: number;
  readonly workspaces: Record<string, PersistedWorkspaceEntry>;
  readonly deleted_workspace_ids: string[];
  readonly idempotency_keys?: Record<string, string>;
}

export interface PersistedWorkspaceMigration {
  readonly source_file: string;
  readonly source_version?: number;
  readonly source_sha256: string;
  readonly migrated_at: string;
}

export interface PersistedProjectsFile {
  readonly schema_version: number;
  readonly projects: Record<string, PersistedWorkspaceEntry>;
  readonly deleted_project_ids: string[];
  readonly idempotency_keys?: Record<string, string>;
  readonly migration?: PersistedWorkspaceMigration;
}

export interface WorkspaceCatalog {
  readonly workspaces: readonly Workspace[];
  readonly deletedIds: readonly string[];
  readonly idempotencyKeys?: Readonly<Record<string, string>>;
}

export type WorkspaceCatalogMutator = (
  current: WorkspaceCatalog,
) => WorkspaceCatalog | Promise<WorkspaceCatalog>;

export interface IWorkspacePersistence {
  readonly _serviceBrand: undefined;

  readonly onDidChange: Event<void>;

  load(): Promise<WorkspaceCatalog | undefined>;
  update(mutator: WorkspaceCatalogMutator): Promise<void>;
}

export const IWorkspacePersistence: ServiceIdentifier<IWorkspacePersistence> =
  createDecorator<IWorkspacePersistence>('workspacePersistence');
