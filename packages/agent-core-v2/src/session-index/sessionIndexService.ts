/**
 * `session-index` domain (L2) — `FileSessionIndex` implementation.
 *
 * Reads the persisted session set through the `storage` access-pattern stores,
 * rooted at the `sessionsDir` path layout fact from `bootstrap`. The directory
 * tree `<sessionsDir>/<workspaceId>/<sessionId>/` is the index: workspace and
 * session ids are enumerated via `IStorageService.list`, and each session's
 * metadata document is read via `IAtomicDocumentStore` to build its summary.
 *
 * The session metadata document lives at `<sessionDir>/state.json`, a layout
 * shared by v1 and v2; the `version` field distinguishes them (`2` = v2,
 * epoch-ms timestamps; absent = v1, ISO-string timestamps). The reader also
 * falls back to the legacy `<sessionDir>/session-meta/state.json` path for v2
 * sessions written before the layouts were unified. Both timestamp
 * representations are normalized to epoch ms.
 *
 * This is the local-deployment backend of `ISessionIndex`; a server deployment
 * would substitute a database-backed `DbSessionIndex`. Bound at Core scope.
 */

import { relative } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/bootstrap';
import { IAtomicDocumentStore, IStorageService, type Page } from '#/storage';

import { ISessionIndex, type SessionListQuery, type SessionSummary } from './sessionIndex';

const META_SCOPE = 'session-meta';
const META_KEY = 'state.json';

/** Accept both v2 (epoch ms number) and v1 (ISO string) timestamps. */
function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export class FileSessionIndex implements ISessionIndex {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IStorageService private readonly storage: IStorageService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
  ) {}

  async list(query: SessionListQuery): Promise<Page<SessionSummary>> {
    const workspaceIds =
      query.workspaceId !== undefined ? [query.workspaceId] : await this.listWorkspaceIds();
    const items: SessionSummary[] = [];
    for (const workspaceId of workspaceIds) {
      for (const sessionId of await this.listSessionIds(workspaceId)) {
        const summary = await this.readSummary(workspaceId, sessionId);
        if (summary === undefined) continue;
        if (summary.archived && query.includeArchived !== true) continue;
        items.push(summary);
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return { items: query.limit !== undefined ? items.slice(0, query.limit) : items };
  }

  async get(id: string): Promise<SessionSummary | undefined> {
    for (const workspaceId of await this.listWorkspaceIds()) {
      if (!(await this.hasSession(workspaceId, id))) continue;
      const summary = await this.readSummary(workspaceId, id);
      if (summary !== undefined) return summary;
    }
    return undefined;
  }

  async countActive(workspaceId: string): Promise<number> {
    let count = 0;
    for (const sessionId of await this.listSessionIds(workspaceId)) {
      const summary = await this.readSummary(workspaceId, sessionId);
      if (summary !== undefined && !summary.archived) count += 1;
    }
    return count;
  }

  private get sessionsScope(): string {
    return relative(this.bootstrap.homeDir, this.bootstrap.sessionsDir);
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
    // `<sessionDir>/state.json` is the unified metadata document: v2 (tagged
    // `version: 2`) and v1 (no version) both write here. Fall back to the
    // legacy v2 `session-meta/` subdir for sessions written before the layouts
    // were unified.
    const meta =
      (await this.readMeta(base)) ?? (await this.readMeta(`${base}/${META_SCOPE}`));
    if (meta === undefined) return undefined;
    const rawCustom = meta['custom'];
    const custom =
      rawCustom !== null && typeof rawCustom === 'object' && !Array.isArray(rawCustom)
        ? (rawCustom as Record<string, unknown>)
        : undefined;
    return {
      id: sessionId,
      workspaceId,
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
  LifecycleScope.Core,
  ISessionIndex,
  FileSessionIndex,
  InstantiationType.Delayed,
  'session-index',
);
