// src/compaction.ts
//
// WAL compaction (a.k.a. snapshot + rewrite).
//
// This is a NON-BLOCKING variant, modelled on Redis's BGREWRITEAOF and
// Bitcask's merge: while the (potentially large) snapshot is being written,
// writers keep appending to the live WAL — the WAL itself acts as the
// "rewrite buffer". Writes are blocked only for a short *rotation* critical
// section at the very end (a flush + a tiny tail copy + two renames).
//
// Phases:
//   1. fence        — flush the WAL, record baseOffset = wal.size. Every write
//                     durable at/before baseOffset is already reflected in the
//                     store (applyOp runs synchronously before the WAL write is
//                     awaited).
//   2. snapshot     — writeSnapshot(store, tmp). NON-BLOCKING. Writers keep
//                     appending to the WAL and mutating the store while we
//                     iterate. The snapshot need NOT be point-in-time: the WAL
//                     tail copied below is replayed last-writer-wins on top of
//                     it, repairing any fuzziness.
//   2.5 pre-copy    — stream WAL[baseOffset .. head] into db.wal.tmp, draining
//                     the bulk of the post-fence tail. NON-BLOCKING. Loops
//                     until the remaining delta is small, so the critical
//                     section stays bounded.
//   3. rotation     — SHORT BLOCKING critical section: set _rotateLock so new
//                     writers park, flush, copy the tiny remaining tail delta,
//                     close the old WAL, rename snapshot then WAL (crash-safe
//                     order), reopen the new WAL.
//   4. bookkeeping  — stats + onCompacted() (rebuild derived text postings).
//
// Crash safety: recovery is `load db.snapshot` + `replay db.wal`, last-writer
// wins. We rename the snapshot BEFORE the WAL. If a crash lands between the two
// renames, the new snapshot is paired with the old full WAL — replaying the
// whole old WAL on top of the new snapshot is idempotent for pre-fence frames
// and correct for post-fence frames, so the state is still consistent. The
// reverse order (WAL first) would pair an old snapshot with a truncated new WAL
// and lose pre-fence data.

import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { WAL } from './wal.js';
import { writeSnapshot } from './snapshot.js';
import type { Store, ValueLoc } from './store.js';
import type { FsyncPolicy } from './wal.js';

/** Structural interface of the bits compaction needs from a MiniDb. */
export interface CompactionTarget {
  dir: string;
  walPath: string;
  fsyncPolicy: FsyncPolicy;
  store: Store;
  wal: WAL;
  compactThresholdBytes: number;
  compacting: boolean;
  _compactDone: Promise<void> | null;
  /** Set only during the short rotation critical section; writers park on it.
   *  Null outside rotation, so the snapshot phase is fully non-blocking. */
  _rotateLock: Promise<void> | null;
  lastCompactError: unknown;
  stats: { compactions: number; walBytesWritten: number; walFsyncs: number; snapshotBytesWritten: number };
  /** Reader for disk-backed values; reopened after snapshot/WAL rotation so
   *  remapped value pointers read from the new files. */
  valueReader?: { reopenBoth(): void };
  /** Optional hook invoked after the snapshot + WAL rotation succeeds, so the
   *  owner can rewrite derived on-disk state (e.g. text postings) against the
   *  new live set. */
  onCompacted?: () => void;
}

export function shouldCompact(db: CompactionTarget): boolean {
  return Boolean(db.wal && db.wal.size >= db.compactThresholdBytes);
}

const COPY_CHUNK = 1 << 20; // 1 MiB read/write coalescing
// A post-fence WAL delta at or below this size is cheap enough to copy inside
// the rotation critical section, so the pre-copy loop stops draining.
const SMALL_DELTA = 64 * 1024; // 64 KiB

