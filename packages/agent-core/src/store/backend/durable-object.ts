import type { DurableObjectSql } from '#/utils/durable-object';

import type { Journal } from '../writer';

const textPartChars = 512 * 1024;

function splitText(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + textPartChars, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

export function durableObjectJournal(storage: DurableObjectSql): Journal {
  const { sql } = storage;
  sql.exec('CREATE TABLE IF NOT EXISTS store_logs (log TEXT PRIMARY KEY) WITHOUT ROWID');
  sql.exec(
    'CREATE TABLE IF NOT EXISTS store_lines (log TEXT NOT NULL, seq INTEGER NOT NULL, part INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (log, seq, part)) WITHOUT ROWID',
  );
  return {
    names: async (prefix) =>
      Array.from(sql.exec('SELECT log FROM store_logs ORDER BY log'), (row) => String(row['log'])).filter((name) =>
        name.startsWith(prefix),
      ),
    async *lines(log, from) {
      const lines: string[] = [];
      let seq: number | undefined;
      let parts: string[] = [];
      for (const row of sql.exec(
        'SELECT seq, text FROM store_lines WHERE log = ? AND seq >= ? ORDER BY seq, part',
        log,
        from,
      )) {
        const rowSeq = Number(row['seq']);
        if (rowSeq !== seq && parts.length > 0) {
          lines.push(parts.join(''));
          parts = [];
        }
        seq = rowSeq;
        parts.push(String(row['text']));
      }
      if (parts.length > 0) lines.push(parts.join(''));
      yield* lines;
    },
    append: async (log, seq, line) => {
      storage.transactionSync(() => {
        sql.exec('INSERT OR IGNORE INTO store_logs (log) VALUES (?)', log);
        splitText(line).forEach((text, part) => {
          sql.exec('INSERT INTO store_lines (log, seq, part, text) VALUES (?, ?, ?, ?)', log, seq, part, text);
        });
      });
    },
    close: async () => {},
  };
}
