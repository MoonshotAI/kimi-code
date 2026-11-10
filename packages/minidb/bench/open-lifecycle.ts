// bench/open-lifecycle.ts
//
// Phase-1 baseline (plan/01-baseline-and-boundaries.md): what MiniDb's open()
// costs the host process, per lifecycle path. Four scenario families —
//   1. small corpus with a healthy published generation;
//   2. a large WAL delta past the generation checkpoint (wal-catch-up);
//   3. a large full-text generation (store image + text images + postings crc);
//   4. a corrupt generation (the full-recovery fallback, then the deferred
//      background text rebuild: the 'degraded' → 'ready' window)
// each measuring the open's wall time, event-loop delay, simulated input
// latency (a setImmediate probe racing the operation — how fast the loop
// services a fresh macrotask, i.e. a keypress handler), and memory peaks, and
// recording the lifecycleStatus() phase breakdown so a generation attach can
// be told apart from a full rebuild by numbers, not by inference.
//
// Run:  node --import tsx bench/open-lifecycle.ts            (full sizes)
//       node --import tsx bench/open-lifecycle.ts --quick    (smoke sizes)
//       node --import tsx bench/open-lifecycle.ts --json .tmp/open-lifecycle.json
//
// Knobs (env): BENCH_SEED.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { MiniDb } from '../src/index.js';
import { GEN_BUILD_WAL_DELTA_BYTES } from '../src/generation-builder.js';

const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const MIB = 1024 * 1024;

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-open-bench-'));
}

// ---- fixed-seed synthetic data (same generator family as bench.ts) ----------

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

// ---- measurement machinery (same conventions as bench.ts) -------------------

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

const finite = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0);

/** Simulated input latency: how long a fresh macrotask (a keypress handler's
 *  setImmediate) waits while the measured operation holds the event loop. */
async function probeInputLatency(stop) {
  const samples = [];
  while (!stop.done) {
    const t = performance.now();
    await new Promise((r) => setImmediate(r));
    samples.push(performance.now() - t);
  }
  return samples;
}

const results = [];

/** Measure one operation (an open, or a degraded→ready wait): wall time,
 *  event-loop delay, input-latency probes, memory peaks. */
async function measure(name, op, extra) {
  if (global.gc) global.gc();
  const eld = monitorEventLoopDelay();
  const mem = new MemSampler();
  const stop = { done: false };
  eld.enable();
  mem.start();
  const probe = probeInputLatency(stop);
  const t0 = performance.now();
  const out = (await op()) || {};
  const durationMs = performance.now() - t0;
  stop.done = true;
  const inputSamples = await probe;
  const memPeaks = mem.stop();
  eld.disable();
  const row = {
    name,
    durationMs: Math.round(durationMs * 1000) / 1000,
    eventLoopDelayMs: {
      mean: finite(eld.mean / 1e6),
      p50: finite(eld.percentile(50) / 1e6),
      p95: finite(eld.percentile(95) / 1e6),
      p99: finite(eld.percentile(99) / 1e6),
      max: finite(eld.max / 1e6),
    },
    inputLatencyMs: latencySummary(inputSamples.map(finite)),
    peakRssBytes: memPeaks.peakRssBytes,
    peakHeapUsedBytes: memPeaks.peakHeapUsedBytes,
    extra: { ...extra, ...out.extra },
  };
  results.push(row);
  const input = row.inputLatencyMs;
  console.log(
    `  ${name.padEnd(52)} ${durationMs.toFixed(1).padStart(9)} ms` +
      `   [eld p99 ${row.eventLoopDelayMs.p99.toFixed(1)} / max ${row.eventLoopDelayMs.max.toFixed(1)} ms` +
      (input ? `, input p99 ${input.p99.toFixed(1)} / max ${input.max.toFixed(1)} ms` : '') +
      `, rss ${(row.peakRssBytes / MIB).toFixed(0)} MiB]`,
  );
  return row;
}

