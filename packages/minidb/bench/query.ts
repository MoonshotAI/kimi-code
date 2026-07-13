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
  console.log('\ndone.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
