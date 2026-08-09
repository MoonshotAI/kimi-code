// test/wal.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WAL } from '../src/wal.js';
import { encodeFrame, FrameParser, CorruptFrameError, TYPE_SET, TYPE_DEL } from '../src/codec.js';
import { barrier } from './helpers.js';

const B = (s) => Buffer.from(s);

/** Drive one everysec background-sync tick deterministically (review #28):
 *  tests open the WAL with a huge syncIntervalMs so the real timer never
 *  fires, then call the extracted tick directly instead of racing sleeps
 *  against a 25ms interval. Returns the tick's settle promise (null when the
 *  tick was skipped — clean WAL / stacked / closed gate). */
const tick = (wal) => wal.backgroundTick();

function freshStats() {
  return {
    walBytesWritten: 0,
    walFsyncs: 0,
    walWriteErrors: 0,
    walFsyncErrors: 0,
    lastWalFsyncError: null,
    walQueuedBytes: 0,
    walMaxQueuedBytes: 0,
    walGroupCommits: 0,
    walGroupCommitFrames: 0,
  };
}

/** Condition-driven barrier (not a fixed sleep): poll until `cond` holds. */
async function waitFor(cond, what, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
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
    // Huge interval: the real timer never fires during the test — every tick
    // below is driven explicitly (see `tick`), so the fsync counts are exact
    // by construction, not by sleeping past a 25ms interval (review #28).
    const wal = new WAL(file, { fsyncPolicy: 'everysec', syncIntervalMs: 3_600_000, stats });
    await wal.open();

    // Idle ticks are skipped without an fsync.
    assert.equal(await tick(wal), null, 'an idle tick is skipped');
    assert.equal(await tick(wal), null);
    assert.equal(stats.walFsyncs, 0, 'idle everysec WAL must not fsync');

    // A write dirties the WAL: exactly one background fsync, then quiet again.
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v') }));
    await tick(wal);
    assert.equal(stats.walFsyncs, 1, 'one background fsync per dirty window');
    assert.equal(await tick(wal), null, 'clean again: the next tick is skipped');
    assert.equal(stats.walFsyncs, 1, 'fsync count does not grow once synced');

    // Another write: one more fsync, no burst.
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('k2'), value: B('v2') }));
    await tick(wal);
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
    // Explicitly driven ticks again (see `tick`): the failure and the retry
    // land exactly where the test puts them, no sleep windows (review #28).
    const wal = new WAL(file, { fsyncPolicy: 'everysec', syncIntervalMs: 3_600_000, stats });
    await wal.open();

    const fh = wal.fh;
    const orig = fh.sync.bind(fh);
    const boom = new Error('injected fsync failure');
    fh.sync = () => Promise.reject(boom);

    // Writes are acknowledged from the page cache: the failing background
    // fsync never rejects them.
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v') }));
    await tick(wal);
    assert.equal(stats.walFsyncErrors, 1, 'the failing tick records exactly one error');
    assert.equal(stats.lastWalFsyncError, boom, 'sticky error is observable');
    assert.equal(stats.walFsyncs, 0, 'no successful fsync meanwhile');

    // A failed sync must not clear the dirty mark: once the failure goes away
    // the next tick retries and the WAL converges to synced.
    fh.sync = orig;
    await tick(wal);
    assert.equal(stats.walFsyncs, 1, 'sync retried after the failure');
    assert.equal(stats.lastWalFsyncError, boom, 'sticky error is not cleared by a later success');
    assert.equal(wal.poison, null, 'a background sync failure must never poison the WAL');

    // Clean again: no more background fsyncs.
    assert.equal(await tick(wal), null, 'synced: the next tick is skipped');
    assert.equal(stats.walFsyncs, 1);
    await wal.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('close() waits for an in-flight background sync before closing the fd (review #13)', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    const wal = new WAL(file, { fsyncPolicy: 'everysec', syncIntervalMs: 3_600_000, stats });
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v') }));

    // Park the background sync inside fh.sync, then start close(): it must
    // drain the tracker instead of closing the fd under the flying sync.
    const fh = wal.fh;
    const gate = barrier(fh, 'sync', 1);
    const events: string[] = [];
    const origClose = fh.close.bind(fh);
    fh.close = async () => {
      events.push('fd-close');
      await origClose();
    };

    const bg = tick(wal);
    void bg!.then(() => events.push('bg-sync-settled'));
    await gate.entered; // the background sync is provably in flight

    const closing = wal.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    // close()'s only path to resolution goes through the parked tracker
    // drain, so no amount of yielding can settle it here.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(closed, false, 'close() must wait for the in-flight background sync');

    gate.release();
    await bg;
    await closing;
    assert.deepEqual(events, ['bg-sync-settled', 'fd-close'], 'the fd closes only after the background sync settled');
    assert.equal(stats.walFsyncs, 2, 'the background sync plus close() final sync');
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

test('appendLoc stamps frames with the id of the flush batch carrying them', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'no' });
    await wal.open();
    const a = wal.appendLoc(encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') }));
    const b = wal.appendLoc(encodeFrame({ type: TYPE_SET, key: B('b'), value: B('2') }));
    assert.equal(a.batchId, b.batchId, 'same-tick appends share the next batch id');
    assert.ok(a.batchId > 0);
    await Promise.all([a.done, b.done]);
    const c = wal.appendLoc(encodeFrame({ type: TYPE_SET, key: B('c'), value: B('3') }));
    assert.ok(c.batchId > a.batchId, 'the id advances once a batch drained');
    await c.done;
    await wal.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a failed flush poisons the WAL: WAL_POISONED rejections until truncate + refreshSize + clearPoison', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    const wal = new WAL(file, { fsyncPolicy: 'no', stats });
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('ok'), value: B('1') }));

    const fh = (wal as unknown as { fh: { writev: (...a: unknown[]) => Promise<unknown> } }).fh;
    const orig = fh.writev.bind(fh);
    // The first writev of the failing batch parks until a second frame is
    // queued behind it, then fails: the batch frame and the queued frame must
    // see different rejections.
    let releaseWritev!: () => void;
    const writevGate = new Promise<void>((r) => (releaseWritev = r));
    let calls = 0;
    fh.writev = async (...a: unknown[]) => {
      calls++;
      if (calls === 1) {
        await writevGate;
        throw new Error('injected writev failure');
      }
      return orig(...a);
    };

    const batchFrame = wal.append(encodeFrame({ type: TYPE_SET, key: B('bad'), value: B('x') }));
    await waitFor(() => calls === 1, 'the failing writev to be in flight');
    const queuedFrame = wal.append(encodeFrame({ type: TYPE_SET, key: B('queued'), value: B('y') }));
    releaseWritev();

    const order: string[] = [];
    await Promise.all([
      batchFrame.catch((e) => { order.push('batch'); throw e; }),
      queuedFrame.catch((e) => { order.push('queued'); throw e; }),
    ]).then(
      () => { throw new Error('expected both frames to reject'); },
      () => {},
    );
    assert.deepEqual(order, ['queued', 'batch'], 'queued frames reject first so group rollbacks unwind newest-first');
    assert.equal(stats.walWriteErrors, 1, 'writev-class failure counted');
    assert.equal(stats.walFsyncErrors, 0, 'not an fsync-class failure');

    const poison = wal.poison;
    assert.ok(poison, 'WAL is poisoned');
    assert.match(String(poison.error), /injected writev failure/);

    // While poisoned: appends reject WAL_POISONED (distinct from WAL_SEALED),
    // flush() throws, sync() is a silent no-op.
    await assert.rejects(
      wal.append(encodeFrame({ type: TYPE_SET, key: B('later'), value: B('z') })),
      (err) => {
        assert.equal((err as { code?: string }).code, 'WAL_POISONED');
        return true;
      },
    );
    await assert.rejects(wal.flush(), (err) => {
      assert.equal((err as { code?: string }).code, 'WAL_POISONED');
      return true;
    });
    await wal.sync();

    // In-place recovery (what MiniDb does): truncate the un-acked tail,
    // re-sync bookkeeping, clear the poison — then the write path resumes.
    const sizeBefore = (await fs.stat(file)).size;
    assert.equal(poison.failedAtOffset, sizeBefore, 'the injected writev threw before writing a byte');
    await fs.truncate(file, poison.failedAtOffset);
    await wal.refreshSize();
    wal.clearPoison();
    assert.equal(wal.poison, null);
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('c'), value: B('3') }));
    await wal.close();

    const frames = parseAll(await fs.readFile(file));
    assert.deepEqual(
      frames.map((f) => f.key.toString()),
      ['ok', 'c'],
      'rejected frames never reach the file',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an fsync failure with fsyncPolicy 'always' poisons the WAL and counts as walFsyncErrors", async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    const wal = new WAL(file, { fsyncPolicy: 'always', stats });
    await wal.open();
    const fh = (wal as unknown as { fh: { sync: () => Promise<void> } }).fh;
    fh.sync = () => Promise.reject(new Error('injected fsync failure'));

    await assert.rejects(wal.append(encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v') })), /injected fsync failure/);
    assert.equal(stats.walFsyncErrors, 1, 'fsync-class failure counted by sync() itself');
    assert.equal(stats.walWriteErrors, 0, 'not a writev-class failure');
    assert.ok(wal.poison, 'an unacknowledged batch poisons even though its bytes landed');

    // A poisoned close() does not throw and skips the final flush/fsync.
    await wal.close();
    assert.equal((wal as unknown as { fh: unknown }).fh, null, 'the handle is still released');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
