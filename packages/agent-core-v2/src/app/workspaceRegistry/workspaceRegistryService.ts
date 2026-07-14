/**
 * `workspaceRegistry` domain (L1) — `IWorkspaceRegistry` implementation.
 *
 * Process-wide catalog of known workspaces, durable: an in-memory cache is
 * loaded once from `IWorkspacePersistence` (`<homeDir>/workspaces.json`, the
 * v1-compatible file shared with agent-core) and every mutation writes back
 * through it. Loading has two paths:
 *
 * 1. No usable catalog file → one-shot rebuild from the legacy
 *    `<homeDir>/session_index.jsonl` (one workspace per distinct absolute
 *    `workDir`), then persisted.
 * 2. Catalog loaded → a one-time merge from the same session index adds every
 *    workDir the file does not know about yet (e.g. sessions created by the
 *    v1 TUI since the last merge), then persisted if anything changed.
 *
 * Deletion is soft: `delete` drops the entry but records the id in
 * `deleted_workspace_ids`, and the merge never resurrects a tombstoned id.
 * An explicit `createOrTouch` clears the tombstone — the user opening the
 * folder again is a stronger signal than the historical index.
 *
 * All access is serialized through a promise-chain mutex so
 * load/rebuild/merge/mutations never race.
 *
 * `createOrTouch` is the single choke point every workspace/session creation
 * funnels through, so it owns the root-existence contract: the root must be
 * an existing directory on the host filesystem, otherwise it throws
 * `fs.path_not_found` (mirrors v1's `WorkspaceRootNotFoundError`). The rebuild
 * and merge paths bypass the check on purpose — they catalog where sessions
 * *were*, not where new ones may open. Bound at App scope.
 */

import { basename, isAbsolute } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { IWorkspaceRegistry, type Workspace, type WorkspaceUpdate } from './workspaceRegistry';
import { IWorkspacePersistence } from './workspacePersistence';

const SESSION_INDEX_SCOPE = '';
const SESSION_INDEX_KEY = 'session_index.jsonl';

const textDecoder = new TextDecoder();

interface SessionIndexLine {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

export class WorkspaceRegistryService implements IWorkspaceRegistry {
  declare readonly _serviceBrand: undefined;

  private cache: Map<string, Workspace> | undefined;
  private deletedIds: Set<string> | undefined;
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @IWorkspacePersistence private readonly store: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
  ) {}

  list(): Promise<readonly Workspace[]> {
    return this.runExclusive(async () => {
      const cache = await this.ensureLoaded();
      return dedupeByRoot(cache);
    });
  }

