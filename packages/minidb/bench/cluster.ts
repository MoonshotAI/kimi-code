// bench/cluster.ts
//
// Multi-process concurrency benchmark for ClusterDb.
//
// For every (processes P, shards S) cell of the matrix:
//   WRITE-AFFINITY  P processes, each confined to its own block of shards
//                   (best case: measure sharding scale-out with zero lock
//                   contention while P <= S).
//   WRITE-SCATTER   P processes writing uniformly random keys across all
//                   shards (worst case: every lock handoff costs up to the
//                   hold window).
//   READ            P read-only processes, each reading back another
//                   process's keyspace (cross-process, mostly cross-shard).
// A raw single-process MiniDb baseline is measured first for reference.
//
// Run:  pnpm --filter @moonshot-ai/minidb bench:cluster
// Env:  CLUSTER_BENCH_PROCESSES=1,2,4,8 CLUSTER_BENCH_SHARDS=1,4,16
//       CLUSTER_BENCH_KEYS=3000 CLUSTER_BENCH_VALUE_BYTES=64
//       CLUSTER_BENCH_HOLD_MS=250

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MiniDb } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, 'cluster-worker.ts');

const PROCESSES = (process.env.CLUSTER_BENCH_PROCESSES ?? '1,2,4,8').split(',').map(Number);
const SHARDS = (process.env.CLUSTER_BENCH_SHARDS ?? '1,4,16').split(',').map(Number);
const KEYS = Number(process.env.CLUSTER_BENCH_KEYS ?? 3000); // per process
const VALUE_BYTES = Number(process.env.CLUSTER_BENCH_VALUE_BYTES ?? 64);
const HOLD_MS = Number(process.env.CLUSTER_BENCH_HOLD_MS ?? 250);

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

interface Report {
  ok: number;
  mode: string;
  n: number;
  ms: number;
  found?: number;
  retries: number;
  lockWaits?: number;
  error?: string;
}

function runWorker(args: string[]): Promise<Report> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) => {
      const lines = stdout.trim().split('\n').filter((l) => l.startsWith('{'));
      if (code !== 0 || lines.length === 0) {
        reject(new Error(`worker failed (code=${code}) args=${args.join(' ')}\n${stderr}\n${stdout}`));
        return;
      }
      const report = JSON.parse(lines[lines.length - 1]!) as Report;
      if (!report.ok) reject(new Error(`worker error args=${args.join(' ')}: ${report.error}`));
      else resolve(report);
    });
  });
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Partition S shards into P contiguous blocks (overlapping when P > S). */
function shardBlock(p: number, procs: number, shards: number): string {
  const s = Math.floor((p * shards) / procs);
  const e = Math.max(s + 1, Math.floor(((p + 1) * shards) / procs));
  const ids: number[] = [];
  for (let i = s; i < Math.min(e, shards); i++) ids.push(i);
  return ids.join(',') || 'all';
}

interface CellResult {
  procs: number;
  shards: number;
  affinityOps: number;
  affinityPerProc: number;
  scatterOps: number;
  scatterPerProc: number;
  scatterRetries: number;
  readOps: number;
  readPerProc: number;
}

