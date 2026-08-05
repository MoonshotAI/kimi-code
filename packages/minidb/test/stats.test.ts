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

test("everysec: idle db performs zero background fsyncs; a dirty window syncs once then goes quiet", async () => {
  const dir = await tmpDir();
  // Huge syncIntervalMs: the real timer never fires during the test. Every
  // background-sync tick is driven explicitly through the WAL's extracted
  // tick method (review #28), so the fsync counts are exact by construction
  // instead of inferred from 25ms-interval sleeps.
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'everysec', syncIntervalMs: 3_600_000, autoCompact: false });
  const tick = (): Promise<void> | null =>
    (db.wal as unknown as { backgroundTick(): Promise<void> | null }).backgroundTick();
  try {
    assert.equal(await tick(), null, 'idle ticks are skipped');
    assert.equal(db.stats.walFsyncs, 0, 'idle everysec db must not fsync in the background');

    await db.set('k', 'v');
    await tick();
    assert.equal(db.stats.walFsyncs, 1, 'the dirty window fsyncs once');

    assert.equal(await tick(), null, 'clean again: the next tick is skipped');
    assert.equal(db.stats.walFsyncs, 1, 'no fsync growth after the writes stopped');

    await db.set('k2', 'v2');
    await tick();
    assert.equal(db.stats.walFsyncs, 2, 'the next dirty window fsyncs once more');
  } finally {
    await db.close(); // final close sync runs after our assertions
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('everysec background sync failure is observable in stats but does not change write semantics', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'everysec', syncIntervalMs: 3_600_000, autoCompact: false });
  const tick = (): Promise<void> | null =>
    (db.wal as unknown as { backgroundTick(): Promise<void> | null }).backgroundTick();
  try {
    const fh = (db as unknown as { wal: { fh: { sync: () => Promise<void> } } }).wal.fh;
    const orig = fh.sync.bind(fh);
    const boom = new Error('injected fsync failure');
    fh.sync = () => Promise.reject(boom);

    // The cache-rebuildable write contract is unchanged: sets resolve from the
    // page cache even while every background fsync fails.
    await db.set('k', 'v');
    await tick();
    assert.equal(db.stats.walFsyncErrors, 1, 'the failing tick records exactly one error');
    assert.equal(db.stats.lastWalFsyncError, boom, 'the failure is observable via stats');
    assert.equal(db.stats.walFsyncs, 0, 'no successful fsync yet');

    fh.sync = orig;
    await tick();
    assert.equal(db.stats.walFsyncs, 1, 'background sync recovers once the failure clears');
    assert.equal(db.stats.lastWalFsyncError, boom, 'sticky error survives later successes');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('recovery stats capture scanned bytes, frames and duration at open', async () => {
  const dir = await tmpDir();
  // Legacy recovery path (indexGenerations: false): a generation load would
  // report the store image + WAL delta instead of the full scan.
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false, indexGenerations: false });
  const N = 50;
  for (let i = 0; i < N; i++) await db.set(`k${i}`, `v${i}`);
  await db.close();

  const walBytes = (await fs.stat(path.join(dir, 'db.wal'))).size;
  const reopened = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no', autoCompact: false, indexGenerations: false });
  try {
    assert.equal(reopened.stats.recoveryFrames, N, 'one frame per set replayed');
    assert.equal(reopened.stats.recoveryBytes, walBytes, 'WAL bytes accounted (no snapshot yet)');
    assert.ok(reopened.stats.recoveryDurationMs >= 0, 'duration recorded');
    assert.equal(reopened.recoveryInfo.walBytes, walBytes);
    assert.equal(reopened.recoveryInfo.snapshotBytes, 0);
  } finally {
    await reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('compaction phase stats break down into snapshot/rotation/postings/total', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createTextIndex('body', { fields: ['body'] });
    for (let i = 0; i < 100; i++) await db.set(`k${i}`, { body: `message number ${i} hello world` });
    await db.compact();

    assert.equal(db.stats.compactions, 1);
    assert.ok(db.stats.compactionDurationMs > 0, 'total recorded');
    assert.ok(db.stats.compactionSnapshotDurationMs > 0, 'snapshot phase recorded');
    assert.ok(db.stats.compactionRotationDurationMs > 0, 'rotation phase recorded');
    assert.ok(db.stats.compactionPostingsDurationMs > 0, 'postings rebuild recorded');
    assert.ok(db.stats.textRebuildDurationMs > 0, 'postings rebuild also counts as a text rebuild');
    assert.ok(
      db.stats.compactionSnapshotDurationMs + db.stats.compactionRotationDurationMs <= db.stats.compactionDurationMs,
      'phases are bounded by the total',
    );
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('query stats count candidates, decodes and sorted rows', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    for (let i = 0; i < 100; i++) await db.set(`k${i}`, { n: i, grp: i % 10 === 0 ? 'x' : 'y' });

    const c0 = db.stats.queryCandidates;
    const d0 = db.stats.queryDecoded;
    const s0 = db.stats.querySortedRows;

    // Full-scan filter without sort: every candidate is decoded, nothing sorted.
    const filtered = db.query({ filter: { grp: 'x' } });
    assert.equal(filtered.length, 10);
    assert.equal(db.stats.queryCandidates - c0, 100, 'every record was a candidate');
    assert.equal(db.stats.queryDecoded - d0, 100, 'every candidate was decoded to match the filter');
    assert.equal(db.stats.querySortedRows - s0, 0, 'no sort without sort/text');

    // Same query with a sort: only the matched rows reach the sort.
    const sorted = db.query({ filter: { grp: 'x' }, sort: { n: -1 } });
    assert.equal(sorted.length, 10);
    assert.equal(db.stats.querySortedRows - s0, 10, 'only matched rows are sorted');

    // A bounded query decodes only until the limit is filled.
    const c1 = db.stats.queryCandidates;
    const page = db.query({ filter: { grp: 'x' }, limit: 3 });
    assert.equal(page.length, 3);
    assert.ok(db.stats.queryCandidates - c1 < 100, 'early exit stops before the full scan');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('index rebuild stats: values decoded once per record, 0 without value-derived indexes', async () => {
  // No secondary/compound/text index: the open-time rebuild walk must be
  // metadata-only (dt comes from record metadata, values are never decoded).
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false, indexGenerations: false });
  for (let i = 0; i < 20; i++) await db.set(`k${i}`, { n: i }, { dt: { created: i } });
  await db.close();
  db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false, indexGenerations: false });
  try {
    assert.equal(db.stats.indexRebuildDecoded, 0, 'no decodes without value-derived indexes');
    assert.equal(db.dtRange('created', { gte: 0 }).length, 20, 'dt index rebuilt from metadata alone');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  // With several value-derived indexes: exactly one decode per live record,
  // fanned out to every staged builder in the shared walk.
  const dir2 = await tmpDir();
  db = await MiniDb.open({ dir: dir2, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false, indexGenerations: false });
  await db.createTextIndex('body', { fields: ['body'] });
  await db.createTextIndex('title', { fields: ['title'] });
  await db.createIndex('byN', { field: 'n' });
  await db.createCompoundIndex('byGrpN', { groupBy: 'grp', orderBy: 'n' });
  for (let i = 0; i < 20; i++) await db.set(`k${i}`, { n: i, grp: 'g', body: `b${i}`, title: `t${i}` });
  await db.close();
  db = await MiniDb.open({ dir: dir2, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false, indexGenerations: false });
  try {
    assert.equal(db.stats.indexRebuildDecoded, 20, 'one decode per record fanned out to all builders');
    assert.equal(db.search('body', 'b1').length, 1);
    assert.equal(db.search('title', 't2').length, 1);
    assert.equal(db.findEq('byN', 3).length, 1);
    assert.equal(db.compoundRange('byGrpN', 'g').length, 20);
  } finally {
    await db.close();
    await fs.rm(dir2, { recursive: true, force: true });
  }
});
