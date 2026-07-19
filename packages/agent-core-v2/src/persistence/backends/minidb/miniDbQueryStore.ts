/**
 * `minidb` backend — `IQueryStore` implementation over `ClusterDb`.
 *
 * A rebuildable, in-process derived read-model. The store is a `ClusterDb`
 * of 16 shards rooted at `<cacheDir>/query-store`: keys are hash-routed over
 * ordinary `MiniDb` directories, so multiple kimi processes can read and
 * write the same read model concurrently (a single writer per shard, readers
 * that never take write locks) instead of failing against a database-wide
 * single-writer lock. Authoritative data lives in `IAppendLogStore` /
 * `IAtomicDocumentStore`, never here, so losing the read model is always
 * safe.
 *
 * Values are JSON (`valueCodec: 'json'`, required by secondary indexes and
 * `query`) and held in memory (`valueMode: 'memory'`); durability is
 * `everysec`, which is acceptable for a cache. Writes are atomic per shard;
 * a `batch` spanning shards is best-effort across them — a projector can
 * always replay from its checkpoint. `lockAcquireTimeoutMs` is lowered from
 * the 30s default: a cache read must not hang behind a contended shard, and
 * with `lockHoldMs` yields one second is ample for a live writer.
 *
 * The database is opened **lazily** on the first actual IO, not at
 * construction. Construction therefore does no filesystem work — important
 * because `MiniDbQueryStore` is resolved transitively whenever a consumer
 * (e.g. `SessionMetadata`) is constructed, including in tests that share a
 * home dir and never read or write the read model.
 *
 * Corruption handling lifts `MiniDb.openOrRebuild`'s predicate
 * (`SyntaxError` / `CorruptFrameError`) to the cluster: the first
 * rebuildable failure triggers one process-lifetime rebuild — close, delete
 * the directory, reopen empty, retry the operation once — and consumers'
 * checkpoint-based reprojection repopulates the model. Every other error
 * propagates as-is; in particular a per-shard `LockError` (a live process
 * holding a shard beyond the acquire timeout) is transient and must NOT
 * become `storage.locked`, which consumers would treat as a permanent
 * read-model outage.
 *
 * A `collection` is encoded as a key prefix (`<collection>` + NUL + `<key>`); index
 * names are prefixed with the collection to keep them isolated in the
 * cluster-wide registry, and value indexes are created `sparse` so documents
 * from other collections (which lack the indexed field) are skipped.
 *
 * Bound at App scope as a peer of the other access-pattern stores.
 */

import { promises as fsp } from 'node:fs';

import { join } from 'pathe';

import { type QueryOptions } from '@moonshot-ai/minidb';
import { ClusterDb } from '@moonshot-ai/minidb/cluster';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  IQueryStore,
  type Checkpoint,
  type IndexDef,
  type IQuery,
  type Page,
  type QueryFilter,
  type SortDir,
  type WriteOp,
} from '#/persistence/interface/queryStore';

const SEP = String.fromCodePoint(0);
const CHECKPOINT_COLLECTION = '__checkpoint__';
const STORE_SUBDIR = 'query-store';
const SHARD_COUNT = 16;
const LOCK_ACQUIRE_TIMEOUT_MS = 1000;

function physicalKey(collection: string, key: string): string {
  return `${collection}${SEP}${key}`;
}

function indexName(collection: string, name: string): string {
  return `${collection}:${name}`;
}

/** The `MiniDb.openOrRebuild` rebuildable predicate: only unrecoverable
 *  on-disk corruption justifies wiping the read model. */
function isRebuildable(error: unknown): boolean {
  return error instanceof SyntaxError || (error as { name?: string }).name === 'CorruptFrameError';
}

export class MiniDbQueryStore extends Disposable implements IQueryStore {
  declare readonly _serviceBrand: undefined;

