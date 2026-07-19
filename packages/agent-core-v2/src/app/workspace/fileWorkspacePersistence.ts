/**
 * `workspace` domain (L2) — `FileWorkspacePersistence` implementation.
 *
 * File backend of `IWorkspacePersistence`. Persists the catalog as a single
 * v1-compatible `workspaces.json` document at the storage root
 * (`<homeDir>/workspaces.json`, via `scope = ''`) through the
 * `IAtomicDocumentStore` access-pattern Store. The `deleted_workspace_ids`
 * tombstone list round-trips with the catalog so soft deletions survive
 * regardless of which engine (v1 or v2) last wrote the file, and the parsed
 * document rides along in `WorkspaceCatalog.raw` so `save` re-applies the
 * semantic view onto it — unknown top-level and entry fields written by other
 * engine versions are preserved. Bound at App scope.
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

  async load(): Promise<WorkspaceCatalog | undefined> {
    const file = await this.docs.get<Record<string, unknown>>(
      WORKSPACE_CATALOG_SCOPE,
      WORKSPACE_CATALOG_KEY,
    );
    if (!isRecord(file)) return undefined;
    const rawWorkspaces = file['workspaces'];
    if (!isRecord(rawWorkspaces)) return undefined;
    const now = Date.now();
    const workspaces: Workspace[] = [];
    for (const [id, raw] of Object.entries(rawWorkspaces)) {
      const entry = sanitizeEntry(raw);
      if (entry === null) continue;
      workspaces.push({
        id,
        root: entry.root,
        name: entry.name,
        createdAt: parseTime(entry.created_at, now),
        lastOpenedAt: parseTime(entry.last_opened_at, now),
      });
    }
    const rawDeleted = file['deleted_workspace_ids'];
    const deletedIds = Array.isArray(rawDeleted)
      ? rawDeleted.filter((id): id is string => typeof id === 'string')
      : [];
    return { workspaces, deletedIds, raw: file };
  }

  async save(catalog: WorkspaceCatalog): Promise<void> {
    const rawWorkspaces = catalog.raw['workspaces'];
    const previousWorkspaces = isRecord(rawWorkspaces) ? rawWorkspaces : {};
    const record: Record<string, unknown> = {};
    for (const ws of catalog.workspaces) {
      const previous = previousWorkspaces[ws.id];
      record[ws.id] = {
        ...(isPlainRecord(previous) ? previous : {}),
        root: ws.root,
        name: ws.name,
        created_at: new Date(ws.createdAt).toISOString(),
        last_opened_at: new Date(ws.lastOpenedAt).toISOString(),
      };
    }
    const file = {
      ...catalog.raw,
      version: WORKSPACE_CATALOG_VERSION,
      workspaces: record,
      deleted_workspace_ids: [...catalog.deletedIds],
    };
    await this.docs.set(WORKSPACE_CATALOG_SCOPE, WORKSPACE_CATALOG_KEY, file);
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
