// src/wal.ts
//
// Write-ahead log: buffered, append-only, group-committed, with three fsync
// policies matching Redis AOF.
//
//   'always'   — write + fsync for every flush (safest, slowest)
//   'everysec' — write every flush; fsync on a 1s timer, but only while there
//                are writes not yet covered by a successful fsync (default;
//                ≤1s loss window; an idle WAL never fsyncs)
//   'no'       — write only; let the OS flush (fastest, may lose seconds)
//
// Group commit: all append() calls within a tick are coalesced into a single
// writev(2) syscall on the next macrotask. Only one flush is ever in flight, so
// frames reach disk strictly in append order (single-writer, like SQLite WAL).
//
// Write-failure semantics (the commit point): a writev or write-path fsync
// failure in a flush POISONS the WAL. The poison records the failed batch's
// first predicted offset — every byte at/after it may have reached the file
// without being acknowledged. While poisoned, appends reject with
// 'WAL_POISONED', flush() throws, sync() is a no-op, and close() skips its
// final flush. The owner (MiniDb) recovers in place: truncate the file to the
// poison offset (removing exactly the un-acked bytes), refreshSize(), then
// clearPoison(). A background everysec sync failure never poisons: it rejects
// no write and is observable only in stats (stage-1 semantics).

import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { OpTracker } from './op-tracker.js';

export type FsyncPolicy = 'always' | 'everysec' | 'no';

const POLICIES = new Set<FsyncPolicy>(['always', 'everysec', 'no']);

interface PendingWrite {
  buf: Buffer;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** The failure that poisoned the WAL plus the offset the owner must truncate
 *  the file to for in-place recovery: every acknowledged frame sits in
 *  earlier, successful batches, so truncating here removes exactly the
 *  un-acked bytes. */
export interface WalPoison {
  failedAtOffset: number;
  error: unknown;
}

/** Cumulative WAL counters, owned by MiniDb so they survive WAL rotation
 *  during compaction (which replaces the WAL). */
export interface WalStats {
  walBytesWritten: number;
  /** Successful fsyncs (write-path 'always', background 'everysec', close). */
  walFsyncs: number;
  /** Failed writev-class attempts on the write path. Each one poisons the WAL
   *  (see the header) and triggers the owner's in-place recovery. */
  walWriteErrors: number;
  /** Failed fsync attempts. A background everysec failure does not reject any
   *  write — it is observable only here and via lastWalFsyncError. A
   *  write-path ('always') failure rejects its batch and poisons the WAL. */
  walFsyncErrors: number;
  /** Sticky copy of the most recent fsync failure (never cleared on success). */
  lastWalFsyncError: unknown;
  /** Bytes currently sitting in the in-memory append queue. */
  walQueuedBytes: number;
  /** High-water mark of walQueuedBytes. */
  walMaxQueuedBytes: number;
  /** Number of group commits (one per flushed batch). */
  walGroupCommits: number;
  /** Total frames carried by those group commits. */
  walGroupCommitFrames: number;
}

export interface WALOptions {
  fsyncPolicy?: FsyncPolicy;
  syncIntervalMs?: number;
  /** Optional sink for cumulative write/fsync counters. Owned by MiniDb so the
   *  counts survive WAL rotation during compaction (which replaces the WAL). */
  stats?: WalStats;
}

export class WAL {
  readonly path: string;
  private readonly policy: FsyncPolicy;
  private readonly syncIntervalMs: number;

