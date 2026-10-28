import { createHash } from 'node:crypto';

import { join, normalize } from 'pathe';
import lockfile from 'proper-lockfile';

import { LifecycleScope } from '#/app/scopes';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { TimeoutTimer } from '#/_base/utils/timer';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  IFileSystemStorageService,
  StorageError,
  StorageErrors,
} from '#/persistence/interface/storage';
import { watch } from '#human/utils/watch';

import type { Workspace } from './workspace';
import {
  IWorkspacePersistence,
  type PersistedProjectsFile,
  type PersistedWorkspaceEntry,
  type PersistedWorkspaceFile,
  type WorkspaceCatalog,
  type WorkspaceCatalogMutator,
} from './workspacePersistence';

const PROJECTS_SCHEMA_VERSION = 2;
const WORKSPACE_CATALOG_SCOPE = '';
const LEGACY_WORKSPACES_KEY = 'workspaces.json';
const PROJECTS_KEY = 'projects.json';
const PROJECTS_LOCK_KEY = '.projects-write-lock';
const WATCH_DEBOUNCE_MS = 150;
const textDecoder = new TextDecoder();

interface LegacySnapshot {
  readonly bytes: Uint8Array;
  readonly hash: string;
  readonly file: PersistedWorkspaceFile;
}

export class FileWorkspacePersistence extends Disposable implements IWorkspacePersistence {
  declare readonly _serviceBrand: undefined;

  private readonly changeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.changeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watchReady: Promise<void>;
  private migration: Promise<void> | undefined;

  constructor(
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    super();
    const catalogFile = join(this.bootstrap.homeDir, PROJECTS_KEY);
    const handle = watch(catalogFile);
    this._register(handle);
    this.watchReady = handle.ready;
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
    await this.ensureMigrated();
    await this.watchReady.catch(() => undefined);
    return (await this.readProjectsState()).catalog;
  }

