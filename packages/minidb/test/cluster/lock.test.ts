// test/cluster/lock.test.js
//
// Lock semantics inside one process: same-shard writer contention with
// acquire timeout, per-shard independence, read-only coexistence, lock lease
// renewal, and writer handoff after close.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ClusterDb } from '../../src/cluster/index.js';
import { ShardLockPool } from '../../src/cluster/lock-pool.js';
import { shardDirName } from '../../src/cluster/utils.js';
import { tmpDir, rmrf } from '../e2e/helpers/tmp.js';
import { keyOnShard, sleep } from './helpers.js';
import { deferred } from '../helpers.js';

test('two writers contend on the same shard; loser times out with LockError', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db1 = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json' });
    const db2 = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json', lockAcquireTimeoutMs: 150 });

    const kOnShard0a = keyOnShard('lock', 0, 4);
    const kOnShard0b = keyOnShard('lockx', 0, 4);
    await db1.set(kOnShard0a, { owner: 1 }); // db1 now holds shard 0

    const t0 = performance.now();
    await assert.rejects(
      () => db2.set(kOnShard0b, { owner: 2 }),
      (e: unknown) => (e as { code?: string }).code === 'ELOCKED',
    );
    const waited = performance.now() - t0;
    // The pool retries with backoff and gives up on the first attempt whose
    // next delay would cross the deadline, so effective waits undershoot the
    // configured timeout slightly.
    assert.ok(waited >= 50 && waited < 5_000, `waited roughly the acquire timeout (${Math.round(waited)}ms)`);

    // A key routed to a different shard is unaffected by the contention.
    const kOther = keyOnShard('other', 1, 4);
    await db2.set(kOther, { owner: 2 });
    assert.deepEqual(await db2.get(kOther), { owner: 2 });

    await db2.close();
    await db1.close();
  } finally {
    await rmrf(dir);
  }
});

test('writer handoff: after close, another instance takes the shard over', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const key = keyOnShard('handoff', 2, 4);
    const db1 = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json' });
    await db1.set(key, { n: 1 });
    await db1.close();

    const db2 = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json', lockAcquireTimeoutMs: 500 });
    assert.deepEqual(await db2.get(key), { n: 1 });
    await db2.set(key, { n: 2 });
    assert.deepEqual(await db2.get(key), { n: 2 });
    await db2.close();
  } finally {
    await rmrf(dir);
  }
});

test('read-only instance coexists with a live writer and sees its commits', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const writer = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json' });
    await writer.set('ro:k1', { v: 1 });

    const reader = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json', readOnly: true });
    assert.deepEqual(await reader.get('ro:k1'), { v: 1 });

    // Fresh reads observe new commits without reopening the cluster.
    await writer.set('ro:k2', { v: 2 });
    assert.deepEqual(await reader.get('ro:k2'), { v: 2 });

    // Writes on the read-only instance are rejected.
    await assert.rejects(() => reader.set('ro:k3', { v: 3 }), /read-only/);
    await assert.rejects(
      () => reader.mset([['ro:k3', { v: 3 }]]),
      (e: unknown) => e instanceof AggregateError && String(e.errors[0]).includes('read-only'),
    );

    await reader.close();
    await writer.close();
  } finally {
    await rmrf(dir);
  }
});

test('lock lease: db.lock timestamp advances while a writer is held', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json', lockRenewMs: 80, lockHoldMs: 0 });
    const key = keyOnShard('lease', 1, 4);
    await db.set(key, { v: 1 }); // grabs shard 1 and starts the lease timer

    const lockPath = path.join(dir, shardDirName(1, 4), 'db.lock');
    const read = async () => JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid: number; ts: number };
    const first = await read();
    assert.equal(first.pid, process.pid);
    await sleep(300);
    const second = await read();
    assert.ok(second.ts > first.ts, `timestamp renewed (${first.ts} -> ${second.ts})`);
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('close releases every shard lock it holds', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db1 = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json' });
    await db1.mset([
      [keyOnShard('c', 0, 4), { v: 0 }],
      [keyOnShard('c', 1, 4), { v: 1 }],
      [keyOnShard('c', 2, 4), { v: 2 }],
      [keyOnShard('c', 3, 4), { v: 3 }],
    ]);
    await db1.close();

    // Nothing left locked: a fresh instance with a tiny timeout can write all shards.
    const db2 = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json', lockAcquireTimeoutMs: 100 });
    await db2.mset([
      [keyOnShard('c', 0, 4), { v: 10 }],
      [keyOnShard('c', 1, 4), { v: 11 }],
      [keyOnShard('c', 2, 4), { v: 12 }],
      [keyOnShard('c', 3, 4), { v: 13 }],
    ]);
    assert.deepEqual(await db2.get(keyOnShard('c', 0, 4)), { v: 10 });
    assert.deepEqual(await db2.get(keyOnShard('c', 3, 4)), { v: 13 });
    await db2.close();
  } finally {
    await rmrf(dir);
  }
});

