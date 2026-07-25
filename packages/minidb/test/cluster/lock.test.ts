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
import { shardDirName } from '../../src/cluster/utils.js';
import { tmpDir, rmrf } from '../e2e/helpers/tmp.js';
import { keyOnShard, sleep } from './helpers.js';

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
