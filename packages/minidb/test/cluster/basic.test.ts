// test/cluster/basic.test.js
//
// Single-process ClusterDb behavior: topology creation/validation, basic KV
// across shards, multi-key ops, merged scans, hash distribution, stats.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ClusterDb } from '../../src/cluster/index.js';
import { shardFor } from '../../src/cluster/utils.js';
import { tmpDir, rmrf } from '../e2e/helpers/tmp.js';
import { keyOnShard, keysByShard } from './helpers.js';

interface User {
  name: string;
  age: number;
}

test('cluster open creates meta + shard dirs; reload validates topology', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json' });
    assert.equal(db.shardCount, 4);
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'cluster.meta.json'), 'utf8'));
    assert.equal(meta.version, 1);
    assert.equal(meta.shardCount, 4);
    assert.equal(meta.valueCodec, 'json');
    const entries = await fs.readdir(dir);
    for (let i = 0; i < 4; i++) assert.ok(entries.includes(`shard-0${i}`), `shard-0${i} exists`);
    await db.close();

    // Reopen without options: inherits the on-disk topology.
    const db2 = await ClusterDb.open({ dir });
    assert.equal(db2.shardCount, 4);
    await db2.close();

    // Explicit mismatches are rejected.
    await assert.rejects(() => ClusterDb.open({ dir, shardCount: 8 }), /shardCount=4/);
    await assert.rejects(() => ClusterDb.open({ dir, valueCodec: 'string' }), /valueCodec=json/);

    // Invalid creation parameter is rejected upfront.
    const dir2 = await tmpDir('minidb-cluster-');
    try {
      await assert.rejects(() => ClusterDb.open({ dir: dir2, shardCount: 0 }), RangeError);
    } finally {
      await rmrf(dir2);
    }
  } finally {
    await rmrf(dir);
  }
});

