import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { durableObjectJournal } from '#/store/backend/durable-object';
import { openWriter } from '#/store/writer';

import { sqliteStorage } from '../../utils/durable-object';
import { note, texts, type Note } from '../fixtures';

describe('durable object journal', () => {
  it('stores large commits in parts and restores them in a new instance', async () => {
    const db = new DatabaseSync(':memory:');
    const large = `a${'😀'.repeat(400_000)}`;
    const writer = openWriter(durableObjectJournal(sqliteStorage(db)));
    const log = await writer.open<Note>('agents/a');
    await log.commit({ events: [note(large)] });
    await log.commit({ events: [note('b')] });
    await (await writer.open<Note>('session')).commit({ events: [note('s')] });
    await writer.close();
    expect(db.prepare('SELECT count(*) AS n FROM store_lines WHERE log = ?').get('agents/a')).toEqual({ n: 3 });
    const reopened = openWriter(durableObjectJournal(sqliteStorage(db)));
    expect(await reopened.names('agents/')).toEqual(['agents/a']);
    expect((await reopened.open<Note>('agents/a')).replica.view(texts).getState()).toEqual([large, 'b']);
  });

  it('seeks lines by seq and rejects a duplicate commit', async () => {
    const journal = durableObjectJournal(sqliteStorage());
    const log = await openWriter(journal).open<Note>('a');
    await log.commit({ events: [note('a'), note('b')] });
    await log.commit({ events: [note('c')] });
    const seqs: number[] = [];
    for await (const line of journal.lines('a', 2)) seqs.push((JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual([2]);
    await expect(journal.append('a', 2, '{"seq":2,"time":1,"rewind":0}')).rejects.toThrow();
  });
});
