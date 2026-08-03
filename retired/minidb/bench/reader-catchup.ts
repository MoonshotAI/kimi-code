// bench/reader-catchup.ts
//
// Reader-side catch-up benchmark for ClusterDb: one writer child process
// hammers a single hot shard while this process reads keys on that shard
// through a second, read-only ClusterDb. Measures per-read latency and how
// the reader pool keeps its cached shard instance current.
//
//   BEFORE (full reopen per WAL change):
//     every read whose fingerprint check notices a WAL append closes the
//     cached reader and replays snapshot+WAL from scratch — O(shard size).
//   AFTER (incremental WAL catch-up):
//     only the appended WAL frames are scanned and applied — O(delta).
//
// Run:  node --import tsx bench/reader-catchup.ts
// Env:  READER_BENCH_KEYS=10000,50000  READER_BENCH_WINDOW_MS=8000
//       READER_BENCH_VALUE_BYTES=150   READER_BENCH_SHARDS=4
//       READER_BENCH_PACE_MS=5 (writer sleep between ops ~190 ops/s; the WAL
//       then grows steadily enough that a full-reopen-per-read reader can
//       never catch a quiet fingerprint, which pins the disputed cost)
//
// ---------------------------------------------------------------------------
// RESULTS (this machine, node v24.15.0, valueBytes=150, poll=20ms, window
// 8000ms, 4 shards, hot shard = 1, writer pace=5ms):
//
// BEFORE (2026-07-17, pre-change; run: node --import tsx bench/reader-catchup.ts):
//       keys |    build | reads | qps |  p50 ms |  p95 ms |  p99 ms | reopens | catchups | frames
//     10,000 |  1,054ms |    52 | 6/s |   130.5 |   157.2 |   238.7 |      52 |        0 |      0
//     50,000 |  5,054ms |    14 | 2/s |   532.2 |   860.8 |   860.8 |      14 |        0 |      0
//   Every 20ms poll observes fresh WAL appends, so every read pays a full
//   replay of the whole shard (snapshot + rebuild of all derived indexes):
//   read QPS collapses to ~1/reopen-cost and p50 = the reopen cost itself.
//
// AFTER (same command, with incremental catch-up):
//       keys |    build | reads | qps |  p50 ms |  p95 ms |  p99 ms | reopens | catchups | frames
//     10,000 |    868ms |   374 | 47/s |     0.4 |     1.3 |     5.7 |       0 |      374 |  1,388
//     50,000 |  5,671ms |   368 | 46/s |     0.4 |     2.7 |     6.2 |       0 |      368 |  1,345
//   Every poll applies only the appended WAL frames (catchupFrames == the
//   writer's ops) and never reopens: p50 drops ~330x (@10k) / ~1,330x (@50k);
//   read QPS rises 6→47/s and 2→46/s (bounded only by the 20ms poll grid).
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClusterDb, shardDirName } from '../src/cluster/index.js';
import { shardFor } from '../src/cluster/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, 'reader-worker.ts');

const SIZES = (process.env.READER_BENCH_KEYS ?? '10000,50000').split(',').map(Number);
const WINDOW_MS = Number(process.env.READER_BENCH_WINDOW_MS ?? 8000);
const VALUE_BYTES = Number(process.env.READER_BENCH_VALUE_BYTES ?? 150);
const SHARDS = Number(process.env.READER_BENCH_SHARDS ?? 4);
const PACE_MS = Number(process.env.READER_BENCH_PACE_MS ?? 5);
const POLL_MS = Number(process.env.READER_BENCH_POLL_MS ?? 20);
const HOT_SHARD = 1;

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

interface Report {
  ok: number;
  mode: string;
  n: number;
  ms: number;
  compactMs?: number;
  error?: string;
}

function spawnWorker(args: string[]): { child: ReturnType<typeof spawn>; done: Promise<Report> } {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise<Report>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter((l) => l.startsWith('{'));
      if (code !== 0 || lines.length === 0) {
        reject(new Error(`worker failed (code=${code}) args=${args.join(' ')}\n${stderr}`));
        return;
      }
      const report = JSON.parse(lines[lines.length - 1]!) as Report;
      if (!report.ok) reject(new Error(`worker error args=${args.join(' ')}: ${report.error}`));
      else resolve(report);
    });
  });
  return { child, done };
}

