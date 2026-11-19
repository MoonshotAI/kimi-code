import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { DurableObjectSql, SqlValue } from '#/utils/durable-object';

export function sqliteStorage(db = new DatabaseSync(':memory:')): DurableObjectSql {
  const input = (value: SqlValue): SQLInputValue => (value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  const output = (value: unknown): SqlValue => (value instanceof Uint8Array ? value.slice().buffer : (value as SqlValue));
  return {
    sql: {
      exec: (query, ...bindings) =>
        db
          .prepare(query)
          .all(...bindings.map(input))
          .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, output(value)]))),
    },
    transactionSync: (closure) => {
      db.exec('BEGIN');
      try {
        const result = closure();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
