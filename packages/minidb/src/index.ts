// src/index.ts
//
// MiniDb: the public embedded API. Ties together the in-memory Store (with its
// ordered key index), the WAL, recovery, compaction, dt-column indexes, value
// secondary indexes, and full-text indexes.
//
// Document model:
//   { key: string(<=128), value: <any JSON>, dt1..dtN: <epoch-ms datetime columns> }

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import type { StoreRecord, ValueLoc, ValueRef } from './store.js';
import { WAL } from './wal.js';
import type { WalPoison } from './wal.js';
import { ValueReader } from './value-reader.js';
import { recover, catchUpWal, frameToOps } from './recovery.js';
import { compact, shouldCompact, fsyncDir } from './compaction.js';
import { OpTracker } from './op-tracker.js';
import {
  SNAPSHOT_FILE,
  WAL_FILE,
  SECONDARY_INDEXES_FILE,
  COMPOUND_INDEXES_FILE,
  TEXT_INDEXES_FILE,
  SIDECAR_FILES,
  STALE_TMP_FILES,
  STALE_POSTINGS_TMP_PATTERN,
  GENERATION_FORMAT_VERSION,
  STORE_IMAGE_FILE,
  DT_INDEX_FILE,
  SECONDARY_INDEX_FILE,
  COMPOUND_INDEX_FILE,
  GEN_SNAPSHOT_FILE,
  generationId,
  indexDefHash,
  isStaleTmpFile,
  isPersistentFile,
  rootPostingsFile,
  textDictionaryFile,
  textPostingsFile,
  textDocsFile,
} from './generation.js';
import type { GenerationManifest } from './generation.js';
import {
  cleanupGenerations,
  generationDir,
  generationsDir,
  listGenerations,
  publishGeneration,
  readCurrent,
  readManifest,
  sweepGenerationTemps,
  writeManifest,
} from './generation-files.js';
import {
  GenerationCorruptError,
  STORE_VERSION,
  readGenerationFileChecked,
  readStoreImage,
  readDtIndexImage,
  readSecondaryIndexImage,
  readCompoundIndexImage,
  readTextDictionaryImage,
  readTextDocsImage,
  verifyFileIntegritySync,
  writeStoreImage,
  writeDtIndexImage,
  writeSecondaryIndexImage,
  writeCompoundIndexImage,
  writeTextDictionaryImage,
  writeTextDocsImage,
} from './gen-codec.js';
import type { StoreImageRecord, TextDocsImage } from './gen-codec.js';
import { IndexManager, UniqueViolationError } from './index-manager.js';
import { DtIndex } from './dt-index.js';
import { TextIndex, type TextIndexOptions, type TextIndexBuild } from './text-index.js';
import { createNgramTokenizer } from './trigram.js';
import { CompoundIndexManager } from './compound-index.js';
import { getPath, match, project } from './query.js';
import { LockFile, LockError } from './lockfile.js';
import { createSerializer } from './serialize.js';
import { encodeFrame, encodeBatchOps, scanBatchOpRefs, scanFrameRefsFd, HEADER_SIZE, TYPE_SET, TYPE_DEL, TYPE_BATCH } from './codec.js';
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

// Distinct tmp name per write (`tmp-${pid}-${seq}`, the lockfile sidecarSeq
// pattern): the per-sidecar mutation chains are the real serialization fix,
// unique tmps are defense in depth — no write can ever rename (or strand)
// another in-flight write's tmp, and a crashed predecessor's leftovers match
// the open-time isStaleTmpFile cleanup.
let sidecarTmpSeq = 0;

/** Unique suffixes for backup's temp/aside dirs (see copyBackupAtomic). */
let backupTmpSeq = 0;

/** Write a small metadata file atomically (unique tmp + rename + strict
 *  directory fsync), so a crash cannot leave a torn definition file that
 *  would force openers into error/rebuild — and a successful return means
 *  the rename is crash-durable (the stage-9 strict fsyncDir mode; a platform
 *  without directory fsync degrades via fsyncDir itself). A strict fsync
 *  failure propagates even though the renamed bytes may already be visible:
 *  persist = crash-durable by definition, so the caller treats the mutation
 *  as failed and keeps its previous in-memory state (the same ambiguity rule
 *  as a WAL commit-point failure). */
