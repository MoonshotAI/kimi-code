// src/index.ts
//
// MiniDb: the public embedded API. Ties together the in-memory Store (with its
// ordered key index), the WAL, recovery, compaction, dt-column indexes, value
// secondary indexes, and full-text indexes.
//
// Document model:
//   { key: string(<=128), value: <any JSON>, dt1..dtN: <epoch-ms datetime columns> }

import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from './store.js';
import type { StoreRecord, ValueLoc } from './store.js';
import { WAL } from './wal.js';
import type { WalPoison } from './wal.js';
import { ValueReader } from './value-reader.js';
import { recover, catchUpWal, frameToOps } from './recovery.js';
import { compact, shouldCompact } from './compaction.js';
import { IndexManager, UniqueViolationError } from './index-manager.js';
import { DtIndex } from './dt-index.js';
import { TextIndex, type TextIndexOptions, type TextIndexBuild } from './text-index.js';
import { createNgramTokenizer } from './trigram.js';
import { CompoundIndexManager } from './compound-index.js';
import { getPath, match, project } from './query.js';
import { LockFile, LockError } from './lockfile.js';
import { encodeFrame, encodeBatchOps, scanBatchOpRefs, HEADER_SIZE, TYPE_SET, TYPE_DEL, TYPE_BATCH } from './codec.js';
import type { BatchOp as EncodedBatchOp, FrameRef } from './codec.js';
import type { FsyncPolicy } from './wal.js';
import type { RecoveryMode, RecoveryInfo, ValueMode, RecoveredOp } from './recovery.js';
import type { IndexDef, IndexInfo } from './index-manager.js';
import type { CompoundIndexDef, CompoundIndexInfo } from './compound-index.js';
import type { DtRangeEntry } from './dt-index.js';
import type { RangeOptions } from './skiplist.js';
import type { TextIndexTokenizerName } from './trigram.js';

export { UniqueViolationError } from './index-manager.js';
export { LockError } from './lockfile.js';
export { normalizeLiteral, createNgramTokenizer } from './trigram.js';
export { tokenize } from './text-index.js';
export type { RecoveryInfo } from './recovery.js';
export type { IndexDef, IndexInfo, IndexType } from './index-manager.js';
export type { CompoundIndexDef, CompoundIndexInfo } from './compound-index.js';
export type { TextIndexTokenizerName } from './trigram.js';
// ClusterDb (the multi-process sharding layer) lives at the './cluster'
// subpath export to keep this module free of import cycles.

export type ValueCodecName = 'buffer' | 'string' | 'json';

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
/** The open-time index rebuild yields to the event loop every this many
 *  records, so a huge Store walk never hard-blocks the host (mirrors the
 *  BUILD_YIELD_DOCS watermark in text-index.ts). */
const REBUILD_YIELD_DOCS = 2048;

export interface ValueCodec<V> {
  encode(v: V): Buffer;
  decode(b: Buffer): V;
}

const BUFFER: ValueCodec<Buffer> = {
  encode: (v) => {
    if (!Buffer.isBuffer(v)) throw new TypeError('value must be a Buffer (use valueCodec: "string" or "json")');
    return v;
  },
  // Return a copy so a caller mutating the result cannot corrupt the stored
  // value (the store keeps the same Buffer reference internally).
  decode: (b) => Buffer.from(b),
};
const STRING: ValueCodec<string> = {
  encode: (v) => Buffer.from(String(v), 'utf8'),
  decode: (b) => b.toString('utf8'),
};
const JSON_CODEC: ValueCodec<unknown> = {
  encode: (v) => Buffer.from(JSON.stringify(v), 'utf8'),
  decode: (b) => JSON.parse(b.toString('utf8')),
};
const CODECS: Record<ValueCodecName, ValueCodec<unknown>> = { buffer: BUFFER, string: STRING, json: JSON_CODEC };
const MAX_KEY_LEN = 128;

function toBuf(key: string | Buffer): Buffer {
  return Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
}
// Canonical byte-string form of a key: each char's code unit equals one byte of
// the key's UTF-8 encoding. The store and every derived index key their maps by
// this string, so a string key and the Buffer of its UTF-8 bytes (which is what
// the WAL/snapshot store) map to the same entry. Without this, a multi-byte
// (non-ASCII) string key is stored under one name (UTF-8 bytes, via the Buffer
// path) but looked up under another (the raw UTF-16 string), so get/del/scan and
// every index miss it.
function toKStr(key: string | Buffer): string {
  return typeof key === 'string' ? Buffer.from(key, 'utf8').toString('binary') : key.toString('binary');
}
// Inverse of toKStr: turn a canonical byte-string back into the original UTF-8
// string for keys returned to callers (scan / findEq / dtRange / ...).
function fromKStr(k: string): string {
  return Buffer.from(k, 'binary').toString('utf8');
}
// Canonicalize the string bounds of a range scan so they compare correctly
// against the canonically-keyed ordered index.
function canonRange(opts: RangeOptions<string>): RangeOptions<string> {
  const out: RangeOptions<string> = { ...opts };
  if (out.gte !== undefined) out.gte = toKStr(out.gte);
  if (out.gt !== undefined) out.gt = toKStr(out.gt);
  if (out.lte !== undefined) out.lte = toKStr(out.lte);
  if (out.lt !== undefined) out.lt = toKStr(out.lt);
  return out;
}

/** Lazy one-shot candidate filter — keeps query pipelines streaming so a
 *  bounded query stops after `skip + limit` matches instead of materializing
 *  every candidate. */
function* filterKeys(keys: Iterable<string>, pred: (k: string) => boolean): Generator<string> {
  for (const k of keys) if (pred(k)) yield k;
}
function normDt(dt?: Record<string, number | string> | null): Record<string, number> | null {
  if (!dt) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(dt)) {
    const ms = typeof v === 'number' ? v : Date.parse(v);
    if (Number.isFinite(ms)) out[k] = ms;
  }
  return Object.keys(out).length ? out : null;
}

export type ValueModeSetting = ValueMode | 'auto';

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
}

/** Write a small metadata file atomically (tmp + rename), so a crash cannot
 *  leave a torn definition file that would force openers into error/rebuild. */
async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

async function resolveValueMode(mode: ValueModeSetting, dir: string, maxMemoryBytes: number | null): Promise<ValueMode> {
  if (mode !== 'auto') return mode;
  if (maxMemoryBytes === null) return 'memory';
  const total = (await fileSize(path.join(dir, 'db.snapshot'))) + (await fileSize(path.join(dir, 'db.wal')));
  return total > maxMemoryBytes ? 'disk' : 'memory';
}

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
  /** Where to keep value bulk. 'memory' keeps values in RAM; 'disk' keeps only
   *  value pointers in RAM and reads values from the snapshot/WAL on demand. */
  valueMode?: ValueModeSetting;
  /** Approximate memory budget for stored keys/values. Undefined disables it. */
  maxMemoryBytes?: number;
  /** What to do when a write would exceed maxMemoryBytes. */
  maxMemoryPolicy?: 'reject' | 'evict-lru';
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

interface PreparedOp<V> {
  type: number;
  key: Buffer;
  value: Buffer | null;
  meta: Buffer | null;
  expireAt: number;
  dtNorm: Record<string, number> | null;
  pk: string;
  valueDecoded: V | undefined;
}

/** Per-flush-group rollback state: the pre-group logical record of every key
 *  the group's ops touched, plus the count of the group's ops still awaiting
 *  their frame's `done`. Created when the first op of a group applies. */
interface WalGroup {
  /** pk → pre-group record. The earliest capture per key wins: several ops of
   *  one group on the same key roll back to the state before the FIRST of
   *  them, so the result matches what a reopen replays (the whole group's
   *  frames are truncated away together). */
  pre: Map<string, StoreRecord | undefined>;
  pending: number;
  /** Set once the group failed and was rolled back; later rejects are no-ops. */
  rolledBack: boolean;
}

/** Persisted shape of one entry in `db.textindexes.json`. `tokenizer` is
 *  absent in definitions written before n-gram support existed, which means
 *  'default'; it is also omitted for new default indexes so their definitions
 *  keep the legacy shape byte-for-byte. */
interface TextIndexDef {
  name: string;
  fields: readonly string[] | null;
  tokenizer?: TextIndexTokenizerName;
}

/** Map a persisted tokenizer name to the TextIndex tokenizer pair. 'default'
 *  (or a legacy definition without the field) returns empty options, keeping
 *  the built-in tokenizer path untouched. The query side only diverges for
 *  'ngram' (a length >= 3 query emits only its 3-grams); both sides share the
 *  same normalization, so candidates stay a superset of the true matches. */
function textIndexTokenizers(
  name: TextIndexTokenizerName | undefined,
): Pick<TextIndexOptions, 'tokenizer' | 'queryTokenizer'> {
  if (name === undefined || name === 'default') return {};
  if (name === 'ngram') {
    return {
      tokenizer: createNgramTokenizer(),
      queryTokenizer: createNgramTokenizer({ forQuery: true }),
    };
  }
  throw new RangeError(`unknown text index tokenizer: ${String(name)}`);
}

export class MiniDb<V = unknown> {
  dir!: string;
  walPath!: string;
  private indexPath!: string;
  private textIndexPath!: string;
  private compoundIndexPath!: string;
  store!: Store;
  wal!: WAL;
  valueReader?: ValueReader;
  valueMode: ValueMode = 'memory';
  readonly indexes = new IndexManager();
  readonly dt = new DtIndex();
  readonly compound = new CompoundIndexManager();
  private readonly text = new Map<string, TextIndex>();
  private textDefs: TextIndexDef[] = [];

  private codec!: ValueCodec<V>;
  private codecName: ValueCodecName = 'buffer';
  fsyncPolicy: FsyncPolicy = 'everysec';
  syncIntervalMs = 1000;
  private closed = false;
  recoveryInfo: RecoveryInfo | null = null;
  /** Continuation watermark for catchUpFromWal: the WAL inode + applied
   *  offset as advanced by the last successful catch-up (recoveryInfo's scan
   *  endpoint anchors the first call). */
  private walTail: { dev: number; ino: number; size: number } | null = null;
  readOnly = false;
  private lock: LockFile | null = null;