/** The lifecycle fields every open row reports (rounded for a stable JSON). */
function lifecycleExtra(db) {
  const status = db.lifecycleStatus();
  const phases = Object.fromEntries(Object.entries(status.phases).map(([k, v]) => [k, finite(v)]));
  return {
    state: status.state,
    path: status.path,
    textIndexes: status.textIndexes,
    pendingTextIndexes: status.pendingTextIndexes,
    phases,
    generationLoads: db.stats.generationLoads,
    generationLoadFallbacks: db.stats.generationLoadFallbacks,
    walDeltaAppliedOps: db.recoveryInfo?.walDeltaAppliedOps ?? 0,
    recoveryBytes: db.stats.recoveryBytes,
    recoveryFrames: db.stats.recoveryFrames,
    indexRebuildDecoded: db.stats.indexRebuildDecoded,
  };
}

// ---- scenario helpers ---------------------------------------------------------

/** Populate a corpus with word + ngram text indexes and publish a generation.
 *  The runtime wal-growth trigger is suppressed so exactly ONE generation
 *  (the explicit rebuild below) is ever published — the corrupt scenario's
 *  candidate set stays deterministic at any corpus size. */
async function populateWithGeneration(dir, docs) {
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  db.genBuildKickMinIntervalMs = Number.POSITIVE_INFINITY;
  const CHUNK = 1000;
  for (let base = 0; base < docs.length; base += CHUNK) {
    await db.batch(docs.slice(base, base + CHUNK).map((d) => ({ op: 'set', key: d.key, value: d })));
  }
  await db.createTextIndex('word', { fields: ['body'] });
  await db.createTextIndex('ngram', { fields: ['body'], tokenizer: 'ngram' });
  await db.rebuildGeneration();
  await db.close();
}

const OPEN_OPTS = { valueCodec: 'json', fsyncPolicy: 'everysec', autoCompact: false };

/** Scenario 1: a healthy generation attach over a small corpus. */
async function smallCorpusScenario({ docs }) {
  const dir = await tmpDir();
  await populateWithGeneration(dir, docs);
  let db;
  await measure(`open small corpus, healthy generation, N=${fmt(docs.length)}`, async () => {
    db = await MiniDb.open({ dir, ...OPEN_OPTS });
    return { extra: { docs: docs.length, ...lifecycleExtra(db) } };
  });
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
}

/** Scenario 2: a published generation plus a WAL delta just below the
 *  close-time republish threshold — the open is generation-load + wal-catch-up. */
async function largeWalScenario({ docs, deltaBytes }) {
  const dir = await tmpDir();
  await populateWithGeneration(dir, docs);
  // Append a WAL delta past the checkpoint WITHOUT crossing
  // GEN_BUILD_WAL_DELTA_BYTES, so neither the wal-growth trigger nor the
  // close-time publish refresh the generation: the next open must replay it.
  const target = Math.min(deltaBytes, Math.floor(GEN_BUILD_WAL_DELTA_BYTES * 0.8));
  let deltaOps = 0;
  let closePublished = false;
  {
    const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    const generation = db.getIndexGeneration()?.id ?? null;
    const writtenBase = db.stats.walBytesWritten;
    let i = 0;
    while (db.stats.walBytesWritten - writtenBase < target) {
      const ops = [];
      for (let k = 0; k < 100; k++) {
        ops.push({ op: 'set', key: `d${i * 100 + k}`, value: { body: `delta ${i} ${k} ${'y'.repeat(200)}`, ts: 1_700_100_000_000 + i * 100 + k } });
      }
      await db.batch(ops);
      i++;
    }
    deltaOps = i * 100;
    await db.close();
    // A close-time republish would invalidate the scenario (nothing left to
    // replay): verify the WAL delta survived below the threshold.
    closePublished = db.getIndexGeneration()?.id !== generation;
  }
  let db;
  await measure(`open with large WAL delta (${fmt(target)} B), N=${fmt(docs.length)}`, async () => {
    db = await MiniDb.open({ dir, ...OPEN_OPTS });
    return { extra: { docs: docs.length, deltaBytes: target, deltaOps, closePublishedGeneration: closePublished, ...lifecycleExtra(db) } };
  });
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
}