export async function fsyncDir(dir: string): Promise<void> {
  let fh: FileHandle | null = null;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch {
    /* best-effort */
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** Stream src[start:end] into dst, fsync'ing dst before returning. With
 *  `append: true` the bytes are appended to an existing dst; otherwise dst is
 *  created/truncated. Uses its own file handles, independent of the WAL's
 *  append handle, so it is safe to read the live WAL while writers append. A
 *  zero-length range still creates/truncates dst (so the new WAL file exists
 *  even when there is no post-fence tail). */
export async function copyFileRange(
  srcPath: string,
  dstPath: string,
  start: number,
  end: number,
  opts: { append?: boolean } = {},
): Promise<void> {
  if (end < start) throw new RangeError(`copyFileRange: end (${end}) < start (${start})`);
  const dst = await fs.open(dstPath, opts.append ? 'a' : 'w');
  try {
    if (end > start) {
      const src = await fs.open(srcPath, 'r');
      try {
        const buf = Buffer.allocUnsafe(COPY_CHUNK);
        let pos = start;
        while (pos < end) {
          const len = Math.min(buf.length, end - pos);
          const { bytesRead } = await src.read(buf, 0, len, pos);
          if (bytesRead === 0) break; // reached EOF earlier than expected
          let written = 0;
          while (written < bytesRead) {
            const { bytesWritten } = await dst.write(buf, written, bytesRead - written);
            if (bytesWritten === 0) throw new Error('copyFileRange: write made no progress (short write)');
            written += bytesWritten;
          }
          pos += bytesRead;
        }
      } finally {
        await src.close().catch(() => {});
      }
    }
    await dst.sync();
  } finally {
    await dst.close().catch(() => {});
  }
}

export async function compact(db: CompactionTarget): Promise<void> {
  if (db.compacting) return db._compactDone ?? undefined;

  db.compacting = true;
  db._compactDone = (async () => {
    try {
      await runCompaction(db);
      db.stats.compactions++;
      db.lastCompactError = null;
      db.onCompacted?.();
    } catch (err) {
      db.lastCompactError = err;
      throw err;
    } finally {
      db.compacting = false;
      // A failed rotation must not leave writers parked forever.
      db._rotateLock = null;
    }
  })();
  return db._compactDone;
}

async function runCompaction(db: CompactionTarget): Promise<void> {
  const tmp = path.join(db.dir, 'db.snapshot.tmp');
  const snap = path.join(db.dir, 'db.snapshot');
  const walTmp = path.join(db.dir, 'db.wal.tmp');

  // Phase 1: fence. Every write durable at/before baseOffset is already
  // reflected in the store, because applyOp() runs synchronously in the same
  // tick as wal.append(), before the op awaits the WAL write.
  await db.wal.flush();
  const baseOffset = db.wal.size;

  // Phase 2: snapshot. NON-BLOCKING — writers keep appending to the WAL and
  // mutating the store while we iterate. Fuzziness is repaired by the tail.
  const snapRes = await writeSnapshot(db.store, tmp);
  db.stats.snapshotBytesWritten += snapRes.bytes;

  // Phase 2.5: pre-copy the post-fence WAL tail into db.wal.tmp. NON-BLOCKING.
  // Drain until the remaining delta is small enough to copy inside the critical
  // section. Each iteration flushes to get a stable `head`, then copies the
  // bytes that landed since the previous iteration. The loop converges because
  // sequential copy is far faster than fsync-bound writes; if writes ever
  // outrun the copy, the critical section simply absorbs a larger delta (still
  // correct, just a longer pause — no worse than the old stop-the-world).
  let copiedUpTo = baseOffset;
  let appended = false;
  for (;;) {
    await db.wal.flush();
    const head = db.wal.size;
    if (head - copiedUpTo <= SMALL_DELTA) break;
    await copyFileRange(db.walPath, walTmp, copiedUpTo, head, { append: appended });
    appended = true;
    copiedUpTo = head;
  }

  // Phase 3: rotation. SHORT BLOCKING critical section.
  //
  // Setting _rotateLock is synchronous and happens-before the flush below. A
  // writer's gate check (`if (_rotateLock) await _rotateLock`) and its
  // wal.append() are in the same synchronous segment, so either the writer saw
  // the old (null) lock and already enqueued its frame (→ drained by flush), or
  // it sees the new lock and parks without appending. The event loop cannot
  // interleave between the two, so after flush() the queue is quiescent and
  // endOffset is final.
  let releaseRotation!: () => void;
  db._rotateLock = new Promise<void>((resolve) => {
    releaseRotation = resolve;
  });
  try {
    await db.wal.flush();
    const endOffset = db.wal.size;
    await copyFileRange(db.walPath, walTmp, copiedUpTo, endOffset, { append: appended });

    await db.wal.close();

    // Snapshot first, then WAL — see the crash-safety note in the file header.
    await fs.rename(tmp, snap);
    await fsyncDir(db.dir);
    await fs.rename(walTmp, db.walPath);
    await fsyncDir(db.dir);

    db.wal = new WAL(db.walPath, { fsyncPolicy: db.fsyncPolicy, stats: db.stats });
    await db.wal.open();

    // Remap disk-backed value pointers to the new snapshot/WAL files. Do this in
    // the same synchronous segment as the fd reopen, so synchronous readers can
    // never observe a new pointer against an old fd or vice versa.
    const snapLocs = snapRes.locs;
    db.store.remapLocs((k: string, loc: ValueLoc) => {
      if (loc.file === 'wal' && loc.off >= baseOffset) {
        return { file: 'wal', off: loc.off - baseOffset, len: loc.len };
      }
      return snapLocs.get(k);
    });
    db.valueReader?.reopenBoth();
  } finally {
    releaseRotation();
    db._rotateLock = null;
  }
}
