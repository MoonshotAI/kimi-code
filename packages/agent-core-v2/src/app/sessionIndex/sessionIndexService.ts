/**
 * `sessionIndex` domain (L2) — `FileSessionIndex` implementation.
 *
 * Reads the persisted session set through the `storage` access-pattern stores,
 * rooted at the `sessionsDir` path layout fact from `bootstrap`. The directory
 * tree `<sessionsDir>/<workspaceId>/<sessionId>/` is the index: workspace and
 * session ids are enumerated via `IFileSystemStorageService.list`, and each session's
 * metadata document is read via `IAtomicDocumentStore` to build its summary.
 *
 * One physical folder may be split across sibling buckets by legacy id
 * spellings (Windows casing/slash variants minted different `workspaceId`s for
 * the same directory; see `IWorkspaceAliases.resolveAliasIds`). A list or
 * `countActive` query takes the workspace-id *set*, enumerates each bucket,
 * and merges before the single recency sort and `limit` step — the merged
 * listing is observably identical to a single-bucket list (same sort key,
 * same cursor shape); filtering options keep their meaning.
 *
 * The session metadata document lives at `<sessionDir>/state.json`, a layout
 * shared by v1 and v2; the `version` field distinguishes them (`2` = v2,
 * epoch-ms timestamps; absent = v1, ISO-string timestamps). The reader also
 * falls back to the legacy `<sessionDir>/session-meta/state.json` path for v2
 * sessions written before the layouts were unified. Both timestamp
 * representations are normalized to epoch ms.
 *
 * Read model (flag `persistence_minidb_readmodel`): when enabled, summaries are
 * served from the `IQueryStore` derived read model instead of re-reading and
 * re-parsing `state.json` on every call. Listing still enumerates the directory
 * (a cheap `readdir`) to discover `(workspaceId, sessionId)` pairs, but each
 * summary is resolved through the read model — falling back to a disk read +
 * backfill on a cold miss. Writes (create / archive / metadata update) keep the
 * read model warm via `SessionMetadata`; new sessions that have not been
 * mirrored yet are simply a cold miss and backfilled on first read. The legacy
 * N+1 path remains as the flag-off fallback — and as the runtime fallback if
 * the query store ever reports `storage.locked`: the first lock warns once and
 * disables the read model for the rest of the process lifetime. (The minidb
 * backend is a multi-process `ClusterDb` and no longer produces that error;
 * the wiring stays as defense in depth.)
 *
 * This is the local-deployment backend of `ISessionIndex`; a server deployment
 * would substitute a database-backed `DbSessionIndex`. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IQueryStore, type Page } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService, isStorageError, StorageErrors } from '#/persistence/interface/storage';

import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  ISessionIndex,
  PARENT_SESSION_ID_KEY,
  type SessionListQuery,
  type SessionSummary,
} from './sessionIndex';

const META_SCOPE = 'session-meta';
const META_KEY = 'state.json';
const SESSION_COLLECTION = 'session';
const READ_MODEL_FLAG = 'persistence_minidb_readmodel';

function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function recoverCwd(meta: Record<string, unknown>): string | undefined {
  if (typeof meta['cwd'] === 'string' && meta['cwd'].length > 0) return meta['cwd'];
  if (typeof meta['workDir'] === 'string' && meta['workDir'].length > 0) {
    return meta['workDir'];
  }
  const custom = meta['custom'];
  if (custom !== null && typeof custom === 'object' && !Array.isArray(custom)) {
    const fromCustom = (custom as Record<string, unknown>)['cwd'];
    if (typeof fromCustom === 'string' && fromCustom.length > 0) return fromCustom;
  }
  return undefined;
}

function matchesChildOf(summary: SessionSummary, parentId: string | undefined): boolean {
  if (parentId === undefined) return true;
  const custom = summary.custom;
  return (
    custom?.[PARENT_SESSION_ID_KEY] === parentId &&
    custom?.[CHILD_SESSION_KIND_KEY] === CHILD_SESSION_KIND
  );
}

export class FileSessionIndex implements ISessionIndex {
  declare readonly _serviceBrand: undefined;

  private indexesEnsured = false;
  private readModelDisabled = false;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IQueryStore private readonly queryStore: IQueryStore,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
  ) {}

  async list(query: SessionListQuery): Promise<Page<SessionSummary>> {
    if (!this.readModelEnabled()) return this.listLegacy(query);
    return this.withReadModelFallback(
      () => this.listFromReadModel(query),
      () => this.listLegacy(query),
    );
  }

  async get(id: string): Promise<SessionSummary | undefined> {
    if (!this.readModelEnabled()) return this.getLegacy(id);
    return this.withReadModelFallback(
      () => this.getFromReadModel(id),
      () => this.getLegacy(id),
    );
  }

  async countActive(workspaceIds: readonly string[]): Promise<number> {
    if (!this.readModelEnabled()) return this.countActiveLegacy(workspaceIds);
    return this.withReadModelFallback(
      () => this.countActiveFromReadModel(workspaceIds),
      () => this.countActiveLegacy(workspaceIds),
    );
  }

  private async withReadModelFallback<T>(op: () => Promise<T>, legacy: () => Promise<T>): Promise<T> {
    if (this.readModelDisabled) return legacy();
    try {
      return await op();
    } catch (error) {
      if (!isStorageError(error, StorageErrors.codes.STORAGE_LOCKED)) throw error;
      this.readModelDisabled = true;
      this.log.warn('query-store locked by another process; disabling read model', {
        error: String(error),
      });
      return legacy();
    }
  }

  private async listFromReadModel(query: SessionListQuery): Promise<Page<SessionSummary>> {
    await this.ensureIndexes();
    if (query.sessionId !== undefined) {
      const summary = await this.getFromReadModel(query.sessionId);
      const items =
        summary !== undefined && (!summary.archived || query.includeArchived === true)
          ? [summary]
          : [];
      return { items: query.limit !== undefined ? items.slice(0, query.limit) : items };
    }

    const workspaceIds = query.workspaceIds ?? (await this.listWorkspaceIds());
    const items: SessionSummary[] = [];
    for (const workspaceId of workspaceIds) {
      for (const sessionId of await this.listSessionIds(workspaceId)) {
        const summary = await this.getCachedSummary(workspaceId, sessionId);
        if (summary === undefined) continue;
        if (summary.archived && query.includeArchived !== true) continue;
        if (!matchesChildOf(summary, query.childOf)) continue;
        items.push(summary);
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return { items: query.limit !== undefined ? items.slice(0, query.limit) : items };
  }

  private async getFromReadModel(id: string): Promise<SessionSummary | undefined> {
    const cached = await this.queryStore.get<SessionSummary>(SESSION_COLLECTION, id);
    if (cached !== undefined) return cached;
    for (const workspaceId of await this.listWorkspaceIds()) {
      if (!(await this.hasSession(workspaceId, id))) continue;
      return this.getCachedSummary(workspaceId, id);
    }
    return undefined;
  }

  private async countActiveFromReadModel(workspaceIds: readonly string[]): Promise<number> {
    let count = 0;
    for (const workspaceId of workspaceIds) {
      for (const sessionId of await this.listSessionIds(workspaceId)) {
        const summary = await this.getCachedSummary(workspaceId, sessionId);
        if (summary !== undefined && !summary.archived) count += 1;
      }
    }
    return count;
  }

  private readModelEnabled(): boolean {
    return this.flags.enabled(READ_MODEL_FLAG);
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) return;
    await this.queryStore.ensureIndex(SESSION_COLLECTION, {
      kind: 'value',
      name: 'byWorkspace',
      field: 'workspaceId',
    });
    await this.queryStore.ensureIndex(SESSION_COLLECTION, {
      kind: 'compound',
      name: 'byWsUpdated',
      groupBy: 'workspaceId',
      orderBy: 'updatedAt',
    });
    this.indexesEnsured = true;
  }

  private async getCachedSummary(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionSummary | undefined> {
    const cached = await this.queryStore.get<SessionSummary>(SESSION_COLLECTION, sessionId);
    if (cached !== undefined) return cached;
    const summary = await this.readSummary(workspaceId, sessionId);
    if (summary !== undefined) {
      await this.queryStore.put(SESSION_COLLECTION, sessionId, summary);
    }
    return summary;
  }

  private async listLegacy(query: SessionListQuery): Promise<Page<SessionSummary>> {
    if (query.sessionId !== undefined) {
      const summary = await this.getLegacy(query.sessionId);
      const items =
        summary !== undefined && (!summary.archived || query.includeArchived === true)
          ? [summary]
          : [];
      return { items: query.limit !== undefined ? items.slice(0, query.limit) : items };
    }

    const workspaceIds = query.workspaceIds ?? (await this.listWorkspaceIds());
    const items: SessionSummary[] = [];
    for (const workspaceId of workspaceIds) {
      for (const sessionId of await this.listSessionIds(workspaceId)) {
        const summary = await this.readSummary(workspaceId, sessionId);
        if (summary === undefined) continue;
        if (summary.archived && query.includeArchived !== true) continue;
        if (!matchesChildOf(summary, query.childOf)) continue;
        items.push(summary);
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return { items: query.limit !== undefined ? items.slice(0, query.limit) : items };
  }

  private async getLegacy(id: string): Promise<SessionSummary | undefined> {
    for (const workspaceId of await this.listWorkspaceIds()) {
      if (!(await this.hasSession(workspaceId, id))) continue;
      const summary = await this.readSummary(workspaceId, id);
      if (summary !== undefined) return summary;
    }
    return undefined;
  }

  private async countActiveLegacy(workspaceIds: readonly string[]): Promise<number> {
    let count = 0;
    for (const workspaceId of workspaceIds) {
      for (const sessionId of await this.listSessionIds(workspaceId)) {
        const summary = await this.readSummary(workspaceId, sessionId);
        if (summary !== undefined && !summary.archived) count += 1;
      }
    }
    return count;
  }

  private get sessionsScope(): string {
    return this.bootstrap.scope('sessions');
  }

  private async listWorkspaceIds(): Promise<readonly string[]> {
    try {
      return await this.storage.list(this.sessionsScope);
    } catch {
      return [];
    }
  }

  private async listSessionIds(workspaceId: string): Promise<readonly string[]> {
    try {
      return await this.storage.list(`${this.sessionsScope}/${workspaceId}`);
    } catch {
      return [];
    }
  }

  private async hasSession(workspaceId: string, sessionId: string): Promise<boolean> {
    const ids = await this.listSessionIds(workspaceId);
    return ids.includes(sessionId);
  }

  private async readSummary(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionSummary | undefined> {
    const base = `${this.sessionsScope}/${workspaceId}/${sessionId}`;
    const meta = (await this.readMeta(base)) ?? (await this.readMeta(`${base}/${META_SCOPE}`));
    if (meta === undefined) return undefined;
    const rawCustom = meta['custom'];
    const custom =
      rawCustom !== null && typeof rawCustom === 'object' && !Array.isArray(rawCustom)
        ? (rawCustom as Record<string, unknown>)
        : undefined;
    return {
      id: sessionId,
      workspaceId,
      cwd: recoverCwd(meta),
      title: typeof meta['title'] === 'string' ? meta['title'] : undefined,
      lastPrompt: typeof meta['lastPrompt'] === 'string' ? meta['lastPrompt'] : undefined,
      createdAt: parseTime(meta['createdAt']),
      updatedAt: parseTime(meta['updatedAt']),
      archived: meta['archived'] === true,
      custom,
    };
  }

  private async readMeta(scope: string): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.docs.get<Record<string, unknown>>(scope, META_KEY);
    } catch {
      return undefined;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionIndex,
  FileSessionIndex,
  InstantiationType.Eager,
  'sessionIndex',
);
