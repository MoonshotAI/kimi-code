export type SqlValue = string | number | null | ArrayBuffer;

export interface DurableObjectSql {
  readonly sql: {
    exec(query: string, ...bindings: SqlValue[]): Iterable<Record<string, SqlValue>>;
  };
  transactionSync<T>(closure: () => T): T;
}
