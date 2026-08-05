// bench/maintenance.ts
//
// Stage-6 acceptance benchmark: heavy maintenance (workerized full-text
// generation rebuild, compaction) must not stall the event loop or ordinary
// requests. Every scenario records request latencies, event-loop-delay
// (p95/p99/max), process RSS peaks (worker threads share the process) and the
// temp-generation disk peak, emitted as machine-readable JSON.
//
// Run:  node --import tsx bench/maintenance.ts            (full: 1M messages)
//       node --import tsx bench/maintenance.ts --quick    (small sizes, smoke)
//       node --import tsx bench/maintenance.ts --json .tmp/maintenance.json
//
// Knobs (env): N (corpus messages), NDISK (disk-mode size), BENCH_SEED,
// BENCH_DIR (reuse an already-populated corpus dir instead of a fresh tmp
// one — skips the ~1h populate phase; the corpus itself stays on disk).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { MiniDb } from '../src/index.js';

const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const MIB = 1024 * 1024;

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-maint-bench-'));
}

// ---- fixed-seed synthetic data (same generator family as bench.ts) ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ (t >>> 14);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LATIN_VOCAB =
  'wal sync snapshot compaction recovery index query cache buffer frame codec store delta merge rotate flush token parse schema server client socket thread worker queue stream ledger journal cursor segment batch commit'.split(
    ' ',
  );
const CJK_VOCAB = ['持久化', '快照', '索引', '恢复', '压缩', '查询', '缓存', '日志', '事务', '复制'];

function makeMessages(count, seed) {
  const rng = mulberry32(seed);
  const pick = (arr) => arr[(rng() * arr.length) | 0];
  const docs = [];
  for (let i = 0; i < count; i++) {
    const words = [];
    const n = 20 + ((rng() * 15) | 0);
    for (let w = 0; w < n; w++) words.push(rng() < 0.15 ? pick(CJK_VOCAB) : pick(LATIN_VOCAB));
    if (i % 97 === 0) words.push('walrus');
    if (i % 131 === 0) words.push('持久化');
    docs.push({ key: `m${i}`, body: words.join(' '), ts: 1_700_000_000_000 + i * 1000 });
  }
  return docs;
}

// ---- measurement machinery ----------------------------------------------------

