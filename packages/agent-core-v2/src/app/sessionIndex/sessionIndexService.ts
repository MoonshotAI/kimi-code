/**
 * `sessionIndex` domain (L2) — `FileSessionIndex` implementation.
 *
 * Serves session listings, point lookups, and counts. Two read paths exist:
 *
 * - **Authoritative (legacy) path** — enumerates the directory tree and reads
 *   every `state.json` (see `sessionIndexSource`). Always correct, linear in
 *   the number of sessions. This is the flag-off behavior and the fallback
 *   whenever the read model cannot serve.
 * - **Read-model path** (flag `persistence_minidb_readmodel`) — queries the
 *   derived `IQueryStore` read model. Recency pages walk the published
 *   generation's ordered recency column with keyset cursors (`O(log N +
 *   limit)`, no directory enumeration, no per-session document reads), point
 *   lookups are single gets, and counts read materialized per-workspace
 *   counters.
 *
 * The read model follows the lifecycle `uninitialized → preparing → ready`,
 * with `degraded` whenever it cannot serve and the authoritative path takes
 * over (the reason and the cumulative count are published via `status()` and
 * logged — never a silent permanent fallback). `prepare()` opens the store,
 * restores the published generation, runs the initial projection when none
 * exists, and starts background reconciliation; read paths kick it
 * single-flight when the composition root never called it. A lost manifest
 * (query-store corruption rebuild) triggers an automatic reprojection — the
 * model is never healed by per-request backfill. Degraded reads retry
 * `prepare()` after a short backoff.
 *
 * Keyset pagination is canonical (`updatedAt` desc, `id` desc): a cursor is a
 * session id resolved by point lookup, and the window's boundary tie group is
 * re-fetched and merged so same-millisecond ties never lose or duplicate an
 * item across pages. `get` falls back to the authoritative document on a
 * read-model miss (mirror lag) and re-records it, and every page folds in the
 * mirror's not-yet-flushed summaries (range-filtered by the cursor on cursor
 * pages) — reads always see recent writes of this process.
 *
 * This is the local-deployment backend of `ISessionIndex`; a server
 * deployment would substitute a database-backed implementation. Bound at App
 * scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IntervalTimer } from '#/_base/utils/timer';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  IQueryStore,
  type Checkpoint,
  type ColumnBounds,
  type Page,
  type QueryFilter,
} from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  ISessionIndex,
  ISessionIndexMirror,
  PARENT_SESSION_ID_KEY,
  type SessionCountQuery,
  type SessionIndexStatus,
  type SessionIndexState,
  type SessionListQuery,
  type SessionSummary,
} from './sessionIndex';
import {
  PARENT_INDEX_NAME,
  SESSION_INDEX_MANIFEST,
  recencyColumn,
  sessionCollection,
  sessionCountersCollection,
  stripRecencyField,
  type SessionWorkspaceCounts,
} from './sessionIndexModel';
import { SessionIndexProjector } from './sessionIndexProjector';
import {
  listSessionIds,
  listWorkspaceIds,
  readSessionSummary,
  summaryMatchesChildOf,
} from './sessionIndexSource';

const READ_MODEL_FLAG = 'persistence_minidb_readmodel';
const RECONCILE_INTERVAL_MS = 60_000;
const DEGRADED_RETRY_MS = 5_000;
const TIE_REPAIR_LIMIT = 1_000;
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

function canonicalOrder(a: SessionSummary, b: SessionSummary): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function isSessionSummaryShape(value: unknown): value is SessionSummary {
  if (value === null || typeof value !== 'object') return false;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary['id'] === 'string' &&
    typeof summary['workspaceId'] === 'string' &&
    typeof summary['createdAt'] === 'number' &&
    typeof summary['updatedAt'] === 'number' &&
    typeof summary['archived'] === 'boolean'
  );
}

export class FileSessionIndex extends Disposable implements ISessionIndex {
  declare readonly _serviceBrand: undefined;

  private state: SessionIndexState = 'uninitialized';
  private generation: number | undefined;
  private statusReason: string | undefined;
  private degradedCount = 0;
  private nextPrepareRetryAt = 0;
  private prepareFlight: Promise<SessionIndexStatus> | undefined;
  private projectFlight: Promise<void> | undefined;
  private readonly reconcileTimer = this._register(new IntervalTimer({ unref: true }));
  private readonly projector: SessionIndexProjector;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IQueryStore private readonly queryStore: IQueryStore,
    @IFlagService private readonly flags: IFlagService,
    @ISessionIndexMirror private readonly mirror: ISessionIndexMirror,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.projector = new SessionIndexProjector({
      storage,
      docs,
      queryStore,
      log,
      sessionsScope: bootstrap.scope('sessions'),
    });
  }

  /** The reconcile loop runs only while the read model is in play — starting
   *  it unconditionally would spin an interval for every flag-off host. */
  private ensureReconcileTimer(): void {
    if (!this.reconcileTimer.isSet()) {
      this.reconcileTimer.cancelAndSet(() => void this.tick(), RECONCILE_INTERVAL_MS);
    }
  }

  // ---- lifecycle ------------------------------------------------------------

  async prepare(options?: { deadlineMs?: number }): Promise<SessionIndexStatus> {
    if (!this.readModelEnabled()) return this.status();
    this.prepareFlight ??= this.doPrepare(options?.deadlineMs).finally(() => {
      this.prepareFlight = undefined;
    });
    return this.prepareFlight;
  }

  status(): SessionIndexStatus {
    return {
      state: this.readModelEnabled() ? this.state : 'uninitialized',
      generation: this.generation,
      reason: this.statusReason,
      degradedCount: this.degradedCount,
    };
  }

  private async doPrepare(deadlineMs?: number): Promise<SessionIndexStatus> {
    if (this.state === 'ready') return this.status();
    this.state = 'preparing';
    try {
      const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
      if (manifest === undefined) {
        const projection = this.ensureProjection();
        if (deadlineMs === undefined) {
          await projection;
        } else {
          await Promise.race([
            projection,
            new Promise((resolve) => {
              setTimeout(resolve, deadlineMs);
            }),
          ]);
        }
      } else {
        this.generation = manifest.seq;
        await this.ensureSchema(manifest.seq);
      }
      const published = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
      if (published !== undefined) {
        this.generation = published.seq;
        this.markReady();
      }
    } catch (error) {
      this.markDegraded('prepare failed', error);
    }
    return this.status();
  }

  private ensureProjection(): Promise<void> {
    this.projectFlight ??= this.runProjection().finally(() => {
      this.projectFlight = undefined;
    });
    return this.projectFlight;
  }

  private async runProjection(): Promise<void> {
    try {
      const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
      const next = (manifest?.seq ?? 0) + 1;
      const result = await this.projector.project(next);
      this.generation = result.generation;
      this.markReady();
    } catch (error) {
      // A failed projection never publishes. When a previous generation is
      // still published, readers keep flowing from it — a crashed re-projection
      // must not take the read model down.
      const published = await this.queryStore
        .getCheckpoint(SESSION_INDEX_MANIFEST)
        .catch(() => undefined);
      if (published !== undefined) {
        this.generation = published.seq;
        this.markReady();
        this.log.warn('session index re-projection failed; staying on the previous generation', {
          generation: published.seq,
          error: String(error),
        });
      } else {
        this.markDegraded('projection failed', error);
      }
    }
  }

  /** Test/ops hook: reconcile the published generation against disk now. */
  async reconcileNow(): Promise<void> {
    if (!this.readModelEnabled()) return;
    const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
    if (manifest === undefined) return;
    this.generation = manifest.seq;
    await this.projector.reconcile(manifest.seq);
  }

  /** Test/ops hook: project a fresh generation now (single-flight). */
  async reprojectNow(): Promise<void> {
    if (!this.readModelEnabled()) return;
    await this.ensureProjection();
  }

  private async tick(): Promise<void> {
    if (!this.readModelEnabled()) return;
    if (this.state === 'degraded') {
      void this.prepare();
      return;
    }
    if (this.state !== 'ready') return;
    try {
      const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
      if (manifest === undefined) {
        this.markDegraded('published generation lost');
        void this.prepare();
        return;
      }
      this.generation = manifest.seq;
      await this.projector.reconcile(manifest.seq);
    } catch (error) {
      // A failed reconcile leaves reads intact; it retries on the next tick.
      this.log.warn('session index reconciliation failed', { error: String(error) });
    }
  }

  private markReady(): void {
    this.state = 'ready';
    this.statusReason = undefined;
    this.ensureReconcileTimer();
  }

  private markDegraded(reason: string, error?: unknown): void {
    this.state = 'degraded';
    this.statusReason = reason;
    this.degradedCount += 1;
    this.nextPrepareRetryAt = Date.now() + DEGRADED_RETRY_MS;
    this.ensureReconcileTimer();
    const detail =
      error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
    this.log.warn('session index read model degraded; serving authoritative reads', {
      reason,
      ...(detail !== undefined ? { error: detail } : {}),
      degradedCount: this.degradedCount,
    });
  }

  private async ensureSchema(generation: number): Promise<void> {
    await this.queryStore.ensureIndex(sessionCollection(generation), {
      kind: 'value',
      name: PARENT_INDEX_NAME,
      field: `custom.${PARENT_SESSION_ID_KEY}`,
    });
  }

  // ---- reads ------------------------------------------------------------------

  async get(id: string): Promise<SessionSummary | undefined> {
    return this.withReadModel(
      (generation) => this.getFromReadModel(generation, id),
      () => this.getLegacy(id),
    );
  }

  async listRecent(query: SessionListQuery): Promise<Page<SessionSummary>> {
    return this.withReadModel(
      (generation) => this.listRecentFromReadModel(generation, query),
      () => this.listLegacy(query),
    );
  }

  async count(query: SessionCountQuery): Promise<number> {
    return this.withReadModel(
      (generation) => this.countFromReadModel(generation, query),
      () => this.countLegacy(query),
    );
  }

  /**
   * Evict a deleted session's derived state so `get` / `listRecent` stop
   * answering for the id immediately: the authoritative directory is deleted
   * by the caller (`sessionLifecycle.delete`), and the next projection would
   * drop the entry anyway — this closes the stale-read window in between. A
   * summary still queued in the mirror heals at the next projection. With the
   * read model off there is no derived state to evict.
   */
  async remove(id: string): Promise<void> {
    await this.withReadModel(
      async (generation) => {
        await this.queryStore.delete(sessionCollection(generation), id);
      },
      () => Promise.resolve(),
    );
  }

  /**
   * Serve `op` from the read model when possible, else from the authoritative
   * path: flag off, not prepared yet (kicked here single-flight), preparing,
   * or degraded (with a throttled re-prepare). Any read-model failure demotes
   * to `degraded` — logged and counted — and falls back immediately.
   */
  private async withReadModel<T>(
    op: (generation: number) => Promise<T>,
    legacy: () => Promise<T>,
  ): Promise<T> {
    if (!this.readModelEnabled()) return legacy();
    if (this.state === 'uninitialized') {
      void this.prepare();
      return legacy();
    }
    if (this.state === 'preparing') return legacy();
    if (this.state === 'degraded') {
      if (Date.now() >= this.nextPrepareRetryAt) void this.prepare();
      return legacy();
    }
    let manifest: Checkpoint | undefined;
    try {
      manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
    } catch (error) {
      this.markDegraded('read model read failed', error);
      return legacy();
    }
    if (manifest === undefined) {
      // The store lost the published generation (corruption rebuild):
      // reproject automatically instead of healing by per-request backfill.
      this.markDegraded('published generation lost');
      void this.prepare();
      return legacy();
    }
    this.generation = manifest.seq;
    try {
      return await op(manifest.seq);
    } catch (error) {
      this.markDegraded('read model read failed', error);
      return legacy();
    }
  }

  private async getFromReadModel(
    generation: number,
    id: string,
  ): Promise<SessionSummary | undefined> {
    const cached: unknown = await this.queryStore.get(sessionCollection(generation), id);
    if (isSessionSummaryShape(cached)) return stripRecencyField(generation, cached);
    // Mirror lag or a not-yet-projected session: probe the authoritative
    // document and re-record it so the next read is warm.
    const summary = await this.getLegacy(id);
    if (summary !== undefined) this.mirror.record(summary);
    return summary;
  }

  private async listRecentFromReadModel(
    generation: number,
    query: SessionListQuery,
  ): Promise<Page<SessionSummary>> {
    const collection = sessionCollection(generation);
    if (query.sessionId !== undefined) {
      const summary = await this.getFromReadModel(generation, query.sessionId);
      const items =
        summary !== undefined && (!summary.archived || query.includeArchived === true)
          ? [summary]
          : [];
      return { items: query.limit !== undefined ? items.slice(0, query.limit) : items };
    }

    const cursor = await this.resolveCursor(generation, query);
    if (cursor === undefined) return { items: [] };
    const limit = query.limit ?? UNBOUNDED;
    const filter = { ...this.baseFilter(query), ...cursor.filter };
    const column = recencyColumn(generation);
    const strip = (records: SessionSummary[]): SessionSummary[] =>
      records.map((record) => stripRecencyField(generation, record));

    const page =
      query.childOf !== undefined
        ? await this.windowedPage(
            (bounds, fetchLimit) => {
              // The equality candidates (few children per parent) drive this
              // path; only bound the column when the cursor actually constrains
              // it — an unbounded column range would materialize per shard.
              const base = this.queryStore
                .query<SessionSummary>(collection)
                .where(filter)
                .orderBy('updatedAt', 'desc')
                .limit(fetchLimit);
              const q =
                Object.keys(bounds).length > 0 ? base.whereColumn(column, bounds) : base;
              return q.execute().then((p) => strip([...p.items]));
            },
            cursor.bounds,
            limit,
          )
        : await this.windowedPage(
            (bounds, fetchLimit) =>
              this.queryStore
                .pageByColumn<SessionSummary>(collection, {
                  column,
                  dir: 'desc',
                  filter,
                  bounds,
                  limit: fetchLimit,
                })
                .then((p) => strip([...p.items])),
            cursor.bounds,
            limit,
          );
    return this.mergePending(page, query, cursor.position);
  }

  private async countFromReadModel(
    generation: number,
    query: SessionCountQuery,
  ): Promise<number> {
    const counters = sessionCountersCollection(generation);
    const restricted = query.workspaceIds;
    const workspaceIds = restricted ?? (await this.queryStore.listKeys(counters));
    const counts = await this.queryStore.getMany<SessionWorkspaceCounts>(counters, workspaceIds);
    let total = 0;
    for (const entry of counts.values()) {
      total += query.includeArchived === true ? entry.active + entry.archived : entry.active;
    }
    // Fold in the mirror queue (read-your-writes): queued creations count
    // immediately, queued archive flips re-bucket, and queued updates to an
    // already-counted session are a no-op.
    const pending = this.mirror
      .pending()
      .filter((summary) => restricted === undefined || restricted.includes(summary.workspaceId));
    if (pending.length === 0) return total;
    const stored = await this.queryStore.getMany<SessionSummary>(
      sessionCollection(generation),
      pending.map((summary) => summary.id),
    );
    const weight = (archived: boolean): number =>
      query.includeArchived === true || !archived ? 1 : 0;
    for (const summary of pending) {
      const old = stored.get(summary.id);
      total += weight(summary.archived) - (old === undefined ? 0 : weight(old.archived));
    }
    return total;
  }

  /**
   * Canonical keyset window: fetch `limit + 1` rows under `bounds`; when the
   * window is full, re-fetch the boundary tie group (`updatedAt` equal to the
   * window's minimum) and merge, so a page cut inside a same-millisecond tie
   * group never drops or duplicates an item across pages. Rows are re-sorted
   * into the canonical (`updatedAt` desc, `id` desc) order — the engine's
   * cross-shard tie order is deterministic but not canonical.
   */
  private async windowedPage(
    fetch: (bounds: ColumnBounds, limit: number) => Promise<SessionSummary[]>,
    bounds: ColumnBounds,
    limit: number,
  ): Promise<Page<SessionSummary>> {
    const raw = await fetch(bounds, limit + 1);
    if (raw.length <= limit) {
      return { items: raw.toSorted(canonicalOrder) };
    }
    const minUpdatedAt = Math.min(...raw.map((summary) => summary.updatedAt));
    const tie = await fetch({ gte: minUpdatedAt, lte: minUpdatedAt }, TIE_REPAIR_LIMIT);
    const merged = new Map<string, SessionSummary>();
    for (const summary of tie) merged.set(summary.id, summary);
    for (const summary of raw) merged.set(summary.id, summary);
    const items = [...merged.values()].toSorted(canonicalOrder);
    const kept = items.slice(0, limit);
    const hasMore = items.length > limit || tie.length >= TIE_REPAIR_LIMIT;
    return { items: kept, nextCursor: hasMore ? kept.at(-1)!.id : undefined };
  }

  /**
   * Read-your-writes merge: pages fold in the mirror's queued summaries so a
   * just-mutated session shows up before the flush lands. Cursor pages merge
   * only the queued summaries that fall inside the page's canonical range
   * (the queue is a tiny, transient window).
   */
  private mergePending(
    page: Page<SessionSummary>,
    query: SessionListQuery,
    position?: { u: number; id: string; before: boolean },
  ): Page<SessionSummary> {
    const pending = this.mirror
      .pending()
      .filter(
        (summary) =>
          (query.workspaceIds === undefined || query.workspaceIds.includes(summary.workspaceId)) &&
          (query.includeArchived === true || !summary.archived) &&
          summaryMatchesChildOf(summary, query.childOf) &&
          (position === undefined ||
            (position.before
              ? summary.updatedAt < position.u ||
                (summary.updatedAt === position.u && summary.id < position.id)
              : summary.updatedAt > position.u ||
                (summary.updatedAt === position.u && summary.id > position.id))),
      );
    if (pending.length === 0) return page;
    const merged = new Map<string, SessionSummary>();
    for (const summary of pending) merged.set(summary.id, summary);
    for (const summary of page.items) {
      if (!merged.has(summary.id)) merged.set(summary.id, summary);
    }
    const items = [...merged.values()].toSorted(canonicalOrder);
    if (query.limit === undefined) return { items };
    const kept = items.slice(0, query.limit);
    const hasMore = page.nextCursor !== undefined || items.length > query.limit;
    return { items: kept, nextCursor: hasMore ? kept.at(-1)!.id : undefined };
  }

  /**
   * Resolve a keyset cursor id to its column bounds plus the exact
   * tie-exclusion filter, in canonical order: strictly older (`before`) is
   * `(updatedAt, id)` lexicographically below the cursor, strictly newer
   * (`after`) is above. An unknown cursor id yields `undefined` — the caller
   * answers an empty, terminal page.
   */
  private async resolveCursor(
    generation: number,
    query: SessionListQuery,
  ): Promise<
    | { filter: QueryFilter; bounds: ColumnBounds; position?: { u: number; id: string; before: boolean } }
    | undefined
  > {
    const id = query.before ?? query.after;
    if (id === undefined) return { filter: {}, bounds: {} };
    // The mirror queue is consulted too: a cursor pointing at a session whose
    // latest mutation has not been flushed yet must still resolve.
    const storedValue: unknown = await this.queryStore.get(sessionCollection(generation), id);
    const stored = isSessionSummaryShape(storedValue) ? storedValue : undefined;
    const cursor = stored ?? this.mirror.pending().find((summary) => summary.id === id);
    if (cursor === undefined) return undefined;
    const u = cursor.updatedAt;
    if (query.before !== undefined) {
      return {
        bounds: { lte: u },
        filter: {
          $or: [
            { updatedAt: { $lt: u } },
            { updatedAt: u, id: { $lt: id } },
          ],
        },
        position: { u, id, before: true },
      };
    }
    return {
      bounds: { gte: u },
      filter: {
        $or: [
          { updatedAt: { $gt: u } },
          { updatedAt: u, id: { $gt: id } },
        ],
      },
      position: { u, id, before: false },
    };
  }

  private baseFilter(query: SessionListQuery): QueryFilter {
    const filter: Record<string, unknown> = {};
    if (query.workspaceIds !== undefined) {
      filter['workspaceId'] =
        query.workspaceIds.length === 1
          ? query.workspaceIds[0]
          : { $in: [...query.workspaceIds] };
    }
    if (query.childOf !== undefined) {
      filter[`custom.${PARENT_SESSION_ID_KEY}`] = query.childOf;
      filter[`custom.${CHILD_SESSION_KIND_KEY}`] = CHILD_SESSION_KIND;
    }
    if (query.includeArchived !== true) filter['archived'] = { $ne: true };
    return filter;
  }

  // ---- authoritative (legacy) path --------------------------------------------

  private get sessionsScope(): string {
    return this.bootstrap.scope('sessions');
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

    const workspaceIds = query.workspaceIds ?? (await listWorkspaceIds(this.storage, this.sessionsScope));
    const collected: SessionSummary[] = [];
    for (const workspaceId of workspaceIds) {
      for (const sessionId of await listSessionIds(this.storage, this.sessionsScope, workspaceId)) {
        const summary = await readSessionSummary(this.docs, this.sessionsScope, workspaceId, sessionId);
        if (summary === undefined) continue;
        if (summary.archived && query.includeArchived !== true) continue;
        if (!summaryMatchesChildOf(summary, query.childOf)) continue;
        collected.push(summary);
      }
    }
    const items = collected.toSorted(canonicalOrder);

    let start = 0;
    let end = items.length;
    const cursorId = query.before ?? query.after;
    if (cursorId !== undefined) {
      const index = items.findIndex((summary) => summary.id === cursorId);
      if (index === -1) return { items: [] };
      if (query.before !== undefined) start = index + 1;
      else end = index;
    }
    const window = items.slice(start, end);
    if (query.limit === undefined) return { items: window };
    const kept = window.slice(0, query.limit);
    return {
      items: kept,
      nextCursor: window.length > query.limit ? kept.at(-1)!.id : undefined,
    };
  }

  private async getLegacy(id: string): Promise<SessionSummary | undefined> {
    for (const workspaceId of await listWorkspaceIds(this.storage, this.sessionsScope)) {
      const sessionIds = await listSessionIds(this.storage, this.sessionsScope, workspaceId);
      if (!sessionIds.includes(id)) continue;
      const summary = await readSessionSummary(this.docs, this.sessionsScope, workspaceId, id);
      if (summary !== undefined) return summary;
    }
    return undefined;
  }

  private async countLegacy(query: SessionCountQuery): Promise<number> {
    let count = 0;
    const workspaceIds =
      query.workspaceIds ?? (await listWorkspaceIds(this.storage, this.sessionsScope));
    for (const workspaceId of workspaceIds) {
      for (const sessionId of await listSessionIds(this.storage, this.sessionsScope, workspaceId)) {
        const summary = await readSessionSummary(this.docs, this.sessionsScope, workspaceId, sessionId);
        if (summary === undefined) continue;
        if (query.includeArchived === true || !summary.archived) count += 1;
      }
    }
    return count;
  }

  private readModelEnabled(): boolean {
    return this.flags.enabled(READ_MODEL_FLAG);
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionIndex,
  FileSessionIndex,
  ScopeActivation.OnScopeCreated,
  'sessionIndex',
);
