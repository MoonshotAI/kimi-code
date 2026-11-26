import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IntervalTimer } from '#/_base/utils/timer';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { databaseBaseEnabled } from '#/persistence/configSection';
import { IQueryStore } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { ISessionIndexMirror, type SessionSummary } from './sessionIndex';
import { markSessionDirty } from './sessionIndexDirtyJournal';
import {
  SESSION_INDEX_MANIFEST,
  addSessionCounts,
  recencyColumn,
  sessionCollection,
  sessionCountersCollection,
  withRecencyField,
  type SessionProjectCounts,
} from './sessionIndexModel';

const FLUSH_INTERVAL_MS = 100;
const FLUSH_BATCH_SIZE = 500;
const MAX_PENDING = 10_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const CONSISTENT_READ_ATTEMPTS = 3;

const pendingDrains = new Set<Promise<void>>();

export async function drainSessionIndexMirror(): Promise<void> {
  await Promise.all(pendingDrains);
}

export class SessionIndexMirror extends Disposable implements ISessionIndexMirror {
  declare readonly _serviceBrand: undefined;

  private readonly pendingMap = new Map<string, SessionSummary>();
  private readonly retained = new Map<string, SessionSummary>();
  private retainers = 0;
  private retentionReleases = 0;
  private writes = 0;
  private supersededChunks = 0;
  private readonly pendingMarks = new Set<Promise<void>>();
  private readonly timer = this._register(new IntervalTimer({ unref: true }));
  private flushing: Promise<void> | undefined;
  private consecutiveFailures = 0;
  private giveUpTracked = false;
  private disposed = false;
  private overflowLogged = false;
  private readonly sessionsScope: string;

  constructor(
    @IQueryStore private readonly queryStore: IQueryStore,
    @IConfigService private readonly config: IConfigService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IBootstrapService bootstrap: IBootstrapService,
  ) {
    super();
    this.sessionsScope = bootstrap.scope('sessions');
    this._register(
      toDisposable(() => {
        this.disposed = true;
        const pending = Promise.all(this.pendingMarks)
          .catch(() => {})
          .then(() => this.drain().catch(() => {}));
        pendingDrains.add(pending);
        void pending.finally(() => pendingDrains.delete(pending));
      }),
    );
  }

  record(summary: SessionSummary): void {
    if (this.disposed) return;
    const mark = markSessionDirty(this.storage, this.sessionsScope, summary.id).catch((error) => {
      this.log.debug('session index dirty mark failed', { error: String(error) });
    });
    this.pendingMarks.add(mark);
    void mark.finally(() => this.pendingMarks.delete(mark));
    if (!databaseBaseEnabled(this.config)) return;
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
    if (this.retained.size === 0) return [...this.pendingMap.values()];
    const merged = new Map(this.retained);
    for (const [id, summary] of this.pendingMap) merged.set(id, summary);
    return [...merged.values()];
  }

  async readConsistently<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      await this.flushing;
      const writes = this.writes;
      const value = await read();
      const settled = writes % 2 === 0 && writes === this.writes;
      if (settled || attempt === CONSISTENT_READ_ATTEMPTS) return value;
    }
  }

  retainFlushes(): IDisposable {
    this.retainers += 1;
    let released = false;
    return toDisposable(() => {
      if (released) return;
      released = true;
      this.retainers -= 1;
      if (this.retainers > 0) return;
      this.retentionReleases += 1;
      for (const [id, summary] of this.retained) {
        if (!this.pendingMap.has(id)) this.pendingMap.set(id, summary);
      }
      this.retained.clear();
      if (this.pendingMap.size > 0 && !this.disposed) void this.flush();
    });
  }

  async evict(id: string): Promise<void> {
    this.pendingMap.delete(id);
    this.retained.delete(id);
    await this.flushing;
    this.pendingMap.delete(id);
    this.retained.delete(id);
  }

  async drain(): Promise<void> {
    this.timer.cancel();
    while (this.pendingMap.size > 0) {
      const before = this.pendingMap.size;
      const supersededBefore = this.supersededChunks;
      await this.flush();
      if (this.pendingMap.size >= before && this.supersededChunks === supersededBefore) {
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
    const releasesAtStart = this.retentionReleases;
    try {
      const manifest = await this.queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
      if (manifest === undefined) {
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

      const current = await this.queryStore.getMany<SessionProjectCounts>(counters, [
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
        ...[...deltas.entries()].map(([workspaceId, delta]) => ({
          kind: 'put' as const,
          collection: counters,
          key: workspaceId,
          value: addSessionCounts(current.get(workspaceId), delta),
        })),
      ];
      this.writes += 1;
      try {
        await this.queryStore.batch(ops);
        const published = await this.queryStore
          .getCheckpoint(SESSION_INDEX_MANIFEST)
          .catch(() => undefined);
        if (published?.seq === manifest.seq && this.retentionReleases === releasesAtStart) {
          for (const [id, summary] of chunk) {
            if (this.pendingMap.get(id) !== summary) continue;
            this.pendingMap.delete(id);
            if (this.retainers > 0) this.retained.set(id, summary);
          }
        } else {
          this.supersededChunks += 1;
        }
      } finally {
        this.writes += 1;
      }
      if (this.consecutiveFailures > 0) {
        this.log.info('session index mirror flush recovered', {
          afterFailures: this.consecutiveFailures,
          pending: this.pendingMap.size,
        });
      }
      this.consecutiveFailures = 0;
      this.giveUpTracked = false;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures === 1) {
        this.log.warn('failed to flush session index mirror chunk', {
          pending: this.pendingMap.size,
          error: String(error),
        });
      }
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.log.warn('session index mirror giving up until the next record; reconciliation will heal', {
          pending: this.pendingMap.size,
          failures: this.consecutiveFailures,
        });
        if (!this.giveUpTracked) {
          this.giveUpTracked = true;
          this.telemetry.track2('session_index_mirror_give_up', {
            pending_count: this.pendingMap.size,
            consecutive_failures: this.consecutiveFailures,
          });
        }
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