  compactThresholdBytes = 64 * 1024 * 1024;
  autoCompact = true;
  compacting = false;
  _compactDone: Promise<void> | null = null;
  /** Set only during compaction's short rotation critical section; writers park
   *  on it (see the write-op gate). Null the rest of the time, so the snapshot
   *  phase of compaction is fully non-blocking. */
  _rotateLock: Promise<void> | null = null;
  lastCompactError: unknown = null;
  maxMemoryBytes: number | null = null;
  maxMemoryPolicy: 'reject' | 'evict-lru' = 'reject';
  private access = new Set<string>(); // pk, insertion-ordered by last touch (Map/Set iteration order): front = LRU
  private uniqueWriteLock: Promise<void> = Promise.resolve();
  /** Serializes in-place WAL recoveries (poison → truncate → resume), the same
   *  promise-chain style as uniqueWriteLock. Never rejects (a failed recovery
   *  lands in writeDisabled instead). */
  private walRecoveryChain: Promise<void> = Promise.resolve();
  /** False while a kicked recovery may still be running. Write-op commit
   *  bodies check it BEFORE awaiting walRecoveryChain: with no recovery in
   *  flight the commit path takes zero extra awaits (hot path), while a write
   *  issued after a failure queues behind the recovery instead of hitting the
   *  still-poisoned WAL. */
  private walRecoveryIdle = true;
  /** The poison object the current recovery chain covers (dedupe key for
   *  kickWalRecovery; each poison event is a fresh object identity). */
  private walRecoveryCovers: WalPoison | null = null;
  /** Set when in-place WAL recovery's truncate fails (persistent I/O error):
   *  from then on every write op throws a WAL_WRITE_DISABLED error
   *  immediately; reads and close() keep working. The value is the truncate
   *  error (the cause). DESIGNED CONSEQUENCE: the WAL stays poisoned, so
   *  close() skips its final flush and the un-acked tail is LEFT in db.wal —
   *  a later reopen replays it and the rejected writes resurface. That is
   *  exactly why every commit-point failure is marked `ambiguous: true`: in
   *  this state the caller cannot assume a rejected write had no effect. */
  writeDisabled: unknown = null;
  /** Scratch out-param for applyOp's pre-state capture. Live only within the
   *  synchronous apply section of a commit body (shared safely because
   *  nothing awaits while it is read); callers lift the reference into a
   *  local before any await. Avoids one small allocation per write op. */
  private readonly applyBox: { prev: StoreRecord | undefined } = { prev: undefined };
  /** Pre-group rollback state of every in-flight flush group, keyed per WAL:
   *  a compaction rotation replaces the WAL and each side's batchIds are
   *  independent. Entries are dropped when their group fully settles. */
  private pendingGroups = new Map<WAL, Map<number, WalGroup>>();
  /** The group groupFor returned most recently (see groupFor); invalidated
   *  when that group settles or rolls back. batchIds are monotonic per WAL,
   *  so a stale (wal, batchId) pair can never collide with a later group. */
  private lastGroup: { wal: WAL; batchId: number; group: WalGroup } | null = null;
  readonly stats = {
    compactions: 0,
    compactErrors: 0,
    walBytesWritten: 0,
    walFsyncs: 0,
    /** Failed writev-class attempts on the WAL write path. Each one poisons
     *  the WAL and triggers an in-place recovery (truncate + resume). */
    walWriteErrors: 0,
    /** Failed fsync attempts; a background everysec failure never rejects a
     *  write — it surfaces only here and in lastWalFsyncError. A write-path
     *  ('always') fsync failure rejects its batch and poisons the WAL. */
    walFsyncErrors: 0,
    /** Sticky copy of the most recent fsync failure (never cleared). */
    lastWalFsyncError: null as unknown,
    /** Bytes currently queued in the live WAL's in-memory append buffer. */
    walQueuedBytes: 0,
    /** High-water mark of walQueuedBytes. */
    walMaxQueuedBytes: 0,
    /** WAL group commits (one per flushed batch) and the frames they carried. */
    walGroupCommits: 0,
    walGroupCommitFrames: 0,
    snapshotBytesWritten: 0,
    evictions: 0,
    maxMemoryRejections: 0,
    queryIndexHits: 0,
    // ---- lifecycle phase metrics (cumulative wall-clock ms / counts) ----
    /** Bytes and frames recovery scanned at open (snapshot + WAL). */
    recoveryBytes: 0,
    recoveryFrames: 0,
    recoveryDurationMs: 0,
    /** Open-time derived-index rebuilds (secondary + dt + compound). */
    indexRebuildDurationMs: 0,
    /** Values decoded by the open-time shared rebuild walk (0 when no
     *  value-derived index exists: the walk is metadata-only then). */
    indexRebuildDecoded: 0,
    /** Text-index (re)builds: at open and after each compaction. */
    textRebuildDurationMs: 0,
    /** Whole successful compactions, hook included. */
    compactionDurationMs: 0,
    /** The non-blocking snapshot phase of compaction. */
    compactionSnapshotDurationMs: 0,
    /** The rotation critical section of compaction (writes park meanwhile). */
    compactionRotationDurationMs: 0,
    /** Text-postings rebuild after a compaction rotation. */
    compactionPostingsDurationMs: 0,
    /** Cumulative time write ops spent parked on a compaction rotation. */
    compactionRotationPauseMs: 0,
    /** Candidate keys iterated / values decoded / rows fed to a sort in query(). */
    queryCandidates: 0,
    queryDecoded: 0,
    querySortedRows: 0,
  };

  /** Hook called by compaction after the store snapshot + WAL are rotated, so
   *  derived on-disk state (text postings) can be rewritten against the new
   *  live set. Structural part of the CompactionTarget interface; the
   *  compaction awaits it, so it may be sync or async. */
  onCompacted: () => void | Promise<void> = async (): Promise<void> => {
    const t0 = performance.now();
    await this.rebuildTextPostings();
    const ms = performance.now() - t0;
    this.stats.compactionPostingsDurationMs += ms;
    this.stats.textRebuildDurationMs += ms;
  };

  static async open<V = unknown>(opts: OpenOptions): Promise<MiniDb<V>> {
    if (!opts || !opts.dir) throw new TypeError('MiniDb.open: opts.dir is required');
    const db = new MiniDb<V>();
    db.dir = opts.dir;
    db.walPath = path.join(db.dir, 'db.wal');
    db.indexPath = path.join(db.dir, 'db.indexes.json');
    db.textIndexPath = path.join(db.dir, 'db.textindexes.json');
    db.compoundIndexPath = path.join(db.dir, 'db.compound-indexes.json');
    db.fsyncPolicy = opts.fsyncPolicy ?? 'everysec';
    db.syncIntervalMs = opts.syncIntervalMs ?? 1000;
    db.codecName = opts.valueCodec ?? 'buffer';
    db.codec = CODECS[db.codecName] as ValueCodec<V>;
    const valueMode: ValueModeSetting = opts.valueMode ?? 'memory';
    if (valueMode !== 'memory' && valueMode !== 'disk' && valueMode !== 'auto') {
      throw new RangeError(`unknown valueMode: ${String(valueMode)}`);
    }
    db.compactThresholdBytes = opts.compactThresholdBytes ?? db.compactThresholdBytes;
    db.autoCompact = opts.autoCompact ?? true;
    db.maxMemoryBytes = opts.maxMemoryBytes ?? null;
    db.maxMemoryPolicy = opts.maxMemoryPolicy ?? 'reject';
    if (db.maxMemoryBytes !== null && (!Number.isFinite(db.maxMemoryBytes) || db.maxMemoryBytes <= 0)) {
      throw new RangeError('maxMemoryBytes must be a positive finite number');
    }

    await fs.mkdir(db.dir, { recursive: true });
    db.valueMode = await resolveValueMode(valueMode, db.dir, db.maxMemoryBytes);

    db.readOnly = !!opts.readOnly;
    if (!db.readOnly) {
      db.lock = new LockFile(path.join(db.dir, 'db.lock'));
      const got = await db.lock.acquire();
      if (!got) {
        if (opts.onLockFail === 'readonly') {
          db.readOnly = true;
          db.lock = null;
        } else {
          throw new LockError(`database is locked by another process: ${db.dir}`);
        }
      }
    }

    // Remove stale temp files left behind by an interrupted previous run (a
    // compaction's snapshot/WAL temps, sidecar-definition temps). Only the
    // sole writer may delete them — a read-only opener must never touch a live
    // writer's in-flight temps.
    if (!db.readOnly) {
      for (const tmp of [
        'db.snapshot.tmp',
        'db.wal.tmp',
        'db.indexes.json.tmp',
        'db.textindexes.json.tmp',
        'db.compound-indexes.json.tmp',
      ]) {
        await fs.rm(path.join(db.dir, tmp), { force: true });
      }
      // A failed postings rebuild orphans `db.text-*.postings.tmp` (its atomic
      // rename never ran). Postings are pure derived state — rebuilt from the
      // Store on open and after compaction — so such temps are always safe to
      // delete, for any index name.
      for (const f of await fs.readdir(db.dir)) {
        if (/^db\.text-.*\.postings\.tmp$/.test(f)) await fs.rm(path.join(db.dir, f), { force: true });
      }
    }

    db.store = new Store({
      activeExpireIntervalMs: opts.activeExpireIntervalMs ?? 100,
      onExpire: (k, rec) => db.onStoreExpire(k, rec),
      readValue: (loc) => {
        if (!db.valueReader) throw new Error('ValueReader is not open');
        return db.valueReader.read(loc);
      },
    });
    try {
      db.wal = new WAL(db.walPath, { fsyncPolicy: db.fsyncPolicy, syncIntervalMs: db.syncIntervalMs, stats: db.stats });
      // A read-only instance must not create or modify any file: the WAL is
      // constructed but never opened (opening with 'a' would create db.wal on
      // disk). Writes are already rejected by ensureWritable, and the unopened
      // WAL's size stays 0, so shouldCompact never fires for it.
      if (!db.readOnly) await db.wal.open();

      const recT0 = performance.now();
      db.recoveryInfo = await recover({
        dir: db.dir,
        store: db.store,
        mode: opts.recovery ?? 'resync',
        truncate: !db.readOnly,
        valueMode: db.valueMode,
      });
      db.stats.recoveryDurationMs += performance.now() - recT0;
      db.stats.recoveryBytes += db.recoveryInfo.snapshotBytes + db.recoveryInfo.walBytes;
      db.stats.recoveryFrames += db.recoveryInfo.snapshotFrames + db.recoveryInfo.walFrames;
      // Recovery may have truncated a torn WAL tail behind the WAL's back;
      // re-sync its size bookkeeping so later appends (and their disk-mode
      // value pointers) are computed against the real, truncated file size.
      if (db.recoveryInfo.truncatedWal) await db.wal.refreshSize();
      // Disk-backed values need the positioned reader; in valueMode 'memory'
      // no record ever carries a disk loc, so opening the files would only
      // hold handles for no benefit. (On Windows those idle handles would
      // additionally block compaction's rename-over-path rotation — rename
      // over an open destination is EPERM there.)
      if (db.valueMode === 'disk') {
        db.valueReader = new ValueReader(db.dir);
        db.valueReader.open();
      }
      db.seedAccessFromStore();

      await db.loadIndexDefinitions();
      await db.loadCompoundIndexDefinitions();
      await db.loadTextIndexDefinitions();
      await db.rebuildAllIndexes();

      // A read-only instance never compacts: rotation would rename the live
      // writer's snapshot/WAL out from under it and lose its acknowledged data.
      // The writer's open-time compaction is fire-and-forget (same as
      // maybeAutoCompact): recovery already applied the full WAL, so the db is
      // complete and consistent the moment open() returns. Awaiting the
      // compaction here blocked open() on the whole snapshot rewrite + text
      // postings rebuild — tens of seconds of stalled startup on a large db.
      if (!db.readOnly && db.autoCompact && shouldCompact(db)) compact(db).catch(() => {});
    } catch (err) {
      // A background open-time compaction may still be in flight: settle it
      // before tearing down the WAL/store/handles it touches.
      if (db.compacting && db._compactDone) await db._compactDone.catch(() => {});
      // Release every resource acquired so far: an open that fails after the
      // WAL/store are set up must not leak a file handle or keep the everysec /
      // active-expire timers running.
      if (db.wal) await db.wal.close().catch(() => {});
      db.valueReader?.close();
      db.store?.close();
      if (db.lock) {
        await db.lock.release().catch(() => {});
        db.lock = null;
      }
      throw err;
    }
    return db;
  }

