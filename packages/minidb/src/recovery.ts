// src/recovery.ts
//
// Startup recovery: load the latest snapshot (if any) then replay the WAL on
// top, last-writer-wins. In valueMode:'disk' recovery scans frames without
// copying values and stores { file, off, len } pointers instead.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { scanFrameRefsFd, scanBatchOpRefs, TYPE_SET, TYPE_DEL, TYPE_BATCH } from './codec.js';
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

function applySetRef(
  f: { key: Buffer; valueOff: number; valLen: number; meta: Buffer | null; expireAt: number },
  file: ValueLoc['file'],
  fd: number,
  store: Store,
  valueMode: ValueMode,
): void {
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
    store.del(f.key);
    return;
  }
  const dt = parseMeta(f.meta);
  if (valueMode === 'disk') {
    const ref: ValueRef = { kind: 'disk', loc: { file, off: f.valueOff, len: f.valLen } };
    store.setRef(f.key, ref, f.expireAt, dt);
  } else {
    store.set(f.key, readAtSync(fd, f.valueOff, f.valLen), f.expireAt, dt);
  }
}

function applyBatchRef(
  f: FrameRef,
  file: ValueLoc['file'],
  fd: number,
  store: Store,
  valueMode: ValueMode,
): void {
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
    if (op.type === TYPE_SET) applySetRef(op, file, fd, store, valueMode);
    else if (op.type === TYPE_DEL) store.del(op.key);
  }
}

function applyFrames(frames: FrameRef[], file: ValueLoc['file'], fd: number, store: Store, valueMode: ValueMode): void {
  for (const f of frames) {
    if (f.type === TYPE_SET) applySetRef(f, file, fd, store, valueMode);
    else if (f.type === TYPE_DEL) store.del(f.key);
    else if (f.type === TYPE_BATCH) applyBatchRef(f, file, fd, store, valueMode);
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
  if (fsSync.existsSync(walPath)) {
    const fd = fsSync.openSync(walPath, 'r');
    let walSize = 0;
    try {
      walSize = fsSync.fstatSync(fd).size;
      const r = scanFrameRefsFd(fd, { onCorrupt: mode });
      applyFrames(r.frames, 'wal', fd, store, valueMode);
      walFrames = r.frames.length;
      walCorrupt = r.corruptRanges;
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
  };
}
