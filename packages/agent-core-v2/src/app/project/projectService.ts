import { randomUUID } from 'node:crypto';

import { basename, isAbsolute } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import {
  encodeWorkDirKey,
  isWorkDirKey,
  workspaceRootKey,
  type AbsoluteDir,
} from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { isDegradedLocation, locateCheckout, type CheckoutLocation } from '#/app/git/workTree';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { listSessionIds, readSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IProjectTrustStore } from '#/project/projectTrust/projectTrustStore';

import { decideImplicitProject, isNonDirectory, type ImplicitDecision } from './implicitProject';
import { projectDirAt } from './projectWorkDir';
import {
  IProjectService,
  type Project,
  type ProjectCreate,
  type ProjectUpdate,
} from './project';
import {
  ProjectCreated,
  ProjectDeleted,
  ProjectUpdated,
} from './projectEvents';
import {
  collectAliasIds,
  compactSessionIndexIfStale,
  dedupeByRoot,
  isImplicitBucketSessionLine,
  readSessionIndexEntries,
  sessionBucketOf,
} from './projectAlias';
import { IProjectPersistence, type ProjectCatalog } from './projectPersistence';

export class ProjectService implements IProjectService {
  declare readonly _serviceBrand: undefined;

  private merged = false;
  private opQueue: Promise<unknown> = Promise.resolve();
  private readonly degradedDirs = new Set<string>();

  constructor(
    @IProjectPersistence private readonly store: IProjectPersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAppendLogStore private readonly appendLogs: IAppendLogStore,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IProjectLocalConfigService private readonly localConfig: IProjectLocalConfigService,
    @ILogService private readonly log: ILogService,
    @IEventService private readonly event: IEventService,
    @IHostEnvironment private readonly hostEnvironment: IHostEnvironment,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IProjectTrustStore private readonly trustStore: IProjectTrustStore,
  ) {}

