// src/cluster/types.ts
//
// Public option and result types for ClusterDb, the sharded multi-process
// layer on top of MiniDb. See plan/minidb-cluster-plan.md for the design.

import type { ValueCodecName } from '../index.js';
import type { IndexDef } from '../index-manager.js';
import type { FsyncPolicy } from '../wal.js';

/** Cross-shard write semantics.
 *  - 'best-effort': shard groups are written one by one in shard-id order;
 *    a failure may leave earlier shards written and later ones untouched.
 *  - 'none': an operation spanning more than one shard throws.
 *  - '2pc': reserved for a future two-phase-commit implementation; rejected
 *    at open time for now. */
export type CrossShardMode = 'best-effort' | '2pc' | 'none';

export interface ClusterOpenOptions {
  dir: string;
  /** Shard count; only used when creating a new cluster (default 16). An
   *  existing cluster's count is read from cluster.meta.json and an explicit
   *  mismatching value is rejected. */
  shardCount?: number;
  valueCodec?: ValueCodecName;
  fsyncPolicy?: FsyncPolicy;
  valueMode?: 'memory' | 'disk' | 'auto';
  compactThresholdBytes?: number;
  autoCompact?: boolean;
  activeExpireIntervalMs?: number;
  recovery?: 'resync' | 'strict';
  maxMemoryBytes?: number;
  maxMemoryPolicy?: 'reject' | 'evict-lru';

  /** Open the whole cluster without ever acquiring a write lock. Writes
   *  throw; reads always go through revalidated read-only shard instances. */
  readOnly?: boolean;

  /** How long a lock timestamp may go unrefreshed before the lock would be
   *  considered abandoned (default 30000). Reserved: the underlying LockFile
   *  currently takes a lock over only when the recorded owner PID is dead,
   *  never merely because it is old; lockRenewMs keeps the timestamp fresh
   *  for observability and for a future lease-based check. */
  lockLeaseMs?: number;
  /** How often a cached shard writer refreshes its lock timestamp
   *  (default 10000). Set to 0 to disable renewal. */
  lockRenewMs?: number;
  /** Maximum number of shard write locks cached in this process; least
   *  recently used, non-busy shards are evicted beyond the cap (default 16). */
  lockPoolMaxShards?: number;
  /** How long a shard writer may stay cached before this process yields the
   *  lock so other processes get a chance to write that shard (default 250ms;
   *  0 holds the lock until pool eviction or close). Yielding costs a shard
   *  reopen (WAL replay) but prevents a continuously-writing process from
   *  starving everyone else on a hot shard. */
  lockHoldMs?: number;
  /** Maximum number of read-only shard instances cached in this process
   *  (default: shardCount). */
  readersMaxShards?: number;
  /** Maximum time to wait for a contended shard write lock before throwing
   *  LockError (default 30000). */
  lockAcquireTimeoutMs?: number;
  /** Cross-shard write semantics (default 'best-effort'). */
  crossShard?: CrossShardMode;
}

export interface ClusterMeta {
  version: number;
  shardCount: number;
  createdAt: string;
  valueCodec: ValueCodecName;
  fsyncPolicy: FsyncPolicy;
}

export interface ScanOptions {
  gte?: string;
  gt?: string;
  lte?: string;
  lt?: string;
  /** When set, range bounds are ignored and a pure prefix scan runs. */
  prefix?: string;
  limit?: number;
  /** Return entries in descending key order (after global merge). */
  reverse?: boolean;
}

/** Registry of cluster-wide index definitions (cluster.indexes.json). The
 *  registry is the source of truth; every shard writer applies missing
 *  definitions right after it is opened, so a shard that was never opened
 *  when an index was created catches up later. */
export interface ClusterIndexRegistry {
  indexes: { name: string; def: IndexDef }[];
  textIndexes: { name: string; fields: readonly string[] | null }[];
}

export interface CompactResult {
  /** Shard ids that were compacted. */
  compacted: number[];
  /** Shard ids whose write lock could not be acquired (held elsewhere). */
  skipped: number[];
}

export interface ClusterStats {
  shardCount: number;
  writersCached: number;
  readersCached: number;
  /** Total shard writer opens performed by this process. */
  writerOpens: number;
  /** Total shard reader opens performed by this process. */
  readerOpens: number;
  /** Reader cache reopens triggered by on-disk changes from other processes
   *  (the full-replay path; contrast incrementalCatchups). */
  readerReopens: number;
  /** Reader refreshes satisfied by applying only the appended WAL frames
   *  instead of a full reopen. */
  incrementalCatchups: number;
  /** Total WAL frames applied by incremental reader catch-ups. */
  catchupFramesApplied: number;
  /** Times a write-lock acquisition had to wait/retry on a live holder. */
  lockWaits: number;
  /** LRU evictions of cached writers/readers. */
  evictions: number;
}
