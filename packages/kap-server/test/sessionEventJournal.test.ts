import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({ appendFailures: 0 }));

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      if (fsMock.appendFailures > 0) {
        fsMock.appendFailures--;
        const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      }
      return actual.appendFile(...args);
    },
  };
});

import {
  type EventEnvelope,
  SessionEventJournal,
} from '../src/transport/ws/v1/sessionEventJournal';

function envelope(seq: number): EventEnvelope {
  return {
    type: 'turn.started',
    seq,
    timestamp: new Date().toISOString(),
    payload: { seq },
  };
}

describe('SessionEventJournal', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-journal-test-'));
    filePath = join(dir, 'sess_1.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('assigns monotonic seq and reads back in order', async () => {
    const j = await SessionEventJournal.open(filePath);
    expect(j.epoch).toMatch(/^ep_/);
    expect(j.seq).toBe(0);

    j.append(j.nextSeq(), envelope(1));
    j.append(j.nextSeq(), envelope(2));
    j.append(j.nextSeq(), envelope(3));
    expect(j.seq).toBe(3);

    const all = await j.readSince(0, 100);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    await j.close();
  });

  it('recovers seq and epoch across reopen', async () => {
    const j1 = await SessionEventJournal.open(filePath);
    const epoch = j1.epoch;
    j1.append(j1.nextSeq(), envelope(1));
    j1.append(j1.nextSeq(), envelope(2));
    await j1.close();

    j1.append(j1.nextSeq(), envelope(3));
    await j1.flush();

    const j2 = await SessionEventJournal.open(filePath);
    expect(j2.epoch).toBe(epoch);
    expect(j2.seq).toBe(2);
    expect(j2.nextSeq()).toBe(3);
    await j2.close();
  });

  it('rotates to a fresh epoch when the header is corrupt', async () => {
    const j1 = await SessionEventJournal.open(filePath);
    const epoch = j1.epoch;
    j1.append(j1.nextSeq(), envelope(1));
    await j1.close();

    await writeFile(filePath, 'this is not json\n', 'utf8');

    const j2 = await SessionEventJournal.open(filePath);
    expect(j2.epoch).toMatch(/^ep_/);
    expect(j2.epoch).not.toBe(epoch);
    expect(j2.seq).toBe(0);
    await j2.close();
  });

  it('readSince honors the exclusive lower bound and the limit', async () => {
    const j = await SessionEventJournal.open(filePath);
    for (let i = 1; i <= 5; i++) j.append(j.nextSeq(), envelope(i));

    const page = await j.readSince(2, 2);
    expect(page.map((e) => e.seq)).toEqual([3, 4]);
    await j.close();
  });

  it('readSince on a missing file returns empty', async () => {
    const j = await SessionEventJournal.open(filePath);
    const out = await j.readSince(0, 100);
    expect(out).toEqual([]);
    await j.close();
  });

  it('flushes appends that arrive while a flush is in flight', async () => {
    const j = await SessionEventJournal.open(filePath);
    for (let i = 1; i <= 12; i++) j.append(j.nextSeq(), envelope(i));
    const deadline = Date.now() + 2000;
    let lines = 0;
    while (Date.now() < deadline) {
      try {
        lines = (await readFile(filePath, 'utf8')).trim().split('\n').length;
      } catch {
        lines = 0;
      }
      if (lines >= 13) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(lines).toBe(13);
    await j.close();
  });

  it('keeps buffered lines after a write failure and retries with backoff', async () => {
    const j = await SessionEventJournal.open(filePath);
    fsMock.appendFailures = 2;
    try {
      j.append(j.nextSeq(), envelope(1));
      j.append(j.nextSeq(), envelope(2));

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readFile(filePath, 'utf8').catch(() => '')).toBe('');

      const deadline = Date.now() + 5000;
      let content = '';
      while (Date.now() < deadline) {
        content = await readFile(filePath, 'utf8').catch(() => '');
        if (content.trim().split('\n').filter(Boolean).length >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('"journal_header"');
      expect(lines[1]).toContain('"seq":1');
      expect(lines[2]).toContain('"seq":2');
      expect(fsMock.appendFailures).toBe(0);
    } finally {
      fsMock.appendFailures = 0;
      await j.close();
    }
  });

  it('keeps the journal header pending when the first write fails, preserving the epoch', async () => {
    const j = await SessionEventJournal.open(filePath);
    const epoch = j.epoch;
    fsMock.appendFailures = 1;
    try {
      j.append(j.nextSeq(), envelope(1));
      const deadline = Date.now() + 5000;
      let content = '';
      while (Date.now() < deadline) {
        content = await readFile(filePath, 'utf8').catch(() => '');
        if (content.includes('"journal_header"') && content.includes('"seq":1')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('"journal_header"');
      expect(lines[1]).toContain('"seq":1');
    } finally {
      fsMock.appendFailures = 0;
      await j.close();
    }

    const reopened = await SessionEventJournal.open(filePath);
    expect(reopened.epoch).toBe(epoch);
    expect(reopened.seq).toBe(1);
    await reopened.close();
  });

  it('does not write buffered lines after close', async () => {
    const j = await SessionEventJournal.open(filePath);
    fsMock.appendFailures = 100;
    j.append(j.nextSeq(), envelope(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await j.close();
    fsMock.appendFailures = 0;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await readFile(filePath, 'utf8').catch(() => '')).toBe('');
  });
});
