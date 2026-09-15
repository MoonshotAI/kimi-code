import { ILogService } from '#/_base/log/log';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IQueryStore, type WriteOp } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { PARENT_SESSION_ID_KEY, type SessionSummary } from './sessionIndex';
import {
  clearDirtyMarks,
  dirtyMarkSessionIds,
  listDirtyMarks,
} from './sessionIndexDirtyJournal';
import {
  PARENT_INDEX_NAME,
  SESSION_INDEX_MANIFEST,
  SESSION_INDEX_SCHEMA_VERSION,
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

export interface AuthoritativeScan {
  readonly summaries: SessionSummary[];
  readonly counts: Map<string, { active: number; archived: number }>;
  readonly sourceSessionCount: number;
}

interface ScanSlot {
  readonly promise: Promise<AuthoritativeScan>;
  readonly reusableUntil: number;
  settled: boolean;
}

export class SessionIndexProjector {
  private scanSlot: ScanSlot | undefined;

  constructor(private readonly deps: SessionIndexProjectorDeps) {}

  sharedScan(): Promise<AuthoritativeScan> {
    const slot = this.scanSlot;
    if (slot !== undefined && (!slot.settled || Date.now() < slot.reusableUntil)) {
      return slot.promise;
    }
    return this.startScan();
  }

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
    const epoch = queryStore.storeEpoch();
    const collection = sessionCollection(generation);
    const counters = sessionCountersCollection(generation);
    await queryStore.dropCollection(collection);
    await queryStore.dropCollection(counters);
    await queryStore.ensureIndex(collection, {
      kind: 'value',
      name: PARENT_INDEX_NAME,
      field: `custom.${PARENT_SESSION_ID_KEY}`,
    });

    const { summaries, counts, sourceSessionCount } = await scan;
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
    await queryStore.setCheckpoint(
      SESSION_INDEX_MANIFEST,
      {
        seq: generation,
        sourceSessionCount,
        schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      },
      epoch,
    );
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

  async reconcile(generation: number): Promise<ReconcileResult> {
    const { queryStore, docs, storage, log, sessionsScope } = this.deps;
    const epoch = queryStore.storeEpoch();
    const collection = sessionCollection(generation);
    const counters = sessionCountersCollection(generation);
    const marks = await listDirtyMarks(storage, sessionsScope);
    const changed = dirtyMarkSessionIds(marks);

    const workspaceIds = await listWorkspaceIds(storage, sessionsScope);
    const authoritative = new Map<string, string>();
    for (const workspaceId of workspaceIds) {
      for (const sessionId of await listSessionIds(storage, sessionsScope, workspaceId)) {
        authoritative.set(sessionId, workspaceId);
      }
    }
    const storedKeys = await queryStore.listKeys(collection);
    const stored = new Set(storedKeys);
    for (const sessionId of authoritative.keys()) {
      if (!stored.has(sessionId)) changed.add(sessionId);
    }
    for (const key of storedKeys) {
      if (!authoritative.has(key)) changed.add(key);
    }

    const olds = await queryStore.getMany<SessionSummary>(collection, [...changed]);
    const upserts: WriteOp[] = [];
    const removals: WriteOp[] = [];
    const applied = new Map<string, SessionSummary>();
    const removed = new Set<string>();
    await mapBounded([...changed], SCAN_CONCURRENCY, async (sessionId) => {
      const workspaceId = authoritative.get(sessionId);
      const summary =
        workspaceId === undefined
          ? undefined
          : await readSessionSummary(docs, sessionsScope, workspaceId, sessionId);
      if (summary === undefined) {
        if (olds.get(sessionId) !== undefined) {
          removals.push({ kind: 'delete', collection, key: sessionId });
          removed.add(sessionId);
        }
        return;
      }
      applied.set(sessionId, summary);
      const existing = olds.get(sessionId);
      if (existing === undefined || !summaryEquals(existing, summary)) {
        upserts.push({
          kind: 'put',
          collection,
          key: sessionId,
          value: withRecencyField(generation, summary),
          columns: { [recencyColumn(generation)]: summary.updatedAt },
        });
      }
    });

    const deltas = new Map<string, { active: number; archived: number }>();
    const bump = (workspaceId: string, field: 'active' | 'archived', by: number): void => {
      const entry = deltas.get(workspaceId) ?? { active: 0, archived: 0 };
      entry[field] += by;
      deltas.set(workspaceId, entry);
    };
    for (const summary of applied.values()) {
      const old = olds.get(summary.id);
      if (old === undefined) {
        bump(summary.workspaceId, summary.archived ? 'archived' : 'active', 1);
      } else if (old.workspaceId !== summary.workspaceId) {
        bump(old.workspaceId, old.archived ? 'archived' : 'active', -1);
        bump(summary.workspaceId, summary.archived ? 'archived' : 'active', 1);
      } else if (old.archived !== summary.archived) {
        bump(summary.workspaceId, old.archived ? 'archived' : 'active', -1);
        bump(summary.workspaceId, summary.archived ? 'archived' : 'active', 1);
      }
    }
    for (const sessionId of removed) {
      const old = olds.get(sessionId);
      if (old !== undefined) bump(old.workspaceId, old.archived ? 'archived' : 'active', -1);
    }
    const current = await queryStore.getMany<SessionWorkspaceCounts>(counters, [...deltas.keys()]);
    const counterOps: WriteOp[] = [...deltas.entries()].map(([workspaceId, delta]) => {
      const base = current.get(workspaceId) ?? { active: 0, archived: 0 };
      const value: SessionWorkspaceCounts = {
        active: Math.max(0, base.active + delta.active),
        archived: Math.max(0, base.archived + delta.archived),
      };
      return { kind: 'put', collection: counters, key: workspaceId, value };
    });
    const totals = new Map<string, number>();
    for (const workspaceId of authoritative.values()) {
      totals.set(workspaceId, (totals.get(workspaceId) ?? 0) + 1);
    }
    for (const key of await queryStore.listKeys(counters)) {
      if (!totals.has(key)) counterOps.push({ kind: 'delete', collection: counters, key });
    }

    await this.batchChunks([...upserts, ...removals, ...counterOps]);
    const manifest = await queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
    if (manifest?.seq === generation) {
      await queryStore.setCheckpoint(
        SESSION_INDEX_MANIFEST,
        {
          seq: generation,
          sourceSessionCount: authoritative.size,
          schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
        },
        epoch,
      );
    }
    await clearDirtyMarks(storage, sessionsScope, marks);
    const result = {
      sessions: authoritative.size,
      upserted: upserts.length,
      removed: removals.length,
    };
    if (result.upserted > 0 || result.removed > 0) {
      log.info('session index reconciliation repaired drift', { generation, ...result });
    }
    return result;
  }

  private async scanAuthoritative(): Promise<AuthoritativeScan> {
    const { storage, docs, sessionsScope } = this.deps;
    const summaries: SessionSummary[] = [];
    const counts = new Map<string, { active: number; archived: number }>();
    let sourceSessionCount = 0;
    for (const workspaceId of await listWorkspaceIds(storage, sessionsScope)) {
      const sessionIds = await listSessionIds(storage, sessionsScope, workspaceId);
      sourceSessionCount += sessionIds.length;
      const found = await mapBounded(sessionIds, SCAN_CONCURRENCY, async (sessionId) =>
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
    return { summaries, counts, sourceSessionCount };
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
