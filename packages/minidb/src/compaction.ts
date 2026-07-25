// src/compaction.ts
//
// WAL compaction (a.k.a. snapshot + rewrite).
//
// This is a NON-BLOCKING variant, modelled on Redis's BGREWRITEAOF and
// Bitcask's merge: while the (potentially large) snapshot is being written,
// writers keep appending to the live WAL — the WAL itself acts as the
// "rewrite buffer". Writes are blocked only for the *rotation* critical
// section at the very end (a flush + a bounded tail copy + two renames).
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
//                     the bulk of the post-fence tail. NON-BLOCKING. Loops while
//                     the copy is CONVERGING (the remaining delta shrinks fast
//                     enough) and gives up after a few passes otherwise —
//                     chasing a tail under writes that append as fast as the
//                     copy drains would otherwise never terminate, stalling
//                     compaction for as long as the write storm lasts.
//   3. rotation     — BLOCKING critical section: set _rotateLock so new writers
//                     park, seal the old WAL (post-seal appends fail fast and
//                     are retried by the op against the new WAL), flush, then
//                     copy the remaining tail. With the WAL sealed and writers
//                     parked the head no longer moves, so this copy provably
//                     finishes; the pause scales with the tail the pre-copy did
//                     not drain — the same bounded end-of-rewrite pause Redis
//                     accepts for its AOF diff flush.
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
import { renameReplace } from './rename-replace.js';
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
  stats: { compactions: number; walBytesWritten: number; walFsyncs: number; snapshotBytesWritten: number; compactErrors?: number };
  /** Reader for disk-backed values; reopened after snapshot/WAL rotation so
   *  remapped value pointers read from the new files. On Windows it is also
   *  closed before the rotation renames (see rotateReplace). */
  valueReader?: { reopenBoth(): void; close?(): void };
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