async function writeFileAtomic(file: string, data: string, opts: { stats?: { dirFsyncUnsupported?: boolean } } = {}): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${++sidecarTmpSeq}`;
  try {
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, file);
  } finally {
    // A successful rename already moved the tmp away (this rm is a no-op); a
    // failed write/rename must not strand it.
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  await fsyncDir(path.dirname(file), { strict: true, stats: opts.stats });
}

async function resolveValueMode(mode: ValueModeSetting, dir: string, maxMemoryBytes: number | null): Promise<ValueMode> {
  if (mode !== 'auto') return mode;
  if (maxMemoryBytes === null) return 'memory';
  const total = (await fileSize(path.join(dir, SNAPSHOT_FILE))) + (await fileSize(path.join(dir, WAL_FILE)));
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
  /** Persistent index generations (stage 5), default true. With generations
   *  enabled, a writer publishes derived-state checkpoints under
   *  `generations/` and open loads them instead of rebuilding every index
   *  from a full store scan; the legacy full recovery remains the automatic
   *  fallback. Set false to force the pre-generation behavior everywhere
   *  (full open-time rebuild, root postings rebuilds after compaction). */
  indexGenerations?: boolean;
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

/** One write op captured by an in-flight generation build (stage 5). The
 *  build walks the live store and then drains this queue onto its detached
 *  states, so the image equals replaying snapshot + WAL up to the sealed
 *  checkpoint exactly. `storeOnly` marks expire()'s TTL-only rewrite: the
 *  value is unchanged, so value-derived index states need no re-feed. */
interface GenBuildOp {
  type: number; // TYPE_SET | TYPE_DEL
  pk: string;
  value: Buffer | null;
  expireAt: number;
  dtNorm: Record<string, number> | null;
  canonical: unknown;
  storeOnly?: boolean;
}

/** Internal control-flow exception: the generation build noticed a rotation,
 *  a WAL rollback, a closing instance, or a queue overflow and discarded
 *  itself. Aborts are expected under churn (never counted as errors). */
class GenerationBuildAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationBuildAborted';
  }
}

/** Soft caps on the generation build's mutation queue: a write storm outrun-
 *  ning the build's drain aborts the build instead of buffering unboundedly —
 *  bounded both by op count and by accumulated value bytes (each queued op
 *  pins its value buffer). */
const GEN_BUILD_QUEUE_CAP = 1_000_000;
const GEN_BUILD_QUEUE_BYTES_CAP = 512 * 1024 * 1024;

/** Trigger-(b) thresholds for the open-time background build: a generation
 *  whose WAL delta replay exceeded either is refreshed in the background so
 *  the next open is cheap (the per-op replay path is for small deltas only). */
const GEN_BUILD_WAL_DELTA_OPS = 4096;
const GEN_BUILD_WAL_DELTA_BYTES = 4 * 1024 * 1024;

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
  /** Names staged for drop by dropTextIndex (plan 10's "mark staged-drop,
   *  persist, then remove from live"). A compaction's postings rebuild
   *  (rebuildTextPostings) skips them: without the mark, a build starting in
   *  the drop's persist window could commit AFTER the drop's close+rm —
   *  re-creating the postings file as an orphan and leaking the reopened
   *  handle. */
  private readonly textDrops = new Set<string>();

  private codec!: ValueCodec<V>;
  private codecName: ValueCodecName = 'buffer';
  fsyncPolicy: FsyncPolicy = 'everysec';
  syncIntervalMs = 1000;
  /** Lifecycle state machine. 'closing' is a real state (not just a flag on
   *  the way down): a cleanup failure leaves the instance there so a later
   *  close() call can retry the remaining cleanup, and ensureOpen rejects
   *  'closing' and 'closed' alike. */
  private state: 'open' | 'closing' | 'closed' = 'open';
  /** The in-flight close() cleanup pass, shared by concurrent close() calls. */
  private closePromise: Promise<void> | null = null;
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
  /** Serializes write ops while any unique index exists (check-then-apply must
   *  be atomic against other writers). Shared promise-chain pattern — see
   *  serialize.ts. */
  private readonly serializeUniqueWrites = createSerializer();
  /** Per-sidecar mutation chains (one promise-chain mutex per index-definition
   *  sidecar file, plan 10): a create/drop runs its whole staged → persist →
   *  publish sequence under its sidecar's chain, so concurrent mutations of
   *  the SAME definition file can never interleave (before this, two
   *  concurrent creates shared one fixed .tmp — one renamed the other's tmp
   *  away — and a persist failure diverged the live registry from disk).
   *  Different sidecar types do NOT block each other, and the data write path
   *  (set/batch/del) never touches these chains. The in-chain rebuild is a
   *  full Store walk: index changes are rare admin operations, so holding the
   *  chain across the walk is the accepted trade-off. */
  private readonly secondaryDefChain = createSerializer();
  private readonly compoundDefChain = createSerializer();
  private readonly textDefChain = createSerializer();
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
  /** Write-op gate + in-flight counter (plan 12's OpTracker): set/del/batch/
   *  expire run inside enter/leave, and backup() pauses the gate — the drain
   *  completion is backup's linearization point (every write acknowledged
   *  before it is in the backup; writes submitted meanwhile reject with
   *  BACKUP_IN_PROGRESS). close() does NOT drain it: an op in flight at close
   *  keeps its stage-7/8 semantics (its frame rejects as the WAL closes and
   *  the op rolls back). */
  private readonly writeOps = new OpTracker();
  /** Serializes whole backup() runs: two backups to the same destination would
   *  otherwise swap each other's freshly-renamed result aside and delete it,
   *  and even to different destinations they would duplicate the compaction +
   *  copy work. The write-gate pause itself is reference-counted and safe to
   *  overlap (see op-tracker.ts). Same promise-chain pattern as
   *  serializeUniqueWrites. */
  private readonly serializeBackups = createSerializer();
  /** Persistent index generations enabled (OpenOptions.indexGenerations,
   *  default true). When false the instance behaves exactly as before stage
   *  5: full open-time rebuild + root postings rebuilds after compaction. */
  private indexGenerationsEnabled = true;
  /** The in-flight generation build's mutation queue registration (stage 5):
   *  while non-null, applyOp (and expire()'s TTL rewrite) push every applied
   *  op here so the build's detached states converge on the exact checkpoint.
   *  `wal` pins the WAL identity the build measured — a compaction rotation
   *  replaces it and aborts the build (its disk refs would point into rotated
   *  files). `aborted` is set by the rollback path (restoreGroupKey), which
   *  mutates the store outside applyOp and therefore outside the queue. */
  private genBuild: { queue: GenBuildOp[]; bytes: number; wal: WAL; aborted: boolean } | null = null;
  /** Single-flight guard for generation builds (open-time background builds
   *  dedupe onto it; a compaction-triggered build awaits an in-flight one —
   *  which the rotation just aborted — before starting fresh). close() drains
   *  it before releasing resources. */
  private genBuildPromise: Promise<void> | null = null;
  /** The generation this instance loaded at open or last published (null when
   *  running on the legacy recovery path). Stable status surface — see
   *  getIndexGeneration(). */
  private generationInfo: { id: string; createdAt: number; walCheckpoint: number; records: number } | null = null;
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
    /** Set once a rotation's directory fsync reported EINVAL/ENOTSUP: this
     *  platform cannot make renames durable via the directory, so rotation
     *  durability is knowingly degraded (warned once), never silently. */
    dirFsyncUnsupported: false,
    /** Candidate keys iterated / values decoded / rows fed to a sort in query(). */
    queryCandidates: 0,
    queryDecoded: 0,
    querySortedRows: 0,
    // ---- persistent index generations (stage 5) ----
    /** Successful generation builds (published under generations/ + CURRENT). */
    generationBuilds: 0,
    /** Builds that failed with a real error (I/O, corruption). */
    generationBuildErrors: 0,
    /** Builds discarded because the ground shifted under them (rotation, WAL
     *  rollback, queue overflow, close) — expected churn, not an error. */
    generationBuildAborts: 0,
    generationBuildDurationMs: 0,
    /** Opens served by a published generation (no full index rebuild). */
    generationLoads: 0,
    /** Opens that fell back to the legacy full recovery (no/invalid
     *  generation); the sticky reason is in lastGenerationFallback. */
    generationLoadFallbacks: 0,
    lastGenerationFallback: null as string | null,
    generationLoadDurationMs: 0,
    /** Individual index images rejected at generation load (definition hash
     *  mismatch, corrupt file) and rebuilt from the loaded store. */
    generationIndexRebuilds: 0,
  };

  /** Hook called by compaction after the store snapshot + WAL are rotated, so
   *  derived on-disk state can be rewritten against the new live set.
   *  Structural part of the CompactionTarget interface; the compaction awaits
   *  it, so it may be sync or async.
   *
   *  Stage 5: with index generations enabled this is ONE publish transaction
   *  — the snapshot rotation and the derived-state checkpoint (store image,
   *  dt/secondary/compound images, text postings) land as a single new
   *  generation, and the live text indexes rebase onto it. The synchronous
   *  rebuildTextPostings() tail no longer runs. With generations disabled the
   *  legacy behavior is kept exactly. */
  onCompacted: () => void | Promise<void> = async (): Promise<void> => {
    const t0 = performance.now();
    if (!this.indexGenerationsEnabled) {
      await this.rebuildTextPostings();
      const ms = performance.now() - t0;
      this.stats.compactionPostingsDurationMs += ms;
      this.stats.textRebuildDurationMs += ms;
      return;
    }
    await this.buildGeneration('compact');
    this.stats.compactionPostingsDurationMs += performance.now() - t0;
  };

  static async open<V = unknown>(opts: OpenOptions): Promise<MiniDb<V>> {
    if (!opts || !opts.dir) throw new TypeError('MiniDb.open: opts.dir is required');
    const db = new MiniDb<V>();
    db.dir = opts.dir;
    db.walPath = path.join(db.dir, WAL_FILE);
    db.indexPath = path.join(db.dir, SECONDARY_INDEXES_FILE);
    db.textIndexPath = path.join(db.dir, TEXT_INDEXES_FILE);
    db.compoundIndexPath = path.join(db.dir, COMPOUND_INDEXES_FILE);
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
    db.indexGenerationsEnabled = opts.indexGenerations ?? true;
    if (db.maxMemoryBytes !== null && (!Number.isFinite(db.maxMemoryBytes) || db.maxMemoryBytes <= 0)) {
      throw new RangeError('maxMemoryBytes must be a positive finite number');
    }

    db.readOnly = !!opts.readOnly;
    // A read-only open must never create the directory (review #26): probe it
    // up front so a missing dir fails with a clear ENOENT here instead of
    // being mkdir'd into an empty database the caller believes held data. A
    // writer open still creates it.
    if (db.readOnly) await fs.readdir(db.dir);
    else await fs.mkdir(db.dir, { recursive: true });
    db.valueMode = await resolveValueMode(valueMode, db.dir, db.maxMemoryBytes);

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
    // compaction's snapshot/WAL temps, sidecar-definition temps — the atomic
    // write siblings of every persistent file, derived from the authoritative
    // module). Only the sole writer may delete them — a read-only opener must
    // never touch a live writer's in-flight temps.
    if (!db.readOnly) {
      for (const tmp of STALE_TMP_FILES) {
        await fs.rm(path.join(db.dir, tmp), { force: true });
      }
      for (const f of await fs.readdir(db.dir)) {
        // Unique-suffixed sidecar temps (`<file>.tmp-<pid>-<seq>`) orphaned by
        // a crashed writeFileAtomic — whitelisted per known file so a live
        // LockFile's db.lock.tmp-* is never matched (isStaleTmpFile).
        if (isStaleTmpFile(f)) {
          await fs.rm(path.join(db.dir, f), { force: true });
          continue;
        }
        // A failed postings rebuild orphans `db.text-*.postings.tmp` (its atomic
        // rename never ran). Postings are pure derived state — rebuilt from the
        // Store on open and after compaction — so such temps are always safe to
        // delete, for any index name.
        if (STALE_POSTINGS_TMP_PATTERN.test(f)) await fs.rm(path.join(db.dir, f), { force: true });
      }
      // Stranded generation build tmp dirs (a crashed build never published):
      // only the sole writer may delete them.
      await sweepGenerationTemps(db.dir);
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

      // Index definitions BEFORE recovery: the generation load path matches
      // the live registries (and the TextIndex instances) against the
      // manifest's definition hashes, so they must exist first. The loaders
      // only read sidecars and construct empty indexes — order-independent
      // with respect to the store.
      await db.loadIndexDefinitions();
      await db.loadCompoundIndexDefinitions();
      await db.loadTextIndexDefinitions();

      // Stage 5: a published generation serves the open (store image +
      // derived-index images + WAL delta replay) and skips the full rebuild
      // below. Any validation failure falls back to the legacy full recovery
      // inside tryLoadGeneration — never a deletion of authoritative data.
      let generationLoaded = false;
      if (db.indexGenerationsEnabled) generationLoaded = await db.tryLoadGeneration(opts.recovery ?? 'resync');

      if (!generationLoaded) {
        const recT0 = performance.now();
        db.recoveryInfo = await recover({
          dir: db.dir,
          store: db.store,
          mode: opts.recovery ?? 'resync',
          truncate: !db.readOnly,
          valueMode: db.valueMode,
          // Disk-backed values need the positioned reader attached to the SAME
          // inodes recovery scanned; recovery's generation pairing re-verifies
          // the attach and retries the whole pass when a rotation landed in
          // between (see the pairing note in recovery.ts). In valueMode
          // 'memory' no record ever carries a disk loc, so opening the files
          // would only hold handles for no benefit (on Windows those idle
          // handles would additionally block compaction's rename-over-path
          // rotation — rename over an open destination is EPERM there).
          attachValueReader:
            db.valueMode === 'disk'
              ? (anchors) => {
                  const reader = new ValueReader(db.dir);
                  // open() can throw after attaching only one side (e.g. EMFILE
                  // on the WAL with the snapshot already open). This reader is
                  // never published to db.valueReader, so the open() failure
                  // cleanup cannot reach it — close it here or leak the fd.
                  let ids: ReturnType<ValueReader['open']>;
                  try {
                    ids = reader.open();
                  } catch (e) {
                    reader.close();
                    throw e;
                  }
                  const sameInode = (a: { dev: number; ino: number } | null, i: { dev: number; ino: number } | null): boolean =>
                    a === null ? i === null : i !== null && i.dev === a.dev && i.ino === a.ino;
                  if (sameInode(anchors.snapshot, ids.snapshot) && sameInode(anchors.wal, ids.wal)) {
                    db.valueReader = reader;
                    return true;
                  }
                  reader.close();
                  return false;
                }
              : undefined,
        });
        db.stats.recoveryDurationMs += performance.now() - recT0;
        db.stats.recoveryBytes += db.recoveryInfo.snapshotBytes + db.recoveryInfo.walBytes;
        db.stats.recoveryFrames += db.recoveryInfo.snapshotFrames + db.recoveryInfo.walFrames;
        // Recovery may have truncated a torn WAL tail behind the WAL's back;
        // re-sync its size bookkeeping so later appends (and their disk-mode
        // value pointers) are computed against the real, truncated file size.
        if (db.recoveryInfo.truncatedWal) await db.wal.refreshSize();
        db.seedAccessFromStore();
        await db.rebuildAllIndexes();
      }

      // A read-only instance never compacts: rotation would rename the live
      // writer's snapshot/WAL out from under it and lose its acknowledged data.
      // The writer's open-time compaction is fire-and-forget (same as
      // maybeAutoCompact): recovery already applied the full WAL, so the db is
      // complete and consistent the moment open() returns. Awaiting the
      // compaction here blocked open() on the whole snapshot rewrite + text
      // postings rebuild — tens of seconds of stalled startup on a large db.
      if (!db.readOnly && db.autoCompact && shouldCompact(db)) compact(db).catch(() => {});
      // Background generation build (fire-and-forget, like the compaction
      // kick). Two triggers: (a) the legacy path served the open and there is
      // data worth checkpointing — no (usable) generation exists; (b) a
      // generation served the open but its checkpoint is far behind (the WAL
      // delta replay was the dominant cost) — refresh it so the NEXT open is
      // cheap again. An empty store is never worth a build (an empty
      // generation would just force every later open to replay the whole WAL
      // through the per-op path before anything refreshes it).
      if (!db.readOnly && db.indexGenerationsEnabled) {
        const gen = db.recoveryInfo?.indexGeneration;
        const deltaOps = db.recoveryInfo?.walDeltaAppliedOps ?? 0;
        const deltaBytes = gen ? db.recoveryInfo!.walScanEnd - gen.walCheckpoint : 0;
        const stale = gen !== undefined && (deltaOps > GEN_BUILD_WAL_DELTA_OPS || deltaBytes > GEN_BUILD_WAL_DELTA_BYTES);
        if ((!generationLoaded && db.size > 0) || stale) {
          void db.buildGeneration('open').catch(() => {});
        }
      }
    } catch (err) {
      // A background open-time compaction may still be in flight: settle it
      // before tearing down the WAL/store/handles it touches.
      if (db.compacting && db._compactDone) await db._compactDone.catch(() => {});
      // Release every resource acquired so far: an open that fails after the
      // WAL/store are set up must not leak a file handle or keep the everysec /
      // active-expire timers running. Text indexes are closed too: a
      // generation load may have attached postings handles before a later
      // step failed (rebuildAllIndexes' builds likewise).
      for (const ti of db.text.values()) ti.close();
      if (db.wal) await db.wal.close().catch(() => {});
      db.valueReader?.close();
      db.store?.close();
      if (db.lock) {
        await db.lock.release().catch(() => {});
        db.lock = null;
      }
      // Tag failures of a read-only open (requested OR degraded via
      // onLockFail:'readonly'): the instance never owned the directory, so
      // openOrRebuild must not "rebuild" (delete) anything in it — it rethrows
      // instead of touching a live writer's files (lock-review repro).
      if (db.readOnly && err && typeof err === 'object') (err as { readOnlyOpen?: boolean }).readOnlyOpen = true;
      throw err;
    }
    return db;
  }

  /**
   * Open a database, and if opening fails due to corruption (not due to a live
   * lock), delete the directory and open a fresh empty database. Recommended for
   * a rebuildable cache. A live lock is rethrown.
   *
   * The destructive rebuild only ever runs for an open that could OWN the
   * directory: an error tagged `readOnlyOpen` (opts.readOnly, or a lock that
   * degraded via onLockFail:'readonly') is rethrown untouched — rebuilding
   * means deleting files, and a read-only bystander must never mutate a live
   * writer's directory (lock-review repro: the readonly fallback deleted the
   * writer's sidecar, and in the strict-recovery shape the whole directory).
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
      if ((err as { readOnlyOpen?: boolean }).readOnlyOpen) throw err;
      if (hooks.onRebuild) hooks.onRebuild(err);
      if (err instanceof SyntaxError) {
        // A corrupted index-definition sidecar holds only derived metadata and
        // must not cost the whole database: drop the sidecars (indexes can be
        // recreated by the caller) and retry once before falling back to a
        // full rebuild. If the SyntaxError came from the data files themselves
        // (e.g. a corrupt frame meta), the retry fails the same way and the
        // full rebuild below runs anyway.
        try {
          for (const f of SIDECAR_FILES) {
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

  /** On-disk postings file path for a text index (root location — the legacy
   *  pre-generation home; the name sanitization lives in generation.ts). */
  private textPostingsPath(name: string): string {
    return path.join(this.dir, rootPostingsFile(name));
  }

  /** LEGACY postings maintenance (indexGenerations: false): rebuild every
   *  dirty text index's on-disk postings from the live Store. With
   *  generations enabled this whole job is superseded by the generation
   *  build (the staged text builds + clean re-publish), so it only runs on
   *  the legacy onCompacted path. Drops the in-memory delta + tombstones and
   *  reclaims orphaned postings records — postings are pure derived state,
   *  so this is only for space/latency, never for correctness. Indexes with
   *  an empty write buffer are skipped: a fresh base must not be redone. */
  private async rebuildTextPostings(): Promise<void> {
    for (const [name, ti] of this.text) {
      // Skip indexes staged for drop (see textDrops): their postings are
      // about to be removed, and a build committing after the drop's
      // close+rm would re-create the file as an orphan and leak the reopened
      // handle. The mark check and ti.build()'s synchronous beginBuild() are
      // one tick apart at most — see dropTextIndex for why that is safe.
      if (this.textDrops.has(name)) continue;
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

  // ---- persistent index generations (stage 5) ------------------------------
  //
  // The writer periodically checkpoints every piece of derived state into an
  // atomically published generation (see generation.ts for the layout and the
  // crash protocol). Build triggers: after each compaction rotation (the
  // onCompacted hook — the rotation and the generation are one transaction),
  // in the background after an open that found no usable generation, and the
  // explicit rebuildGeneration() maintenance call. The build walks the live
  // store into DETACHED index states (fresh IndexManager / DtIndex /
  // CompoundIndexManager instances, plus staged TextIndex builds whose commit
  // also rebases the live index) while applyOp feeds every concurrent write
  // into a queue; a final synchronous drain + WAL watermark capture seals the
  // exact checkpoint. The load path (tryLoadGeneration) validates the
  // manifest, loads the images whose definition hashes still match, rebuilds
  // only the affected indexes for mismatches, and replays just the WAL delta
  // — open cost follows the WAL delta + index metadata, not the full corpus.

  /** The canonical definition shape a text index's manifest hash is computed
   *  from (both sides use it, so a legacy definition without `tokenizer`
   *  hashes identically to an explicit 'default'). */
  private static canonicalTextDef(d: TextIndexDef): { name: string; fields: readonly string[] | null; tokenizer: string } {
    return { name: d.name, fields: d.fields, tokenizer: d.tokenizer ?? 'default' };
  }

  /** Read the store image / index images of one published generation and
   *  replay the WAL past its checkpoint. Throws GenerationCorruptError for
   *  every validation/consistency failure (the caller falls back); genuine
   *  system errors propagate. On success the instance is fully recovered —
   *  store, every derived index, recoveryInfo, value reader. */
  private async loadOneGeneration(id: string, mode: RecoveryMode): Promise<void> {
    const genDir = generationDir(this.dir, id);
    const manifest = await readManifest(this.dir, id);
    if (manifest.valueCodec !== this.codecName) {
      throw new GenerationCorruptError(`codec mismatch (${manifest.valueCodec} != ${this.codecName})`);
    }
    if (manifest.valueMode !== this.valueMode) {
      throw new GenerationCorruptError(`value mode mismatch (${manifest.valueMode} != ${this.valueMode})`);
    }
    const cp = manifest.checkpoint;
    // WAL anchor: the checkpoint offset only has meaning on the exact inode
    // the build measured, and the file must still reach it.
    const walSt = await fs.stat(this.walPath).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (!walSt || walSt.dev !== cp.walDev || walSt.ino !== cp.walIno || walSt.size < cp.walOffset) {
      throw new GenerationCorruptError('WAL anchor mismatch (rotated or truncated since the build)');
    }
    // Disk mode: image refs point into the generation's snapshot, which the
    // live db.snapshot still aliases (hard link) — verify the identity.
    if (this.valueMode === 'disk' && cp.snapshotIno !== 0) {
      if (!cp.snapshotLinked) throw new GenerationCorruptError('snapshot not hard-linked; disk refs unservable');
      const snapSt = await fs.stat(path.join(this.dir, SNAPSHOT_FILE)).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (!snapSt || snapSt.dev !== cp.snapshotDev || snapSt.ino !== cp.snapshotIno) {
        throw new GenerationCorruptError('snapshot anchor mismatch (rotated since the build)');
      }
    }
    // Disk mode: attach the positioned reader NOW, before anything reads a
    // value back — the image's refs and the WAL-delta replay both resolve
    // through it (mirrors the legacy recovery's attach check).
    if (this.valueMode === 'disk') {
      const reader = new ValueReader(this.dir);
      let ids: ReturnType<ValueReader['open']>;
      try {
        ids = reader.open();
      } catch (e) {
        reader.close();
        throw e;
      }
      const walOk = ids.wal !== null && ids.wal.dev === cp.walDev && ids.wal.ino === cp.walIno;
      const snapOk =
        cp.snapshotIno === 0
          ? true // the build had no snapshot; the image can carry no snapshot refs
          : ids.snapshot !== null && ids.snapshot.dev === cp.snapshotDev && ids.snapshot.ino === cp.snapshotIno;
      if (!walOk || !snapOk) {
        reader.close();
        throw new GenerationCorruptError('value reader attach raced a rotation');
      }
      this.valueReader = reader;
    }

    // Store image. Records expire-past at load time are dropped here AND
    // noted, so their loaded index entries can be reconciled below (the
    // image legitimately contains records whose TTL elapsed after the build).
    const storeInfo = manifest.files[STORE_IMAGE_FILE];
    if (!storeInfo) throw new GenerationCorruptError('store image missing from manifest');
    const storePayload = await readGenerationFileChecked(path.join(genDir, STORE_IMAGE_FILE), 'MDGS', STORE_VERSION, storeInfo);
    const now = Date.now();
    const droppedExpired: string[] = [];
    const records: StoreImageRecord[] = [];
    let imageCount = 0;
    for (const rec of readStoreImage(storePayload)) {
      imageCount++;
      if (rec.expireAt && rec.expireAt <= now) {
        droppedExpired.push(rec.kstr);
        continue;
      }
      if (this.valueMode === 'memory' && rec.ref.kind !== 'memory') {
        throw new GenerationCorruptError('store image carries disk refs for a memory-mode open');
      }
      records.push(rec);
    }
    this.store.bulkLoadRefs(records);
    if (manifest.counts && typeof manifest.counts.records === 'number' && manifest.counts.records !== imageCount) {
      throw new GenerationCorruptError(`store image record count mismatch (${imageCount} != ${manifest.counts.records})`);
    }

    // Derived-index images. Every failure here is LOCAL: a corrupt or missing
    // image rebuilds exactly the affected index(es) from the loaded store.
    await this.loadDtImage(genDir, manifest);
    await this.loadSecondaryImages(genDir, manifest);
    await this.loadCompoundImages(genDir, manifest);
    await this.loadTextImages(genDir, manifest);

    // Reconcile the expired-at-load drops out of the loaded index states.
    for (const k of droppedExpired) {
      this.dt.del(k);
      this.indexes.remove(k, undefined);
      this.compound.remove(k);
      for (const ti of this.text.values()) ti.remove(k);
    }

    // Replay the WAL delta past the checkpoint with the exact same per-frame
    // interpretation the legacy recovery uses (frameToOps), maintaining every
    // derived index incrementally (applyRecoveredOp).
    const replay = await this.replayWalDelta(cp.walOffset, mode);
    // A rotation racing the load invalidates the coordinate system the
    // recoveryInfo below is anchored to (and, in disk mode, the value reader
    // attached above) — reject the candidate.
    const walAfter = await fs.stat(this.walPath).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (!walAfter || walAfter.dev !== cp.walDev || walAfter.ino !== cp.walIno) {
      throw new GenerationCorruptError('WAL rotated during generation load');
    }

    this.recoveryInfo = {
      snapshotFrames: records.length,
      walFrames: replay.walFrames,
      snapshotBytes: storeInfo.bytes,
      walBytes: walSt.size,
      truncatedWal: replay.truncatedWal,
      corruptRanges: replay.corruptRanges,
      snapshotCorruptRanges: [],
      lostBytes: replay.corruptRanges.reduce((a, [s, e]) => a + (e - s), 0),
      walScanEnd: replay.walScanEnd,
      walDev: cp.walDev,
      walIno: cp.walIno,
      snapshotDev: cp.snapshotDev,
      snapshotIno: cp.snapshotIno,
      corruptBatches: replay.corruptBatches,
      generationRetries: 0,
      indexGeneration: { id, walCheckpoint: cp.walOffset, records: records.length },
      walDeltaAppliedOps: replay.appliedOps,
    };
    this.generationInfo = { id, createdAt: manifest.createdAt, walCheckpoint: cp.walOffset, records: records.length };
    this.seedAccessFromStore();
  }

  /** Undo any partial state a failed generation-load candidate left behind,
   *  so the next candidate (or the legacy full recovery) starts clean: the
   *  store must be empty (recovery replays into it), the value reader
   *  detached, and any postings handles the candidate attached closed (the
   *  next path re-attaches or rebuilds as needed). */
  private resetAfterFailedGenerationLoad(): void {
    for (const k of this.store.map.keys()) this.store.del(k);
    this.valueReader?.close();
    this.valueReader = undefined;
    for (const ti of this.text.values()) ti.close();
  }

  /** The generation-load entry point from open(): try CURRENT's generation
   *  first, then the previous ones (their WAL anchor survives whenever no
   *  compaction intervened). Corruption-class failures try the next
   *  candidate; genuine system errors propagate. Returns false when no
   *  candidate loaded (the caller runs the legacy full recovery). */
  private async tryLoadGeneration(mode: RecoveryMode): Promise<boolean> {
    const t0 = performance.now();
    const candidates: string[] = [];
    try {
      const current = await readCurrent(this.dir);
      if (current) candidates.push(current);
      for (const g of await listGenerations(this.dir)) {
        if (!g.tmp && g.id !== current && candidates.length < 3) candidates.push(g.id);
      }
    } catch (e) {
      this.stats.generationLoadFallbacks++;
      this.stats.lastGenerationFallback = `list: ${(e as Error).message}`;
      return false;
    }
    for (const id of candidates) {
      try {
        await this.loadOneGeneration(id, mode);
        this.stats.generationLoads++;
        this.stats.generationLoadDurationMs += performance.now() - t0;
        return true;
      } catch (e) {
        if (!(e instanceof GenerationCorruptError) && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        this.stats.generationLoadFallbacks++;
        this.stats.lastGenerationFallback = `${id}: ${(e as Error).message}`;
        this.resetAfterFailedGenerationLoad();
      }
    }
    return false;
  }

  /** Load the dt image; rebuild the (cheap, metadata-only) dt index from the
   *  loaded store when the image is absent/corrupt. */
  private async loadDtImage(genDir: string, manifest: GenerationManifest): Promise<void> {
    const info = manifest.files[DT_INDEX_FILE];
    if (info) {
      try {
        const payload = await readGenerationFileChecked(path.join(genDir, DT_INDEX_FILE), 'MDGD', 1, info);
        this.dt.loadImage(readDtIndexImage(payload));
        return;
      } catch (e) {
        if (!(e instanceof GenerationCorruptError)) throw e;
      }
    }
    this.stats.generationIndexRebuilds++;
    const store = this.store;
    this.dt.rebuild(
      (function* (): Generator<{ key: string; dt: Record<string, number> | null }> {
        for (const rec of store.rawRecords()) yield { key: rec.kstr, dt: rec.dt };
      })(),
    );
  }

  /** Load secondary-index images for definitions whose hash still matches;
   *  rebuild exactly the affected indexes otherwise (plan: only the affected
   *  index is rebuilt, never the whole registry). */
  private async loadSecondaryImages(genDir: string, manifest: GenerationManifest): Promise<void> {
    const live = this.indexes.list();
    if (live.length === 0) return;
    let images: Map<string, ReturnType<typeof readSecondaryIndexImage>[number]> | null = null;
    const info = manifest.files[SECONDARY_INDEX_FILE];
    if (info) {
      try {
        const payload = await readGenerationFileChecked(path.join(genDir, SECONDARY_INDEX_FILE), 'MDSI', 1, info);
        images = new Map(readSecondaryIndexImage(payload).map((i) => [i.name, i]));
      } catch (e) {
        if (!(e instanceof GenerationCorruptError)) throw e;
      }
    }
    for (const def of live) {
      const image = images?.get(def.name);
      if (image && manifest.indexDefs.secondary[def.name] === indexDefHash(def)) {
        try {
          this.indexes.loadImage(image);
          continue;
        } catch {
          /* shape mismatch: rebuild below */
        }
      }
      this.stats.generationIndexRebuilds++;
      this.rebuildOneSecondaryIndex(def);
    }
  }

  private rebuildOneSecondaryIndex(def: IndexInfo): void {
    const fresh = new IndexManager();
    fresh.create(def.name, def);
    for (const { key, value } of this._liveRecordsRaw()) {
      if (this.indexable(value)) fresh.add(this.pk(key), value);
    }
    this.indexes.indexes.set(def.name, fresh.indexes.get(def.name)!);
  }

  /** Load compound-index images (same per-index discipline as secondary). */
  private async loadCompoundImages(genDir: string, manifest: GenerationManifest): Promise<void> {
    const live = this.compound.list();
    if (live.length === 0) return;
    let images: Map<string, ReturnType<typeof readCompoundIndexImage>[number]> | null = null;
    const info = manifest.files[COMPOUND_INDEX_FILE];
    if (info) {
      try {
        const payload = await readGenerationFileChecked(path.join(genDir, COMPOUND_INDEX_FILE), 'MDCI', 1, info);
        images = new Map(readCompoundIndexImage(payload).map((i) => [i.name, i]));
      } catch (e) {
        if (!(e instanceof GenerationCorruptError)) throw e;
      }
    }
    for (const def of live) {
      const image = images?.get(def.name);
      if (image && manifest.indexDefs.compound[def.name] === indexDefHash(def)) {
        try {
          this.compound.loadImage(image);
          continue;
        } catch {
          /* shape mismatch: rebuild below */
        }
      }
      this.stats.generationIndexRebuilds++;
      this.rebuildOneCompoundIndex(def);
    }
  }

  private rebuildOneCompoundIndex(def: CompoundIndexInfo): void {
    const fresh = new CompoundIndexManager();
    fresh.create(def.name, { groupBy: def.groupBy, orderBy: def.orderBy, orderType: def.orderType });
    for (const { key, value, dt } of this.liveRecords()) {
      fresh.add(this.pk(key), value, dt);
    }
    this.compound.indexes.set(def.name, fresh.indexes.get(def.name)!);
  }

  /** Load text-index images (dictionary + docs + postings attachment) for
   *  definitions whose hash still matches; rebuild exactly the affected
   *  indexes otherwise — a rebuild is the full corpus tokenization for that
   *  one index, the cost stage 5 exists to avoid on the happy path. */
  private async loadTextImages(genDir: string, manifest: GenerationManifest): Promise<void> {
    for (const def of this.textDefs) {
      const ti = this.text.get(def.name);
      if (!ti) continue;
      const dictInfo = manifest.files[textDictionaryFile(def.name)];
      const docsInfo = manifest.files[textDocsFile(def.name)];
      const postingsInfo = manifest.files[textPostingsFile(def.name)];
      let attached = false;
      if (dictInfo && docsInfo && postingsInfo && manifest.indexDefs.text[def.name] === indexDefHash(MiniDb.canonicalTextDef(def))) {
        try {
          const dictPayload = await readGenerationFileChecked(path.join(genDir, textDictionaryFile(def.name)), 'MDTD', 1, dictInfo);
          const docsPayload = await readGenerationFileChecked(path.join(genDir, textDocsFile(def.name)), 'MDTC', 1, docsInfo);
          // The postings file carries the base every search reads: verify it
          // wholesale against the manifest NOW (one streaming crc pass), so a
          // corrupt base is rebuilt at open instead of failing a query later
          // (its per-record CRCs would only trip on the first read).
          const postingsPath = path.join(genDir, textPostingsFile(def.name));
          verifyFileIntegritySync(postingsPath, postingsInfo);
          const dict = new Map(readTextDictionaryImage(dictPayload).map((e) => [e.term, { off: e.off, len: e.len, df: e.df }]));
          const docs = readTextDocsImage(docsPayload);
          const docLens = new Map<number, number>();
          for (let i = 0; i < docs.docLens.length; i++) {
            const len = docs.docLens[i];
            if (len !== undefined) docLens.set(i, len);
          }
          ti.attachImage({
            postingsPath,
            dict,
            keys: docs.keys,
            docLens,
            liveCount: docs.liveCount,
            removed: new Set(docs.removed),
            delta: new Map(docs.delta.map((d) => [d.term, new Map(d.docs.map((x) => [x.docID, x.freq] as [number, number]))])),
          });
          // Carry the integrity record forward: a later CLEAN fast-path build
          // re-publishes this unchanged file without re-reading it.
          ti.postingsFileInfo = { bytes: postingsInfo.bytes, crc32: postingsInfo.crc32 };
          attached = true;
        } catch (e) {
          if (!(e instanceof GenerationCorruptError) && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
      if (!attached) {
        this.stats.generationIndexRebuilds++;
        await ti.build(this.textRecords());
      }
    }
  }

  /** Replay WAL frames at/after `startOffset` onto the loaded store (and
   *  every derived index), with the legacy recovery's torn-tail handling:
   *  a corrupt tail is truncated by the writer, left alone read-only. */
  private async replayWalDelta(
    startOffset: number,
    mode: RecoveryMode,
  ): Promise<{
    walFrames: number;
    walScanEnd: number;
    corruptRanges: [number, number][];
    truncatedWal: boolean;
    corruptBatches: number;
    appliedOps: number;
  }> {
    const fd = fsSync.openSync(this.walPath, 'r');
    try {
      const st = fsSync.fstatSync(fd);
      const r = scanFrameRefsFd(fd, { onCorrupt: mode, startOffset });
      let corruptBatches = 0;
      let appliedOps = 0;
      for (const f of r.frames) {
        for (const op of frameToOps(f, 'wal', fd, this.valueMode, () => corruptBatches++)) {
          this.applyRecoveredOp(op);
          appliedOps++;
        }
      }
      let truncatedWal = false;
      const last = r.corruptRanges[r.corruptRanges.length - 1];
      if (last && last[1] === st.size && !this.readOnly) {
        await fs.truncate(this.walPath, last[0]);
        truncatedWal = true;
        await this.wal.refreshSize();
      }
      return { walFrames: r.frames.length, walScanEnd: r.eofOffset, corruptRanges: r.corruptRanges, truncatedWal, corruptBatches, appliedOps };
    } finally {
      fsSync.closeSync(fd);
    }
  }

  /** Single-flight generation build entry point. 'open' dedupes onto an
   *  in-flight build; 'compact'/'manual' await the in-flight one (a rotation
   *  or their own trigger just made it abort) and then build fresh. */
  private async buildGeneration(trigger: 'open' | 'compact' | 'manual'): Promise<void> {
    if (this.readOnly || !this.indexGenerationsEnabled) return;
    if (this.state !== 'open') return;
    if (this.genBuildPromise) {
      if (trigger === 'open') return this.genBuildPromise;
      await this.genBuildPromise.catch(() => {});
    }
    const run = this.runGenerationBuild();
    this.genBuildPromise = run;
    try {
      await run;
    } finally {
      if (this.genBuildPromise === run) this.genBuildPromise = null;
    }
  }

  /** The build itself: detached-state walk + mutation queue + seal + file
   *  writes + atomic publish, then retention cleanup. See the section header. */
  private async runGenerationBuild(): Promise<void> {
    const t0 = performance.now();
    const gens = generationsDir(this.dir);
    const prevCurrent = await readCurrent(this.dir);
    const existing = await listGenerations(this.dir);
    const nextN = Math.max(prevCurrent ? (existing.find((g) => g.id === prevCurrent)?.n ?? 0) : 0, existing[0]?.n ?? 0) + 1;
    const id = generationId(nextN);
    const tmpName = `${id}.tmp-${process.pid}`;
    const tmpDir = path.join(gens, tmpName);

    const gb = { queue: [] as GenBuildOp[], bytes: 0, wal: this.wal, aborted: false };
    // Detached derived states (never touched by the live write paths).
    const dtB = new DtIndex();
    const secB = new IndexManager();
    for (const d of this.indexes.list()) secB.create(d.name, d);
    const cmpB = new CompoundIndexManager();
    for (const d of this.compound.list()) cmpB.create(d.name, { groupBy: d.groupBy, orderBy: d.orderBy, orderType: d.orderType });
    const imageRecords = new Map<string, { ref: ValueRef; expireAt: number; dt: Record<string, number> | null }>();
    const textBuilds = new Map<string, { ti: TextIndex; b: TextIndexBuild }>();
    /** Clean text indexes (empty write buffer): no staged rebuild — the
     *  current base is re-published wholesale (hard link + live-state
     *  serialization), the generation-era form of the old needsRebuild skip.
     *  A compaction over a static corpus therefore never re-tokenizes it. */
    const textClean = new Map<string, TextIndex>();

    const drainQueue = (): void => {
      if (gb.queue.length === 0) return;
      const ops = gb.queue.splice(0, gb.queue.length);
      gb.bytes = 0;
      for (const op of ops) {
        if (op.type === TYPE_SET) {
          imageRecords.set(op.pk, { ref: { kind: 'memory', value: op.value! }, expireAt: op.expireAt, dt: op.dtNorm });
          dtB.set(op.pk, op.dtNorm);
          if (!op.storeOnly) {
            secB.remove(op.pk, undefined);
            if (this.indexable(op.canonical)) secB.add(op.pk, op.canonical);
            cmpB.remove(op.pk);
            cmpB.add(op.pk, op.canonical, op.dtNorm);
          }
        } else {
          imageRecords.delete(op.pk);
          dtB.del(op.pk);
          secB.remove(op.pk, undefined);
          cmpB.remove(op.pk);
        }
      }
    };

    const checkAlive = (): void => {
      if (gb.aborted) throw new GenerationBuildAborted('store rewound by a WAL rollback');
      if (this.wal !== gb.wal) throw new GenerationBuildAborted('compaction rotation replaced the WAL');
      if (this.state !== 'open') throw new GenerationBuildAborted('instance is closing');
      if (gb.queue.length > GEN_BUILD_QUEUE_CAP || gb.bytes > GEN_BUILD_QUEUE_BYTES_CAP) {
        throw new GenerationBuildAborted('write storm outran the build');
      }
    };

    const files: Record<string, { bytes: number; crc32: number }> = {};
    let sealedOffset = 0;
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      // Staged text builds register their build queues FIRST, so every write
      // in the window is captured for the swap-time replay (existing
      // TextIndex machinery). An index that cannot start a build (one already
      // in flight, e.g. a concurrent createTextIndex) is excluded from the
      // image — the loader rebuilds it. A CLEAN index (empty delta, no
      // tombstones) skips the staged rebuild entirely: its unchanged base is
      // re-published by link below.
      for (const [name, ti] of this.text) {
        try {
          if (!ti.needsRebuild()) {
            textClean.set(name, ti);
            continue;
          }
          textBuilds.set(name, { ti, b: ti.beginBuild({ postingsPath: path.join(tmpDir, textPostingsFile(name)) }) });
        } catch {
          /* excluded from this generation */
        }
      }
      // Register the mutation queue only AFTER the staged builds exist, so
      // queued ops and staged text builds cover the same window.
      this.genBuild = gb;

      // Phase 1: walk the live store into the detached states. Sorted keys
      // (the store's ordered index), so the store image is written in
      // bulk-load order without a later sort.
      let docsSinceYield = 0;
      let tokensSinceYield = 0;
      const needValues = secB.indexes.size > 0 || cmpB.indexes.size > 0 || textBuilds.size > 0;
      for (const kstr of this.store.rawKeys()) {
        const rec = this.store.map.get(kstr);
        if (!rec) continue;
        imageRecords.set(kstr, { ref: rec.ref, expireAt: rec.expireAt, dt: rec.dt });
        dtB.set(kstr, rec.dt);
        if (needValues) {
          const buf = rec.ref.kind === 'memory' ? rec.ref.value : this.valueReader!.read(rec.ref.loc);
          const doc = this.decode(buf);
          if (this.indexable(doc)) {
            secB.add(kstr, doc);
            for (const { b } of textBuilds.values()) tokensSinceYield += b.add(kstr, doc);
          }
          cmpB.add(kstr, doc, rec.dt);
        }
        if (++docsSinceYield >= REBUILD_YIELD_DOCS || tokensSinceYield >= 500_000) {
          docsSinceYield = 0;
          tokensSinceYield = 0;
          drainQueue();
          checkAlive();
          await yieldToLoop();
        }
      }

      // Seal: the final drain, the liveness check, the queue cutoff, and the
      // WAL watermark read form ONE synchronous segment — no op can interleave,
      // so the image equals replaying every frame below the checkpoint exactly.
      drainQueue();
      checkAlive();
      this.genBuild = null;
      sealedOffset = gb.wal.appendOffset;

      // Phase 2: commit the staged text builds — each writes its postings file
      // into the tmp dir, swaps the LIVE base onto it (the compaction-time
      // rebase that replaces rebuildTextPostings), and replays its queue.
      const textStates = new Map<string, ReturnType<TextIndex['exportImageState']>>();
      for (const [name, tb] of textBuilds) {
        await tb.b.commit();
        textStates.set(name, tb.ti.exportImageState());
        checkAlive();
      }
      // Clean indexes: serialize the live state as-is and re-publish the
      // unchanged postings file by hard link (copy fallback). The manifest
      // reuses the integrity record from the build that WROTE the file (it is
      // immutable until replaced, so the record is still exact) — no
      // re-tokenization, no re-read.
      const cleanPostings = new Map<string, { src: string; info: { bytes: number; crc32: number } }>();
      for (const [name, ti] of textClean) {
        const src = ti.currentPostingsPath;
        const info = ti.postingsFileInfo;
        if (src && info) {
          cleanPostings.set(name, { src, info });
          textStates.set(name, ti.exportImageState());
        }
        // else: cannot re-publish safely (memory base / unknown integrity) —
        // omit from the image; the loader rebuilds that index.
      }

      // Phase 3: write every image file (fsynced individually by the writers).
      // The store image is written in ascending key order (the load path
      // bulk-builds the ordered index from file order): the walk's keys were
      // already sorted, but queue-applied keys appended out of order.
      const sortedImageKeys = [...imageRecords.keys()].sort();
      const storeRes = await writeStoreImage(
        path.join(tmpDir, STORE_IMAGE_FILE),
        (function* (): Generator<StoreImageRecord> {
          for (const kstr of sortedImageKeys) {
            const r = imageRecords.get(kstr)!;
            yield { kstr, ref: r.ref, expireAt: r.expireAt, dt: r.dt };
          }
        })(),
      );
      files[STORE_IMAGE_FILE] = { bytes: storeRes.bytes, crc32: storeRes.crc32 };
      files[DT_INDEX_FILE] = await writeDtIndexImage(path.join(tmpDir, DT_INDEX_FILE), dtB.exportImage());
      const secImages = secB.exportImage();
      files[SECONDARY_INDEX_FILE] = await writeSecondaryIndexImage(path.join(tmpDir, SECONDARY_INDEX_FILE), secImages);
      const cmpExport = cmpB.exportImage();
      files[COMPOUND_INDEX_FILE] = await writeCompoundIndexImage(path.join(tmpDir, COMPOUND_INDEX_FILE), cmpExport.images);
      for (const [name, state] of textStates) {
        files[textDictionaryFile(name)] = await writeTextDictionaryImage(
          path.join(tmpDir, textDictionaryFile(name)),
          (function* (): Generator<{ term: string; off: number; len: number; df: number }> {
            for (const [term, e] of state.dict) yield { term, off: e.off, len: e.len, df: e.df };
          })(),
        );
        const docsImage: TextDocsImage = {
          keys: state.keys,
          docLens: (() => {
            const out: (number | undefined)[] = [];
            for (let i = 0; i < state.keys.length; i++) out.push(state.docLens.get(i));
            return out;
          })(),
          liveCount: state.liveCount,
          removed: [...state.removed],
          delta: [...state.delta].map(([term, m]) => ({
            term,
            docs: [...m].map(([docID, freq]) => ({ docID, freq })),
          })),
        };
        files[textDocsFile(name)] = await writeTextDocsImage(path.join(tmpDir, textDocsFile(name)), docsImage);
        const clean = cleanPostings.get(name);
        if (clean) {
          // Re-publish the unchanged base: hard link (same inode, zero copy),
          // copy fallback — carrying the original integrity record.
          const dst = path.join(tmpDir, textPostingsFile(name));
          try {
            await fs.link(clean.src, dst);
          } catch {
            await fs.copyFile(clean.src, dst);
          }
          files[textPostingsFile(name)] = clean.info;
        } else {
          const postInfo = textBuilds.get(name)?.ti.postingsFileInfo;
          if (!postInfo) throw new GenerationBuildAborted(`text index "${name}" produced no postings file info`);
          files[textPostingsFile(name)] = postInfo;
        }
      }

      // The generation's own snapshot reference: a hard link to the live
      // db.snapshot (same inode, zero copy — later rotations rename the path
      // away and the generation keeps the inode), falling back to a full copy
      // on filesystems without links (manifest records which; disk-mode loads
      // require the link).
      const snapSrc = path.join(this.dir, SNAPSHOT_FILE);
      let snapSt: fsSync.Stats | null = null;
      let snapshotLinked = false;
      try {
        snapSt = await fs.stat(snapSrc);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (snapSt) {
        try {
          await fs.link(snapSrc, path.join(tmpDir, GEN_SNAPSHOT_FILE));
          snapshotLinked = true;
        } catch {
          await fs.copyFile(snapSrc, path.join(tmpDir, GEN_SNAPSHOT_FILE));
          const h = await fs.open(path.join(tmpDir, GEN_SNAPSHOT_FILE), 'r');
          try {
            await h.sync();
          } finally {
            await h.close().catch(() => {});
          }
        }
      }
      const walSt = await fs.stat(this.walPath);

      // The manifest hashes exactly the indexes this image carries (a
      // definition created/dropped mid-build is simply absent — the loader
      // rebuilds or ignores it).
      const manifest: GenerationManifest = {
        format: GENERATION_FORMAT_VERSION,
        id,
        createdAt: Date.now(),
        valueCodec: this.codecName,
        valueMode: this.valueMode,
        checkpoint: {
          walOffset: sealedOffset,
          walDev: walSt.dev,
          walIno: walSt.ino,
          walSize: sealedOffset,
          snapshotBytes: snapSt?.size ?? 0,
          snapshotDev: snapSt?.dev ?? 0,
          snapshotIno: snapSt?.ino ?? 0,
          snapshotLinked,
        },
        indexDefs: {
          secondary: Object.fromEntries(
            secImages.map((i) => [
              i.name,
              indexDefHash({ name: i.name, field: i.field, type: i.type, unique: i.unique, sparse: i.sparse }),
            ]),
          ),
          compound: Object.fromEntries(
            cmpExport.images.map((i) => [i.name, indexDefHash({ name: i.name, groupBy: i.groupBy, orderBy: i.orderBy, orderType: i.orderType })]),
          ),
          text: Object.fromEntries(
            [...textStates.keys()].map((name) => {
              const def = this.textDefs.find((d) => d.name === name);
              return [name, def ? indexDefHash(MiniDb.canonicalTextDef(def)) : ''];
            }),
          ),
        },
        files,
        counts: {
          records: imageRecords.size,
          dtColumns: dtB.columns().length,
          secondaryIndexes: secImages.length,
          compoundIndexes: cmpExport.images.length,
          textIndexes: textStates.size,
        },
      };
      checkAlive();
      await writeManifest(tmpDir, manifest);
      await fsyncDir(tmpDir, { strict: true, stats: this.stats });
      // Windows cannot rename a directory with open files inside: the
      // committed bases' live handles sit in the tmp dir, so close them first
      // (repointPostings reopens at the final path below). POSIX keeps the
      // handles valid across the rename — no close needed there.
      if (process.platform === 'win32') {
        for (const [, tb] of textBuilds) tb.ti.close();
      }
      await publishGeneration(this.dir, tmpName, id, { stats: this.stats });
      // Repoint EVERY live base this build (re)published into the CURRENT
      // generation: staged commits still read the (now renamed) tmp path, and
      // clean re-publishes still read their OLD location (the root file — or
      // a previous generation's — both about to be reclaimed below). Without
      // this the next clean fast path links from a deleted path and fails
      // ENOENT forever. The invariant after publish: every live text base
      // reads from inside the CURRENT generation. POSIX: same inode (the
      // hard link), just update the path string; win32: close + reopen there.
      for (const [name, tb] of textBuilds) {
        tb.ti.repointPostings(path.join(generationDir(this.dir, id), textPostingsFile(name)));
      }
      for (const [name, ti] of textClean) {
        if (cleanPostings.has(name)) ti.repointPostings(path.join(generationDir(this.dir, id), textPostingsFile(name)));
      }

      this.generationInfo = { id, createdAt: manifest.createdAt, walCheckpoint: sealedOffset, records: imageRecords.size };
      this.stats.generationBuilds++;
      this.stats.generationBuildDurationMs += performance.now() - t0;

      // Retention: keep the new and the previously-published generation; sweep
      // everything else (stray tmp dirs included). Best-effort, async.
      const keep = new Set(prevCurrent ? [id, prevCurrent] : [id]);
      void cleanupGenerations(this.dir, keep).catch(() => {});
      // The live text bases now live inside the new generation: the legacy
      // root postings files are superseded derived state — reclaim them.
      for (const name of textStates.keys()) {
        await fs.rm(this.textPostingsPath(name), { force: true }).catch(() => {});
      }
    } catch (e) {
      if (this.genBuild === gb) this.genBuild = null;
      // Uncommitted staged builds only disarm their queues (the live indexes
      // stay authoritative); committed ones keep their new base — its
      // postings file stays readable through the open fd even though the
      // stranded tmp dir is swept at the next open (POSIX; on Windows the
      // sweep fails best-effort until the handle closes).
      for (const [, tb] of textBuilds) tb.b.abort();
      if (e instanceof GenerationBuildAborted) {
        this.stats.generationBuildAborts++;
        return;
      }
      this.stats.generationBuildErrors++;
      throw e;
    } finally {
      if (this.genBuild === gb) this.genBuild = null;
      void sealedOffset;
    }
  }

  /** Explicit maintenance (stage 5): build + publish a fresh index generation
   *  now. Writer only. The load path is automatic; this exists for operators
   *  who want to force a checkpoint after a large burst of writes instead of
   *  waiting for the next compaction. */
  async rebuildGeneration(): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    if (!this.indexGenerationsEnabled) throw new Error('index generations are disabled (OpenOptions.indexGenerations: false)');
    await this.buildGeneration('manual');
  }

  /** Stable generation status: the generation this instance loaded at open or
   *  last published (null when running on the legacy recovery path). */
  getIndexGeneration(): { id: string; createdAt: number; walCheckpoint: number; records: number } | null {
    return this.generationInfo ? { ...this.generationInfo } : null;
  }

  private async loadIndexDefinitions(): Promise<void> {
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      for (const d of JSON.parse(raw) as (IndexInfo & IndexDef)[]) this.indexes.create(d.name, d);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  /** Persist the given secondary-index definition list. The CONTENT is the
   *  caller's transaction decision (live list ± the mutation), never an
   *  implicit snapshot of the registry — a create persists live+staged BEFORE
   *  publishing, a drop persists live-minus BEFORE removing. */
  private async persistIndexDefinitions(defs: IndexInfo[]): Promise<void> {
    await writeFileAtomic(this.indexPath, JSON.stringify(defs), { stats: this.stats });
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
  /** Persist the given text-index definition list (same transaction-content
   *  rule as persistIndexDefinitions). */
  private async persistTextIndexDefinitions(defs: TextIndexDef[]): Promise<void> {
    await writeFileAtomic(this.textIndexPath, JSON.stringify(defs), { stats: this.stats });
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
  /** Persist the given compound-index definition list (same
   *  transaction-content rule as persistIndexDefinitions). */
  private async persistCompoundIndexDefinitions(defs: CompoundIndexInfo[]): Promise<void> {
    await writeFileAtomic(this.compoundIndexPath, JSON.stringify(defs), { stats: this.stats });
  }

  /** Drop every derived index entry for a key that just expired in the Store. */
  private onStoreExpire(k: string, _rec: StoreRecord): void {
    this.access.delete(k);
    this.dt.del(k);
    this.compound.remove(k);
    if (this.indexes.size) this.indexes.remove(k, undefined);
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
    // Staged included: while a unique create is in its persist window the
    // staged index is fully built and writes must already be checked against
    // it (and serialized via serializeUniqueWrites) — see IndexManager.staged.
    return this.indexes.hasUnique();
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
    if (!this.writeOps.enter()) throw this.backupInProgressError();
    try {
      await this.awaitRotation();
      // Validation before side effects (stage 11): prepare (key/ttl checks,
      // encode + canonical, tokenize + custom-tokenizer validation) and the
      // unique check run BEFORE ensureMemoryFor can evict anything, so a
      // rejected write leaves the database untouched — no eviction, no WAL, no
      // memory change (review #6). The whole pipeline runs inside the
      // unique-write chain when a unique index exists: check-then-commit stays
      // atomic for the chain's whole lifetime, so a WAL-seal retry needs no
      // re-check (every violation-creating writer is serialized out).
      const run = async (): Promise<void> => {
        const op = this.prepareSet(key, value, { ttl, dt });
        if (this.indexes.size && this.indexable(op.canonical)) this.indexes.checkUnique(op.pk, op.canonical);
        await this.ensureMemoryFor([op]);
        await this.retryOnWalSeal(() => this.commitSetOp(op));
      };
      if (this.hasUniqueIndexes()) await this.serializeUniqueWrites(run);
      else await run();
    } finally {
      this.writeOps.leave();
    }
  }

  /** The set() commit body: append the frame and apply the prepared op,
   *  rolling back (per-op or group) when the WAL write fails. */
  private async commitSetOp(op: PreparedOp<V>): Promise<void> {
      // Queue behind any in-place WAL recovery: a write issued after a
      // failure waits for the truncate + poison-clear instead of hitting the
      // still-poisoned WAL. Null (and zero-cost) when no recovery is running.
      const recoveryGate = this.walRecoveryGate();
      if (recoveryGate) await recoveryGate;
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
  }

  async del(key: string | Buffer): Promise<boolean> {
    this.ensureOpen();
    this.ensureWritable();
    if (!this.writeOps.enter()) throw this.backupInProgressError();
    try {
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
    } finally {
      this.writeOps.leave();
    }
  }

  /** Atomically apply a batch of operations (all-or-nothing). */
  async batch(ops: readonly BatchInputOp<V>[]): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    if (!this.writeOps.enter()) throw this.backupInProgressError();
    try {
      await this.awaitRotation();
      if (!ops || ops.length === 0) return;
      // Same stage-11 ordering as set(): every fallible validation (per-op
      // prepare, then the whole-batch unique check against canonical docs)
      // precedes ensureMemoryFor's evictions, so a rejected batch has zero
      // side effects; the pipeline holds the unique-write chain end to end, so
      // a WAL-seal retry of the commit needs no re-check.
      const run = async (): Promise<void> => {
        const prepared = ops.map((o) => this.prepareOp(o));
        if (this.indexes.size) {
          this.indexes.checkUniqueBatch(
            prepared.map((o) => ({
              pk: o.pk,
              op: o.type === TYPE_DEL ? ('del' as const) : ('set' as const),
              doc: o.canonical,
            })),
          );
        }
        await this.ensureMemoryFor(prepared);
        await this.retryOnWalSeal(() => this.commitBatchOps(prepared));
      };
      if (this.hasUniqueIndexes()) await this.serializeUniqueWrites(run);
      else await run();
    } finally {
      this.writeOps.leave();
    }
  }

  /** The batch() commit body: append one BATCH frame and apply every prepared
   *  op, rolling the whole batch back when the WAL write fails. */
  private async commitBatchOps(prepared: readonly PreparedOp<V>[]): Promise<void> {
      const recoveryGate = this.walRecoveryGate();
      if (recoveryGate) await recoveryGate;
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
    // Canonical value (stage 11): the json codec re-parses the encoded bytes
    // ONCE, so every downstream consumer sees exactly the persisted value
    // (review #5). The decode is infallible here — it re-parses what
    // JSON.stringify just produced. Buffer/string codecs have no canonical
    // concept and keep the value as passed (their paths never feed indexes).
    const canonical = this.codecName === 'json' ? (this.decode(vbuf) as V) : value;
    // Tokenize at the prepare boundary (stage 11): a throwing custom
    // tokenizer — or one producing an overlong term — rejects the write here,
    // before the store/delta/buildQueue can be polluted (reviews #24/#27).
    let textTokens: Map<TextIndex, readonly string[] | null> | null = null;
    if (this.text.size) {
      textTokens = new Map();
      for (const ti of this.text.values()) {
        textTokens.set(ti, this.indexable(canonical) ? ti.prepareAdd(canonical) : null);
      }
    }
    const meta = dtNorm ? Buffer.from(JSON.stringify({ dt: dtNorm })) : null;
    return { type: TYPE_SET, key: toBuf(key), value: vbuf, meta, expireAt, dtNorm, pk, canonical, textTokens };
  }

  private prepareDel(key: string | Buffer): PreparedOp<V> {
    this.checkKey(key);
    return {
      type: TYPE_DEL,
      key: toBuf(key),
      value: null,
      meta: null,
      expireAt: 0,
      dtNorm: null,
      pk: this.pk(key),
      canonical: undefined,
      textTokens: null,
    };
  }

  /** Apply a prepared op to the store + derived indexes, writing the key's
   *  pre-op logical record into `out.prev` so the caller can roll back (or
   *  poison + group-rollback) on failure. `out.prev` is assigned before any
   *  mutation, so it is valid even when the apply throws.
   *
   *  CONTRACT: applyOp must not throw. Stage 11 makes this structural: every
   *  fallible input validation lives in the prepare phase (key/ttl checks,
   *  encoding, the canonical decode, tokenization + custom-tokenizer output
   *  validation) and unique checks run before ensureMemoryFor, so the body
   *  below is pure assignment against pre-validated data. The ONE remaining
   *  fallible branch is a text index registered between prepare and apply
   *  (a createTextIndex racing this write — see the comment inline); the
   *  commit bodies' defensive try (stage 7) stays as the backstop for it and
   *  for catastrophic store I/O. */
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
      this.compound.add(op.pk, op.canonical, op.dtNorm);
      if (this.indexes.size) {
        if (this.indexable(oldDoc)) this.indexes.remove(op.pk, oldDoc);
        if (this.indexable(op.canonical)) this.indexes.add(op.pk, op.canonical);
      }
      for (const ti of this.text.values()) {
        const tokens = op.textTokens?.get(ti);
        if (tokens !== undefined) {
          // Pre-tokenized and validated at the prepare boundary (null = the
          // canonical doc is not indexable → drop the key from this index).
          if (tokens === null) ti.remove(op.pk);
          else ti.addPrepared(op.pk, tokens);
        } else if (this.indexable(op.canonical)) {
          // An index registered AFTER this op was prepared (createTextIndex
          // registered it mid-write), or replaced by a same-name drop+create
          // since: it has no prepared tokens, so tokenize here. A throwing
          // tokenizer in this narrow race is covered by the commit body's
          // defensive try (stage 7), exactly as before stage 11.
          ti.add(op.pk, op.canonical);
        } else {
          ti.remove(op.pk);
        }
      }
    } else if (op.type === TYPE_DEL) {
      const existed = this.store.del(op.key);
      if (existed) {
        this.access.delete(op.pk);
        this.dt.del(op.pk);
        this.compound.remove(op.pk);
        if (this.indexes.size && this.indexable(oldDoc)) this.indexes.remove(op.pk, oldDoc);
        for (const ti of this.text.values()) ti.remove(op.pk);
      }
    }
    // Stage 5: feed the in-flight generation build (if any) so its detached
    // states converge on the exact sealed checkpoint — see genBuild. Infallible
    // (a bare array push + counter), preserving this method's must-not-throw
    // contract.
    const gb = this.genBuild;
    if (gb) {
      gb.queue.push({
        type: op.type,
        pk: op.pk,
        value: op.value,
        expireAt: op.expireAt,
        dtNorm: op.dtNorm,
        canonical: op.canonical,
      });
      gb.bytes += (op.value ? op.value.length : 0) + 64;
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
    // A rollback rewinds the store OUTSIDE applyOp's op stream, so an
    // in-flight generation build can no longer prove its image equals the
    // checkpoint replay: abort it (expected churn, never an error).
    if (this.genBuild) this.genBuild.aborted = true;
    if (this.indexes.size) this.indexes.remove(pk, undefined);
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
    const oldDoc = this.indexes.size ? this.decode(this.store.get(pk)) : undefined;
    if (op.type === TYPE_DEL) {
      if (!this.store.del(pk)) return;
      this.access.delete(pk);
      this.dt.del(pk);
      this.compound.remove(pk);
      if (this.indexes.size && this.indexable(oldDoc)) this.indexes.remove(pk, oldDoc);
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
    if (this.indexes.size || this.text.size || this.compound.size) {
      const doc = this.decode(buf)!;
      this.compound.add(pk, doc, op.dt);
      if (this.indexes.size) {
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
    if (!this.writeOps.enter()) throw this.backupInProgressError();
    try {
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
          // Stage 5: expire() rewrites the TTL without going through applyOp,
          // so the generation build's queue needs this store-only entry — the
          // value is unchanged and value-derived indexes need no re-feed.
          const gb = this.genBuild;
          if (gb) {
            gb.queue.push({
              type: TYPE_SET,
              pk: k,
              value: curValue,
              expireAt,
              dtNorm: cur.dt,
              canonical: undefined,
              storeOnly: true,
            });
            gb.bytes += curValue.length + 64;
          }
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
    } finally {
      this.writeOps.leave();
    }
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
    // Serialized staged → persist → publish (see secondaryDefChain): the
    // definition is staged off to the side, rebuilt there, persisted as part
    // of the sidecar content, and only then published into the live registry.
    // Any failure discards the staged index — the live registry and the
    // sidecar keep their previous state, so a retry cannot hit a phantom
    // "already exists".
    await this.secondaryDefChain(async () => {
      this.indexes.stage(name, opts);
      try {
        this.indexes.rebuildStaged(name, this._liveRecordsRaw());
        // A unique index must not be created over data that already violates it.
        this.indexes.assertUniqueValid(name);
        await this.persistIndexDefinitions([...this.indexes.list(), this.indexes.stagedInfo(name)]);
      } catch (e) {
        this.indexes.discardStaged(name);
        throw e;
      }
      this.indexes.publish(name);
    });
  }
  async dropIndex(name: string): Promise<boolean> {
    this.ensureOpen();
    this.ensureWritable();
    return this.secondaryDefChain(async () => {
      // Persist FIRST (content without the definition), remove from the live
      // registry only after the sidecar is durable: a persist failure leaves
      // the index fully usable instead of diverging memory from disk (which a
      // reopen would have resurrected).
      await this.persistIndexDefinitions(this.indexes.list().filter((i) => i.name !== name));
      return this.indexes.drop(name);
    });
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
    // Serialized staged → persist → publish, the same discipline as
    // createIndex (see compoundDefChain).
    await this.compoundDefChain(async () => {
      this.compound.stage(name, def);
      try {
        this.compound.rebuildStaged(name, this.liveRecords());
        await this.persistCompoundIndexDefinitions([...this.compound.list(), this.compound.stagedInfo(name)]);
      } catch (e) {
        this.compound.discardStaged(name);
        throw e;
      }
      this.compound.publish(name);
    });
  }

  async dropCompoundIndex(name: string): Promise<boolean> {
    this.ensureOpen();
    this.ensureWritable();
    return this.compoundDefChain(async () => {
      // Persist FIRST (content without the definition), remove from live only
      // after the sidecar is durable (see dropIndex).
      await this.persistCompoundIndexDefinitions(this.compound.list().filter((i) => i.name !== name));
      return this.compound.drop(name);
    });
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
    await this.textDefChain(async () => {
      if (this.text.has(name)) throw new Error(`text index "${name}" already exists`);
      const ti = new TextIndex({ fields, ...textIndexTokenizers(tokenizer), postingsPath: this.textPostingsPath(name) });
      // The staged definition: joins the persisted set (publish) only after
      // the sidecar is durable.
      const def: TextIndexDef = { name, fields: fields ?? null, tokenizer };
      // Register BEFORE building: the build yields to the event loop, and
      // registering makes concurrent writes feed the index's build queue, which
      // the build replays onto the new base — so the finished index reflects
      // every write whenever it landed. Until the build completes, searches on
      // the index see only its post-registration delta. Any failure below
      // discards the staged index, so a retry cannot hit a phantom
      // "already exists".
      this.text.set(name, ti);
      try {
        await ti.build(this.textRecords());
        await this.persistTextIndexDefinitions([...this.textDefs, def]);
      } catch (e) {
        // Discard the staged index so the in-memory state and the definition
        // sidecar (which does not name this index) do not diverge; drop the
        // derived postings file with it, exactly like dropTextIndex would.
        this.text.delete(name);
        ti.close();
        await fs.rm(this.textPostingsPath(name), { force: true }).catch(() => {});
        throw e;
      }
      this.textDefs.push(def);
    });
  }
  async dropTextIndex(name: string): Promise<boolean> {
    this.ensureOpen();
    this.ensureWritable();
    return this.textDefChain(async () => {
      const ti = this.text.get(name);
      // Dropping mid-build would orphan the in-flight postings write (the file
      // is removed while the build is still producing it). The build can only
      // be a compaction's postings rebuild — createTextIndex builds under this
      // same chain.
      if (ti?.building) throw new Error(`text index "${name}" is still building`);
      // Mark staged-drop BEFORE the persist window: a compaction's postings
      // rebuild checks the mark and skips this index (see textDrops), so no
      // build can start while the persist below is in flight. The marking is
      // synchronous with the building check above, so a build is either
      // already running (caught there) or can never start (blocked here).
      this.textDrops.add(name);
      try {
        // Persist FIRST (content without the definition), remove from live and
        // release the resources only after the sidecar is durable: a persist
        // failure leaves the index fully usable (see dropIndex).
        const nextDefs = this.textDefs.filter((d) => d.name !== name);
        await this.persistTextIndexDefinitions(nextDefs);
        const ok = this.text.delete(name);
        if (ti) {
          ti.close();
          await fs.rm(this.textPostingsPath(name), { force: true }).catch(() => {});
        }
        this.textDefs = nextDefs;
        return ok;
      } finally {
        this.textDrops.delete(name);
      }
    });
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
    return names.filter(isPersistentFile);
  }

  private async copyIfExists(name: string, destDir: string): Promise<boolean> {
    try {
      const src = path.join(this.dir, name);
      const st = await fs.stat(src);
      // The generations/ tree is a directory: copy it recursively (backup
      // includes published generations; a restore's inode change safely
      // invalidates their WAL anchors, so they fall back to a rebuild).
      if (st.isDirectory()) await fs.cp(src, path.join(destDir, name), { recursive: true });
      else await fs.copyFile(src, path.join(destDir, name));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }

  /** The rejection a write op gets while a backup holds the write gate: the
   *  fence is short (file copies) and retryable, so callers can simply
   *  re-issue the write afterwards. */
  private backupInProgressError(): Error {
    return Object.assign(new Error('MiniDb backup is in progress: writes are fenced until it completes'), {
      code: 'BACKUP_IN_PROGRESS',
    });
  }

  /** Write a consistent online backup of this database directory.
   *
   *  Semantics (plan 12): backup pauses the write gate — new writes reject
   *  with BACKUP_IN_PROGRESS — and waits for every in-flight write to settle.
   *  That drain completion IS the linearization point: every write
   *  acknowledged before it is included in the backup, every write submitted
   *  after it is not. The copy itself is an atomic commit: persistent files
   *  go to a sibling temp dir, every copied file is fsync'd, the manifest is
   *  written LAST (the commit marker — a manifest on disk implies every file
   *  it lists is fully copied and durable), then the temp dir is renamed over
   *  the destination (an existing previous backup is swapped aside first and
   *  restored if the rename fails). A failure anywhere before the rename
   *  leaves the destination untouched and the temp dir removed — never a half
   *  backup. Concurrent backups serialize on serializeBackups. */
  async backup(destDir: string, opts: { compact?: boolean } = {}): Promise<void> {
    this.ensureOpen();
    if (!destDir) throw new TypeError('backup: destDir is required');
    if (this.compacting) await this._compactDone;
    if (opts.compact !== false && !this.readOnly) await this.compact();
    if (this.compacting) await this._compactDone;

    // The gate closes SYNCHRONOUSLY here (pause's first statement): a write
    // submitted from the same synchronous segment as this backup() call
    // already sees the fence. pause is reference-counted, so a second backup
    // queued on the serializer keeps the gate closed until the last one
    // resumes.
    const drain = this.writeOps.pause();
    try {
      await this.serializeBackups(async () => {
        // Fence + drain. After the drain resolves, no write op is running and
        // no new one can start, so the on-disk files are quiescent (this
        // instance is the only writer — a read-only instance backing up a
        // LIVE writer's dir can only fence itself and stays best-effort, as
        // before).
        await drain;
        // A compaction kicked by the just-drained writes must finish before
        // the copy; no new one can start with the gate closed (kicks come from
        // write commit bodies only).
        if (this.compacting) await this._compactDone;
        // Wait out any in-flight WAL recovery inside the fence: a WAL failure
        // racing the backup leaves un-acked bytes in db.wal that the recovery
        // is about to truncate away, and the copy must land on the recovered
        // (possibly truncated) file rather than copying bytes that are about
        // to disappear. With the gate closed no new recovery can be kicked,
        // and a persistent failure keeps the WAL poisoned, so the flush below
        // rejects the backup.
        await this.walRecoveryChain;
        await this.wal.flush();
        await this.copyBackupAtomic(destDir);
      });
    } finally {
      this.writeOps.resume();
    }
  }

  /** The atomic-copy core of backup(): temp dir → per-file fsync → manifest
   *  (commit marker) → dir fsync → rename swap → parent fsync. Runs with the
   *  write gate paused. */
  private async copyBackupAtomic(destDir: string): Promise<void> {
    const parent = path.dirname(destDir);
    const base = path.basename(destDir);
    const tmp = path.join(parent, `.${base}.backup-tmp-${process.pid}-${++backupTmpSeq}`);
    const aside = path.join(parent, `.${base}.backup-old-${process.pid}-${++backupTmpSeq}`);
    await fs.mkdir(parent, { recursive: true });
    // Sweep orphans from a crashed previous backup of this destination.
    for (const name of await fs.readdir(parent)) {
      if (name.startsWith(`.${base}.backup-tmp-`) || name.startsWith(`.${base}.backup-old-`)) {
        await fs.rm(path.join(parent, name), { recursive: true, force: true });
      }
    }
    await fs.mkdir(tmp);
    try {
      const files = await this.persistentFiles();
      const copied: string[] = [];
      for (const name of files) if (await this.copyIfExists(name, tmp)) copied.push(name);
      // Fsync every copied file BEFORE the manifest: the manifest is the
      // commit marker, so a durable manifest must imply durable payloads.
      for (const name of copied) {
        const h = await fs.open(path.join(tmp, name), 'r');
        try {
          await h.sync();
        } finally {
          await h.close();
        }
      }
      const manifest = path.join(tmp, 'backup.manifest.json');
      await fs.writeFile(manifest, JSON.stringify({ version: 1, createdAt: Date.now(), files: copied }, null, 2), 'utf8');
      const mh = await fs.open(manifest, 'r');
      try {
        await mh.sync();
      } finally {
        await mh.close();
      }
      await fsyncDir(tmp, { strict: true, stats: this.stats });
      // Swap into place: move an existing previous backup aside, rename the
      // temp dir over the destination, restore the aside on failure.
      let asideUsed = false;
      try {
        try {
          await fs.rename(destDir, aside);
          asideUsed = true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        await fs.rename(tmp, destDir);
      } catch (err) {
        if (asideUsed) await fs.rename(aside, destDir).catch(() => {});
        throw err;
      }
      await fs.rm(aside, { recursive: true, force: true });
      await fsyncDir(parent, { strict: true, stats: this.stats });
    } finally {
      // A successful rename already moved the temp dir away (this rm is a
      // no-op); a failed copy must not strand it (review #22: no half backup).
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
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
      if (isPersistentFile(name) || name === 'backup.manifest.json') {
        const src = path.join(srcDir, name);
        const st = await fs.stat(src);
        if (st.isDirectory()) await fs.cp(src, path.join(destDir, name), { recursive: true });
        else await fs.copyFile(src, path.join(destDir, name));
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
    if (this.state === 'closed') return;
    // Concurrent close() calls share the one in-flight cleanup pass; after a
    // failed pass a later call retries the remaining cleanup (the state stays
    // 'closing' until a pass completes without errors).
    if (this.closePromise) return this.closePromise;
    this.state = 'closing';
    const run = this.closeResources();
    this.closePromise = run;
    try {
      await run;
      this.state = 'closed';
    } finally {
      if (this.closePromise === run) this.closePromise = null;
    }
  }

  /** One cleanup pass over every held resource in dependency order (text
   *  indexes → store → valueReader → WAL → lock). Each resource's close is
   *  independently fallible and idempotent: an error is collected and the
   *  rest still run — a failed WAL close must not skip the lock release —
   *  then every collected error is rethrown as one AggregateError. The WAL
   *  failure semantics themselves are unchanged (the error propagates); only
   *  the lock release is no longer skipped because of it. */
  private async closeResources(): Promise<void> {
    // Wait out an in-flight compaction, but never propagate its failure: it is
    // already accounted in lastCompactError/stats.compactErrors, and letting
    // it escape here would skip the whole cleanup pass (the caller would have
    // to close() twice to actually release the lock).
    if (this.compacting) await this._compactDone?.catch(() => {});
    // Settle an in-flight generation build (its liveness check aborts it once
    // the state flips to 'closing') before its file handles/posts are torn
    // down. Failures are already accounted in the generation stats.
    if (this.genBuildPromise) await this.genBuildPromise.catch(() => {});
    // Let in-flight WAL failures and their kicked recoveries settle before
    // and after closing the WAL: a poisoned/failing close would otherwise
    // leave an un-acked tail in db.wal that a reopen replays as ghost writes.
    // Kicks arrive in op rejection microtasks that can be scheduled behind
    // this close (and the WAL's own final flush can drive a queued failing
    // batch, kicking one more recovery), so wait for the chain to be IDLE in
    // a loop instead of awaiting one snapshot of it.
    while (!this.walRecoveryIdle) await this.walRecoveryChain;
    const errors: unknown[] = [];
    try {
      for (const ti of this.text.values()) ti.close();
    } catch (e) {
      errors.push(e);
    }
    try {
      this.store.close();
    } catch (e) {
      errors.push(e);
    }
    try {
      this.valueReader?.close();
    } catch (e) {
      errors.push(e);
    }
    try {
      await this.wal.close();
    } catch (e) {
      errors.push(e);
    }
    while (!this.walRecoveryIdle) await this.walRecoveryChain;
    try {
      if (this.lock) {
        await this.lock.release();
        this.lock = null;
      }
    } catch (e) {
      errors.push(e);
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `MiniDb close: ${errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')}`,
      );
    }
  }

  private ensureOpen(): void {
    if (this.state !== 'open') throw new Error('MiniDb is closed');
  }
  private ensureWritable(): void {
    if (this.readOnly) throw new Error('MiniDb is open in read-only mode');
    if (this.writeDisabled) throw this.writeDisabledError();
  }
}
