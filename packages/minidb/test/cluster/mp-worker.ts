// test/cluster/mp-worker.ts
//
// Child-process entrypoint for the multi-process cluster tests. Not a test
// file itself; spawned via `node --import tsx mp-worker.ts <mode> ...`.
// Always prints a final JSON report line and exits non-zero on failure.

import { ClusterDb } from '../../src/cluster/index.js';
import { shardFor } from '../../src/cluster/utils.js';
import { LockError } from '../../src/lockfile.js';

const [, , mode, ...rest] = process.argv;

function out(report: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(report) + '\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLockError(e: unknown): boolean {
  return e instanceof LockError || (e as { code?: string }).code === 'ELOCKED';
}

/** Retry a write op on lock contention with jittered backoff; counts retries. */
async function withRetry<T>(fn: () => Promise<T>, stats: { retries: number }, deadlineMs = 60_000): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!isLockError(e) || Date.now() > deadline) throw e;
      stats.retries++;
      await sleep(20 + Math.floor(Math.random() * 60));
    }
  }
}

const pad = (n: number) => 'x'.repeat(n);

async function main(): Promise<void> {
  const stats = { retries: 0 };

  if (mode === 'write') {
    // write <dir> <shardCount> <prefix> <n> [valueBytes] [fsyncPolicy]
    const [dir, shardCount, prefix, n, valueBytes = '32', fsyncPolicy = 'everysec'] = rest;
    const db = await ClusterDb.open({
      dir: dir!,
      shardCount: Number(shardCount),
      valueCodec: 'json',
      fsyncPolicy: fsyncPolicy as 'always' | 'everysec' | 'no',
    });
    const t0 = performance.now();
    const count = Number(n);
    for (let i = 0; i < count; i++) {
      const value = { p: prefix, i, pad: pad(Number(valueBytes)) };
      await withRetry(() => db.set(`${prefix}:${i}`, value), stats);
    }
    const ms = performance.now() - t0;
    out({ ok: 1, mode, n: count, ms, retries: stats.retries });
    await db.close();
    return;
  }

  if (mode === 'writekeys') {
    // writekeys <dir> <shardCount> <key1,key2,...>
    const [dir, shardCount, keysCsv] = rest;
    const keys = keysCsv!.split(',');
    const db = await ClusterDb.open({ dir: dir!, shardCount: Number(shardCount), valueCodec: 'json' });
    const t0 = performance.now();
    for (const key of keys) {
      await withRetry(() => db.set(key, { key }), stats);
    }
    const ms = performance.now() - t0;
    out({ ok: 1, mode, n: keys.length, ms, retries: stats.retries });
    await db.close();
    return;
  }

  if (mode === 'verify') {
    // verify <dir> <shardCount> <prefix> <n>
    const [dir, shardCount, prefix, n] = rest;
    const db = await ClusterDb.open({ dir: dir!, shardCount: Number(shardCount), valueCodec: 'json', readOnly: true });
    const count = Number(n);
    let found = 0;
    for (let i = 0; i < count; i++) {
      const v = (await db.get(`${prefix}:${i}`)) as { p?: string; i?: number } | undefined;
      if (v === undefined || v.p !== prefix || v.i !== i) {
        out({ ok: 0, mode, error: `mismatch at ${prefix}:${i}`, got: v ?? null });
        process.exit(1);
      }
      found++;
    }
    out({ ok: 1, mode, found });
    await db.close();
    return;
  }

  if (mode === 'wait-read') {
    // wait-read <dir> <shardCount> <key> <expectedI> <timeoutMs>
    const [dir, shardCount, key, expectedI, timeoutMs] = rest;
    const db = await ClusterDb.open({ dir: dir!, shardCount: Number(shardCount), valueCodec: 'json', readOnly: true });
    const t0 = performance.now();
    const deadline = t0 + Number(timeoutMs);
    for (;;) {
      const v = (await db.get(key!)) as { i?: number } | undefined;
      if (v !== undefined && v.i === Number(expectedI)) {
        out({ ok: 1, mode, waitedMs: performance.now() - t0 });
        await db.close();
        return;
      }
      if (performance.now() > deadline) {
        out({ ok: 0, mode, error: `timeout waiting for ${key}`, got: v ?? null });
        process.exit(1);
      }
      await sleep(50);
    }
  }

  if (mode === 'crash') {
    // crash <dir> <shardCount> — write k{i} sequentially with fsync 'always'
    // until killed; report progress every 25 keys.
    const [dir, shardCount] = rest;
    const db = await ClusterDb.open({
      dir: dir!,
      shardCount: Number(shardCount),
      valueCodec: 'json',
      fsyncPolicy: 'always',
    });
    for (let i = 0; ; i++) {
      await db.set(`k${i}`, { i });
      if (i % 25 === 0) out({ progress: i });
    }
  }

  if (mode === 'hold') {
    // hold <dir> <shardCount> <key> — write one key, then keep the process
    // (and its shard write lock) alive until killed.
    const [dir, shardCount, key] = rest;
    const db = await ClusterDb.open({ dir: dir!, shardCount: Number(shardCount), valueCodec: 'json', lockHoldMs: 0 });
    await db.set(key!, { heldBy: process.pid });
    out({ ok: 1, mode, holding: key, pid: process.pid });
    setInterval(() => {}, 60_000); // stay alive; killed by the parent
    return;
  }

  if (mode === 'storm') {
    // storm <dir> <shardCount> <shard> <seed> <n> [compactThresholdBytes] [doCompact]
    // Deterministic mixed write storm onto ONE shard: sets, same-key updates,
    // dels, same-shard atomic batches (TYPE_BATCH frames), short/long TTL sets
    // and dt changes. Reports the exact appended frame count.
    const [dir, shardCount, shard, seed, n, compactThresholdBytes = '0', doCompact = '0'] = rest;
    const shards = Number(shardCount);
    const target = Number(shard);
    const db = await ClusterDb.open({
      dir: dir!,
      shardCount: shards,
      valueCodec: 'json',
      fsyncPolicy: 'no',
      lockHoldMs: 0,
      compactThresholdBytes: Number(compactThresholdBytes) > 0 ? Number(compactThresholdBytes) : undefined,
    });
    const doc = (i: number) => ({ n: i, c: `c${i % 7}`, u: `${seed}-u${i}`, t: `alpha beta w${i % 13}` });
    const keys = (function* (): Generator<string> {
      for (let seq = 0; ; seq++) {
        const key = `${seed}:${seq}`;
        if (shardFor(key, shards) === target) yield key;
      }
    })();
    // Loop keys aligned with i (batch keys are NOT tracked here): updates and
    // dels always target a key whose unique value only ever lives on itself.
    const loopKeys: string[] = [];
    let frames = 0;
    const count = Number(n);
    for (let i = 0; i < count; i++) {
      const key = keys.next().value!;
      await withRetry(() => db.set(key, doc(i), { dt: { created: 1700000000000 + i } }), stats);
      frames++;
      loopKeys.push(key);
      if (i % 5 === 1) {
        const j = i - 1;
        await withRetry(
          () => db.set(loopKeys[j]!, { ...doc(j), n: j * 10, t: `alpha changed w${j % 13}` }, { dt: { created: 1700000009000 + j } }),
          stats,
        );
        frames++;
      }
      if (i % 7 === 3) {
        await withRetry(() => db.del(loopKeys[i - 3]!), stats);
        frames++;
      }
      if (i % 50 === 10) {
        // Atomic single-shard batch: three fresh keys plus a del of the first.
        const b1 = keys.next().value!;
        const b2 = keys.next().value!;
        const b3 = keys.next().value!;
        await withRetry(
          () =>
            db.batch([
              { op: 'set', key: b1, value: { ...doc(i + 100000), u: `${seed}-ub${i}a` }, dt: { created: 1700001000000 + i } },
              { op: 'set', key: b2, value: { ...doc(i + 100001), u: `${seed}-ub${i}b`, t: 'alpha batch' } },
              { op: 'set', key: b3, value: { ...doc(i + 100002), u: `${seed}-ub${i}c` } },
              { op: 'del', key: b1 },
            ]),
          stats,
        );
        frames++;
      }
      if (i % 11 === 5) {
        // TTL keys come from the same shard-targeted generator, so every op
        // of the storm appends to this one shard's WAL.
        await withRetry(() => db.set(keys.next().value!, { ...doc(i + 200000), u: `${seed}-uts${i}` }, { ttl: 50 }), stats);
        frames++;
      }
      if (i % 11 === 6) {
        await withRetry(() => db.set(keys.next().value!, { ...doc(i + 300000), u: `${seed}-utl${i}` }, { ttl: 3_600_000 }), stats);
        frames++;
      }
    }
    if (doCompact === '1') await db.compact();
    out({ ok: 1, mode, frames, retries: stats.retries });
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
