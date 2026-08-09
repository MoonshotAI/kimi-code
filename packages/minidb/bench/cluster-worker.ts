// bench/cluster-worker.ts
//
// Worker process for the cluster concurrency benchmark. Spawned by
// bench/cluster.ts; prints one JSON report line and exits.
//
//   write <dir> <shards> <prefix> <n> <valueBytes> <lockHoldMs> <allow>
//     Writes n keys `${prefix}:${i}` (json values). `allow` is either 'all'
//     or a comma-separated shard-id list; keys routing outside the allowed
//     shards are skipped (shard-affinity workloads).
//   read  <dir> <shards> <prefix> <n>

import { ClusterDb } from '../src/cluster/index.js';
import { LockError } from '../src/lockfile.js';

const [, , mode, ...rest] = process.argv;

function out(report: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(report) + '\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const [dir, shards, prefix, n, valueBytes = '64', lockHoldMs = '250', allow = 'all'] = rest;
  const shardCount = Number(shards);
  const allowed = allow === 'all' ? null : new Set(allow.split(',').map(Number));
  const want = Number(n);

  let retries = 0;
  const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        if ((e as { code?: string }).code !== 'ELOCKED' && !(e instanceof LockError)) throw e;
        retries++;
        await sleep(15 + Math.floor(Math.random() * 45));
      }
    }
  };

  if (mode === 'write') {
    const db = await ClusterDb.open({
      dir: dir!,
      shardCount,
      valueCodec: 'json',
      fsyncPolicy: 'everysec',
      lockHoldMs: Number(lockHoldMs),
    });
    const pad = 'x'.repeat(Number(valueBytes));
    let written = 0;
    const t0 = performance.now();
    for (let i = 0; written < want; i++) {
      const key = `${prefix}:${i}`;
      if (allowed && !allowed.has(db.shardOf(key))) continue;
      await withRetry(() => db.set(key, { p: prefix, i, pad }));
      written++;
    }
    const ms = performance.now() - t0;
    out({ ok: 1, mode, n: written, ms, retries, lockWaits: db.stats().lockWaits });
    await db.close();
    return;
  }

  if (mode === 'read') {
    const db = await ClusterDb.open({ dir: dir!, shardCount, valueCodec: 'json', readOnly: true });
    let found = 0;
    const t0 = performance.now();
    for (let i = 0; found < want; i++) {
      if (i > want * shardCount * 8 + 1000) throw new Error(`read found only ${found}/${want} keys`);
      const key = `${prefix}:${i}`;
      if (allowed && !allowed.has(db.shardOf(key))) continue;
      const v = (await db.get(key)) as { i?: number } | undefined;
      if (v !== undefined && v.i === i) found++;
    }
    const ms = performance.now() - t0;
    out({ ok: 1, mode, n: want, found, ms, retries });
    await db.close();
    return;
  }

  out({ ok: 0, error: `unknown mode: ${mode}` });
  process.exit(1);
}

main().catch((e) => {
  out({ ok: 0, mode, error: String(e && (e as Error).stack ? (e as Error).stack : e) });
  process.exit(1);
});
