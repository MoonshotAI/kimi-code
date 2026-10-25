import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type EventEnvelope,
  SessionEventJournal,
} from '../src/transport/ws/v1/sessionEventJournal';

const fsMock = vi.hoisted(() => ({
  appendFailures: 0,
  appendPrefixLines: 0,
  appendPrefixBytes: 0,
  appendPrefixes: [] as number[],
  appendCalls: 0,
  appendGate: undefined as Promise<void> | undefined,
  appendStarted: undefined as (() => void) | undefined,
  statFailures: 0,
  statFailuresAfterAppend: 0,
  rangeReadFailures: 0,
  partialAppends: [] as { requested: number; written: number }[],
}));

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  const { Readable } = await import('node:stream');
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      if (typeof args[1] === 'object' && args[1]?.start !== undefined && fsMock.rangeReadFailures > 0) {
        fsMock.rangeReadFailures--;
        return new Readable({
          read() {
            this.destroy(new Error('EIO: temporary range read failure'));
          },
        });
      }
      return actual.createReadStream(...args);
    },
  };
});

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  const enospc = (): NodeJS.ErrnoException => {
    const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
    error.code = 'ENOSPC';
    return error;
  };
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (fsMock.statFailures > 0) {
        fsMock.statFailures--;
        const error = new Error('EIO: temporary stat failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return actual.stat(...args);
    },
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      fsMock.appendCalls++;
      if (fsMock.appendGate !== undefined) {
        const gate = fsMock.appendGate;
        fsMock.appendGate = undefined;
        fsMock.appendStarted?.();
        await gate;
      }
      const prefixBytes = fsMock.appendPrefixes.shift() ?? fsMock.appendPrefixBytes;
      if (prefixBytes > 0) {
        fsMock.appendPrefixBytes = 0;
        const bytes = Buffer.isBuffer(args[1]) ? args[1] : Buffer.from(String(args[1]), 'utf8');
        const prefix = bytes.subarray(0, prefixBytes);
        await actual.appendFile(args[0], prefix);
        fsMock.partialAppends.push({ requested: bytes.byteLength, written: prefix.byteLength });
        fsMock.statFailures += fsMock.statFailuresAfterAppend;
        fsMock.statFailuresAfterAppend = 0;
        throw enospc();
      }
      if (fsMock.appendPrefixLines > 0) {
        const count = fsMock.appendPrefixLines;
        fsMock.appendPrefixLines = 0;
        const prefix =
          String(args[1])
            .split('\n')
            .slice(0, count)
            .join('\n') + '\n';
        await actual.appendFile(args[0], prefix, args[2]);
        throw enospc();
      }
      if (fsMock.appendFailures > 0) {
        fsMock.appendFailures--;
        throw enospc();
      }
      return actual.appendFile(...args);
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
    fsMock.appendFailures = 0;
    fsMock.appendPrefixLines = 0;
    fsMock.appendPrefixBytes = 0;
    fsMock.appendPrefixes = [];
    fsMock.appendCalls = 0;
    fsMock.appendGate = undefined;
    fsMock.appendStarted = undefined;
    fsMock.statFailures = 0;
    fsMock.statFailuresAfterAppend = 0;
    fsMock.rangeReadFailures = 0;
    fsMock.partialAppends = [];
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

  it('does not duplicate events after a partially committed write', async () => {
    const j = await SessionEventJournal.open(filePath);
    fsMock.appendPrefixLines = 2;
    try {
      j.append(j.nextSeq(), envelope(1));
      j.append(j.nextSeq(), envelope(2));

      const deadline = Date.now() + 5000;
      let content = '';
      while (Date.now() < deadline) {
        content = await readFile(filePath, 'utf8').catch(() => '');
        if (content.includes('"seq":2')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('"journal_header"');
      expect(lines[1]).toContain('"seq":1');
      expect(lines[2]).toContain('"seq":2');
      const entries = await j.readSince(0, 100);
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
    } finally {
      await j.close();
    }
  });

  it('repairs a torn line on retry so the event is not lost', async () => {
    const j = await SessionEventJournal.open(filePath);
    const epoch = j.epoch;
    fsMock.appendPrefixBytes = 10;
    try {
      j.append(j.nextSeq(), envelope(1));

      const deadline = Date.now() + 5000;
      let content = '';
      while (Date.now() < deadline) {
        content = await readFile(filePath, 'utf8').catch(() => '');
        if (content.includes('"seq":1')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const entries = await j.readSince(0, 100);
      expect(entries.map((entry) => entry.seq)).toEqual([1]);

      const reopened = await SessionEventJournal.open(filePath);
      expect(reopened.epoch).toBe(epoch);
      expect(reopened.seq).toBe(1);
      await reopened.close();
    } finally {
      await j.close();
    }
  });

  it('keeps the event pending when a repeated failure commits only one more byte', async () => {
    const j = await SessionEventJournal.open(filePath);
    try {
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      fsMock.appendPrefixes = [10, 1];
      j.append(j.nextSeq(), envelope(2));
      await j.flush();
      await j.flush();
      await j.flush();

      expect((await j.readSince(0, 100)).map((entry) => entry.seq)).toEqual([1, 2]);
    } finally {
      await j.close();
    }
  });

  it('preserves events when a boundary stat fails before a partial append', async () => {
    const j = await SessionEventJournal.open(filePath);
    try {
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      fsMock.statFailures = 1;
      fsMock.appendPrefixBytes = 10;
      j.append(j.nextSeq(), envelope(2));
      await j.flush();
      await j.flush();
      await j.flush();
      await j.close();

      const reopened = await SessionEventJournal.open(filePath);
      try {
        expect((await reopened.readSince(0, 2)).map((entry) => entry.seq)).toEqual([1, 2]);
      } finally {
        await reopened.close();
      }
    } finally {
      await j.close();
    }
  });

  it.each(['stat', 'range read'])('reconciles a committed append after a failed %s before replaying it', async (failure) => {
    const j = await SessionEventJournal.open(filePath);
    try {
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      const event = envelope(2);
      fsMock.appendPrefixBytes = Buffer.byteLength(
        JSON.stringify({ kind: 'event', seq: 2, envelope: event }) + '\n',
      );
      if (failure === 'stat') fsMock.statFailuresAfterAppend = 1;
      else fsMock.rangeReadFailures = 1;
      j.append(j.nextSeq(), event);
      j.append(j.nextSeq(), envelope(3));
      await j.flush();
      await j.flush();
      await j.close();

      const reopened = await SessionEventJournal.open(filePath);
      try {
        expect((await reopened.readSince(1, 2)).map((entry) => entry.seq)).toEqual([2, 3]);
      } finally {
        await reopened.close();
      }
    } finally {
      await j.close();
    }
  });

  it('does not replay an event committed without its final newline', async () => {
    const j = await SessionEventJournal.open(filePath);
    try {
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      const event = envelope(2);
      fsMock.appendPrefixBytes = Buffer.byteLength(
        JSON.stringify({ kind: 'event', seq: 2, envelope: event }),
      );
      j.append(j.nextSeq(), event);
      j.append(j.nextSeq(), envelope(3));
      await j.flush();
      await j.flush();
      await j.close();

      const reopened = await SessionEventJournal.open(filePath);
      try {
        expect((await reopened.readSince(1, 2)).map((entry) => entry.seq)).toEqual([2, 3]);
      } finally {
        await reopened.close();
      }
    } finally {
      await j.close();
    }
  });

  it.each(['stat', 'range read'])('preserves the original header through repeated %s failures and close', async (failure) => {
    const j = await SessionEventJournal.open(filePath);
    const epoch = j.epoch;
    try {
      fsMock.appendPrefixBytes = Number.MAX_SAFE_INTEGER;
      if (failure === 'stat') fsMock.statFailuresAfterAppend = 2;
      else fsMock.rangeReadFailures = 2;
      j.append(j.nextSeq(), envelope(1));
      j.append(j.nextSeq(), envelope(2));
      await j.flush();
      await j.flush();
      await j.close();

      const reopened = await SessionEventJournal.open(filePath);
      try {
        expect(reopened.epoch).toBe(epoch);
        expect((await reopened.readSince(0, 2)).map((entry) => entry.seq)).toEqual([1, 2]);
        const records = (await readFile(filePath, 'utf8')).trim().split('\n').map(
          (line) => JSON.parse(line) as { kind: string },
        );
        expect(records.filter((record) => record.kind === 'journal_header')).toHaveLength(1);
      } finally {
        await reopened.close();
      }
    } finally {
      await j.close();
    }
  });

  it.each(['stat', 'range read'])('keeps the file unchanged while a committed batch cannot be checked by %s', async (failure) => {
    const j = await SessionEventJournal.open(filePath);
    try {
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      fsMock.appendPrefixBytes = Number.MAX_SAFE_INTEGER;
      if (failure === 'stat') fsMock.statFailuresAfterAppend = 5;
      else fsMock.rangeReadFailures = 5;
      j.append(j.nextSeq(), envelope(2));
      await j.flush();
      const committed = await readFile(filePath);
      j.append(j.nextSeq(), envelope(3));
      await j.flush();
      await j.flush();
      expect(await readFile(filePath)).toEqual(committed);

      fsMock.statFailures = 0;
      fsMock.rangeReadFailures = 0;
      await j.close();
      const reopened = await SessionEventJournal.open(filePath);
      try {
        expect((await reopened.readSince(1, 2)).map((entry) => entry.seq)).toEqual([2, 3]);
      } finally {
        await reopened.close();
      }
    } finally {
      fsMock.statFailures = 0;
      fsMock.rangeReadFailures = 0;
      await j.close();
    }
  });

  it('finishes repeated partial UTF-8 appends before later events during close', async () => {
    const j = await SessionEventJournal.open(filePath);
    try {
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      const event = { ...envelope(2), payload: { text: '你好🙂' } };
      const bytes = Buffer.from(JSON.stringify({ kind: 'event', seq: 2, envelope: event }), 'utf8');
      fsMock.appendPrefixes = [bytes.indexOf(Buffer.from('你', 'utf8')) + 1, 1];
      j.append(j.nextSeq(), event);
      await j.flush();
      j.append(j.nextSeq(), envelope(3));
      await j.flush();
      await j.close();

      const reopened = await SessionEventJournal.open(filePath);
      try {
        const entries = await reopened.readSince(0, 3);
        expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
        expect(entries[1]?.envelope.payload).toEqual({ text: '你好🙂' });
        const records = (await readFile(filePath, 'utf8')).trim().split('\n').map(
          (line) => JSON.parse(line) as { kind: string },
        );
        expect(records.map((record) => record.kind)).toEqual(['journal_header', 'event', 'event', 'event']);
      } finally {
        await reopened.close();
      }
    } finally {
      await j.close();
    }
  });

  it('matches a healthy journal after an append fails at every byte boundary', async () => {
    const first = envelope(1);
    const second = { ...envelope(2), payload: { text: '你好🙂\n"尾巴' } };
    const third = envelope(3);
    const header = { kind: 'journal_header', version: 1, epoch: 'ep_example', created_at: 0 };
    const initial = JSON.stringify(header) + '\n' +
      JSON.stringify({ kind: 'event', seq: 1, envelope: first }) + '\n';
    await writeFile(filePath, initial);
    const healthy = await SessionEventJournal.open(filePath);
    healthy.append(healthy.nextSeq(), second);
    healthy.append(healthy.nextSeq(), third);
    await healthy.close();
    const expected = await readFile(filePath);
    expect(expected.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line))).toEqual([
      header,
      { kind: 'event', seq: 1, envelope: first },
      { kind: 'event', seq: 2, envelope: second },
      { kind: 'event', seq: 3, envelope: third },
    ]);
    const batchLength = Buffer.byteLength(JSON.stringify({ kind: 'event', seq: 2, envelope: second }) + '\n');

    for (let cut = 1; cut <= batchLength; cut++) {
      const cutPath = join(dir, `cut-${cut}.jsonl`);
      await writeFile(cutPath, initial);
      const j = await SessionEventJournal.open(cutPath);
      try {
        fsMock.partialAppends = [];
        fsMock.appendPrefixBytes = cut;
        j.append(j.nextSeq(), second);
        j.append(j.nextSeq(), third);
        await j.flush();
        await j.close();
        expect(fsMock.partialAppends, `byte boundary ${cut}`).toEqual([
          { requested: batchLength, written: cut },
        ]);
        expect(await readFile(cutPath), `byte boundary ${cut}`).toEqual(expected);

        const reopened = await SessionEventJournal.open(cutPath);
        try {
          expect(await reopened.readSince(0, 10), `byte boundary ${cut}`).toEqual([
            { seq: 1, envelope: first },
            { seq: 2, envelope: second },
            { seq: 3, envelope: third },
          ]);
          expect((await reopened.readSince(1, 2)).map((entry) => entry.seq), `byte boundary ${cut}`).toEqual([2, 3]);
        } finally {
          await reopened.close();
        }
      } finally {
        await j.close();
      }
    }
  });

  it('reconciles a partial write ending inside a multibyte UTF-8 character', async () => {
    const j = await SessionEventJournal.open(filePath);
    try {
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      const event = { ...envelope(2), payload: { text: '你好' } };
      const bytes = Buffer.from(JSON.stringify({ kind: 'event', seq: 2, envelope: event }), 'utf8');
      fsMock.appendPrefixBytes = bytes.indexOf(Buffer.from('你', 'utf8')) + 1;
      j.append(j.nextSeq(), event);
      await j.flush();
      await j.flush();

      const entries = await j.readSince(0, 100);
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
      expect(entries[1]?.envelope.payload).toEqual({ text: '你好' });
    } finally {
      await j.close();
    }
  });

  it('does not queue the incomplete header as an event when retrying its torn write', async () => {
    const j = await SessionEventJournal.open(filePath);
    try {
      fsMock.appendPrefixBytes = 10;
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      await j.flush();

      const parsed = (await readFile(filePath, 'utf8')).trim().split('\n').flatMap((line) => {
        try {
          return [JSON.parse(line) as { kind: string }];
        } catch {
          return [];
        }
      });
      expect(parsed.filter((line) => line.kind === 'journal_header')).toHaveLength(1);
      expect((await j.readSince(0, 100)).map((entry) => entry.seq)).toEqual([1]);
    } finally {
      await j.close();
    }
  });

  it('close retries the buffered events after an in-flight append fails', async () => {
    const j = await SessionEventJournal.open(filePath);
    j.append(j.nextSeq(), envelope(1));
    await j.flush();
    const callsBefore = fsMock.appendCalls;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    fsMock.appendGate = new Promise<void>((resolve) => { release = resolve; });
    fsMock.appendStarted = markStarted;
    fsMock.appendFailures = 1;
    j.append(j.nextSeq(), envelope(2));
    await started;
    const closing = j.close();
    release();
    await closing;

    expect(fsMock.appendCalls - callsBefore).toBe(2);
    const reopened = await SessionEventJournal.open(filePath);
    expect(reopened.seq).toBe(2);
    expect((await reopened.readSince(0, 100)).map((entry) => entry.seq)).toEqual([1, 2]);
    await reopened.close();
  });
});
