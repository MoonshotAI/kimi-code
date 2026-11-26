import { LifecycleScope } from '#/app/scopes';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { isWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IProjectService, type Project } from '#/app/project/project';
import {
  legacyBucketRoot,
  readSessionIndexEntries,
  SESSION_INDEX_KEY,
  SESSION_INDEX_SCOPE,
  type LegacyBucketRoot,
} from '#/app/project/projectAlias';
import { IProjectPersistence } from '#/app/project/projectPersistence';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { IProjectAliases } from './projectAliases';

interface CatalogSnapshot {
  readonly byId: ReadonlyMap<string, Project>;
  readonly wdIdsByRootKey: ReadonlyMap<string, readonly string[]>;
}

interface SessionIndexSnapshot {
  readonly idsByRootKey: ReadonlyMap<string, readonly string[]>;
  readonly rootKeyById: ReadonlyMap<string, string>;
}

function rootKeyIndex<T>(
  items: readonly T[],
  rootOf: (item: T) => string,
  idOf: (item: T) => string,
): Map<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const item of items) {
    const key = workspaceRootKey(rootOf(item));
    const id = idOf(item);
    const bucket = map.get(key);
    if (bucket === undefined) {
      map.set(key, [id]);
    } else if (!bucket.includes(id)) {
      bucket.push(id);
    }
  }
  return map;
}

export class ProjectAliasesService extends Disposable implements IProjectAliases {
  declare readonly _serviceBrand: undefined;

  private catalogCache: CatalogSnapshot | undefined;
  private sessionIndexCache: { snapshot: SessionIndexSnapshot; size: number | undefined } | undefined;
  private catalogPromise:
    | Promise<{ snapshot: CatalogSnapshot; generation: number }>
    | undefined;
  private sessionIndexPromise:
    | Promise<{ snapshot: SessionIndexSnapshot; generation: number }>
    | undefined;
  private invalidationGeneration = 0;
  private catalogMergePrimed = false;

  constructor(
    @IProjectService private readonly projects: IProjectService,
    @IProjectPersistence private readonly store: IProjectPersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAppendLogStore private readonly appendLogs: IAppendLogStore,
  ) {
    super();
    this._register(
      this.store.onDidChange(() => {
        this.invalidationGeneration += 1;
        this.catalogCache = undefined;
      }),
    );
    this._register(
      this.appendLogs.onDidWrite((write) => {
        if (write.scope === SESSION_INDEX_SCOPE && write.key === SESSION_INDEX_KEY) {
          this.invalidationGeneration += 1;
          this.sessionIndexCache = undefined;
        }
      }),
    );
  }

  async resolveAliasIds(id: string): Promise<readonly string[]> {
    if (!isWorkDirKey(id)) return [id];
    for (;;) {
      const generation = this.invalidationGeneration;
      const [catalog, index] = await Promise.all([this.catalog(), this.sessionIndex()]);
      if (generation !== this.invalidationGeneration) continue;
      const entry = catalog.byId.get(id);
      const rootKey =
        entry !== undefined ? workspaceRootKey(entry.root) : index.rootKeyById.get(id);
      if (rootKey === undefined) return [id];
      const fromCatalog = catalog.wdIdsByRootKey.get(rootKey);
      const fromIndex = index.idsByRootKey.get(rootKey);
      const merged = fromCatalog === undefined ? [id] : [...fromCatalog];
      if (!merged.includes(id)) merged.push(id);
      if (fromIndex !== undefined) {
        for (const alias of fromIndex) {
          if (!merged.includes(alias)) merged.push(alias);
        }
      }
      return merged;
    }
  }

  private async catalog(): Promise<CatalogSnapshot> {
    if (this.catalogCache !== undefined) return this.catalogCache;
    this.catalogPromise ??= this.loadCatalog();
    const { snapshot, generation } = await this.catalogPromise;
    if (generation !== this.invalidationGeneration) return this.catalog();
    return snapshot;
  }

  private async loadCatalog(): Promise<{ snapshot: CatalogSnapshot; generation: number }> {
    try {
      if (!this.catalogMergePrimed) {
        await this.projects.list();
        this.catalogMergePrimed = true;
      }
      const generation = this.invalidationGeneration;
      const workspaces = (await this.store.load())?.workspaces ?? [];
      const snapshot: CatalogSnapshot = {
        byId: new Map(workspaces.map((ws) => [ws.id, ws] as const)),
        wdIdsByRootKey: rootKeyIndex(
          workspaces.filter((ws) => isWorkDirKey(ws.id)),
          (ws) => ws.root,
          (ws) => ws.id,
        ),
      };
      if (generation === this.invalidationGeneration) {
        this.catalogCache = snapshot;
      }
      return { snapshot, generation };
    } finally {
      this.catalogPromise = undefined;
    }
  }

  private async sessionIndex(): Promise<SessionIndexSnapshot> {
    const cache = this.sessionIndexCache;
    if (
      cache !== undefined &&
      (await this.storage.size(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY)) === cache.size
    ) {
      return cache.snapshot;
    }
    this.sessionIndexPromise ??= this.loadSessionIndex();
    const { snapshot, generation } = await this.sessionIndexPromise;
    if (generation !== this.invalidationGeneration) return this.sessionIndex();
    return snapshot;
  }

  private async loadSessionIndex(): Promise<{ snapshot: SessionIndexSnapshot; generation: number }> {
    try {
      const generation = this.invalidationGeneration;
      const roots = (await readSessionIndexEntries(this.storage))
        .map(legacyBucketRoot)
        .filter((root): root is LegacyBucketRoot => root !== undefined);
      const rootKeyById = new Map<string, string>();
      for (const root of roots) {
        rootKeyById.set(root.id, workspaceRootKey(root.root));
      }
      const snapshot: SessionIndexSnapshot = {
        idsByRootKey: rootKeyIndex(roots, (root) => root.root, (root) => root.id),
        rootKeyById,
      };
      if (generation === this.invalidationGeneration) {
        this.sessionIndexCache = {
          snapshot,
          size: await this.storage.size(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY),
        };
      }
      return { snapshot, generation };
    } finally {
      this.sessionIndexPromise = undefined;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IProjectAliases,
  ProjectAliasesService,
  ScopeActivation.OnScopeCreated,
  'workspaceAliases',
);
