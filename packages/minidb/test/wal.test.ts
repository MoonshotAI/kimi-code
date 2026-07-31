// test/wal.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WAL } from '../src/wal.js';
import { encodeFrame, FrameParser, CorruptFrameError, TYPE_SET, TYPE_DEL } from '../src/codec.js';

const B = (s) => Buffer.from(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshStats() {
  return {
    walBytesWritten: 0,
    walFsyncs: 0,
    walFsyncErrors: 0,
    lastWalFsyncError: null,
    walQueuedBytes: 0,
    walMaxQueuedBytes: 0,
    walGroupCommits: 0,
    walGroupCommitFrames: 0,
  };
}

async function tmpWalPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-'));
  return { dir, file: path.join(dir, 'db.wal') };
}

function parseAll(buf) {
  return [...new FrameParser().feed(buf)];
}

test('append then read back preserves frames and order', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'everysec' });
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') }));
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('b'), value: B('2') }));
    await wal.append(encodeFrame({ type: TYPE_DEL, key: B('a') }));
    await wal.close();

    const frames = parseAll(await fs.readFile(file));
    assert.equal(frames.length, 3);
    assert.equal(frames[0].key.toString(), 'a');
    assert.equal(frames[1].key.toString(), 'b');
    assert.equal(frames[2].type, TYPE_DEL);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('group commit: many concurrent appends all land in order', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'no' });
    await wal.open();
    const N = 1000;
    const ops = [];
    for (let i = 0; i < N; i++) {
      ops.push(wal.append(encodeFrame({ type: TYPE_SET, key: B(`k${i}`), value: B(`${i}`) })));
    }
    await Promise.all(ops);
    await wal.close();

    const frames = parseAll(await fs.readFile(file));
    assert.equal(frames.length, N);
    // Spot-check ordering.
    assert.equal(frames[0].key.toString(), 'k0');
    assert.equal(frames[N - 1].key.toString(), `k${N - 1}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("fsyncPolicy 'always' works", async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'always' });
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('durable'), value: B('yes') }));
    await wal.close();
    const frames = parseAll(await fs.readFile(file));
    assert.equal(frames[0].key.toString(), 'durable');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('recovery truncates a torn/corrupt tail at the error offset', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'no' });
    await wal.open();
    const N = 50;
    for (let i = 0; i < N; i++) {
      await wal.append(encodeFrame({ type: TYPE_SET, key: B(`key${i}`), value: B('v') }));
    }
    await wal.close();

    const validSize = (await fs.stat(file)).size;
    // Simulate a crash that left a half-written frame at the end.
    const partial = encodeFrame({ type: TYPE_SET, key: B('torn'), value: B('x'.repeat(100)) }).subarray(0, 13);
    await fs.appendFile(file, partial);

    const buf = await fs.readFile(file);
    const parser = new FrameParser();
    const frames = [];
    let err = null;
    try {
      for (const f of parser.feed(buf)) frames.push(f);
      parser.finish();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof CorruptFrameError, 'expected a corrupt-frame error');
    assert.equal(err.offset, validSize, 'error offset should equal end of valid data');
    assert.equal(frames.length, N, 'all valid frames before the tail are recovered');

    // Truncate at the error offset and verify the file is clean again.
    await fs.truncate(file, err.offset);
    const after = parseAll(await fs.readFile(file));
    assert.equal(after.length, N);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('seal(): rejects new appends with WAL_SEALED, queued frames stay flushable', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'no' });
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') }));
    wal.seal();
    wal.seal(); // idempotent
    await assert.rejects(wal.append(encodeFrame({ type: TYPE_SET, key: B('b'), value: B('2') })), (err) => {
      assert.equal(err.code, 'WAL_SEALED');
      return true;
    });
    await wal.close(); // flushes the pre-seal frame
    const frames = parseAll(await fs.readFile(file));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].key.toString(), 'a');
    // after close the legacy "WAL is closed" rejection is preserved
    await assert.rejects(wal.append(encodeFrame({ type: TYPE_SET, key: B('c'), value: B('3') })), /WAL is closed/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("everysec: idle WAL performs zero background fsyncs; only dirty intervals sync", async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    const wal = new WAL(file, { fsyncPolicy: 'everysec', syncIntervalMs: 25, stats });
    await wal.open();

    // ~5 intervals with no writes: not a single fsync.
    await sleep(120);
    assert.equal(stats.walFsyncs, 0, 'idle everysec WAL must not fsync');

    // A write dirties the WAL: exactly one background fsync, then quiet again.
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v') }));
    await sleep(120);
    assert.equal(stats.walFsyncs, 1, 'one background fsync per dirty interval');
    await sleep(120);
    assert.equal(stats.walFsyncs, 1, 'fsync count does not grow once synced');

    // Another write: one more fsync, no burst.
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('k2'), value: B('v2') }));
    await sleep(120);
    assert.equal(stats.walFsyncs, 2);

    // close() keeps its unconditional final sync even though the WAL is clean.
    await wal.close();
    assert.equal(stats.walFsyncs, 3, 'close() always performs the final sync');
    assert.equal(stats.walFsyncErrors, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('close() performs a final fsync even when there were no writes at all', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    const wal = new WAL(file, { fsyncPolicy: 'everysec', syncIntervalMs: 25, stats });
    await wal.open();
    await wal.close();
    assert.equal(stats.walFsyncs, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('background sync failure is recorded but neither rejects writes nor clears dirty', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    const wal = new WAL(file, { fsyncPolicy: 'everysec', syncIntervalMs: 25, stats });
    await wal.open();

    const fh = (wal as unknown as { fh: { sync: () => Promise<void> } }).fh;
    const orig = fh.sync.bind(fh);
    const boom = new Error('injected fsync failure');
    fh.sync = () => Promise.reject(boom);

    // Writes are acknowledged from the page cache: the failing background
    // fsync never rejects them.
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v') }));
    await sleep(120);
    assert.ok(stats.walFsyncErrors >= 1, `expected fsync errors, got ${stats.walFsyncErrors}`);
    assert.equal(stats.lastWalFsyncError, boom, 'sticky error is observable');
    assert.equal(stats.walFsyncs, 0, 'no successful fsync meanwhile');

    // A failed sync must not clear the dirty mark: once the failure goes away
    // the next tick retries and the WAL converges to synced.
    fh.sync = orig;
    await sleep(120);
    assert.ok(stats.walFsyncs >= 1, 'sync retried after the failure');
    assert.equal(stats.lastWalFsyncError, boom, 'sticky error is not cleared by a later success');

    // Clean again: no more background fsyncs.
    const n = stats.walFsyncs;
    await sleep(120);
    assert.equal(stats.walFsyncs, n);
    await wal.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('queue depth and group-commit counters track the append buffer', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    const wal = new WAL(file, { fsyncPolicy: 'no', stats });
    await wal.open();

    // Sequential appends: each lands in its own group commit.
    for (let i = 0; i < 5; i++) {
      await wal.append(encodeFrame({ type: TYPE_SET, key: B(`s${i}`), value: B('v') }));
    }
    assert.equal(stats.walGroupCommits, 5);
    assert.equal(stats.walGroupCommitFrames, 5);
    assert.equal(stats.walQueuedBytes, 0, 'queue drains after each flush');

    // Concurrent appends coalesce: fewer commits than frames.
    const N = 200;
    const ops = [];
    for (let i = 0; i < N; i++) {
      ops.push(wal.append(encodeFrame({ type: TYPE_SET, key: B(`c${i}`), value: B('v') })));
    }
    await Promise.all(ops);
    assert.equal(stats.walGroupCommitFrames, 5 + N);
    assert.ok(stats.walGroupCommits < 5 + N, `expected coalescing, got ${stats.walGroupCommits} commits`);
    assert.ok(stats.walMaxQueuedBytes > 0, 'high-water mark recorded the burst');
    assert.equal(stats.walQueuedBytes, 0);
    await wal.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
