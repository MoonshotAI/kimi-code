// src/cluster/lock-pool.ts
//
// Per-process cache of opened shards.
//
// Writers: MiniDb instances holding the shard's db.lock. While a process
// holds a shard's write lock it is by definition the only writer of that
// shard, so the cached writer's in-memory view is authoritative and current.
// Cached writers are LRU-evicted (only when idle) down to a soft cap.
//
// Readers: read-only MiniDb instances used for keys whose shard this process
// does not currently hold. A MiniDb reader replays snapshot+WAL only at open
// time and would go stale afterwards, so every reader use is guarded by a
// cheap file fingerprint (mtime+size of the shard's WAL, snapshot and index
// definition files). A change refreshes the reader first:
//  - when only the WAL changed as pure appends on the same inode (tracked by
//    a {dev, ino, size} watermark), the appended frames are scanned and
//    applied incrementally (MiniDb.catchUpFromWal) — O(delta);
//  - anything else (rotation, truncation, snapshot/index-def changes, an
//    offset that turns out not to be a frame boundary) falls back to a close
//    + full reopen — O(shard size).
// Because a writer's WAL append is complete before its set() resolves, a read
// that starts after another process's write resolved always observes it.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { MiniDb } from '../index.js';
import { LockError } from '../lockfile.js';
import { ShardHandle } from './shard.js';
import type { ShardOpenOptions } from './shard.js';
import { sleep } from './utils.js';

export interface LockPoolOptions {
  writerOpts: ShardOpenOptions;
  readerOpts: ShardOpenOptions;
  lockRenewMs: number;
  lockAcquireTimeoutMs: number;
  lockHoldMs: number;
  maxWriters: number;
  maxReaders: number;
  /** Cluster-wide read-only: withWriter rejects, withReader never uses cached writers. */
  readOnly: boolean;
  /** Apply cluster-wide index definitions to a freshly opened writer. */
  applyDefs: (db: MiniDb<unknown>) => Promise<void>;
}

interface WriterEntry {
  handle: ShardHandle;
  lastUsedAt: number;
  busy: number;
  /** Set once the hold window expired while busy; closed at the next idle point. */
  retire: boolean;
  /** When the process should yield this shard's lock (Infinity: never by time). */
  expiresAt: number;
}

interface ReaderEntry {
  handle: ShardHandle;
  fingerprint: string;
  /** Per-file fingerprint parts, in FINGERPRINT_FILES order. */
  fpParts: string[];
  /** WAL watermark the instance's data represents: the {dev, ino} anchor of
   *  the WAL inode recovery (or the last catch-up) read, and the byte offset
   *  up to which frames were applied. null when the shard has no WAL yet. */
  walMark: { dev: number; ino: number; size: number } | null;
  lastUsedAt: number;
  busy: number;
}

