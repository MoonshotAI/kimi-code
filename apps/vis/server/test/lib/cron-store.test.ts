import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { buildSessionFixture } from '../fixtures/build';
import { isSafeCronId, listCronTasks } from '../../src/lib/cron-store';

async function writeCron(sessionDir: string, fileName: string, body: unknown): Promise<void> {
  const dir = join(sessionDir, 'cron');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), JSON.stringify(body));
}

describe('cron-store', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('lists valid cron tasks sorted by creation time', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    // Written in the real on-disk shape — this doubles as a drift guard for
    // the local CronTask mirror in agent-record-types.ts.
    await writeCron(sessionDir, 'a1b2c3d4.json', {
      id: 'a1b2c3d4', cron: '0 9 * * *', prompt: 'daily standup',
      createdAt: 2000, recurring: true, lastFiredAt: 5000,
    });
    await writeCron(sessionDir, 'beefbeef.json', {
      id: 'beefbeef', cron: '*/5 * * * *', prompt: 'poll ci',
      createdAt: 1000, recurring: false,
    });

    const cron = await listCronTasks(sessionDir);
    expect(cron.map((t) => t.id)).toEqual(['beefbeef', 'a1b2c3d4']); // createdAt asc
    expect(cron[1]).toMatchObject({
      cron: '0 9 * * *', prompt: 'daily standup', recurring: true, lastFiredAt: 5000,
    });
  });

  it('skips bad ids, corrupt json, and records missing required fields', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    await writeCron(sessionDir, 'NOTHEX12.json', { id: 'NOTHEX12', cron: 'x', prompt: 'p', createdAt: 1 });
    await mkdir(join(sessionDir, 'cron'), { recursive: true });
    await writeFile(join(sessionDir, 'cron', 'deadbeef.json'), '{ broken');
    await writeCron(sessionDir, 'cafecafe.json', { id: 'cafecafe', cron: '* * * * *' }); // no prompt/createdAt
    expect(await listCronTasks(sessionDir)).toEqual([]);
  });

  it('returns [] when there is no cron directory', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    expect(await listCronTasks(sessionDir)).toEqual([]);
  });

  it('isSafeCronId accepts 8-hex and ULID ids (mirrors the engine regex)', () => {
    expect(isSafeCronId('a1b2c3d4')).toBe(true);
    expect(isSafeCronId('deadbeef')).toBe(true);
    expect(isSafeCronId('DEADBEEF')).toBe(true);
    expect(isSafeCronId('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(isSafeCronId('abc')).toBe(false);
    expect(isSafeCronId('01ARZ3NDEKTSV4RRFFQ69G5FAO')).toBe(false); // 'O' is outside the ULID alphabet
    expect(isSafeCronId('../escape')).toBe(false);
  });

  it('folds cron records from wire.jsonl (v2 layout)', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const taskA = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      cron: '*/10 * * * *',
      prompt: 'wire task a',
      createdAt: 3000,
      recurring: true,
    };
    const taskB = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
      cron: '0 8 * * *',
      prompt: 'wire task b',
      createdAt: 4000,
    };
    const lines = [
      JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1 }),
      JSON.stringify({ type: 'cron.add', agentId: 'main', task: taskA, time: 10 }),
      JSON.stringify({ type: 'cron.add', agentId: 'main', task: taskB, time: 11 }),
      JSON.stringify({ type: 'cron.cursor', agentId: 'main', id: taskA.id, lastFiredAt: 9000, time: 12 }),
      JSON.stringify({ type: 'cron.delete', agentId: 'main', ids: [taskB.id], time: 13 }),
    ];
    await writeFile(join(sessionDir, 'wire.jsonl'), lines.join('\n') + '\n');

    const cron = await listCronTasks(sessionDir);
    expect(cron).toHaveLength(1);
    expect(cron[0]).toMatchObject({ ...taskA, lastFiredAt: 9000 });
  });

  it('lets wire records win over legacy cron files for the same id', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    await writeCron(sessionDir, 'a1b2c3d4.json', {
      id: 'a1b2c3d4', cron: '0 9 * * *', prompt: 'file version', createdAt: 1000,
    });
    const lines = [
      JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1 }),
      JSON.stringify({
        type: 'cron.add',
        agentId: 'main',
        task: { id: 'a1b2c3d4', cron: '0 10 * * *', prompt: 'wire version', createdAt: 1000 },
        time: 10,
      }),
    ];
    await writeFile(join(sessionDir, 'wire.jsonl'), lines.join('\n') + '\n');

    const cron = await listCronTasks(sessionDir);
    expect(cron).toHaveLength(1);
    expect(cron[0]).toMatchObject({ cron: '0 10 * * *', prompt: 'wire version' });
  });

  it('treats a missing or unreadable wire.jsonl as no records', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    await writeCron(sessionDir, 'a1b2c3d4.json', {
      id: 'a1b2c3d4', cron: '0 9 * * *', prompt: 'only files', createdAt: 1000,
    });
    // No wire.jsonl at all — legacy sessions still list their files.
    expect((await listCronTasks(sessionDir)).map((t) => t.id)).toEqual(['a1b2c3d4']);
  });

  it('ignores malformed cron.delete / cron.cursor payloads instead of throwing', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const lines = [
      JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1 }),
      JSON.stringify({
        type: 'cron.add',
        agentId: 'main',
        task: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', cron: '* * * * *', prompt: 'p', createdAt: 1 },
        time: 2,
      }),
      // Hand-edited / corrupted payloads: ids is not an array; cursor fields
      // have the wrong types. The fold must skip them, not reject the read.
      '{"type":"cron.delete","agentId":"main","ids":"not-an-array","time":3}',
      '{"type":"cron.cursor","agentId":"main","id":42,"lastFiredAt":"soon","time":4}',
    ];
    await writeFile(join(sessionDir, 'wire.jsonl'), lines.join('\n') + '\n');

    const cron = await listCronTasks(sessionDir);
    expect(cron.map((t) => t.id)).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });
});
