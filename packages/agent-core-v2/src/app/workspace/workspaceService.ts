import { randomUUID } from 'node:crypto';

import { basename, isAbsolute } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { encodeWorkDirKey, isWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IEventService } from '#/app/event/event';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import {
  IWorkspaceService,
  type Workspace,
  type WorkspaceCreate,
  type WorkspaceUpdate,
} from './workspace';
import {
  WorkspaceCreated,
  WorkspaceDeleted,
  WorkspaceUpdated,
} from './workspaceEvents';
import {
  collectAliasIds,
  compactSessionIndexIfStale,
  dedupeByRoot,
  isImplicitBucketSessionLine,
  readSessionIndexEntries,
} from './workspaceAlias';
import { IWorkspacePersistence, type WorkspaceCatalog } from './workspacePersistence';

export class WorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined;

  private merged = false;
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @IWorkspacePersistence private readonly store: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAppendLogStore private readonly appendLogs: IAppendLogStore,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IProjectLocalConfigService private readonly localConfig: IProjectLocalConfigService,
    @ILogService private readonly log: ILogService,
    @IEventService private readonly event: IEventService,
  ) {}

  list(): Promise<readonly Workspace[]> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const byId = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
      return dedupeByRoot(byId);
    });
  }

  get(id: string): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      return catalog.workspaces.find((ws) => ws.id === id);
    });
  }

  createOrTouch(root: string, name?: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      let stat;
      try {
        stat = await this.hostFs.stat(root);
      } catch {
        stat = undefined;
      }
      if (stat !== undefined && !stat.isDirectory) {
        try {
          stat = await this.hostFs.stat(await this.hostFs.realpath(root));
        } catch {
          stat = undefined;
        }
      }
      if (stat !== undefined && !stat.isDirectory) {
        throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} is not a directory`);
      }
      await this.ensureMerged();
      let ws!: Workspace;
      let existing: Workspace | undefined;
      await this.store.update((catalog) => {
        const byId = new Map(catalog.workspaces.map((entry) => [entry.id, entry]));
        const deletedIds = new Set(catalog.deletedIds);
        const id = encodeWorkDirKey(root);
        existing = byId.get(id);
        if (existing === undefined) {
          const rootKey = workspaceRootKey(root);
          for (const entry of byId.values()) {
            if (isWorkDirKey(entry.id) && workspaceRootKey(entry.root) === rootKey) {
              existing = entry;
              break;
            }
          }
        }
        const now = Date.now();
        ws =
          existing !== undefined
            ? { ...existing, lastOpenedAt: now }
            : {
                id,
                root,
                name: name ?? basename(root),
                kind: 'implicit',
                additionalDirs: [],
                createdAt: now,
                lastOpenedAt: now,
              };
        byId.set(ws.id, ws);
        deletedIds.delete(ws.id);
        return {
          workspaces: [...byId.values()],
          deletedIds: [...deletedIds],
          idempotencyKeys: catalog.idempotencyKeys,
        };
      });
      this.event.publish(
        existing === undefined
          ? new WorkspaceCreated({ payload: { workspace: ws } })
          : new WorkspaceUpdated({ payload: { workspace: ws } }),
      );
      return ws;
    });
  }

  create(input: WorkspaceCreate): Promise<Workspace> {
    return this.runExclusive(async () => {
      await this.requireDirectory(input.root);
      const additionalDirs = await this.normalizeAdditionalDirs(
        input.root,
        input.additionalDirs ?? [],
      );
      await this.ensureMerged();
      let ws!: Workspace;
      let reused = false;
      await this.store.update((catalog) => {
        if (input.idempotencyKey !== undefined) {
          const mapped = catalog.idempotencyKeys?.[input.idempotencyKey];
          const existing =
            mapped === undefined
              ? undefined
              : catalog.workspaces.find((entry) => entry.id === mapped);
          if (existing !== undefined) {
            ws = existing;
            reused = true;
            return catalog;
          }
        }
        const now = Date.now();
        ws = {
          id: `wm_${randomUUID()}`,
          root: input.root,
          name: input.name ?? basename(input.root),
          kind: 'managed',
          additionalDirs,
          createdAt: now,
          lastOpenedAt: now,
        };
        const idempotencyKeys = { ...catalog.idempotencyKeys };
        if (input.idempotencyKey !== undefined) idempotencyKeys[input.idempotencyKey] = ws.id;
        return {
          workspaces: [...catalog.workspaces, ws],
          deletedIds: catalog.deletedIds,
          idempotencyKeys,
        };
      });
      if (!reused) this.event.publish(new WorkspaceCreated({ payload: { workspace: ws } }));
      return ws;
    });
  }

  readProjectConfigDirs(root: string): Promise<readonly string[]> {
    return this.runExclusive(async () => {
      const fromProject = await this.readProjectDirs(root);
      const rootKey = workspaceRootKey(root);
      const result: string[] = [];
      for (const dir of fromProject) {
        const key = workspaceRootKey(dir);
        if (key === rootKey) continue;
        if (result.some((kept) => workspaceRootKey(kept) === key)) continue;
        result.push(dir);
      }
      return result;
    });
  }

  touch(id: string): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      let touched: Workspace | undefined;
      await this.store.update(async (catalog) => {
        const existing = catalog.workspaces.find((ws) => ws.id === id);
        if (existing === undefined) return catalog;
        await this.requireDirectory(existing.root);
        touched = { ...existing, lastOpenedAt: Date.now() };
        return {
          workspaces: catalog.workspaces.map((ws) => (ws.id === id ? touched! : ws)),
          deletedIds: catalog.deletedIds,
          idempotencyKeys: catalog.idempotencyKeys,
        };
      });
      if (touched !== undefined) {
        this.event.publish(new WorkspaceUpdated({ payload: { workspace: touched } }));
      }
      return touched;
    });
  }

  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      let updated: Workspace | undefined;
      await this.store.update(async (catalog) => {
        const existing = catalog.workspaces.find((ws) => ws.id === id);
        if (existing === undefined) return catalog;
        const additionalDirs =
          patch.additionalDirs === undefined
            ? existing.additionalDirs
            : await this.normalizeAdditionalDirs(existing.root, patch.additionalDirs);
        updated = {
          ...existing,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          additionalDirs,
        };
        return {
          workspaces: catalog.workspaces.map((ws) => (ws.id === id ? updated! : ws)),
          deletedIds: catalog.deletedIds,
          idempotencyKeys: catalog.idempotencyKeys,
        };
      });
      if (updated !== undefined) {
        this.event.publish(new WorkspaceUpdated({ payload: { workspace: updated } }));
      }
      return updated;
    });
  }

  setPrimary(id: string, path: string): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      let updated: Workspace | undefined;
      let changed = false;
      await this.store.update(async (catalog) => {
        const existing = catalog.workspaces.find((ws) => ws.id === id);
        if (existing === undefined) return catalog;
        const resolved = (await this.localConfig.resolveAdditionalDirs(existing.root, [path]))[0];
        if (resolved === undefined) {
          throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `primary ${path} does not exist`);
        }
        const rootKey = workspaceRootKey(existing.root);
        const resolvedKey = workspaceRootKey(resolved);
        if (resolvedKey === rootKey) {
          updated = existing;
          return catalog;
        }
        if (!existing.additionalDirs.some((dir) => workspaceRootKey(dir) === resolvedKey)) {
          throw new Error2(
            ErrorCodes.CONFIG_INVALID,
            `primary ${resolved} is not in the workspace dir set`,
          );
        }
        updated = {
          ...existing,
          root: resolved,
          additionalDirs: [
            existing.root,
            ...existing.additionalDirs.filter((dir) => workspaceRootKey(dir) !== resolvedKey),
          ],
          lastOpenedAt: Date.now(),
        };
        changed = true;
        return {
          workspaces: catalog.workspaces.map((ws) => (ws.id === id ? updated! : ws)),
          deletedIds: catalog.deletedIds,
          idempotencyKeys: catalog.idempotencyKeys,
        };
      });
      if (changed && updated !== undefined) {
        this.event.publish(new WorkspaceUpdated({ payload: { workspace: updated } }));
      }
      return updated;
    });
  }

  delete(id: string): Promise<void> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      let deletedRoot: string | undefined;
      await this.store.update(async (catalog) => {
        let root = catalog.workspaces.find((ws) => ws.id === id)?.root;
        if (root === undefined) {
          root = (await readSessionIndexEntries(this.storage)).find(
            (line) => encodeWorkDirKey(line.workDir) === id,
          )?.workDir;
        }
        if (root === undefined) {
          return {
            workspaces: catalog.workspaces.filter((ws) => ws.id !== id),
            deletedIds: [...new Set([...catalog.deletedIds, id])],
            idempotencyKeys: catalog.idempotencyKeys,
          };
        }
        const aliasIds = isWorkDirKey(id)
          ? collectAliasIds(catalog.workspaces, await readSessionIndexEntries(this.storage), root)
          : [];
        const removedIds = new Set([id, ...aliasIds]);
        deletedRoot = root;
        return {
          workspaces: catalog.workspaces.filter((ws) => !removedIds.has(ws.id)),
          deletedIds: [...new Set([...catalog.deletedIds, ...removedIds])],
          idempotencyKeys: catalog.idempotencyKeys,
        };
      });
      if (deletedRoot !== undefined) {
        this.event.publish(new WorkspaceDeleted({ payload: { workspaceId: id, root: deletedRoot } }));
      }
    });
  }

  private async ensureMerged(): Promise<void> {
    if (this.merged) return;
    const loaded = await this.store.load();
    if (loaded === undefined || loaded.workspaces.length === 0) {
      await this.store.update(async (catalog) => {
        const rebuilt = await this.rebuildFromSessionIndex();
        const byId = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
        const deletedIds = new Set(catalog.deletedIds);
        for (const [id, workspace] of rebuilt) {
          if (!byId.has(id) && !deletedIds.has(id)) byId.set(id, workspace);
        }
        return {
          workspaces: [...byId.values()],
          deletedIds: [...deletedIds],
          idempotencyKeys: catalog.idempotencyKeys,
        };
      });
    } else {
      const byId = new Map(loaded.workspaces.map((ws) => [ws.id, ws]));
      const deletedIds = new Set(loaded.deletedIds);
      if (await this.mergeFromSessionIndex(byId, deletedIds)) {
        await this.store.update(async (catalog) => {
          const latestById = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
          const latestDeletedIds = new Set(catalog.deletedIds);
          await this.mergeFromSessionIndex(latestById, latestDeletedIds);
          return {
            workspaces: [...latestById.values()],
            deletedIds: [...latestDeletedIds],
            idempotencyKeys: catalog.idempotencyKeys,
          };
        });
      }
    }
    this.merged = true;
    await this.compactSessionIndex();
  }

  private async compactSessionIndex(): Promise<void> {
    try {
      await compactSessionIndexIfStale({
        storage: this.storage,
        appendLogs: this.appendLogs,
        sessionDirExists: (dir) => this.sessionDirExists(dir),
      });
    } catch (error) {
      this.log.warn('session index compaction failed; will retry on the next startup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sessionDirExists(dir: string): Promise<boolean> {
    try {
      return (await this.hostFs.stat(dir)).isDirectory;
    } catch (error) {
      const code = (unwrapErrorCause(error) as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      return true;
    }
  }

  private async loadCatalog(): Promise<WorkspaceCatalog> {
    return (await this.store.load()) ?? { workspaces: [], deletedIds: [] };
  }

  private async mergeFromSessionIndex(
    byId: Map<string, Workspace>,
    deletedIds: ReadonlySet<string>,
  ): Promise<boolean> {
    let changed = false;
    const now = Date.now();
    for (const entry of await readSessionIndexEntries(this.storage)) {
      if (!isAbsolute(entry.workDir)) continue;
      if (!isImplicitBucketSessionLine(entry)) continue;
      const id = encodeWorkDirKey(entry.workDir);
      if (byId.has(id) || deletedIds.has(id)) continue;
      byId.set(id, {
        id,
        root: entry.workDir,
        name: basename(entry.workDir),
        kind: 'implicit',
        additionalDirs: [],
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
    const seenRootKeys = new Set<string>();
    for (const entry of await readSessionIndexEntries(this.storage)) {
      if (!isAbsolute(entry.workDir)) continue;
      if (!isImplicitBucketSessionLine(entry)) continue;
      const rootKey = workspaceRootKey(entry.workDir);
      if (seenRootKeys.has(rootKey)) continue;
      seenRootKeys.add(rootKey);
      const id = encodeWorkDirKey(entry.workDir);
      result.set(id, {
        id,
        root: entry.workDir,
        name: basename(entry.workDir),
        kind: 'implicit',
        additionalDirs: [],
        createdAt: now,
        lastOpenedAt: now,
      });
    }
    return result;
  }

  private async requireDirectory(root: string): Promise<void> {
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
      try {
        stat = await this.hostFs.stat(await this.hostFs.realpath(root));
      } catch {
      }
    }
    if (!stat.isDirectory) {
      throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} is not a directory`);
    }
  }

  private async normalizeAdditionalDirs(
    root: string,
    dirs: readonly string[],
  ): Promise<readonly string[]> {
    const resolved = await this.localConfig.resolveAdditionalDirs(root, dirs);
    const rootKey = workspaceRootKey(root);
    const result: string[] = [];
    for (const dir of resolved) {
      if (workspaceRootKey(dir) === rootKey) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `additional dir ${dir} duplicates the workspace root`,
        );
      }
      if (result.some((kept) => workspaceRootKey(kept) === workspaceRootKey(dir))) continue;
      result.push(dir);
    }
    return result;
  }

  private async readProjectDirs(root: string): Promise<readonly string[]> {
    const onDisk = await this.localConfig.readAdditionalDirs(root);
    return onDisk.additionalDirs;
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

registerScopedService(
  LifecycleScope.App,
  IWorkspaceService,
  WorkspaceService,
  ScopeActivation.OnScopeCreated,
  'workspace',
);
