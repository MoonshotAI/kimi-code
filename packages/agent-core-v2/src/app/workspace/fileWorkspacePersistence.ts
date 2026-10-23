import { join, normalize } from 'pathe';

import { LifecycleScope } from '#/app/scopes';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { TimeoutTimer } from '#/_base/utils/timer';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { watchCandidates } from '#human/utils/watch';

import type { Workspace } from './workspace';
import {
  IWorkspacePersistence,
  type PersistedWorkspaceEntry,
  type PersistedWorkspaceFile,
  type WorkspaceCatalog,
} from './workspacePersistence';

const WORKSPACE_CATALOG_VERSION = 2;
const WORKSPACE_CATALOG_SCOPE = '';
const WORKSPACE_CATALOG_KEY = 'workspaces.json';
const WATCH_DEBOUNCE_MS = 150;

export class FileWorkspacePersistence extends Disposable implements IWorkspacePersistence {
  declare readonly _serviceBrand: undefined;

  private readonly changeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.changeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());

  constructor(
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    super();
    const catalogFile = join(this.bootstrap.homeDir, WORKSPACE_CATALOG_KEY);
    const handle = watchCandidates(this.bootstrap.homeDir, [catalogFile]);
    this._register(handle);
    this._register(
      handle.onDidChange((change) => {
        if (normalize(change.path) !== normalize(catalogFile)) return;
        this.watchDebounce.cancelAndSet(() => {
          this.changeEmitter.fire();
        }, WATCH_DEBOUNCE_MS);
      }),
    );
  }

  async load(): Promise<WorkspaceCatalog | undefined> {
    const file = await this.docs.get<PersistedWorkspaceFile>(
      WORKSPACE_CATALOG_SCOPE,
      WORKSPACE_CATALOG_KEY,
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
    const workspaces: Workspace[] = [];
    for (const [id, raw] of Object.entries(file.workspaces)) {
      const entry = sanitizeEntry(raw);
      if (entry === null) continue;
      workspaces.push({
        id,
        root: entry.root,
        name: entry.name,
        kind: entry.kind === 'managed' ? 'managed' : 'implicit',
        additionalDirs: entry.additional_dirs ?? [],
        createdAt: parseTime(entry.created_at, now),
        lastOpenedAt: parseTime(entry.last_opened_at, now),
      });
    }
    const rawDeleted = (file as { deleted_workspace_ids?: unknown }).deleted_workspace_ids;
    const deletedIds = Array.isArray(rawDeleted)
      ? rawDeleted.filter((id): id is string => typeof id === 'string')
      : [];
    const rawKeys = (file as { idempotency_keys?: unknown }).idempotency_keys;
    const idempotencyKeys: Record<string, string> = {};
    if (typeof rawKeys === 'object' && rawKeys !== null) {
      for (const [key, value] of Object.entries(rawKeys)) {
        if (typeof value === 'string') idempotencyKeys[key] = value;
      }
    }
    return { workspaces, deletedIds, idempotencyKeys };
  }

  async save(catalog: WorkspaceCatalog): Promise<void> {
    const existing = await this.docs.get<PersistedWorkspaceFile>(
      WORKSPACE_CATALOG_SCOPE,
      WORKSPACE_CATALOG_KEY,
    );
    const existingWorkspaces =
      existing !== undefined &&
      typeof existing.workspaces === 'object' &&
      existing.workspaces !== null
        ? existing.workspaces
        : {};
    const record: Record<string, PersistedWorkspaceEntry> = {};
    for (const ws of catalog.workspaces) {
      const rawEntry = existingWorkspaces[ws.id];
      const merged: Record<string, unknown> =
        typeof rawEntry === 'object' && rawEntry !== null ? { ...rawEntry } : {};
      if (ws.additionalDirs.length > 0) {
        merged['additional_dirs'] = [...ws.additionalDirs];
      } else {
        delete merged['additional_dirs'];
      }
      merged['root'] = ws.root;
      merged['name'] = ws.name;
      merged['kind'] = ws.kind;
      merged['created_at'] = new Date(ws.createdAt).toISOString();
      merged['last_opened_at'] = new Date(ws.lastOpenedAt).toISOString();
      record[ws.id] = merged as unknown as PersistedWorkspaceEntry;
    }
    const file: PersistedWorkspaceFile = {
      ...existing,
      version: WORKSPACE_CATALOG_VERSION,
      workspaces: record,
      deleted_workspace_ids: [...catalog.deletedIds],
      idempotency_keys: { ...(catalog.idempotencyKeys ?? existing?.idempotency_keys) },
    };
    await this.docs.set(WORKSPACE_CATALOG_SCOPE, WORKSPACE_CATALOG_KEY, file);
    this.changeEmitter.fire();
  }
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
  const rawDirs = v.additional_dirs;
  const additionalDirs = Array.isArray(rawDirs)
    ? rawDirs.filter((dir): dir is string => typeof dir === 'string')
    : undefined;
  return {
    root: v.root,
    name: v.name,
    kind: typeof v.kind === 'string' ? v.kind : undefined,
    additional_dirs: additionalDirs,
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
  ScopeActivation.OnScopeCreated,
  'workspace',
);
