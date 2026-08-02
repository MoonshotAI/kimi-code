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
 * Reconciliation runs against the *published* generation: it re-scans the
 * authoritative set, upserts summaries that drifted (mirror loss, external
 * edits), deletes entries whose document disappeared, and rewrites every
 * counter from the authoritative scan — bounding counter drift to one
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

export class SessionIndexProjector {
  constructor(private readonly deps: SessionIndexProjectorDeps) {}

  /** Scan the authoritative set into a fresh generation and publish it. */
  async project(generation: number): Promise<ProjectionResult> {
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

    const { summaries, counts } = await this.scanAuthoritative();
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

  private async scanAuthoritative(): Promise<{
    summaries: SessionSummary[];
    counts: Map<string, { active: number; archived: number }>;
  }> {
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
