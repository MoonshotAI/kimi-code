// src/wal.ts
//
// Write-ahead log: buffered, append-only, group-committed, with three fsync
// policies matching Redis AOF.
//
//   'always'   — write + fsync for every flush (safest, slowest)
//   'everysec' — write every flush; fsync on a 1s timer (default; ≤1s loss window)
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

export interface WALOptions {
  fsyncPolicy?: FsyncPolicy;
  syncIntervalMs?: number;
  /** Optional sink for cumulative write/fsync counters. Owned by MiniDb so the
   *  counts survive WAL rotation during compaction (which replaces the WAL). */
  stats?: { walBytesWritten: number; walFsyncs: number };
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly stats: { walBytesWritten: number; walFsyncs: number } | null;

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
        this.sync().catch(() => {});
      }, this.syncIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Append one frame and return its predicted absolute file offset. The offset
   *  is known synchronously because frames are flushed strictly in append order.
   *  NOTE: the frame's bytes are NOT in the file yet — they sit in the in-memory
   *  queue until a later writev lands — so the offset must not be published as a
   *  disk value pointer before `done` resolves: a synchronous positioned read in
   *  that window would hit a short read past the current end of the file. */
  appendLoc(frame: Buffer): { offset: number; done: Promise<void> } {
    if (this.closed) return { offset: -1, done: Promise.reject(new Error('WAL is closed')) };
    if (!Buffer.isBuffer(frame)) return { offset: -1, done: Promise.reject(new TypeError('frame must be a Buffer')) };
    const offset = this.nextOffset;
    this.nextOffset += frame.length;
    const done = new Promise<void>((resolve, reject) => {
      this.queue.push({ buf: frame, resolve, reject });
      this.queuedBytes += frame.length;
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
      this.queuedBytes = 0;
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

  /** Force an fsync of the underlying file. */
  async sync(): Promise<void> {
    if (this.fh) {
      await this.fh.sync();
      if (this.stats) this.stats.walFsyncs++;
    }
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
    await this.flush();
    if (this.fh) {
      await this.sync();
      await this.fh.close();
      this.fh = null;
    }
  }
}
