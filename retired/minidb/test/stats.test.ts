// Verifies the SSD-pressure instrumentation on db.stats: WAL bytes written,
// fsync count, snapshot bytes written, and compaction count.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-stats-'));
}

// Frame overhead is 22 (header) + 4 (crc) = 26 bytes, plus key + value.
const FRAME_OVERHEAD = 26;

test('walBytesWritten accumulates the exact frame bytes written', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
  try {
    assert.equal(db.stats.walBytesWritten, 0);
    let expected = 0;
    for (let i = 0; i < 10; i++) {
      const k = `k${i}`;
      const v = `v${i}`;
      await db.set(k, v);
      expected += FRAME_OVERHEAD + Buffer.byteLength(k) + Buffer.byteLength(v);
    }
    assert.equal(db.stats.walBytesWritten, expected);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("walFsyncs counts one fsync per flush under fsyncPolicy 'always'", async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'always' });
  try {
    const N = 5;
    for (let i = 0; i < N; i++) await db.set(`k${i}`, `v${i}`);
    // Sequential awaited sets each flush + fsync independently.
    assert.ok(db.stats.walFsyncs >= N, `expected >= ${N} fsyncs, got ${db.stats.walFsyncs}`);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("walFsyncs stays low under fsyncPolicy 'no'", async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
  try {
    for (let i = 0; i < 50; i++) await db.set(`k${i}`, `v${i}`);
    // 'no' never fsyncs on the write path (only on close).
    assert.equal(db.stats.walFsyncs, 0);
  } finally {
    await db.close(); // close fsyncs once, counted after our assertion above
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('snapshotBytesWritten and compactions update on compact', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
  try {
    assert.equal(db.stats.snapshotBytesWritten, 0);
    assert.equal(db.stats.compactions, 0);
    for (let i = 0; i < 100; i++) await db.set(`k${i}`, `value-${i}`);
    await db.compact();
    assert.equal(db.stats.compactions, 1);
    assert.ok(db.stats.snapshotBytesWritten > 0, 'snapshot wrote some bytes');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('batch writes a single frame (lower write amplification than per-key sets)', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
  try {
    const ops = Array.from({ length: 10 }, (_, i) => ({ op: 'set' as const, key: `b${i}`, value: `v${i}` }));
    await db.batch(ops);
    // One TYPE_BATCH frame: 26 + (2-byte count + sum of per-op subframes).
    // Just assert it is far less than 10 individual SET frames would be.
    const individual = 10 * (FRAME_OVERHEAD + 2 + 2); // ~10 * 30 = 300
    assert.ok(db.stats.walBytesWritten < individual, `batch wrote ${db.stats.walBytesWritten} < ${individual}`);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