test('single-key ops round-trip across shards', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<User>({ dir, shardCount: 4, valueCodec: 'json' });
    // Keys crafted to hit two distinct shards, proving reads/writes route.
    const k0 = keyOnShard('round', 0, 4);
    const k1 = keyOnShard('round', 1, 4);
    await db.set(k0, { name: 'alice', age: 30 });
    await db.set(k1, { name: 'bob', age: 25 });
    assert.deepEqual(await db.get(k0), { name: 'alice', age: 30 });
    assert.deepEqual(await db.get(k1), { name: 'bob', age: 25 });
    assert.equal(await db.has(k0), true);
    assert.equal(await db.has('round:nope'), false);
    assert.equal(await db.del(k0), true);
    assert.equal(await db.del(k0), false);
    assert.equal(await db.get(k0), undefined);
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('ttl and expire work per key', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<string>({ dir, shardCount: 2, valueCodec: 'string' });
    await db.set('temp', 'v', { ttl: 50 });
    const left = await db.ttl('temp');
    assert.ok(left > 0 && left <= 50, `ttl in range, got ${left}`);
    assert.equal(await db.ttl('missing'), -2);
    await db.set('forever', 'v');
    assert.equal(await db.ttl('forever'), -1);
    assert.equal(await db.expire('forever', 30), true);
    assert.equal(await db.expire('missing', 30), false);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(await db.get('temp'), undefined);
    assert.equal(await db.get('forever'), undefined);
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('mset/mget/mdel span shards (atomic per shard)', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<number>({ dir, shardCount: 8, valueCodec: 'json' });
    const grouped = keysByShard('multi', 200, 8);
    assert.ok(grouped.size >= 3, `keys hit multiple shards, got ${grouped.size}`);

    const entries = [...grouped.values()].flat().map((k, i) => [k, i] as [string, number]);
    await db.mset(entries);

    const keys = entries.map(([k]) => k);
    const got = await db.mget(keys);
    assert.deepEqual(got, entries.map(([, v]) => v));

    // mdel counts real deletions and spans shards.
    const some = keys.filter((_, i) => i % 2 === 0);
    const removed = await db.mdel([...some, 'multi:never-existed']);
    assert.equal(removed, some.length);
    const after = await db.mget(some);
    assert.ok(after.every((v) => v === undefined));
    const rest = await db.mget(keys.filter((_, i) => i % 2 === 1));
    assert.ok(rest.every((v) => typeof v === 'number'));
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('batch applies per-shard atomically with ttl/dt', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<User>({ dir, shardCount: 4, valueCodec: 'json' });
    const grouped = keysByShard('batch', 40, 4);
    const ops = [...grouped.values()].flat().flatMap((k, i) => [
      { op: 'set' as const, key: k, value: { name: `u${i}`, age: i }, dt: { created: 1000 + i } },
      { op: 'del' as const, key: `ghost:${i}` },
    ]);
    await db.batch(ops);
    const all = await db.scan({ prefix: 'batch:' });
    assert.equal(all.length, 40);
    assert.ok(all.every((e) => e.dt && typeof e.dt.created === 'number'));
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('scan/prefix merge across shards: sorted, bounded, limited, reversible', { timeout: 60_000 }, async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<number>({ dir, shardCount: 8, valueCodec: 'json' });
    const keys: string[] = [];
    for (let i = 0; i < 300; i++) {
      const k = `s:${String(i).padStart(4, '0')}`;
      keys.push(k);
      await db.set(k, i);
    }
    const byteSorted = [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

    const all = await db.scan();
    assert.equal(all.length, 300);
    assert.deepEqual(
      all.map((e) => e.key),
      byteSorted,
      'globally sorted by key bytes',
    );

    // Interleaved writes land in every shard; the merge must be complete.
    const range = await db.scan({ gte: 's:0010', lt: 's:0020' });
    assert.deepEqual(
      range.map((e) => e.key),
      byteSorted.filter((k) => k >= 's:0010' && k < 's:0020'),
    );

    const pref = await db.prefix('s:01', 10);
    assert.equal(pref.length, 10);
    assert.deepEqual(
      pref.map((e) => e.key),
      byteSorted.filter((k) => k.startsWith('s:01')).slice(0, 10),
    );

    const limited = await db.scan({ limit: 7 });
    assert.equal(limited.length, 7);
    assert.deepEqual(limited.map((e) => e.key), byteSorted.slice(0, 7));

    const rev = await db.scan({ reverse: true, limit: 5 });
    assert.deepEqual(rev.map((e) => e.key), [...byteSorted].reverse().slice(0, 5));

    // Prefix within ScanOptions beats range bounds.
    const prefOpt = await db.scan({ prefix: 's:029', gte: 'zzz' });
    assert.deepEqual(prefOpt.map((e) => e.key), ['s:0290', 's:0291', 's:0292', 's:0293', 's:0294', 's:0295', 's:0296', 's:0297', 's:0298', 's:0299'].filter((k) => k.startsWith('s:029')));
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('hash routing distributes keys over all shards and is deterministic', async () => {
  const counts = Array.from({ length: 16 }, () => 0);
  for (let i = 0; i < 4000; i++) counts[shardFor(`dist:${i}`, 16)]++;
  const avg = 4000 / 16;
  for (let s = 0; s < 16; s++) {
    assert.ok(counts[s]! > 0, `shard ${s} got keys`);
    assert.ok(counts[s]! < avg * 3, `shard ${s} not hot (${counts[s]} vs avg ${avg})`);
  }
  // Stable across calls (crypto-free pure function).
  assert.equal(shardFor('dist:42', 16), shardFor('dist:42', 16));
  assert.equal(shardFor('', 16), shardFor('', 16)); // empty key hashes fine
});

test('stats reflect writer usage', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<string>({ dir, shardCount: 4, valueCodec: 'string', lockPoolMaxShards: 2 });
    for (let i = 0; i < 20; i++) await db.set(`st:${i}`, 'v');
    const s = db.stats();
    assert.equal(s.shardCount, 4);
    assert.ok(s.writerOpens >= 2, `writers opened, got ${s.writerOpens}`);
    assert.ok(s.writersCached <= 2, `pool bounded, got ${s.writersCached}`);
    assert.ok(s.evictions >= 1, 'LRU eviction happened with tiny pool');
    await db.close();
    await assert.rejects(() => db.get('st:0'), /closed/);
  } finally {
    await rmrf(dir);
  }
});
