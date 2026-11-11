import { promises as fsp } from 'node:fs';

import Database from 'better-sqlite3';
import { dirname, join } from 'pathe';

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
  type ValueIndexDef,
  type WriteOp,
} from '#/persistence/interface/queryStore';

import { wipeCluster, wipeStoreDir } from './legacyCacheCleanup.js';

const CHECKPOINT_COLLECTION = '__checkpoint__';
const STORE_FILE = 'query-store.sqlite';
const LEGACY_STORE_SUBDIR = 'query-store';
const LEGACY_SEARCH_SUBDIR = 'search-index';
const LOCK_ACQUIRE_TIMEOUT_MS = 1000;
const TRANSIENT_ESCALATION_LIMIT = 5;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS query_documents (
    collection TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (collection, key)
  );
  CREATE TABLE IF NOT EXISTS query_numeric_values (
    collection TEXT NOT NULL,
    key TEXT NOT NULL,
    column_name TEXT NOT NULL,
    numeric_value REAL NOT NULL,
    PRIMARY KEY (collection, key, column_name),
    FOREIGN KEY (collection, key) REFERENCES query_documents(collection, key) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS qs_numeric_page
    ON query_numeric_values (collection, column_name, numeric_value, key);
  CREATE TABLE IF NOT EXISTS query_indexes (
    collection TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    definition TEXT NOT NULL,
    PRIMARY KEY (collection, kind, name)
  );
`;

interface DocumentRow {
  readonly key: string;
  readonly value: string;
}

function tokenizePath(path: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  for (const segment of path.split('.')) {
    let rest = segment;
    while (rest.length > 0) {
      const matched = rest.match(/^([^[]*)\[(\d+)\](.*)$/);
      if (matched) {
        if (matched[1]) tokens.push(matched[1]);
        tokens.push(Number(matched[2]));
        rest = matched[3]!;
      } else {
        tokens.push(rest);
        rest = '';
      }
    }
  }
  return tokens;
}

function getPath(doc: unknown, path: string): unknown {
  let current: unknown = doc;
  for (const token of tokenizePath(path)) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string | number, unknown>)[token];
  }
  return current;
}

function getIndexField(doc: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current === null || current === undefined
          ? undefined
          : (current as Record<string, unknown>)[key],
      doc,
    );
}

function matchCond(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof RegExp) {
    if (cond instanceof RegExp) {
      cond.lastIndex = 0;
      return typeof value === 'string' && cond.test(value);
    }
    return value === cond;
  }
  for (const op of Object.keys(cond as Record<string, unknown>)) {
    const arg = (cond as Record<string, unknown>)[op];
    switch (op) {
      case '$eq':
        if (value !== arg) return false;
        break;
      case '$ne':
        if (value === arg) return false;
        break;
      case '$gt':
        if (!((value as number) > (arg as number))) return false;
        break;
      case '$gte':
        if (!((value as number) >= (arg as number))) return false;
        break;
      case '$lt':
        if (!((value as number) < (arg as number))) return false;
        break;
      case '$lte':
        if (!((value as number) <= (arg as number))) return false;
        break;
      case '$in':
        if (!Array.isArray(arg) || !arg.includes(value)) return false;
        break;
      case '$nin':
        if (!Array.isArray(arg) || arg.includes(value)) return false;
        break;
      case '$regex': {
        const regex =
          arg instanceof RegExp
            ? arg
            : Array.isArray(arg)
              ? new RegExp(arg[0] as string, arg[1] as string | undefined)
              : new RegExp(arg as string);
        if (typeof value !== 'string') return false;
        regex.lastIndex = 0;
        if (!regex.test(value)) return false;
        break;
      }
      case '$exists':
        if ((value !== undefined) !== !!arg) return false;
        break;
      case '$contains':
        if (!Array.isArray(value) || !value.includes(arg)) return false;
        break;
      case '$type':
        if (typeof value !== arg) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function match(doc: unknown, filter?: QueryFilter | null): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const key of Object.keys(filter)) {
    const cond = filter[key];
    if (key === '$and') {
      if (
        !Array.isArray(cond) ||
        !cond.every((entry) => match(doc, entry as QueryFilter))
      ) {
        return false;
      }
    } else if (key === '$or') {
      if (
        !Array.isArray(cond) ||
        !cond.some((entry) => match(doc, entry as QueryFilter))
      ) {
        return false;
      }
    } else if (key === '$nor') {
      if (
        !Array.isArray(cond) ||
        cond.some((entry) => match(doc, entry as QueryFilter))
      ) {
        return false;
      }
    } else if (key === '$not') {
      if (match(doc, cond as QueryFilter)) return false;
    } else if (!matchCond(getPath(doc, key), cond)) {
      return false;
    }
  }
  return true;
}

function encode(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('value must be JSON-serializable');
  return encoded;
}

function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function jsonPath(field: string): string {
  return tokenizePath(field)
    .reduce<string>(
      (path, token) =>
        typeof token === 'number'
          ? `${path}[${token}]`
          : `${path}."${token.replaceAll('"', '""')}"`,
      '$',
    );
}

