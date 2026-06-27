/**
 * `IQueryStore` — the indexed, queryable read-model facade.
 *
 * A peer of `IRecordStore` and `IConfigStore`. Where `IRecordStore` is the
 * authoritative append-only write model and `IConfigStore` holds atomic
 * documents, `IQueryStore` serves fast, indexed, paginated reads over a
 * *derived* dataset — typically materialized from a record log by a projector.
 *
 * This file intentionally ships the interface only. A concrete implementation
 * (e.g. backed by `minidb`) and the projector that feeds it are a follow-up;
 * the contract is fixed here so domains can depend on it without coupling to
 * any specific engine.
 *
 * `collection` is a logical table (an engine may encode it as a key prefix).
 * Values are plain JSON-shaped objects; indexes are declared over their fields.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type SortDir = 'asc' | 'desc';

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque token for the next page, or `undefined` when exhausted. */
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

/** A field mapped to a scalar (shorthand for `$eq`) or a set of operators. */
export type QueryFilter = {
  readonly [field: string]: unknown | ComparisonOp;
};

export interface IQuery<T> {
  where(filter: QueryFilter): IQuery<T>;
  orderBy(field: string, dir?: SortDir): IQuery<T>;
  limit(n: number): IQuery<T>;
  cursor(cursor: string | undefined): IQuery<T>;
  execute(): Promise<Page<T>>;
}

export interface ValueIndexDef {
  readonly kind: 'value';
  readonly name: string;
  /** Dot/bracket path into the value, e.g. `"model"` or `"meta.user"`. */
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
  /** Fields to tokenize; empty/omitted means the whole value. */
  readonly fields?: readonly string[];
}

export type IndexDef = ValueIndexDef | CompoundIndexDef | TextIndexDef;

export type WriteOp =
  | { readonly kind: 'put'; readonly collection: string; readonly key: string; readonly value: unknown }
  | { readonly kind: 'delete'; readonly collection: string; readonly key: string };

/** Position a projector has reached in its source log. */
export interface Checkpoint {
  readonly seq: number;
}

export interface IQueryStore {
  readonly _serviceBrand: undefined;

  /** Upsert a value (projector write path). */
  put<T>(collection: string, key: string, value: T): Promise<void>;

  /** Apply several writes atomically. */
  batch(ops: readonly WriteOp[]): Promise<void>;

  delete(collection: string, key: string): Promise<void>;

  get<T>(collection: string, key: string): Promise<T | undefined>;

  /** Start a query against a collection (read path). */
  query<T>(collection: string): IQuery<T>;

  /** Declare an index. Idempotent — re-declaring an existing index is a no-op. */
  ensureIndex(collection: string, def: IndexDef): Promise<void>;

  /** Read how far a projector has indexed a given source log. */
  getCheckpoint(source: string): Promise<Checkpoint | undefined>;

  /** Persist a projector's progress for a given source log. */
  setCheckpoint(source: string, checkpoint: Checkpoint): Promise<void>;

  close(): Promise<void>;
}

export const IQueryStore: ServiceIdentifier<IQueryStore> = createDecorator<IQueryStore>('queryStore');
