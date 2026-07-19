/**
 * `SessionEventJournal` — seq assignment, durability, recovery, epoch rotation,
 * write-failure semantics.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type EventEnvelope,
  JournalStorageError,
  SessionEventJournal,
} from '../src/transport/ws/v1/sessionEventJournal';

/**
 * Controllable write-failure injection. The journal opens its journal file via
 * `fs/promises.open(path, 'a')` per flush batch (single open → write → fsync →
 * close), so failing `open` fails the whole batch. All other calls (including
 * this test's own mkdtemp/readFile/...) pass through to the real module.
 */
const journalFs = vi.hoisted(() => ({
  failOpens: false,
  openAttempts: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (path: Parameters<typeof actual.open>[0], flags?: string, mode?: number) => {
      journalFs.openAttempts += 1;
      if (journalFs.failOpens) {
        const error = new Error('injected journal write failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        return Promise.reject(error);
      }
      return actual.open(path, flags, mode);
    },
  };
});

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
    journalFs.failOpens = false;
    journalFs.openAttempts = 0;
    dir = await mkdtemp(join(tmpdir(), 'kimi-journal-test-'));
    filePath = join(dir, 'sess_1.jsonl');
  });

  afterEach(async () => {
    journalFs.failOpens = false;
    await rm(dir, { recursive: true, force: true });
  });

  it('assigns monotonic seq and reads back in order', async () => {
    const j = await SessionEventJournal.open(filePath);
    // No baseline before the first durable append — a cold journal has no epoch.
    expect(j.epoch).toBeUndefined();
    expect(j.seq).toBe(0);

    j.append(j.nextSeq(), envelope(1));
    expect(j.epoch).toMatch(/^ep_/); // materialized on the first real append
    j.append(j.nextSeq(), envelope(2));
    j.append(j.nextSeq(), envelope(3));
    expect(j.seq).toBe(3);

    const all = await j.readSince(0, 100);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    await j.close();
  });

  it('recovers seq and epoch across reopen', async () => {
    const j1 = await SessionEventJournal.open(filePath);
    j1.append(j1.nextSeq(), envelope(1));
    j1.append(j1.nextSeq(), envelope(2));
    const epoch = j1.epoch;
    expect(epoch).toMatch(/^ep_/);
    await j1.close();

    const j2 = await SessionEventJournal.open(filePath);
    expect(j2.epoch).toBe(epoch);
    expect(j2.seq).toBe(2);
    expect(j2.nextSeq()).toBe(3);
    await j2.close();
  });

  it('rotates to a fresh epoch when the header is corrupt', async () => {
    const j1 = await SessionEventJournal.open(filePath);
    j1.append(j1.nextSeq(), envelope(1));
    const epoch = j1.epoch;
    await j1.close();

    // Corrupt the file: overwrite with a garbage first line (no header).
    await writeFile(filePath, 'this is not json\n', 'utf8');

    const j2 = await SessionEventJournal.open(filePath);
    // The baseline is lost, but the next incarnation (and its epoch) is born
    // only on the next real append.
    expect(j2.epoch).toBeUndefined();
    expect(j2.seq).toBe(0);
    j2.append(j2.nextSeq(), envelope(1));
    expect(j2.epoch).toMatch(/^ep_/);
    expect(j2.epoch).not.toBe(epoch);
    await j2.close();
  });

  it('adopts the LAST header when a rotated journal carries several', async () => {
    // A crash after a rotation can leave multiple headers in one file; only
    // the newest incarnation is authoritative.
    const lines = [
      JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_old', created_at: 1 }),
      JSON.stringify({ kind: 'event', seq: 1, envelope: envelope(1) }),
      JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_new', created_at: 2 }),
      JSON.stringify({ kind: 'event', seq: 2, envelope: envelope(2) }),
    ];
    await writeFile(filePath, lines.join('\n') + '\n', 'utf8');

    const j = await SessionEventJournal.open(filePath);
    expect(j.epoch).toBe('ep_new');
    expect(j.seq).toBe(2);
    await j.close();
  });

  it('cold reads are read-only: no epoch is fabricated and nothing is written', async () => {
    // Missing file — open → close must not create it.
    const j1 = await SessionEventJournal.open(filePath);
    expect(j1.epoch).toBeUndefined();
    expect(j1.seq).toBe(0);
    await j1.close();
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });

    // Re-open of the same absent journal: the same absent baseline — no
    // random-epoch flip-flop (which used to trigger fake `epoch_changed`).
    const j2 = await SessionEventJournal.open(filePath);
    expect(j2.epoch).toBeUndefined();
    await j2.close();
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });

    // Pre-created empty file: stays zero bytes across open → close.
    await writeFile(filePath, '', 'utf8');
    const j3 = await SessionEventJournal.open(filePath);
    expect(j3.epoch).toBeUndefined();
    await j3.close();
    expect(await readFile(filePath, 'utf8')).toBe('');

    // The epoch only materializes when the first durable event actually lands.
    j3.append(j3.nextSeq(), envelope(1));
    expect(j3.epoch).toMatch(/^ep_/);
    await j3.close();
    const j4 = await SessionEventJournal.open(filePath);
    expect(j4.epoch).toBe(j3.epoch);
    expect(j4.seq).toBe(1);
    await j4.close();
  });

  it('readSince honors the exclusive lower bound and the limit', async () => {
    const j = await SessionEventJournal.open(filePath);
    for (let i = 1; i <= 5; i++) j.append(j.nextSeq(), envelope(i));

    const page = await j.readSince(2, 2);
    expect(page.map((e) => e.seq)).toEqual([3, 4]);
    await j.close();
  });

  it('readSince on a missing file returns empty (and writes nothing)', async () => {
    const j = await SessionEventJournal.open(filePath);
    expect(j.epoch).toBeUndefined();
    const out = await j.readSince(0, 100);
    expect(out).toEqual([]);
    // A pure read never fabricates an epoch or a header.
    expect(j.epoch).toBeUndefined();
    await j.close();
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps pending lines across a failed flush and replays them after a retry', async () => {
    const j = await SessionEventJournal.open(filePath);
    j.append(j.nextSeq(), envelope(1));
    await j.readSince(0, 100); // batch 1 durable (header + seq 1)
    expect(journalFs.openAttempts).toBe(1);

    // Batch 2 fails: the lines must NOT be dropped — the file still holds seq 1.
    journalFs.failOpens = true;
    j.append(j.nextSeq(), envelope(2));
    j.append(j.nextSeq(), envelope(3));
    await vi.waitFor(() => expect(journalFs.openAttempts).toBe(2));
    journalFs.failOpens = false;

    const mid = await SessionEventJournal.open(filePath);
    expect(mid.seq).toBe(1);
    await mid.close();

    // readSince retries the pending flush, then serves the full tail.
    const all = await j.readSince(1, 100);
    expect(all.map((e) => e.seq)).toEqual([2, 3]);
    await j.close();

    const reopened = await SessionEventJournal.open(filePath);
    expect(reopened.seq).toBe(3);
    expect(reopened.epoch).toBe(j.epoch);
    await reopened.close();
  });

  it('enters a sticky failure state after consecutive write failures', async () => {
    const j = await SessionEventJournal.open(filePath);
    journalFs.failOpens = true;
    j.append(j.nextSeq(), envelope(1));

    // The scheduled round fails (1); the flush inside readSince retries and
    // fails again (2) → sticky — and the read fails loudly instead of
    // silently serving fewer events.
    await expect(j.readSince(0, 100)).rejects.toBeInstanceOf(JournalStorageError);

    // Sticky: subsequent writes fail fast (no unbounded pending growth), and
    // reads keep failing explicitly.
    expect(() => j.nextSeq()).toThrow(JournalStorageError);
    expect(() => j.append(2, envelope(2))).toThrow(JournalStorageError);
    await expect(j.readSince(0, 100)).rejects.toBeInstanceOf(JournalStorageError);

    // The sticky state is terminal for this instance — storage "recovering"
    // does not silently un-stick it mid-flight.
    journalFs.failOpens = false;
    expect(() => j.append(2, envelope(2))).toThrow(JournalStorageError);

    // close() must neither throw nor hot-spin on the persistent failure.
    await j.close();
  });

  it('flushes appends that arrive while a flush is in flight', async () => {
    const j = await SessionEventJournal.open(filePath);
    // The first append starts an in-flight flush; the rest land in the same
    // synchronous burst (while it runs) and must be chained into a follow-up
    // round — not parked until a later append or `close()`.
    for (let i = 1; i <= 12; i++) j.append(j.nextSeq(), envelope(i));
    // Poll the raw file: `readSince`/`close` force a flush themselves and
    // would mask a missing chained round.
    const deadline = Date.now() + 2000;
    let lines = 0;
    while (Date.now() < deadline) {
      try {
        lines = (await readFile(filePath, 'utf8')).trim().split('\n').length;
      } catch {
        lines = 0;
      }
      if (lines >= 13) break; // header + 12 events
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(lines).toBe(13);
    await j.close();
  });
});