function indexSqlName(collection: string, def: IndexDef): string {
  return sqlIdentifier(`qs_${def.kind}_${JSON.stringify([collection, def.name])}`);
}

function createIndexSql(collection: string, def: IndexDef): string {
  const name = indexSqlName(collection, def);
  if (def.kind === 'value') {
    const path = sqlString(jsonPath(def.field));
    return `CREATE INDEX IF NOT EXISTS ${name} ON query_documents (collection, json_extract(value, ${path})) WHERE json_type(value, ${path}) IS NOT NULL`;
  }
  if (def.kind === 'compound') {
    const group = sqlString(jsonPath(def.groupBy));
    const order = sqlString(jsonPath(def.orderBy));
    return `CREATE INDEX IF NOT EXISTS ${name} ON query_documents (collection, json_extract(value, ${group}), json_extract(value, ${order})) WHERE json_type(value, ${group}) IS NOT NULL AND json_type(value, ${order}) IS NOT NULL`;
  }
  throw new Error('text indexes are not supported');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function scalarKey(value: unknown): string {
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return `${type}:${String(value)}`;
  }
  return `json:${stableStringify(value)}`;
}

function validateUniqueIndex(
  db: Database.Database,
  collection: string,
  def: ValueIndexDef,
): void {
  if (def.unique !== true) return;
  const owners = new Map<string, string>();
  const rows = db
    .prepare<[string], DocumentRow>('SELECT key, value FROM query_documents WHERE collection = ?')
    .iterate(collection);
  for (const row of rows) {
    const value = getIndexField(decode(row.value), def.field);
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      const key = scalarKey(item);
      const previous = owners.get(key);
      if (previous !== undefined && previous !== row.key) {
        const error = new Error(
          `unique index "${collection}:${def.name}" violation on value ${JSON.stringify(item)}`,
        );
        error.name = 'UniqueViolationError';
        throw error;
      }
      owners.set(key, row.key);
    }
  }
}

function validateUniqueIndexes(db: Database.Database, collections: ReadonlySet<string>): void {
  if (collections.size === 0) return;
  const names = [...collections];
  const placeholders = names.map(() => '?').join(', ');
  const rows = db
    .prepare<unknown[], { readonly definition: string }>(
      `SELECT definition FROM query_indexes WHERE kind = 'value' AND collection IN (${placeholders})`,
    )
    .all(...names);
  for (const row of rows) {
    const def = decode<ValueIndexDef & { readonly collection: string }>(row.definition);
    validateUniqueIndex(db, def.collection, def);
  }
}

function writeBatch(db: Database.Database, ops: readonly WriteOp[]): void {
  db.transaction((batch: readonly WriteOp[]) => {
    const deleteNumeric = db.prepare(
      'DELETE FROM query_numeric_values WHERE collection = ? AND key = ?',
    );
    const deleteDocument = db.prepare(
      'DELETE FROM query_documents WHERE collection = ? AND key = ?',
    );
    const upsertDocument = db.prepare(`
      INSERT INTO query_documents (collection, key, value) VALUES (?, ?, ?)
      ON CONFLICT(collection, key) DO UPDATE SET value = excluded.value
    `);
    const upsertNumeric = db.prepare(`
      INSERT INTO query_numeric_values (collection, key, column_name, numeric_value)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(collection, key, column_name)
      DO UPDATE SET numeric_value = excluded.numeric_value
    `);
    const touched = new Set<string>();
    for (const op of batch) {
      deleteNumeric.run(op.collection, op.key);
      if (op.kind === 'delete') {
        deleteDocument.run(op.collection, op.key);
        continue;
      }
      const encoded = encode(op.value);
      upsertDocument.run(op.collection, op.key, encoded);
      touched.add(op.collection);
      for (const [column, value] of Object.entries(op.columns ?? {})) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          upsertNumeric.run(op.collection, op.key, column, value);
        }
      }
    }
    validateUniqueIndexes(db, touched);
  }).immediate(ops);
}

