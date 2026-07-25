// test/cluster/concurrent.test.js
//
// True multi-process concurrent read/write tests. Each scenario spawns real
// child processes (node --import tsx mp-worker.ts) that open the same cluster
// directory concurrently, and verifies data integrity afterwards.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MiniDb } from '../../src/index.js';
import { ClusterDb, shardDirName } from '../../src/cluster/index.js';
import { shardFor } from '../../src/cluster/utils.js';
import { tmpDir } from '../e2e/helpers/tmp.js';
import { keyOnShard, runWorker, runWorkerOk, rmrf, sleep } from './helpers.js';

test(
  'P=4 processes write disjoint keyspaces concurrently (S=8); all data survives',
  { timeout: 180_000 },
  async () => {
    const dir = await tmpDir('minidb-cluster-mp-');
    try {
      const P = 4;
      const N = 150;
      const runs = Array.from({ length: P }, (_, p) =>
        runWorkerOk(['write', dir, '8', `p${p}`, String(N)], { timeoutMs: 120_000 }),
      );
      const reports = await Promise.all(runs);
      for (const r of reports) assert.equal(r.n, N);

      // Verify from a brand-new process: every key, every value.
      await Promise.all(
        Array.from({ length: P }, (_, p) => runWorkerOk(['verify', dir, '8', `p${p}`, String(N)], { timeoutMs: 120_000 })),
      );

      // Double-check through a read-only cluster in this process.
      const db = await ClusterDb.open<{ p: string; i: number }>({ dir, readOnly: true });
      let count = 0;
      for (const e of await db.scan()) {
        assert.equal(e.key, `${e.value.p}:${e.value.i}`);
        count++;
      }
      assert.equal(count, P * N);
      await db.close();
    } finally {
      await rmrf(dir);
    }
  },
);

test(
  'concurrent writers on the SAME shard serialize safely with no lost writes',
  { timeout: 180_000 },
  async () => {
    const dir = await tmpDir('minidb-cluster-mp-');
    try {
      const shards = 4;
      const targetShard = 2;
      const procs = 3;
      const perProc = 40;
      // Precompute disjoint keys that all route to the same shard.
      const keysPerProc = Array.from({ length: procs }, (_, p) =>
        Array.from({ length: perProc }, (_, i) => keyOnShard(`hot${p}:${i}`, targetShard, shards)),
      );
      const runs = keysPerProc.map((keys) =>
        runWorkerOk(['writekeys', dir, String(shards), keys.join(',')], { timeoutMs: 150_000 }),
      );
      const reports = await Promise.all(runs);
      // Retries are expected under contention but not required; log for insight.
      const retries = reports.map((r) => r.retries);

      const db = await ClusterDb.open<{ key: string }>({ dir, shardCount: shards, readOnly: true });
      const allKeys = keysPerProc.flat();
      const got = await db.mget(allKeys);
      assert.deepEqual(
        got.map((v) => v?.key),
        allKeys,
        `no lost writes on a hot shard (retries: ${retries.join('/')})`,
      );
      await db.close();
    } finally {
      await rmrf(dir);
    }
  },
);

test(
  'a reader process observes commits from a concurrently running writer process',
  { timeout: 180_000 },
  async () => {
    const dir = await tmpDir('minidb-cluster-mp-');
    try {
      // Start a long-polling reader BEFORE the data exists. The inner wait
      // budget must absorb writer process startup on heavily loaded CI
      // runners (writer spawn + first open can take tens of seconds there).
      const waiter = runWorkerOk(['wait-read', dir, '4', 'live:k', '42', '120000'], { timeoutMs: 150_000 });
      // Give the reader a head start so it really polls with a cold cache.
      await new Promise((r) => setTimeout(r, 500));

      const db = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json' });
      await db.set('live:k', { i: 42 });
      const report = await waiter;
      assert.ok(typeof report.waitedMs === 'number');
      await db.close();
    } finally {
      await rmrf(dir);
    }
  },
);

