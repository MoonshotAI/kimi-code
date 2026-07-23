/**
 * `workspace` domain (L2) — `FileWorkspacePersistence` implementation.
 *
 * File backend of `IWorkspacePersistence`. Persists the catalog as a single
 * v1-compatible `workspaces.json` document at the storage root
 * (`<homeDir>/workspaces.json`, via `scope = ''`) through the
 * `IAtomicDocumentStore` access-pattern Store. The `deleted_workspace_ids`
 * tombstone list round-trips with the catalog so soft deletions survive
 * regardless of which engine (v1 or v2) last wrote the file, and the parsed
 * document rides along in `WorkspaceCatalog.sourceDocument` so `save`
 * re-applies the semantic view onto it — unknown top-level and entry fields
 * written by other engine versions are preserved. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import type { Workspace } from './workspace';
import {
  IWorkspacePersistence,
  type PersistedWorkspaceEntry,
  type WorkspaceCatalog,
} from './workspacePersistence';

const WORKSPACE_CATALOG_VERSION = 1;
const WORKSPACE_CATALOG_SCOPE = '';
const WORKSPACE_CATALOG_KEY = 'workspaces.json';

export class FileWorkspacePersistence implements IWorkspacePersistence {
  declare readonly _serviceBrand: undefined;

  constructor(@IAtomicDocumentStore private readonly docs: IAtomicDocumentStore) {}

  runExclusive<T>(op: () => Promise<T>): Promise<T> {
    return this.docs.withExclusiveKeyMutation(WORKSPACE_CATALOG_SCOPE, WORKSPACE_CATALOG_KEY, op);
  }

  async load(): Promise<WorkspaceCatalog | undefined> {
    const document = await this.docs.get<Record<string, unknown>>(
      WORKSPACE_CATALOG_SCOPE,
      WORKSPACE_CATALOG_KEY,
    );
    if (!isRecord(document)) return undefined;
    const unvalidatedWorkspaces = document['workspaces'];
    if (!isRecord(unvalidatedWorkspaces)) return undefined;
    const now = Date.now();
    const workspaces: Workspace[] = [];
    for (const [id, unvalidatedEntry] of Object.entries(unvalidatedWorkspaces)) {
      const entry = sanitizeEntry(unvalidatedEntry);
      if (entry === null) continue;
      workspaces.push({
        id,
        root: entry.root,
        name: entry.name,
        createdAt: parseTime(entry.created_at, now),
        lastOpenedAt: parseTime(entry.last_opened_at, now),
      });
    }
    const unvalidatedDeletedIds = document['deleted_workspace_ids'];
    const deletedIds = Array.isArray(unvalidatedDeletedIds)
      ? unvalidatedDeletedIds.filter((id): id is string => typeof id === 'string')
      : [];
    return { workspaces, deletedIds, sourceDocument: document };
  }

  async save(catalog: WorkspaceCatalog): Promise<void> {
    const unvalidatedWorkspaces = catalog.sourceDocument['workspaces'];
    const sourceWorkspaces = isRecord(unvalidatedWorkspaces) ? unvalidatedWorkspaces : {};
    const workspaceRecord: Record<string, unknown> = {};
    for (const ws of catalog.workspaces) {
      const sourceEntry = sourceWorkspaces[ws.id];
      workspaceRecord[ws.id] = {
        ...(isPlainRecord(sourceEntry) ? sourceEntry : {}),
        root: ws.root,
        name: ws.name,
        created_at: new Date(ws.createdAt).toISOString(),
        last_opened_at: new Date(ws.lastOpenedAt).toISOString(),
      };
    }
    const document = {
      ...catalog.sourceDocument,
      version: WORKSPACE_CATALOG_VERSION,
      workspaces: workspaceRecord,
      deleted_workspace_ids: [...catalog.deletedIds],
    };
    await this.docs.set(WORKSPACE_CATALOG_SCOPE, WORKSPACE_CATALOG_KEY, document);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function sanitizeEntry(value: unknown): PersistedWorkspaceEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<PersistedWorkspaceEntry>;
  if (
    typeof v.root !== 'string' ||
    typeof v.name !== 'string' ||
    typeof v.created_at !== 'string' ||
    typeof v.last_opened_at !== 'string'
  ) {
    return null;
  }
  return {
    root: v.root,
    name: v.name,
    created_at: v.created_at,
    last_opened_at: v.last_opened_at,
  };
}

function parseTime(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

registerScopedService(
  LifecycleScope.App,
  IWorkspacePersistence,
  FileWorkspacePersistence,
  InstantiationType.Eager,
  'workspace',
);
