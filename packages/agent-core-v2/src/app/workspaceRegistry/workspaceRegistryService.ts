/**
 * `workspaceRegistry` domain (L2) — `IWorkspaceRegistry` implementation.
 *
 * Owns explicitly registered workspaces and deletion tombstones. Reads a fresh
 * catalog for every operation; mutations hold the persistence write lock from
 * load through atomic save so v1, v2, and multiple daemon processes cannot
 * overwrite each other. Normalizes roots and chooses one public representative
 * per root (canonical when present, otherwise the persisted alias). Session-
 * derived workspaces are composed by
 * `workspaceQuery`. Bound at App scope.
 */

import { basename, isAbsolute, relative, resolve } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { encodeWorkDirKey, normalizeWorkDir } from '#/_base/utils/workdir-slug';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import {
  IWorkspaceRegistry,
  type Workspace,
  type WorkspaceRegistrySnapshot,
  type WorkspaceUpdate,
} from './workspaceRegistry';
import { IWorkspacePersistence, type WorkspaceCatalog } from './workspacePersistence';

interface WorkspaceCatalogState {
  readonly workspaces: Map<string, Workspace>;
  readonly deletedWorkspaceIds: Set<string>;
  readonly deletedWorkspaceRoots: Map<string, string>;
}

interface SessionIndexLine {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

export class WorkspaceRegistryService implements IWorkspaceRegistry {
  declare readonly _serviceBrand: undefined;

  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @IWorkspacePersistence private readonly store: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  async list(): Promise<readonly Workspace[]> {
    const snapshot = await this.snapshot();
    const deletedRoots = normalizedDeletedRoots(snapshot);
    return dedupeByRoot(
      snapshot.workspaces.filter(
        (workspace) =>
          !snapshot.deletedWorkspaceIds.has(workspace.id) &&
          !deletedRoots.has(normalizeWorkDir(workspace.root)),
      ),
    );
  }

  snapshot(): Promise<WorkspaceRegistrySnapshot> {
    return this.runExclusive(() =>
      this.store.withWriteLock(async () => {
        const catalog = await this.store.load();
        if (catalog !== undefined) {
          const state = toCatalogState(catalog);
          if (
            state.workspaces.size === 0 &&
            state.deletedWorkspaceIds.size === 0 &&
            state.deletedWorkspaceRoots.size === 0
          ) {
            const derived = await this.rebuildFromSessionIndex();
            for (const workspace of derived.workspaces.values()) {
              state.workspaces.set(workspace.id, workspace);
            }
          }
          return toSnapshot(state);
        }
        const rebuilt = await this.rebuildFromSessionIndex();
        await this.store.save(toPersistedCatalog(rebuilt));
        return toSnapshot(rebuilt);
      }),
    );
  }

  async get(id: string): Promise<Workspace | undefined> {
    const snapshot = await this.snapshot();
    if (snapshot.deletedWorkspaceIds.has(id)) return undefined;
    const workspace =
      snapshot.workspaces.find((candidate) => candidate.id === id) ??
      findRepresentativeWorkspace(snapshot.workspaces, id);
    if (workspace === undefined) {
      const derived = (await this.rebuildFromSessionIndex()).workspaces.get(id);
      if (derived === undefined) return undefined;
      const root = normalizeWorkDir(derived.root);
      if (normalizedDeletedRoots(snapshot).has(root)) return undefined;
      const registered = findRepresentativeWorkspace(
        snapshot.workspaces,
        encodeWorkDirKey(root),
      );
      return { ...(registered ?? derived), id, root };
    }
    const root = normalizeWorkDir(workspace.root);
    if (normalizedDeletedRoots(snapshot).has(root)) return undefined;
    return { ...workspace, root };
  }