test(
  'mixed read/write storm across processes keeps all committed data readable',
  { timeout: 240_000 },
  async () => {
    const dir = await tmpDir('minidb-cluster-mp-');
    try {
      const writers = Array.from({ length: 3 }, (_, p) =>
        runWorkerOk(['write', dir, '8', `storm${p}`, '100'], { timeoutMs: 150_000 }),
      );
      // Concurrent read-only verifiers race the writers; they may legitimately
      // see partial progress, so only assert they never error out.
      const racingReaders = Array.from({ length: 2 }, () =>
        runWorker(['wait-read', dir, '8', 'storm0:0', '0', '90000'], { timeoutMs: 120_000 }),
      );
      const writerReports = await Promise.all(writers);
      const readerResults = await Promise.all(racingReaders);
      for (const w of writerReports) assert.equal(w.n, 100);
      for (const r of readerResults) assert.equal(r.code, 0, `racing reader exited cleanly: ${r.stderr}`);

      // After quiesce, the full dataset is visible to a new process.
      for (let p = 0; p < 3; p++) {
        await runWorkerOk(['verify', dir, '8', `storm${p}`, '100'], { timeoutMs: 120_000 });
      }
    } finally {
      await rmrf(dir);
    }
  },
);


/** Dual-check: every view of the cached reader on the hot shard must equal a
 *  from-scratch full open of the same shard files. */
type Doc = Record<string, unknown>;

async function assertSameAsFreshOpen(db: ClusterDb<Doc>, dir: string, hot: number): Promise<void> {
  const sortByKey = (a: { key: string }, b: { key: string }): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const ref = await MiniDb.open<Doc>({ dir: path.join(dir, shardDirName(hot, db.shardCount)), readOnly: true, valueCodec: 'json' });
  try {
    assert.deepEqual(await db.scan(), ref.scan(), 'scan equality with a fresh full open');
    assert.deepEqual((await db.findEq('c', 'c3')).sort(sortByKey), ref.findEq('c', 'c3').sort(sortByKey), 'findEq equality');
    const [crange, rrange] = [await db.findRange('n', { min: 100, max: 900 }), ref.findRange('n', { min: 100, max: 900 })];
    assert.deepEqual(crange.sort(sortByKey), rrange.sort(sortByKey), 'findRange equality');
    assert.deepEqual(await db.findEq('u', 'pre-u42'), ref.findEq('u', 'pre-u42'), 'unique-index equality');
    const [cs, rs] = [await db.search('t', 'alpha'), ref.search('t', 'alpha')];
    assert.deepEqual(cs.sort(sortByKey), rs.sort(sortByKey), 'text search equality');
  } finally {
    await ref.close();
  }
}

test(
  'reader WAL catch-up: incremental tail apply equals a full reopen (multi-process)',
  { timeout: 180_000 },
  async () => {
    const dir = await tmpDir('minidb-cluster-mp-');
    try {
      const shards = 4;
      const hot = 1;
      // Preload 30k keys on the hot shard (secondary eq+range indexes, one
      // unique index, one text index, dt column on every key), then release
      // all locks so the storm child can write.
      const setup = await ClusterDb.open<Doc>({ dir, shardCount: shards, valueCodec: 'json', fsyncPolicy: 'no', lockHoldMs: 0 });
      const pre: string[] = [];
      for (let seq = 0; pre.length < 30_000; seq++) {
        const key = `pre:${seq}`;
        if (shardFor(key, shards) === hot) pre.push(key);
      }
      for (let j = 0; j < pre.length; j++) {
        await setup.set(pre[j]!, { n: j, c: `c${j % 11}`, u: `pre-u${j}`, t: `alpha beta pre w${j % 17}` }, { dt: { created: 1700000100000 + j } });
      }
      await setup.createIndex('c', { field: 'c' });
      await setup.createIndex('n', { field: 'n', type: 'range' });
      await setup.createIndex('u', { field: 'u', unique: true });
      await setup.createTextIndex('t', { fields: ['t'] });
      await setup.close();

      // The parent's read-only cluster: first read opens and warms the cached
      // reader of the hot shard (records the WAL watermark).
      const db = await ClusterDb.open<Doc>({ dir, readOnly: true });
      assert.equal((await db.get(pre[0]!))?.n, 0);
      const stats0 = db.stats();
      assert.equal(stats0.readerReopens, 0);
      assert.equal(stats0.incrementalCatchups, 0);

      // Mixed storm from a child process: sets, updates, dels, TYPE_BATCH
      // batches, short/long TTL sets, dt changes — all on the hot shard.
      const report = await runWorkerOk(['storm', dir, String(shards), String(hot), 'storm', '4000'], { timeoutMs: 120_000 });
      // Outlive the 50ms short TTLs so replay-side expiry is deterministic.
      await sleep(150);

      // The first read after the storm catches the cached reader up by
      // applying ONLY the appended frames (exactly the storm's frame count);
      // no full reader reopen is allowed on this pure-append path.
      await db.get(pre[1]!);
      const stats1 = db.stats();
      assert.ok(stats1.incrementalCatchups > 0, 'incremental catch-up happened');
      assert.equal(stats1.readerReopens - stats0.readerReopens, 0, 'no full reopen on the pure-append path');
      assert.equal(stats1.catchupFramesApplied - stats0.catchupFramesApplied, report.frames, 'every storm frame applied exactly once');

      // Every view equals a from-scratch full open of the shard.
      await assertSameAsFreshOpen(db, dir, hot);

      // Control: a quiet shard (no writes) — reads cost only the fingerprint.
      const quiet = keyOnShard('quiet', 3, shards);
      await db.get(quiet); // first read caches the shard's reader
      const stats2 = db.stats();
      for (let k = 0; k < 200; k++) assert.equal(await db.get(quiet), undefined);
      const stats3 = db.stats();
      assert.equal(stats3.incrementalCatchups, stats2.incrementalCatchups, 'no catch-ups without writes');
      assert.equal(stats3.readerReopens, stats2.readerReopens, 'no reopens without writes');
      await db.close();
    } finally {
      await rmrf(dir);
    }
  },
);

