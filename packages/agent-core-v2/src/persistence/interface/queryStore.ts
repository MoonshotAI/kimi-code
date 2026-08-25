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

export interface ColumnBounds {
  readonly gt?: number;
  readonly gte?: number;
  readonly lt?: number;
  readonly lte?: number;
}

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
  getMany<T>(collection: string, keys: readonly string[]): Promise<Map<string, T>>;
  query<T>(collection: string): IQuery<T>;
  pageByColumn<T>(collection: string, query: ColumnPageQuery): Promise<Page<T>>;
  ensureIndex(collection: string, def: IndexDef): Promise<void>;
  listKeys(collection: string): Promise<readonly string[]>;
  dropCollection(collection: string): Promise<void>;
  getCheckpoint(source: string): Promise<Checkpoint | undefined>;
  setCheckpoint(source: string, checkpoint: Checkpoint): Promise<void>;
  close(): Promise<void>;
}

export const IQueryStore: ServiceIdentifier<IQueryStore> = createDecorator<IQueryStore>('queryStore');