  async createOrTouch(root: string, name?: string): Promise<Workspace> {
    const normalizedRoot = normalizeWorkDir(root);
    let stat;
    try {
      stat = await this.hostFs.stat(normalizedRoot);
    } catch (error) {
      const code = (unwrapErrorCause(error) as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new Error2(
          ErrorCodes.FS_PATH_NOT_FOUND,
          `workspace root ${normalizedRoot} does not exist`,
        );
      }
      throw error;
    }
    if (!stat.isDirectory) {
      throw new Error2(
        ErrorCodes.FS_PATH_NOT_FOUND,
        `workspace root ${normalizedRoot} is not a directory`,
      );
    }

    return this.mutate(async (catalog) => {
      const next = cloneCatalog(catalog);
      const id = encodeWorkDirKey(normalizedRoot);
      let aliases = [...next.workspaces.values()].filter(
        (workspace) => normalizeWorkDir(workspace.root) === normalizedRoot,
      );
      if (aliases.length === 0) {
        const recovered = [...(await this.rebuildFromSessionIndex()).workspaces.values()].find(
          (workspace) => normalizeWorkDir(workspace.root) === normalizedRoot,
        );
        if (recovered !== undefined) {
          next.workspaces.set(recovered.id, recovered);
          aliases = [recovered];
        }
      }
      const existing = aliases.find((workspace) => workspace.id === id) ?? aliases[0];
      const representativeId = existing?.id ?? id;
      const now = Date.now();
      const workspace: Workspace = {
        id: representativeId,
        root: normalizedRoot,
        name: existing?.name ?? name ?? basename(normalizedRoot),
        createdAt: existing?.createdAt ?? now,
        lastOpenedAt: now,
      };
      next.workspaces.set(representativeId, workspace);
      clearTombstones(next, representativeId, normalizedRoot);
      return { next, value: workspace };
    });
  }

  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined> {
    return this.mutate(async (catalog) => {
      const next = cloneCatalog(catalog);
      let existing = findRepresentativeWorkspace([...next.workspaces.values()], id);
      if (existing === undefined) {
        const recovered = (await this.rebuildFromSessionIndex()).workspaces.get(id);
        if (recovered !== undefined) {
          next.workspaces.set(recovered.id, recovered);
          existing = recovered;
        }
      }
      if (existing === undefined) return { next: catalog, value: undefined };
      const root = normalizeWorkDir(existing.root);
      const aliases = [...next.workspaces.values()].filter(
        (workspace) => normalizeWorkDir(workspace.root) === root,
      );
      const representativeId =
        aliases.find((workspace) => workspace.id === encodeWorkDirKey(root))?.id ??
        aliases[0]?.id ??
        existing.id;
      const updated: Workspace = {
        ...(next.workspaces.get(representativeId) ?? existing),
        id: representativeId,
        root,
        name: patch.name ?? existing.name,
      };
      next.workspaces.set(representativeId, updated);
      return { next, value: updated };
    });
  }

  delete(id: string, suppliedRoot?: string): Promise<void> {
    return this.mutate((catalog) => {
      const next = cloneCatalog(catalog);
      const existing =
        next.workspaces.get(id) ??
        [...next.workspaces.values()].find(
          (workspace) => encodeWorkDirKey(normalizeWorkDir(workspace.root)) === id,
        );
      const root =
        suppliedRoot === undefined && existing === undefined
          ? undefined
          : normalizeWorkDir(suppliedRoot ?? existing!.root);
      if (root !== undefined) {
        for (const [aliasId, workspace] of next.workspaces) {
          if (normalizeWorkDir(workspace.root) !== root) continue;
          next.workspaces.delete(aliasId);
          next.deletedWorkspaceIds.add(aliasId);
          next.deletedWorkspaceRoots.set(aliasId, root);
        }
        next.deletedWorkspaceRoots.set(id, root);
      }
      next.deletedWorkspaceIds.add(id);
      return { next, value: undefined };
    });
  }

  private mutate<T>(
    operation: (catalog: WorkspaceCatalogState) => {
      readonly next: WorkspaceCatalogState;
      readonly value: T;
    } | Promise<{
      readonly next: WorkspaceCatalogState;
      readonly value: T;
    }>,
  ): Promise<T> {
    return this.runExclusive(() =>
      this.store.withWriteLock(async () => {
        const result = await operation(await this.load());
        await this.store.save(toPersistedCatalog(result.next));
        return result.value;
      }),
    );
  }

  private async load(): Promise<WorkspaceCatalogState> {
    const catalog = await this.store.load();
    if (catalog !== undefined) return toCatalogState(catalog);
    return this.rebuildFromSessionIndex();
  }

