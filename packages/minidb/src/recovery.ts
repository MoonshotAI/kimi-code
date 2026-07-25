// src/recovery.ts
//
// Startup recovery: load the latest snapshot (if any) then replay the WAL on
// top, last-writer-wins. In valueMode:'disk' recovery scans frames without
// copying values and stores { file, off, len } pointers instead.
//
// The per-frame interpretation (expiry drop, batch unrolling, value refs, dt
// meta) lives in frameToOps so that open-time recovery and read-replica WAL
// catch-up (catchUpWal) can never drift apart.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { scanFrameRefsFd, scanBatchOpRefs, TYPE_SET, TYPE_DEL, TYPE_BATCH, MAGIC } from './codec.js';
import type { FrameRef } from './codec.js';
import type { Store, ValueLoc, ValueRef } from './store.js';

export type RecoveryMode = 'resync' | 'strict';
export type ValueMode = 'memory' | 'disk';

export interface RecoveryInfo {
  snapshotFrames: number;
  walFrames: number;
  truncatedWal: boolean;
  corruptRanges: [number, number][];
  snapshotCorruptRanges: [number, number][];
  lostBytes: number;
  /** Byte offset in db.wal up to which recovery replayed frames (the scan
   *  endpoint; a torn/corrupt tail beyond it was NOT applied). 0 without WAL.
   *  Anchored by walDev/walIno to the inode that was scanned. */
  walScanEnd: number;
  /** dev/ino of the WAL inode recovery scanned (both 0 when there was none). */
  walDev: number;
  walIno: number;
}

function readAtSync(fd: number, off: number, len: number): Buffer {
  if (len === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const r = fsSync.readSync(fd, buf, got, len - got, off + got);
    if (r === 0) throw new Error('recovery: short read past EOF');
    got += r;
  }
  return buf;
}

function parseMeta(meta: Buffer | null): Record<string, number> | null {
  if (!meta) return null;
  const parsed = JSON.parse(meta.toString('utf8')) as { dt?: Record<string, number> };
  return parsed.dt ?? null;
}

/** A recovered frame unrolled into one primitive store op; the shared
 *  interpretation layer between open-time recovery and replica catch-up. */
export interface RecoveredOp {
  type: number; // TYPE_SET | TYPE_DEL
  key: Buffer;
  ref: ValueRef | null;
  expireAt: number;
  dt: Record<string, number> | null;
}

function* setRefToOps(
  f: { key: Buffer; valueOff: number; valLen: number; meta: Buffer | null; expireAt: number },
  file: ValueLoc['file'],
  fd: number,
  valueMode: ValueMode,
): Generator<RecoveredOp> {
  // A record whose TTL already elapsed while the db was closed must not be
  // replayed as a live key: that would make `size` count a key scan/get hide,
  // and would rebuild indexes without it (inconsistency).
  //
  // We must also actively DROP the key: an expired SET is still the *latest*
  // write for its key. If an older live value for the same key was already
  // loaded from the snapshot (or an earlier WAL frame), simply skipping this
  // frame would leave that stale value behind — resurrecting a key the most
  // recent write had already expired. Deleting it preserves last-writer-wins
  // semantics: a later op (another SET, or a DEL) will re-establish the key if
  // needed; otherwise the key stays gone, as its expired TTL dictates.
  if (f.expireAt && f.expireAt <= Date.now()) {
    yield { type: TYPE_DEL, key: f.key, ref: null, expireAt: 0, dt: null };
    return;
  }
  const dt = parseMeta(f.meta);
  const ref: ValueRef =
    valueMode === 'disk'
      ? { kind: 'disk', loc: { file, off: f.valueOff, len: f.valLen } }
      : { kind: 'memory', value: readAtSync(fd, f.valueOff, f.valLen) };
  yield { type: TYPE_SET, key: f.key, ref, expireAt: f.expireAt, dt };
}

/** Unroll one recovered frame into primitive ops. SET frames carry their value
 *  ref (inline bytes in memory mode, a {file, off, len} pointer in disk mode);
 *  expired-at-replay SETs become DELs (see setRefToOps). A BATCH frame yields
 *  its sub-ops in order; a malformed body with a valid outer CRC skips the
 *  whole batch rather than half-applying it. Unknown frame types yield nothing. */
export function* frameToOps(f: FrameRef, file: ValueLoc['file'], fd: number, valueMode: ValueMode): Generator<RecoveredOp> {
  if (f.type === TYPE_SET) {
    yield* setRefToOps(f, file, fd, valueMode);
  } else if (f.type === TYPE_DEL) {
    yield { type: TYPE_DEL, key: f.key, ref: null, expireAt: 0, dt: null };
  } else if (f.type === TYPE_BATCH) {
    let ops;
    try {
      ops = scanBatchOpRefs(readAtSync(fd, f.valueOff, f.valLen), f.valueOff);
    } catch {
      // A malformed body with a valid outer CRC can only come from an encoder
      // bug. Skip the whole batch rather than half-apply it, preserving the
      // all-or-nothing guarantee.
      return;
    }
    for (const op of ops) {
      if (op.type === TYPE_SET) yield* setRefToOps(op, file, fd, valueMode);
      else if (op.type === TYPE_DEL) yield { type: TYPE_DEL, key: op.key, ref: null, expireAt: 0, dt: null };
    }
  }
}

