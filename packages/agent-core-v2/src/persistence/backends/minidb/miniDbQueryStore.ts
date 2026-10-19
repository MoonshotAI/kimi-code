import { join } from 'pathe';

import { classifyStorageError, type QueryOptions } from '@moonshot-ai/minidb';
import { ClusterDb, wipeCluster } from '@moonshot-ai/minidb/cluster';

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  IQueryStore,
  QueryStoreRebuiltError,
  type Checkpoint,
  type ColumnBounds,
  type ColumnPageQuery,
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
const DROP_BATCH_SIZE = 500;
const TRANSIENT_ESCALATION_LIMIT = 5;

function physicalKey(collection: string, key: string): string {
  return `${collection}${SEP}${key}`;
}

function indexName(collection: string, name: string): string {
  return `${collection}:${name}`;
}

const pendingDisposals = new Set<Promise<void>>();

export async function drainQueryStoreDisposals(): Promise<void> {
  await Promise.all(pendingDisposals);
}

export class MiniDbQueryStore extends Disposable implements IQueryStore {
  declare readonly _serviceBrand: undefined;

  private readonly dir: string;
  private dbPromise: Promise<ClusterDb> | undefined;
  private rebuildPromise: Promise<void> | undefined;
  private transientReadFailures = 0;
  private transientWriteFailures = 0;
  private storeEpochCounter = 0;
  private readonly ensuredIndexes = new Set<string>();

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.dir = join(this.bootstrap.cacheDir, STORE_SUBDIR);
    this._register(toDisposable(() => {
      const pending = this.close().catch(() => {});
      pendingDisposals.add(pending);
      void pending.finally(() => pendingDisposals.delete(pending));
    }));
  }

  private openDb(): Promise<ClusterDb> {
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
    this.log.info('minidb query-store opening', { dir: this.dir, shardCount: SHARD_COUNT });
    return ClusterDb.open({
      dir: this.dir,
      shardCount: SHARD_COUNT,
      valueCodec: 'json',
      valueMode: 'memory',
      fsyncPolicy: 'everysec',
      lockAcquireTimeoutMs: LOCK_ACQUIRE_TIMEOUT_MS,
    });
  }

  private rebuild(cause: unknown): Promise<void> {
    this.rebuildPromise ??= (async () => {
      this.log.warn('minidb query-store rebuilt after unrecoverable failure', {
        dir: this.dir,
        error: String(cause),
      });
      const previous = this.dbPromise;
      this.dbPromise = undefined;
      this.ensuredIndexes.clear();
      if (previous !== undefined) {
        const db = await previous.catch(() => undefined);
        await db?.close().catch(() => {});
      }
      const outcome = await wipeCluster({
        dir: this.dir,
        lockAcquireTimeoutMs: LOCK_ACQUIRE_TIMEOUT_MS,
      });
      if (outcome === 'locked') throw cause;
      this.storeEpochCounter += 1;
    })();
    const settled = this.rebuildPromise;
    return settled.then(
      () => {
        if (this.rebuildPromise === settled) this.rebuildPromise = undefined;
      },
      (error: unknown) => {
        if (this.rebuildPromise === settled) this.rebuildPromise = undefined;
        throw error;
      },
    );
  }

  private async withDb<T>(
    op: (db: ClusterDb) => Promise<T>,
    kind: 'read' | 'write',
    expectedStoreEpoch?: number,
  ): Promise<T> {
    const db = await this.openDb();
    if (expectedStoreEpoch !== undefined && expectedStoreEpoch !== this.storeEpochCounter) {
      throw new QueryStoreRebuiltError();
    }
    try {
      const result = await op(db);
      if (kind === 'write') this.transientWriteFailures = 0;
      else this.transientReadFailures = 0;
      return result;
    } catch (error) {
      if (classifyStorageError(error) !== 'rebuild') {
        const failures =
          kind === 'write'
            ? (this.transientWriteFailures += 1)
            : (this.transientReadFailures += 1);
        if (failures < TRANSIENT_ESCALATION_LIMIT) throw error;
      }
      this.transientReadFailures = 0;
      this.transientWriteFailures = 0;
      await this.rebuild(error);
      if (expectedStoreEpoch !== undefined) throw new QueryStoreRebuiltError();
      throw error;
    }
  }

  async put<T>(
    collection: string,
    key: string,
    value: T,
    options?: { columns?: Record<string, number> },
  ): Promise<void> {
    await this.withDb(
      (db) => db.set(physicalKey(collection, key), value, { dt: options?.columns }),
      'write',
    );
  }

  async batch(ops: readonly WriteOp[]): Promise<void> {
    if (ops.length === 0) return;
    await this.withDb(
      (db) =>
        db.batch(
          ops.map((op) =>
            op.kind === 'put'
              ? {
                  op: 'set' as const,
                  key: physicalKey(op.collection, op.key),
                  value: op.value,
                  dt: op.columns,
                }
              : { op: 'del' as const, key: physicalKey(op.collection, op.key) },
          ),
        ),
      'write',
    );
  }

  async delete(collection: string, key: string): Promise<void> {
    await this.withDb((db) => db.del(physicalKey(collection, key)), 'write');
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    return this.withDb((db) => db.get(physicalKey(collection, key)) as Promise<T | undefined>, 'read');
  }

  async getMany<T>(collection: string, keys: readonly string[]): Promise<Map<string, T>> {
    if (keys.length === 0) return new Map();
    const values = await this.withDb(
      (db) => db.mget(keys.map((key) => physicalKey(collection, key))),
      'read',
    );
    const out = new Map<string, T>();
    values.forEach((value, index) => {
      if (value !== undefined) out.set(keys[index]!, value as T);
    });
    return out;
  }

  async pageByColumn<T>(collection: string, query: ColumnPageQuery): Promise<Page<T>> {
    const dir = query.dir ?? 'asc';
    const rows = (await this.withDb(
      (db) =>
        db.query({
          dt: { [query.column]: query.bounds ?? {} },
          filter: query.filter as Record<string, unknown> | undefined,
          sort: { [query.column]: dir === 'desc' ? -1 : 1 },
          limit: query.limit,
        }),
      'read',
    )) as ReadonlyArray<{ value: T }>;
    return { items: rows.map((row) => row.value) };
  }

  async listKeys(collection: string): Promise<readonly string[]> {
    const prefix = `${collection}${SEP}`;
    const entries = await this.withDb((db) => db.scan({ prefix }), 'read');
    return entries.map((entry) => entry.key.slice(prefix.length));
  }

  async dropCollection(collection: string): Promise<void> {
    const prefix = `${collection}${SEP}`;
    const entries = await this.withDb((db) => db.scan({ prefix }), 'read');
    for (let start = 0; start < entries.length; start += DROP_BATCH_SIZE) {
      const chunk = entries.slice(start, start + DROP_BATCH_SIZE);
      await this.withDb(
        (db) => db.batch(chunk.map((entry) => ({ op: 'del' as const, key: entry.key }))),
        'write',
      );
    }
  }

  query<T>(collection: string): IQuery<T> {
    return new MiniDbQuery<T>((op) => this.withDb(op, 'read'), collection);
  }

  async ensureIndex(collection: string, def: IndexDef): Promise<void> {
    if (def.kind === 'text') {
      throw new Error(
        `minidb query-store is a structural read model: text index "${def.name}" on collection "${collection}" is rejected; full-text search lives in the kap-server search-index database`,
      );
    }
    const guard = `${collection}:${def.kind}:${def.name}`;
    if (this.ensuredIndexes.has(guard)) return;
    const name = indexName(collection, def.name);
    await this.withDb(async (db) => {
      try {
        if (def.kind === 'value') {
          await db.createIndex(name, { field: def.field, sparse: true, unique: def.unique });
        } else {
          await db.createCompoundIndex(name, { groupBy: def.groupBy, orderBy: def.orderBy });
        }
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('already exists')) throw error;
      }
    }, 'write');
    this.ensuredIndexes.add(guard);
  }

  async getCheckpoint(source: string): Promise<Checkpoint | undefined> {
    return this.get<Checkpoint>(CHECKPOINT_COLLECTION, source);
  }

  async setCheckpoint(
    source: string,
    checkpoint: Checkpoint,
    expectedStoreEpoch?: number,
  ): Promise<void> {
    await this.withDb(
      (db) => db.set(physicalKey(CHECKPOINT_COLLECTION, source), checkpoint),
      'write',
      expectedStoreEpoch,
    );
  }

  storeEpoch(): number {
    return this.storeEpochCounter;
  }

  async close(): Promise<void> {
    const db = await this.dbPromise?.catch(() => undefined);
    await db?.close();
  }
}

class MiniDbQuery<T> implements IQuery<T> {
  private filter: QueryFilter = {};
  private column?: { name: string; bounds: ColumnBounds };
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

  whereColumn(column: string, bounds: ColumnBounds): IQuery<T> {
    this.column = { name: column, bounds };
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
    if (this.column !== undefined) q.dt = { [this.column.name]: this.column.bounds };
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
  ScopeActivation.OnScopeCreated,
  'storage',
);
