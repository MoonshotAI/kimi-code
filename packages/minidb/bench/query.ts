// bench/query.js
//
// Query micro-benchmarks: key prefix scan, dt range, value filter, full-text.
// Run: node bench/query.js

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const ops = (n, ms) => `${fmt((n / ms) * 1000)} ops/s`;

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-qbench-'));
}

async function bench(label, fn, iters = 1) {
  const t0 = performance.now();
  let r;
  for (let i = 0; i < iters; i++) r = await fn();
  const ms = performance.now() - t0;
  return { ms, r };
}

// ---------------------------------------------------------------------------
// Phase-2 hot-path scenarios (plan/02): bounded startup rebuild, full-text
// top-K, text delta overwrite, unique batch validation, TTL write pauses.
// Sizes default to the plan's acceptance scenarios; shrink via env for a
// quick smoke run (OPEN_N / TOPK_N / DELTA_TERMS / UNIQUE_OWNERS / TTL_N).
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Cold open of the same 100k-doc database with 0/1/2 text indexes defined.
 *  Built once with two text indexes; the definitions sidecar is trimmed
 *  between runs to emulate fewer defined indexes. */
async function coldOpenScenario() {
  const OPEN_N = Number(process.env.OPEN_N || 100_000);
  console.log(`\n  -- cold open, ${fmt(OPEN_N)} docs, 0/1/2 text indexes --`);
  const dir = await tmpDir();
  try {
    {
      const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
      const bulk = [];
      for (let i = 0; i < OPEN_N; i++) {
        bulk.push(db.set(`doc:${String(i).padStart(7, '0')}`, { title: `title ${i}`, body: `hello world doc ${i}` }, { dt: { created: i } }));
        if (bulk.length >= 10_000) {
          await Promise.all(bulk);
          bulk.length = 0;
        }
      }
      await Promise.all(bulk);
      await db.createTextIndex('body', { fields: ['body'] });
      await db.createTextIndex('title', { fields: ['title'] });
      await db.close();
    }
    const defsPath = path.join(dir, 'db.textindexes.json');
    const defs = JSON.parse(await fs.readFile(defsPath, 'utf8'));
    for (const k of [0, 1, 2]) {
      await fs.writeFile(defsPath, JSON.stringify(defs.slice(0, k)), 'utf8');
      const opens = [];
      let decoded;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
        opens.push(performance.now() - t0);
        decoded = db.stats.indexRebuildDecoded ?? 'n/a';
        await db.close();
      }
      opens.sort((a, b) => a - b);
      console.log(
        `    textIndexes=${k}`.padEnd(24),
        `median ${opens[1].toFixed(1).padStart(8)} ms   (min ${opens[0].toFixed(1)}, rebuild-decoded=${decoded})`,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Full-text top-K over ~1M candidates with limit 10/50/1000. Two warm-up
 *  searches run first (JIT/GC steady state); the reported number is the min
 *  of five — the ranking phase's cost, not first-run noise. */
async function topKScenario() {
  const TOPK_N = Number(process.env.TOPK_N || 1_000_000);
  console.log(`\n  -- full-text top-K, ${fmt(TOPK_N)} candidates --`);
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    await db.createTextIndex('body', { fields: ['body'] });
    for (let base = 0; base < TOPK_N; base += 10_000) {
      const bulk = [];
      for (let i = base; i < Math.min(base + 10_000, TOPK_N); i++) bulk.push(db.set(`doc:${i}`, { body: `common word ${i}` }));
      await Promise.all(bulk);
    }
    db.search('body', 'common', { limit: 10 });
    db.search('body', 'common', { limit: 10 });
    for (const limit of [10, 50, 1000]) {
      let hits = 0;
      let best = Infinity;
      const rss0 = process.memoryUsage().rss;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        hits = db.search('body', 'common', { limit }).length;
        best = Math.min(best, performance.now() - t0);
      }
      const rssDelta = Math.max(0, process.memoryUsage().rss - rss0) / 1024 / 1024;
      console.log(`    limit=${String(limit).padEnd(6)}`.padEnd(24), `${best.toFixed(1).padStart(8)} ms/search (min-of-5, hits=${hits}, rssΔ~${rssDelta.toFixed(0)} MiB)`);
    }
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Overwrite one document while the text delta holds many distinct terms. */
async function deltaOverwriteScenario() {
  const DELTA_TERMS = Number(process.env.DELTA_TERMS || 1_000_000);
  const DOCS = 1000;
  const perDoc = Math.ceil(DELTA_TERMS / DOCS);
  console.log(`\n  -- text delta overwrite, ~${fmt(DELTA_TERMS)} distinct delta terms (${DOCS} docs x ${fmt(perDoc)} words) --`);
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    await db.createTextIndex('body', { fields: ['body'] });
    const bulk = [];
    let w = 0;
    for (let d = 0; d < DOCS; d++) {
      const words = [];
      for (let i = 0; i < perDoc; i++) words.push(`w${w++}`);
      bulk.push(db.set(`doc:${d}`, { body: words.join(' ') }));
      if (bulk.length >= 100) {
        await Promise.all(bulk);
        bulk.length = 0;
      }
    }
    await Promise.all(bulk);
    // Overwrite a single doc repeatedly; each overwrite must visit only the
    // doc's own terms, not the whole delta vocabulary.
    const lat = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      await db.set('doc:0', { body: `w0 w1 w2 extra${i}` });
      lat.push(performance.now() - t0);
    }
    lat.sort((a, b) => a - b);
    console.log(
      `    overwrite 1 doc x100`.padEnd(24),
      `p50 ${percentile(lat, 50).toFixed(2)} ms   p95 ${percentile(lat, 95).toFixed(2)} ms   max ${lat[lat.length - 1].toFixed(2)} ms`,
    );
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Unique batch validation cost vs unique-index owner count. */
async function uniqueBatchScenario() {
  const OWNERS = Number(process.env.UNIQUE_OWNERS || 100_000);
  console.log(`\n  -- unique batch validation, ${fmt(OWNERS)} owners --`);
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    await db.createIndex('byN', { field: 'n', unique: true });
    for (let base = 0; base < OWNERS; base += 10_000) {
      const bulk = [];
      for (let i = base; i < Math.min(base + 10_000, OWNERS); i++) bulk.push(db.set(`u:${i}`, { n: i }));
      await Promise.all(bulk);
    }
    let next = OWNERS;
    for (const size of [1, 10, 100]) {
      const lat = [];
      for (let r = 0; r < 30; r++) {
        // Update existing keys with fresh unique values (no conflicts), so the
        // check must logically vacate the touched keys' old owners.
        const ops = [];
        for (let i = 0; i < size; i++) ops.push({ op: 'set', key: `u:${r % OWNERS}`, value: { n: next++ } });
        const t0 = performance.now();
        await db.batch(ops);
        lat.push(performance.now() - t0);
      }
      lat.sort((a, b) => a - b);
      console.log(
        `    batch size=${String(size).padEnd(5)}`.padEnd(24),
        `p50 ${percentile(lat, 50).toFixed(2)} ms   p95 ${percentile(lat, 95).toFixed(2)} ms   max ${lat[lat.length - 1].toFixed(2)} ms`,
      );
    }
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Write pauses with a large live TTL set and maxMemoryBytes accounting on. */
async function ttlWritePauseScenario() {
  const TTL_N = Number(process.env.TTL_N || 100_000);
  const WRITES = Number(process.env.TTL_WRITES || 2_000);
  console.log(`\n  -- TTL write pause, ${fmt(TTL_N)} live TTL records, ${fmt(WRITES)} writes --`);
  const dir = await tmpDir();
  try {
    // Budget comfortably fits everything: the rejection path is not what is
    // being measured — the per-write expiry sweep is.
    const db = await MiniDb.open({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'no',
      autoCompact: false,
      maxMemoryBytes: 512 * 1024 * 1024,
    });
    for (let base = 0; base < TTL_N; base += 10_000) {
      const bulk = [];
      for (let i = base; i < Math.min(base + 10_000, TTL_N); i++) {
        bulk.push(db.set(`ttl:${i}`, { v: i }, { ttl: 3_600_000 }));
      }
      await Promise.all(bulk);
    }
    const lat = [];
    for (let i = 0; i < WRITES; i++) {
      const t0 = performance.now();
      await db.set(`w:${i}`, { v: i });
      lat.push(performance.now() - t0);
    }
    lat.sort((a, b) => a - b);
    console.log(
      `    plain writes`.padEnd(24),
      `p50 ${percentile(lat, 50).toFixed(2)} ms   p95 ${percentile(lat, 95).toFixed(2)} ms   max ${lat[lat.length - 1].toFixed(2)} ms`,
    );
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const N = Number(process.env.N || 50_000);
  const ITERS = Number(process.env.ITERS || 200);
  console.log(`\nminidb query benchmark  (N=${fmt(N)} docs, ${ITERS} iters each, node ${process.version})\n`);

  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  await db.createTextIndex('body');

  const base = Date.parse('2024-01-01');
  const bulk = [];
  for (let i = 0; i < N; i++) {
    bulk.push(
      db.set(
        `user:${String(i).padStart(6, '0')}`,
        {
          age: 18 + (i % 60),
          city: ['Paris', 'London', 'Tokyo', 'Beijing'][i % 4],
          bio: i % 3 === 0 ? '我住在北京，喜欢编程和数据库' : 'hello world from nodejs database engine',
        },
        { dt: { created: base + i * 1000 } },
      ),
    );
  }
  await Promise.all(bulk);

  // key prefix scan
  let r = await bench('key prefix scan "user:0001.."', () => db.prefix('user:0001'), ITERS);
  console.log(`  key prefix scan (user:0001*)`.padEnd(42), `${r.ms.toFixed(1)} ms total`, `-> ${ops(ITERS, r.ms)}`, `(~${r.r.length} rows)`);

  // key range
  r = await bench('key range', () => db.scan({ gte: 'user:001', lte: 'user:002' }), ITERS);
  console.log(`  key range [user:001, user:002]`.padEnd(42), `${r.ms.toFixed(1)} ms total`, `-> ${ops(ITERS, r.ms)}`, `(~${r.r.length} rows)`);

  // dt range
  r = await bench('dt range', () => db.dtRange('created', { gte: base + 10000, lte: base + 20000 }), ITERS);
  console.log(`  dt range (10 docs)`.padEnd(42), `${r.ms.toFixed(1)} ms total`, `-> ${ops(ITERS, r.ms)}`);

  // value filter (full scan + match)
  r = await bench('value filter', () => db.query({ filter: { city: 'Paris', age: { $gte: 30 } } }), ITERS);
  console.log(`  value filter (city=Paris & age>=30)`.padEnd(42), `${r.ms.toFixed(1)} ms total`, `-> ${ops(ITERS, r.ms)}`, `(~${r.r.length} rows)`);

  // full-text search
  r = await bench('text search latin', () => db.search('body', 'hello'), ITERS);
  console.log(`  text search "hello"`.padEnd(42), `${r.ms.toFixed(1)} ms total`, `-> ${ops(ITERS, r.ms)}`, `(~${r.r.length} rows)`);

  r = await bench('text search cjk', () => db.search('body', '北京'), ITERS);
  console.log(`  text search "北京"`.padEnd(42), `${r.ms.toFixed(1)} ms total`, `-> ${ops(ITERS, r.ms)}`, `(~${r.r.length} rows)`);

  // composed query
  r = await bench(
    'composed',
    () =>
      db.query({
        dt: { created: { gte: base, lte: base + N * 1000 } },
        filter: { city: 'Beijing' },
        sort: { age: -1 },
        limit: 10,
      }),
    ITERS,
  );
  console.log(`  composed (dt + filter + sort + limit)`.padEnd(42), `${r.ms.toFixed(1)} ms total`, `-> ${ops(ITERS, r.ms)}`);

  await db.close();
  await fs.rm(dir, { recursive: true, force: true });

  // ONLY=<substring> selects a subset of the phase-2 scenarios (e.g. ONLY=topk).
  const only = (process.env.ONLY ?? '').toLowerCase();
  const pick = (name: string) => only === '' || name.includes(only);
  if (pick('open')) await coldOpenScenario();
  if (pick('topk')) await topKScenario();
  if (pick('delta')) await deltaOverwriteScenario();
  if (pick('unique')) await uniqueBatchScenario();
  if (pick('ttl')) await ttlWritePauseScenario();
  console.log('\ndone.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