// Windows cannot rename over an open destination; rotation uses the shared
// retrying replace helper (see rename-replace.ts).
const rotateReplace = (src: string, dst: string): Promise<void> => renameReplace(src, dst);
// Pre-copy convergence bounds: each pass costs roughly `gap / copyRate` and
// appends `gap * (appendRate / copyRate)` new bytes during the copy. Give up
// when a pass fails to shrink the gap meaningfully (appendRate ≳ copyRate),
// or after this many passes regardless — the rotation critical section (with
// the WAL sealed and writers parked) then absorbs the remaining tail.
const MAX_PRECOPY_PASSES = 5;
const CONVERGE_RATIO = 0.7;

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
      // The onCompacted hook is part of the compaction: a run whose hook
      // throws is counted as a compactError, not a successful compaction.
      db.onCompacted?.();
      db.stats.compactions++;
      db.lastCompactError = null;
    } catch (err) {
      db.stats.compactErrors = (db.stats.compactErrors ?? 0) + 1;
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
  // Each pass flushes to get a stable `head`, then copies the bytes that landed
  // since the previous pass. The loop only continues while it is CONVERGING:
  // under sustained writes whose append rate approaches the copy rate the gap
  // stops shrinking, and looping until it was small enough would never
  // terminate (stalling compaction for the whole write storm — observed in the
  // field as compactions=0 forever while the WAL grew unboundedly). Give up to
  // the rotation critical section instead, which finishes because the sealed
  // WAL + parked writers freeze the head.
  let copiedUpTo = baseOffset;
  let appended = false;
  let prevGap = Number.POSITIVE_INFINITY;
  for (let pass = 0; pass < MAX_PRECOPY_PASSES; pass++) {
    await db.wal.flush();
    const head = db.wal.size;
    const gap = head - copiedUpTo;
    if (gap <= SMALL_DELTA) break;
    if (pass > 0 && gap > prevGap * CONVERGE_RATIO) break; // not converging: rotate with a parked writer set
    await copyFileRange(db.walPath, walTmp, copiedUpTo, head, { append: appended });
    appended = true;
    copiedUpTo = head;
    prevGap = gap;
  }

  // Phase 3: rotation. BLOCKING critical section.
  //
  // Setting _rotateLock is synchronous and happens-before the seal below. New
  // writers park on the lock; an in-flight writer that passed the gate check
  // just before the lock landed cannot have its append slip between the final
  // flush and close(), because seal() makes any post-seal append fail fast
  // (the op retries against the new WAL once the rotation is done). With the
  // old WAL sealed, its head no longer moves after this drain loop, so the
  // loop provably terminates — at the cost of a write pause proportional to
  // the tail the pre-copy could not drain.
  //
  // Recovery: the seal is one-way and the old WAL object is single-use, so a
  // failure anywhere between the seal and the new WAL's open would leave every
  // later write hitting WAL_SEALED/'WAL is closed' forever. The catch below
  // rolls the db forward to a writable state by swapping in a FRESH WAL on
  // db.walPath (it appends at the real EOF of whatever file the path now
  // holds). `rotated` tracks the commit point: before the WAL rename the old
  // full WAL is still at db.walPath and the old store pointers stay valid (a
  // renamed-in new snapshot paired with the old WAL is consistent — see the
  // crash-safety note above); past it, the new layout is on disk and recovery
  // must additionally apply the store-pointer remap + reader reopen. If the
  // rollback itself also fails (e.g. persistent EMFILE), the db stays
  // unwritable but the on-disk snapshot/WAL pair is consistent either way, so
  // the next process open still recovers.
  let releaseRotation!: () => void;
  db._rotateLock = new Promise<void>((resolve) => {
    releaseRotation = resolve;
  });
  let rotated = false;
  let remapped = false;
  // Remap disk-backed value pointers to the new snapshot/WAL files. Guarded
  // against double application: the wal-offset shift is NOT idempotent.
  const remap = (): void => {
    if (remapped) return;
    const snapLocs = snapRes.locs;
    db.store.remapLocs((k: string, loc: ValueLoc) => {
      if (loc.file === 'wal' && loc.off >= baseOffset) {
        return { file: 'wal', off: loc.off - baseOffset, len: loc.len };
      }
      return snapLocs.get(k);
    });
    remapped = true;
  };
  try {
    db.wal.seal();
    for (;;) {
      await db.wal.flush();
      const endOffset = db.wal.size;
      // `!appended` guarantees the (possibly empty) new WAL file is created
      // even when there is no post-fence tail to copy.
      if (endOffset === copiedUpTo && appended) break;
      await copyFileRange(db.walPath, walTmp, copiedUpTo, endOffset, { append: appended });
      appended = true;
      copiedUpTo = endOffset;
    }

    await db.wal.close();

    // Windows cannot rename over an open destination, so our own ValueReader
    // must let go of the old snapshot/WAL before the renames below. POSIX
    // keeps the handles across the rotation (old fd reads the unlinked old
    // inode) — no close needed there; after the remap segment below,
    // reopenBoth() re-attaches both handles on every platform.
    if (process.platform === 'win32') db.valueReader?.close?.();

    // Snapshot first, then WAL — see the crash-safety note in the file header.
    await rotateReplace(tmp, snap);
    await fsyncDir(db.dir);
    await rotateReplace(walTmp, db.walPath);
    rotated = true;
    await fsyncDir(db.dir);

    const fresh = new WAL(db.walPath, { fsyncPolicy: db.fsyncPolicy, stats: db.stats });
    db.wal = fresh;
    await fresh.open();

    // Commit the in-memory view to the new files. Do this in the same
    // synchronous segment as the fd reopen, so synchronous readers can never
    // observe a new pointer against an old fd or vice versa.
    remap();
    db.valueReader?.reopenBoth();
  } catch (err) {
    try {
      // Swap the sealed/closed WAL for a fresh handle on db.walPath. The swap
      // comes first: it both restores appendability and stops late in-flight
      // writers from publishing old-file value pointers against the fresh WAL.
      await db.wal.close().catch(() => {});
      const fresh = new WAL(db.walPath, { fsyncPolicy: db.fsyncPolicy, stats: db.stats });
      await fresh.open();
      db.wal = fresh;
      if (rotated) {
        remap();
        db.valueReader?.reopenBoth();
      }
    } catch {
      // Best-effort recovery only — on-disk state is consistent regardless.
    }
    throw err;
  } finally {
    releaseRotation();
    db._rotateLock = null;
  }
}