  /**
   * Open a database, and if opening fails due to corruption (not due to a live
   * lock), delete the directory and open a fresh empty database. Recommended for
   * a rebuildable cache. A live lock is rethrown.
   */
  static async openOrRebuild<V = unknown>(
    opts: OpenOptions,
    hooks: { onRebuild?: (err: unknown) => void } = {},
  ): Promise<MiniDb<V>> {
    try {
      return await MiniDb.open<V>(opts);
    } catch (err) {
      if (err instanceof LockError || (err as { code?: string }).code === 'ELOCKED') throw err;
      // Only rebuild on errors that indicate unrecoverable/corrupt state (e.g.
      // malformed index-definition JSON). Transient I/O errors (EACCES, ENOSPC,
      // EIO, EMFILE, …) are rethrown so a cache opener never destroys data
      // because of a recoverable system error.
      const rebuildable = err instanceof SyntaxError || (err as { name?: string }).name === 'CorruptFrameError';
      if (!rebuildable) throw err;
      if (hooks.onRebuild) hooks.onRebuild(err);
      if (err instanceof SyntaxError) {
        // A corrupted index-definition sidecar holds only derived metadata and
        // must not cost the whole database: drop the sidecars (indexes can be
        // recreated by the caller) and retry once before falling back to a
        // full rebuild. If the SyntaxError came from the data files themselves
        // (e.g. a corrupt frame meta), the retry fails the same way and the
        // full rebuild below runs anyway.
        try {
          for (const f of ['db.indexes.json', 'db.textindexes.json', 'db.compound-indexes.json']) {
            await fs.rm(path.join(opts.dir, f), { force: true });
            await fs.rm(path.join(opts.dir, `${f}.tmp`), { force: true });
          }
          return await MiniDb.open<V>(opts);
        } catch {
          /* fall through to a full rebuild */
        }
      }
      await fs.rm(opts.dir, { recursive: true, force: true });
      return MiniDb.open<V>(opts);
    }
  }

  private encode(v: V): Buffer {
    return this.codec.encode(v);
  }
  private decode(b: Buffer | undefined): V | undefined {
    return b === undefined ? undefined : this.codec.decode(b);
  }
  private pk(key: string | Buffer): string {
    return toKStr(key);
  }
  private indexable(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object';
  }

  private *liveRecords(): Generator<{ key: Buffer; value: V | undefined; dt: Record<string, number> | null }> {
    for (const { key, value, dt } of this.store.entries()) {
      yield { key, value: this.decode(value), dt };
    }
  }

  /** Live indexable records with canonical keys, for (re)building text indexes. */
  private *textRecords(): Generator<{ key: string; value: unknown }> {
    for (const { key, value } of this.liveRecords()) {
      if (this.indexable(value)) yield { key: this.pk(key), value };
    }
  }

  /** On-disk postings file path for a text index (name sanitized for the fs). */
  private textPostingsPath(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(this.dir, `db.text-${safe}.postings`);
  }

  /** Rebuild every dirty text index's on-disk postings from the live Store.
   *  Drops the in-memory delta + tombstones and reclaims orphaned postings
   *  records. Invoked after compaction (postings are pure derived state, so
   *  this is only for space/latency, never for correctness). Indexes with an
   *  empty write buffer are skipped: the open-time build just produced a
   *  fresh base, so a compaction landing right after open must not redo the
   *  exact same (expensive) pass. */
  private async rebuildTextPostings(): Promise<void> {
    for (const ti of this.text.values()) {
      if (ti.needsRebuild()) await ti.build(this.textRecords());
    }
  }

  private async rebuildAllIndexes(): Promise<void> {
    // One Store walk feeds every staged builder. dt comes from record metadata
    // (never decoded); the value is decoded at most once per record and only
    // when a value-derived index (secondary / compound / text) actually exists
    // — an index-less open performs a metadata-only walk.
    const dtB = this.dt.beginRebuild();
    const secB = this.indexes.indexes.size ? this.indexes.beginRebuild() : null;
    const cmpB = this.compound.indexes.size ? this.compound.beginRebuild() : null;
    const textBs: { b: TextIndexBuild }[] = [];
    for (const [, ti] of this.text) textBs.push({ b: ti.beginBuild() });
    const needValues = secB !== null || cmpB !== null || textBs.length > 0;

    const t0 = performance.now();
    let docsSinceYield = 0;
    try {
      for (const rec of this.store.rawRecords()) {
        // Yield periodically so a huge open-time rebuild never hard-blocks the
        // event loop; safe because open() awaits this before publishing the
        // db or starting the background compaction.
        if (++docsSinceYield >= REBUILD_YIELD_DOCS) {
          docsSinceYield = 0;
          await yieldToLoop();
        }
        dtB.add(rec.kstr, rec.dt);
        if (!needValues) continue;
        const value = this.decode(rec.readValue());
        this.stats.indexRebuildDecoded++;
        secB?.add(rec.kstr, value);
        cmpB?.add(rec.kstr, value, rec.dt);
        if (this.indexable(value)) for (const { b } of textBs) b.add(rec.kstr, value);
      }
    } catch (e) {
      for (const { b } of textBs) b.abort();
      throw e;
    }
    this.stats.indexRebuildDurationMs += performance.now() - t0;

    // Commit the fallible builders first (text postings do file I/O); the
    // in-memory swaps cannot fail. A text commit failure leaves every
    // not-yet-committed builder on its previous state.
    const t1 = performance.now();
    try {
      for (const { b } of textBs) await b.commit();
    } catch (e) {
      for (const { b } of textBs) b.abort();
      throw e;
    }
    this.stats.textRebuildDurationMs += performance.now() - t1;
    secB?.commit();
    cmpB?.commit();
    dtB.commit();
  }

  private *_liveRecordsRaw(): Generator<{ key: Buffer; value: unknown }> {
    for (const { key, value } of this.store.entries()) {
      yield { key, value: this.decode(value) };
    }
  }