  private fh: FileHandle | null = null;
  size = 0; // bytes on disk (best-effort; updated after each write)
  private nextOffset = 0; // logical next append offset, including queued/in-flight frames
  private queue: PendingWrite[] = [];
  private queuedBytes = 0;
  private flushing = false;
  private inflight: Promise<unknown> | null = null;
  private scheduled = false;
  /** When sealed, appendLoc rejects new frames (code 'WAL_SEALED') while the
   *  already-queued frames can still be flushed. Compaction rotation seals the
   *  old WAL so no append can slip between the final flush and close(): any
   *  frame that will ever land in the old file is durable after one flush. */
  private sealed = false;
  /** Set by the first failed flush (or poisonPending): the WAL stops accepting
   *  appends until the owner recovers it in place (see the header). Distinct
   *  from `sealed`: seal is a normal compaction rotation (rejections are
   *  retried against the new WAL), poison is a fault state (hard failures). */
  private poisoned: WalPoison | null = null;
  /** Id of the batch the next drain will carry. appendLoc stamps each frame
   *  with it so the owner can track per-flush-group pre-state; flushBatch
   *  increments it at drain time, so same-tick appends always share an id. */
  private nextBatchId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly stats: WalStats | null;
  /** Durability watermark, Redis-AOF style: writeGen counts the writev batches
   *  that landed in the OS page cache, syncedGen the watermark the last
   *  successful fsync is known to cover. The WAL is dirty while they differ.
   *  A generation (not a boolean) so a successful fsync never clears writes a
   *  concurrent flush landed while the fsync was in flight. */
  private writeGen = 0;
  private syncedGen = 0;
  /** Set while a background (everysec) sync is in flight, so a slow fsync
   *  never stacks a second background fsync on top of itself. */
  private bgSyncing = false;
  /** Tracks every in-flight background sync so close() can drain them before
   *  the final flush/sync/fd-close (review #13): the timer only FIRES ticks,
   *  the tracker owns their lifetimes. */
  private readonly bgSync = new OpTracker();

  constructor(path: string, opts: WALOptions = {}) {
    const policy = opts.fsyncPolicy ?? 'everysec';
    if (!POLICIES.has(policy)) throw new RangeError(`unknown fsyncPolicy: ${policy}`);
    this.path = path;
    this.policy = policy;
    this.syncIntervalMs = opts.syncIntervalMs ?? 1000;
    this.stats = opts.stats ?? null;
  }

  async open(): Promise<void> {
    if (this.fh) return;
    this.fh = await fs.open(this.path, 'a'); // create + append at EOF
    const st = await this.fh.stat();
    this.size = st.size;
    this.nextOffset = st.size;
    if (this.policy === 'everysec') {
      this.timer = setInterval(() => {
        void this.backgroundTick();
      }, this.syncIntervalMs);
      this.timer.unref?.();
    }
  }

  /** One everysec background-sync tick. Extracted from the timer callback so
   *  tests can drive it deterministically (the wal/stats suites open with a
   *  huge syncIntervalMs and call this directly instead of racing the wall
   *  clock). Returns the tracked sync's settle promise, or null when the tick
   *  was skipped: the WAL is clean (idle ticks must not fsync — the previous
   *  unconditional fsync cost one syscall + disk wake-up per second for the
   *  database's whole lifetime), a sync is already in flight, or close() shut
   *  the tracker's gate. Sync failures do not reject any write (the page-cache
   *  copy is the acknowledged one); they are recorded in stats.walFsyncErrors /
   *  lastWalFsyncError instead of being silently swallowed. */
  private backgroundTick(): Promise<void> | null {
    if (this.writeGen === this.syncedGen || this.bgSyncing) return null;
    if (!this.bgSync.enter()) return null;
    this.bgSyncing = true;
    const run = this.sync()
      .catch(() => {})
      .finally(() => {
        this.bgSyncing = false;
        this.bgSync.leave();
      });
    return run;
  }

  /** Reject new appends from now on; already-queued frames stay flushable.
   *  Idempotent. */
  seal(): void {
    this.sealed = true;
  }

