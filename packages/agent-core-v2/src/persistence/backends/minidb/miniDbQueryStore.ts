/**
 * `minidb` backend — `IQueryStore` implementation over `MiniDb`.
 *
 * A rebuildable, in-process derived read-model. `MiniDb` is opened with
 * `openOrRebuild`, so on-disk corruption becomes a clean rebuild rather than a
 * hard failure: authoritative data lives in `IAppendLogStore` /
 * `IAtomicDocumentStore`, never here, so losing the read model is always safe.
 * Values are JSON (`valueCodec: 'json'`, required by secondary indexes and
 * `query`) and held in memory (`valueMode: 'memory'`); durability is `everysec`,
 * which is acceptable for a cache. The store is rooted at
 * `<cacheDir>/query-store`.
 *
 * The database is opened **lazily** on the first actual IO, not at construction.
 * Construction therefore does no filesystem work and never touches the single
 * writer lock — important because `MiniDbQueryStore` is resolved transitively
 * whenever a consumer (e.g. `SessionMetadata`) is constructed, including in
 * tests that share a home dir and never read or write the read model. Only a
 * real `put`/`get`/`query`/... opens the database.
 *
 * An open failure — typically another kimi process holding the single-writer
 * lock on `<cacheDir>/query-store` — throws `StorageError(storage.locked)`
 * instead of silently degrading to a no-op. The failure is memoized (the
 * rejected open promise is cached), so the error is stable for the process
 * lifetime and consumers can catch it once and fall back to their
 * non-read-model paths.
 *
 * A `collection` is encoded as a key prefix (`<collection>\u0000<key>`); indexes
 * are global to the `MiniDb` instance, so index names are prefixed with the
 * collection to keep them isolated, and value indexes are created `sparse` so
 * documents from other collections (which lack the indexed field) are skipped.
 *
 * Bound at App scope as a peer of the other access-pattern stores.
 */

import { join } from 'pathe';

import { MiniDb, type QueryOptions } from '@moonshot-ai/minidb';

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
import { StorageError, StorageErrors } from '#/persistence/interface/storage';

const SEP = String.fromCodePoint(0);
const CHECKPOINT_COLLECTION = '__checkpoint__';
const STORE_SUBDIR = 'query-store';

function physicalKey(collection: string, key: string): string {
  return `${collection}${SEP}${key}`;
}

function indexName(collection: string, name: string): string {
  return `${collection}:${name}`;
}

export class MiniDbQueryStore extends Disposable implements IQueryStore {
  declare readonly _serviceBrand: undefined;

  private readonly dir: string;
  private dbPromise: Promise<MiniDb> | undefined;
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

  private openDb(): Promise<MiniDb> {
    if (this.dbPromise !== undefined) return this.dbPromise;
    this.dbPromise = MiniDb.openOrRebuild(
      {
        dir: this.dir,
        valueCodec: 'json',
        valueMode: 'memory',
        fsyncPolicy: 'everysec',
      },
      {
        onRebuild: (err) => {
          this.log.warn('minidb query-store rebuilt after corruption', {
            dir: this.dir,
            error: String(err),
          });
        },
      },
    ).catch((error) => {
      throw new StorageError(
        StorageErrors.codes.STORAGE_LOCKED,
        'minidb query-store is locked by another process',
        { details: { dir: this.dir }, cause: error },
      );
    });
    return this.dbPromise;
  }

  async put<T>(collection: string, key: string, value: T): Promise<void> {
    const db = await this.openDb();
    await db.set(physicalKey(collection, key), value);
  }

  async batch(ops: readonly WriteOp[]): Promise<void> {
    if (ops.length === 0) return;
    const db = await this.openDb();
    await db.batch(
      ops.map((op) =>
        op.kind === 'put'
          ? { op: 'set' as const, key: physicalKey(op.collection, op.key), value: op.value }
          : { op: 'del' as const, key: physicalKey(op.collection, op.key) },
      ),
    );
  }

  async delete(collection: string, key: string): Promise<void> {
    const db = await this.openDb();
    await db.del(physicalKey(collection, key));
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    const db = await this.openDb();
    return db.get(physicalKey(collection, key)) as T | undefined;
  }

  query<T>(collection: string): IQuery<T> {
    return new MiniDbQuery<T>(() => this.openDb(), collection);
  }

  async ensureIndex(collection: string, def: IndexDef): Promise<void> {
    const guard = `${collection}:${def.kind}:${def.name}`;
    if (this.ensuredIndexes.has(guard)) return;
    const db = await this.openDb();
    const name = indexName(collection, def.name);
    if (def.kind === 'value') {
      if (!db.listIndexes().some((i) => i.name === name)) {
        await db.createIndex(name, { field: def.field, sparse: true, unique: def.unique });
      }
    } else if (def.kind === 'compound') {
      if (!db.listCompoundIndexes().some((i) => i.name === name)) {
        await db.createCompoundIndex(name, { groupBy: def.groupBy, orderBy: def.orderBy });
      }
    } else {
      try {
        await db.createTextIndex(name, { fields: def.fields });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('already exists')) throw error;
      }
    }
    this.ensuredIndexes.add(guard);
  }

  async getCheckpoint(source: string): Promise<Checkpoint | undefined> {
    return this.get<Checkpoint>(CHECKPOINT_COLLECTION, source);
  }

  async setCheckpoint(source: string, checkpoint: Checkpoint): Promise<void> {
    await this.put(CHECKPOINT_COLLECTION, source, checkpoint);
  }

  async close(): Promise<void> {
    if (this.dbPromise === undefined) return;
    const db = await this.dbPromise.catch(() => undefined);
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
    private readonly openDb: () => Promise<MiniDb>,
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
    const db = await this.openDb();
    const prefix = `${this.collection}${SEP}`;
    const q: QueryOptions = { key: { prefix } };
    if (Object.keys(this.filter).length > 0) q.filter = this.filter as Record<string, unknown>;
    if (this.sortField !== undefined) {
      q.sort = { [this.sortField]: this.sortDir === 'desc' ? -1 : 1 };
    }
    q.skip = this.skip;
    if (this.lim !== undefined) q.limit = this.lim + 1;
    const rows = db.query(q) as ReadonlyArray<{ key: string; value: T }>;
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
  InstantiationType.Delayed,
  'storage',
);