  get(id: string): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      const cache = await this.ensureLoaded();
      return cache.get(id);
    });
  }

  createOrTouch(root: string, name?: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      const cache = await this.ensureLoaded();
      let stat;
      try {
        stat = await this.hostFs.stat(root);
      } catch (error) {
        const code = (unwrapErrorCause(error) as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} does not exist`);
        }
        throw error;
      }
      if (!stat.isDirectory) {
        throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} is not a directory`);
      }
      const id = encodeWorkDirKey(root);
      const existing = cache.get(id);
      const now = Date.now();
      const ws: Workspace =
        existing !== undefined
          ? { ...existing, lastOpenedAt: now }
          : {
              id,
              root,
              name: name ?? basename(root),
              createdAt: now,
              lastOpenedAt: now,
            };
      cache.set(id, ws);
      // An explicit add clears any prior deletion tombstone.
      this.deletedIds?.delete(id);
      await this.persist();
      return ws;
    });
  }

  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      const cache = await this.ensureLoaded();
      const existing = cache.get(id);
      if (existing === undefined) return undefined;
      const updated: Workspace = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
      };
      cache.set(id, updated);
      await this.persist();
      return updated;
    });
  }

  delete(id: string): Promise<void> {
    return this.runExclusive(async () => {
      const cache = await this.ensureLoaded();
      cache.delete(id);
      // Soft delete: tombstone the id so the session-index merge cannot
      // resurrect it, even if sessions still reference the workDir.
      this.deletedIds?.add(id);
      await this.persist();
    });
  }

  private async ensureLoaded(): Promise<Map<string, Workspace>> {
    if (this.cache !== undefined) return this.cache;
    const loaded = await this.store.load();
    if (loaded === undefined) {
      const rebuilt = await this.rebuildFromSessionIndex();
      this.cache = rebuilt;
      this.deletedIds = new Set();
      await this.persist();
      return rebuilt;
    }
    const cache = new Map(loaded.workspaces.map((ws) => [ws.id, ws]));
    const deletedIds = new Set(loaded.deletedIds);
    this.cache = cache;
    this.deletedIds = deletedIds;
    if (await this.mergeFromSessionIndex(cache, deletedIds)) {
      await this.persist();
    }
    return cache;
  }

  /** Add every distinct workDir from the legacy session index that the
   *  catalog does not know about yet. Tombstoned ids are skipped, so a
   *  soft-deleted workspace stays deleted. Returns whether anything changed. */
  private async mergeFromSessionIndex(
    cache: Map<string, Workspace>,
    deletedIds: ReadonlySet<string>,
  ): Promise<boolean> {
    let changed = false;
    const now = Date.now();
    for (const workDir of await this.readSessionIndexWorkDirs()) {
      const id = encodeWorkDirKey(workDir);
      if (cache.has(id) || deletedIds.has(id)) continue;
      cache.set(id, {
        id,
        root: workDir,
        name: basename(workDir),
        createdAt: now,
        lastOpenedAt: now,
      });
      changed = true;
    }
    return changed;
  }

  private async rebuildFromSessionIndex(): Promise<Map<string, Workspace>> {
    const result = new Map<string, Workspace>();
    const now = Date.now();
    for (const workDir of await this.readSessionIndexWorkDirs()) {
      const id = encodeWorkDirKey(workDir);
      if (result.has(id)) continue;
      result.set(id, {
        id,
        root: workDir,
        name: basename(workDir),
        createdAt: now,
        lastOpenedAt: now,
      });
    }
    return result;
  }

  private async readSessionIndexWorkDirs(): Promise<readonly string[]> {
    const bytes = await this.storage.read(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY);
    if (bytes === undefined) return [];
    const workDirs: string[] = [];
    for (const line of textDecoder.decode(bytes).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const entry = parseSessionIndexLine(trimmed);
      if (entry === undefined) continue;
      if (!isAbsolute(entry.workDir)) continue;
      workDirs.push(entry.workDir);
    }
    return workDirs;
  }

  private async persist(): Promise<void> {
    const cache = this.cache;
    const deletedIds = this.deletedIds;
    if (cache === undefined || deletedIds === undefined) {
      throw new Error('workspace registry mutated before load completed');
    }
    await this.store.save({
      workspaces: [...cache.values()],
      deletedIds: [...deletedIds],
    });
  }

  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(op, op);
    this.opQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

function parseSessionIndexLine(line: string): SessionIndexLine | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const entry = parsed as Partial<SessionIndexLine>;
    if (
      typeof entry.sessionId !== 'string' ||
      typeof entry.sessionDir !== 'string' ||
      typeof entry.workDir !== 'string'
    ) {
      return undefined;
    }
    return {
      sessionId: entry.sessionId,
      sessionDir: entry.sessionDir,
      workDir: entry.workDir,
    };
  } catch {
    return undefined;
  }
}

function dedupeByRoot(cache: ReadonlyMap<string, Workspace>): Workspace[] {
  const byRoot = new Map<string, Workspace>();
  for (const ws of cache.values()) {
    const existing = byRoot.get(ws.root);
    if (existing === undefined) {
      byRoot.set(ws.root, ws);
      continue;
    }
    const canonicalId = encodeWorkDirKey(ws.root);
    if (existing.id !== canonicalId && ws.id === canonicalId) {
      byRoot.set(ws.root, ws);
    }
  }
  return [...byRoot.values()];
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceRegistry,
  WorkspaceRegistryService,
  InstantiationType.Eager,
  'workspaceRegistry',
);