async function statFingerprint(file: string): Promise<string> {
  try {
    const s = await fs.stat(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
}

/** Cheap change detector for a shard directory. WAL appends change size (and
 *  usually mtime); compaction swaps both snapshot and WAL; index definition
 *  changes rewrite their JSON files. */
const FINGERPRINT_FILES = ['db.wal', 'db.snapshot', 'db.indexes.json', 'db.textindexes.json'] as const;

async function shardFingerprint(dir: string): Promise<string[]> {
  return Promise.all(FINGERPRINT_FILES.map((f) => statFingerprint(path.join(dir, f))));
}

/** WAL watermark for a freshly opened reader: the exact inode recovery
 *  scanned and the offset up to which frames were replayed — never an offset
 *  beyond the replayed state, so frames appended during/after the open are
 *  picked up by a later incremental catch-up instead of being skipped. */
function readerWalMark(handle: ShardHandle): ReaderEntry['walMark'] {
  const ri = handle.db.recoveryInfo;
  if (!ri || !ri.walIno) return null;
  return { dev: ri.walDev, ino: ri.walIno, size: ri.walScanEnd };
}

export class ShardLockPool {
  private readonly writers = new Map<number, WriterEntry>();
  private readonly readers = new Map<number, ReaderEntry>();
  private readonly openingWriters = new Map<number, Promise<WriterEntry>>();
  private readonly openingReaders = new Map<number, Promise<ReaderEntry>>();
  private closed = false;

  readonly stats = {
    writerOpens: 0,
    readerOpens: 0,
    readerReopens: 0,
    incrementalCatchups: 0,
    catchupFramesApplied: 0,
    lockWaits: 0,
    evictions: 0,
  };

  constructor(private readonly opts: LockPoolOptions) {}

  get writersCached(): number {
    return this.writers.size;
  }
  get readersCached(): number {
    return this.readers.size;
  }

  /** Run fn against the shard's writer, opening it (with lock retry) if this
   *  process does not hold it yet. The writer cannot be evicted while busy. */
  async withWriter<T>(shardId: number, dir: string, fn: (db: MiniDb<unknown>) => T | Promise<T>): Promise<T> {
    if (this.opts.readOnly) throw new Error('ClusterDb is open in read-only mode');
    if (this.closed) throw new Error('ClusterDb is closed');
    const entry = await this.acquireWriter(shardId, dir);
    entry.busy++;
    try {
      return await fn(entry.handle.db);
    } finally {
      entry.busy--;
      entry.lastUsedAt = Date.now();
      if (entry.retire && entry.busy === 0) {
        // The hold window expired while ops were in flight: yield the lock so
        // other processes can take the shard over.
        if (this.writers.get(shardId) === entry) this.writers.delete(shardId);
        await entry.handle.close().catch(() => {});
      }
      await this.evictWriters();
    }
  }

  /** Run fn against the best available read view of the shard: the cached
   *  writer when this process holds the shard (current and lock-free), else a
   *  fingerprint-revalidated read-only instance. */
  async withReader<T>(shardId: number, dir: string, fn: (db: MiniDb<unknown>) => T | Promise<T>): Promise<T> {
    if (this.closed) throw new Error('ClusterDb is closed');
    if (!this.opts.readOnly) {
      const w = this.writers.get(shardId);
      if (w) {
        w.busy++;
        try {
          return await fn(w.handle.db);
        } finally {
          w.busy--;
          w.lastUsedAt = Date.now();
        }
      }
    }
    const entry = await this.acquireReader(shardId, dir);
    entry.busy++;
    try {
      return await fn(entry.handle.db);
    } finally {
      entry.busy--;
      entry.lastUsedAt = Date.now();
      await this.evictReaders();
    }
  }

  async closeAll(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const writers = [...this.writers.values()];
    const readers = [...this.readers.values()];
    this.writers.clear();
    this.readers.clear();
    const results = await Promise.allSettled([...writers, ...readers].map((e) => e.handle.close()));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  // ---- writers ------------------------------------------------------------

  private async acquireWriter(shardId: number, dir: string): Promise<WriterEntry> {
    const cached = this.writers.get(shardId);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        cached.lastUsedAt = Date.now();
        return cached;
      }
      // Hold window expired: yield. If ops are in flight, serve this one too
      // (it is short) and close at the next idle point.
      if (cached.busy > 0) {
        cached.retire = true;
        return cached;
      }
      if (this.writers.get(shardId) === cached) this.writers.delete(shardId);
      await cached.handle.close().catch(() => {});
    }
    const inflight = this.openingWriters.get(shardId);
    if (inflight) return inflight;
    const opening = this.openWriter(shardId, dir).finally(() => this.openingWriters.delete(shardId));
    this.openingWriters.set(shardId, opening);
    return opening;
  }

  private async openWriter(shardId: number, dir: string): Promise<WriterEntry> {
    const deadline = Date.now() + this.opts.lockAcquireTimeoutMs;
    let delay = 10;
    for (;;) {
      try {
        const handle = await ShardHandle.openWriter(shardId, dir, this.opts.writerOpts, this.opts.lockRenewMs);
        this.stats.writerOpens++;
        try {
          await this.opts.applyDefs(handle.db);
        } catch (e) {
          await handle.close().catch(() => {});
          throw e;
        }
        const entry: WriterEntry = {
          handle,
          lastUsedAt: Date.now(),
          busy: 0,
          retire: false,
          expiresAt: this.opts.lockHoldMs > 0 ? Date.now() + this.opts.lockHoldMs : Infinity,
        };
        if (this.opts.lockHoldMs > 0) {
          // Proactively yield the lock at the end of the hold window even if
          // this process goes idle, so a waiting process is never starved by
          // a holder that stopped writing but kept the process alive.
          const timer = setTimeout(() => {
            if (entry.busy > 0) {
              entry.retire = true;
              return;
            }
            if (this.writers.get(shardId) === entry) this.writers.delete(shardId);
            void entry.handle.close().catch(() => {});
          }, this.opts.lockHoldMs);
          timer.unref();
        }
        this.writers.set(shardId, entry);
        return entry;
      } catch (e) {
        // Apply-time failures (e.g. a unique index that does not backfill) are
        // permanent; only lock contention is retried, until the deadline.
        if (!(e instanceof LockError) || Date.now() + delay > deadline) throw e;
        this.stats.lockWaits++;
        await sleep(delay + Math.floor(Math.random() * delay));
        delay = Math.min(delay * 2, 250);
      }
    }
  }

  private async evictWriters(): Promise<void> {
    while (this.writers.size > this.opts.maxWriters) {
      let victim: WriterEntry | null = null;
      for (const entry of this.writers.values()) {
        if (entry.busy > 0) continue;
        if (!victim || entry.lastUsedAt < victim.lastUsedAt) victim = entry;
      }
      if (!victim) return; // everything busy: soft cap exceeded temporarily
      this.writers.delete(victim.handle.shardId);
      this.stats.evictions++;
      await victim.handle.close().catch(() => {});
    }
  }

  // ---- readers ------------------------------------------------------------

  private async acquireReader(shardId: number, dir: string): Promise<ReaderEntry> {
    const inflight = this.openingReaders.get(shardId);
    if (inflight) return inflight;
    const opening = this.refreshReader(shardId, dir).finally(() => this.openingReaders.delete(shardId));
    this.openingReaders.set(shardId, opening);
    return opening;
  }

  private async refreshReader(shardId: number, dir: string): Promise<ReaderEntry> {
    const cached = this.readers.get(shardId);
    const parts = await shardFingerprint(dir);
    const fp = parts.join('|');
    if (cached && cached.fingerprint === fp) {
      cached.lastUsedAt = Date.now();
      return cached;
    }
    if (cached) {
      // Something in the shard changed. When the change is confined to WAL
      // appends on the same inode, apply just those frames instead of paying
      // for a full replay (fallback: a clean full reopen below).
      if (parts[1] === cached.fpParts[1] && parts[2] === cached.fpParts[2] && parts[3] === cached.fpParts[3]) {
        if (await this.tryCatchUpReader(cached, dir, parts)) return cached;
      }
      // A change the watermark cannot advance over (rotation, truncation,
      // snapshot/index-def rewrite, broken boundary): reopen to see it. Wait
      // for any in-flight user of the stale instance to drain first.
      while (cached.busy > 0) await sleep(5);
      this.readers.delete(shardId);
      this.stats.readerReopens++;
      await cached.handle.close().catch(() => {});
    }
    // Retry a few times: a compaction by another process briefly swaps files,
    // which can make an otherwise-fine open race with the rotation.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await ShardHandle.openReader(shardId, dir, this.opts.readerOpts);
        this.stats.readerOpens++;
        const openedParts = await shardFingerprint(dir);
        const entry: ReaderEntry = {
          handle,
          fingerprint: openedParts.join('|'),
          fpParts: openedParts,
          walMark: readerWalMark(handle),
          lastUsedAt: Date.now(),
          busy: 0,
        };
        this.readers.set(shardId, entry);
        return entry;
      } catch (e) {
        lastErr = e;
        await sleep(25);
      }
    }
    throw lastErr;
  }

  /** Incremental reader refresh: apply the WAL frames appended after the
   *  cached reader's watermark. Only safe when the fingerprint change is
   *  WAL-only (caller checked), the WAL is still the inode the watermark is
   *  anchored to, and it never shrank below the applied offset. Returns false
   *  on every divergence, leaving the cached reader untouched for the caller
   *  to fully reopen. */
  private async tryCatchUpReader(cached: ReaderEntry, dir: string, parts: string[]): Promise<boolean> {
    const mark = cached.walMark;
    if (!mark) return false;
    const st = await fs.stat(path.join(dir, 'db.wal')).catch(() => null);
    if (!st || st.dev !== mark.dev || st.ino !== mark.ino || st.size < mark.size) return false;
    // Serialize against in-flight users of the cached instance (the reopen
    // path does the same drain) and hold it busy so eviction skips it.
    while (cached.busy > 0) await sleep(5);
    cached.busy++;
    let res: { offset: number; appliedFrames: number } | null = null;
    try {
      res = await cached.handle.db.catchUpFromWal(mark.size);
    } catch {
      res = null; // raced a rotation/truncation: caller falls back to a full reopen
    } finally {
      cached.busy--;
    }
    if (res === null) return false;
    // Advance the watermark only to what was actually applied — a frame
    // appended after this stat (or after catch-up scanned) sits beyond
    // res.offset and is picked up by the next fingerprint miss.
    cached.walMark = { dev: st.dev, ino: st.ino, size: res.offset };
    cached.fpParts = parts;
    cached.fingerprint = parts.join('|');
    cached.lastUsedAt = Date.now();
    this.stats.incrementalCatchups++;
    this.stats.catchupFramesApplied += res.appliedFrames;
    return true;
  }

  private async evictReaders(): Promise<void> {
    while (this.readers.size > this.opts.maxReaders) {
      let victim: ReaderEntry | null = null;
      for (const entry of this.readers.values()) {
        if (entry.busy > 0) continue;
        if (!victim || entry.lastUsedAt < victim.lastUsedAt) victim = entry;
      }
      if (!victim) return;
      this.readers.delete(victim.handle.shardId);
      this.stats.evictions++;
      await victim.handle.close().catch(() => {});
    }
  }
}
