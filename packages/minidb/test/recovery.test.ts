// test/recovery.test.js
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';
import { HEADER_SIZE, CRC_SIZE, encodeFrame, TYPE_SET } from '../src/codec.js';

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
});

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-recover-'));
}

// Each record: key='kN'(2B), value='vN'(2B), no meta -> 22+2+2+0+4 = 30 bytes
const FRAME = HEADER_SIZE + 2 + 2 + 0 + CRC_SIZE;

async function writeFive(dir) {
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'always', autoCompact: false });
  for (let i = 0; i < 5; i++) await db.set(`k${i}`, `v${i}`);
  await db.close();
}

test('resync: a single corrupt frame mid-file only loses that frame', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    const buf = await fs.readFile(walPath);
    assert.equal(buf.length, FRAME * 5);

    // Corrupt k2's value (frame at offset 2*FRAME; value starts after header+key).
    buf[2 * FRAME + HEADER_SIZE + 2] ^= 0xff;
    await fs.writeFile(walPath, buf);

    const db = await MiniDb.open({ dir, valueCodec: 'string', recovery: 'resync' });
    assert.equal(db.recoveryInfo.corruptRanges.length, 1);
    assert.deepEqual(db.recoveryInfo.corruptRanges[0], [2 * FRAME, 3 * FRAME]);
    assert.equal(db.recoveryInfo.lostBytes, FRAME);

    // k2 lost, everything else recovered.
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get('k1'), 'v1');
    assert.equal(db.get('k2'), undefined);
    assert.equal(db.get('k3'), 'v3');
    assert.equal(db.get('k4'), 'v4');
    assert.equal(db.size, 4);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resync: multiple corrupt frames are each skipped', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    const buf = await fs.readFile(walPath);
    buf[1 * FRAME + HEADER_SIZE + 2] ^= 0xff; // k1
    buf[3 * FRAME + HEADER_SIZE + 2] ^= 0xff; // k3
    await fs.writeFile(walPath, buf);

    const db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.recoveryInfo.corruptRanges.length, 2);
    assert.deepEqual(
      [...new Set(['k0', 'k1', 'k2', 'k3', 'k4'].filter((k) => db.get(k) !== undefined))].sort(),
      ['k0', 'k2', 'k4'],
    );
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resync: torn tail is still truncated', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    const valid = await fs.readFile(walPath);
    // append a half-written frame
    await fs.appendFile(walPath, valid.subarray(0, 11));

    const db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.recoveryInfo.truncatedWal, true);
    assert.equal(db.size, 5);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('strict mode truncates at the first bad frame', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    const buf = await fs.readFile(walPath);
    buf[2 * FRAME + HEADER_SIZE + 2] ^= 0xff; // corrupt k2
    await fs.writeFile(walPath, buf);

    const db = await MiniDb.open({ dir, valueCodec: 'string', recovery: 'strict' });
    // strict recovers k0,k1 then stops at k2; k3,k4 are NOT recovered.
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get('k1'), 'v1');
    assert.equal(db.size, 2);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// catchUpFromWal: a read-only replica applies only the WAL frames appended
