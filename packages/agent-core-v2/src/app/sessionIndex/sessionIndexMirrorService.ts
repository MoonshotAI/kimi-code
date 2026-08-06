/**
 * `sessionIndex` domain (L2) — `ISessionIndexMirror` implementation.
 *
 * The write side of the session read model. `SessionMetadata` (Session scope)
 * records the freshest `SessionSummary` here once the authoritative
 * `state.json` is durable; this App-scoped queue then mirrors it into the
 * `IQueryStore` read model *off the user completion path*. Updates coalesce
 * per session (only the newest summary is kept) and flush in chunks — on a
 * short timer or as soon as a batch fills — writing summaries (with the
 * recency column declared) and per-workspace counter deltas into the
 * currently published generation.
 *
 * Everything here is best-effort: a flush failure keeps the entries queued,
 * backs off, and after repeated failures gives up until the next `record` —
 * the failed entries stay dirty and the domain's reconciliation heals them
 * from the authoritative documents. A queue overflow drops incoming summaries
 * (logged) rather than growing memory without bound. `drain()` is the
 * explicit shutdown path — the composition root awaits it before the query
 * store closes; DI disposal additionally fires a best-effort drain into a
 * module-level set so hosts without explicit wiring can await it via
 * `drainSessionIndexMirror()`.
 *
 * Bound at App scope.
 */

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IntervalTimer } from '#/_base/utils/timer';
import { IFlagService } from '#/app/flag/flag';
import { IQueryStore } from '#/persistence/interface/queryStore';

import { ISessionIndexMirror, type SessionSummary } from './sessionIndex';
import {
  SESSION_INDEX_MANIFEST,
  recencyColumn,
  sessionCollection,
  sessionCountersCollection,
  withRecencyField,
  type SessionWorkspaceCounts,
} from './sessionIndexModel';

const READ_MODEL_FLAG = 'persistence_minidb_readmodel';

const FLUSH_INTERVAL_MS = 100;
const FLUSH_BATCH_SIZE = 500;
const MAX_PENDING = 10_000;
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Best-effort drains fired by DI disposal (which is synchronous). The server
 * shutdown path awaits the service's own `drain()` explicitly before the
 * query store closes; this set is the backstop for hosts that only tear the
 * scope down.
 */
const pendingDrains = new Set<Promise<void>>();

export async function drainSessionIndexMirror(): Promise<void> {
  await Promise.all(pendingDrains);
}

export class SessionIndexMirror extends Disposable implements ISessionIndexMirror {
  declare readonly _serviceBrand: undefined;

  private readonly pendingMap = new Map<string, SessionSummary>();
  private readonly timer = this._register(new IntervalTimer({ unref: true }));
  private flushing: Promise<void> | undefined;
  private consecutiveFailures = 0;
  private disposed = false;
  private overflowLogged = false;

  constructor(
    @IQueryStore private readonly queryStore: IQueryStore,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(
      toDisposable(() => {
        this.disposed = true;
        const pending = this.drain().catch(() => {});
        pendingDrains.add(pending);
        void pending.finally(() => pendingDrains.delete(pending));
      }),
    );
  }

  record(summary: SessionSummary): void {
    if (this.disposed || !this.flags.enabled(READ_MODEL_FLAG)) return;
    if (this.pendingMap.size >= MAX_PENDING && !this.pendingMap.has(summary.id)) {
      if (!this.overflowLogged) {
        this.overflowLogged = true;
        this.log.warn('session index mirror queue full; dropping summaries until it drains', {
          pending: this.pendingMap.size,
        });
      }
      return;
    }
    this.overflowLogged = false;
    this.pendingMap.set(summary.id, summary);
    if (this.pendingMap.size >= FLUSH_BATCH_SIZE) {
      void this.flush();
    } else if (!this.timer.isSet()) {
      this.timer.cancelAndSet(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  pending(): readonly SessionSummary[] {
    return [...this.pendingMap.values()];
  }

  async drain(): Promise<void> {
    this.timer.cancel();
    while (this.pendingMap.size > 0) {
      const before = this.pendingMap.size;
      await this.flush();
      if (this.pendingMap.size >= before) {
        // No progress — the store is down; the next reconciliation heals.
        this.log.warn('session index mirror drain made no progress; leaving the rest dirty', {
          pending: this.pendingMap.size,
        });
        return;
      }
    }
  }

  private flush(): Promise<void> {
    this.flushing ??= this.flushChunk().finally(() => {
      this.flushing = undefined;
      if (this.pendingMap.size > 0 && this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
        this.timer.cancelAndSet(() => void this.flush(), FLUSH_INTERVAL_MS);
      }
    });
    return this.flushing;
  }

  private async flushChunk(): Promise<void> {
    const chunk = [...this.pendingMap.entries()].slice(0, FLUSH_BATCH_SIZE);
    if (chunk.length === 0) return;
    try {
      const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
      if (manifest === undefined) {
        // No published generation yet — the running projection reads the
        // authoritative documents and covers these sessions; retry shortly.
        this.consecutiveFailures += 1;
        return;
      }
      const collection = sessionCollection(manifest.seq);
      const counters = sessionCountersCollection(manifest.seq);
      const ids = chunk.map(([id]) => id);
      const olds = await this.queryStore.getMany<SessionSummary>(collection, ids);

      const deltas = new Map<string, { active: number; archived: number }>();
      const bump = (workspaceId: string, field: 'active' | 'archived', by: number): void => {
        const entry = deltas.get(workspaceId) ?? { active: 0, archived: 0 };
        entry[field] += by;
        deltas.set(workspaceId, entry);
      };
      for (const [id, summary] of chunk) {
        const old = olds.get(id);
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

      const current = await this.queryStore.getMany<SessionWorkspaceCounts>(counters, [
        ...deltas.keys(),
      ]);
      const ops = [
        ...chunk.map(([id, summary]) => ({
          kind: 'put' as const,
          collection,
          key: id,
          value: withRecencyField(manifest.seq, summary),
          columns: { [recencyColumn(manifest.seq)]: summary.updatedAt },
        })),
        ...[...deltas.entries()].map(([workspaceId, delta]) => {
          const base = current.get(workspaceId) ?? { active: 0, archived: 0 };
          const value: SessionWorkspaceCounts = {
            active: Math.max(0, base.active + delta.active),
            archived: Math.max(0, base.archived + delta.archived),
          };
          return { kind: 'put' as const, collection: counters, key: workspaceId, value };
        }),
      ];
      await this.queryStore.batch(ops);
      for (const [id, summary] of chunk) {
        if (this.pendingMap.get(id) === summary) this.pendingMap.delete(id);
      }
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.log.warn('failed to flush session index mirror chunk', {
        pending: this.pendingMap.size,
        failures: this.consecutiveFailures,
        error: String(error),
      });
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.log.warn('session index mirror giving up until the next record; reconciliation will heal', {
          pending: this.pendingMap.size,
        });
      }
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionIndexMirror,
  SessionIndexMirror,
  ScopeActivation.OnScopeCreated,
  'sessionIndex',
);
