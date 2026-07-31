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

import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export type FsyncPolicy = 'always' | 'everysec' | 'no';

const POLICIES = new Set<FsyncPolicy>(['always', 'everysec', 'no']);

interface PendingWrite {
  buf: Buffer;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** Cumulative WAL counters, owned by MiniDb so they survive WAL rotation
 *  during compaction (which replaces the WAL). */
export interface WalStats {
  walBytesWritten: number;
  /** Successful fsyncs (write-path 'always', background 'everysec', close). */
  walFsyncs: number;
  /** Failed fsync attempts. A background everysec failure does not reject any
   *  write — it is observable only here and via lastWalFsyncError. */
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
        // Skip idle ticks entirely: an everysec WAL with no unsynced writes
        // must not fsync (the previous unconditional fsync cost one syscall +
        // disk wake-up per second for the database's whole lifetime).
        // Sync failures do not reject any write (the page-cache copy is the
        // acknowledged one); they are recorded in stats.walFsyncErrors /
        // lastWalFsyncError instead of being silently swallowed.
        if (this.writeGen === this.syncedGen || this.bgSyncing) return;
        this.bgSyncing = true;
        this.sync()
          .catch(() => {})
          .finally(() => {
            this.bgSyncing = false;
          });
      }, this.syncIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Reject new appends from now on; already-queued frames stay flushable.
   *  Idempotent. */
  seal(): void {
    this.sealed = true;
  }

  /** Append one frame and return its predicted absolute file offset. The offset
   *  is known synchronously because frames are flushed strictly in append order.
   *  NOTE: the frame's bytes are NOT in the file yet — they sit in the in-memory
   *  queue until a later writev lands — so the offset must not be published as a
   *  disk value pointer before `done` resolves: a synchronous positioned read in
   *  that window would hit a short read past the current end of the file. */
  appendLoc(frame: Buffer): { offset: number; done: Promise<void> } {
    if (this.closed) return { offset: -1, done: Promise.reject(new Error('WAL is closed')) };
    if (this.sealed) {
      const err = new Error('WAL is sealed by a compaction rotation; retry against the new WAL');
      (err as { code?: string }).code = 'WAL_SEALED';
      return { offset: -1, done: Promise.reject(err) };
    }
    if (!Buffer.isBuffer(frame)) return { offset: -1, done: Promise.reject(new TypeError('frame must be a Buffer')) };
    const offset = this.nextOffset;
    this.nextOffset += frame.length;
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
    return { offset, done };
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

    this.flushing = true;
    const run = async () => {
      const batch = this.queue;
      this.queue = [];
      const batchBytes = this.queuedBytes;
      this.queuedBytes = 0;
      if (this.stats) {
        this.stats.walQueuedBytes -= batchBytes;
        this.stats.walGroupCommits++;
        this.stats.walGroupCommitFrames += batch.length;
      }
      // writev(2) may short-write (signal interruption, RLIMIT_FSIZE, …). Retry
      // until the whole batch lands so a partial write never rejects frames
      // whose in-memory side effects were already applied. Only a real I/O
      // error (or zero progress) rejects the batch.
      let bufs = batch.map((b) => b.buf);
      let off = 0; // byte offset within bufs[0]
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
        if (this.policy === 'always') await this.sync();
        for (const b of batch) b.resolve();
      } catch (err) {
        for (const b of batch) b.reject(err);
      } finally {
        this.flushing = false;
        this.inflight = null;
        if (this.queue.length > 0 && !this.closed) {
          this.scheduled = true;
          setImmediate(() => { void this.flushBatch(); });
        }
      }
    };
    this.inflight = run();
    return this.inflight;
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
   *  and rethrown, and the WAL stays dirty. */
  async sync(): Promise<void> {
    if (!this.fh) return;
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
   *  frames were still queued, which let compaction truncate un-flushed data. */
  async flush(): Promise<void> {
    while (this.queue.length > 0 || this.inflight) {
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
    // Release the file handle even when the final flush/fsync fails: the error
    // still propagates to the caller, but a half-closed WAL must not leak its
    // fd (a compaction rotation recovering from a failed close swaps in a
    // fresh WAL on the same path and abandons this handle). An fh.close()
    // error itself is swallowed: with the fsync above already durable there
    // is nothing actionable left to report.
    try {
      await this.flush();
      if (this.fh) await this.sync();
    } finally {
      const fh = this.fh;
      this.fh = null;
      if (fh) await fh.close().catch(() => {});
    }
  }
}
