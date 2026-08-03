// Regression tests for the fifth deep-review round:
//   A) Recovery must not let an expired overwrite resurrect an older value.
//   B) Observing an expired key via scan/query/dtRange must reap it from the
//      derived indexes (dt / secondary), so they cannot leak ghost entries.
//   C) A non-integer / non-finite TTL must not explode with a BigInt error.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-r5-'));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- A) Recovery must not resurrect an older value -------------------------

test('recovery: expired overwrite does not resurrect older value (WAL only)', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
  await db.set('k', 'v1'); // no ttl
  await db.set('k', 'v2', { ttl: 1 }); // overwrites with a ttl that will expire
  await sleep(20); // v2 expires while open (not reaped: activeExpire off, no get)
  await db.close();

  db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
  try {
    assert.equal(db.get('k'), undefined, 'the expired v2 overwrite must not resurrect v1');
    assert.equal(db.size, 0, 'no live key should remain');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('recovery: expired overwrite does not resurrect a snapshotted value', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({
    dir,
    valueCodec: 'string',
    activeExpireIntervalMs: 0,
    compactThresholdBytes: 1,
    autoCompact: false,
  });
  await db.set('k', 'v1');
  await db.compact(); // snapshot now holds k=v1; WAL is truncated
  await db.set('k', 'v2', { ttl: 1 }); // lives only in the post-compaction WAL
  await sleep(20);
  await db.close();

  db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
  try {
    assert.equal(db.get('k'), undefined, 'expired WAL overwrite must not resurrect the snapshot value');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- B) Derived indexes must not leak expired keys -------------------------

test('expired key is reaped from the dt index when observed via scan', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', activeExpireIntervalMs: 0 });
  try {
    await db.set('g', { v: 1 }, { ttl: 1, dt: { created: 100 } });
    await sleep(20);
    db.scan(); // non-get read path: must reap the expired key + derived indexes
    assert.deepEqual(db.dt.columns(), [], 'dt index must drop a column whose only key expired');
    assert.deepEqual(db.dtRange('created', { gte: 0, lte: 1000 }), []);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('expired key is reaped from a secondary index when observed via scan', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', activeExpireIntervalMs: 0 });
  await db.createIndex('byCity', { field: 'city' });
  try {
    await db.set('g', { city: 'Paris' }, { ttl: 1 });
    await sleep(20);
    db.scan(); // reap via the getRecord read path
    // Inspect the raw index manager (no store.get, so no self-healing here):
    assert.deepEqual(db.indexes.findEq('byCity', 'Paris'), [], 'secondary index must not retain the expired key');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- C) TTL validation ------------------------------------------------------

test('set with a fractional ttl does not throw (rounded to integer ms)', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
  try {
    await db.set('k', 'v', { ttl: 200.9 }); // floor to 200ms; must not throw a BigInt error
    const left = db.ttl('k');
    assert.ok(left > 0 && left <= 201, `ttl should be ~200ms, got ${left}`);
    assert.equal(db.get('k'), 'v');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('set with a non-finite ttl is rejected with a clear error and stores nothing', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await assert.rejects(db.set('a', 'v', { ttl: Infinity }), /ttl/i);
    await assert.rejects(db.set('b', 'v', { ttl: NaN }), /ttl/i);
    assert.equal(db.get('a'), undefined, 'rejected set must not be stored');
    assert.equal(db.get('b'), undefined);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