async function benchCell(procs: number, shards: number): Promise<CellResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-cluster-bench-'));
  try {
    // ---- phase 1: affinity writes ------------------------------------------
    const affinityArgs = Array.from({ length: procs }, (_, p) => [
      'write',
      dir,
      String(shards),
      `w${p}`,
      String(KEYS),
      String(VALUE_BYTES),
      String(HOLD_MS),
      shardBlock(p, procs, shards),
    ]);
    const affinity = await Promise.all(affinityArgs.map((args) => runWorker(args)));
    const affinityTotal = affinity.reduce((s, r) => s + r.n, 0);
    const affinityWall = Math.max(...affinity.map((r) => r.ms));

    // ---- phase 2: scatter writes -------------------------------------------
    const scatterArgs = Array.from({ length: procs }, (_, p) => [
      'write',
      dir,
      String(shards),
      `s${p}`,
      String(KEYS),
      String(VALUE_BYTES),
      String(HOLD_MS),
      'all',
    ]);
    const scatter = await Promise.all(scatterArgs.map((args) => runWorker(args)));
    const scatterTotal = scatter.reduce((s, r) => s + r.n, 0);
    const scatterWall = Math.max(...scatter.map((r) => r.ms));
    const scatterRetries = scatter.reduce((s, r) => s + (r.lockWaits ?? r.retries), 0);

    // ---- phase 3: cross-process reads of the scatter keyspace ---------------
    const readArgs = Array.from({ length: procs }, (_, p) => [
      'read',
      dir,
      String(shards),
      `s${(p + 1) % procs}`,
      String(KEYS),
      String(VALUE_BYTES),
      String(HOLD_MS),
      'all',
    ]);
    const reads = await Promise.all(readArgs.map((args) => runWorker(args)));
    for (const r of reads) {
      if (r.found !== r.n) throw new Error(`read verification failed: found ${r.found}/${r.n}`);
    }
    const readTotal = reads.reduce((s, r) => s + r.found!, 0);
    const readWall = Math.max(...reads.map((r) => r.ms));

    const agg = (total: number, wall: number) => (total / wall) * 1000;
    const perProc = (reports: Report[]) => (KEYS / (reports.reduce((s, r) => s + r.ms, 0) / reports.length)) * 1000;
    return {
      procs,
      shards,
      affinityOps: agg(affinityTotal, affinityWall),
      affinityPerProc: perProc(affinity),
      scatterOps: agg(scatterTotal, scatterWall),
      scatterPerProc: perProc(scatter),
      scatterRetries,
      readOps: agg(readTotal, readWall),
      readPerProc: perProc(reads),
    };
  } finally {
    await rmrf(dir);
  }
}

async function baseline(): Promise<{ writeOps: number; readOps: number }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-bench-baseline-'));
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'everysec' });
    const pad = 'x'.repeat(VALUE_BYTES);
    let t0 = performance.now();
    for (let i = 0; i < KEYS; i++) await db.set(`w0:${i}`, { p: 'w0', i, pad });
    const writeMs = performance.now() - t0;
    t0 = performance.now();
    let found = 0;
    for (let i = 0; i < KEYS; i++) {
      const v = db.get(`w0:${i}`) as { i: number } | undefined;
      if (v?.i === i) found++;
    }
    const readMs = performance.now() - t0;
    if (found !== KEYS) throw new Error(`baseline verification failed ${found}/${KEYS}`);
    await db.close();
    return { writeOps: (KEYS / writeMs) * 1000, readOps: (KEYS / readMs) * 1000 };
  } finally {
    await rmrf(dir);
  }
}

function printMatrix(title: string, cells: CellResult[], pick: (c: CellResult) => number): void {
  console.log(`\n${title}`);
  const header = ['P \\ S', ...SHARDS.map((s) => String(s).padStart(12))].join(' | ');
  console.log(`  ${header}`);
  for (const p of PROCESSES) {
    const row = [
      String(p).padEnd(5),
      ...SHARDS.map((s) => fmt(pick(cells.find((c) => c.procs === p && c.shards === s)!)).padStart(12)),
    ].join(' | ');
    console.log(`  ${row}`);
  }
}

async function main(): Promise<void> {
  console.log(
    `\nClusterDb concurrency benchmark  (keys/proc=${fmt(KEYS)}, value=${VALUE_BYTES}B pad, codec=json, fsync=everysec, lockHoldMs=${HOLD_MS}, node ${process.version})`,
  );

  const base = await baseline();
  console.log(`baseline raw MiniDb (1 process, in-process, awaited writes):`);
  console.log(`  write ${fmt(base.writeOps)} ops/s | read ${fmt(base.readOps)} ops/s`);

  const cells: CellResult[] = [];
  for (const shards of SHARDS) {
    for (const procs of PROCESSES) {
      process.stdout.write(`running P=${procs} S=${shards} ... `);
      const cell = await benchCell(procs, shards);
      cells.push(cell);
      console.log(
        `affinity ${fmt(cell.affinityOps)} (${fmt(cell.affinityPerProc)}/proc) | ` +
          `scatter ${fmt(cell.scatterOps)} (${fmt(cell.scatterPerProc)}/proc, lockWaits=${fmt(cell.scatterRetries)}) | ` +
          `read ${fmt(cell.readOps)} (${fmt(cell.readPerProc)}/proc)`,
      );
    }
  }

  console.log(`\nall numbers are aggregate ops/s across processes (spawn/teardown excluded)`);
  printMatrix('WRITE-AFFINITY', cells, (c) => c.affinityOps);
  printMatrix('WRITE-SCATTER ', cells, (c) => c.scatterOps);
  printMatrix('READ           ', cells, (c) => c.readOps);
  printMatrix('SCATTER lock waits', cells, (c) => c.scatterRetries);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
