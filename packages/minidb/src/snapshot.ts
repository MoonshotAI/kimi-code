// src/snapshot.ts
//
// Write a point-in-time snapshot of the live Store to a temp file as a sequence
// of SET frames (tombstones dropped — only live keys are emitted). The caller is
// responsible for the atomic rename + WAL rotation.
//
// We yield to the event loop every `yieldEvery` entries so a large snapshot does
// not starve other work.

import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { encodeFrame, HEADER_SIZE, TYPE_SET } from './codec.js';
import type { Store, ValueLoc } from './store.js';

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
const FLUSH_BYTES = 1 << 20; // coalesce into ~1 MiB writev batches

export interface SnapshotResult {
  count: number;
  bytes: number;
  locs: Map<string, ValueLoc>;
}

export async function writeSnapshot(
  store: Store,
  tmpPath: string,
  opts: { yieldEvery?: number } = {},
): Promise<SnapshotResult> {
  const yieldEvery = opts.yieldEvery ?? 2000;
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

  try {
    for (const { key, value, expireAt, dt } of store.entries()) {
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
    }
    await flushBatch();
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { count, bytes, locs };
}
