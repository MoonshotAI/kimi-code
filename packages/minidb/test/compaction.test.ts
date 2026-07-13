// test/compaction.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-compact-'));
}

test('manual compact writes a snapshot, shrinks the WAL, and keeps data', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    for (let i = 0; i < 500; i++) await db.set(`k${i}`, `value-${i}`);
    const walBefore = (await fs.stat(path.join(dir, 'db.wal'))).size;
    await db.compact();
    assert.equal(db.stats.compactions, 1);

    const snap = await fs.stat(path.join(dir, 'db.snapshot'));
    const walAfter = (await fs.stat(path.join(dir, 'db.wal'))).size;
    assert.ok(snap.size > 0, 'snapshot file exists and is non-empty');
    assert.ok(walAfter < walBefore, 'WAL shrank after compaction');
    assert.equal(db.size, 500);
    await db.close();

    // Recovery should load snapshot + (small) WAL and restore everything.
    db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.recoveryInfo.snapshotFrames, 500);
    assert.equal(db.size, 500);
    assert.equal(db.get('k0'), 'value-0');
    assert.equal(db.get('k499'), 'value-499');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a write issued during compaction is preserved', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    for (let i = 0; i < 200; i++) await db.set(`k${i}`, `v${i}`);

    const compactP = db.compact();
    const setP = db.set('during', 'hello'); // guard should queue behind compaction
    await Promise.all([compactP, setP]);

    assert.equal(db.get('during'), 'hello');
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.size, 201);
    assert.equal(db.get('during'), 'hello');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('auto-compaction triggers when the WAL crosses the threshold', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      compactThresholdBytes: 1024, // 1 KiB
    });
    for (let i = 0; i < 200; i++) await db.set(`k${i}`, `v${i}`.padEnd(50, 'x'));
    // Allow the background compaction to finish.
    if (db.compacting) await db._compactDone;
    assert.ok(db.stats.compactions >= 1, 'at least one auto-compaction ran');
    assert.equal(db.size, 200);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('del-then-compact drops tombstoned keys from the snapshot', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', '1');
    await db.set('b', '2');
    await db.del('a');
    await db.compact();
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.recoveryInfo.snapshotFrames, 1); // only 'b' survived
    assert.equal(db.get('a'), undefined);
    assert.equal(db.get('b'), '2');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('concurrent SET/UPDATE/DEL during compaction survive recovery', async () => {
  // Exercises the fuzzy-snapshot + WAL-tail-replay convergence: writes that
  // land while the snapshot is being written must all be reflected after a
  // reopen, with last-writer-wins semantics.
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    // 5000 keys span 2 writeSnapshot yield windows (yieldEvery=2000, src/snapshot.ts),
    // so the ops below genuinely race an in-progress snapshot.
    const N = 5000;
    for (let i = 0; i < N; i++) await db.set('k' + i, 'v' + i);

    // Even keys are updated, keys == 1 (mod 4) are deleted, keys == 3 (mod 4)
    // are left untouched, and a batch of new keys is added — all racing the
    // in-progress snapshot.
    let deleted = 0;
    const M = 1000;
    const compactP = db.compact();
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      if (i % 2 === 0) ops.push(db.set('k' + i, 'updated-' + i));
      else if (i % 4 === 1) {
        deleted++;
        ops.push(db.del('k' + i));
      }
    }
    for (let i = 0; i < M; i++) ops.push(db.set('new' + i, 'n' + i));
    await Promise.all(ops);
    await compactP;
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    for (let i = 0; i < N; i++) {
      if (i % 2 === 0) assert.equal(db.get('k' + i), 'updated-' + i, `updated k${i}`);
      else if (i % 4 === 1) assert.equal(db.get('k' + i), undefined, `deleted k${i}`);
      else assert.equal(db.get('k' + i), 'v' + i, `unchanged k${i}`);
    }
    for (let i = 0; i < M; i++) assert.equal(db.get('new' + i), 'n' + i, `new${i}`);
    assert.equal(db.size, N - deleted + M);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test('compaction with no concurrent writes produces an empty WAL tail', async () => {
  // When nothing is written during compaction, the post-fence WAL tail is empty
  // and the new WAL should be zero-length (or near-zero). Data still survives.
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    for (let i = 0; i < 300; i++) await db.set('k' + i, 'v' + i);
    await db.compact();
    const walSize = (await fs.stat(path.join(dir, 'db.wal'))).size;
    assert.equal(walSize, 0, 'WAL tail is empty when no writes raced compaction');
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.size, 300);
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get('k299'), 'v299');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