/** Scenario 3: a large full-text generation — store image + text images +
 *  the whole-file postings crc dominate the open. */
async function largeGenerationScenario({ docs }) {
  const dir = await tmpDir();
  await populateWithGeneration(dir, docs);
  let db;
  await measure(`open large full-text generation, N=${fmt(docs.length)}`, async () => {
    db = await MiniDb.open({ dir, ...OPEN_OPTS });
    return { extra: { docs: docs.length, ...lifecycleExtra(db) } };
  });
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
}

/** Scenario 4: a corrupt generation — the open falls back to the legacy full
 *  recovery, returns 'degraded' (the corpus-scale text rebuild is deferred),
 *  and reaches 'ready' when the background bounded build commits. */
async function corruptGenerationScenario({ docs, readyTimeoutMs }) {
  const dir = await tmpDir();
  await populateWithGeneration(dir, docs);
  // Flip one byte inside EVERY generation's store image: the manifest crc
  // rejects every candidate and the next open must take the legacy full
  // recovery (retention keeps a previous generation around as a fallback
  // candidate — corrupting only the newest would measure THAT path instead).
  {
    const gens = path.join(dir, 'generations');
    for (const entry of await fs.readdir(gens)) {
      if (entry.includes('.tmp-')) continue;
      const storeImage = path.join(gens, entry, 'store');
      const raw = await fs.readFile(storeImage);
      raw[Math.floor(raw.length / 2)] ^= 0xff;
      await fs.writeFile(storeImage, raw);
    }
  }
  let db;
  await measure(`open with corrupt generation (full-recovery fallback), N=${fmt(docs.length)}`, async () => {
    db = await MiniDb.open({ dir, ...OPEN_OPTS });
    return { extra: { docs: docs.length, ...lifecycleExtra(db) } };
  });
  await measure(`deferred text rebuild (degraded -> ready), N=${fmt(docs.length)}`, async () => {
    const t0 = Date.now();
    while (db.lifecycleStatus().state !== 'ready') {
      if (Date.now() - t0 > readyTimeoutMs) throw new Error(`timed out waiting for ready (state=${db.lifecycleStatus().state})`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return {
      extra: {
        docs: docs.length,
        ...lifecycleExtra(db),
        textDeferredBuilds: db.stats.textDeferredBuilds,
        textDeferredBuildErrors: db.stats.textDeferredBuildErrors,
        textWorkerBuilds: db.stats.textWorkerBuilds,
        textWorkerFallbacks: db.stats.textWorkerFallbacks,
      },
    };
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
  const sizes = quick
    ? { small: 2_000, walCorpus: 5_000, walDeltaBytes: 1.5 * MIB, largeGen: 8_000, corrupt: 8_000, readyTimeoutMs: 120_000 }
    : { small: 20_000, walCorpus: 50_000, walDeltaBytes: 3 * MIB, largeGen: 200_000, corrupt: 100_000, readyTimeoutMs: 600_000 };

  console.log(`\nminidb open-lifecycle baseline  (seed=${SEED}${quick ? ', QUICK' : ''}, node ${process.version})\n`);

  await smallCorpusScenario({ docs: makeMessages(sizes.small, SEED) });
  await largeWalScenario({ docs: makeMessages(sizes.walCorpus, SEED), deltaBytes: sizes.walDeltaBytes });
  await largeGenerationScenario({ docs: makeMessages(sizes.largeGen, SEED) });
  await corruptGenerationScenario({ docs: makeMessages(sizes.corrupt, SEED), readyTimeoutMs: sizes.readyTimeoutMs });

  const report = {
    schemaVersion: 1,
    tool: 'minidb/bench/open-lifecycle',
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
