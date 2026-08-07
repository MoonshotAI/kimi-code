/**
 * `sessionIndex` domain (L2) — projector and reconciliation for the read
 * model.
 *
 * The projector materializes the authoritative session metadata
 * (`state.json` documents) into a fresh read-model generation: a full scan
 * with bounded concurrency, chunked `batch` writes (no cross-shard atomicity
 * required), per-workspace counters recomputed exactly, and finally one
 * atomic checkpoint publish that makes the generation readable. A projector
 * that dies midway never publishes, so readers keep serving the previous
 * generation; the next run clears its own stragglers before writing.
 * Publishing also schedules the previous generation's drop.
 *
 * The initial projection coincides with the first list request (read paths
 * kick `prepare()` single-flight and fall back to the authoritative scan
 * while unprepared). `sharedScan()` makes that ONE scan serve both: the
 * projection joins a running scan — or reuses one that just settled within
 * a short window — instead of enumerating every session directory a second
 * time. Fallback reads use `sharedScanForRead()`: they join only a scan
 * that is still in flight and otherwise drive a fresh one, so a read never
 * serves a settled snapshot that could predate a just-created session. (A
 * joined scan may still have started before the read; the index folds the
 * mirror's pending queue into the result to cover that window.) A
 * projection run consumes the slot on settle, so a later re-projection
 * always scans fresh.
 *
 * Reconciliation runs against the *published* generation: it re-scans the
 * authoritative set (always fresh — a stale snapshot could regress counters
 * the mirror just updated), upserts summaries that drifted (mirror loss,
 * external edits), deletes entries whose document disappeared, and rewrites
 * every counter from the authoritative scan — bounding counter drift to one
 * reconcile interval.
 *
 * This is an internal collaborator of `FileSessionIndex`, not a DI service:
 * the index drives it single-flight and owns the state machine around it.
 */

import { ILogService } from '#/_base/log/log';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IQueryStore, type WriteOp } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { PARENT_SESSION_ID_KEY, type SessionSummary } from './sessionIndex';
import {
  PARENT_INDEX_NAME,
  SESSION_INDEX_MANIFEST,
  recencyColumn,
  sessionCollection,
  sessionCountersCollection,
  withRecencyField,
  type SessionWorkspaceCounts,
} from './sessionIndexModel';
import {
  listSessionIds,
  listWorkspaceIds,
  mapBounded,
  readSessionSummary,
  summaryEquals,
} from './sessionIndexSource';

const WRITE_CHUNK = 500;
const SCAN_CONCURRENCY = 16;
/**
 * How long a settled shared scan stays reusable BY A PROJECTION. The window
 * only needs to cover the gap between a fallback read finishing its scan and
 * the kicked projection reaching its own scan call (query-store open +
 * collection housekeeping in between); a projection never reuses a slot
 * older than this. Fallback reads never reuse a settled scan at all (see
 * `sharedScanForRead`).
 */
const SHARED_SCAN_REUSE_MS = 30_000;

export interface SessionIndexProjectorDeps {
  readonly storage: IFileSystemStorageService;
  readonly docs: IAtomicDocumentStore;
  readonly queryStore: IQueryStore;
  readonly log: ILogService;
  readonly sessionsScope: string;
}

export interface ProjectionResult {
  readonly generation: number;
  readonly sessions: number;
}

export interface ReconcileResult {
  readonly sessions: number;
  readonly upserted: number;
  readonly removed: number;
}

/** One consistent pass over the authoritative session metadata set. */
export interface AuthoritativeScan {
  readonly summaries: SessionSummary[];
  readonly counts: Map<string, { active: number; archived: number }>;
}

interface ScanSlot {
  readonly promise: Promise<AuthoritativeScan>;
  readonly reusableUntil: number;
  settled: boolean;
}

export class SessionIndexProjector {
  private scanSlot: ScanSlot | undefined;

  constructor(private readonly deps: SessionIndexProjectorDeps) {}

  /**
   * The projection's scan: joins a running shared scan, reuses one that
   * settled within the reuse window, or starts a fresh one. The projection
   * publishes a point-in-time derived model by design, so a just-finished
   * snapshot is safe for it (the mirror queue and reconciliation heal the
   * gap) — and this is what keeps a fast first read + kicked projection
   * from scanning the directory tree twice.
   */
  sharedScan(): Promise<AuthoritativeScan> {
    const slot = this.scanSlot;
    if (slot !== undefined && (!slot.settled || Date.now() < slot.reusableUntil)) {
      return slot.promise;
    }
    return this.startScan();
  }

  /**
   * A fallback read's scan: joins a scan that is still in flight or starts a
   * fresh one. A settled snapshot is NEVER served to a read — it could
   * predate a session this process just created, breaking read-your-writes.
   * Joining an in-flight scan is NOT the same freshness as enumerating here
   * and now: the scan may have started (and passed a directory) before this
   * call, so the caller folds the mirror's pending queue into the result —
   * every pending entry is known to be durable on disk.
   */
  sharedScanForRead(): Promise<AuthoritativeScan> {
    const slot = this.scanSlot;
    if (slot !== undefined && !slot.settled) return slot.promise;
    return this.startScan();
  }

  private startScan(): Promise<AuthoritativeScan> {
    const slot: ScanSlot = {
      promise: this.scanAuthoritative(),
      reusableUntil: Date.now() + SHARED_SCAN_REUSE_MS,
      settled: false,
    };
    const markSettled = (): void => {
      slot.settled = true;
    };
    void slot.promise.then(markSettled, markSettled);
    this.scanSlot = slot;
    return slot.promise;
  }

