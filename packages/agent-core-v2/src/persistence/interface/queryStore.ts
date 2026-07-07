/**
 * `IQueryStore` — the indexed, queryable read-model facade.
 *
 * A peer of `IAppendLogStore` and `IAtomicDocumentStore`. Where
 * `IAppendLogStore` is the authoritative append-only write model and
 * `IAtomicDocumentStore` holds atomic documents, `IQueryStore` serves fast,
 * indexed, paginated reads over a *derived* dataset — typically materialized
 * from an append log by a projector.
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
  | { readonly kind: 'put'; readonly collection: string; readonly key: string; readonly value: unknown }
  | { readonly kind: 'delete'; readonly collection: string; readonly key: string };

export interface Checkpoint {
  readonly seq: number;
}

export interface IQueryStore {
  readonly _serviceBrand: undefined;

  put<T>(collection: string, key: string, value: T): Promise<void>;
  batch(ops: readonly WriteOp[]): Promise<void>;
  delete(collection: string, key: string): Promise<void>;
  get<T>(collection: string, key: string): Promise<T | undefined>;
  query<T>(collection: string): IQuery<T>;
  ensureIndex(collection: string, def: IndexDef): Promise<void>;
  getCheckpoint(source: string): Promise<Checkpoint | undefined>;
  setCheckpoint(source: string, checkpoint: Checkpoint): Promise<void>;
  close(): Promise<void>;
}

export const IQueryStore: ServiceIdentifier<IQueryStore> = createDecorator<IQueryStore>('queryStore');
