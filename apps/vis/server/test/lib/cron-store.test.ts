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

  it('isSafeCronId accepts 8-hex ids only', () => {
    expect(isSafeCronId('a1b2c3d4')).toBe(true);
    expect(isSafeCronId('deadbeef')).toBe(true);
    expect(isSafeCronId('DEADBEEF')).toBe(false);
    expect(isSafeCronId('abc')).toBe(false);
    expect(isSafeCronId('../escape')).toBe(false);
  });
});