  async update(mutator: WorkspaceCatalogMutator): Promise<void> {
    await this.ensureMigrated();
    await this.watchReady.catch(() => undefined);
    await this.withLock(async () => {
      const { file, catalog } = await this.readProjectsState();
      const next = await mutator(catalog);
      if (next === catalog) return;
      const record: Record<string, PersistedWorkspaceEntry> = {};
      for (const ws of next.workspaces) {
        const rawEntry = file.projects[ws.id];
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
      const nextFile: PersistedProjectsFile = {
        ...file,
        schema_version: PROJECTS_SCHEMA_VERSION,
        projects: record,
        deleted_project_ids: [...next.deletedIds],
        idempotency_keys: { ...(next.idempotencyKeys ?? file.idempotency_keys) },
      };
      await this.docs.set(WORKSPACE_CATALOG_SCOPE, PROJECTS_KEY, nextFile);
      this.changeEmitter.fire();
    });
  }

  private ensureMigrated(): Promise<void> {
    this.migration ??= this.migrate().catch((error) => {
      this.migration = undefined;
      throw error;
    });
    return this.migration;
  }

  private async migrate(): Promise<void> {
    await this.withLock(async () => {
      const existingSize = await this.storage.size(WORKSPACE_CATALOG_SCOPE, PROJECTS_KEY);
      if (existingSize !== undefined) return;
      const snapshot = await this.readLegacySnapshot();
      if (snapshot === undefined) {
        await this.docs.set(WORKSPACE_CATALOG_SCOPE, PROJECTS_KEY, {
          schema_version: PROJECTS_SCHEMA_VERSION,
          projects: {},
          deleted_project_ids: [],
          idempotency_keys: {},
        });
        return;
      }
      const backupKey = `${LEGACY_WORKSPACES_KEY}.pre-projects-migration-${new Date()
        .toISOString()
        .replaceAll(':', '-')}.bak`;
      await this.storage.write(WORKSPACE_CATALOG_SCOPE, backupKey, snapshot.bytes, {
        atomic: true,
      });
      await this.docs.set(
        WORKSPACE_CATALOG_SCOPE,
        PROJECTS_KEY,
        migrateLegacyDocument(snapshot.file, snapshot.hash),
      );
    });
  }

  private async readLegacySnapshot(): Promise<LegacySnapshot | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bytes = await this.storage.read(WORKSPACE_CATALOG_SCOPE, LEGACY_WORKSPACES_KEY);
      if (bytes === undefined) return undefined;
      const hash = createHash('sha256').update(bytes).digest('hex');
      let file: PersistedWorkspaceFile;
      try {
        file = JSON.parse(textDecoder.decode(bytes)) as PersistedWorkspaceFile;
      } catch (error) {
        throw new StorageError(
          StorageErrors.codes.STORAGE_DECODE_FAILED,
          `failed to parse ${LEGACY_WORKSPACES_KEY}`,
          { cause: error },
        );
      }
      const confirmed = await this.storage.read(WORKSPACE_CATALOG_SCOPE, LEGACY_WORKSPACES_KEY);
      if (
        confirmed !== undefined &&
        createHash('sha256').update(confirmed).digest('hex') === hash
      ) {
        return { bytes, hash, file };
      }
    }
    throw new StorageError(
      StorageErrors.codes.STORAGE_IO_FAILED,
      `${LEGACY_WORKSPACES_KEY} changed repeatedly during migration`,
    );
  }

  private async readProjectsState(): Promise<{
    readonly file: PersistedProjectsFile;
    readonly catalog: WorkspaceCatalog;
  }> {
    const raw = await this.docs.get<unknown>(WORKSPACE_CATALOG_SCOPE, PROJECTS_KEY);
    if (raw === undefined) {
      throw new StorageError(
        StorageErrors.codes.STORAGE_NOT_FOUND,
        `${PROJECTS_KEY} is missing after migration`,
      );
    }
    return parseProjectsDocument(raw);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.storage.write(WORKSPACE_CATALOG_SCOPE, PROJECTS_LOCK_KEY, new Uint8Array(), {
      atomic: true,
    });
    const target =
      this.storage.pathFor(WORKSPACE_CATALOG_SCOPE, PROJECTS_LOCK_KEY) ??
      join(this.bootstrap.homeDir, PROJECTS_LOCK_KEY);
    const release = await lockfile.lock(target, {
      retries: { retries: 120, factor: 1, minTimeout: 50, maxTimeout: 200 },
      stale: 5_000,
      realpath: false,
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

function parseProjectsDocument(value: unknown): {
  readonly file: PersistedProjectsFile;
  readonly catalog: WorkspaceCatalog;
} {
  const raw = asRecord(value, PROJECTS_KEY);
  const version = raw['schema_version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw projectsCorrupted(`invalid schema_version in ${PROJECTS_KEY}`);
  }
  if (version > PROJECTS_SCHEMA_VERSION) {
    throw projectsCorrupted(
      `${PROJECTS_KEY} schema_version ${version} is newer than supported ${PROJECTS_SCHEMA_VERSION}`,
    );
  }
  const rawProjects = asRecord(raw['projects'], `${PROJECTS_KEY} projects`);
  const now = Date.now();
  const workspaces: Workspace[] = [];
  for (const [id, rawEntry] of Object.entries(rawProjects)) {
    const entry = sanitizeEntry(rawEntry, version === PROJECTS_SCHEMA_VERSION);
    if (entry === null) throw projectsCorrupted(`invalid project entry ${id}`);
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
  return {
    file: raw as unknown as PersistedProjectsFile,
    catalog: {
      workspaces,
      deletedIds: readStringArray(raw['deleted_project_ids'], 'deleted_project_ids'),
      idempotencyKeys: readIdempotencyKeys(raw['idempotency_keys']),
    },
  };
}

function migrateLegacyDocument(file: PersistedWorkspaceFile, hash: string): PersistedProjectsFile {
  const raw = legacyRecord(file);
  const rawWorkspaces = legacyRecord(raw['workspaces']);
  const rawDeletedIds = raw['deleted_workspace_ids'];
  const projects: Record<string, PersistedWorkspaceEntry> = {};
  for (const [id, value] of Object.entries(rawWorkspaces)) {
    const entry = sanitizeEntry(value);
    if (entry === null) continue;
    projects[id] = {
      ...(typeof value === 'object' && value !== null ? value : {}),
      root: entry.root,
      name: entry.name,
      kind: entry.kind === 'managed' ? 'managed' : 'implicit',
      additional_dirs: entry.additional_dirs ?? [],
      created_at: entry.created_at,
      last_opened_at: entry.last_opened_at,
    };
  }
  const extensions = Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) => key !== 'version' && key !== 'workspaces' && key !== 'deleted_workspace_ids',
    ),
  );
  return {
    ...extensions,
    schema_version: PROJECTS_SCHEMA_VERSION,
    projects,
    deleted_project_ids: Array.isArray(rawDeletedIds)
      ? readStringArray(rawDeletedIds, 'deleted_workspace_ids')
      : [],
    idempotency_keys: readIdempotencyKeys(raw['idempotency_keys']),
    migration: {
      source_file: LEGACY_WORKSPACES_KEY,
      source_version: typeof raw['version'] === 'number' ? raw['version'] : undefined,
      source_sha256: hash,
      migrated_at: new Date().toISOString(),
    },
  };
}

function legacyRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw projectsCorrupted(`invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function readStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw projectsCorrupted(`invalid ${label}`);
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function readIdempotencyKeys(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const record = asRecord(value, 'idempotency_keys');
  const result: Record<string, string> = {};
  for (const [key, mapped] of Object.entries(record)) {
    if (typeof mapped === 'string') result[key] = mapped;
  }
  return result;
}

function sanitizeEntry(value: unknown, strict = false): PersistedWorkspaceEntry | null {
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
  if (strict && v.kind !== 'managed' && v.kind !== 'implicit') {
    throw projectsCorrupted('invalid kind');
  }
  const rawDirs = v.additional_dirs;
  if (
    strict &&
    rawDirs !== undefined &&
    (!Array.isArray(rawDirs) || rawDirs.some((dir) => typeof dir !== 'string'))
  ) {
    throw projectsCorrupted('invalid additional_dirs');
  }
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

function projectsCorrupted(message: string): StorageError {
  return new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, message, {
    details: { key: PROJECTS_KEY },
  });
}

registerScopedService(
  LifecycleScope.App,
  IWorkspacePersistence,
  FileWorkspacePersistence,
  ScopeActivation.OnScopeCreated,
  'workspace',
);
