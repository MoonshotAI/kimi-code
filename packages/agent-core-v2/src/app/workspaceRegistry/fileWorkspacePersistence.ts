/**
 * `workspaceRegistry` domain (L1) — `FileWorkspacePersistence` implementation.
 *
 * File backend of `IWorkspacePersistence`. Persists the catalog as a single
 * v1-compatible `workspaces.json` document at the storage root
 * (`<homeDir>/workspaces.json`, via `scope = ''`) through the
 * `IAtomicDocumentStore` access-pattern Store. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import type { Workspace } from './workspaceRegistry';
import {
  IWorkspacePersistence,
  type PersistedWorkspaceEntry,
  type PersistedWorkspaceFile,
} from './workspacePersistence';

const WORKSPACE_REGISTRY_VERSION = 1;
const WORKSPACE_REGISTRY_SCOPE = '';
const WORKSPACE_REGISTRY_KEY = 'workspaces.json';

export class FileWorkspacePersistence implements IWorkspacePersistence {
  declare readonly _serviceBrand: undefined;

  constructor(@IAtomicDocumentStore private readonly docs: IAtomicDocumentStore) {}

  async load(): Promise<Workspace[] | undefined> {
    const file = await this.docs.get<PersistedWorkspaceFile>(
      WORKSPACE_REGISTRY_SCOPE,
      WORKSPACE_REGISTRY_KEY,
    );
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
    return result;
  }

  async save(workspaces: readonly Workspace[]): Promise<void> {
    const record: Record<string, PersistedWorkspaceEntry> = {};
    for (const ws of workspaces) {
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
    };
    await this.docs.set(WORKSPACE_REGISTRY_SCOPE, WORKSPACE_REGISTRY_KEY, file);
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
  InstantiationType.Delayed,
  'workspaceRegistry',
);
