// bench/reader-worker.ts
//
// Child-process entrypoint for bench/reader-catchup.ts. Not run directly.
//
//   preload <dir> <shards> <shard> <n> <valueBytes>
//       Write n keys (`pre:<seq>`, all routed to <shard>) then compact, so the
//       shard holds a large snapshot + a nearly-empty WAL when the reader
//       benchmark starts.
//   hammer <dir> <shards> <shard> <valueBytes>
//       Overwrite `hot:<i>` keys on <shard> as fast as possible until SIGTERM,
//       keeping the shard's WAL hot so the parent's reads never see a quiet
//       fingerprint.

import { ClusterDb } from '../src/cluster/index.js';
import { shardFor } from '../src/cluster/utils.js';

const [, , mode, ...rest] = process.argv;

function out(report: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(report) + '\n');
}

/** Keys `${seed}:${n}` (n = 0,1,2,...) that route to `shard`, in order. */
function* keysOnShard(seed: string, shard: number, shards: number): Generator<string> {
  for (let n = 0; ; n++) {
    const key = `${seed}:${n}`;
    if (shardFor(key, shards) === shard) yield key;
  }
}

function value(i: number, valueBytes: number): { p: string; i: number; pad: string } {
  return { p: 'b', i, pad: 'x'.repeat(valueBytes) };
}

async function main(): Promise<void> {
  if (mode === 'preload') {
    const [dir, shards, shard, n, valueBytes] = rest;
    const db = await ClusterDb.open({
      dir: dir!,
      shardCount: Number(shards),
      valueCodec: 'json',
      fsyncPolicy: 'no',
      autoCompact: false,
    });
    const gen = keysOnShard('pre', Number(shard), Number(shards));
    const t0 = performance.now();
    const count = Number(n);
    for (let i = 0; i < count; i++) {
      await db.set(gen.next().value!, value(i, Number(valueBytes)));
    }
    const writeMs = performance.now() - t0;
    const t1 = performance.now();
    await db.compact();
    const compactMs = performance.now() - t1;
    out({ ok: 1, mode, n: count, ms: writeMs, compactMs });
    await db.close();
    return;
  }

  if (mode === 'hammer') {
    const [dir, shards, shard, valueBytes, paceMs = '5'] = rest;
    const db = await ClusterDb.open({
      dir: dir!,
      shardCount: Number(shards),
      valueCodec: 'json',
      fsyncPolicy: 'no',
      // No compaction during the measured window: rotation costs are covered
      // by tests, mixing one into a latency sample only muddies the numbers.
      autoCompact: false,
      // Keep the shard lock held: the default 250ms hold window would force a
      // writer reopen (full WAL replay) several times a second, which would
      // throttle the WAL drip this benchmark is meant to produce.
      lockHoldMs: 0,
    });
    let stop = false;
    process.on('SIGTERM', () => {
      stop = true;
    });
    // A small yield between writes paces the WAL into a steady drip: un-paced,
    // the writer's own group commit coalesces hundreds of frames into one
    // writev, so a reader only observes the file change a few times a second
    // instead of on (almost) every read.
    const pace = Number(paceMs);
    const gen = keysOnShard('hot', Number(shard), Number(shards));
    let i = 0;
    const t0 = performance.now();
    while (!stop) {
      await db.set(gen.next().value!, value(i, Number(valueBytes)));
      i++;
      if (pace > 0) await new Promise((r) => setTimeout(r, pace));
    }
    out({ ok: 1, mode, n: i, ms: performance.now() - t0 });
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
