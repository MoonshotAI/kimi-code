import { randomUUID } from 'node:crypto';

import { basename, isAbsolute } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import {
  encodeWorkDirKey,
  isWorkDirKey,
  toAbsoluteDir,
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

import {
  decideImplicitProject,
  implicitCatalogOf,
  isInProjectScope,
  reviveCandidates,
  reviveRoot,
  type ImplicitDecision,
  type ImplicitResolution,
  type ImplicitResolutionPorts,
  type ImplicitWorkspace,
} from './implicitProject';
import {
  IWorkspaceService,
  type ImplicitProjectResult,
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
  legacyBucketRoot,
  readSessionIndexEntries,
  sessionBucketOf,
  type LegacyBucketRoot,
  type SessionIndexLine,
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
    @IHostEnvironment private readonly hostEnvironment: IHostEnvironment,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
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

  resolveImplicit(dir: string): Promise<ImplicitProjectResult> {
    return this.runExclusive(async () => {
      await this.rejectNonDirectory(dir);
      await this.ensureMerged();
      const home = await this.homeDirs();
      let resolution!: ImplicitResolution;
      let committed!: { readonly project: ImplicitWorkspace; readonly created: boolean };
      await this.store.update(async (catalog) => {
        resolution = await this.decide(dir, catalog, home);
        const applied = applyImplicitDecision(catalog, resolution.decision, Date.now());
        committed = applied;
        return applied.catalog;
      });
      this.reportDegraded(dir, resolution.location);
      this.event.publish(
        committed.created
          ? new WorkspaceCreated({ payload: { workspace: committed.project } })
          : new WorkspaceUpdated({ payload: { workspace: committed.project } }),
      );
      return { project: committed.project, rule: resolution.decision.rule };
    });
  }

  peekImplicit(dir: string): Promise<ImplicitDecision> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const resolution = await this.decide(dir, await this.loadCatalog(), await this.homeDirs());
      this.reportDegraded(dir, resolution.location);
      return resolution.decision;
    });
  }

  reviveImplicit(id: string, workDir: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      let revived!: Workspace;
      let created = false;
      await this.store.update(async (catalog) => {
        const existing = catalog.workspaces.find((ws) => ws.id === id);
        if (existing !== undefined) {
          revived = existing;
          return catalog;
        }
        const root = isWorkDirKey(id) ? reviveRoot(id, await this.reviveCandidatesOf(workDir)) : undefined;
        if (root === undefined) {
          throw new Error2(
            ErrorCodes.WORKSPACE_NOT_FOUND,
            isWorkDirKey(id)
              ? `session project ${id} no longer exists and cannot be recreated from ${workDir}: neither the directory nor its main checkout hashes to that id`
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
      if (created) this.event.publish(new WorkspaceCreated({ payload: { workspace: revived } }));
      return revived;
    });
  }

  contains(project: Pick<Workspace, 'root' | 'additionalDirs'>, dir: string): Promise<boolean> {
    return isInProjectScope(this.hostFs, project, dir);
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
      let deletedWorkspace: Workspace | undefined;
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
        this.event.publish(new WorkspaceDeleted({ payload: { workspaceId: id, root: deletedRoot, workspace: deletedWorkspace } }));
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
      const recovered = await this.bucketRootOf(entry, (id) => byId.has(id) || deletedIds.has(id));
      if (recovered === undefined) continue;
      byId.set(recovered.id, implicitEntry(recovered.id, recovered.root, now));
      changed = true;
    }
    return changed;
  }

  private async rebuildFromSessionIndex(): Promise<Map<string, Workspace>> {
    const result = new Map<string, Workspace>();
    const now = Date.now();
    const seenRootKeys = new Set<string>();
    for (const entry of await readSessionIndexEntries(this.storage)) {
      const recovered = await this.bucketRootOf(entry, (id) => result.has(id));
      if (recovered === undefined) continue;
      const rootKey = workspaceRootKey(recovered.root);
      if (seenRootKeys.has(rootKey)) continue;
      seenRootKeys.add(rootKey);
      result.set(recovered.id, implicitEntry(recovered.id, recovered.root, now));
    }
    return result;
  }

  private async bucketRootOf(
    line: SessionIndexLine,
    known: (id: string) => boolean,
  ): Promise<LegacyBucketRoot | undefined> {
    if (!isAbsolute(line.workDir)) return undefined;
    const legacy = legacyBucketRoot(line);
    if (legacy !== undefined) return known(legacy.id) ? undefined : legacy;
    const bucket = sessionBucketOf(line);
    if (!isImplicitBucketSessionLine(line) || known(bucket)) return undefined;
    const workDir = toAbsoluteDir(line.workDir);
    if (workDir === undefined) return undefined;
    const location = await locateCheckout(this.hostFs, workDir);
    if (location.kind !== 'grouped') return undefined;
    const root = reviveRoot(bucket, [location.mainDir, location.canonicalMainDir]);
    return root === undefined ? undefined : { id: encodeWorkDirKey(root), root };
  }

  private async decide(
    dir: string,
    catalog: WorkspaceCatalog,
    homeDirs: readonly string[] | undefined,
  ): Promise<ImplicitResolution> {
    let indexLines: Promise<SessionIndexLine[]> | undefined;
    const ports: ImplicitResolutionPorts = {
      occupied: async (project) => {
        indexLines ??= readSessionIndexEntries(this.storage);
        return this.bucketsHoldSession([
          project.id,
          ...collectAliasIds(catalog.workspaces, await indexLines, project.root),
        ]);
      },
      locate: (target: AbsoluteDir) => locateCheckout(this.hostFs, target),
      realpath: (target) => this.realpathOrUndefined(target),
      homeDirs,
    };
    return decideImplicitProject(dir, implicitCatalogOf(catalog.workspaces, catalog.deletedIds), ports);
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
      const real = await this.realpathOrUndefined(home);
      return real === undefined ? [home] : [home, real];
    } catch (error) {
      this.log.warn('home directory is unavailable; implicit projects are not grouped by repository', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async reviveCandidatesOf(workDir: string): Promise<readonly (string | undefined)[]> {
    const absolute = toAbsoluteDir(workDir);
    const location = absolute === undefined ? undefined : await locateCheckout(this.hostFs, absolute);
    return reviveCandidates(workDir, await this.realpathOrUndefined(workDir), location);
  }

  private reportDegraded(dir: string, location: CheckoutLocation | undefined): void {
    if (location === undefined || !isDegradedLocation(location)) return;
    this.log.warn('project checkout could not be verified; the directory stays its own project', {
      dir,
      checkoutRoot: location.checkoutRoot,
      reason: location.reason,
    });
    this.telemetry.track2('project_locate_degraded', { reason: location.reason });
  }

  private async realpathOrUndefined(path: string): Promise<string | undefined> {
    try {
      return await this.hostFs.realpath(path);
    } catch {
      return undefined;
    }
  }

  private async rejectNonDirectory(dir: string): Promise<void> {
    let stat;
    try {
      stat = await this.hostFs.stat(dir);
    } catch {
      return;
    }
    if (stat.isDirectory) return;
    try {
      stat = await this.hostFs.stat(await this.hostFs.realpath(dir));
    } catch {
      return;
    }
    if (!stat.isDirectory) {
      throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${dir} is not a directory`);
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

function implicitEntry(id: string, root: string, now: number): ImplicitWorkspace {
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

function applyImplicitDecision(
  catalog: WorkspaceCatalog,
  decision: ImplicitDecision,
  now: number,
): { readonly catalog: WorkspaceCatalog; readonly project: ImplicitWorkspace; readonly created: boolean } {
  const id = decision.kind === 'reuse' ? decision.project.id : decision.id;
  const existing = catalog.workspaces.find((ws) => ws.id === id);
  const project: ImplicitWorkspace = decision.kind === 'reuse'
    ? { ...decision.project, lastOpenedAt: now }
    : existing === undefined
      ? implicitEntry(decision.id, decision.root, now)
      : { ...existing, kind: 'implicit', lastOpenedAt: now };
  return {
    catalog: {
      workspaces: existing === undefined
        ? [...catalog.workspaces, project]
        : catalog.workspaces.map((ws) => (ws.id === id ? project : ws)),
      deletedIds: catalog.deletedIds.filter((deleted) => deleted !== id),
      idempotencyKeys: catalog.idempotencyKeys,
    },
    project,
    created: existing === undefined,
  };
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceService,
  WorkspaceService,
  ScopeActivation.OnScopeCreated,
  'workspace',
);