  /** Scan the authoritative set into a fresh generation and publish it. */
  async project(generation: number): Promise<ProjectionResult> {
    // Captured BEFORE the housekeeping below: the scan overlaps it, and the
    // finally invalidates exactly the slot this run consumed — never a newer
    // scan a concurrent fallback read started meanwhile.
    const scan = this.sharedScan();
    try {
      return await this.doProject(generation, scan);
    } finally {
      // The consumed slot must not serve a LATER projection: a re-projection
      // always scans the authoritative set fresh.
      if (this.scanSlot?.promise === scan) this.scanSlot = undefined;
    }
  }

  private async doProject(
    generation: number,
    scan: Promise<AuthoritativeScan>,
  ): Promise<ProjectionResult> {
    const { queryStore, log } = this.deps;
    const collection = sessionCollection(generation);
    const counters = sessionCountersCollection(generation);
    // Clear stragglers of a crashed earlier attempt at this generation.
    await queryStore.dropCollection(collection);
    await queryStore.dropCollection(counters);
    await queryStore.ensureIndex(collection, {
      kind: 'value',
      name: PARENT_INDEX_NAME,
      field: `custom.${PARENT_SESSION_ID_KEY}`,
    });

    const { summaries, counts } = await scan;
    await this.batchChunks(
      summaries.map((summary) => ({
        kind: 'put' as const,
        collection,
        key: summary.id,
        value: withRecencyField(generation, summary),
        columns: { [recencyColumn(generation)]: summary.updatedAt },
      })),
    );
    await this.writeCounters(counters, counts);
    await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, { seq: generation });
    log.info('session index generation published', {
      generation,
      sessions: summaries.length,
    });

    if (generation > 1) {
      const staleSession = sessionCollection(generation - 1);
      const staleCounters = sessionCountersCollection(generation - 1);
      void queryStore
        .dropCollection(staleSession)
        .then(() => queryStore.dropCollection(staleCounters))
        .catch((error) => {
          log.warn('failed to drop previous session index generation', {
            generation: generation - 1,
            error: String(error),
          });
        });
    }
    return { generation, sessions: summaries.length };
  }

  /** Re-scan the authoritative set and repair the published generation. */
  async reconcile(generation: number): Promise<ReconcileResult> {
    const { queryStore, log } = this.deps;
    const collection = sessionCollection(generation);
    const counters = sessionCountersCollection(generation);
    const { summaries, counts } = await this.scanAuthoritative();
    const authoritativeIds = new Set(summaries.map((s) => s.id));

    const storedKeys = await queryStore.listKeys(collection);
    const stored = await queryStore.getMany<SessionSummary>(
      collection,
      summaries.map((s) => s.id),
    );

    const upserts: WriteOp[] = [];
    for (const summary of summaries) {
      const existing = stored.get(summary.id);
      if (existing === undefined || !summaryEquals(existing, summary)) {
        upserts.push({
          kind: 'put',
          collection,
          key: summary.id,
          value: withRecencyField(generation, summary),
          columns: { [recencyColumn(generation)]: summary.updatedAt },
        });
      }
    }
    const removals: WriteOp[] = storedKeys
      .filter((key) => !authoritativeIds.has(key))
      .map((key) => ({ kind: 'delete' as const, collection, key }));

    await this.batchChunks([...upserts, ...removals]);
    await this.writeCounters(counters, counts);
    const result = { sessions: summaries.length, upserted: upserts.length, removed: removals.length };
    if (result.upserted > 0 || result.removed > 0) {
      log.info('session index reconciliation repaired drift', { generation, ...result });
    }
    return result;
  }

  private async scanAuthoritative(): Promise<AuthoritativeScan> {
    const { storage, docs, sessionsScope } = this.deps;
    const summaries: SessionSummary[] = [];
    const counts = new Map<string, { active: number; archived: number }>();
    for (const workspaceId of await listWorkspaceIds(storage, sessionsScope)) {
      const sessionIds = await listSessionIds(storage, sessionsScope, workspaceId);
      const found = await mapBounded(sessionIds, SCAN_CONCURRENCY, (sessionId) =>
        readSessionSummary(docs, sessionsScope, workspaceId, sessionId),
      );
      const entry = counts.get(workspaceId) ?? { active: 0, archived: 0 };
      for (const summary of found) {
        summaries.push(summary);
        if (summary.archived) entry.archived += 1;
        else entry.active += 1;
      }
      counts.set(workspaceId, entry);
    }
    return { summaries, counts };
  }

  private async writeCounters(
    counters: string,
    counts: Map<string, { active: number; archived: number }>,
  ): Promise<void> {
    const { queryStore } = this.deps;
    const ops: WriteOp[] = [...counts.entries()].map(([workspaceId, value]) => ({
      kind: 'put',
      collection: counters,
      key: workspaceId,
      value: { active: value.active, archived: value.archived } satisfies SessionWorkspaceCounts,
    }));
    // Workspaces that vanished entirely lose their counter document.
    const existing = await queryStore.listKeys(counters);
    for (const key of existing) {
      if (!counts.has(key)) ops.push({ kind: 'delete', collection: counters, key });
    }
    await this.batchChunks(ops);
  }

  private async batchChunks(ops: readonly WriteOp[]): Promise<void> {
    for (let start = 0; start < ops.length; start += WRITE_CHUNK) {
      await this.deps.queryStore.batch(ops.slice(start, start + WRITE_CHUNK));
    }
  }
}
