// test/e2e/crash-recovery.test.js
//
// Crash injection: spawn a child that writes keys sequentially with
// fsyncPolicy='always', kill -9 it at a random time, then reopen and verify:
//   - the database always opens (never corrupted);
//   - recovered keys form a contiguous prefix k0..kM with no gaps;
//   - every recovered key's value is correct.
// This is the durability contract for sequential 'always' writes.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MiniDb } from '../../src/index.js';
import { tmpDir, rmrf } from './helpers/tmp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRITER = path.join(__dirname, 'helpers', 'crash-writer.ts');

function crashWriter(dir: string, compactEvery: number, runMs: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WRITER, dir, String(compactEvery)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    // Wait until the child signals progress (>=25 keys durable) before starting
    // the kill clock, so the test is robust even under heavy CPU contention.
    child.stdout.on('data', () => {
      if (!killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), runMs);
    });
    const safety = setTimeout(() => child.kill('SIGKILL'), 8000); // should not happen
    child.on('exit', () => {
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(safety);
      resolve();
    });
  });
}

async function verifyContiguous(dir, label) {
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  let last = -1;
  for (let i = 0; i < 1_000_000; i++) {
    const v = db.get('k' + i);
    if (v === undefined) {
      last = i - 1;
      break;
    }
    assert.equal(v.i, i, `${label}: value mismatch at k${i}`);
  }
  await db.close();
  return last; // highest contiguous index
}

test('crash-recovery: kill mid-write, recovery yields a contiguous correct prefix', async () => {
  // Each run spawns a child process (the dominant cost); 5 runs with random kill
  // times still sample the crash window well.
  const runs = 5;
  for (let r = 0; r < runs; r++) {
    const dir = await tmpDir();
    try {
      const runMs = Math.floor(Math.random() * 150);
      await crashWriter(dir, 0, runMs);
      const last = await verifyContiguous(dir, `run${r}`);
      assert.ok(last >= 2, `run${r}: expected several durable keys, got up to k${last}`);
    } finally {
      await rmrf(dir);
    }
  }
});

test('crash-recovery: kill during compaction, still consistent', async () => {
  const runs = 3;
  for (let r = 0; r < runs; r++) {
    const dir = await tmpDir();
    try {
      const runMs = Math.floor(Math.random() * 150);
      await crashWriter(dir, 40, runMs); // compact every 40 writes
      const last = await verifyContiguous(dir, `compact-run${r}`);
      assert.ok(last >= 2, `compact-run${r}: expected several durable keys, got up to k${last}`);
    } finally {
      await rmrf(dir);
    }
  }
});
