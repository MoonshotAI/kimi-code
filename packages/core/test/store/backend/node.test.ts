import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { JournalLockedError, nodeJournal } from '#/store/backend/node';
import { LogCorruptError } from '#/store/commit';
import { openWriter } from '#/store/writer';

import { note, texts, type Note } from '../fixtures';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'core-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('node journal', () => {
  it('persists jsonl logs in nested files and lists them', async () => {
    const dir = await tempDir();
    const writer = openWriter(await nodeJournal(dir, { fsync: true }));
    await (await writer.open<Note>('session')).commit({ events: [note('s')] });
    const agent = await writer.open<Note>('agents/a');
    await agent.commit({ events: [note('a'), note('b')] });
    await agent.commit({ rewind: 1 });
    await writer.close();
    expect((await readFile(join(dir, 'agents', 'a.jsonl'), 'utf8')).split('\n')).toHaveLength(3);
    const reopened = openWriter(await nodeJournal(dir));
    expect(await reopened.names('agents/')).toEqual(['agents/a']);
    expect((await reopened.open<Note>('agents/a')).replica.view(texts).getState()).toEqual(['a']);
    await reopened.close();
  });

  it('preserves a torn tail for read-only readers, then truncates it and keeps appending', async () => {
    const dir = await tempDir();
    const first = openWriter(await nodeJournal(dir));
    await (await first.open<Note>('a')).commit({ events: [note('a')] });
    await first.close();
    await appendFile(join(dir, 'a.jsonl'), '{"seq":1,"time":9,"ev');
    const reader = await nodeJournal(dir, { readOnly: true });
    const complete: string[] = [];
    for await (const line of reader.lines('a', 0)) complete.push(line);
    expect(complete).toHaveLength(1);
    expect(await readFile(join(dir, 'a.jsonl'), 'utf8')).toContain('{"seq":1,"time":9,"ev');
    await reader.close();
    const second = openWriter(await nodeJournal(dir));
    const log = await second.open<Note>('a');
    expect(log.version).toBe(1);
    expect(await log.commit({ events: [note('b')] })).toBe(2);
    await second.close();
    const lines = (await readFile(join(dir, 'a.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as { seq: number }).seq)).toEqual([0, 1]);
  });

  it('refuses to open a log with a corrupt middle line', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'a.jsonl'), '{"seq":0,"time":1,"events":[{"type":"note","text":"a"}]}\nnot-json\n');
    const writer = openWriter(await nodeJournal(dir));
    await expect(writer.open('a')).rejects.toThrow(LogCorruptError);
    await writer.close();
  });

  it('allows one writer per directory and takes over a stale lock', async () => {
    const dir = await tempDir();
    const journal = await nodeJournal(dir);
    await expect(nodeJournal(dir)).rejects.toBeInstanceOf(JournalLockedError);
    await (await nodeJournal(dir, { readOnly: true })).close();
    await journal.close();
    await writeFile(join(dir, 'writer.lock'), '999999999');
    await (await nodeJournal(dir)).close();
  });
});