  /** Append one frame and return its predicted absolute file offset plus the
   *  id of the flush batch that will carry it. The offset is known
   *  synchronously because frames are flushed strictly in append order.
   *  NOTE: the frame's bytes are NOT in the file yet — they sit in the in-memory
   *  queue until a later writev lands — so the offset must not be published as a
   *  disk value pointer before `done` resolves: a synchronous positioned read in
   *  that window would hit a short read past the current end of the file.
   *  batchId is -1 for frames that never entered a group (immediate
   *  rejections: closed/poisoned/sealed/invalid). */
  appendLoc(frame: Buffer): { offset: number; batchId: number; done: Promise<void> } {
    if (this.closed) return { offset: -1, batchId: -1, done: Promise.reject(new Error('WAL is closed')) };
    if (this.poisoned) return { offset: -1, batchId: -1, done: Promise.reject(this.poisonError()) };
    if (this.sealed) {
      const err = new Error('WAL is sealed by a compaction rotation; retry against the new WAL');
      (err as { code?: string }).code = 'WAL_SEALED';
      return { offset: -1, batchId: -1, done: Promise.reject(err) };
    }
    if (!Buffer.isBuffer(frame)) {
      return { offset: -1, batchId: -1, done: Promise.reject(new TypeError('frame must be a Buffer')) };
    }
    const offset = this.nextOffset;
    this.nextOffset += frame.length;
    const batchId = this.nextBatchId;
    const done = new Promise<void>((resolve, reject) => {
      this.queue.push({ buf: frame, resolve, reject });
      this.queuedBytes += frame.length;
      if (this.stats) {
        this.stats.walQueuedBytes += frame.length;
        if (this.stats.walQueuedBytes > this.stats.walMaxQueuedBytes) {
          this.stats.walMaxQueuedBytes = this.stats.walQueuedBytes;
        }
      }
      if (!this.flushing && !this.scheduled) {
        this.scheduled = true;
        setImmediate(() => { void this.flushBatch(); });
      }
    });
    return { offset, batchId, done };
  }

  /** Append one frame. Resolves once written to the OS page cache; for
   * fsyncPolicy 'always' it additionally waits for fsync. */
  append(frame: Buffer): Promise<void> {
    return this.appendLoc(frame).done;
  }

