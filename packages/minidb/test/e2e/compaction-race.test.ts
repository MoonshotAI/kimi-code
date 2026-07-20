// test/e2e/compaction-race.test.js
//
// Stress the stop-the-world compaction guard: heavy concurrent writes while
// compaction is triggered frequently (both auto and manual) must not lose any
// write, must not throw, and must leave a recoverable database.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MiniDb } from '../../src/index.js';
import { tmpDir, rmrf } from './helpers/tmp.js';

test('compaction-race: concurrent writes + frequent compaction lose nothing', { timeout: 30_000 }, async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({
    dir,
    valueCodec: 'json',
    fsyncPolicy: 'no',
    compactThresholdBytes: 2048, // tiny -> compaction triggers a lot
  });
  const N = 1000;
  const written = new Map();
  try {
    const ops = [];
    for (let i = 0; i < N; i++) {
      const k = 'k' + i;
      const v = { i, pad: 'x'.repeat(30) };
      written.set(k, v);
      ops.push(db.set(k, v));
      if (i % 100 === 0) ops.push(db.compact().then(() => {})); // manual compaction, concurrent
    }
    await Promise.all(ops);
    if (db.compacting) await db._compactDone;

    for (const [k, v] of written) assert.deepEqual(db.get(k), v, `get(${k})`);
    assert.equal(db.size, N);
    const compactionsRan = db.stats.compactions;

    // recoverable + still correct
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json' });
    for (const [k, v] of written) assert.deepEqual(db.get(k), v, `reopen get(${k})`);
    assert.equal(db.size, N);
    assert.ok(compactionsRan >= 1, 'at least one compaction ran');
  } finally {
    await db.close().catch(() => {});
    await rmrf(dir);
  }
});

test('compaction-race: reads remain available during compaction', { timeout: 30_000 }, async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({
    dir,
    valueCodec: 'json',
    fsyncPolicy: 'no',
    compactThresholdBytes: 4096,
  });
  try {
    for (let i = 0; i < 200; i++) await db.set('k' + i, { i });
    // trigger compaction but don't await; reads should still work immediately
    const cp = db.compact();
    for (let i = 0; i < 200; i++) {
      const v = db.get('k' + i);
      assert.deepEqual(v, { i }, `read during compaction k${i}`);
    }
    await cp;
  } finally {
    await db.close().catch(() => {});
    await rmrf(dir);
  }
});

test('compaction-race: snapshot phase does not block writes', { timeout: 30_000 }, async () => {
  // A write issued while a large snapshot is being written must complete
  // BEFORE the whole compaction finishes — i.e. the snapshot phase is
  // non-blocking. writeSnapshot yields to the event loop every chunk, so the
  // write's WAL append is serviced in a yield gap, well ahead of the snapshot
  // completing. We race the first write against the compaction rather than
  // measuring absolute timing, so the assertion stays robust under CPU/IO load
  // (e.g. when the e2e files run concurrently).
  const dir = await tmpDir();
  const db = await MiniDb.open({
    dir,
    valueCodec: 'json',
    fsyncPolicy: 'no',
    compactThresholdBytes: 1 << 30, // drive compaction manually
  });
  try {
    // writeSnapshot yields to the event loop every 2000 entries (snapshot.ts
    // `yieldEvery`, plus an async writev per ~1 MiB batch), so N just has to
    // clear a few yield quanta for the write to land in a yield gap. 10_000
    // entries = 5 explicit yields — ~5x headroom over the minimum for
    // "multiple yields", enough for slow CI machines without writing ~75 MB.
    const N = 10_000;
    {
      // Prefill via batches: one WAL frame per 500 sets instead of 10k
      // sequential appends — the setup phase must stay cheap on slow CI
      // runners, leaving the timeout budget for the actual race below.
      for (let base = 0; base < N; base += 500) {
        await db.batch(
          Array.from({ length: Math.min(500, N - base) }, (_, j) => ({
            op: 'set' as const,
            key: 'k' + (base + j),
            value: { i: base + j, pad: 'x'.repeat(500) },
          })),
        );
      }
    }

    const cp = db.compact();
    const first = db.set('w0', { i: 0 });
    const winner = await Promise.race([
      cp.then(() => 'compact' as const),
      first.then(() => 'write' as const),
    ]);
    assert.equal(
      winner,
      'write',
      'a write issued during compaction completes before compaction finishes (non-blocking snapshot)',
    );
    await first;

    const M = 500;
    for (let i = 1; i < M; i++) await db.set('w' + i, { i });
    await cp;

    for (let i = 0; i < M; i++) assert.deepEqual(db.get('w' + i), { i }, `get(w${i})`);
    assert.equal(db.size, N + M);
  } finally {
    await db.close().catch(() => {});
    await rmrf(dir);
  }
});