// after its watermark; the result must be identical to a from-scratch replay
// (store, dt, compound, secondary, unique and text indexes alike).
for (const valueMode of ['memory', 'disk'] as const) {
  test(`catchUpFromWal (${valueMode}): mixed tail applies identically to a full reopen`, { timeout: 60_000 }, async () => {
    const dir = await tmpDir();
    try {
      const doc = (i: number) => ({ n: i, c: `c${i % 7}`, u: `u${i}`, t: `alpha beta w${i % 13}` });
      const writer = await MiniDb.open<Record<string, unknown>>({
        dir,
        valueCodec: 'json',
        valueMode,
        fsyncPolicy: 'no',
        autoCompact: false,
      });
      await writer.createIndex('c', { field: 'c' });
      await writer.createIndex('n', { field: 'n', type: 'range' });
      await writer.createIndex('u', { field: 'u', unique: true });
      await writer.createTextIndex('t', { fields: ['t'] });
      await writer.createCompoundIndex('cg', { groupBy: 'c', orderBy: 'n' });
      for (let i = 0; i < 2000; i++) await writer.set(`pre:${i}`, doc(i), { dt: { created: 1700000000000 + i } });

      const reader = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', valueMode, readOnly: true });
      const ri = reader.recoveryInfo!;
      assert.ok(ri.walScanEnd > 0);
      assert.ok(ri.walIno !== 0);

      // Mixed storm: updates, new sets, dels, one BATCH frame, short/long TTL,
      // dt-only change. 500 + 500 + 300 + 1 + 2 = 1303 appended frames.
      for (let i = 1500; i < 2000; i++) {
        await writer.set(`pre:${i}`, { ...doc(i), n: i * 10, t: `alpha changed w${i % 13}` }, { dt: { created: 1700000009000 + i } });
      }
      for (let i = 0; i < 500; i++) await writer.set(`s:${i}`, { ...doc(i), u: `us${i}` }, { dt: { created: 1700001000000 + i } });
      for (let i = 0; i < 1500; i += 5) await writer.del(`pre:${i}`);
      await writer.batch([
        { op: 'set', key: 's:b1', value: doc(9001), dt: { created: 1700002000000 } },
        { op: 'set', key: 's:b2', value: { ...doc(9002), t: 'alpha batch' } },
        { op: 'del', key: 's:b1' },
      ]);
      await writer.set('s:short', doc(9100), { ttl: 1 });
      await writer.set('s:long', doc(9101), { ttl: 3_600_000 });

      const res = await reader.catchUpFromWal(ri.walScanEnd);
      assert.ok(res, 'clean watermark must catch up');
      assert.equal(res.appliedFrames, 1303);
      assert.ok(res.offset > ri.walScanEnd);

      // Reference: a full from-scratch replay of the same files.
      const ref = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', valueMode, readOnly: true });
      const sortByKey = (a: { key: string }, b: { key: string }): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      assert.equal(reader.size, ref.size);
      assert.deepEqual(reader.scan(), ref.scan());
      assert.deepEqual(reader.dtColumns(), ref.dtColumns());
      assert.deepEqual(reader.findEq('c', 'c3').sort(sortByKey), ref.findEq('c', 'c3').sort(sortByKey));
      assert.deepEqual(reader.findEq('u', 'u1700'), ref.findEq('u', 'u1700'));
      assert.deepEqual(
        reader.findRange('n', { min: 100, max: 500 }).sort(sortByKey),
        ref.findRange('n', { min: 100, max: 500 }).sort(sortByKey),
      );
      assert.deepEqual(reader.dtRange('created', { gte: 1700000009000, limit: 20 }), ref.dtRange('created', { gte: 1700000009000, limit: 20 }));
      assert.deepEqual(reader.compoundRange('cg', 'c2', { limit: 25 }), ref.compoundRange('cg', 'c2', { limit: 25 }));
      assert.deepEqual(reader.search('t', 'alpha'), ref.search('t', 'alpha'));
      assert.deepEqual(reader.search('t', 'changed'), ref.search('t', 'changed'));
      assert.deepEqual(reader.search('t', 'batch'), ref.search('t', 'batch'));
      assert.equal(reader.get('s:short'), undefined);
      assert.equal(ref.get('s:short'), undefined);
      assert.deepEqual(reader.get('s:long'), ref.get('s:long'));

      // No new writes: catch-up is a cheap no-op at the same offset.
      assert.deepEqual(await reader.catchUpFromWal(res.offset), { offset: res.offset, appliedFrames: 0 });
      // Not a frame boundary (byte 3 of the first frame's header: flags=0).
      assert.equal(await reader.catchUpFromWal(3), null);

      await ref.close();
      await reader.close();
      await writer.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('catchUpFromWal: a torn tail pauses the catch-up and a later call completes it', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    for (let i = 0; i < 10; i++) await writer.set(`k${i}`, { n: i });
    const reader = await MiniDb.open({ dir, valueCodec: 'json', readOnly: true });
    const ri = reader.recoveryInfo!;

    // Simulate a writer mid-writev: only a PREFIX of the next frame is on
    // disk. The catch-up must stop at the last fully-valid frame without
    // erroring, and must not advance the watermark past it.
    const frame = encodeFrame({
      type: TYPE_SET,
      key: Buffer.from('torn', 'utf8'),
      value: Buffer.from(JSON.stringify({ n: 99 }), 'utf8'),
    });
    const half = Math.floor(frame.length / 2);
    const walPath = path.join(dir, 'db.wal');
    await fs.appendFile(walPath, frame.subarray(0, half));
    const paused = await reader.catchUpFromWal(ri.walScanEnd);
    assert.deepEqual(paused, { offset: ri.walScanEnd, appliedFrames: 0 });
    assert.equal(reader.get('torn'), undefined);

    // The writev lands: the tail's CRC now validates and the frame applies.
    await fs.appendFile(walPath, frame.subarray(half));
    const done = await reader.catchUpFromWal(ri.walScanEnd);
    assert.deepEqual(done, { offset: ri.walScanEnd + frame.length, appliedFrames: 1 });
    assert.deepEqual(reader.get('torn'), { n: 99 });

    await reader.close();
    await writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('catchUpFromWal: a compaction rotation swaps the WAL inode and the catch-up declines', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    for (let i = 0; i < 100; i++) await writer.set(`k${i}`, { n: i });
    const reader = await MiniDb.open({ dir, valueCodec: 'json', readOnly: true });
    const ri = reader.recoveryInfo!;
    assert.ok(ri.walScanEnd > 0);

    // Rotation: compaction swaps db.snapshot/db.wal in two renames, so the
    // WAL the reader anchored on is gone — incremental catch-up must decline
    // (null) and leave the reopen decision to the caller.
    await writer.compact();
    assert.equal(await reader.catchUpFromWal(ri.walScanEnd), null);

    // A fresh read-only reopen sees every write, including post-rotation ones.
    await writer.set('post-rotation', { n: 101 });
    await reader.close();
    const reopened = await MiniDb.open({ dir, valueCodec: 'json', readOnly: true });
    assert.equal(reopened.size, 101);
    assert.deepEqual(reopened.get('post-rotation'), { n: 101 });
    await reopened.close();
    await writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('catchUpFromWal: concurrent calls are serialized instead of interleaving mid-apply', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    for (let i = 0; i < 50; i++) await writer.set(`k${i}`, { n: i });
    const reader = await MiniDb.open({ dir, valueCodec: 'json', readOnly: true });
    const ri = reader.recoveryInfo!;
    for (let i = 50; i < 150; i++) await writer.set(`k${i}`, { n: i });

    // The sliced async apply yields to the event loop, so two overlapping
    // catch-ups at the same watermark would interleave op-by-op without the
    // per-instance chain. The second call runs after the first advanced the
    // watermark and declines (the caller then falls back to a reopen).
    const [first, second] = await Promise.all([
      reader.catchUpFromWal(ri.walScanEnd),
      reader.catchUpFromWal(ri.walScanEnd),
    ]);
    assert.ok(first && first.appliedFrames === 100);
    assert.equal(second, null);
    assert.equal(reader.size, 150);

    await reader.close();
    await writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('catchUpFromWal: a large tail applies in cooperative slices (event loop stays live)', { timeout: 60_000 }, async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    for (let i = 0; i < 100; i++) await writer.set(`pre:${i}`, { n: i, t: `alpha ${i}` });
    await writer.createTextIndex('t', { fields: ['t'] });
    const reader = await MiniDb.open({ dir, valueCodec: 'json', readOnly: true });
    const ri = reader.recoveryInfo!;
    // 8000 single-op frames: WAL_APPLY_OPS_PER_SLICE (512) alone forces ~15
    // yields mid-apply even when every op is cheap.
    for (let i = 0; i < 8000; i++) await writer.set(`s:${i}`, { n: i, t: `alpha beta ${i}` });

    // Count event-loop turns observed while the catch-up runs. The async
    // scan contributes about one (a sub-window file fills in one read); an
    // UNSLICED apply would add none, the sliced one adds one per 512 ops.
    let loopTurns = 0;
    let catchUpDone = false;
    const probe = (async () => {
      for (;;) {
        await new Promise((r) => setImmediate(r));
        if (catchUpDone) return;
        loopTurns++;
      }
    })();
    const res = await reader.catchUpFromWal(ri.walScanEnd);
    catchUpDone = true;
    await probe;

    assert.ok(res && res.appliedFrames === 8000);
    assert.ok(loopTurns >= 3, `expected the sliced apply to yield repeatedly, observed ${loopTurns} loop turn(s)`);
    assert.equal(reader.size, 8100);
    assert.ok(reader.search('t', 'beta').length > 0);

    await reader.close();
    await writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- generation pairing (stat-pairing; review #15) --------------------------
//
// Fault-injection tests for recover()'s snapshot/WAL generation pairing. The
// injections run INSIDE mocked fs calls, which makes them deterministic: they
// fire exactly at recover's forensic points (the post-scan path re-stat, the
// ValueReader attach) — no sleeps, no races. The mocks affect only DYNAMIC
// imports made after them (vi.resetModules), so the statically-imported
// MiniDb above keeps the real fs for seeding and verification.

type FsSyncModule = typeof import('node:fs');

/** Mock node:fs so statSync/openSync on the db.wal path fire the given hook
 *  (with the call count) before delegating to the real module. Everything
 *  else passes through untouched. */
function mockFsSyncForWal(
  walPath: string,
  hooks: {
    onStatSync?: (call: number, real: FsSyncModule) => void;
    onOpenSync?: (call: number, real: FsSyncModule) => void;
  },
): void {
  let statCalls = 0;
  let openCalls = 0;
  vi.doMock('node:fs', async () => {
    const real = await vi.importActual<FsSyncModule>('node:fs');
    const statSync = ((p: unknown, ...args: unknown[]) => {
      if (String(p) === walPath) hooks.onStatSync?.(++statCalls, real);
      return (real.statSync as (...a: unknown[]) => unknown)(p, ...args);
    }) as typeof real.statSync;
    const openSync = ((p: unknown, ...args: unknown[]) => {
      if (String(p) === walPath) hooks.onOpenSync?.(++openCalls, real);
      return (real.openSync as (...a: unknown[]) => unknown)(p, ...args);
    }) as typeof real.openSync;
    const mocked = { ...real, statSync, openSync };
    return { ...mocked, default: mocked };
  });
}

/** Atomically replace db.wal with an identical-content copy on a NEW inode —
 *  exactly what a compaction rotation's rename does. */
function swapWalInodeSync(real: FsSyncModule, walPath: string): void {
  real.copyFileSync(walPath, `${walPath}.swap`);
  real.renameSync(`${walPath}.swap`, walPath);
}

test('generation pairing: a rotation-like WAL inode swap at the post-scan forensics is retried to a consistent read-only open', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open<string>({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false, indexGenerations: false });
    for (let i = 0; i < 50; i++) await writer.set(`k${i}`, `v${i}`);

    // The injection fires when recover takes its post-scan path stat of
    // db.wal (forensics round 2): the WAL is swapped for a new inode between
    // the scan and the verification — precisely the rotation race the
    // pairing exists to catch. One-shot: the retried pass sees a stable pair.
    const walPath = path.join(dir, 'db.wal');
    let swaps = 0;
    mockFsSyncForWal(walPath, {
      onStatSync: (call, real) => {
        if (call === 1) {
          swapWalInodeSync(real, walPath);
          swaps++;
        }
      },
    });
    const { MiniDb: MockedMiniDb } = await import('../src/index.js');
    const reader = await MockedMiniDb.open<string>({ dir, valueCodec: 'string', readOnly: true, indexGenerations: false });
    assert.equal(swaps, 1);
    assert.equal(reader.recoveryInfo!.generationRetries, 1, 'the swapped inode forced exactly one retry');
    assert.equal(reader.size, 50);
    assert.equal(reader.get('k0'), 'v0');
    assert.equal(reader.get('k49'), 'v49');
    await reader.close();
    await writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generation pairing: churn beyond the retry budget throws RECOVERY_GENERATION_CHURN and leaves no partial state', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open<string>({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false, indexGenerations: false });
    for (let i = 0; i < 50; i++) await writer.set(`k${i}`, `v${i}`);
    await writer.close();

    // EVERY pass's post-scan stat swaps the WAL inode: recovery can never
    // pair a consistent set and must exhaust its bounded retries (1 + 4).
    const walPath = path.join(dir, 'db.wal');
    let swaps = 0;
    mockFsSyncForWal(walPath, {
      onStatSync: (_call, real) => {
        swapWalInodeSync(real, walPath);
        swaps++;
      },
    });
    const { MiniDb: MockedMiniDb } = await import('../src/index.js');
    await assert.rejects(
      MockedMiniDb.open<string>({ dir, valueCodec: 'string', readOnly: true, indexGenerations: false }),
      (e: unknown) =>
        (e as { code?: string }).code === 'RECOVERY_GENERATION_CHURN' && (e as Error).name === 'RecoveryGenerationChurnError',
    );
    assert.equal(swaps, 5, 'one swap per pass: the initial attempt plus 4 retries');

    // No partial application state survived the failed open: the swaps
    // preserved content, and a clean open recovers every key.
    const db = await MiniDb.open<string>({ dir, valueCodec: 'string', readOnly: true });
    assert.equal(db.size, 50);
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get('k49'), 'v49');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generation pairing: append-only WAL growth between the forensic rounds does not trigger a retry', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open<string>({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false, indexGenerations: false });
    for (let i = 0; i < 50; i++) await writer.set(`k${i}`, `v${i}`);
    await writer.close();

    // A live writer's append landing between recover's scan and its post-scan
    // stat (same inode, size grew) is the safe staleness window — NOT a
    // generation switch — and must not cost a retry.
    const walPath = path.join(dir, 'db.wal');
    mockFsSyncForWal(walPath, {
      onStatSync: (call, real) => {
        if (call === 1) {
          real.appendFileSync(walPath, encodeFrame({ type: TYPE_SET, key: Buffer.from('late'), value: Buffer.from('z') }));
        }
      },
    });
    const { MiniDb: MockedMiniDb } = await import('../src/index.js');
    const reader = await MockedMiniDb.open<string>({ dir, valueCodec: 'string', readOnly: true, indexGenerations: false });
    assert.equal(reader.recoveryInfo!.generationRetries, 0, 'append-only growth must not be retried');
    assert.equal(reader.size, 50);
    // The late frame landed after the scan: outside the recovered view, to be
    // picked up by a later catch-up instead.
    assert.equal(reader.get('late'), undefined);
    assert.equal(reader.get('k49'), 'v49');
    await reader.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generation pairing (disk mode): a ValueReader attach to the wrong inode retries the whole recovery', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open<string>({ dir, valueCodec: 'string', valueMode: 'disk', fsyncPolicy: 'no', autoCompact: false });
    for (let i = 0; i < 50; i++) await writer.set(`k${i}`, `v${i}`);
    await writer.close();

    // The swap fires when the ValueReader opens db.wal to attach (the second
    // openSync: the first was recovery's scan) — after recovery's forensics
    // verified the old inode. The attach check must reject the mismatched
    // handle and retry the whole recovery against the new generation.
    const walPath = path.join(dir, 'db.wal');
    let swaps = 0;
    mockFsSyncForWal(walPath, {
      onOpenSync: (call, real) => {
        if (call === 2) {
          swapWalInodeSync(real, walPath);
          swaps++;
        }
      },
    });
    const { MiniDb: MockedMiniDb } = await import('../src/index.js');
    const reader = await MockedMiniDb.open<string>({ dir, valueCodec: 'string', valueMode: 'disk', readOnly: true, indexGenerations: false });
    assert.equal(swaps, 1);
    assert.equal(reader.recoveryInfo!.generationRetries, 1, 'the mismatched attach forced exactly one retry');
    // Every pointer reads back the right bytes through the correctly-attached
    // reader.
    assert.equal(reader.size, 50);
    for (let i = 0; i < 50; i++) assert.equal(reader.get(`k${i}`), `v${i}`);
    await reader.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generation pairing (disk mode): a failing ValueReader open() closes the partially attached reader (no fd leak)', async () => {
  const dir = await tmpDir();
  try {
    // Seed with a snapshot on disk so the attach opens (and would leak) the
    // snapshot fd before the WAL open throws.
    const writer = await MiniDb.open<string>({ dir, valueCodec: 'string', valueMode: 'disk', fsyncPolicy: 'no', autoCompact: false });
    for (let i = 0; i < 50; i++) await writer.set(`k${i}`, `v${i}`);
    await writer.compact();
    await writer.close();

    // The throw fires when the ValueReader opens db.wal to attach (the second
    // openSync on the WAL path: the first was recovery's scan) — after the
    // snapshot fd is already open. The reader is never published, so only the
    // callback itself can close it.
    const walPath = path.join(dir, 'db.wal');
    mockFsSyncForWal(walPath, {
      onOpenSync: (call) => {
        if (call === 2) throw Object.assign(new Error('injected wal open failure'), { code: 'EMFILE' });
      },
    });
    const { MiniDb: MockedMiniDb } = await import('../src/index.js');
    const { ValueReader } = await import('../src/value-reader.js');
    let closes = 0;
    const origClose = ValueReader.prototype.close;
    ValueReader.prototype.close = function (this: InstanceType<typeof ValueReader>): void {
      closes++;
      origClose.call(this);
    };
    try {
      await assert.rejects(
        MockedMiniDb.open<string>({ dir, valueCodec: 'string', valueMode: 'disk', readOnly: true, indexGenerations: false }),
        (e: unknown) => (e as { code?: string }).code === 'EMFILE',
      );
    } finally {
      ValueReader.prototype.close = origClose;
    }
    assert.equal(closes, 1, 'the partially attached ValueReader was closed instead of leaking its snapshot fd');

    // The injected failure was transient: a clean open recovers everything.
    const db = await MiniDb.open<string>({ dir, valueCodec: 'string', valueMode: 'disk', readOnly: true });
    assert.equal(db.size, 50);
    assert.equal(db.get('k49'), 'v49');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generation pairing: a stable writer costs a read-only open zero retries', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open<string>({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false, indexGenerations: false });
    for (let i = 0; i < 20; i++) await writer.set(`k${i}`, `v${i}`);

    const reader = await MiniDb.open<string>({ dir, valueCodec: 'string', readOnly: true });
    assert.equal(reader.recoveryInfo!.generationRetries, 0);
    assert.equal(reader.size, 20);
    await reader.close();
    await writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a read-only open racing a compaction rotation always recovers one complete generation', { timeout: 30_000 }, async () => {
  // Deterministic interleave, no sleeps: the writer's rotation is parked
  // BETWEEN its two renames (the new snapshot is already in place, the old
  // full WAL is still at db.wal) while the read-only open runs its whole
  // recovery inside that window. The only consistent outcomes are one
  // complete generation or the other — never a mix.
  let armed = true;
  let parked!: () => void;
  let release!: () => void;
  const parkedPromise = new Promise<void>((r) => (parked = r));
  const gate = new Promise<void>((r) => (release = r));
  const rename = async (src: PathLike, dst: PathLike): Promise<void> => {
    if (armed && String(src).endsWith('db.wal.tmp') && String(dst).endsWith('db.wal')) {
      armed = false;
      parked();
      await gate;
    }
    return fs.rename(src, dst);
  };
  const mocked = { ...fs, rename };
  vi.doMock('node:fs/promises', () => ({ ...mocked, default: mocked }));

  const { MiniDb: MockedMiniDb } = await import('../src/index.js');
  const dir = await tmpDir();
  try {
    const writer = await MockedMiniDb.open<string>({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false, indexGenerations: false });
    const N = 100;
    for (let i = 0; i < N; i++) await writer.set(`k${i}`, `v${i}`);

    const compactPromise = writer.compact();
    await parkedPromise; // the rotation is now parked between the two renames

    // The reader opens in the mid-rotation window: new snapshot + old full
    // WAL is a complete, consistent pairing (the replay is idempotent), and
    // the stable window costs no retry.
    const midReader = await MockedMiniDb.open<string>({ dir, valueCodec: 'string', readOnly: true, indexGenerations: false });
    assert.equal(midReader.size, N);
    assert.equal(midReader.get('k0'), 'v0');
    assert.equal(midReader.get(`k${N - 1}`), `v${N - 1}`);
    assert.equal(midReader.recoveryInfo!.generationRetries, 0);
    await midReader.close();

    release();
    await compactPromise;

    // After the rotation, a fresh open recovers the new generation, complete.
    const postReader = await MockedMiniDb.open<string>({ dir, valueCodec: 'string', readOnly: true, indexGenerations: false });
    assert.equal(postReader.size, N);
    assert.equal(postReader.get('k0'), 'v0');
    assert.equal(postReader.get(`k${N - 1}`), `v${N - 1}`);
    assert.equal(postReader.recoveryInfo!.generationRetries, 0);
    await postReader.close();
    await writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- stage 6: async frame scanner -------------------------------------------

import { scanFrameRefsFd, scanFrameRefsFdAsync, MAGIC, DEFAULT_RESYNC_CANDIDATE_BUDGET } from '../src/codec.js';
import fsSync from 'node:fs';

test('async scanner: results match the sync scanner on clean and corrupt files', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    // Add corruption: damage k2's frame, then append two valid frames after it.
    const buf = await fs.readFile(walPath);
    buf[2 * FRAME + HEADER_SIZE + 2] ^= 0xff;
    const extra = Buffer.concat([
      encodeFrame({ type: TYPE_SET, key: Buffer.from('k5'), value: Buffer.from('v5') }),
      encodeFrame({ type: TYPE_SET, key: Buffer.from('k6'), value: Buffer.from('v6') }),
    ]);
    await fs.writeFile(walPath, Buffer.concat([buf, extra]));

    for (const mode of ['resync', 'strict'] as const) {
      const fd = fsSync.openSync(walPath, 'r');
      let syncRes;
      try {
        syncRes = scanFrameRefsFd(fd, { onCorrupt: mode });
      } finally {
        fsSync.closeSync(fd);
      }
      const fd2 = fsSync.openSync(walPath, 'r');
      let asyncRes;
      try {
        asyncRes = await scanFrameRefsFdAsync(fd2, { onCorrupt: mode });
      } finally {
        fsSync.closeSync(fd2);
      }
      assert.deepEqual(
        asyncRes.frames.map((f) => [f.type, f.frameOff, f.valueOff, f.valLen, f.frameLen, f.key.toString('binary')]),
        syncRes.frames.map((f) => [f.type, f.frameOff, f.valueOff, f.valLen, f.frameLen, f.key.toString('binary')]),
      );
      assert.deepEqual(asyncRes.corruptRanges, syncRes.corruptRanges);
      assert.equal(asyncRes.eofOffset, syncRes.eofOffset);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('async scanner: frames larger than the read window scan identically (chunked fallback)', async () => {
  const dir = await tmpDir();
  try {
    // One 8 MiB value (exceeds the 4 MiB async window) between two small frames.
    const frames = Buffer.concat([
      encodeFrame({ type: TYPE_SET, key: Buffer.from('a'), value: Buffer.from('small-a') }),
      encodeFrame({ type: TYPE_SET, key: Buffer.from('big'), value: Buffer.alloc(8 << 20, 0x61) }),
      encodeFrame({ type: TYPE_SET, key: Buffer.from('z'), value: Buffer.from('small-z') }),
    ]);
    const walPath = path.join(dir, 'db.wal');
    await fs.writeFile(walPath, frames);
    const fd = fsSync.openSync(walPath, 'r');
    let syncRes;
    try {
      syncRes = scanFrameRefsFd(fd, {});
    } finally {
      fsSync.closeSync(fd);
    }
    const fd2 = fsSync.openSync(walPath, 'r');
    let asyncRes;
    try {
      asyncRes = await scanFrameRefsFdAsync(fd2, {});
    } finally {
      fsSync.closeSync(fd2);
    }
    assert.equal(asyncRes.frames.length, 3);
    assert.deepEqual(
      asyncRes.frames.map((f) => [f.frameOff, f.valLen, f.frameLen]),
      syncRes.frames.map((f) => [f.frameOff, f.valLen, f.frameLen]),
    );
    assert.equal(asyncRes.eofOffset, syncRes.eofOffset);
    assert.deepEqual(asyncRes.corruptRanges, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('async scanner: cancellation aborts the scan with AbortError', async () => {
  const dir = await tmpDir();
  try {
    // A file large enough to span many yield points.
    const big = Buffer.concat(
      Array.from({ length: 200 }, (_, i) => encodeFrame({ type: TYPE_SET, key: Buffer.from(`k${i}`), value: Buffer.alloc(1 << 16, i & 0xff) })),
    );
    const walPath = path.join(dir, 'db.wal');
    await fs.writeFile(walPath, big);
    const fd = fsSync.openSync(walPath, 'r');
    try {
      const controller = new AbortController();
      controller.abort(); // pre-aborted: the scan must not even start
      await assert.rejects(scanFrameRefsFdAsync(fd, { signal: controller.signal }), (e) => (e as Error).name === 'AbortError');
    } finally {
      fsSync.closeSync(fd);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('async scanner: resync candidate budget bounds fake-magic storms', async () => {
  const dir = await tmpDir();
  try {
    // One valid frame, then a long storm of fake magic bytes (each looks like
    // a resync candidate but never validates), then a valid frame that must
    // be surrendered to the budget.
    const head = encodeFrame({ type: TYPE_SET, key: Buffer.from('head'), value: Buffer.from('v') });
    const storm = Buffer.alloc(DEFAULT_RESYNC_CANDIDATE_BUDGET * 2 + 64);
    for (let i = 0; i < storm.length; i += 2) MAGIC.copy(storm, i);
    const tail = encodeFrame({ type: TYPE_SET, key: Buffer.from('tail'), value: Buffer.from('v') });
    const walPath = path.join(dir, 'db.wal');
    await fs.writeFile(walPath, Buffer.concat([head, storm, tail]));

    const fd = fsSync.openSync(walPath, 'r');
    let res;
    try {
      const t0 = performance.now();
      res = await scanFrameRefsFdAsync(fd, { onCorrupt: 'resync', maxResyncCandidates: 128 });
      // The budget caps the work: 128 candidate validations, not 65k+.
      assert.ok(performance.now() - t0 < 10_000, 'budget-bounded resync must be fast');
    } finally {
      fsSync.closeSync(fd);
    }
    // Only the head frame was recovered; the whole storm+tail is one corrupt
    // range (the strict outcome for the tail), and the scan stopped there.
    assert.equal(res.frames.length, 1);
    assert.equal(res.frames[0]!.key.toString(), 'head');
    assert.equal(res.corruptRanges.length, 1);
    assert.equal(res.corruptRanges[0]![0], head.length);
    assert.equal(res.eofOffset, head.length);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- phase 3: cooperative slicing of the recovered-op apply loops -----------

import { walApplySlicer, WAL_APPLY_OPS_PER_SLICE, WAL_APPLY_SLICE_MS } from '../src/recovery.js';

test('walApplySlicer trips on the op budget, then resets; the time budget trips independently', () => {
  const slice = walApplySlicer();
  for (let i = 1; i < WAL_APPLY_OPS_PER_SLICE; i++) assert.equal(slice(), false);
  assert.equal(slice(), true); // the op budget trips exactly at the cap
  assert.equal(slice(), false); // counters reset for the next slice
  // The time budget trips below the op cap once the slice ran long enough.
  const timed = walApplySlicer();
  assert.equal(timed(), false); // one op, well under the op cap
  const t0 = performance.now();
  while (performance.now() - t0 < WAL_APPLY_SLICE_MS + 5) {
    // busy-wait: keep this slice over its time budget with ops to spare
  }
  assert.equal(timed(), true);
});

test('a generation WAL delta of large batch frames replays every op through the sliced apply loop', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    db.genBuildKickMinIntervalMs = Number.POSITIVE_INFINITY; // exactly one explicit generation
    for (let base = 0; base < 2000; base += 500) {
      await db.batch(Array.from({ length: 500 }, (_, i) => ({ op: 'set' as const, key: `b${base + i}`, value: { n: base + i } })));
    }
    await db.rebuildGeneration();
    await db.close();

    // A WAL delta of batch frames past the checkpoint: thousands of primitive
    // ops in a handful of frames — frame-granular yielding could never slice
    // this; the op/time budgets can. Small values keep the delta far below
    // the close-time republish threshold.
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    const gen = db.getIndexGeneration()?.id;
    for (let base = 0; base < 3000; base += 500) {
      await db.batch(Array.from({ length: 500 }, (_, i) => ({ op: 'set' as const, key: `d${base + i}`, value: { n: base + i } })));
    }
    await db.close();
    assert.equal(db.getIndexGeneration()?.id, gen); // no close-time republish: the delta must be replayed

    db = await MiniDb.open({ dir, valueCodec: 'json', autoCompact: false });
    try {
      assert.ok(db.recoveryInfo?.indexGeneration);
      assert.equal(db.recoveryInfo?.walDeltaAppliedOps, 3000);
      assert.equal(db.size, 5000);
      assert.deepEqual(db.get('d0'), { n: 0 });
      assert.deepEqual(db.get('d2999'), { n: 2999 });
      assert.deepEqual(db.get('b1999'), { n: 1999 });
      const status = db.lifecycleStatus();
      assert.equal(status.state, 'ready');
      assert.deepEqual(status.path, ['no-generation', 'generation-load', 'wal-catch-up', 'ready']);
      assert.ok(status.phases.walApplyMs > 0);
    } finally {
      await db.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