  private readonly dir: string;
  private dbPromise: Promise<ClusterDb> | undefined;
  private rebuildPromise: Promise<void> | undefined;
  private readonly ensuredIndexes = new Set<string>();

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.dir = join(this.bootstrap.cacheDir, STORE_SUBDIR);
    this._register(toDisposable(() => {
      void this.close();
    }));
  }

  private openDb(): Promise<ClusterDb> {
    // A rebuild wipes and recreates the directory; opens started while one is
    // in flight must wait for it instead of racing the rm.
    if (this.rebuildPromise !== undefined) return this.openDbAfterRebuild();
    this.dbPromise ??= this.openFresh();
    return this.dbPromise;
  }

  private async openDbAfterRebuild(): Promise<ClusterDb> {
    await this.rebuildPromise;
    this.dbPromise ??= this.openFresh();
    return this.dbPromise;
  }

  private openFresh(): Promise<ClusterDb> {
    return ClusterDb.open({
      dir: this.dir,
      shardCount: SHARD_COUNT,
      valueCodec: 'json',
      valueMode: 'memory',
      fsyncPolicy: 'everysec',
      lockAcquireTimeoutMs: LOCK_ACQUIRE_TIMEOUT_MS,
    });
  }

  /** One process-lifetime rebuild: wipe the corrupt store and let the next
   *  open start empty. Concurrent callers share the same in-flight rebuild. */
  private rebuild(cause: unknown): Promise<void> {
    this.rebuildPromise ??= (async () => {
      this.log.warn('minidb query-store rebuilt after corruption', {
        dir: this.dir,
        error: String(cause),
      });
      const previous = this.dbPromise;
      // Reset before the first await so a concurrent openDb() waits on
      // rebuildPromise instead of reusing the corrupt instance.
      this.dbPromise = undefined;
      this.ensuredIndexes.clear();
      if (previous !== undefined) {
        const db = await previous.catch(() => undefined);
        await db?.close().catch(() => {});
      }
      await fsp.rm(this.dir, { recursive: true, force: true });
    })();
    return this.rebuildPromise;
  }

  private async withDb<T>(op: (db: ClusterDb) => Promise<T>): Promise<T> {
    try {
      return await op(await this.openDb());
    } catch (error) {
      if (!isRebuildable(error)) throw error;
      await this.rebuild(error);
      // One retry on the fresh store; a second failure propagates as-is.
      return op(await this.openDb());
    }
  }

  async put<T>(collection: string, key: string, value: T): Promise<void> {
    await this.withDb((db) => db.set(physicalKey(collection, key), value));
  }

  async batch(ops: readonly WriteOp[]): Promise<void> {
    if (ops.length === 0) return;
    await this.withDb((db) =>
      db.batch(
        ops.map((op) =>
          op.kind === 'put'
            ? { op: 'set' as const, key: physicalKey(op.collection, op.key), value: op.value }
            : { op: 'del' as const, key: physicalKey(op.collection, op.key) },
        ),
      ),
    );
  }

  async delete(collection: string, key: string): Promise<void> {
    await this.withDb((db) => db.del(physicalKey(collection, key)));
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    return this.withDb((db) => db.get(physicalKey(collection, key)) as Promise<T | undefined>);
  }

  query<T>(collection: string): IQuery<T> {
    return new MiniDbQuery<T>((op) => this.withDb(op), collection);
  }

  async ensureIndex(collection: string, def: IndexDef): Promise<void> {
    const guard = `${collection}:${def.kind}:${def.name}`;
    if (this.ensuredIndexes.has(guard)) return;
    const name = indexName(collection, def.name);
    await this.withDb(async (db) => {
      try {
        if (def.kind === 'value') {
          await db.createIndex(name, { field: def.field, sparse: true, unique: def.unique });
        } else if (def.kind === 'compound') {
          await db.createCompoundIndex(name, { groupBy: def.groupBy, orderBy: def.orderBy });
        } else {
          await db.createTextIndex(name, { fields: def.fields });
        }
      } catch (error) {
        // A raced ensure (a peer process created it first, or a rebuild
        // replayed this call) is a no-op: the definition already exists.
        if (!(error instanceof Error) || !error.message.includes('already exists')) throw error;
      }
    });
    this.ensuredIndexes.add(guard);
  }

  async getCheckpoint(source: string): Promise<Checkpoint | undefined> {
    return this.get<Checkpoint>(CHECKPOINT_COLLECTION, source);
  }

  async setCheckpoint(source: string, checkpoint: Checkpoint): Promise<void> {
    await this.put(CHECKPOINT_COLLECTION, source, checkpoint);
  }

  async close(): Promise<void> {
    const db = await this.dbPromise?.catch(() => undefined);
    await db?.close();
  }
}

class MiniDbQuery<T> implements IQuery<T> {
  private filter: QueryFilter = {};
  private sortField?: string;
  private sortDir: SortDir = 'asc';
  private lim?: number;
  private skip = 0;

  constructor(
    private readonly withDb: <R>(op: (db: ClusterDb) => Promise<R>) => Promise<R>,
    private readonly collection: string,
  ) {}

  where(filter: QueryFilter): IQuery<T> {
    this.filter = { ...this.filter, ...filter };
    return this;
  }

  orderBy(field: string, dir: SortDir = 'asc'): IQuery<T> {
    this.sortField = field;
    this.sortDir = dir;
    return this;
  }

  limit(n: number): IQuery<T> {
    this.lim = n;
    return this;
  }

  cursor(cursor: string | undefined): IQuery<T> {
    this.skip = cursor !== undefined && cursor.length > 0 ? Number(cursor) : 0;
    return this;
  }

  async execute(): Promise<Page<T>> {
    const prefix = `${this.collection}${SEP}`;
    const q: QueryOptions = { key: { prefix } };
    if (Object.keys(this.filter).length > 0) q.filter = this.filter as Record<string, unknown>;
    if (this.sortField !== undefined) {
      q.sort = { [this.sortField]: this.sortDir === 'desc' ? -1 : 1 };
    }
    q.skip = this.skip;
    if (this.lim !== undefined) q.limit = this.lim + 1;
    const rows = (await this.withDb((db) => db.query(q))) as ReadonlyArray<{ key: string; value: T }>;
    let items = rows.map((r) => r.value);
    let nextCursor: string | undefined;
    if (this.lim !== undefined && items.length > this.lim) {
      items = items.slice(0, this.lim);
      nextCursor = String(this.skip + this.lim);
    }
    return { items, nextCursor };
  }
}

registerScopedService(
  LifecycleScope.App,
  IQueryStore,
  MiniDbQueryStore,
  InstantiationType.Eager,
  'storage',
);