  private async loadIndexDefinitions(): Promise<void> {
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      for (const d of JSON.parse(raw) as (IndexInfo & IndexDef)[]) this.indexes.create(d.name, d);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  private async persistIndexDefinitions(): Promise<void> {
    await writeFileAtomic(this.indexPath, JSON.stringify(this.indexes.list()));
  }
  private async loadTextIndexDefinitions(): Promise<void> {
    try {
      const raw = await fs.readFile(this.textIndexPath, 'utf8');
      this.textDefs = JSON.parse(raw) as TextIndexDef[];
      for (const d of this.textDefs) {
        this.text.set(
          d.name,
          new TextIndex({
            fields: d.fields,
            ...textIndexTokenizers(d.tokenizer),
            // A read-only opener must not write to a live writer's postings file;
            // it keeps the base postings in memory instead.
            postingsPath: this.readOnly ? undefined : this.textPostingsPath(d.name),
          }),
        );
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  private async persistTextIndexDefinitions(): Promise<void> {
    await writeFileAtomic(this.textIndexPath, JSON.stringify(this.textDefs));
  }
  private async loadCompoundIndexDefinitions(): Promise<void> {
    try {
      const raw = await fs.readFile(this.compoundIndexPath, 'utf8');
      for (const d of JSON.parse(raw) as (CompoundIndexInfo & { name: string })[]) {
        this.compound.create(d.name, { groupBy: d.groupBy, orderBy: d.orderBy, orderType: d.orderType });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  private async persistCompoundIndexDefinitions(): Promise<void> {
    await writeFileAtomic(this.compoundIndexPath, JSON.stringify(this.compound.list()));
  }

  /** Drop every derived index entry for a key that just expired in the Store. */
  private onStoreExpire(k: string, _rec: StoreRecord): void {
    this.access.delete(k);
    this.dt.del(k);
    this.compound.remove(k);
    if (this.indexes.indexes.size) this.indexes.remove(k, undefined);
    for (const ti of this.text.values()) ti.remove(k);
  }

  private maybeAutoCompact(): void {
    if (this.autoCompact && !this.compacting && shouldCompact(this)) compact(this).catch(() => {});
  }

  /** Park a write op while a compaction rotation is in flight, accounting the
   *  wait so compactionRotationPauseMs reflects the writer-visible pause
   *  (as opposed to compactionRotationDurationMs, the rotation's wall time). */
  private async awaitRotation(): Promise<void> {
    const rl = this._rotateLock;
    if (!rl) return;
    const t0 = performance.now();
    await rl;
    this.stats.compactionRotationPauseMs += performance.now() - t0;
  }

  private hasUniqueIndexes(): boolean {
    for (const idx of this.indexes.indexes.values()) if (idx.unique) return true;
    return false;
  }

  private async withUniqueWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.uniqueWriteLock;
    let release!: () => void;
    this.uniqueWriteLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Run a write-op commit body, transparently retrying once when the commit
   * raced a compaction rotation: an op that passed the _rotateLock gate check
   * just before it was set can hit the freshly-sealed old WAL (code
   * 'WAL_SEALED') between the gate and its append, or — one step later in the
   * rotation — the already-closed but not-yet-replaced old WAL (the untyped
   * 'WAL is closed'; only retried while a rotation is actually in flight, so a
   * write after db.close() still fails). The op rolls its in-memory side
   * effects back on a failed append, so re-running the (idempotent) commit
   * body against the post-rotation WAL is safe.
   */
  private async retryOnWalSeal(commit: () => Promise<void>): Promise<void> {
    try {
      await commit();
    } catch (e) {
      const sealed = (e as { code?: string }).code === 'WAL_SEALED';
      const closedMidRotation =
        this._rotateLock !== null && e instanceof Error && e.message === 'WAL is closed';
      if (!sealed && !closedMidRotation) throw e;
      await this.awaitRotation();
      await commit();
    }
  }

  // ---- WAL poison: in-place recovery + flush-group rollback ----------------
  //
  // Commit point semantics: an op is committed when its frame's `done`
  // resolves. A WAL write/fsync failure poisons the WAL (see wal.ts) and
  // rejects every un-acked frame; each rejected op rolls its flush group back
  // to the pre-group records, then the instance recovers the WAL in place —
  // truncate db.wal to the failed batch's first predicted offset (removing
  // exactly the un-acked bytes), refreshSize, clearPoison — so the on-disk
  // tail a reopen would replay and the in-memory state agree again.

  /** Register one op of a flush group (one call per op awaiting a frame) and
   *  return the group; null when the frame never entered a group (batchId < 0:
   *  a sealed/closed/poisoned appendLoc — those use the per-op rollback).
   *  lastGroup caches the previous lookup: ops of one flush burst share the
   *  same (wal, batchId), so they hit two reference compares instead of two
   *  map lookups. */
  private groupFor(wal: WAL, batchId: number): WalGroup | null {
    if (batchId < 0) return null;
    const last = this.lastGroup;
    if (last && last.wal === wal && last.batchId === batchId) {
      last.group.pending++;
      return last.group;
    }
    let byId = this.pendingGroups.get(wal);
    if (!byId) {
      byId = new Map();
      this.pendingGroups.set(wal, byId);
    }
    let g = byId.get(batchId);
    if (!g) {
      g = { pre: new Map(), pending: 0, rolledBack: false };
      byId.set(batchId, g);
    }
    g.pending++;
    this.lastGroup = { wal, batchId, group: g };
    return g;
  }

  /** Record a key's pre-group record; the earliest capture per group wins. */
  private groupNoteKey(group: WalGroup | null, pk: string, prev: StoreRecord | undefined): void {
    if (group && !group.pre.has(pk)) group.pre.set(pk, prev);
  }

  /** The op's frame landed: drop the group's pre-state once every op settled. */
  private settleGroup(group: WalGroup | null, wal: WAL, batchId: number): void {
    if (!group) return;
    if (--group.pending === 0 && !group.rolledBack) {
      const byId = this.pendingGroups.get(wal);
      byId?.delete(batchId);
      if (byId && byId.size === 0) this.pendingGroups.delete(wal);
      if (this.lastGroup?.group === group) this.lastGroup = null;
    }
  }

  /** Roll a failed group back as a whole: every touched key returns to its
   *  pre-group record. Uses the unguarded restoreGroupKey — flush-group
   *  ordering itself guarantees no legally-committed later op exists (a
   *  poison rejects every queued frame, and the rollbacks unwind newest
   *  group first because the WAL rejects queued frames in reverse enqueue
   *  order), so the per-op seq guard would only misfire here: an earlier
   *  group's pre-state must win even after a later group's rollback re-seqd
   *  the record. Idempotent per group. */
  private rollbackGroup(group: WalGroup | null, wal: WAL, batchId: number): void {
    if (!group || group.rolledBack) return;
    group.rolledBack = true;
    for (const [pk, prev] of group.pre) this.restoreGroupKey(pk, prev);
    const byId = this.pendingGroups.get(wal);
    byId?.delete(batchId);
    if (byId && byId.size === 0) this.pendingGroups.delete(wal);
    if (this.lastGroup?.group === group) this.lastGroup = null;
  }

  /** Tag a failure past the commit point as ambiguous: the op's frame may
   *  have reached the OS — and its value was visible to in-process readers
   *  between applyOp and the group rollback — before the failure revoked it,
   *  so the caller must not assume the write had no effect. Errors thrown
   *  before the commit point (validation, unique violation, maxMemory,
   *  write-disabled) carry no flag: those definitely had no effect.
   *  WAL_SEALED is excluded too: retryOnWalSeal transparently retries it. */
  private markAmbiguous(err: unknown): unknown {
    if (err && typeof err === 'object' && (err as { code?: string }).code !== 'WAL_SEALED') {
      (err as { ambiguous?: boolean }).ambiguous = true;
    }
    return err;
  }

  /** Kick the in-place recovery for a poisoned WAL (single-flight; recoveries
   *  serialize on walRecoveryChain). Called from op catches after the group
   *  rollback — many ops can share one poison event, so a recovery already
   *  chained for THIS poison object is not chained again (a write storm's
   *  worth of catches costs one recovery, not one per op). No-op for
   *  anything that did not poison the WAL (e.g. a seal rejection during a
   *  compaction rotation). */
  private kickWalRecovery(wal: WAL): void {
    const poison = wal.poison;
    if (!poison || poison === this.walRecoveryCovers) return;
    this.walRecoveryCovers = poison;
    this.walRecoveryIdle = false;
    const run = this.walRecoveryChain.then(() => this.recoverWalInPlace(wal));
    const chain = run.catch(() => {});
    this.walRecoveryChain = chain;
    void chain.finally(() => {
      // Idle again only once the LATEST kicked recovery settled (an earlier
      // chain's settle must not mark idle while a later one still runs).
      if (this.walRecoveryChain === chain) {
        this.walRecoveryIdle = true;
        this.walRecoveryCovers = null;
      }
    });
  }

  /** Write-op gate at the start of every commit body: throws synchronously
   *  while writes are disabled; returns the recovery chain to await while a
   *  recovery is in flight, null otherwise — so the hot path pays zero extra
   *  microtasks (`const g = this.walRecoveryGate(); if (g) await g;`).
   *  Correctness never depends on the gate alone: an op that races a poison
   *  past the check is still rejected by the WAL itself and rolls its group
   *  back. */
  private walRecoveryGate(): Promise<void> | null {
    if (this.writeDisabled) throw this.writeDisabledError();
    return this.walRecoveryIdle ? null : this.walRecoveryChain;
  }

  private writeDisabledError(): Error {
    const cause = this.writeDisabled;
    return Object.assign(
      new Error(
        `MiniDb writes are disabled: in-place WAL recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
      { code: 'WAL_WRITE_DISABLED', cause },
    );
  }

  /** Recover a poisoned WAL back to a known-safe point: truncate db.wal to
   *  the failed batch's first predicted offset — exactly the un-acked bytes;
   *  every acknowledged write sits in earlier, successful batches — then
   *  re-sync the live WAL's size bookkeeping and clear the poison.
   *
   *  Mutual exclusion with a compaction rotation (which has its own recovery:
   *  swapping in a fresh WAL at the real EOF): the truncate targets the PATH,
   *  so it is correct whether or not the rotation's recovery swapped the WAL
   *  meanwhile, and the bookkeeping refresh hits the CURRENT WAL. Both sides
   *  only ever truncate to the same poison offset, so the composition never
   *  double-executes.
   *
   *  A truncate failure (the I/O error persists) parks the instance in
   *  writeDisabled: the poison is kept, so appends keep rejecting, reads keep
   *  working and close() skips its final flush. */
  private async recoverWalInPlace(wal: WAL): Promise<void> {
    let poison = wal.poison;
    if (!poison) return;
    // Settle any in-flight flush first: a poisonPending truncation point is
    // predicted against the in-flight batch fully landing, so truncating past
    // the real EOF would zero-extend the file (a corrupt gap on reopen). A
    // failed in-flight batch widens the point via poisonWith meanwhile.
    await wal.whenIdle();
    poison = wal.poison;
    if (!poison) return;
    try {
      // Stale-coordinate guard: if db.wal was REPLACED since the poison was
      // recorded (a compaction rotation committed a new, shorter file at the
      // path — the commit-body guards make this unreachable for poisons
      // recorded during/after the seal, so this is defense-in-depth), the
      // offset belongs to the old file's coordinate system and truncating to
      // it would zero-extend the new file. The new file never carried the
      // un-acked tail, so skipping the truncate is the correct recovery.
      const st = await fs.stat(this.walPath);
      if (poison.failedAtOffset <= st.size) await fs.truncate(this.walPath, poison.failedAtOffset);
    } catch (err) {
      this.writeDisabled = err;
      return;
    }
    await this.wal.refreshSize();
    wal.clearPoison();
  }

  private touchAccess(pk: string): void {
    // Re-insert so the iteration order of `access` is LRU..MRU: delete()+add()
    // moves the key to the most-recently-used end (a plain set() on an existing
    // key would keep its old position, which forced O(N) victim scans).
    this.access.delete(pk);
    this.access.add(pk);
  }

  private seedAccessFromStore(): void {
    this.access.clear();
    for (const [k] of this.store.map) this.access.add(k);
  }

  private projectedBytesForOps(ops: readonly PreparedOp<V>[]): number {
    const considered = new Map<string, number>();
    let projected = this.store.bytes;
    for (const op of ops) {
      const cur = considered.has(op.pk) ? considered.get(op.pk)! : this.store.recordBytes(op.pk);
      projected -= cur;
      const next =
        op.type === TYPE_SET
          ? this.store.estimateSetBytes(op.key, op.value!, op.dtNorm, { countValue: this.valueMode === 'memory' })
          : 0;
      projected += next;
      considered.set(op.pk, next);
    }
    return projected;
  }

  /** O(1) LRU victim: `access` is insertion-ordered by last touch, so the
   *  first entry that is a live, non-skipped key is the least-recently-used one. */
  private pickEvictionVictim(skip: Set<string>): string | undefined {
    for (const k of this.access) {
      if (skip.has(k) || !this.store.map.has(k)) continue;
      return k;
    }
    for (const [k] of this.store.map) if (!skip.has(k)) return k;
    return undefined;
  }

  private async evictKey(pk: string): Promise<void> {
    const bytes = this.store.recordBytes(pk);
    if (!bytes) return;
    const op = this.prepareDel(Buffer.from(pk, 'binary'));
    // Committed through retryOnWalSeal like any other write: an evict that
    // passed the writer gate just before a compaction rotation can land its
    // DEL on the freshly-sealed (or just-closed, soon-to-be-replaced) old WAL,
    // and the user write that triggered the eviction must never see that race.
    // A failed attempt restores the victim via restoreKey, so re-running the
    // idempotent DEL body against the post-rotation WAL is safe.
    const commit = async (): Promise<void> => {
      const recoveryGate = this.walRecoveryGate();
      if (recoveryGate) await recoveryGate;
      const wal = this.wal;
      const appended = wal.appendLoc(encodeFrame({ type: TYPE_DEL, key: op.key }));
      const group = this.groupFor(wal, appended.batchId);
      const applied = this.applyBox;
      let prev: StoreRecord | undefined;
      let seq: number | undefined;
      try {
        this.applyOp(op, applied);
        prev = applied.prev;
        seq = this.store.map.get(op.pk)?.seq;
      } catch (err) {
        // See set() for this defensive path (applyOp's must-not-throw contract).
        void appended.done.catch(() => {}); // this op throws here; swallow the frame's rejection
        if (group) {
          wal.poisonPending(err);
          this.groupNoteKey(group, op.pk, applied.prev);
          this.rollbackGroup(group, wal, appended.batchId);
          this.kickWalRecovery(wal);
        } else {
          this.restoreGroupKey(op.pk, applied.prev);
        }
        throw this.markAmbiguous(err);
      }
      this.groupNoteKey(group, op.pk, prev);
      try {
        await appended.done;
        this.stats.evictions++;
      } catch (e) {
        if (group) this.rollbackGroup(group, wal, appended.batchId);
        else this.restoreKey(op.pk, prev, seq);
        this.kickWalRecovery(wal);
        throw this.markAmbiguous(e);
      }
      this.settleGroup(group, wal, appended.batchId);
    };
    await this.retryOnWalSeal(commit);
  }

  private async ensureMemoryFor(ops: readonly PreparedOp<V>[]): Promise<void> {
    if (this.maxMemoryBytes === null) return;
    // Drain due TTL entries via the store's expiry heap (O(due)) instead of a
    // full-store sweep on every write.
    this.store.reapExpiredDue();
    let projected = this.projectedBytesForOps(ops);
    if (projected <= this.maxMemoryBytes) return;

    if (this.maxMemoryPolicy === 'evict-lru') {
      const skip = new Set(ops.map((o) => o.pk));
      while (projected > this.maxMemoryBytes) {
        const victim = this.pickEvictionVictim(skip);
        if (!victim) break;
        projected -= this.store.recordBytes(victim);
        await this.evictKey(victim);
      }
    }

    if (projected > this.maxMemoryBytes) {
      this.stats.maxMemoryRejections++;
      throw new Error(`maxMemory exceeded: projected ${projected} bytes > ${this.maxMemoryBytes} bytes`);
    }
  }

  private checkKey(key: string | Buffer): void {
    const len = typeof key === 'string' ? key.length : Buffer.from(key).length;
    if (len > MAX_KEY_LEN) throw new RangeError(`key too long (>${MAX_KEY_LEN})`);
    if ((typeof key === 'string' && key.length === 0) || (Buffer.isBuffer(key) && key.length === 0)) {
      throw new RangeError('key must be non-empty');
    }
  }

  // ---- KV API -------------------------------------------------------------

  get(key: string | Buffer): V | undefined {
    this.ensureOpen();
    const k = toKStr(key);
    const v = this.store.get(k);
    if (v !== undefined) this.touchAccess(k);
    return this.decode(v);
  }

  getRecord(key: string | Buffer): DocRecord<V> | undefined {
    this.ensureOpen();
    const k = toKStr(key);
    const value = this.store.get(k);
    if (value === undefined) return undefined;
    const r = this.store.map.get(k);
    this.touchAccess(k);
    return { key: fromKStr(this.pk(key)), value: this.decode(value)!, dt: r?.dt ?? undefined };
  }

  /** Swap a record this op just wrote over to its disk-backed WAL pointer.
   *  Must only run after the WAL frame's `done` resolved: appendLoc's offset
   *  is a prediction and the bytes are not in db.wal until the queued writev
   *  lands, so publishing the pointer earlier let synchronous disk readers
   *  (compaction's snapshot phase, get) read past the end of the file.
   *  Skipped when the WAL was rotated by a compaction meanwhile (the pointer
   *  would reference the old file's offsets) or when the record was
   *  overwritten/deleted since; the record then keeps its in-memory ref —
   *  correct, just held in RAM until the next snapshot. */
  private publishWalRef(
    pk: string,
    wal: WAL,
    seq: number | undefined,
    loc: ValueLoc,
    expireAt: number,
    dt: Record<string, number> | null,
  ): void {
    if (this.wal !== wal || seq === undefined) return;
    const cur = this.store.map.get(pk);
    if (!cur || cur.seq !== seq) return;
    this.store.setRef(pk, { kind: 'disk', loc }, expireAt, dt);
  }

  async set(key: string | Buffer, value: V, { ttl, dt }: SetOptions = {}): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    this.checkKey(key);
    await this.awaitRotation();
    const op = this.prepareSet(key, value, { ttl, dt });
    await this.ensureMemoryFor([op]);

    const commit = async (): Promise<void> => {
      // Queue behind any in-place WAL recovery: a write issued after a
      // failure waits for the truncate + poison-clear instead of hitting the
      // still-poisoned WAL. Null (and zero-cost) when no recovery is running.
      const recoveryGate = this.walRecoveryGate();
      if (recoveryGate) await recoveryGate;
      if (this.indexes.indexes.size && this.indexable(value)) this.indexes.checkUnique(op.pk, value);
      const frame = encodeFrame({ type: TYPE_SET, key: op.key, value: op.value, meta: op.meta, expireAt: op.expireAt });
      const wal = this.wal;
      const appended = wal.appendLoc(frame);
      // Apply in the SAME synchronous tick as the WAL append, so a concurrent
      // compaction always snapshots the post-write state. In valueMode 'disk'
      // the record first holds an in-memory ref: the frame's bytes are not in
      // db.wal yet (appendLoc's offset is only a prediction), so a disk
      // pointer published now could point past the end of the file. The
      // pointer is published once `done` resolves (see publishWalRef). If the
      // WAL write ultimately fails, the whole flush group rolls back to the
      // pre-group records so in-memory state never diverges from what is
      // durable (and from what a reopen replays after the in-place recovery
      // truncated the failed tail).
      const group = this.groupFor(wal, appended.batchId);
      const applied = this.applyBox;
      let prev: StoreRecord | undefined;
      let seq: number | undefined;
      try {
        this.applyOp(op, applied);
        // Lift the pre-state reference out of the shared scratch before any
        // await lets a later op overwrite it.
        prev = applied.prev;
        seq = this.store.map.get(op.pk)?.seq;
      } catch (err) {
        // applyOp violated its must-not-throw contract (see its doc — stage 11
        // makes it structural; this try is the defensive layer). An enqueued
        // frame (batchId >= 0) is un-acked and must never reach disk: poison
        // the WAL exactly like a write failure and roll the group back. A
        // never-enqueued frame (batchId < 0, e.g. a seal race) poisons
        // nothing — only the partial in-memory mutation needs undoing.
        void appended.done.catch(() => {}); // this op throws here; swallow the frame's rejection
        if (group) {
          wal.poisonPending(err);
          this.groupNoteKey(group, op.pk, applied.prev);
          this.rollbackGroup(group, wal, appended.batchId);
          this.kickWalRecovery(wal);
        } else {
          this.restoreGroupKey(op.pk, applied.prev);
        }
        throw this.markAmbiguous(err);
      }
      this.groupNoteKey(group, op.pk, prev);
      try {
        await appended.done;
      } catch (e) {
        if (group) this.rollbackGroup(group, wal, appended.batchId);
        else this.restoreKey(op.pk, prev, seq);
        this.kickWalRecovery(wal);
        throw this.markAmbiguous(e);
      }
      this.settleGroup(group, wal, appended.batchId);
      if (this.valueMode === 'disk') {
        this.publishWalRef(
          op.pk,
          wal,
          seq,
          { file: 'wal', off: appended.offset + HEADER_SIZE + op.key.length, len: op.value!.length },
          op.expireAt,
          op.dtNorm,
        );
      }
      this.maybeAutoCompact();
    };

    if (this.hasUniqueIndexes()) await this.withUniqueWriteLock(() => this.retryOnWalSeal(commit));
    else await this.retryOnWalSeal(commit);
  }

  async del(key: string | Buffer): Promise<boolean> {
    this.ensureOpen();
    this.ensureWritable();
    await this.awaitRotation();
    const existed = this.store.has(toKStr(key));
    if (!existed) return false;
    const op = this.prepareDel(key);
    await this.ensureMemoryFor([op]);
    const commit = async (): Promise<void> => {
      const recoveryGate = this.walRecoveryGate();
      if (recoveryGate) await recoveryGate;
      const wal = this.wal;
      const appended = wal.appendLoc(encodeFrame({ type: TYPE_DEL, key: op.key }));
      const group = this.groupFor(wal, appended.batchId);
      const applied = this.applyBox;
      let prev: StoreRecord | undefined;
      let seq: number | undefined;
      try {
        this.applyOp(op, applied);
        prev = applied.prev;
        seq = this.store.map.get(op.pk)?.seq;
      } catch (err) {
        // See set() for this defensive path (applyOp's must-not-throw contract).
        void appended.done.catch(() => {}); // this op throws here; swallow the frame's rejection
        if (group) {
          wal.poisonPending(err);
          this.groupNoteKey(group, op.pk, applied.prev);
          this.rollbackGroup(group, wal, appended.batchId);
          this.kickWalRecovery(wal);
        } else {
          this.restoreGroupKey(op.pk, applied.prev);
        }
        throw this.markAmbiguous(err);
      }
      this.groupNoteKey(group, op.pk, prev);
      try {
        await appended.done;
      } catch (e) {
        if (group) this.rollbackGroup(group, wal, appended.batchId);
        else this.restoreKey(op.pk, prev, seq);
        this.kickWalRecovery(wal);
        throw this.markAmbiguous(e);
      }
      this.settleGroup(group, wal, appended.batchId);
      this.maybeAutoCompact();
    };
    await this.retryOnWalSeal(commit);
    return true;
  }

  /** Atomically apply a batch of operations (all-or-nothing). */
  async batch(ops: readonly BatchInputOp<V>[]): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    await this.awaitRotation();
    if (!ops || ops.length === 0) return;
    const prepared = ops.map((o) => this.prepareOp(o));
    await this.ensureMemoryFor(prepared);

    const commit = async (): Promise<void> => {
      const recoveryGate = this.walRecoveryGate();
      if (recoveryGate) await recoveryGate;
      if (this.indexes.indexes.size) {
        this.indexes.checkUniqueBatch(
          prepared.map((o) => ({
            pk: o.pk,
            op: o.type === TYPE_DEL ? ('del' as const) : ('set' as const),
            doc: o.valueDecoded,
          })),
        );
      }
      const body = encodeBatchOps(
        prepared.map<EncodedBatchOp>((op) => ({ type: op.type, key: op.key, value: op.value, meta: op.meta, expireAt: op.expireAt })),
      );
      const frame = encodeFrame({ type: TYPE_BATCH, key: Buffer.alloc(0), value: body });
      const wal = this.wal;
      const appended = wal.appendLoc(frame);
      const group = this.groupFor(wal, appended.batchId);
      // Capture each key's pre-batch record (first applyOp per key) so the whole
      // batch can be rolled back if the WAL write fails, preserving atomicity.
      const prevs = new Map<string, StoreRecord | undefined>();
      const applied = this.applyBox;
      let cur: PreparedOp<V> | null = null;
      try {
        for (const op of prepared) {
          cur = op;
          this.applyOp(op, applied);
          if (!prevs.has(op.pk)) prevs.set(op.pk, applied.prev);
        }
      } catch (err) {
        // See set() for this defensive path (applyOp's must-not-throw
        // contract); the op that threw mid-apply has its pre-state in `applied`.
        if (cur && !prevs.has(cur.pk)) prevs.set(cur.pk, applied.prev);
        void appended.done.catch(() => {}); // this batch throws here; swallow the frame's rejection
        if (group) {
          wal.poisonPending(err);
          for (const [pk, p] of prevs) this.groupNoteKey(group, pk, p);
          this.rollbackGroup(group, wal, appended.batchId);
          this.kickWalRecovery(wal);
        } else {
          for (const [pk, p] of prevs) this.restoreGroupKey(pk, p);
        }
        throw this.markAmbiguous(err);
      }
      for (const [pk, p] of prevs) this.groupNoteKey(group, pk, p);
      // Seq identity of each record as this batch left it (undefined where the
      // batch's last op deleted the key): guards both the per-op rollback
      // (frames that never entered a group, e.g. a seal race) and the WAL
      // pointer publish against interleaved same-key commits.
      const seqs = new Map<string, number | undefined>();
      for (const pk of prevs.keys()) seqs.set(pk, this.store.map.get(pk)?.seq);
      // In valueMode 'disk' the applied records hold in-memory refs for now
      // (see set()); their WAL pointers are published after `done` resolves.
      // Only the LAST set per key may publish — an earlier op's frame range
      // holds a superseded value.
      const lastSet = new Map<string, { op: PreparedOp<V>; loc: ValueLoc; seq: number | undefined }>();
      if (this.valueMode === 'disk') {
        const bodyOff = appended.offset + HEADER_SIZE;
        const opRefs = scanBatchOpRefs(body, 0);
        for (let i = 0; i < prepared.length; i++) {
          const op = prepared[i]!;
          const ref = opRefs[i];
          if (op.type === TYPE_SET && ref) {
            lastSet.set(op.pk, { op, loc: { file: 'wal', off: bodyOff + ref.valueOff, len: ref.valLen }, seq: seqs.get(op.pk) });
          }
        }
      }
      try {
        await appended.done;
      } catch (e) {
        if (group) this.rollbackGroup(group, wal, appended.batchId);
        else for (const [pk, prev] of prevs) this.restoreKey(pk, prev, seqs.get(pk));
        this.kickWalRecovery(wal);
        throw this.markAmbiguous(e);
      }
      this.settleGroup(group, wal, appended.batchId);
      for (const [pk, { op, loc, seq }] of lastSet) {
        this.publishWalRef(pk, wal, seq, loc, op.expireAt, op.dtNorm);
      }
      this.maybeAutoCompact();
    };

    if (this.hasUniqueIndexes()) await this.withUniqueWriteLock(() => this.retryOnWalSeal(commit));
    else await this.retryOnWalSeal(commit);
  }

  private prepareOp(o: BatchInputOp<V>): PreparedOp<V> {
    if (o.op === 'set') return this.prepareSet(o.key, o.value, { ttl: o.ttl, dt: o.dt });
    if (o.op === 'del') return this.prepareDel(o.key);
    throw new TypeError(`unknown batch op: ${(o as { op: string }).op}`);
  }

  private prepareSet(key: string | Buffer, value: V, { ttl, dt }: SetOptions = {}): PreparedOp<V> {
    this.checkKey(key);
    const pk = this.pk(key);
    const dtNorm = normDt(dt);
    // A TTL is encoded as an int64 in the frame, so it must be a finite integer
    // of milliseconds. A fractional TTL is floored; a non-finite one
    // (NaN / ±Infinity) is rejected up front instead of exploding inside the
    // frame encoder with an opaque "cannot convert to BigInt" error. ttl 0 (or
    // omitted) keeps the existing "no expiry" semantics.
    if (ttl !== undefined && !Number.isFinite(ttl)) throw new RangeError('ttl must be a finite number of milliseconds');
    const expireAt = ttl ? Date.now() + Math.floor(ttl) : 0;
    const vbuf = this.encode(value);
    const meta = dtNorm ? Buffer.from(JSON.stringify({ dt: dtNorm })) : null;
    return { type: TYPE_SET, key: toBuf(key), value: vbuf, meta, expireAt, dtNorm, pk, valueDecoded: value };
  }

  private prepareDel(key: string | Buffer): PreparedOp<V> {
    this.checkKey(key);
    return { type: TYPE_DEL, key: toBuf(key), value: null, meta: null, expireAt: 0, dtNorm: null, pk: this.pk(key), valueDecoded: undefined };
  }

  /** Apply a prepared op to the store + derived indexes, writing the key's
   *  pre-op logical record into `out.prev` so the caller can roll back (or
   *  poison + group-rollback) on failure. `out.prev` is assigned before any
   *  mutation, so it is valid even when the apply throws.
   *
   *  CONTRACT: applyOp must not throw — every fallible input validation
   *  belongs to the prepare phase (stage 11 moves unique checks, the
   *  tokenizer and canonical extraction there, making this structural).
   *  Until then the commit bodies wrap the call in a defensive try that
   *  converts a throw into a WAL poison + group rollback + in-place recovery;
   *  that path is not the normal one. */
  private applyOp(op: PreparedOp<V>, out: { prev: StoreRecord | undefined }): void {
    const oldBuf = this.store.get(op.pk);
    out.prev = oldBuf !== undefined ? this.store.map.get(op.pk) : undefined;
    const oldDoc = oldBuf !== undefined ? this.decode(oldBuf) : undefined;
    if (op.type === TYPE_SET) {
      // Always applied as an in-memory ref; in valueMode 'disk' the caller
      // swaps in the WAL pointer via publishWalRef() once the frame's bytes
      // are durably in db.wal.
      this.store.set(op.key, op.value!, op.expireAt, op.dtNorm);
      this.dt.set(op.pk, op.dtNorm);
      this.compound.add(op.pk, op.valueDecoded, op.dtNorm);
      if (this.indexes.indexes.size) {
        if (this.indexable(oldDoc)) this.indexes.remove(op.pk, oldDoc);
        if (this.indexable(op.valueDecoded)) this.indexes.add(op.pk, op.valueDecoded);
      }
      for (const ti of this.text.values()) {
        if (this.indexable(op.valueDecoded)) ti.add(op.pk, op.valueDecoded);
        else ti.remove(op.pk);
      }
    } else if (op.type === TYPE_DEL) {
      const existed = this.store.del(op.key);
      if (existed) {
        this.access.delete(op.pk);
        this.dt.del(op.pk);
        this.compound.remove(op.pk);
        if (this.indexes.indexes.size && this.indexable(oldDoc)) this.indexes.remove(op.pk, oldDoc);
        for (const ti of this.text.values()) ti.remove(op.pk);
      }
    }
    if (op.type === TYPE_SET) this.touchAccess(op.pk);
  }

  /** Roll a key back to its pre-op record across the store and every derived
   *  index. Used when a WAL write fails after applyOp already mutated state.
   *  `appliedSeq` is the store record's seq captured right after THIS attempt's
   *  own apply (undefined when the op left the key absent, i.e. a DEL). The
   *  restore is skipped when the key's current state no longer matches it —
   *  the same seq-identity guard publishWalRef uses — because a later same-key
   *  op committed (or an expiry reaped the key) meanwhile, and rolling back
   *  over it would wipe state that is already durable. This per-op path covers
   *  frames that never entered a flush group (batchId < 0: a seal/rotation
   *  race) and cross-group interleaves with retryOnWalSeal retries; grouped
   *  failures roll back via rollbackGroup instead. */
  private restoreKey(pk: string, prev: StoreRecord | undefined, appliedSeq: number | undefined): void {
    const cur = this.store.map.get(pk);
    if (appliedSeq === undefined ? cur !== undefined : cur?.seq !== appliedSeq) return;
    this.restoreGroupKey(pk, prev);
  }

  /** The unguarded restore core behind restoreKey and the flush-group
   *  rollback: put the key back to `prev` across the store and every derived
   *  index (TTL/access/dt/secondary/compound/text). */
  private restoreGroupKey(pk: string, prev: StoreRecord | undefined): void {
    if (this.indexes.indexes.size) this.indexes.remove(pk, undefined);
    for (const ti of this.text.values()) ti.remove(pk);
    this.dt.del(pk);
    this.compound.remove(pk);
    if (prev === undefined) {
      this.store.del(pk);
      this.access.delete(pk);
      return;
    }
    this.store.setRef(pk, prev.ref, prev.expireAt, prev.dt);
    this.touchAccess(pk);
    const doc = this.decode(this.store.get(pk));
    this.dt.set(pk, prev.dt);
    this.compound.add(pk, doc, prev.dt);
    if (this.indexable(doc)) this.indexes.add(pk, doc);
    for (const ti of this.text.values()) {
      if (this.indexable(doc)) ti.add(pk, doc);
    }
  }

  /** Apply one recovered WAL frame during catchUpFromWal: the same ops
   *  open-time recovery derives from it (frameToOps), plus the incremental
   *  derived-index maintenance applyOp performs on the write path — minus
   *  unique checks: the writer already validated, and intermediate frame
   *  states must apply literally (LWW). */
  private applyRecoveredFrame(f: FrameRef, fd: number): void {
    for (const op of frameToOps(f, 'wal', fd, this.valueMode)) this.applyRecoveredOp(op);
  }

  private applyRecoveredOp(op: RecoveredOp): void {
    const pk = this.pk(op.key);
    // Old doc for derived-index removal; decoded before the overwrite, like
    // applyOp. This get also lazy-reaps an expired old record, whose onExpire
    // hook then removes its derived entries for us.
    const oldDoc = this.indexes.indexes.size ? this.decode(this.store.get(pk)) : undefined;
    if (op.type === TYPE_DEL) {
      if (!this.store.del(pk)) return;
      this.access.delete(pk);
      this.dt.del(pk);
      this.compound.remove(pk);
      if (this.indexes.indexes.size && this.indexable(oldDoc)) this.indexes.remove(pk, oldDoc);
      for (const ti of this.text.values()) ti.remove(pk);
      return;
    }
    this.store.setRef(op.key, op.ref!, op.expireAt, op.dt);
    // Re-read through the store: a TTL too short to survive the few
    // microseconds since the replay-time expiry check was already reaped
    // here, with onExpire dropping derived state — exactly what a fresh
    // reopen leaves for the key. Otherwise dt/compound/secondary/text indexes
    // would be resurrected for a key the store no longer holds.
    const buf = this.store.get(pk);
    if (buf === undefined) return;
    this.dt.set(pk, op.dt);
    // Values are only decoded when a value-derived index exists (all of them
    // require the json codec): with none, recovery never copies them either.
    if (this.indexes.indexes.size || this.text.size || this.compound.list().length) {
      const doc = this.decode(buf)!;
      this.compound.add(pk, doc, op.dt);
      if (this.indexes.indexes.size) {
        if (this.indexable(oldDoc)) this.indexes.remove(pk, oldDoc);
        if (this.indexable(doc)) this.indexes.add(pk, doc);
      }
      for (const ti of this.text.values()) {
        if (this.indexable(doc)) ti.add(pk, doc);
        else ti.remove(pk);
      }
    }
    this.touchAccess(pk);
  }

  has(key: string | Buffer): boolean {
    this.ensureOpen();
    return this.store.has(toKStr(key));
  }
  get size(): number {
    return this.store.size;
  }
  async mset(entries: readonly (readonly [string, V])[]): Promise<void> {
    if (!entries.length) return;
    await this.batch(entries.map(([key, value]) => ({ op: 'set' as const, key, value })));
  }
  mget(keys: readonly string[]): (V | undefined)[] {
    return keys.map((k) => this.get(k));
  }

  async expire(key: string | Buffer, ttlMs: number): Promise<boolean> {
    this.ensureOpen();
    this.ensureWritable();
    await this.awaitRotation();
    const k = toKStr(key);
    const cur = this.store.getRecord(k);
    if (cur === undefined) return false;
    // Same validation as set(): the TTL is stored as an int64, so it must be a
    // finite integer of milliseconds (fractional values are floored).
    if (!Number.isFinite(ttlMs)) throw new RangeError('ttl must be a finite number of milliseconds');
    const expireAt = Date.now() + Math.floor(ttlMs);
    const curValue = this.store.get(k);
    if (curValue === undefined) return false;
    const meta = cur.dt ? Buffer.from(JSON.stringify({ dt: cur.dt })) : null;
    const keyBuf = toBuf(key);
    const frame = encodeFrame({ type: TYPE_SET, key: keyBuf, value: curValue, meta, expireAt });
    const commit = async (): Promise<void> => {
      const recoveryGate = this.walRecoveryGate();
      if (recoveryGate) await recoveryGate;
      const wal = this.wal;
      const appended = wal.appendLoc(frame);
      const group = this.groupFor(wal, appended.batchId);
      // In-memory ref first (see set()); the disk pointer is published once the
      // frame's bytes are durably in db.wal. prev/seq are captured per attempt
      // (as in set()): a rotation retry can find a different record in place,
      // and restoreKey's seq guard then leaves that newer durable state alone.
      const prev = this.store.map.get(k);
      let seq: number | undefined;
      try {
        this.store.set(k, curValue, expireAt, cur.dt);
        seq = this.store.map.get(k)?.seq;
      } catch (err) {
        // The in-memory mutation failed: an enqueued frame poisons the WAL
        // exactly like a write failure and rolls the group back; a
        // never-enqueued one only needs the per-op undo (see set()).
        void appended.done.catch(() => {}); // this op throws here; swallow the frame's rejection
        if (group) {
          wal.poisonPending(err);
          this.groupNoteKey(group, k, prev);
          this.rollbackGroup(group, wal, appended.batchId);
          this.kickWalRecovery(wal);
        } else {
          this.restoreGroupKey(k, prev);
        }
        throw this.markAmbiguous(err);
      }
      this.groupNoteKey(group, k, prev);
      try {
        await appended.done;
      } catch (e) {
        if (group) this.rollbackGroup(group, wal, appended.batchId);
        else this.restoreKey(k, prev, seq);
        this.kickWalRecovery(wal);
        throw this.markAmbiguous(e);
      }
      this.settleGroup(group, wal, appended.batchId);
      if (this.valueMode === 'disk') {
        this.publishWalRef(
          k,
          wal,
          seq,
          { file: 'wal', off: appended.offset + HEADER_SIZE + keyBuf.length, len: curValue.length },
          expireAt,
          cur.dt,
        );
      }
      this.maybeAutoCompact();
    };
    await this.retryOnWalSeal(commit);
    return true;
  }

  ttl(key: string | Buffer): number {
    this.ensureOpen();
    const r = this.store.map.get(toKStr(key));
    if (!r) return -2;
    if (!r.expireAt) return -1;
    const left = r.expireAt - Date.now();
    return left > 0 ? left : -2;
  }

  // ---- key-ordered scans --------------------------------------------------

  scan(opts: RangeOptions<string> = {}): ScanEntry<V>[] {
    this.ensureOpen();
    const count = (opts as { limit?: number }).limit ?? Infinity;
    const out: ScanEntry<V>[] = [];
    for (const r of this.store.scan({ ...canonRange(opts), count })) {
      out.push({ key: r.key.toString(), value: this.decode(r.value)!, dt: r.dt ?? undefined });
    }
    return out;
  }

  prefix(p: string, limit = Infinity): ScanEntry<V>[] {
    this.ensureOpen();
    const out: ScanEntry<V>[] = [];
    for (const r of this.store.prefix(toKStr(p), limit)) {
      out.push({ key: r.key.toString(), value: this.decode(r.value)!, dt: r.dt ?? undefined });
    }
    return out;
  }

  // ---- dt column queries --------------------------------------------------

  dtColumns(): string[] {
    return this.dt.columns();
  }

  dtRange(col: string, opts: RangeOptions<number> & { limit?: number } = {}): (ScanEntry<V> & { dtValue: number })[] {
    this.ensureOpen();
    const rows = this.dt.range(col, { ...opts, count: opts.limit ?? opts.count });
    const out: (ScanEntry<V> & { dtValue: number })[] = [];
    for (const { key, value: dtValue } of rows as DtRangeEntry[]) {
      const value = this.store.get(key);
      if (value === undefined) continue;
      const r = this.store.map.get(key);
      out.push({ key: fromKStr(key), value: this.decode(value)!, dt: r?.dt ?? undefined, dtValue });
    }
    return out;
  }

  // ---- value secondary indexes -------------------------------------------

  async createIndex(name: string, opts: IndexDef): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    if (this.codecName !== 'json') throw new Error('secondary indexes require valueCodec: "json"');
    this.indexes.create(name, opts);
    this.indexes.rebuild(this._liveRecordsRaw());
    try {
      // A unique index must not be created over data that already violates it.
      this.indexes.assertUniqueValid(name);
    } catch (e) {
      this.indexes.drop(name);
      this.indexes.rebuild(this._liveRecordsRaw());
      throw e;
    }
    await this.persistIndexDefinitions();
  }
  async dropIndex(name: string): Promise<boolean> {
    this.ensureOpen();
    this.ensureWritable();
    const ok = this.indexes.drop(name);
    await this.persistIndexDefinitions();
    return ok;
  }
  listIndexes(): IndexInfo[] {
    return this.indexes.list();
  }
  findEq(name: string, value: unknown): { key: string; value: V | undefined }[] {
    this.ensureOpen();
    return this.indexes
      .findEq(name, value)
      .map((pk) => ({ key: fromKStr(pk), value: this.decode(this.store.get(pk)) }))
      .filter((r): r is { key: string; value: V } => r.value !== undefined);
  }
  findRange(name: string, opts: Parameters<IndexManager['findRange']>[1]): { key: string; value: V | undefined; field: number }[] {
    this.ensureOpen();
    return this.indexes
      .findRange(name, opts)
      .map(({ pk, value }) => ({ key: fromKStr(pk), value: this.decode(this.store.get(pk)), field: value }))
      .filter((r): r is { key: string; value: V; field: number } => r.value !== undefined);
  }

  // ---- compound indexes (groupBy + orderBy) -------------------------------

  async createCompoundIndex(name: string, def: CompoundIndexDef): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    if (this.codecName !== 'json') throw new Error('compound indexes require valueCodec: "json"');
    this.compound.create(name, def);
    this.compound.rebuild(this.liveRecords());
    await this.persistCompoundIndexDefinitions();
  }

  async dropCompoundIndex(name: string): Promise<boolean> {
    this.ensureOpen();
    this.ensureWritable();
    const ok = this.compound.drop(name);
    await this.persistCompoundIndexDefinitions();
    return ok;
  }

  listCompoundIndexes(): CompoundIndexInfo[] {
    return this.compound.list();
  }

  /**
   * Ordered range within a group, e.g. "sessions in workspace X ordered by
   * updatedAt". O(log N + limit) — no full sort.
   */
  compoundRange(
    name: string,
    groupValue: unknown,
    opts: RangeOptions<unknown> & { limit?: number } = {},
  ): { key: string; value: V | undefined; orderValue: unknown }[] {
    this.ensureOpen();
    return this.compound
      .range(name, groupValue, opts)
      .map(({ key, orderValue }) => ({
        key: fromKStr(key),
        value: this.decode(this.store.get(key)),
        orderValue,
      }))
      .filter((r): r is { key: string; value: V; orderValue: unknown } => r.value !== undefined);
  }

  // ---- full-text search ---------------------------------------------------

  async createTextIndex(
    name: string,
    { fields, tokenizer }: { fields?: readonly string[]; tokenizer?: TextIndexTokenizerName } = {},
  ): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    if (this.codecName !== 'json') throw new Error('text indexes require valueCodec: "json"');
    if (this.text.has(name)) throw new Error(`text index "${name}" already exists`);
    const ti = new TextIndex({ fields, ...textIndexTokenizers(tokenizer), postingsPath: this.textPostingsPath(name) });
    const def: TextIndexDef = { name, fields: fields ?? null, tokenizer };
    // Register BEFORE building: the build yields to the event loop, and
    // registering makes concurrent writes feed the index's build queue, which
    // the build replays onto the new base — so the finished index reflects
    // every write whenever it landed. Until the build completes, searches on
    // the index see only its post-registration delta. A failed build unwinds
    // the registration, so a retry cannot hit a phantom "already exists".
    this.text.set(name, ti);
    try {
      await ti.build(this.textRecords());
    } catch (e) {
      this.text.delete(name);
      ti.close();
      throw e;
    }
    this.textDefs.push(def);
    try {
      await this.persistTextIndexDefinitions();
    } catch (e) {
      // Unwind so the in-memory state and the definition sidecar (which does
      // not name this index) do not diverge; drop the derived postings file
      // with it, exactly like dropTextIndex would.
      this.text.delete(name);
      this.textDefs = this.textDefs.filter((d) => d.name !== name);
      ti.close();
      await fs.rm(this.textPostingsPath(name), { force: true }).catch(() => {});
      throw e;
    }
  }
  async dropTextIndex(name: string): Promise<boolean> {
    this.ensureOpen();
    this.ensureWritable();
    const ti = this.text.get(name);
    // Dropping mid-build would orphan the in-flight postings write (the file
    // is removed while the build is still producing it).
    if (ti?.building) throw new Error(`text index "${name}" is still building`);
    const ok = this.text.delete(name);
    if (ti) {
      ti.close();
      await fs.rm(this.textPostingsPath(name), { force: true }).catch(() => {});
    }
    this.textDefs = this.textDefs.filter((d) => d.name !== name);
    await this.persistTextIndexDefinitions();
    return ok;
  }

  search(name: string, q: string, opts: { op?: 'AND' | 'OR'; limit?: number; maxVisits?: number } = {}): { key: string; value: V | undefined; score: number }[] {
    return this.searchBounded(name, q, opts).hits;
  }

  /**
   * `search` with work accounting: `opts.maxVisits` bounds how many posting
   * entries the index visits (see TextIndex.searchBounded); the result
   * reports the visits and whether the budget truncated the candidate set
   * (hits are then a subset of the full matches, never false hits).
   */
  searchBounded(
    name: string,
    q: string,
    opts: { op?: 'AND' | 'OR'; limit?: number; maxVisits?: number } = {},
  ): { hits: { key: string; value: V; score: number }[]; visits: number; truncated: boolean } {
    this.ensureOpen();
    const ti = this.text.get(name);
    if (!ti) throw new Error(`no such text index: ${name}`);
    const res = ti.searchBounded(q, opts);
    const hits = res.hits
      .map(({ key, score }) => ({ key: fromKStr(key), value: this.decode(this.store.get(key)), score }))
      .filter((r): r is { key: string; value: V; score: number } => r.value !== undefined);
    return { hits, visits: res.visits, truncated: res.truncated };
  }

  private indexPredicates(filter?: Record<string, unknown>): { field: string; cond: unknown }[] {
    if (!filter || typeof filter !== 'object') return [];
    const out: { field: string; cond: unknown }[] = [];
    for (const [key, cond] of Object.entries(filter)) {
      if (key === '$and' && Array.isArray(cond)) {
        for (const f of cond) {
          if (f && typeof f === 'object') {
            for (const [k, c] of Object.entries(f)) {
              if (!k.startsWith('$')) out.push({ field: k, cond: c });
            }
          }
        }
      } else if (!key.startsWith('$')) {
        out.push({ field: key, cond });
      }
    }
    return out;
  }

  private candidateKeysForPredicate(field: string, cond: unknown): Set<string> | null {
    if (this.codecName !== 'json' || !this.indexes.indexes.size) return null;
    const indexes = this.indexes.list().filter((i) => i.field === field);
    if (!indexes.length) return null;

    const isOpObj = cond !== null && typeof cond === 'object' && !(cond instanceof RegExp);
    const ops = isOpObj ? (cond as Record<string, unknown>) : null;

    const eqIndex = indexes.find((i) => i.type === 'equality');
    if (eqIndex) {
      if (!isOpObj) return new Set(this.indexes.findEq(eqIndex.name, cond));
      if (ops && Object.keys(ops).length === 1 && '$eq' in ops) {
        return new Set(this.indexes.findEq(eqIndex.name, ops['$eq']));
      }
      if (ops && Array.isArray(ops['$in'])) {
        const set = new Set<string>();
        for (const v of ops['$in']) for (const pk of this.indexes.findEq(eqIndex.name, v)) set.add(pk);
        return set;
      }
    }

    const rangeIndex = indexes.find((i) => i.type === 'range');
    if (rangeIndex && ops) {
      const opts: { min?: number; max?: number; minExclusive?: boolean; maxExclusive?: boolean } = {};
      if (typeof ops['$gte'] === 'number') opts.min = ops['$gte'];
      if (typeof ops['$gt'] === 'number') {
        opts.min = ops['$gt'];
        opts.minExclusive = true;
      }
      if (typeof ops['$lte'] === 'number') opts.max = ops['$lte'];
      if (typeof ops['$lt'] === 'number') {
        opts.max = ops['$lt'];
        opts.maxExclusive = true;
      }
      if (opts.min !== undefined || opts.max !== undefined) {
        return new Set(this.indexes.findRange(rangeIndex.name, opts).map((r) => r.pk));
      }
    }
    return null;
  }

  private indexedCandidateKeys(filter?: Record<string, unknown>): string[] | null {
    let candidates: Set<string> | null = null;
    for (const p of this.indexPredicates(filter)) {
      const set = this.candidateKeysForPredicate(p.field, p.cond);
      if (!set) continue;
      if (candidates) {
        const next = new Set<string>();
        for (const k of candidates) if (set.has(k)) next.add(k);
        candidates = next;
      } else {
        candidates = set;
      }
    }
    if (!candidates) return null;
    this.stats.queryIndexHits++;
    return [...candidates];
  }

  // Extract simple equality predicates (top-level or inside $and) that are
  // backed by an equality index, for use as a cheap per-candidate pre-filter.
  // Only direct equality and {$eq: x} qualify; $in / range / non-indexed fields
  // are left to the full match() after decode.
  private cheapEqChecks(filter?: Record<string, unknown>): { name: string; value: unknown }[] {
    const out: { name: string; value: unknown }[] = [];
    if (!filter || typeof filter !== 'object' || !this.indexes.indexes.size) return out;
    for (const { field, cond } of this.indexPredicates(filter)) {
      const idx = this.indexes.list().find((i) => i.field === field && i.type === 'equality');
      if (!idx) continue;
      if (cond !== null && typeof cond === 'object' && !(cond instanceof RegExp)) {
        const ops = cond as Record<string, unknown>;
        if (Object.keys(ops).length === 1 && '$eq' in ops) out.push({ name: idx.name, value: ops['$eq'] });
      } else {
        out.push({ name: idx.name, value: cond });
      }
    }
    return out;
  }

  // Fast path: a query bounded by a single dt column whose result order is that
  // dt column can walk the dt skiplist in order and stop as soon as `limit`
  // qualifying rows are found, instead of materializing + decoding + sorting the
  // whole candidate set. Returns null when the query is not eligible (caller
  // falls back to the general path). Kept conservative so results match exactly.
  private tryDtOrderedLimit(q: QueryOptions): ScanEntry<V>[] | null {
    if (q.text) return null; // text has its own ranking
    if (q.key !== undefined) return null;
    if (q.limit === undefined) return null; // unbounded -> full return, no win
    if (!q.dt) return null;
    const dtCols = Object.keys(q.dt);
    if (dtCols.length !== 1) return null;
    const col = dtCols[0]!;
    const cond = q.dt[col]!;
    // A dt condition carrying its own offset/count has slice semantics this
    // fast path cannot reproduce exactly (it honors range bounds only) — the
    // general path handles it.
    if (cond.offset !== undefined || cond.count !== undefined) return null;

    // Result order must be the dt column's order.
    let reverse = false;
    if (q.sort) {
      const entries = Object.entries(q.sort);
      if (entries.length !== 1) return null;
      const [sortKey, dir] = entries[0]!;
      if (sortKey !== col) return null;
      reverse = dir < 0;
    }

    const limit = q.limit;
    const skip = q.skip ?? 0;
    const iterOpts: RangeOptions<number> = { reverse };
    if (cond.gte !== undefined) iterOpts.gte = cond.gte;
    if (cond.gt !== undefined) iterOpts.gt = cond.gt;
    if (cond.lte !== undefined) iterOpts.lte = cond.lte;
    if (cond.lt !== undefined) iterOpts.lt = cond.lt;

    // Cheap key-level pre-filter (no decode, no full-set materialization) for
    // simple equality predicates that have an equality index.
    const eqChecks = this.cheapEqChecks(q.filter);

    const out: { key: string; value: V; dt: Record<string, number> | undefined }[] = [];
    let skipped = 0;
    for (const { key: kstr } of this.dt.iterate(col, iterOpts)) {
      this.stats.queryCandidates++;
      let rejected = false;
      for (const c of eqChecks) {
        if (!this.indexes.hasEq(c.name, c.value, kstr)) {
          rejected = true;
          break;
        }
      }
      if (rejected) continue;
      const buf = this.store.get(kstr);
      if (buf === undefined) continue;
      const r = this.store.map.get(kstr);
      this.stats.queryDecoded++;
      const value = this.decode(buf)!;
      if (q.filter && !match(value, q.filter)) continue;
      if (skipped < skip) {
        skipped++;
        continue;
      }
      out.push({ key: kstr, value, dt: r?.dt ?? undefined });
      if (out.length >= limit) break;
    }

    return out.map((d) => ({
      key: fromKStr(d.key),
      value: q.project ? (project(d.value, q.project) as V) : d.value,
      dt: d.dt,
    }));
  }

  // ---- unified query ------------------------------------------------------

  query(q: QueryOptions = {}): ScanEntry<V>[] {
    this.ensureOpen();
    const fast = this.tryDtOrderedLimit(q);
    if (fast !== null) return fast;

    // Candidate collection never decodes values and stays lazy (a one-shot
    // iterable) wherever possible: key scans walk the ordered index directly,
    // and intersections filter as they go. A bounded query below then decodes
    // only the rows it returns instead of materializing the whole candidate
    // set first.
    let keys: Iterable<string> | null = null;
    if (typeof q.key === 'string') {
      keys = [toKStr(q.key)];
    } else if (q.key && typeof q.key === 'object') {
      if ((q.key as { prefix?: string }).prefix) {
        const p = toKStr((q.key as { prefix: string }).prefix);
        keys = this.store.rawKeys({ gte: p, lt: p + '\uffff' });
      } else {
        const opts: RangeOptions<string> = {};
        for (const b of ['gte', 'gt', 'lte', 'lt'] as const)
          if ((q.key as Record<string, unknown>)[b] !== undefined) opts[b] = (q.key as Record<string, unknown>)[b] as string;
        keys = this.store.rawKeys(canonRange(opts));
      }
    }

    if (q.dt) {
      for (const [col, cond] of Object.entries(q.dt)) {
        const set = new Set(this.dt.range(col, cond).map((r) => r.key));
        keys = keys === null ? set : filterKeys(keys, (k) => set.has(k));
      }
    }

    let textOrder: { key: string; score: number }[] | null = null;
    if (q.text) {
      const ti = this.text.get(q.text.index);
      if (!ti) throw new Error(`no such text index: ${q.text.index}`);
      const hits = ti.search(q.text.q, { op: q.text.op, limit: q.text.limit ?? 1_000_000 });
      textOrder = hits;
      const set = new Set(hits.map((h) => h.key));
      keys = keys === null ? hits.map((h) => h.key) : filterKeys(keys, (k) => set.has(k));
    }

    const indexed = this.indexedCandidateKeys(q.filter);
    if (indexed) {
      const set = new Set(indexed);
      keys = keys === null ? indexed : filterKeys(keys, (k) => set.has(k));
    }

    if (keys === null) keys = this.store.rawKeys({});

    const skip = q.skip ?? 0;
    const limit = q.limit === undefined ? Infinity : q.limit;
    // Without an explicit sort or text ranking, result order is the candidate
    // iteration order, so skip/limit can be applied while iterating: a bounded
    // query decodes only the rows it returns instead of the whole candidate
    // set (an indexed equality query with limit previously decoded every
    // candidate and sliced at the end).
    const early = !q.sort && !textOrder;
    const docs: ScanEntry<V>[] = [];
    let seen = 0;
    for (const k of keys) {
      this.stats.queryCandidates++;
      const buf = this.store.get(k);
      if (buf === undefined) continue;
      const r = this.store.map.get(k);
      this.stats.queryDecoded++;
      const value = this.decode(buf)!;
      if (q.filter && !match(value, q.filter)) continue;
      if (early) {
        if (seen++ < skip) continue;
        docs.push({ key: k, value, dt: r?.dt ?? undefined });
        if (docs.length >= limit) break;
      } else {
        docs.push({ key: k, value, dt: r?.dt ?? undefined });
      }
    }

    if (textOrder && !q.sort) {
      this.stats.querySortedRows += docs.length;
      const rank = new Map(textOrder.map((h, i) => [h.key, i]));
      docs.sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
    }

    if (q.sort) {
      this.stats.querySortedRows += docs.length;
      const entries = Object.entries(q.sort);
      docs.sort((a, b) => {
        for (const [p, dir] of entries) {
          const av = getPath(a.value, p) as number | string;
          const bv = getPath(b.value, p) as number | string;
          const c = av < bv ? -1 : av > bv ? 1 : 0;
          if (c !== 0) return dir < 0 ? -c : c;
        }
        return 0;
      });
    }

    const sliced = early ? docs : skip || limit !== Infinity ? docs.slice(skip, skip + limit) : docs;

    if (q.project) {
      return sliced.map((d) => ({ key: fromKStr(d.key), value: project(d.value, q.project) as V, dt: d.dt }));
    }
    return sliced.map((d) => ({ ...d, key: fromKStr(d.key) }));
  }

  private async persistentFiles(): Promise<string[]> {
    const names = await fs.readdir(this.dir);
    return names.filter((n) =>
      /^db\.(snapshot|wal|indexes\.json|compound-indexes\.json|textindexes\.json)$/.test(n) ||
      /^db\.text-.*\.postings$/.test(n),
    );
  }

  private async copyIfExists(name: string, destDir: string): Promise<boolean> {
    try {
      await fs.copyFile(path.join(this.dir, name), path.join(destDir, name));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }

  /** Write a consistent online backup of this database directory. */
  async backup(destDir: string, opts: { compact?: boolean } = {}): Promise<void> {
    this.ensureOpen();
    if (!destDir) throw new TypeError('backup: destDir is required');
    if (this.compacting) await this._compactDone;
    if (opts.compact !== false && !this.readOnly) await this.compact();
    if (this.compacting) await this._compactDone;

    let releaseRotation!: () => void;
    this._rotateLock = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    try {
      // Wait out any in-flight WAL recovery before fencing: a WAL failure
      // racing the backup leaves un-acked bytes in db.wal that the recovery
      // is about to truncate away, and the fence must land on the recovered
      // (possibly truncated) file rather than copying bytes that are about
      // to disappear. A persistent failure keeps the WAL poisoned and the
      // flush below then rejects the backup. (Stage 12 rewrites backup with
      // OpTracker; this is the minimal guard.)
      await this.walRecoveryChain;
      await this.wal.flush();
      await fs.mkdir(destDir, { recursive: true });
      const files = await this.persistentFiles();
      const copied: string[] = [];
      for (const name of files) if (await this.copyIfExists(name, destDir)) copied.push(name);
      await fs.writeFile(
        path.join(destDir, 'backup.manifest.json'),
        JSON.stringify({ version: 1, createdAt: Date.now(), files: copied }, null, 2),
        'utf8',
      );
    } finally {
      releaseRotation();
      this._rotateLock = null;
    }
  }

  /** Restore a backup directory into destDir and open it. */
  static async restore<V = unknown>(srcDir: string, destDir: string, opts: RestoreOptions = {}): Promise<MiniDb<V>> {
    if (!srcDir) throw new TypeError('restore: srcDir is required');
    if (!destDir) throw new TypeError('restore: destDir is required');
    const { force, ...openOpts } = opts;

    if (force) {
      await fs.rm(destDir, { recursive: true, force: true });
    } else {
      try {
        const existing = await fs.readdir(destDir);
        if (existing.length) throw new Error(`restore destination is not empty: ${destDir}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    await fs.mkdir(destDir, { recursive: true });

    const names = await fs.readdir(srcDir);
    for (const name of names) {
      if (
        /^db\.(snapshot|wal|indexes\.json|compound-indexes\.json|textindexes\.json)$/.test(name) ||
        /^db\.text-.*\.postings$/.test(name) ||
        name === 'backup.manifest.json'
      ) {
        await fs.copyFile(path.join(srcDir, name), path.join(destDir, name));
      }
    }
    return MiniDb.open<V>({ ...openOpts, dir: destDir });
  }

  // ---- maintenance --------------------------------------------------------

  /** Refresh the write lock's timestamp (see {@link LockFile.renew}). No-op
   *  for a read-only instance. Exposed for lease-style holders such as the
   *  cluster shard pool, which renew on a timer to prove liveness. */
  async renewLock(): Promise<void> {
    await this.lock?.renew();
  }

  /** Advanced/internal (read-replica owners such as the cluster shard pool):
   *  incrementally apply WAL frames appended to db.wal after `offset` — the
   *  same frames open-time recovery would replay, interpreted identically
   *  (frameToOps: valueMode memory/disk refs, expired-SET drop with LWW,
   *  TYPE_BATCH unrolling, dt meta) — plus incremental maintenance of every
   *  derived index (dt, compound, secondary, text). Unique constraints are
   *  NOT checked: the writer already validated, and intermediate frame states
   *  must apply literally, last-writer-wins.
   *
   *  The instance tracks its own continuation: the first call must pass
   *  recoveryInfo.walScanEnd, every later call the previous call's returned
   *  offset, and the fs identity of the WAL opened for reading must match the
   *  inode recovery (or the last catch-up) scanned — an offset too old/new, a
   *  rotated file and a shrunken one all return null, meaning: reopen from
   *  scratch. A partial/torn tail left by a writer mid-writev is NOT an
   *  error: the scan stops at the last fully-valid frame; call again later
   *  and its CRC validates once the writev landed. */
  async catchUpFromWal(offset: number): Promise<{ offset: number; appliedFrames: number } | null> {
    this.ensureOpen();
    const ri = this.recoveryInfo;
    const anchor = this.walTail ?? (ri && ri.walIno ? { dev: ri.walDev, ino: ri.walIno, size: ri.walScanEnd } : null);
    if (!anchor || offset !== anchor.size) return null;
    const res = catchUpWal(this.walPath, offset, anchor, (f, fd) => this.applyRecoveredFrame(f, fd));
    if (res) this.walTail = { dev: anchor.dev, ino: anchor.ino, size: res.offset };
    return res;
  }

  async compact(): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    await compact(this);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.compacting) await this._compactDone;
    this.closed = true;
    // Let in-flight WAL failures and their kicked recoveries settle before
    // and after closing the WAL: a poisoned/failing close would otherwise
    // leave an un-acked tail in db.wal that a reopen replays as ghost writes.
    // Kicks arrive in op rejection microtasks that can be scheduled behind
    // this close (and the WAL's own final flush can drive a queued failing
    // batch, kicking one more recovery), so wait for the chain to be IDLE in
    // a loop instead of awaiting one snapshot of it.
    while (!this.walRecoveryIdle) await this.walRecoveryChain;
    for (const ti of this.text.values()) ti.close();
    this.store.close();
    this.valueReader?.close();
    await this.wal.close();
    while (!this.walRecoveryIdle) await this.walRecoveryChain;
    if (this.lock) {
      await this.lock.release();
      this.lock = null;
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('MiniDb is closed');
  }
  private ensureWritable(): void {
    if (this.readOnly) throw new Error('MiniDb is open in read-only mode');
    if (this.writeDisabled) throw this.writeDisabledError();
  }
}
