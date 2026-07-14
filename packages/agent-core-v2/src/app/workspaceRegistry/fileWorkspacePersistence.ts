/**
 * `workspaceRegistry` domain (L1) — `FileWorkspacePersistence` implementation.
 *
 * File backend of `IWorkspacePersistence`. Persists the catalog as a single
 * v1-compatible `workspaces.json` document at the storage root
 * (`<homeDir>/workspaces.json`, via `scope = ''`) through the atomic-document
 * Store, and coordinates writers through one shared file lock. Bound at App
 * scope.
 */

import { mkdir } from 'node:fs/promises';

import { join } from 'pathe';
import lockfile from 'proper-lockfile';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { isStorageError, StorageErrors } from '#/persistence/interface/storage';

import type { Workspace } from './workspaceRegistry';
import {
  IWorkspacePersistence,
  type PersistedWorkspaceEntry,
  type PersistedWorkspaceFile,
  type WorkspaceCatalog,
} from './workspacePersistence';

const WORKSPACE_REGISTRY_VERSION = 1;
const WORKSPACE_REGISTRY_SCOPE = '';
const WORKSPACE_REGISTRY_KEY = 'workspaces.json';
const WORKSPACE_REGISTRY_LOCK_RETRIES = {
  retries: 100,
  factor: 1,
  minTimeout: 10,
  maxTimeout: 50,
  randomize: true,
} as const;

export class FileWorkspacePersistence implements IWorkspacePersistence {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  async load(): Promise<WorkspaceCatalog | undefined> {
    let file: PersistedWorkspaceFile | undefined;
    try {
      file = await this.docs.get<PersistedWorkspaceFile>(
        WORKSPACE_REGISTRY_SCOPE,
        WORKSPACE_REGISTRY_KEY,
      );
    } catch (error) {
      if (isStorageError(error, StorageErrors.codes.STORAGE_DECODE_FAILED)) return undefined;
      throw error;
    }
    if (file === undefined) return undefined;
    if (
      typeof file !== 'object' ||
      file === null ||
      typeof (file as { workspaces?: unknown }).workspaces !== 'object' ||
      (file as { workspaces?: unknown }).workspaces === null
    ) {
      return undefined;
    }
    const now = Date.now();
    const result: Workspace[] = [];
    for (const [id, raw] of Object.entries(file.workspaces)) {
      const entry = sanitizeEntry(raw, now);
      if (entry === null) continue;
      result.push({
        id,
        root: entry.root,
        name: entry.name,
        createdAt: parseTime(entry.created_at, now),
        lastOpenedAt: parseTime(entry.last_opened_at, now),
      });
    }
    const rawDeletedIds = file.deleted_workspace_ids;
    const deletedWorkspaceIds = Array.isArray(rawDeletedIds)
      ? rawDeletedIds.filter((id): id is string => typeof id === 'string')
      : [];
    const rawDeletedRoots = file.deleted_workspace_roots;
    const deletedWorkspaceRoots: Record<string, string> = {};
    if (typeof rawDeletedRoots === 'object' && rawDeletedRoots !== null) {
      for (const [id, root] of Object.entries(rawDeletedRoots)) {
        if (typeof root === 'string') deletedWorkspaceRoots[id] = root;
      }
    }
    return { workspaces: result, deletedWorkspaceIds, deletedWorkspaceRoots };
  }

  async save(catalog: WorkspaceCatalog): Promise<void> {
    const record: Record<string, PersistedWorkspaceEntry> = {};
    for (const ws of catalog.workspaces) {
      record[ws.id] = {
        root: ws.root,
        name: ws.name,
        created_at: new Date(ws.createdAt).toISOString(),
        last_opened_at: new Date(ws.lastOpenedAt).toISOString(),
      };
    }
    const file: PersistedWorkspaceFile = {
      version: WORKSPACE_REGISTRY_VERSION,
      workspaces: record,
      deleted_workspace_ids: catalog.deletedWorkspaceIds,
      deleted_workspace_roots: catalog.deletedWorkspaceRoots,
    };
    await this.docs.set(WORKSPACE_REGISTRY_SCOPE, WORKSPACE_REGISTRY_KEY, file);
  }

  async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.bootstrap.homeDir, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(
      join(this.bootstrap.homeDir, WORKSPACE_REGISTRY_KEY),
      {
        realpath: false,
        retries: WORKSPACE_REGISTRY_LOCK_RETRIES,
      },
    );
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

function sanitizeEntry(value: unknown, _now: number): PersistedWorkspaceEntry | null {
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
  'workspaceRegistry',
);
