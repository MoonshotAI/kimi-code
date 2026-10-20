import type { DurableObjectSql } from '#/utils/durable-object';

import type { BlobBackend } from '../backend';

const partBytes = 1024 * 1024;

export function durableObjectBlobBackend(storage: DurableObjectSql): BlobBackend {
  const { sql } = storage;
  sql.exec(
    'CREATE TABLE IF NOT EXISTS blob_parts (key TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, part)) WITHOUT ROWID',
  );
  return {
    has: async (key) => {
      for (const _row of sql.exec('SELECT 1 FROM blob_parts WHERE key = ? LIMIT 1', key)) return true;
      return false;
    },
    read: async (key) => {
      const parts = Array.from(sql.exec('SELECT data FROM blob_parts WHERE key = ? ORDER BY part', key), (row) => {
        const data = row['data'];
        if (!(data instanceof ArrayBuffer)) throw new TypeError(`Blob '${key}' has a non-binary part`);
        return new Uint8Array(data);
      });
      if (parts.length === 0) return undefined;
      const bytes = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      return bytes;
    },
    write: async (key, data) => {
      storage.transactionSync(() => {
        sql.exec('DELETE FROM blob_parts WHERE key = ?', key);
        let part = 0;
        let offset = 0;
        do {
          const chunk = data.slice(offset, offset + partBytes);
          sql.exec('INSERT INTO blob_parts (key, part, data) VALUES (?, ?, ?)', key, part, chunk.buffer);
          part += 1;
          offset += partBytes;
        } while (offset < data.byteLength);
      });
    },
  };
}
