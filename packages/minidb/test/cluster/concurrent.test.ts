// test/cluster/concurrent.test.js
//
// True multi-process concurrent read/write tests. Each scenario spawns real
// child processes (node --import tsx mp-worker.ts) that open the same cluster
// directory concurrently, and verifies data integrity afterwards.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ClusterDb } from '../../src/cluster/index.js';
import { tmpDir } from '../e2e/helpers/tmp.js';
import { keyOnShard, runWorker, runWorkerOk, rmrf } from './helpers.js';

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
      // Start a long-polling reader BEFORE the data exists.
      const waiter = runWorkerOk(['wait-read', dir, '4', 'live:k', '42', '60000'], { timeoutMs: 90_000 });
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