function percentileOf(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function latencySummary(samples) {
  if (!samples || samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentileOf(sorted, 50),
    p95: percentileOf(sorted, 95),
    p99: percentileOf(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

const finite = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0);

/** Samples process RSS (covers worker threads — they share the process), the
 *  main isolate's heapUsed, and the on-disk size of the generations dir. */
class ResourceSampler {
  constructor(dir) {
    this.dir = dir;
    this.peakRssBytes = 0;
    this.peakMainHeapBytes = 0;
    this.peakGenDirBytes = 0;
    this.timer = null;
  }
  start() {
    const sample = async () => {
      const mu = process.memoryUsage();
      if (mu.rss > this.peakRssBytes) this.peakRssBytes = mu.rss;
      if (mu.heapUsed > this.peakMainHeapBytes) this.peakMainHeapBytes = mu.heapUsed;
      try {
        let total = 0;
        const gens = path.join(this.dir, 'generations');
        for (const g of await fs.readdir(gens)) {
          const gdir = path.join(gens, g);
          for (const f of await fs.readdir(gdir)) {
            total += (await fs.stat(path.join(gdir, f))).size;
          }
        }
        if (total > this.peakGenDirBytes) this.peakGenDirBytes = total;
      } catch {
        /* generations dir may not exist yet */
      }
    };
    void sample();
    this.timer = setInterval(() => void sample(), 100);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return {
      peakRssBytes: this.peakRssBytes,
      peakMainHeapBytes: this.peakMainHeapBytes,
      peakGenDirBytes: this.peakGenDirBytes,
    };
  }
}

const results = [];

/** Run one scenario under an event-loop-delay monitor + resource sampler. The
 *  wrapped fn returns { latencies, requests, extra }. */
async function scenario(name, dir, fn) {
  if (global.gc) global.gc();
  const eld = monitorEventLoopDelay({ resolution: 20 });
  const sampler = new ResourceSampler(dir);
  eld.enable();
  sampler.start();
  const t0 = performance.now();
  const out = (await fn()) || {};
  const durationMs = performance.now() - t0;
  const peaks = sampler.stop();
  eld.disable();
  const row = {
    name,
    durationMs: Math.round(durationMs * 1000) / 1000,
    requests: out.requests,
    requestLatencyMs: latencySummary(out.latencies),
    eventLoopDelayMs: {
      p95: finite(eld.percentile(95) / 1e6),
      p99: finite(eld.percentile(99) / 1e6),
      max: finite(eld.max / 1e6),
    },
    ...peaks,
    extra: out.extra,
  };
  results.push(row);
  const lat = row.requestLatencyMs;
  console.log(
    `  ${name.padEnd(52)} ${durationMs.toFixed(0).padStart(9)} ms` +
      `   [eld p99 ${row.eventLoopDelayMs.p99.toFixed(1)} / max ${row.eventLoopDelayMs.max.toFixed(1)} ms` +
      (lat ? `, req p99 ${lat.p99.toFixed(1)} / max ${lat.max.toFixed(1)} ms (${lat.count} reqs)` : '') +
      `, rss ${(peaks.peakRssBytes / MIB).toFixed(0)} MiB]`,
  );
  return row;
}

/** Mixed request load driven until `shouldStop()` reports done: word/ngram
 *  searches + point gets + a slow write drip. Searches go through the BOUNDED
 *  path with the same budgets kap-server uses in production (maxVisits: 250k,
 *  small limit) — an unbounded search decodes whole hot-bucket postings lists
 *  synchronously at 1M scale, which measures the caller's mistake, not the
 *  maintenance behavior. */
async function driveLoad(db, shouldStop, { writeEvery = 200 } = {}) {
  const SEARCH_BUDGET = { op: 'AND', limit: 11, maxVisits: 250_000 };
  const latencies = [];
  let requests = 0;
  let writes = 0;
  let i = 0;
  const timed = async (p) => {
    const t = performance.now();
    await p;
    latencies.push(performance.now() - t);
    requests++;
  };
  while (!shouldStop()) {
    await timed(db.searchBoundedAsync('word', 'walrus', SEARCH_BUDGET));
    await timed(db.searchBoundedAsync('ngram', 'walru', SEARCH_BUDGET));
    await timed(db.searchBoundedAsync('word', '持久化', SEARCH_BUDGET));
    for (let k = 0; k < 5; k++) await timed(db.getAsync(`m${(i * 7 + k * 9973) % LOAD_KEY_SPACE}`));
    if (++i % writeEvery === 0) {
      writes++;
      // Writes during maintenance also feed the build's mutation queue — keep
      // them part of the measured load.
      await timed(db.set(`live-${writes}`, { body: 'live write during maintenance walrus', ts: Date.now() }));
    }
    // Yield to the event loop every batch: a warm-cache request resolves in a
    // microtask, so without this the loop starves timers/I/O (and with them
    // the maintenance task itself) — real servers always have I/O gaps.
    await new Promise((r) => setImmediate(r));
  }
  return { latencies, requests, extra: { writesDuringMaintenance: writes } };
}

/** Drive the load while a maintenance promise is in flight. */
async function driveLoadUntil(db, maintenance, opts) {
  let done = false;
  maintenance.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  const out = await driveLoad(db, () => done, opts);
  await maintenance;
  return out;
}

/** Drive the same load for a fixed wall-clock window (no-maintenance baseline:
 *  separates the query path's own cost from the maintenance's added cost). */
async function driveLoadFor(db, ms) {
  const end = performance.now() + ms;
  return driveLoad(db, () => performance.now() >= end);
}

let LOAD_KEY_SPACE = 1;

// ---- scenarios ------------------------------------------------------------------

/** Populate the corpus, build word + ngram indexes over the bulk, then dirty
 *  the indexes with a tail burst so the manual rebuild has real worker work.
 *  With BENCH_DIR pointing at an already-populated corpus (marker file next
 *  to it), the expensive insert/index phase is skipped and only a small dirty
 *  write keeps the rebuild worker-eligible. */
async function populate(dir, docs, { tail = 0.05 } = {}) {
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  const marker = `${dir}.populated.json`;
  let reusable = false;
  try {
    reusable = JSON.parse(await fs.readFile(marker, 'utf8')).count === docs.length;
  } catch {
    /* no marker */
  }
  if (reusable) {
    console.log('  (reusing the populated corpus)');
    await db.set(`bench-dirty-${Date.now()}`, { body: 'walrus 持久化', ts: Date.now() });
    return db;
  }
  const CHUNK = 1000;
  const bulk = Math.floor(docs.length * (1 - tail));
  for (let base = 0; base < bulk; base += CHUNK) {
    await db.batch(docs.slice(base, Math.min(base + CHUNK, bulk)).map((d) => ({ op: 'set', key: d.key, value: d })));
  }
  await db.createTextIndex('word', { fields: ['body'] });
  await db.createTextIndex('ngram', { fields: ['body'], tokenizer: 'ngram' });
  // Tail burst AFTER the initial build: the indexes are dirty, so the manual
  // rebuild below goes through the worker instead of the clean re-publish.
  for (let base = bulk; base < docs.length; base += CHUNK) {
    await db.batch(docs.slice(base, Math.min(base + CHUNK, docs.length)).map((d) => ({ op: 'set', key: d.key, value: d })));
  }
  await fs.writeFile(marker, JSON.stringify({ count: docs.length }));
  return db;
}

async function rebuildUnderLoadScenario({ docs, quick, baselineMs }) {
  const dir = process.env.BENCH_DIR ?? (await tmpDir());
  const keep = Boolean(process.env.BENCH_DIR);
  console.log(`\n[1] workerized full-text rebuild under load (${fmt(docs.length)} messages)`);
  const db = await populate(dir, docs);
  LOAD_KEY_SPACE = docs.length;

  await scenario(`baseline load (no maintenance), N=${fmt(docs.length)}`, dir, () => driveLoadFor(db, baselineMs));

  const row = await scenario(`rebuild generation (worker) under load, N=${fmt(docs.length)}`, dir, async () => {
    const maintenance = db.rebuildGeneration();
    const load = await driveLoadUntil(db, maintenance);
    const s = db.stats;
    return {
      ...load,
      extra: {
        ...load.extra,
        docs: docs.length,
        textWorkerBuilds: s.textWorkerBuilds,
        textWorkerFallbacks: s.textWorkerFallbacks,
        generationBuildDurationMs: s.generationBuildDurationMs,
        quick,
      },
    };
  });

  await scenario(`compaction under load, N=${fmt(docs.length)}`, dir, async () => {
    const maintenance = db.compact();
    const load = await driveLoadUntil(db, maintenance);
    const s = db.stats;
    return {
      ...load,
      extra: {
        ...load.extra,
        compactionDurationMs: s.compactionDurationMs,
        compactionRotationDurationMs: s.compactionRotationDurationMs,
      },
    };
  });

  await db.close();
  if (!keep) await fs.rm(dir, { recursive: true, force: true });
  return row;
}

async function coldOpenScenario({ docs }) {
  const dir = await tmpDir();
  console.log(`\n[2] cold open / recovery (${fmt(docs.length)} messages)`);
  const db = await populate(dir, docs, { tail: 0 });
  await db.rebuildGeneration();
  await db.close();
  await scenario(`cold open (generation + WAL delta), N=${fmt(docs.length)}`, dir, async () => {
    const db2 = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    const s = db2.stats;
    await db2.close();
    return { extra: { recoveryBytes: s.recoveryBytes, recoveryFrames: s.recoveryFrames, recoveryDurationMs: s.recoveryDurationMs } };
  });
  await fs.rm(dir, { recursive: true, force: true });
}

async function diskModeScenario({ count, seed }) {
  const dir = await tmpDir();
  console.log(`\n[3] disk-mode random reads via async APIs (${fmt(count)} messages)`);
  const docs = makeMessages(count, seed);
  let db = await MiniDb.open({ dir, valueCodec: 'json', valueMode: 'disk', fsyncPolicy: 'no', autoCompact: false });
  const CHUNK = 1000;
  for (let base = 0; base < docs.length; base += CHUNK) {
    await db.batch(docs.slice(base, Math.min(base + CHUNK, docs.length)).map((d) => ({ op: 'set', key: d.key, value: d })));
  }
  await db.createTextIndex('word', { fields: ['body'] });
  await db.close();
  // Reopen: the value cache starts cold, so random gets hit positioned reads.
  db = await MiniDb.open({ dir, valueCodec: 'json', valueMode: 'disk', fsyncPolicy: 'no', autoCompact: false });
  const rng = mulberry32(seed ^ 0x5eed);
  await scenario(`disk-mode random getAsync/searchAsync, N=${fmt(count)}`, dir, async () => {
    const latencies = [];
    const ROUNDS = 200;
    for (let r = 0; r < ROUNDS; r++) {
      let t = performance.now();
      await db.getAsync(`m${(rng() * count) | 0}`);
      latencies.push(performance.now() - t);
      t = performance.now();
      await db.searchBoundedAsync('word', 'walrus', { limit: 10, maxVisits: 250_000 });
      latencies.push(performance.now() - t);
    }
    return { latencies, requests: latencies.length, extra: { rounds: ROUNDS } };
  });
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
}

async function main() {
  const argv = process.argv.slice(2);
  const jsonIdx = argv.indexOf('--json');
  const jsonPath = jsonIdx !== -1 ? argv[jsonIdx + 1] : process.env.BENCH_JSON;
  const quick = argv.includes('--quick') || process.env.BENCH_QUICK === '1';

  const SEED = Number(process.env.BENCH_SEED || 42);
  const N = quick ? 20_000 : Number(process.env.N || 1_000_000);
  const NDISK = quick ? 5_000 : Number(process.env.NDISK || 100_000);

  console.log(
    `\nminidb stage-6 maintenance benchmark  (N=${fmt(N)}, disk N=${fmt(NDISK)}, seed=${SEED}${quick ? ', QUICK' : ''}, node ${process.version})\n`,
  );

  const docs = makeMessages(N, SEED);
  await rebuildUnderLoadScenario({ docs, quick, baselineMs: quick ? 5_000 : 30_000 });
  await coldOpenScenario({ docs: quick ? docs : docs.slice(0, 100_000) });
  await diskModeScenario({ count: NDISK, seed: SEED });

  const baseline = results.find((r) => r.name.startsWith('baseline load'));
  const maintenance = results.filter((r) => r.name.includes('under load'));
  const report = {
    schemaVersion: 1,
    tool: 'minidb/bench/maintenance',
    quick,
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    seed: SEED,
    acceptance: {
      requestP99Under1s: maintenance.every((r) => !r.requestLatencyMs || r.requestLatencyMs.p99 < 1000),
      eldP99Under50ms: maintenance.every((r) => r.eventLoopDelayMs.p99 < 50),
      eldMaxUnder100ms: maintenance.every((r) => r.eventLoopDelayMs.max < 100),
    },
    /** The plan's absolute eld targets assume cheap ordinary requests; at 1M
     *  scale the bounded query path itself has ~50-130ms slices, so the
     *  meaningful check is what maintenance ADDS over the no-maintenance
     *  baseline running the identical load. */
    baselineVsMaintenance: baseline
      ? maintenance.map((r) => ({
          scenario: r.name,
          requestP99Ms: r.requestLatencyMs?.p99,
          baselineRequestP99Ms: baseline.requestLatencyMs?.p99,
          eldP99Ms: r.eventLoopDelayMs.p99,
          baselineEldP99Ms: baseline.eventLoopDelayMs.p99,
          eldMaxMs: r.eventLoopDelayMs.max,
          baselineEldMaxMs: baseline.eventLoopDelayMs.max,
        }))
      : undefined,
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
  const a = report.acceptance;
  console.log(
    `\nacceptance (maintenance scenarios): request p99 < 1s: ${a.requestP99Under1s ? 'PASS' : 'FAIL'}` +
      ` | eld p99 < 50ms: ${a.eldP99Under50ms ? 'PASS' : 'FAIL'} | eld max < 100ms: ${a.eldMaxUnder100ms ? 'PASS' : 'FAIL'}`,
  );
  if (report.baselineVsMaintenance) {
    for (const c of report.baselineVsMaintenance) {
      console.log(
        `  ${c.scenario}: req p99 ${c.requestP99Ms?.toFixed(1)} vs baseline ${c.baselineRequestP99Ms?.toFixed(1)} ms` +
          ` | eld p99 ${c.eldP99Ms.toFixed(1)} vs ${c.baselineEldP99Ms.toFixed(1)} | eld max ${c.eldMaxMs.toFixed(1)} vs ${c.baselineEldMaxMs.toFixed(1)}`,
      );
    }
  }
  console.log('\ndone.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
