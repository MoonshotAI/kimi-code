import { basename, isAbsolute } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { encodeWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IEventService } from '#/app/event/event';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { IWorkspaceService, type Workspace, type WorkspaceUpdate } from './workspace';
import {
  WorkspaceCreated,
  WorkspaceDeleted,
  WorkspaceUpdated,
} from './workspaceEvents';
import {
  collectAliasIds,
  dedupeByRoot,
  readSessionIndexEntries,
  readSessionIndexWorkDirs,
} from './workspaceAlias';
import { IWorkspacePersistence, type WorkspaceCatalog } from './workspacePersistence';

export class WorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined;

  private merged = false;
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @IWorkspacePersistence private readonly store: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
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
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const byId = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
      const deletedIds = new Set(catalog.deletedIds);
      const id = encodeWorkDirKey(root);
      let existing = byId.get(id);
      if (existing === undefined) {
        const rootKey = workspaceRootKey(root);
        for (const entry of byId.values()) {
          if (workspaceRootKey(entry.root) === rootKey) {
            existing = entry;
            break;
          }
        }
      }
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
      byId.set(ws.id, ws);
      deletedIds.delete(ws.id);
      await this.store.save({ workspaces: [...byId.values()], deletedIds: [...deletedIds] });
      this.event.publish(
        existing === undefined
          ? new WorkspaceCreated({ payload: { workspace: ws } })
          : new WorkspaceUpdated({ payload: { workspace: ws } }),
      );
      return ws;
    });
  }

  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const existing = catalog.workspaces.find((ws) => ws.id === id);
      if (existing === undefined) return undefined;
      const updated: Workspace = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
      };
      await this.store.save({
        workspaces: catalog.workspaces.map((ws) => (ws.id === id ? updated : ws)),
        deletedIds: catalog.deletedIds,
      });
      this.event.publish(new WorkspaceUpdated({ payload: { workspace: updated } }));
      return updated;
    });
  }

  delete(id: string): Promise<void> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      let root = catalog.workspaces.find((ws) => ws.id === id)?.root;
      if (root === undefined) {
        root = (await readSessionIndexEntries(this.storage)).find(
          (line) => encodeWorkDirKey(line.workDir) === id,
        )?.workDir;
      }
      if (root === undefined) {
        await this.store.save({
          workspaces: catalog.workspaces.filter((ws) => ws.id !== id),
          deletedIds: [...new Set([...catalog.deletedIds, id])],
        });
        return;
      }
      const rootKey = workspaceRootKey(root);
      const aliasIds = collectAliasIds(
        catalog.workspaces,
        await readSessionIndexEntries(this.storage),
        root,
      );
      await this.store.save({
        workspaces: catalog.workspaces.filter((ws) => workspaceRootKey(ws.root) !== rootKey),
        deletedIds: [...new Set([...catalog.deletedIds, ...aliasIds])],
      });
      this.event.publish(new WorkspaceDeleted({ payload: { workspaceId: id, root } }));
    });
  }

  private async ensureMerged(): Promise<void> {
    if (this.merged) return;
    const loaded = await this.store.load();
    if (loaded === undefined) {
      const rebuilt = await this.rebuildFromSessionIndex();
      await this.store.save({ workspaces: [...rebuilt.values()], deletedIds: [] });
      this.merged = true;
      return;
    }
    const byId = new Map(loaded.workspaces.map((ws) => [ws.id, ws]));
    const deletedIds = new Set(loaded.deletedIds);
    if (await this.mergeFromSessionIndex(byId, deletedIds)) {
      await this.store.save({ workspaces: [...byId.values()], deletedIds: [...deletedIds] });
    }
    this.merged = true;
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
    for (const workDir of await readSessionIndexWorkDirs(this.storage)) {
      const id = encodeWorkDirKey(workDir);
      if (byId.has(id) || deletedIds.has(id)) continue;
      byId.set(id, {
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
    const seenRootKeys = new Set<string>();
    for (const entry of await readSessionIndexEntries(this.storage)) {
      if (!isAbsolute(entry.workDir)) continue;
      const rootKey = workspaceRootKey(entry.workDir);
      if (seenRootKeys.has(rootKey)) continue;
      seenRootKeys.add(rootKey);
      const id = encodeWorkDirKey(entry.workDir);
      result.set(id, {
        id,
        root: entry.workDir,
        name: basename(entry.workDir),
        createdAt: now,
        lastOpenedAt: now,
      });
    }
    return result;
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
