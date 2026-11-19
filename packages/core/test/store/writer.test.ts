import { describe, expect, it } from 'vitest';

import { memoryJournal } from '#/store/backend/memory';
import { LogCorruptError } from '#/store/commit';
import { openWriter, StoreFailedError } from '#/store/writer';

import { note, texts, type Note } from './fixtures';

describe('writer', () => {
  it('commits batches, persists them, and restores state on reopen', async () => {
    const logs = new Map<string, string[]>();
    const writer = openWriter(memoryJournal(logs));
    const log = await writer.open<Note>('agents/a');
    expect(await log.commit({ events: [note('a'), note('b')] })).toBe(2);
    expect(await log.commit({ rewind: 1 })).toBe(3);
    expect(await log.commit({ events: [] })).toBe(3);
    await writer.close();
    expect(logs.get('agents/a')).toHaveLength(2);
    const reopened = openWriter(memoryJournal(logs));
    const restored = await reopened.open<Note>('agents/a');
    expect(restored.version).toBe(3);
    expect(restored.replica.view(texts).getState()).toEqual(['a']);
    expect(await reopened.names('agents/')).toEqual(['agents/a']);
  });

  it('rejects invalid input without failing the log', async () => {
    const writer = openWriter(memoryJournal());
    const log = await writer.open<Note>('a');
    await expect(log.commit({ events: [{ type: 'note', text: new Date() as unknown as string }] })).rejects.toThrow(
      TypeError,
    );
    await expect(log.commit({ rewind: 5 })).rejects.toThrow(TypeError);
    expect(await log.commit({ events: [note('a')] })).toBe(1);
    await expect(writer.open('../x')).rejects.toThrow('Invalid log name');
  });

  it('fails the log after a journal append error', async () => {
    const writer = openWriter({
      ...memoryJournal(),
      append: async () => {
        throw new Error('disk full');
      },
    });
    const log = await writer.open<Note>('a');
    await expect(log.commit({ events: [note('a')] })).rejects.toBeInstanceOf(StoreFailedError);
    await expect(log.commit({ events: [note('b')] })).rejects.toBeInstanceOf(StoreFailedError);
    expect(log.version).toBe(0);
  });

  it('streams catch-up then live commits from a commit boundary', async () => {
    const writer = openWriter(memoryJournal());
    const log = await writer.open<Note>('a');
    await log.commit({ events: [note('a'), note('b')] });
    await log.commit({ events: [note('c')] });
    const seqs: number[] = [];
    const lines: string[] = [];
    const stop = await log.subscribe(2, (commit, line) => {
      seqs.push(commit.seq);
      lines.push(line);
    });
    await log.commit({ rewind: 0 });
    stop();
    await log.commit({ events: [note('d')] });
    expect(seqs).toEqual([2, 3]);
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ seq: 3, rewind: 0 });
    await expect(log.subscribe(1, () => {})).rejects.toThrow('boundary');
    await expect(log.subscribe(9, () => {})).rejects.toThrow(RangeError);
  });

  it('refuses to open a log with a sequence gap', async () => {
    const logs = new Map([['a', ['{"seq":0,"time":1,"events":[{"type":"note","text":"a"}]}', '{"seq":5,"time":2,"rewind":0}']]]);
    await expect(openWriter(memoryJournal(logs)).open('a')).rejects.toThrow(LogCorruptError);
  });

  it('stamps strictly increasing times across logs', async () => {
    const writer = openWriter(memoryJournal());
    const [a, b] = await Promise.all([writer.open<Note>('a'), writer.open<Note>('b')]);
    await Promise.all([
      a.commit({ events: [note('1')] }),
      b.commit({ events: [note('2')] }),
      a.commit({ events: [note('3')] }),
      b.commit({ events: [note('4')] }),
    ]);
    const times = [...a.replica.entries(), ...b.replica.entries()].map((entry) => entry.time);
    expect(new Set(times).size).toBe(4);
  });

  it('deduplicates concurrent opens and drains on close', async () => {
    const writer = openWriter(memoryJournal());
    const [first, second] = await Promise.all([writer.open<Note>('a'), writer.open<Note>('a')]);
    expect(first).toBe(second);
    const pending = first.commit({ events: [note('a')] });
    await writer.close();
    await expect(pending).resolves.toBe(1);
    await expect(first.commit({ events: [note('b')] })).rejects.toThrow('closed');
  });
});
