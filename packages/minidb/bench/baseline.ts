// bench/baseline.ts
//
// "Without minidb" baseline for bench.ts. Reproduces the same durable KV
// operations using only a JS Map + raw node:fs, so the timings isolate what
// minidb's machinery (group commit, binary codec + CRC, in-memory store,
// snapshot format) costs over a hand-written equivalent.
//
// Conventions mirror bench.ts so the two can be compared line by line:
//   - same N / NSMALL / 100B value
//   - three fsync policies: no / everysec (1s timer) / always (per-write fsync)
//   - concurrent set = fire all appends then Promise.all (file opened with
//     O_APPEND, so each write lands atomically at EOF, like minidb's WAL fd)
//   - snapshot = serialize the whole map to JSON and fsync it
//
// Run:  node --import tsx bench/baseline.ts

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const ops = (n: number, ms: number) => `${fmt((n / ms) * 1000)} ops/s`;

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'baseline-bench-'));
}

async function bench(label: string, fn: () => unknown) {
  if (global.gc) global.gc();
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

  console.log(`\nbaseline (no minidb)  (N=${fmt(N)}, value=${VALUE.length}B, node ${process.version})\n`);

  // --- baseline: raw JS Map (in-memory) ---------------------------------
  {
    const m = new Map<string, string>();
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

  // --- naive durable writes, fsync=no -----------------------------------
  // One JSONL record per set, O_APPEND, no fsync (rely on OS flush).
  {
    const dir = await tmpDir();
    const file = path.join(dir, 'log.jsonl');
    const m = new Map<string, string>();
    const fh = await fs.open(file, 'a');
    let bytes = 0;
    const ms = await bench('naive set concurrent, fsync=no (O_APPEND)', async () => {
      const p: Promise<unknown>[] = [];
      for (let i = 0; i < N; i++) {
        const k = `k${i}`;
        m.set(k, VALUE);
        const line = Buffer.from(JSON.stringify({ k, v: VALUE }) + '\n');
        bytes += line.length;
        p.push(fh.write(line));
      }
      await Promise.all(p);
    });
    await fh.close();
    console.log(`    -> ${ops(N, ms)}   (${(bytes / 1024 / 1024).toFixed(2)} MiB written)`);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // --- naive durable writes, fsync=everysec -----------------------------
  {
    const dir = await tmpDir();
    const file = path.join(dir, 'log.jsonl');
    const m = new Map<string, string>();
    const fh = await fs.open(file, 'a');
    const timer = setInterval(() => {
      fh.sync().catch(() => {});
    }, 1000);
    timer.unref?.();
    let bytes = 0;
    const ms = await bench('naive set concurrent, fsync=everysec', async () => {
      const p: Promise<unknown>[] = [];
      for (let i = 0; i < N; i++) {
        const k = `k${i}`;
        m.set(k, VALUE);
        const line = Buffer.from(JSON.stringify({ k, v: VALUE }) + '\n');
        bytes += line.length;
        p.push(fh.write(line));
      }
      await Promise.all(p);
    });
    clearInterval(timer);
    await fh.sync();
    await fh.close();
    console.log(`    -> ${ops(N, ms)}   (${(bytes / 1024 / 1024).toFixed(2)} MiB written)`);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // --- naive durable writes, sequential fsync=always --------------------
  {
    const dir = await tmpDir();
    const file = path.join(dir, 'log.jsonl');
    const m = new Map<string, string>();
    const fh = await fs.open(file, 'a');
    const ms = await bench(`naive set sequential, fsync=always (N=${fmt(NSMALL)})`, async () => {
      for (let i = 0; i < NSMALL; i++) {
        const k = `k${i}`;
        m.set(k, VALUE);
        await fh.write(Buffer.from(JSON.stringify({ k, v: VALUE }) + '\n'));
        await fh.sync();
      }
    });
    await fh.close();
    console.log(`    -> ${ops(NSMALL, ms)}`);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // --- naive reads (in-memory Map after load) ---------------------------
  {
    const m = new Map<string, string>();
    for (let i = 0; i < N; i++) m.set(`k${i}`, VALUE);
    const ms = await bench('naive get (in-memory Map)', () => {
      let s = 0;
      for (let i = 0; i < N; i++) if (m.get(`k${i}`)) s++;
      return s;
    });
    console.log(`    -> ${ops(N, ms)}`);
  }

  // --- naive snapshot ---------------------------------------------------
  // Dump the whole map to one JSON file + fsync (the hand-written equivalent
  // of minidb's compact()).
  {
    const dir = await tmpDir();
    const file = path.join(dir, 'snapshot.json');
    const m = new Map<string, string>();
    for (let i = 0; i < N; i++) m.set(`k${i}`, VALUE);
    const ms = await bench(`naive JSON snapshot of ${fmt(N)} keys`, async () => {
      const body = JSON.stringify(Object.fromEntries(m));
      await fs.writeFile(file, body);
      const fh = await fs.open(file, 'r');
      await fh.sync();
      await fh.close();
    });
    const snap = await fs.stat(file);
    console.log(`    -> ${(snap.size / 1024 / 1024).toFixed(2)} MiB snapshot in ${ms.toFixed(0)} ms`);
    await fs.rm(dir, { recursive: true, force: true });
  }

  console.log('\ndone.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
