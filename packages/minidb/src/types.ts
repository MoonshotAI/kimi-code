// src/types.ts
//
// Public types of the MiniDb API: the value codec contract, open/restore/set
// options, batch/query shapes — plus the internal PreparedOp (the write
// path's prepared-mutation shape, shared with the memory guard; NOT
// re-exported from index.ts).

import type { FsyncPolicy } from './wal.js';
import type { RecoveryMode, ValueMode } from './recovery.js';
import type { RangeOptions } from './skiplist.js';
import type { TextIndex } from './text-index/index.js';

export type ValueCodecName = 'buffer' | 'string' | 'json';

export interface ValueCodec<V> {
  encode(v: V): Buffer;
  decode(b: Buffer): V;
}

export type ValueModeSetting = ValueMode | 'auto';

export interface OpenOptions {
  dir: string;
  valueCodec?: ValueCodecName;
  fsyncPolicy?: FsyncPolicy;
  /** Background-sync interval for fsyncPolicy 'everysec' (default 1000 ms). */
  syncIntervalMs?: number;
  compactThresholdBytes?: number;
  autoCompact?: boolean;
  activeExpireIntervalMs?: number;
  recovery?: RecoveryMode;
  readOnly?: boolean;
  onLockFail?: 'readonly';
  /**
   * Writer opens only: invoked synchronously right after the exclusive write
   * lock is acquired — BEFORE any recovery/replay work runs. Hosts that
   * supervise the open from another thread (e.g. kap-server's search worker,
   * whose threads share the main process pid so pid-liveness alone can never
   * reclaim the lock) use it to learn the lock token immediately and reap
   * the lock after a mid-open crash.
   */
  onLockAcquired?: (info: { readonly token: string }) => void;
  /** Where to keep value bulk. 'memory' keeps values in RAM; 'disk' keeps only
   *  value pointers in RAM and reads values from the snapshot/WAL on demand. */
  valueMode?: ValueModeSetting;
  /** Approximate memory budget for stored keys/values. Undefined disables it. */
  maxMemoryBytes?: number;
  /** What to do when a write would exceed maxMemoryBytes. */
  maxMemoryPolicy?: 'reject' | 'evict-lru';
  /** Persistent index generations (stage 5), default true. With generations
   *  enabled, a writer publishes derived-state checkpoints under
   *  `generations/` and open loads them instead of rebuilding every index
   *  from a full store scan; the legacy full recovery remains the automatic
   *  fallback. Set false to force the pre-generation behavior everywhere
   *  (full open-time rebuild, root postings rebuilds after compaction). */
  indexGenerations?: boolean;
  /** Stage 6: build full-text generation artifacts (tokenization,
   *  aggregation, postings merge) in a worker thread instead of on the main
   *  event loop. Default true; set false to force the in-thread staged
   *  build everywhere (rollback switch). Deployments without the worker
   *  entry file (bundled single-file) automatically host the SAME bounded
   *  core inline on the main thread instead of the staged aggregation. */
  textBuildWorker?: boolean;
  /** Memory budget (bytes) for the worker build's per-index postings
   *  aggregation — exceeding it flushes sorted segments and the final build
   *  is an external merge, so rebuild peak RAM stays bounded instead of
   *  growing with the total (doc, term) pair count. Default 128 MiB. */
  textBuildMemoryBytes?: number;
  /** Defer the open-time full text-index rebuild (the no-generation fallback
   *  recovery path) to a background maintenance task running the bounded
   *  worker/inline engine, pinned at the recovery checkpoint. Default true:
   *  open() returns with those text indexes in a "building" state — searches
   *  raise TextIndexBuildingError until the build commits — instead of
   *  blocking the caller's event loop on a corpus-scale rebuild; a read-only
   *  opener builds its base into a private scratch dir OUTSIDE the db dir and
   *  adopts it there. Set false to restore the pre-deferral behavior (the
   *  staged rebuild is awaited inside open()). */
  deferOpenTextBuilds?: boolean;
  /** Max concurrent async value reads in maintenance I/O (compaction
   *  snapshot's disk-mode reads). Default 8. */
  maintenanceIoConcurrency?: number;
}

export interface RestoreOptions extends Omit<OpenOptions, 'dir'> {
  /** Overwrite an existing destination directory. */
  force?: boolean;
}

export interface SetOptions {
  ttl?: number;
  dt?: Record<string, number | string>;
}

export type BatchInputOp<V = unknown> =
  | { op: 'set'; key: string; value: V; ttl?: number; dt?: Record<string, number | string> }
  | { op: 'del'; key: string };

export interface DocRecord<V = unknown> {
  key: string;
  value: V;
  dt?: Record<string, number>;
}

export interface ScanEntry<V = unknown> extends DocRecord<V> {}

export interface QueryOptions {
  key?: string | (RangeOptions<string> & { prefix?: string });
  dt?: Record<string, RangeOptions<number>>;
  text?: { index: string; q: string; op?: 'AND' | 'OR'; limit?: number };
  filter?: Record<string, unknown>;
  project?: readonly string[];
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
}

export interface PreparedOp<V> {
  type: number;
  key: Buffer;
  value: Buffer | null;
  meta: Buffer | null;
  expireAt: number;
  dtNorm: Record<string, number> | null;
  pk: string;
  /** The ONE value representation every downstream consumer (unique checks,
   *  secondary / compound / text indexes) sees. For the json codec this is the
   *  decoded form of `value` — exactly what the WAL stores and what a reopen
   *  rebuilds — so getter/toJSON/Proxy are consumed exactly once, at encode
   *  time, and the index view can never diverge from the storage view
   *  (review #5, stage 11). For the buffer/string codecs (no canonical
   *  concept, no value-derived indexes) it is the value as passed. */
  canonical: V | undefined;
  /** Per-text-index precomputed tokens for `canonical` (null per index = not
   *  indexable → remove at apply). Tokenization and custom-tokenizer
   *  validation happen HERE, at the prepare boundary, so a throwing tokenizer
   *  rejects the write before any side effect and applyOp stays infallible
   *  (reviews #24/#27). Null when there were no text indexes at prepare time.
   *  Keyed by the TextIndex INSTANCE, not its name: a same-name drop+create
   *  between prepare and apply must not feed tokens produced by the old
   *  index's tokenizer into the new one. */
  textTokens: Map<TextIndex, readonly string[] | null> | null;
}
