// test/cluster/recovery.test.js
//
// Crash semantics for the cluster layer: SIGKILL mid-write must not corrupt
// any shard, recovered data is a contiguous prefix of the write order, and a
// db.lock left behind by a dead process is taken over by the next writer.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ClusterDb } from '../../src/cluster/index.js';
import { tmpDir } from '../e2e/helpers/tmp.js';
import { WORKER, keyOnShard, rmrf } from './helpers.js';

/** Spawn the crash writer and SIGKILL it shortly after it starts writing. */
function crashWriter(dir: string, shardCount: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER, 'crash', dir, String(shardCount)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeats = 0;
    child.stdout.on('data', () => {
      // Kill after several progress heartbeats (>=51 acknowledged keys), not on
      // a wall-clock window: fsync 'always' throughput collapses under
      // parallel-suite load, so a fixed ms window was inherently flaky.
      heartbeats++;
      if (!killTimer && heartbeats >= 3) killTimer = setTimeout(() => child.kill('SIGKILL'), 20);
    });
    const safety = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('exit', () => {
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(safety);
      resolve();
    });
  });
}

test(
  'kill -9 a writer mid-flight: every shard reopens clean and data is a contiguous prefix',
  { timeout: 120_000 },
  async () => {
    const runs = 3;
    for (let r = 0; r < runs; r++) {
      const dir = await tmpDir('minidb-cluster-crash-');
      try {
        await crashWriter(dir, 4);
        // The dead process left db.lock files behind; with its PID gone, the
        // next writer takes over immediately.
        const db = await ClusterDb.open<{ i: number }>({
          dir,
          shardCount: 4,
          valueCodec: 'json',
          lockAcquireTimeoutMs: 3_000,
        });
        let last = -1;
        for (let i = 0; i < 100_000; i++) {
          const v = await db.get(`k${i}`);
          if (v === undefined) {
            last = i - 1;
            break;
          }
          assert.equal(v.i, i, `run${r}: value mismatch at k${i}`);
        }
        assert.ok(last >= 2, `run${r}: expected several durable keys, got k0..k${last}`);
        // Writable after takeover.
        await db.set(`post`, { i: -1 });
        assert.deepEqual(await db.get('post'), { i: -1 });
        await db.close();
      } finally {
        await rmrf(dir);
      }
    }
  },
);

test(
  'a db.lock left by a SIGKILLed holder is taken over by the next process',
  { timeout: 60_000 },
  async () => {
    const dir = await tmpDir('minidb-cluster-takeover-');
    try {
      const shardCount = 4;
      const key = keyOnShard('victim', 1, shardCount);
      const holder = spawn(process.execPath, ['--import', 'tsx', WORKER, 'hold', dir, String(shardCount), key], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      // Wait until the holder actually wrote the key (its lock is now held).
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on('data', (d) => {
          if (String(d).includes('"holding"')) resolve();
        });
        holder.on('error', reject);
        setTimeout(() => reject(new Error('holder never started')), 30_000);
      });
      holder.kill('SIGKILL');
      await new Promise((r) => holder.on('exit', r));

      const t0 = performance.now();
      const db = await ClusterDb.open<{ heldBy: number }>({
        dir,
        shardCount,
        valueCodec: 'json',
        lockAcquireTimeoutMs: 5_000,
      });
      // Same-shard write requires taking over the dead process's lock.
      const sameShardKey = keyOnShard('rescuer', 1, shardCount);
      await db.set(sameShardKey, { ok: 1 });
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 5_000, `takeover was prompt (${Math.round(elapsed)}ms)`);
      assert.equal((await db.get(sameShardKey)) !== undefined, true);
      await db.close();
    } finally {
      await rmrf(dir);
    }
  },
);
