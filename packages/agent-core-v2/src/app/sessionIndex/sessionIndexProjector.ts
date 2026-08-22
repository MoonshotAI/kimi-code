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
    const scan = this.sharedScan();
    try {
      return await this.doProject(generation, scan);
    } finally {
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
