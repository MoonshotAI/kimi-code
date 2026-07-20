// bench/bench.js
//
// Throughput / latency micro-benchmarks for MiniDb.
//
// Run:  npm run bench   (or: node bench/bench.js)

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const ops = (n, ms) => `${fmt((n / ms) * 1000)} ops/s`;

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-bench-'));
}

async function bench(label, fn) {
  // warm-up + a couple of GCs if available
  if (global.gc) {
    global.gc();
  }
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(46)} ${ms.toFixed(1).padStart(8)} ms`);
  return ms;
}

async function main() {
  const VALUE = 'x'.repeat(100); // 100-byte values
  const N = Number(process.env.N || 200_000);
  const NSMALL = Number(process.env.NSMALL || 3_000);

  console.log(`\nminidb benchmark  (N=${fmt(N)}, value=${VALUE.length}B, node ${process.version})\n`);

  // --- baseline: raw JS Map ----------------------------------------------
  {
    const m = new Map();
    const ms = await bench('baseline: raw Map set (in-memory)', () => {
      for (let i = 0; i < N; i++) m.set(`k${i}`, VALUE);
    });
    console.log(`    -> ${ops(N, ms)}`);
    const ms2 = await bench('baseline: raw Map get (in-memory)', () => {
      let s = 0;
      for (let i = 0; i < N; i++) if (m.get(`k${i}`)) s++;
      return s;
    });
    console.log(`    -> ${ops(N, ms2)}`);
  }

  // --- DB writes, fsyncPolicy = no (fastest on-disk path) -----------------
  {
    const dir = await tmpDir();
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false });
    const ms = await bench('DB set concurrent, fsync=no (group commit)', async () => {
      const p = [];
      for (let i = 0; i < N; i++) p.push(db.set(`k${i}`, VALUE));
      await Promise.all(p);
    });
    console.log(`    -> ${ops(N, ms)}`);
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  // --- DB writes, fsyncPolicy = everysec ---------------------------------
  {
    const dir = await tmpDir();
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'everysec', autoCompact: false });
    const ms = await bench('DB set concurrent, fsync=everysec', async () => {
      const p = [];
      for (let i = 0; i < N; i++) p.push(db.set(`k${i}`, VALUE));
      await Promise.all(p);
    });
    console.log(`    -> ${ops(N, ms)}`);
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  // --- DB writes, sequential await-each, fsync=always (worst case) -------
  {
    const dir = await tmpDir();
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'always', autoCompact: false });
    const ms = await bench(`DB set sequential, fsync=always (N=${fmt(NSMALL)})`, async () => {
      for (let i = 0; i < NSMALL; i++) await db.set(`k${i}`, VALUE);
    });
    console.log(`    -> ${ops(NSMALL, ms)}`);
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  // --- DB reads (in-memory) ----------------------------------------------
  {
    const dir = await tmpDir();
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false });
    const p = [];
    for (let i = 0; i < N; i++) p.push(db.set(`k${i}`, VALUE));
    await Promise.all(p);
    const ms = await bench('DB get (in-memory, after load)', () => {
      let s = 0;
      for (let i = 0; i < N; i++) if (db.get(`k${i}`)) s++;
      return s;
    });
    console.log(`    -> ${ops(N, ms)}`);
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  // --- compaction --------------------------------------------------------
  {
    const dir = await tmpDir();
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false });
    const p = [];
    for (let i = 0; i < N; i++) p.push(db.set(`k${i}`, VALUE));
    await Promise.all(p);
    const ms = await bench(`compact snapshot of ${fmt(N)} keys`, () => db.compact());
    const snap = await fs.stat(path.join(dir, 'db.snapshot'));
    console.log(`    -> ${(snap.size / 1024 / 1024).toFixed(2)} MiB snapshot in ${ms.toFixed(0)} ms`);
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  console.log('\ndone.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
