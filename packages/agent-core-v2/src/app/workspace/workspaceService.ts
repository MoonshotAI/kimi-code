import { randomUUID } from 'node:crypto';

import { basename } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IEventService } from '#/app/event/event';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import {
  IProjectService,
  type Project,
  type ProjectCreate,
  type ProjectUpdate,
} from '#/app/project/project';
import {
  WorkspaceCreated,
  WorkspaceDeleted,
  WorkspaceUpdated,
} from './workspaceEvents';
import {
  hasOriginalImplicitRoot,
  implicitRoots,
  compactSessionIndexIfStale,
  dedupeByRoot,
  readSessionIndexEntries,
} from './workspaceAlias';
import { recoverImplicitProjects } from '#/app/project/projectRecovery';
import { resolveImplicitProject } from '#/app/project/implicitProject';
import { IWorkspacePersistence, type WorkspaceCatalog } from './workspacePersistence';

export class ProjectService implements IProjectService {
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
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
  ) {}

  list(): Promise<readonly Project[]> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const byId = new Map(catalog.workspaces.map((project) => [project.id, project]));
      return dedupeByRoot(byId, await this.originalRoots(catalog));
    });
  }

  get(id: string): Promise<Project | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      return catalog.workspaces.find((ws) => ws.id === id);
    });
  }

  implicitDirectories(cwd: string): Promise<readonly string[]> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const entries = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
      const project = await resolveImplicitProject(entries, await this.originalRoots(catalog), cwd);
      return [project.root, ...project.additionalDirs];
    });
  }

  createOrTouch(root: string, name?: string): Promise<Project> {
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
      let project!: Project;
      let existing = false;
      await this.store.update(async (catalog) => {
        const byId = new Map(catalog.workspaces.map((entry) => [entry.id, entry]));
        const deletedIds = new Set(catalog.deletedIds);
        project = await resolveImplicitProject(byId, await this.originalRoots(catalog), root, name);
        existing = byId.has(project.id);
        byId.set(project.id, project);
        deletedIds.delete(project.id);
        return {
          workspaces: [...byId.values()],
          deletedIds: [...deletedIds],
          idempotencyKeys: catalog.idempotencyKeys,
        };
      });
      this.event.publish(
        !existing
          ? new WorkspaceCreated({ payload: { workspace: project } })
          : new WorkspaceUpdated({ payload: { workspace: project } }),
      );
      return project;
    });
  }

  create(input: ProjectCreate): Promise<Project> {
    return this.runExclusive(async () => {
      await this.requireDirectory(input.root);
      const additionalDirs = await this.normalizeAdditionalDirs(
        input.root,
        input.additionalDirs ?? [],
      );
      await this.ensureMerged();
      let ws!: Project;
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

  touch(id: string): Promise<Project | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      let touched: Project | undefined;
      await this.store.update((catalog) => {
        const existing = catalog.workspaces.find((ws) => ws.id === id);
        if (existing === undefined) return catalog;
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

  update(id: string, patch: ProjectUpdate): Promise<Project | undefined> {
    return this.changeProject(id, async (existing) => ({
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      additionalDirs: patch.additionalDirs === undefined
        ? existing.additionalDirs
        : await this.normalizeAdditionalDirs(existing.root, patch.additionalDirs),
    }));
  }

  addDirectory(id: string, dir: string): Promise<Project | undefined> {
    return this.changeProject(id, async (existing) => {
      const [resolved] = await this.localConfig.resolveAdditionalDirs(existing.root, [dir]);
      if (resolved === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, `additional dir ${dir} did not resolve`);
      const key = workspaceRootKey(resolved);
      if (workspaceRootKey(existing.root) === key || existing.additionalDirs.some((kept) => workspaceRootKey(kept) === key)) {
        return existing;
      }
      return { ...existing, additionalDirs: [...existing.additionalDirs, resolved] };
    });
  }

  private changeProject(
    id: string,
    change: (existing: Project) => Promise<Project>,
  ): Promise<Project | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      let updated: Project | undefined;
      let changed = false;
      await this.store.update(async (catalog) => {
        const existing = catalog.workspaces.find((ws) => ws.id === id);
        if (existing === undefined) return catalog;
        const next = await change(existing);
        updated = next;
        if (existing === next) return catalog;
        changed = true;
        return { ...catalog, workspaces: catalog.workspaces.map((ws) => ws.id === id ? next : ws) };
      });
      if (changed && updated !== undefined) {
        this.event.publish(new WorkspaceUpdated({ payload: { workspace: updated } }));
      }
      return updated;
    });
  }

  setPrimary(id: string, path: string): Promise<Project | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      let updated: Project | undefined;
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
      let deletedWorkspace: Project | undefined;
      await this.store.update(async (catalog) => {
        deletedWorkspace = catalog.workspaces.find((ws) => ws.id === id);
        const roots = implicitRoots(catalog.workspaces, await readSessionIndexEntries(this.storage));
        const origin = roots.get(id);
        const removedIds = new Set([id]);
        if (origin !== undefined) {
          const key = workspaceRootKey(origin);
          for (const [alias, root] of roots) {
            if (workspaceRootKey(root) === key) removedIds.add(alias);
          }
        }
        deletedRoot = deletedWorkspace?.root ?? origin;
        return {
          workspaces: catalog.workspaces.filter((ws) => !removedIds.has(ws.id)),
          deletedIds: [...new Set([...catalog.deletedIds, ...removedIds])],
          idempotencyKeys: catalog.idempotencyKeys,
        };
      });
      if (deletedRoot !== undefined) {
        this.event.publish(new WorkspaceDeleted({ payload: { workspaceId: id, root: deletedRoot, workspace: deletedWorkspace } }));
      }
    });
  }

  private async ensureMerged(): Promise<void> {
    if (this.merged) return;
    const catalog = await this.loadCatalog();
    const recovered = await recoverImplicitProjects(catalog, this.storage, this.docs, this.log);
    if (recovered.length > 0) {
      await this.store.update((latest) => {
        const occupied = new Set([...latest.workspaces.map((ws) => ws.id), ...latest.deletedIds]);
        const additions = recovered.filter((ws) => !occupied.has(ws.id));
        return additions.length === 0 ? latest : { ...latest, workspaces: [...latest.workspaces, ...additions] };
      });
    }
    this.merged = true;
    await this.compactSessionIndex();
  }

  private async originalRoots(catalog: WorkspaceCatalog): Promise<Map<string, string>> {
    const needsHistory = catalog.workspaces.some(
      (project) => project.kind === 'implicit' && !hasOriginalImplicitRoot(project),
    );
    return implicitRoots(catalog.workspaces, needsHistory ? await readSessionIndexEntries(this.storage) : []);
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
  IProjectService,
  ProjectService,
  ScopeActivation.OnScopeCreated,
  'workspace',
);

export { ProjectService as WorkspaceService };