  list(): Promise<readonly Project[]> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const byId = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
      return dedupeByRoot(byId);
    });
  }

  get(id: string): Promise<Project | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      return catalog.workspaces.find((ws) => ws.id === id);
    });
  }

  resolveImplicit(dir: string): Promise<Project> {
    return this.runExclusive(async () => {
      if (await isNonDirectory(this.hostFs, dir)) {
        throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${dir} is not a directory`);
      }
      await this.ensureMerged();
      const homeDirs = await this.homeDirs();
      let ws!: Project;
      let existing: Project | undefined;
      await this.store.update(async (catalog) => {
        const byId = new Map(catalog.workspaces.map((entry) => [entry.id, entry]));
        const deletedIds = new Set(catalog.deletedIds);
        const decision = await this.decide(dir, catalog.workspaces, homeDirs);
        const now = Date.now();
        existing = decision.project;
        ws =
          existing !== undefined
            ? { ...existing, lastOpenedAt: now }
            : implicitEntry(decision.id, decision.root, now);
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
          ? new ProjectCreated({ payload: { workspace: ws } })
          : new ProjectUpdated({ payload: { workspace: ws } }),
      );
      return ws;
    });
  }

  peekImplicit(dir: string): Promise<ImplicitDecision> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      return this.decide(dir, (await this.loadCatalog()).workspaces, await this.homeDirs());
    });
  }

  reviveImplicit(id: string, workDir: string): Promise<Project> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      let revived!: Project;
      let created = false;
      await this.store.update(async (catalog) => {
        const existing = catalog.workspaces.find((ws) => ws.id === id);
        if (existing !== undefined) {
          revived = existing;
          return catalog;
        }
        const root = !isWorkDirKey(id)
          ? undefined
          : encodeWorkDirKey(workDir) === id
            ? workDir
            : (await this.bucketRoots()).get(id);
        if (root === undefined) {
          throw new Error2(
            ErrorCodes.WORKSPACE_NOT_FOUND,
            isWorkDirKey(id)
              ? `session project ${id} no longer exists and cannot be recreated from ${workDir}: neither that directory nor a directory its sessions recorded hashes to that id`
              : `session project ${id} no longer exists and only implicit projects can be recreated`,
          );
        }
        const now = Date.now();
        revived = implicitEntry(id, root, now);
        created = true;
        return {
          workspaces: [...catalog.workspaces, revived],
          deletedIds: catalog.deletedIds.filter((deleted) => deleted !== id),
          idempotencyKeys: catalog.idempotencyKeys,
        };
      });
      if (created) this.event.publish(new ProjectCreated({ payload: { workspace: revived } }));
      return revived;
    });
  }

  async projectDirAt(project: Pick<Project, 'root'>, dir: string): Promise<string | undefined> {
    return projectDirAt(project.root, dir, { fs: this.hostFs, homeDirs: await this.homeDirs() });
  }

  async acceptsWorkDir(project: Pick<Project, 'root'>, dir: string): Promise<boolean> {
    return (await this.projectDirAt(project, dir)) !== undefined;
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
      if (!reused) this.event.publish(new ProjectCreated({ payload: { workspace: ws } }));
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
        this.event.publish(new ProjectUpdated({ payload: { workspace: touched } }));
      }
      return touched;
    });
  }

  update(id: string, patch: ProjectUpdate): Promise<Project | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      let updated: Project | undefined;
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
        this.event.publish(new ProjectUpdated({ payload: { workspace: updated } }));
      }
      return updated;
    });
  }

  setPrimary(id: string, path: string): Promise<Project | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      let updated: Project | undefined;
      let previousRoot: string | undefined;
      await this.store.update(async (catalog) => {
        const existing = catalog.workspaces.find((ws) => ws.id === id);
        if (existing === undefined) return catalog;
        if (existing.kind === 'implicit') {
          throw new Error2(
            ErrorCodes.WORKSPACE_PRIMARY_IMMUTABLE,
            `project ${id} is implicit; its primary directory is the directory it was opened from and cannot change`,
          );
        }
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
        previousRoot = existing.root;
        return {
          workspaces: catalog.workspaces.map((ws) => (ws.id === id ? updated! : ws)),
          deletedIds: catalog.deletedIds,
          idempotencyKeys: catalog.idempotencyKeys,
        };
      });
      if (previousRoot === undefined || updated === undefined) return updated;
      try {
        await this.trustStore.carry(previousRoot, updated.root);
      } finally {
        this.event.publish(new ProjectUpdated({ payload: { workspace: updated } }));
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
        let root = deletedWorkspace?.root;
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
        this.event.publish(new ProjectDeleted({ payload: { workspaceId: id, root: deletedRoot, workspace: deletedWorkspace } }));
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

  private async loadCatalog(): Promise<ProjectCatalog> {
    return (await this.store.load()) ?? { workspaces: [], deletedIds: [] };
  }

  private async mergeFromSessionIndex(
    byId: Map<string, Project>,
    deletedIds: ReadonlySet<string>,
  ): Promise<boolean> {
    let changed = false;
    const now = Date.now();
    for (const [id, root] of await this.bucketRoots()) {
      if (byId.has(id) || deletedIds.has(id)) continue;
      byId.set(id, implicitEntry(id, root, now));
      changed = true;
    }
    return changed;
  }

  private async rebuildFromSessionIndex(): Promise<Map<string, Project>> {
    const result = new Map<string, Project>();
    const now = Date.now();
    const seenRootKeys = new Set<string>();
    for (const [id, root] of await this.bucketRoots()) {
      const rootKey = workspaceRootKey(root);
      if (seenRootKeys.has(rootKey)) continue;
      seenRootKeys.add(rootKey);
      result.set(id, implicitEntry(id, root, now));
    }
    return result;
  }

  private async bucketRoots(): Promise<Map<string, string>> {
    const roots = new Map<string, string>();
    for (const entry of await readSessionIndexEntries(this.storage)) {
      if (!isImplicitBucketSessionLine(entry)) continue;
      const bucket = sessionBucketOf(entry);
      if (roots.has(bucket)) continue;
      const root = [entry.projectRoot, entry.workDir].find(
        (dir) => dir !== undefined && isAbsolute(dir) && encodeWorkDirKey(dir) === bucket,
      );
      if (root !== undefined) roots.set(bucket, root);
    }
    return roots;
  }

  private decide(
    dir: string,
    workspaces: readonly Project[],
    homeDirs: readonly string[] | undefined,
  ): Promise<ImplicitDecision> {
    return decideImplicitProject(dir, workspaces, {
      occupied: async (project) => {
        if (await this.bucketsHoldSession([project.id])) return true;
        const indexLines = await readSessionIndexEntries(this.storage);
        return this.bucketsHoldSession(collectAliasIds(workspaces, indexLines, project.root));
      },
      locate: (target) => this.locate(target),
      homeDirs,
    });
  }

  private async locate(dir: AbsoluteDir): Promise<CheckoutLocation> {
    const location = await locateCheckout(this.hostFs, dir);
    if (isDegradedLocation(location) && !this.degradedDirs.has(dir)) {
      this.degradedDirs.add(dir);
      this.log.warn('project checkout could not be verified; the directory stays its own project', {
        dir,
        checkoutRoot: location.checkoutRoot,
        reason: location.reason,
      });
      this.telemetry.track2('project_locate_degraded', { reason: location.reason });
    }
    return location;
  }

  private async bucketsHoldSession(ids: readonly string[]): Promise<boolean> {
    const sessionsScope = this.bootstrap.scope('sessions');
    for (const id of new Set(ids)) {
      for (const sessionId of await listSessionIds(this.storage, sessionsScope, id)) {
        if ((await readSessionSummary(this.docs, sessionsScope, id, sessionId)) !== undefined) return true;
      }
    }
    return false;
  }

  private async homeDirs(): Promise<readonly string[] | undefined> {
    try {
      await this.hostEnvironment.ready;
      const home = this.hostEnvironment.homeDir;
      if (home.length === 0) return undefined;
      return [home, await this.hostFs.realpath(home).catch(() => home)];
    } catch (error) {
      this.log.warn('home directory is unavailable; implicit projects are not grouped by repository', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
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

function implicitEntry(id: string, root: string, now: number): Project {
  return {
    id,
    root,
    name: basename(root),
    kind: 'implicit',
    additionalDirs: [],
    createdAt: now,
    lastOpenedAt: now,
  };
}

registerScopedService(
  LifecycleScope.App,
  IProjectService,
  ProjectService,
  ScopeActivation.OnScopeCreated,
  'workspace',
);