async function runWorker(args: string[]): Promise<Report> {
  const { done } = spawnWorker(args);
  return done;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

/** The exact preload key list (same generator as reader-worker 'preload'). */
function preloadKeys(n: number): string[] {
  const keys: string[] = [];
  for (let seq = 0; keys.length < n; seq++) {
    const key = `pre:${seq}`;
    if (shardFor(key, SHARDS) === HOT_SHARD) keys.push(key);
  }
  return keys;
}

interface Row {
  keys: number;
  buildMs: number;
  reads: number;
  qps: number;
  p50: number;
  p95: number;
  p99: number;
  writerOps: number;
  readerReopens: number;
  incrementalCatchups: number;
  catchupFramesApplied: number;
}

async function benchSize(n: number): Promise<Row> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-reader-bench-'));
  const keys = preloadKeys(n);
  let db: ClusterDb | null = null;
  try {
    // Build the shard (writes + compaction), then start the hot writer.
    const t0 = performance.now();
    await runWorker(['preload', dir, String(SHARDS), String(HOT_SHARD), String(n), String(VALUE_BYTES)]);
    const buildMs = performance.now() - t0;

    db = await ClusterDb.open({ dir, readOnly: true });
    // Warm the reader cache (this first open pays the full replay once).
    for (let i = 0; i < 3; i++) await db.get(keys[i]!);
    const stats0 = db.stats();

    const hammer = spawnWorker(['hammer', dir, String(SHARDS), String(HOT_SHARD), String(VALUE_BYTES), String(PACE_MS)]);
    // The hammer's own shard open replays the (large) shard first, so it only
    // starts appending hundreds of ms after spawn. Wait for the WAL to grow
    // once before measuring, or the early window samples a quiet file.
    const walPath = path.join(dir, shardDirName(HOT_SHARD, SHARDS), 'db.wal');
    const walBase = await fs.stat(walPath).then((s) => s.size, () => -1);
    for (let waited = 0; ; waited += 50) {
      const cur = await fs.stat(walPath).then((s) => s.size, () => -1);
      if (cur !== walBase || waited > 15_000) break;
      await sleep(50);
    }

    // Poll at a fixed interval rather than busy-looping: with a hot writer the
    // WAL changes between any two polls, so every poll pays exactly one
    // refresh — a full reopen before, an incremental catch-up after. A busy
    // loop instead degenerates into a scheduling lottery between the two
    // processes and measures mostly stale-fingerprint fast paths.
    const lat: number[] = [];
    const w0 = performance.now();
    const deadline = w0 + WINDOW_MS;
    let i = 0;
    while (performance.now() < deadline) {
      await sleep(POLL_MS);
      const t = performance.now();
      await db.get(keys[i % keys.length]!);
      lat.push(performance.now() - t);
      i++;
    }
    const windowMs = performance.now() - w0;

    hammer.child.kill('SIGTERM');
    const report = await Promise.race([
      hammer.done,
      sleep(10_000).then(() => {
        hammer.child.kill('SIGKILL');
        return hammer.done;
      }),
    ]);

    lat.sort((a, b) => a - b);
    const stats1 = db.stats();
    return {
      keys: n,
      buildMs,
      reads: lat.length,
      qps: (lat.length / windowMs) * 1000,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      p99: percentile(lat, 99),
      writerOps: report.n,
      readerReopens: stats1.readerReopens - stats0.readerReopens,
      incrementalCatchups: (stats1.incrementalCatchups ?? 0) - (stats0.incrementalCatchups ?? 0),
      catchupFramesApplied: (stats1.catchupFramesApplied ?? 0) - (stats0.catchupFramesApplied ?? 0),
    };
  } finally {
    if (db) await db.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log(
    `\nClusterDb reader catch-up benchmark  (value=${VALUE_BYTES}B pad, window=${WINDOW_MS}ms, poll=${POLL_MS}ms, S=${SHARDS}, hot shard=${HOT_SHARD}, writer pace=${PACE_MS}ms, fsync=no, node ${process.version})`,
  );
  const rows: Row[] = [];
  for (const n of SIZES) {
    process.stdout.write(`building shard with ${fmt(n)} keys ... `);
    const row = await benchSize(n);
    rows.push(row);
    console.log(
      `built in ${fmt(row.buildMs)}ms; reads=${fmt(row.reads)} (${fmt(row.qps)}/s), ` +
        `p50=${row.p50.toFixed(1)}ms p95=${row.p95.toFixed(1)}ms p99=${row.p99.toFixed(1)}ms, ` +
        `writerOps=${fmt(row.writerOps)}, fullReopens=${fmt(row.readerReopens)}, ` +
        `incrementalCatchups=${fmt(row.incrementalCatchups)}, catchupFrames=${fmt(row.catchupFramesApplied)}`,
    );
  }

  console.log(`\n  ${'keys'.padStart(8)} | ${'build'.padStart(8)} | ${'reads'.padStart(7)} | ${'qps'.padStart(8)} | ${'p50 ms'.padStart(8)} | ${'p95 ms'.padStart(8)} | ${'p99 ms'.padStart(8)} | ${'reopens'.padStart(8)} | ${'catchups'.padStart(9)} | ${'frames'.padStart(9)}`);
  for (const r of rows) {
    console.log(
      `  ${fmt(r.keys).padStart(8)} | ${fmt(r.buildMs).padStart(8)} | ${fmt(r.reads).padStart(7)} | ${fmt(r.qps).padStart(8)} | ${r.p50.toFixed(1).padStart(8)} | ${r.p95.toFixed(1).padStart(8)} | ${r.p99.toFixed(1).padStart(8)} | ${fmt(r.readerReopens).padStart(8)} | ${fmt(r.incrementalCatchups).padStart(9)} | ${fmt(r.catchupFramesApplied).padStart(9)}`,
    );
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