  private async rebuildFromSessionIndex(): Promise<WorkspaceCatalogState> {
    const result = new Map<string, Workspace>();
    const bytes = await this.storage.read('', 'session_index.jsonl');
    if (bytes === undefined) {
      return { workspaces: result, deletedWorkspaceIds: new Set(), deletedWorkspaceRoots: new Map() };
    }
    const now = Date.now();
    for (const line of new TextDecoder().decode(bytes).split(/\r?\n/)) {
      const entry = parseSessionIndexLine(line.trim());
      if (entry === undefined || !isAbsolute(entry.workDir)) continue;
      const root = normalizeWorkDir(entry.workDir);
      const id = sessionBucketId(entry.sessionDir, entry.sessionId, this.bootstrap.sessionsDir);
      if (id === undefined || result.has(id)) continue;
      result.set(id, {
        id,
        root,
        name: basename(root),
        createdAt: now,
        lastOpenedAt: now,
      });
    }
    return {
      workspaces: result,
      deletedWorkspaceIds: new Set(),
      deletedWorkspaceRoots: new Map(),
    };
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(operation, operation);
    this.opQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function sessionBucketId(
  sessionDir: string,
  sessionId: string,
  sessionsDir: string,
): string | undefined {
  if (!isAbsolute(sessionDir) || !isAbsolute(sessionsDir)) return undefined;
  const relativePath = relative(resolve(sessionsDir), resolve(sessionDir));
  const segments = relativePath.split('/');
  if (
    segments.length !== 2 ||
    segments[1] !== sessionId ||
    segments[0] === '' ||
    segments[0] === '.' ||
    segments[0] === '..' ||
    relativePath.startsWith('../') ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return segments[0];
}

function cloneCatalog(catalog: WorkspaceCatalogState): WorkspaceCatalogState {
  return {
    workspaces: new Map(catalog.workspaces),
    deletedWorkspaceIds: new Set(catalog.deletedWorkspaceIds),
    deletedWorkspaceRoots: new Map(catalog.deletedWorkspaceRoots),
  };
}

function toCatalogState(catalog: WorkspaceCatalog): WorkspaceCatalogState {
  return {
    workspaces: new Map(catalog.workspaces.map((workspace) => [workspace.id, workspace])),
    deletedWorkspaceIds: new Set(catalog.deletedWorkspaceIds),
    deletedWorkspaceRoots: new Map(Object.entries(catalog.deletedWorkspaceRoots)),
  };
}

function parseSessionIndexLine(line: string): SessionIndexLine | undefined {
  if (line === '') return undefined;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const value = parsed as Partial<SessionIndexLine>;
    if (
      typeof value.sessionId !== 'string' ||
      typeof value.sessionDir !== 'string' ||
      typeof value.workDir !== 'string'
    ) {
      return undefined;
    }
    return value as SessionIndexLine;
  } catch {
    return undefined;
  }
}

function toSnapshot(catalog: WorkspaceCatalogState): WorkspaceRegistrySnapshot {
  return {
    workspaces: [...catalog.workspaces.values()],
    deletedWorkspaceIds: new Set(catalog.deletedWorkspaceIds),
    deletedWorkspaceRoots: new Map(catalog.deletedWorkspaceRoots),
  };
}

function toPersistedCatalog(catalog: WorkspaceCatalogState): WorkspaceCatalog {
  return {
    workspaces: [...catalog.workspaces.values()],
    deletedWorkspaceIds: [...catalog.deletedWorkspaceIds],
    deletedWorkspaceRoots: Object.fromEntries(catalog.deletedWorkspaceRoots),
  };
}

function findRepresentativeWorkspace(
  workspaces: readonly Workspace[],
  workspaceId: string,
): Workspace | undefined {
  const exact = workspaces.find((workspace) => workspace.id === workspaceId);
  const candidates =
    exact === undefined
      ? workspaces.filter(
          (workspace) => encodeWorkDirKey(normalizeWorkDir(workspace.root)) === workspaceId,
        )
      : workspaces.filter(
          (workspace) =>
            normalizeWorkDir(workspace.root) === normalizeWorkDir(exact.root),
        );
  if (candidates.length === 0) return undefined;
  const root = normalizeWorkDir(candidates[0]!.root);
  const canonicalId = encodeWorkDirKey(root);
  return candidates.find((workspace) => workspace.id === canonicalId) ?? candidates[0];
}

function dedupeByRoot(workspaces: readonly Workspace[]): Workspace[] {
  const byRoot = new Map<string, { workspace: Workspace; canonical: boolean }>();
  for (const workspace of workspaces) {
    const root = normalizeWorkDir(workspace.root);
    const canonicalId = encodeWorkDirKey(root);
    const candidate = { ...workspace, root };
    const existing = byRoot.get(root);
    const canonical = workspace.id === canonicalId;
    if (existing === undefined || (!existing.canonical && canonical)) {
      byRoot.set(root, { workspace: candidate, canonical });
    }
  }
  return [...byRoot.values()].map(({ workspace }) => workspace);
}

function normalizedDeletedRoots(snapshot: WorkspaceRegistrySnapshot): ReadonlySet<string> {
  const roots = new Set(
    [...snapshot.deletedWorkspaceRoots.values()].map((root) => normalizeWorkDir(root)),
  );
  for (const workspace of snapshot.workspaces) {
    if (snapshot.deletedWorkspaceIds.has(workspace.id)) {
      roots.add(normalizeWorkDir(workspace.root));
    }
  }
  return roots;
}

function clearTombstones(catalog: WorkspaceCatalogState, id: string, root: string): void {
  const cleared: string[] = [];
  for (const deletedId of catalog.deletedWorkspaceIds) {
    const deletedRoot = catalog.deletedWorkspaceRoots.get(deletedId);
    if (
      deletedId === id ||
      (deletedRoot !== undefined && normalizeWorkDir(deletedRoot) === root)
    ) {
      cleared.push(deletedId);
    }
  }
  for (const deletedId of cleared) {
    catalog.deletedWorkspaceIds.delete(deletedId);
    catalog.deletedWorkspaceRoots.delete(deletedId);
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceRegistry,
  WorkspaceRegistryService,
  InstantiationType.Delayed,
  'workspaceRegistry',
);
