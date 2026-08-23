// src/snapshot.ts
//
// Write a point-in-time snapshot of the live Store to a temp file as a sequence
// of SET frames (tombstones dropped — only live keys are emitted). The caller is
// responsible for the atomic rename + WAL rotation.
//
// We yield to the event loop every `yieldEvery` entries so a large snapshot does
// not starve other work.
//
// Stage 6 (disk valueMode): values are no longer materialized one synchronous
// positioned read per record. The live refs are grouped by their source file
// and sorted by offset, then read with bounded concurrency through an async
// positioned reader — sequential-ish I/O instead of random readSync calls on
// the event loop. Each work slice is bounded by a value-byte budget, so both
// the per-slice CPU run and the in-flight memory stay flat.

import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { encodeFrame, HEADER_SIZE, TYPE_SET } from './codec.js';
import type { Store, ValueLoc } from './store.js';

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
const FLUSH_BYTES = 1 << 20; // coalesce into ~1 MiB writev batches
/** Stage 6 defaults: at most this many positioned reads in flight, and at
 *  most this many value bytes collected per work slice. */
const DEFAULT_READ_CONCURRENCY = 8;
const DEFAULT_SLICE_BYTES = 8 << 20;

export interface SnapshotResult {
  count: number;
  bytes: number;
  locs: Map<string, ValueLoc>;
}

export interface SnapshotOptions {
  yieldEvery?: number;
  /** Stage 6: async positioned reader for disk-backed value refs. When
   *  absent, disk refs fall back to the Store's synchronous materialization
   *  (the pre-stage-6 behavior). */
  readValueAsync?: (loc: ValueLoc) => Promise<Buffer>;
  /** Max concurrent async value reads (default 8). */
  readConcurrency?: number;
  /** Max value bytes collected per work slice (default 8 MiB). */
  sliceBytes?: number;
}

interface PendingRecord {
  key: Buffer;
  value: Buffer | null;
  loc: ValueLoc | null;
  expireAt: number;
  dt: Record<string, number> | null;
}

export async function writeSnapshot(
  store: Store,
  tmpPath: string,
  opts: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const yieldEvery = opts.yieldEvery ?? 2000;
  const readConcurrency = Math.max(1, opts.readConcurrency ?? DEFAULT_READ_CONCURRENCY);
  const sliceBytes = Math.max(1, opts.sliceBytes ?? DEFAULT_SLICE_BYTES);
  const fh: FileHandle = await fs.open(tmpPath, 'w');
  let count = 0;
  let bytes = 0;
  let batch: Buffer[] = [];
  let batchBytes = 0;
  const locs = new Map<string, ValueLoc>();

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    // writev(2) may short-write (signal interruption, RLIMIT_FSIZE, …). Loop
    // until every byte is on the kernel side; otherwise the snapshot would be
    // silently truncated and later renamed over the good one.
    let bufs = batch;
    let off = 0; // byte offset within bufs[0]
    while (bufs.length > 0) {
      const toWrite = off > 0 ? [bufs[0]!.subarray(off), ...bufs.slice(1)] : bufs;
      const { bytesWritten } = await fh.writev(toWrite);
      if (bytesWritten === 0) throw new Error('snapshot writev made no progress (short write)');
      bytes += bytesWritten;
      let rem = bytesWritten;
      while (rem > 0 && bufs.length > 0) {
        const left = bufs[0]!.length - off;
        if (rem < left) {
          off += rem;
          rem = 0;
        } else {
          rem -= left;
          bufs.shift();
          off = 0;
        }
      }
    }
    batch = [];
    batchBytes = 0;
  };

  const writeRecord = async (key: Buffer, value: Buffer, expireAt: number, dt: Record<string, number> | null): Promise<void> => {
    const meta = dt ? Buffer.from(JSON.stringify({ dt })) : null;
    const frame = encodeFrame({ type: TYPE_SET, key, value, expireAt, meta });
    const frameOff = bytes + batchBytes;
    locs.set(key.toString('binary'), {
      file: 'snapshot',
      off: frameOff + HEADER_SIZE + key.length,
      len: value.length,
    });
    batch.push(frame);
    batchBytes += frame.length;
    count++;
    if (batchBytes >= FLUSH_BYTES) await flushBatch();
    if (count % yieldEvery === 0) await yieldToLoop();
  };

  try {
    // Collect the live refs WITHOUT materializing values, then emit two
    // passes: memory-resident values first (pure CPU), then disk-backed
    // values grouped by source file and sorted by offset (see the header).
    // Frame order inside a snapshot carries no semantics — every key appears
    // exactly once and recovery applies frames last-writer-wins per key.
    const memRecs: PendingRecord[] = [];
    const diskRecs: PendingRecord[] = [];
    for (const r of store.rawRefRecords()) {
      const key = Buffer.from(r.kstr, 'binary');
      if (r.ref.kind === 'memory') {
        memRecs.push({ key, value: r.ref.value, loc: null, expireAt: r.expireAt, dt: r.dt });
      } else {
        diskRecs.push({ key, value: null, loc: r.ref.loc, expireAt: r.expireAt, dt: r.dt });
      }
    }

    for (const rec of memRecs) await writeRecord(rec.key, rec.value!, rec.expireAt, rec.dt);

    if (diskRecs.length > 0) {
      // Group by source file, sort by offset: the async reads below then hit
      // each file in ascending-offset order (sequential I/O), never random.
      diskRecs.sort((a, b) => (a.loc!.file < b.loc!.file ? -1 : a.loc!.file > b.loc!.file ? 1 : a.loc!.off - b.loc!.off));
      if (!opts.readValueAsync) {
        // Legacy fallback: no async reader wired — synchronous materialize
        // per record (the pre-stage-6 behavior), one record at a time.
        for (const rec of diskRecs) {
          const value = store.get(rec.key);
          if (value === undefined) continue; // expired between collect and read
          await writeRecord(rec.key, value, rec.expireAt, rec.dt);
        }
      } else {
        const readValue = opts.readValueAsync;
        // Work slices bounded by accumulated value bytes: each slice reads
        // its records with bounded concurrency, then writes them in slice
        // order, keeping both the event-loop pause and in-flight memory flat.
        let i = 0;
        while (i < diskRecs.length) {
          let sliceLen = 0;
          let j = i;
          while (j < diskRecs.length && (j === i || sliceLen < sliceBytes)) {
            sliceLen += diskRecs[j]!.loc!.len;
            j++;
          }
          const slice = diskRecs.slice(i, j);
          const values: (Buffer | undefined)[] = Array.from({ length: slice.length });
          let cursor = 0;
          const workers = Array.from({ length: Math.min(readConcurrency, slice.length) }, async () => {
            for (;;) {
              const idx = cursor++;
              if (idx >= slice.length) return;
              const rec = slice[idx]!;
              values[idx] = await readValue(rec.loc!);
            }
          });
          await Promise.all(workers);
          for (let k = 0; k < slice.length; k++) {
            const value = values[k];
            if (value === undefined) continue;
            const rec = slice[k]!;
            await writeRecord(rec.key, value, rec.expireAt, rec.dt);
          }
          i = j;
          await yieldToLoop();
        }
      }
    }

    await flushBatch();
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { count, bytes, locs };
}