function applyFrames(frames: FrameRef[], file: ValueLoc['file'], fd: number, store: Store, valueMode: ValueMode): void {
  for (const f of frames) {
    for (const op of frameToOps(f, file, fd, valueMode)) {
      if (op.type === TYPE_SET) store.setRef(op.key, op.ref!, op.expireAt, op.dt);
      else if (op.type === TYPE_DEL) store.del(op.key);
    }
  }
}

export async function recover({
  dir,
  store,
  mode = 'resync',
  truncate = true,
  valueMode = 'memory',
}: {
  dir: string;
  store: Store;
  mode?: RecoveryMode;
  truncate?: boolean;
  valueMode?: ValueMode;
}): Promise<RecoveryInfo> {
  const snapPath = path.join(dir, 'db.snapshot');
  const walPath = path.join(dir, 'db.wal');

  let snapshotFrames = 0;
  let snapshotCorrupt: [number, number][] = [];
  if (fsSync.existsSync(snapPath)) {
    const fd = fsSync.openSync(snapPath, 'r');
    try {
      const r = scanFrameRefsFd(fd, { onCorrupt: mode });
      applyFrames(r.frames, 'snapshot', fd, store, valueMode);
      snapshotFrames = r.frames.length;
      snapshotCorrupt = r.corruptRanges;
    } finally {
      fsSync.closeSync(fd);
    }
  }

  let walFrames = 0;
  let walCorrupt: [number, number][] = [];
  let truncatedWal = false;
  let walScanEnd = 0;
  let walDev = 0;
  let walIno = 0;
  if (fsSync.existsSync(walPath)) {
    const fd = fsSync.openSync(walPath, 'r');
    let walSize = 0;
    try {
      const st = fsSync.fstatSync(fd);
      walSize = st.size;
      walDev = st.dev;
      walIno = st.ino;
      const r = scanFrameRefsFd(fd, { onCorrupt: mode });
      applyFrames(r.frames, 'wal', fd, store, valueMode);
      walFrames = r.frames.length;
      walCorrupt = r.corruptRanges;
      walScanEnd = r.eofOffset;
      const last = r.corruptRanges[r.corruptRanges.length - 1];
      if (last && last[1] === walSize) {
        // A torn/corrupt tail is normally truncated so the next writer appends
        // cleanly. In read-only mode (truncate = false) we must never mutate the
        // database files: a read-only opener racing a live writer could otherwise
        // observe a momentarily-incomplete tail and destroy live data.
        if (truncate) {
          await fs.truncate(walPath, last[0]);
          truncatedWal = true;
        }
      }
    } finally {
      fsSync.closeSync(fd);
    }
  }

  return {
    snapshotFrames,
    walFrames,
    truncatedWal,
    corruptRanges: walCorrupt,
    snapshotCorruptRanges: snapshotCorrupt,
    lostBytes: [...walCorrupt, ...snapshotCorrupt].reduce((a, [s, e]) => a + (e - s), 0),
    walScanEnd,
    walDev,
    walIno,
  };
}

/** Continue a replica from a WAL watermark: strictly scan frames in
 *  [offset, EOF) of `walPath` and hand each to `apply(f, fd)` in order.
 *
 *  Returns the new continuation offset (end of the last fully-valid frame)
 *  and how many frames were applied. An invalid/partial frame anywhere stops
 *  the scan WITHOUT error (a writer mid-writev leaves such a tail; everything
 *  applied before it stands and the next call re-validates from the stopped
 *  offset — its CRC passes once the writev lands). Returns null when `offset`
 *  cannot be a clean frame-boundary continuation (negative, beyond EOF,
 *  pointing at bytes that start no frame, or the file is not the `anchor`
 *  inode — rotation swapped it in the microseconds between the caller's stat
 *  and this open): the caller must fully reopen. */
export function catchUpWal(
  walPath: string,
  offset: number,
  anchor: { dev: number; ino: number },
  apply: (f: FrameRef, fd: number) => void,
): { offset: number; appliedFrames: number } | null {
  let fd: number;
  try {
    fd = fsSync.openSync(walPath, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const st = fsSync.fstatSync(fd);
    if (st.dev !== anchor.dev || st.ino !== anchor.ino) return null;
    const size = st.size;
    if (offset < 0 || offset > size) return null;
    const r = scanFrameRefsFd(fd, { onCorrupt: 'strict', startOffset: offset });
    if (r.frames.length === 0 && r.eofOffset < size) {
      // Bytes at `offset` start no valid frame. An append-only file grows
      // whole frames sequentially, so a torn tail is always a frame PREFIX
      // (starts with the magic): retry next time. Anything else means offset
      // was not a boundary of this file — no valid continuation exists here.
      const n = Math.min(MAGIC.length, size - offset);
      const head = readAtSync(fd, offset, n);
      if (!MAGIC.subarray(0, n).equals(head)) return null;
      return { offset, appliedFrames: 0 };
    }
    for (const f of r.frames) apply(f, fd);
    return { offset: r.eofOffset, appliedFrames: r.frames.length };
  } finally {
    fsSync.closeSync(fd);
  }
}
