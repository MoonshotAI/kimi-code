// test/cluster/helpers.js
//
// Shared helpers for the cluster tests: worker-process spawning and
// deterministic key generation that lands on a chosen shard.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shardFor } from '../../src/cluster/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WORKER = path.join(__dirname, 'mp-worker.ts');

/** rm -rf with retry: children may still be finishing their final syscalls
 *  (or a cleanup may race one) when the parent starts removing the tree. */
export async function rmrf(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'EPERM')) throw e;
      await sleep(50 * (attempt + 1));
    }
  }
}

export interface WorkerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Last JSON line printed by the worker, if any. */
  json: Record<string, unknown> | null;
}

/** Spawn a cluster worker process and wait for it to exit. */
export function runWorker(args: string[], opts: { timeoutMs?: number } = {}): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const killer =
      opts.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`worker timed out after ${opts.timeoutMs}ms\nargs: ${args.join(' ')}\nstderr: ${stderr}`));
          }, opts.timeoutMs);
    child.on('error', (e) => {
      if (killer) clearTimeout(killer);
      reject(e);
    });
    // 'close' (not 'exit'): the process is fully reaped and its stdio is
    // flushed, so no lingering child can still touch the cluster directory.
    child.on('close', (code) => {
      if (killer) clearTimeout(killer);
      const lines = stdout.trim().split('\n').filter((l) => l.startsWith('{'));
      let json: Record<string, unknown> | null = null;
      if (lines.length > 0) {
        try {
          json = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
        } catch {
          /* leave json null */
        }
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

/** Assert-like helper: run a worker that must exit 0, return its JSON report. */
export async function runWorkerOk(args: string[], opts: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  const r = await runWorker(args, opts);
  if (r.code !== 0 || !r.json) {
    throw new Error(`worker failed (code=${r.code})\nargs: ${args.join(' ')}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return r.json;
}

/** Find a key `${seed}:${n}` that routes to the given shard. Deterministic. */
export function keyOnShard(seed: string, shardId: number, shardCount: number): string {
  for (let n = 0; ; n++) {
    const key = `${seed}:${n}`;
    if (shardFor(key, shardCount) === shardId) return key;
  }
}

/** Pick count keys (seed:0..) grouped by the shard they route to. */
export function keysByShard(seed: string, count: number, shardCount: number): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (let n = 0; n < count; n++) {
    const key = `${seed}:${n}`;
    const id = shardFor(key, shardCount);
    const arr = out.get(id);
    if (arr) arr.push(key);
    else out.set(id, [key]);
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