  private async flushBatch(): Promise<unknown> {
    this.scheduled = false;
    if (this.flushing) return this.inflight;
    if (this.queue.length === 0) return null;
    if (this.poisoned) return null; // defensive: the queue stays empty while poisoned

    this.flushing = true;
    const run = async () => {
      const batch = this.queue;
      this.queue = [];
      const batchBytes = this.queuedBytes;
      this.queuedBytes = 0;
      this.nextBatchId++;
      if (this.stats) {
        this.stats.walQueuedBytes -= batchBytes;
        this.stats.walGroupCommits++;
        this.stats.walGroupCommitFrames += batch.length;
      }
      // The predicted offset of the batch's first frame: the owner's recovery
      // truncation point if this flush fails. Captured now — later appends
      // move nextOffset forward.
      const batchStartOffset = this.nextOffset - batchBytes;
      // writev(2) may short-write (signal interruption, RLIMIT_FSIZE, …). Retry
      // until the whole batch lands so a partial write never rejects frames
      // whose in-memory side effects were already applied. Only a real I/O
      // error (or zero progress) rejects the batch.
      let bufs = batch.map((b) => b.buf);
      let off = 0; // byte offset within bufs[0]
      let failure: unknown = null;
      try {
        while (bufs.length > 0) {
          const toWrite = off > 0 ? [bufs[0]!.subarray(off), ...bufs.slice(1)] : bufs;
          const { bytesWritten } = await this.fh!.writev(toWrite);
          if (bytesWritten === 0) throw new Error('WAL writev made no progress (short write)');
          this.size += bytesWritten;
          if (this.stats) this.stats.walBytesWritten += bytesWritten;
          // The bytes are in the OS page cache but not necessarily on disk:
          // the WAL is dirty until a successful fsync covers this generation.
          this.writeGen++;
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
      } catch (err) {
        failure = err;
        if (this.stats) this.stats.walWriteErrors++;
      }
      if (!failure && this.policy === 'always') {
        // sync() records walFsyncErrors itself. The batch's bytes are in the
        // page cache but unacknowledged, so an fsync failure poisons exactly
        // like a write failure.
        try {
          await this.sync();
        } catch (err) {
          failure = err;
        }
      }
      if (failure) {
        this.poisonWith(batchStartOffset, failure);
        // Reject the still-queued frames first (reverse enqueue order: newest
        // flush group first, so the owner's group rollback unwinds
        // newest-first), then this batch's frames with the original error —
        // the oldest group's rollback must run last.
        const perr = this.poisonError();
        this.rejectQueued(perr);
        for (const b of batch) b.reject(failure);
      } else {
        for (const b of batch) b.resolve();
      }
      this.flushing = false;
      this.inflight = null;
      if (this.queue.length > 0 && !this.closed && !this.poisoned) {
        this.scheduled = true;
        setImmediate(() => { void this.flushBatch(); });
      }
    };
    this.inflight = run();
    return this.inflight;
  }

  /** Non-null while the WAL is poisoned by a failed flush (or poisonPending):
   *  the failure and the owner's in-place recovery truncation point. */
  get poison(): WalPoison | null {
    return this.poisoned;
  }

  /** The logical next append offset, including queued-but-unflushed frames:
   *  every frame already accepted sits strictly below it, and any later frame
   *  starts at/above it. Stage 5's generation build seals its checkpoint at
   *  this watermark (every op applied so far has its frame below it, because
   *  a commit body appends before it applies, in the same tick). */
  get appendOffset(): number {
    return this.nextOffset;
  }

  /** Clear the poison after the owner truncated the file to failedAtOffset
   *  and re-synced size bookkeeping via refreshSize(): the write path resumes. */
  clearPoison(): void {
    this.poisoned = null;
  }

  /** Poison the WAL from outside the flush path — used when a post-append
   *  in-memory apply fails (MiniDb's applyOp contract violation): every queued
   *  frame is un-acked and must never reach disk, exactly as if the flush
   *  carrying it had failed. The truncation point is the start of the queued
   *  region; an in-flight batch keeps its own fate. */
  poisonPending(error: unknown): void {
    if (this.closed) return;
    this.poisonWith(this.nextOffset - this.queuedBytes, error);
    this.rejectQueued(this.poisonError());
  }

  private poisonWith(failedAtOffset: number, error: unknown): void {
    if (this.poisoned) {
      // Already poisoned (poisonPending raced a flush failure, or a second
      // batch failed): widen the truncation point to also cover the older
      // un-acked bytes, never narrowing it.
      this.poisoned.failedAtOffset = Math.min(this.poisoned.failedAtOffset, failedAtOffset);
      return;
    }
    this.poisoned = { failedAtOffset, error };
  }

  /** Reject every queued frame with `perr` in reverse enqueue order (see the
   *  flushBatch failure path for why newest-first matters). */
  private rejectQueued(perr: Error): void {
    if (this.queue.length === 0) return;
    for (let i = this.queue.length - 1; i >= 0; i--) this.queue[i]!.reject(perr);
    if (this.stats) this.stats.walQueuedBytes -= this.queuedBytes;
    this.queue = [];
    this.queuedBytes = 0;
  }

  /** The rejection appends and flush() see while poisoned. 'WAL_POISONED' is
   *  deliberately distinct from 'WAL_SEALED': seal is a normal rotation
   *  (callers retry against the new WAL), poison is a hard failure the caller
   *  must treat as ambiguous. */
  private poisonError(): Error {
    const cause = this.poisoned?.error;
    const err = new Error(
      `WAL is poisoned by a previous write failure: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    (err as { code?: string }).code = 'WAL_POISONED';
    (err as { cause?: unknown }).cause = cause;
    return err;
  }

  /** Await the currently in-flight flush (if any) without scheduling new
   *  ones. Used by the owner's in-place recovery: a poisonPending truncation
   *  point is predicted against the in-flight batch fully landing, so the
   *  truncate must wait for that batch to settle — on success the point lies
   *  beyond its bytes, on failure poisonWith already widened the point to
   *  cover them. Never rejects (flushBatch settles its frames itself). */
  async whenIdle(): Promise<void> {
    await this.inflight;
  }

  /** Re-sync size/nextOffset with the file on disk. Required after recovery
   *  truncates a torn WAL tail: the truncate happens on the path behind this
   *  WAL's back, and stale bookkeeping would otherwise make later appends
   *  publish value pointers offset by the torn byte count (reads then hit the
   *  wrong frames). */
  async refreshSize(): Promise<void> {
    if (!this.fh) return;
    const st = await this.fh.stat();
    this.size = st.size;
    this.nextOffset = st.size;
  }

  /** Force an fsync of the underlying file. On success the durability
   *  watermark advances to the write generation sampled when the fsync was
   *  issued; a failure is recorded (walFsyncErrors + sticky lastWalFsyncError)
   *  and rethrown, and the WAL stays dirty. A no-op while poisoned: the tail
   *  is about to be truncated by the owner's recovery, so syncing it reports
   *  nothing actionable. */
  async sync(): Promise<void> {
    if (!this.fh || this.poisoned) return;
    const gen = this.writeGen;
    try {
      await this.fh.sync();
    } catch (err) {
      if (this.stats) {
        this.stats.walFsyncErrors++;
        this.stats.lastWalFsyncError = err;
      }
      throw err;
    }
    if (this.stats) this.stats.walFsyncs++;
    // Only generations issued BEFORE this fsync may be marked synced: a flush
    // that landed while the fsync was in flight is not covered by it, so the
    // WAL stays dirty and the next tick syncs again.
    if (this.syncedGen < gen) this.syncedGen = gen;
  }

  /** Flush buffered frames to the OS (without necessarily fsync'ing).
   *  Loops until everything queued up to now has been flushed: an earlier
   *  version only awaited the in-flight batch and could return while newer
   *  frames were still queued, which let compaction truncate un-flushed data.
   *  Throws the poison error when the WAL is (or becomes) poisoned: a caller
   *  that needs a durable fence (compaction, backup) must fail there instead
   *  of building on a tail the owner's recovery is about to truncate. */
  async flush(): Promise<void> {
    for (;;) {
      if (this.poisoned) throw this.poisonError();
      if (this.queue.length === 0 && !this.inflight) return;
      if (this.inflight) await this.inflight;
      if (this.queue.length > 0) await this.flushBatch();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Drain any background sync already in flight before the final
    // flush/sync/fd-close below (review #13): the timer is stopped, so no new
    // tick fires, and the closed tracker gate rejects any tick racing in —
    // what is already flying settles here instead of fsync'ing a dying fd.
    await this.bgSync.close();
    // Release the file handle even when the final flush/fsync fails: the error
    // still propagates to the caller, but a half-closed WAL must not leak its
    // fd (a compaction rotation recovering from a failed close swaps in a
    // fresh WAL on the same path and abandons this handle). An fh.close()
    // error itself is swallowed: with the fsync above already durable there
    // is nothing actionable left to report. While poisoned the final flush is
    // skipped entirely — the queue was drained with rejections and the tail
    // belongs to the owner's recovery (or the write-disabled state). A flush
    // that fails HERE (the final flush itself drives a queued failing batch)
    // poisons the WAL the same way and is swallowed identically: the frames
    // were rejected and the owner's recovery — which MiniDb.close() awaits
    // right after this — owns the tail.
    try {
      if (!this.poisoned) {
        try {
          await this.flush();
        } catch (err) {
          if (!this.poisoned) throw err;
        }
        if (this.fh) await this.sync();
      }
    } finally {
      const fh = this.fh;
      this.fh = null;
      if (fh) await fh.close().catch(() => {});
    }
  }
}