function boundsSql(bounds: ColumnBounds): { sql: string; params: number[] } {
  const clauses: string[] = [];
  const params: number[] = [];
  for (const [operator, value] of [
    ['>', bounds.gt],
    ['>=', bounds.gte],
    ['<', bounds.lt],
    ['<=', bounds.lte],
  ] as const) {
    if (value !== undefined) {
      clauses.push(`n.numeric_value ${operator} ?`);
      params.push(value);
    }
  }
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', params };
}

function resetDatabase(db: Database.Database): void {
  db.transaction(() => {
    const indexes = db
      .prepare<[], { readonly name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE 'qs_value_%' OR name LIKE 'qs_compound_%')",
      )
      .all();
    for (const index of indexes) db.exec(`DROP INDEX ${sqlIdentifier(index.name)}`);
    db.prepare('DELETE FROM query_numeric_values').run();
    db.prepare('DELETE FROM query_documents').run();
    db.prepare('DELETE FROM query_indexes').run();
  }).immediate();
}

function classifySqliteError(error: unknown): 'rebuild' | 'transient' {
  if (error instanceof AggregateError) {
    return error.errors.some((inner) => classifySqliteError(inner) === 'rebuild')
      ? 'rebuild'
      : 'transient';
  }
  if (error instanceof SyntaxError) return 'rebuild';
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' ? 'rebuild' : 'transient';
}

const pendingDisposals = new Set<Promise<void>>();

export async function drainQueryStoreDisposals(): Promise<void> {
  await Promise.all(pendingDisposals);
}

export class SqliteQueryStore extends Disposable implements IQueryStore {
  declare readonly _serviceBrand: undefined;

