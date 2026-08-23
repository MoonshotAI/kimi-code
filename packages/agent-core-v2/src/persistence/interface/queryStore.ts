import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type SortDir = 'asc' | 'desc';

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface ComparisonOp {
  readonly $eq?: unknown;
  readonly $ne?: unknown;
  readonly $gt?: number | string;
  readonly $gte?: number | string;
  readonly $lt?: number | string;
  readonly $lte?: number | string;
  readonly $in?: readonly unknown[];
  readonly $nin?: readonly unknown[];
  readonly $exists?: boolean;
}

export type QueryFilter = {
  readonly [field: string]: unknown;
};

export interface IQuery<T> {
  where(filter: QueryFilter): IQuery<T>;
  /**
   * Restrict to records whose ordered column `column` falls inside `bounds`.
   * The column must have been declared at write time (`put`/`batch` with
   * `columns`).
   */
  whereColumn(column: string, bounds: ColumnBounds): IQuery<T>;
  orderBy(field: string, dir?: SortDir): IQuery<T>;
  limit(n: number): IQuery<T>;
  cursor(cursor: string | undefined): IQuery<T>;
  execute(): Promise<Page<T>>;
}

export interface ValueIndexDef {
  readonly kind: 'value';
  readonly name: string;
  readonly field: string;
  readonly unique?: boolean;
}

export interface CompoundIndexDef {
  readonly kind: 'compound';
  readonly name: string;
  readonly groupBy: string;
  readonly orderBy: string;
}

export interface TextIndexDef {
  readonly kind: 'text';
  readonly name: string;
  readonly fields?: readonly string[];
}

export type IndexDef = ValueIndexDef | CompoundIndexDef | TextIndexDef;

export type WriteOp =
  | {
      readonly kind: 'put';
      readonly collection: string;
      readonly key: string;
      readonly value: unknown;
      readonly columns?: Record<string, number>;
    }
  | { readonly kind: 'delete'; readonly collection: string; readonly key: string };

export interface Checkpoint {
  readonly seq: number;
}

/** Numeric range bounds over an ordered column; every bound is optional. */
export interface ColumnBounds {
  readonly gt?: number;
  readonly gte?: number;
  readonly lt?: number;
  readonly lte?: number;
}

/**
 * A bounded page over an ordered column: rows whose column value falls inside
 * `bounds` (all bounds optional), filtered by `filter`, ordered by the column
 * in `dir` (default `'asc'`), at most `limit` rows. Rows sharing a column
 * value come back in a deterministic but engine-specific order; a caller that
 * needs a total order re-sorts the (bounded) page itself.
 */
export interface ColumnPageQuery {
  readonly column: string;
  readonly dir?: SortDir;
  readonly filter?: QueryFilter;
  readonly bounds?: ColumnBounds;
  readonly limit: number;
}

export interface IQueryStore {
  readonly _serviceBrand: undefined;

  put<T>(
    collection: string,
    key: string,
    value: T,
    options?: { columns?: Record<string, number> },
  ): Promise<void>;
  batch(ops: readonly WriteOp[]): Promise<void>;
  delete(collection: string, key: string): Promise<void>;
  get<T>(collection: string, key: string): Promise<T | undefined>;
  /** Point reads for several keys; missing keys are absent from the result. */
  getMany<T>(collection: string, keys: readonly string[]): Promise<Map<string, T>>;
  query<T>(collection: string): IQuery<T>;
  /**
   * Bounded page over an ordered column (see `ColumnPageQuery`). This is the
   * keyset-pagination primitive: it must stay cheap even over large
   * collections (index walk, not a full scan + in-memory sort).
   */
  pageByColumn<T>(collection: string, query: ColumnPageQuery): Promise<Page<T>>;
  ensureIndex(collection: string, def: IndexDef): Promise<void>;
  /** Every key currently in the collection (engine key decoding applied). */
  listKeys(collection: string): Promise<readonly string[]>;
  /** Delete the whole collection; a no-op when it does not exist. */
  dropCollection(collection: string): Promise<void>;
  getCheckpoint(source: string): Promise<Checkpoint | undefined>;
  setCheckpoint(source: string, checkpoint: Checkpoint): Promise<void>;
  close(): Promise<void>;
}

export const IQueryStore: ServiceIdentifier<IQueryStore> = createDecorator<IQueryStore>('queryStore');
