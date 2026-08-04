// bench/bench.js
//
// Throughput / latency / lifecycle benchmarks for MiniDb, on fixed-seed
// synthetic data. Every scenario reports wall time, event-loop-delay and peak
// heap/RSS, and the whole run is emitted as machine-readable JSON (stable
// field names, `schemaVersion: 1`) so later phases can diff before/after.
//
// Run:  npm run bench                 (human output + JSON on stdout)
//       node --import tsx bench/bench.ts --json .tmp/bench.json
//       node --import tsx bench/bench.ts --quick   (small sizes, for tests)
//
// Knobs (env): N, NSMALL (throughput sizes), BENCH_SEED, BENCH_IDLE_MS.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { MiniDb } from '../src/index.js';

const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const ops = (n, ms) => `${fmt((n / ms) * 1000)} ops/s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-bench-'));
}

// ---- fixed-seed synthetic data ----------------------------------------------

/** mulberry32: tiny deterministic PRNG so every bench run sees the same data. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LATIN_VOCAB =
  'wal sync snapshot compaction recovery index query cache buffer frame codec store delta merge rotate flush token parse schema server client socket thread worker queue stream ledger journal cursor segment batch commit'.split(
    ' ',
  );
const CJK_VOCAB = ['持久化', '快照', '索引', '恢复', '压缩', '查询', '缓存', '日志', '事务', '复制'];
// Needles planted at deterministic intervals so query hit counts are stable.
const NEEDLES = [
  { term: 'walrus', every: 97 },
  { term: '持久化', every: 131 },
  { term: 'checkpoint', every: 257 },
];

/** Deterministic pseudo-message corpus: `count` docs of ~25 words each. */
function makeMessages(count, seed) {
  const rng = mulberry32(seed);
  const pick = (arr) => arr[(rng() * arr.length) | 0];
  const docs = [];
  for (let i = 0; i < count; i++) {
    const words = [];
    const n = 20 + ((rng() * 15) | 0);
    for (let w = 0; w < n; w++) words.push(rng() < 0.15 ? pick(CJK_VOCAB) : pick(LATIN_VOCAB));
    for (const { term, every } of NEEDLES) if (i % every === 0) words.push(term);
    docs.push({ key: `m${i}`, body: words.join(' '), ts: 1_700_000_000_000 + i * 1000 });
  }
  return docs;
}

// ---- measurement machinery ----------------------------------------------------

const MIB = 1024 * 1024;

function percentileOf(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function latencySummary(samples) {
  if (!samples || samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentileOf(sorted, 50),
    p95: percentileOf(sorted, 95),
    p99: percentileOf(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

/** Sample process.memoryUsage() on a timer and keep the peaks. */
class MemSampler {
  constructor() {
    this.peakRssBytes = 0;
    this.peakHeapUsedBytes = 0;
    this.timer = null;
  }
  start() {
    const sample = () => {
      const mu = process.memoryUsage();
      if (mu.rss > this.peakRssBytes) this.peakRssBytes = mu.rss;
      if (mu.heapUsed > this.peakHeapUsedBytes) this.peakHeapUsedBytes = mu.heapUsed;
    };
    sample();
    this.timer = setInterval(sample, 25);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return { peakRssBytes: this.peakRssBytes, peakHeapUsedBytes: this.peakHeapUsedBytes };
  }
}

const results = [];

/** Histogram means are NaN when no sample was recorded (a scenario that never
 *  yielded the event loop); normalize so the JSON stays numeric. */
const finite = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0);

/** Run one scenario: time it, capture event-loop delay + memory peaks, record
 *  a stable-shaped JSON row, and print the human line. */
async function scenario(name, fn, { ops: opCount, extra } = {}) {
  if (global.gc) global.gc();
  const eld = monitorEventLoopDelay();
  const mem = new MemSampler();
  const latencies = [];
  eld.enable();
  mem.start();
  const t0 = performance.now();
  const out = (await fn({ lat: (ms) => latencies.push(ms) })) || {};
  const durationMs = performance.now() - t0;
  const memPeaks = mem.stop();
  eld.disable();
  const row = {
    name,
    durationMs: Math.round(durationMs * 1000) / 1000,
    ops: opCount,
    opsPerSec: opCount ? Math.round((opCount / durationMs) * 1000) : undefined,
    latencyMs: latencySummary(latencies),
    eventLoopDelayMs: {
      mean: finite(eld.mean / 1e6),
      p50: finite(eld.percentile(50) / 1e6),
      p95: finite(eld.percentile(95) / 1e6),
      p99: finite(eld.percentile(99) / 1e6),
      max: finite(eld.max / 1e6),
    },
    peakRssBytes: memPeaks.peakRssBytes,
    peakHeapUsedBytes: memPeaks.peakHeapUsedBytes,
    extra: { ...extra, ...out.extra },
  };
  results.push(row);
  const tail = opCount ? `   -> ${ops(opCount, durationMs)}` : '';
  console.log(
    `  ${name.padEnd(46)} ${durationMs.toFixed(1).padStart(9)} ms${tail}` +
      `   [eld p95 ${row.eventLoopDelayMs.p95.toFixed(1)} ms, peak rss ${(row.peakRssBytes / MIB).toFixed(0)} MiB]`,
  );
  return row;
}

// ---- scenarios ------------------------------------------------------------------

async function throughputScenarios({ N, NSMALL, VALUE }) {
  // --- baseline: raw JS Map ---
  {
    const m = new Map();
    await scenario(
      'baseline: raw Map set (in-memory)',
      () => {
        for (let i = 0; i < N; i++) m.set(`k${i}`, VALUE);
      },
      { ops: N },
    );
    await scenario(
      'baseline: raw Map get (in-memory)',
      () => {
        let s = 0;
        for (let i = 0; i < N; i++) if (m.get(`k${i}`)) s++;
        return s;
      },
      { ops: N },
    );
  }

  // --- DB writes, fsyncPolicy = no ---
  {
    const dir = await tmpDir();
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false });
    await scenario(
      'DB set concurrent, fsync=no (group commit)',
      async () => {
        const p = [];
        for (let i = 0; i < N; i++) p.push(db.set(`k${i}`, VALUE));
        await Promise.all(p);
        return {
          extra: {
            walGroupCommits: db.stats.walGroupCommits,
            walGroupCommitFrames: db.stats.walGroupCommitFrames,
            walMaxQueuedBytes: db.stats.walMaxQueuedBytes,
          },
        };
      },
      { ops: N },
    );
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  // --- DB writes, fsyncPolicy = everysec ---
  {
    const dir = await tmpDir();
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'everysec', autoCompact: false });
    await scenario(
      'DB set concurrent, fsync=everysec',
      async () => {
        const p = [];
        for (let i = 0; i < N; i++) p.push(db.set(`k${i}`, VALUE));
        await Promise.all(p);
      },
      { ops: N },
    );
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  // --- DB writes, sequential await-each, fsync=always (worst case) ---
  {
    const dir = await tmpDir();
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'always', autoCompact: false });
    await scenario(
      `DB set sequential, fsync=always (N=${fmt(NSMALL)})`,
      async ({ lat }) => {
        for (let i = 0; i < NSMALL; i++) {
          const t = performance.now();
          await db.set(`k${i}`, VALUE);
          lat(performance.now() - t);
        }
      },
      { ops: NSMALL },
    );
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  // --- DB reads (in-memory) ---
  {
    const dir = await tmpDir();
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false });
    const p = [];
    for (let i = 0; i < N; i++) p.push(db.set(`k${i}`, VALUE));
    await Promise.all(p);
    await scenario(
      'DB get (in-memory, after load)',
      ({ lat }) => {
        let s = 0;
        for (let i = 0; i < N; i++) {
          const t = performance.now();
          if (db.get(`k${i}`)) s++;
          lat(performance.now() - t);
        }
        return s;
      },
      { ops: N },
    );
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Populate a db with `count` string keys via large batch frames (fast prep),
 *  close it, then measure a cold open and (for the largest size) a compaction. */
async function coldOpenScenarios({ sizes, VALUE }) {
  for (const count of sizes) {
    const dir = await tmpDir();
    await scenario(
      `populate ${fmt(count)} keys (batch frames)`,
      async () => {
        const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false });
        const CHUNK = 2000;
        for (let base = 0; base < count; base += CHUNK) {
          const ops = [];
          for (let i = base; i < Math.min(base + CHUNK, count); i++) ops.push({ op: 'set', key: `k${i}`, value: VALUE });
          await db.batch(ops);
        }
        await db.close();
      },
      { ops: count },
    );

    await scenario(
      `cold open ${fmt(count)} keys`,
      async () => {
        const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'everysec', autoCompact: false });
        const s = db.stats;
        await db.close();
        return {
          extra: {
            keys: count,
            recoveryBytes: s.recoveryBytes,
            recoveryFrames: s.recoveryFrames,
            recoveryDurationMs: s.recoveryDurationMs,
            indexRebuildDurationMs: s.indexRebuildDurationMs,
            textRebuildDurationMs: s.textRebuildDurationMs,
            walFsyncs: s.walFsyncs,
          },
        };
      },
      { ops: count },
    );

    // Compaction of the largest populated set doubles as the plan's
    // "100k records compaction" scenario.
    if (count === Math.max(...sizes)) {
      await scenario(
        `compact ${fmt(count)} records`,
        async () => {
          const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false });
          await db.compact();
          const s = db.stats;
          await db.close();
          return {
            extra: {
              keys: count,
              compactionDurationMs: s.compactionDurationMs,
              compactionSnapshotDurationMs: s.compactionSnapshotDurationMs,
              compactionRotationDurationMs: s.compactionRotationDurationMs,
              compactionPostingsDurationMs: s.compactionPostingsDurationMs,
              snapshotBytesWritten: s.snapshotBytesWritten,
            },
          };
        },
        { ops: count },
      );
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Word (default tokenizer) and n-gram searches over the seeded message corpus. */
async function searchScenarios({ sizes, seed }) {
  const WORD_QUERIES = ['walrus', '持久化', 'wal snapshot', 'nonexistentxyz123'];
  const NGRAM_QUERIES = ['walru', '持久', 'heckpo'];
  const RUNS = 7;
  for (const count of sizes) {
    const dir = await tmpDir();
    const docs = makeMessages(count, seed);
    const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    await scenario(
      `build ${fmt(count)} messages + word/ngram indexes`,
      async () => {
        const CHUNK = 1000;
        for (let base = 0; base < docs.length; base += CHUNK) {
          await db.batch(docs.slice(base, base + CHUNK).map((d) => ({ op: 'set', key: d.key, value: d })));
        }
        await db.createTextIndex('word', { fields: ['body'] });
        await db.createTextIndex('ngram', { fields: ['body'], tokenizer: 'ngram' });
      },
      { ops: count, extra: { docs: count } },
    );

    for (const [index, queries] of [
      ['word', WORD_QUERIES],
      ['ngram', NGRAM_QUERIES],
    ] as const) {
      await scenario(
        `search ${index} over ${fmt(count)} messages`,
        ({ lat }) => {
          const perQuery = [];
          for (const q of queries) {
            let hits = 0;
            const times = [];
            for (let r = 0; r < RUNS; r++) {
              const t = performance.now();
              hits = db.search(index, q, { limit: 10 }).length;
              const ms = performance.now() - t;
              lat(ms);
              times.push(ms);
            }
            times.sort((a, b) => a - b);
            perQuery.push({ q, hits, medianMs: Math.round(times[(times.length / 2) | 0] * 1000) / 1000 });
          }
          return { extra: { docs: count, runs: RUNS, queries: perQuery } };
        },
        { ops: queries.length * RUNS },
      );
    }
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** The phase-1 acceptance scenario: an everysec db idles with ZERO background
 *  fsyncs, and a single write re-arms exactly one sync before it goes quiet. */
async function walIdleScenarios({ idleMs }) {
  {
    const dir = await tmpDir();
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'everysec', autoCompact: false });
    const before = db.stats.walFsyncs;
    await scenario(
      `idle everysec ${idleMs / 1000}s: background fsyncs`,
      async () => {
        await sleep(idleMs);
        return { extra: { idleMs, walFsyncs: db.stats.walFsyncs - before, walFsyncErrors: db.stats.walFsyncErrors } };
      },
    );
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
  {
    const dir = await tmpDir();
    // A short interval keeps the re-arm behavior visible in any mode: the
    // write dirties the WAL, the next tick syncs once, then it goes quiet.
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'everysec', syncIntervalMs: 100, autoCompact: false });
    await db.set('k', 'v');
    const before = db.stats.walFsyncs;
    const windowMs = 500;
    await scenario('write then idle: fsyncs in the dirty window', async () => {
      await sleep(windowMs);
      return { extra: { syncIntervalMs: 100, idleMs: windowMs, walFsyncs: db.stats.walFsyncs - before } };
    });
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const jsonIdx = argv.indexOf('--json');
  const jsonPath = jsonIdx !== -1 ? argv[jsonIdx + 1] : process.env.BENCH_JSON;
  const quick = argv.includes('--quick') || process.env.BENCH_QUICK === '1';

  const SEED = Number(process.env.BENCH_SEED || 42);
  const VALUE = 'x'.repeat(100); // 100-byte values
  const N = quick ? 5_000 : Number(process.env.N || 200_000);
  const NSMALL = quick ? 300 : Number(process.env.NSMALL || 3_000);
  const COLD_OPEN_SIZES = quick ? [1_000, 2_000] : [10_000, 50_000, 100_000];
  const SEARCH_SIZES = quick ? [1_000, 2_000] : [10_000, 100_000];
  const IDLE_MS = quick ? 400 : Number(process.env.BENCH_IDLE_MS || 10_000);

  console.log(
    `\nminidb benchmark  (N=${fmt(N)}, value=${VALUE.length}B, seed=${SEED}${quick ? ', QUICK' : ''}, node ${process.version})\n`,
  );

  await throughputScenarios({ N, NSMALL, VALUE });
  await coldOpenScenarios({ sizes: COLD_OPEN_SIZES, VALUE });
  await searchScenarios({ sizes: SEARCH_SIZES, seed: SEED });
  await walIdleScenarios({ idleMs: IDLE_MS });

  const report = {
    schemaVersion: 1,
    tool: 'minidb/bench',
    quick,
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    seed: SEED,
    scenarios: results,
  };
  const json = JSON.stringify(report, null, 2);
  if (jsonPath) {
    await fs.mkdir(path.dirname(path.resolve(jsonPath)), { recursive: true });
    await fs.writeFile(jsonPath, json + '\n', 'utf8');
    console.log(`\nJSON report written to ${jsonPath}`);
  } else {
    console.log('\n--- bench JSON ---');
    console.log(json);
  }
  console.log('\ndone.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