  private readonly file: string;
  private readonly legacyStoreDir: string;
  private readonly legacySearchDir: string;
  private dbPromise: Promise<Database.Database> | undefined;
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
    this.file = join(this.bootstrap.cacheDir, STORE_FILE);
    this.legacyStoreDir = join(this.bootstrap.cacheDir, LEGACY_STORE_SUBDIR);
    this.legacySearchDir = join(this.bootstrap.homeDir, LEGACY_SEARCH_SUBDIR);
    this._register(
      toDisposable(() => {
        const pending = this.close().catch(() => {});
        pendingDisposals.add(pending);
        void pending.finally(() => pendingDisposals.delete(pending));
      }),
    );
  }

  private openDb(): Promise<Database.Database> {
    if (this.rebuildPromise !== undefined) return this.openDbAfterRebuild();
    this.dbPromise ??= this.openFresh();
    return this.dbPromise;
  }

  private async openDbAfterRebuild(): Promise<Database.Database> {
    await this.rebuildPromise;
    this.dbPromise ??= this.openFresh();
    return this.dbPromise;
  }

  private async openFresh(): Promise<Database.Database> {
    this.log.info('sqlite query-store opening', { file: this.file });
    await fsp.mkdir(dirname(this.file), { recursive: true });
    const db = new Database(this.file, { timeout: LOCK_ACQUIRE_TIMEOUT_MS });
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('foreign_keys = ON');
      db.pragma(`busy_timeout = ${LOCK_ACQUIRE_TIMEOUT_MS}`);
      db.exec(SCHEMA);
      return db;
    } catch (error) {
      if (db.open) db.close();
      throw error;
    }
  }

  private rebuild(cause: unknown): Promise<void> {
    this.rebuildPromise ??= (async () => {
      this.log.warn('sqlite query-store rebuilding after unrecoverable failure', {
        file: this.file,
        error: String(cause),
      });
      const previous = this.dbPromise;
      this.dbPromise = undefined;
      this.ensuredIndexes.clear();
      let db = await previous?.catch(() => undefined);
      try {
        if (db === undefined || !db.open) db = await this.openFresh();
        resetDatabase(db);
        this.storeEpochCounter += 1;
      } catch {
        throw cause;
      } finally {
        if (db?.open) db.close();
      }
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
    op: (db: Database.Database) => T,
    kind: 'read' | 'write',
    expectedStoreEpoch?: number,
  ): Promise<T> {
    try {
      const db = await this.openDb();
      if (expectedStoreEpoch !== undefined && expectedStoreEpoch !== this.storeEpochCounter) {
        throw new QueryStoreRebuiltError();
      }
      const result = op(db);
      if (kind === 'write') this.transientWriteFailures = 0;
      else this.transientReadFailures = 0;
      return result;
    } catch (error) {
      if (error instanceof QueryStoreRebuiltError) throw error;
      if (classifySqliteError(error) !== 'rebuild') {
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
      (db) => writeBatch(db, [{ kind: 'put', collection, key, value, columns: options?.columns }]),
      'write',
    );
  }

  async batch(ops: readonly WriteOp[]): Promise<void> {
    if (ops.length === 0) return;
    await this.withDb((db) => writeBatch(db, ops), 'write');
  }

  async delete(collection: string, key: string): Promise<void> {
    await this.withDb((db) => writeBatch(db, [{ kind: 'delete', collection, key }]), 'write');
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    return this.withDb((db) => {
      const row = db
        .prepare<[string, string], { readonly value: string }>(
          'SELECT value FROM query_documents WHERE collection = ? AND key = ?',
        )
        .get(collection, key);
      return row === undefined ? undefined : decode<T>(row.value);
    }, 'read');
  }

  async getMany<T>(collection: string, keys: readonly string[]): Promise<Map<string, T>> {
    if (keys.length === 0) return new Map();
    return this.withDb((db) => {
      const get = db.prepare<[string, string], { readonly value: string }>(
        'SELECT value FROM query_documents WHERE collection = ? AND key = ?',
      );
      const out = new Map<string, T>();
      for (const key of keys) {
        const row = get.get(collection, key);
        if (row !== undefined) out.set(key, decode<T>(row.value));
      }
      return out;
    }, 'read');
  }

  async pageByColumn<T>(collection: string, query: ColumnPageQuery): Promise<Page<T>> {
    return this.withDb((db) => {
      const direction = query.dir === 'desc' ? 'DESC' : 'ASC';
      const bounds = boundsSql(query.bounds ?? {});
      const rows = db
        .prepare<unknown[], DocumentRow>(
          `SELECT d.key, d.value FROM query_numeric_values AS n
           JOIN query_documents AS d ON d.collection = n.collection AND d.key = n.key
           WHERE n.collection = ? AND n.column_name = ?${bounds.sql}
           ORDER BY n.numeric_value ${direction}, n.key ${direction}`,
        )
        .iterate(collection, query.column, ...bounds.params);
      const items: T[] = [];
      for (const row of rows) {
        const value = decode<T>(row.value);
        if (!match(value, query.filter)) continue;
        items.push(value);
        if (items.length >= query.limit) break;
      }
      return { items };
    }, 'read');
  }

  async listKeys(collection: string): Promise<readonly string[]> {
    return this.withDb(
      (db) =>
        db
          .prepare<[string], { readonly key: string }>(
            'SELECT key FROM query_documents WHERE collection = ? ORDER BY key ASC',
          )
          .all(collection)
          .map((row) => row.key),
      'read',
    );
  }

  async dropCollection(collection: string): Promise<void> {
    await this.withDb((db) => {
      db.transaction(() => {
        db.prepare('DELETE FROM query_numeric_values WHERE collection = ?').run(collection);
        db.prepare('DELETE FROM query_documents WHERE collection = ?').run(collection);
      }).immediate();
    }, 'write');
  }

  query<T>(collection: string): IQuery<T> {
    return new SqliteQuery<T>((op) => this.withDb(op, 'read'), collection);
  }

  async ensureIndex(collection: string, def: IndexDef): Promise<void> {
    if (def.kind === 'text') {
      throw new Error(
        `sqlite query-store is a structural read model: text index "${def.name}" on collection "${collection}" is rejected`,
      );
    }
    const guard = `${collection}:${def.kind}:${def.name}`;
    if (this.ensuredIndexes.has(guard)) return;
    await this.withDb((db) => {
      const existing = db
        .prepare<[string, string, string], { readonly definition: string }>(
          'SELECT definition FROM query_indexes WHERE collection = ? AND kind = ? AND name = ?',
        )
        .get(collection, def.kind, def.name);
      if (existing !== undefined) return;
      db.transaction(() => {
        const raced = db
          .prepare<[string, string, string], { readonly definition: string }>(
            'SELECT definition FROM query_indexes WHERE collection = ? AND kind = ? AND name = ?',
          )
          .get(collection, def.kind, def.name);
        if (raced !== undefined) return;
        db.exec(createIndexSql(collection, def));
        db.prepare(
          'INSERT INTO query_indexes (collection, kind, name, definition) VALUES (?, ?, ?, ?)',
        ).run(
          collection,
          def.kind,
          def.name,
          encode({ ...def, collection }),
        );
        if (def.kind === 'value') validateUniqueIndex(db, collection, def);
      }).immediate();
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
      (db) =>
        writeBatch(db, [
          { kind: 'put', collection: CHECKPOINT_COLLECTION, key: source, value: checkpoint },
        ]),
      'write',
      expectedStoreEpoch,
    );
    await this.cleanupLegacyCaches();
  }

  private async cleanupLegacyCaches(): Promise<void> {
    for (const cleanup of [
      { dir: this.legacyStoreDir, wipe: wipeCluster },
      { dir: this.legacySearchDir, wipe: wipeStoreDir },
    ]) {
      try {
        await fsp.access(cleanup.dir);
        const outcome = await cleanup.wipe({ dir: cleanup.dir, lockAcquireTimeoutMs: 0 });
        if (outcome === 'locked') {
          this.log.debug('legacy derived cache is still locked; cleanup will retry', {
            dir: cleanup.dir,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        this.log.warn('failed to clean legacy derived cache; cleanup will retry', {
          dir: cleanup.dir,
          error: String(error),
        });
      }
    }
  }

  storeEpoch(): number {
    return this.storeEpochCounter;
  }

  async close(): Promise<void> {
    await this.rebuildPromise?.catch(() => {});
    const db = await this.dbPromise?.catch(() => undefined);
    if (db?.open) db.close();
  }
}

class SqliteQuery<T> implements IQuery<T> {
  private filter: QueryFilter = {};
  private column?: { name: string; bounds: ColumnBounds };
  private sortField?: string;
  private sortDir: SortDir = 'asc';
  private lim?: number;
  private skip = 0;

  constructor(
    private readonly withDb: <R>(op: (db: Database.Database) => R) => Promise<R>,
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
    return this.withDb((db) => {
      const params: unknown[] = [this.collection];
      let sql = 'SELECT key, value FROM query_documents AS d WHERE d.collection = ?';
      if (this.column !== undefined) {
        const bounds = boundsSql(this.column.bounds);
        sql += ` AND EXISTS (
          SELECT 1 FROM query_numeric_values AS n
          WHERE n.collection = d.collection AND n.key = d.key AND n.column_name = ?${bounds.sql}
        )`;
        params.push(this.column.name, ...bounds.params);
      }
      sql += ' ORDER BY d.key ASC';
      const target = this.lim === undefined ? Infinity : this.lim + 1;
      const rows = db.prepare<unknown[], DocumentRow>(sql).iterate(...params);
      const docs: { readonly key: string; readonly value: T }[] = [];
      if (this.sortField === undefined) {
        let seen = 0;
        for (const row of rows) {
          const value = decode<T>(row.value);
          if (!match(value, this.filter)) continue;
          if (seen++ < this.skip) continue;
          docs.push({ key: row.key, value });
          if (docs.length >= target) break;
        }
      } else {
        for (const row of rows) {
          const value = decode<T>(row.value);
          if (match(value, this.filter)) docs.push({ key: row.key, value });
        }
        const sortField = this.sortField;
        docs.sort((a, b) => {
          const av = getPath(a.value, sortField) as number | string;
          const bv = getPath(b.value, sortField) as number | string;
          const compared = av < bv ? -1 : av > bv ? 1 : 0;
          return this.sortDir === 'desc' ? -compared : compared;
        });
      }
      const sliced =
        this.sortField !== undefined && (this.skip || target !== Infinity)
          ? docs.slice(this.skip, this.skip + target)
          : docs;
      let items = sliced.map((row) => row.value);
      let nextCursor: string | undefined;
      if (this.lim !== undefined && items.length > this.lim) {
        items = items.slice(0, this.lim);
        nextCursor = String(this.skip + this.lim);
      }
      return { items, nextCursor };
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  IQueryStore,
  SqliteQueryStore,
  ScopeActivation.OnScopeCreated,
  'storage',
);
