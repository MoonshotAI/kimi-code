import { LifecycleScope } from '#/app/scopes';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { encodeWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import {
  readSessionIndexEntries,
  SESSION_INDEX_KEY,
  SESSION_INDEX_SCOPE,
} from '#/app/workspace/workspaceAlias';
import { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { IWorkspaceAliases } from './workspaceAliases';

interface CatalogSnapshot {
  readonly byId: ReadonlyMap<string, Workspace>;
  readonly idsByRootKey: ReadonlyMap<string, readonly string[]>;
}

interface SessionIndexSnapshot {
  readonly idsByRootKey: ReadonlyMap<string, readonly string[]>;
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

export class WorkspaceAliasesService extends Disposable implements IWorkspaceAliases {
  declare readonly _serviceBrand: undefined;

  private catalogCache: CatalogSnapshot | undefined;
  private sessionIndexCache: SessionIndexSnapshot | undefined;
  private catalogPromise: Promise<CatalogSnapshot> | undefined;
  private sessionIndexPromise: Promise<SessionIndexSnapshot> | undefined;
  private invalidationGeneration = 0;
  private readonly sessionIndexCacheable: boolean;
  private catalogMergePrimed = false;

  constructor(
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @IWorkspacePersistence private readonly store: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
  ) {
    super();
    this._register(
      this.store.onDidChange(() => {
        this.invalidationGeneration += 1;
        this.catalogCache = undefined;
      }),
    );
    const watchSessionIndex = this.storage.watch?.(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY);
    this.sessionIndexCacheable = watchSessionIndex !== undefined;
    if (watchSessionIndex !== undefined) {
      this._register(
        watchSessionIndex(() => {
          this.invalidationGeneration += 1;
          this.sessionIndexCache = undefined;
        }),
      );
    }
  }

  async resolveAliasIds(id: string): Promise<readonly string[]> {
    const catalog = await this.catalog();
    const entry = catalog.byId.get(id);
    if (entry === undefined) return [id];
    const rootKey = workspaceRootKey(entry.root);
    const index = await this.sessionIndex();
    const fromCatalog = catalog.idsByRootKey.get(rootKey);
    const fromIndex = index.idsByRootKey.get(rootKey);
    if (fromCatalog === undefined) return fromIndex ?? [id];
    if (fromIndex === undefined) return fromCatalog;
    const merged = [...fromCatalog];
    for (const alias of fromIndex) {
      if (!merged.includes(alias)) merged.push(alias);
    }
    return merged;
  }

  private catalog(): Promise<CatalogSnapshot> {
    if (this.catalogCache !== undefined) return Promise.resolve(this.catalogCache);
    this.catalogPromise ??= this.loadCatalog();
    return this.catalogPromise;
  }

  private async loadCatalog(): Promise<CatalogSnapshot> {
    try {
      if (!this.catalogMergePrimed) {
        await this.workspaces.list();
        this.catalogMergePrimed = true;
      }
      const generation = this.invalidationGeneration;
      const workspaces = (await this.store.load())?.workspaces ?? [];
      const snapshot: CatalogSnapshot = {
        byId: new Map(workspaces.map((ws) => [ws.id, ws] as const)),
        idsByRootKey: rootKeyIndex(
          workspaces,
          (ws) => ws.root,
          (ws) => ws.id,
        ),
      };
      if (generation === this.invalidationGeneration) {
        this.catalogCache = snapshot;
      }
      return snapshot;
    } finally {
      this.catalogPromise = undefined;
    }
  }

  private sessionIndex(): Promise<SessionIndexSnapshot> {
    if (this.sessionIndexCache !== undefined) return Promise.resolve(this.sessionIndexCache);
    this.sessionIndexPromise ??= this.loadSessionIndex();
    return this.sessionIndexPromise;
  }

  private async loadSessionIndex(): Promise<SessionIndexSnapshot> {
    try {
      const generation = this.invalidationGeneration;
      const entries = await readSessionIndexEntries(this.storage);
      const snapshot: SessionIndexSnapshot = {
        idsByRootKey: rootKeyIndex(entries, (entry) => entry.workDir, (entry) =>
          encodeWorkDirKey(entry.workDir),
        ),
      };
      if (this.sessionIndexCacheable && generation === this.invalidationGeneration) {
        this.sessionIndexCache = snapshot;
      }
      return snapshot;
    } finally {
      this.sessionIndexPromise = undefined;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceAliases,
  WorkspaceAliasesService,
  ScopeActivation.OnScopeCreated,
  'workspaceAliases',
);