test(
  'reader falls back to a full reopen on compaction rotation, then resumes incrementally',
  { timeout: 180_000 },
  async () => {
    const dir = await tmpDir('minidb-cluster-mp-');
    try {
      const shards = 4;
      const hot = 1;
      const setup = await ClusterDb.open<Doc>({ dir, shardCount: shards, valueCodec: 'json', fsyncPolicy: 'no', lockHoldMs: 0 });
      const pre: string[] = [];
      for (let seq = 0; pre.length < 1_000; seq++) {
        const key = `pre:${seq}`;
        if (shardFor(key, shards) === hot) pre.push(key);
      }
      for (let j = 0; j < pre.length; j++) {
        await setup.set(pre[j]!, { n: j, c: `c${j % 11}`, u: `pre-u${j}`, t: `alpha beta pre w${j % 17}` }, { dt: { created: 1700000100000 + j } });
      }
      await setup.createIndex('c', { field: 'c' });
      await setup.createIndex('n', { field: 'n', type: 'range' });
      await setup.createIndex('u', { field: 'u', unique: true });
      await setup.createTextIndex('t', { fields: ['t'] });
      await setup.close();

      const db = await ClusterDb.open<Doc>({ dir, readOnly: true });
      await db.get(pre[0]!); // warm the cached reader
      const stats0 = db.stats();

      // Storm with a tiny compaction threshold: the WAL/snapshot are rotated
      // (possibly several times) while the parent's reader is cached.
      await runWorkerOk(['storm', dir, String(shards), String(hot), 'rot', '1500', '60000', '1'], { timeoutMs: 120_000 });
      await sleep(150);

      await db.get(pre[1]!);
      const stats1 = db.stats();
      assert.ok(stats1.readerReopens - stats0.readerReopens >= 1, 'rotation forced a full reopen');
      assert.equal(stats1.incrementalCatchups - stats0.incrementalCatchups, 0, 'no incremental progress across a rotation');
      await assertSameAsFreshOpen(db, dir, hot);

      // A follow-up append-only storm is caught incrementally again.
      const report2 = await runWorkerOk(['storm', dir, String(shards), String(hot), 'rot2', '800', '0', '0'], { timeoutMs: 120_000 });
      await sleep(150);
      await db.get(pre[2]!);
      const stats2 = db.stats();
      assert.ok(stats2.incrementalCatchups - stats1.incrementalCatchups > 0, 'incremental catch-up resumed after the reopen');
      assert.equal(stats2.readerReopens - stats1.readerReopens, 0, 'no further reopen');
      assert.equal(stats2.catchupFramesApplied - stats1.catchupFramesApplied, report2.frames, 'second storm applied frame-exactly');
      await assertSameAsFreshOpen(db, dir, hot);
      await db.close();
    } finally {
      await rmrf(dir);
    }
  },
);