test('compaction-race: heavy writes during compaction grow a WAL tail that survives recovery', { timeout: 30_000 }, async () => {
  // Sustained writes during compaction force the pre-copy loop to drain a real
  // WAL tail; the tail must be replayed on top of the snapshot after a reopen.
  const dir = await tmpDir();
  let db = await MiniDb.open({
    dir,
    valueCodec: 'json',
    fsyncPolicy: 'no',
    compactThresholdBytes: 1 << 30,
  });
  try {
    // 10k keys span 5 writeSnapshot yield windows (yieldEvery=2000, src/snapshot.ts),
    // so compaction is still in progress while the writes below land.
    const N = 10_000;
    for (let base = 0; base < N; base += 500) {
      await db.batch(
        Array.from({ length: Math.min(500, N - base) }, (_, j) => ({
          op: 'set' as const,
          key: 'k' + (base + j),
          value: { i: base + j },
        })),
      );
    }

    const cp = db.compact();
    // ~55 B/frame × 2000 ≈ 110 KB post-fence tail > SMALL_DELTA (64 KiB,
    // src/compaction.ts), so the pre-copy loop still drains a real WAL tail.
    const M = 2000;
    const writes: Promise<void>[] = [];
    for (let i = 0; i < M; i++) writes.push(db.set('k' + i, { i, bumped: true }));
    await Promise.all(writes);
    await cp;
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'json' });
    for (let i = 0; i < M; i++) assert.deepEqual(db.get('k' + i), { i, bumped: true }, `bumped k${i}`);
    for (let i = M; i < N; i++) assert.deepEqual(db.get('k' + i), { i }, `untouched k${i}`);
    assert.equal(db.size, N);
  } finally {
    await db.close().catch(() => {});
    await rmrf(dir);
  }
});

test('compaction-race: valueMode disk preserves concurrent writes and remaps pointers', { timeout: 30_000 }, async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({
    dir,
    valueCodec: 'json',
    valueMode: 'disk',
    fsyncPolicy: 'no',
    compactThresholdBytes: 2048,
  });
  const N = 300;
  const written = new Map();
  try {
    const ops = [];
    for (let i = 0; i < N; i++) {
      const k = 'k' + i;
      const v = { i, pad: 'x'.repeat(100) };
      written.set(k, v);
      ops.push(db.set(k, v));
      if (i % 50 === 0) ops.push(db.compact().then(() => {}));
    }
    await Promise.all(ops);
    if (db.compacting) await db._compactDone;

    for (const [k, v] of written) assert.deepEqual(db.get(k), v, `get(${k})`);
    assert.equal(db.size, N);
    const sawDiskRef = [...db.store.map.values()].some((r) => r.ref.kind === 'disk');
    assert.ok(sawDiskRef, 'expected disk-backed value refs after compaction');

    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', valueMode: 'disk' });
    for (const [k, v] of written) assert.deepEqual(db.get(k), v, `reopen get(${k})`);
    assert.equal(db.size, N);
  } finally {
    await db.close().catch(() => {});
    await rmrf(dir);
  }
});

// Regression: under sustained writes whose append rate approaches the pre-copy
// rate, auto-compactions previously never converged (stats.compactions stayed 0
// until the storm stopped; the WAL grew unboundedly). Compaction must now give
// up pre-copying and finish via the rotation critical section.
test(
  'compaction-race: auto compaction completes during a sustained write storm',
  { timeout: 60_000 },
  async () => {
    const dir = await tmpDir();
    let db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      compactThresholdBytes: 8 * 1024 * 1024,
    });
    let stop = false;
    let written = 0;
    let writeError: unknown = null;
    try {
      const val = 'v'.repeat(1024);
      const start = Date.now();
      const writers = Array.from({ length: 16 }, async () => {
        while (!stop && Date.now() - start < 15_000) {
          try {
            await db.set(`k${written++}`, val);
          } catch (e) {
            writeError ??= e;
            stop = true;
          }
        }
      });
      while (!stop && db.stats.compactions < 2 && Date.now() - start < 15_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      stop = true;
      await Promise.all(writers);
      assert.equal(writeError, null, `write failed during compaction storm: ${String(writeError)}`);
      assert.ok(
        db.stats.compactions >= 2,
        `expected auto compactions to complete during the storm, got ${db.stats.compactions} (written=${written})`,
      );
      await db.close();

      // every acknowledged write must survive compaction rotations + recovery
      db = await MiniDb.open({ dir, valueCodec: 'string' });
      assert.equal(db.size, written, `size=${db.size} vs written=${written}`);
      assert.equal(db.get('k0'), val);
      assert.equal(db.get(`k${written - 1}`), val);
    } finally {
      await db.close().catch(() => {});
      await rmrf(dir);
    }
  },
);