test('close() waits for an in-flight shard open and releases its lock', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const key = keyOnShard('inflight', 0, 4);
    const db1 = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json' });
    await db1.set(key, { holder: 1 }); // db1 holds shard 0

    // lockHoldMs: 0 — an acquired writer never auto-yields, so a leaked handle
    // would hold the shard lock indefinitely.
    const db2 = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json', lockAcquireTimeoutMs: 5_000, lockHoldMs: 0 });
    // db2's shard-0 open is now stuck in the lock-retry loop behind db1.
    const pendingSet = db2.set(key, { holder: 2 });
    await sleep(50);
    const t0 = performance.now();
    const closing = db2.close();
    // Release the holder mid-close: db2's in-flight open can now succeed —
    // close() must still wait for it and close the freshly acquired handle.
    await sleep(100);
    await db1.close();

    await pendingSet.catch(() => {}); // may resolve or reject; either is fine
    await closing;
    const waited = performance.now() - t0;
    assert.ok(waited >= 80, `close() waited for the in-flight open to settle (${Math.round(waited)}ms)`);

    // No leaked handle holds the shard lock: a fresh instance writes at once.
    const db3 = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json', lockAcquireTimeoutMs: 300, lockHoldMs: 0 });
    await db3.set(key, { holder: 3 });
    assert.deepEqual(await db3.get(key), { holder: 3 });
    await db3.close();
  } finally {
    await rmrf(dir);
  }
});

test('closeAll() drains in-flight callbacks before closing handles — no MiniDb-is-closed leak (review #18)', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const pool = new ShardLockPool({
      writerOpts: { valueCodec: 'json' },
      readerOpts: { valueCodec: 'json' },
      lockRenewMs: 0,
      lockAcquireTimeoutMs: 1_000,
      lockHoldMs: 0,
      maxWriters: 4,
      maxReaders: 4,
      readOnly: false,
      applyDefs: async () => {},
    });
    const shardDir = path.join(dir, shardDirName(2, 4));

    // A callback parked mid-flight: closeAll must wait for it instead of
    // closing the handle under it (the old 'MiniDb is closed' leak).
    const gate = deferred<void>();
    const entered = deferred<void>();
    const op = pool.withWriter(2, shardDir, async (db) => {
      entered.resolve();
      await gate.promise;
      // The handle must still be alive here: closeAll may not tear it down
      // while this callback runs.
      await db.set('late', { v: 1 });
      return db.get('late');
    });
    await entered.promise;

    let opSettled = false;
    void op.then(
      () => (opSettled = true),
      () => (opSettled = true),
    );
    const closing = pool.closeAll();
    let closeReturned = false;
    void closing.then(() => (closeReturned = true));
    // closeAll's only path to resolution goes through the parked callback's
    // drain, so no amount of yielding can settle it here.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(closeReturned, false, 'closeAll waits for the in-flight callback');

    gate.resolve();
    assert.deepEqual(await op, { v: 1 }, 'the in-flight callback ran to completion on a live handle');
    await closing;
    assert.equal(opSettled, true, 'every callback is settled by the time closeAll returns');

    // New ops reject at the closed gate; the shard lock is released for the
    // next pool.
    await assert.rejects(pool.withWriter(2, shardDir, (db) => db.get('x')), /ClusterDb is closed/);
    const pool2 = new ShardLockPool({
      writerOpts: { valueCodec: 'json' },
      readerOpts: { valueCodec: 'json' },
      lockRenewMs: 0,
      lockAcquireTimeoutMs: 300,
      lockHoldMs: 0,
      maxWriters: 4,
      maxReaders: 4,
      readOnly: false,
      applyDefs: async () => {},
    });
    assert.deepEqual(await pool2.withWriter(2, shardDir, (db) => db.get('late')), { v: 1 }, 'the callback’s write is durable');
    await pool2.closeAll();
  } finally {
    await rmrf(dir);
  }
});
