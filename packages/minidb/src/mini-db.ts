// src/mini-db.ts
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
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import type { StoreRecord } from './store.js';
import { WAL } from './wal.js';
import { ValueReader } from './value-reader.js';
import { catchUpWal } from './recovery.js';
import { compact, shouldCompact } from './compaction.js';
import { OpTracker } from './op-tracker.js';
import { TEXT_INDEXES_FILE, SNAPSHOT_FILE, isPersistentFile, rootPostingsFile, textDictionaryFile, textDocsFile } from './generation.js';
import { IndexManager } from './index-manager.js';
import { DtIndex } from './dt-index.js';
import { TextIndex } from './text-index/index.js';
import { CompoundIndexManager } from './compound-index.js';
import { toKStr, writeFileAtomic } from './value-codec.js';
import { LockFile } from './lockfile.js';
import { createSerializer } from './serialize.js';
import { MaintenanceScheduler, defaultWorkerSlots } from './maintenance.js';
import { MemoryGuard } from './memory-guard.js';
import { backup as runBackup, backupInProgressError as newBackupInProgressError } from './backup.js';
import type { BackupDeps } from './backup.js';
import { QueryEngine } from './query-engine.js';
import { GenerationBuilder, TEXT_BUILD_WORKER_MIN_DOCS, GEN_BUILD_WAL_DELTA_BYTES } from './generation-builder.js';
import type { GenBuildOp } from './generation-builder.js';
import { WalGroupTracker } from './wal-group.js';
import { WritePath } from './write-path.js';
import { openMiniDb, closeMiniDb, renewMiniDbLock, openOrRebuildMiniDb } from './lifecycle.js';
import { IndexAdmin } from './index-admin.js';
import { ReadPath } from './read-path.js';
import { createMiniDbStats } from './stats.js';
import type { LifecycleHooks } from './lifecycle.js';
import { TextRegistry } from './text-registry.js';
import type { TextIndexDef } from './text-registry.js';
import type { MaintenanceContext, MaintenanceTaskInfo } from './maintenance.js';
import type { FrameRef } from './codec.js';
import type { FsyncPolicy } from './wal.js';
import type { RecoveryMode, RecoveryInfo, ValueMode, RecoveredOp } from './recovery.js';
import type { IndexDef, IndexInfo } from './index-manager.js';
import type { CompoundIndexDef, CompoundIndexInfo } from './compound-index.js';
import type { RangeOptions } from './skiplist.js';
import type { TextIndexTokenizerName } from './trigram.js';
import type { PostingEntry } from './text-postings.js';
import { startWorkerTextBuild, textBuildWorkerAvailable, verifyFileCrcAsync, WorkerTextBuildError } from './worker/text-build.js';
import type { TextBuildCheckpoint } from './worker/text-build.js';
import { readBaseDocsImageAsync, BASE_DOCS_MAGIC, BASE_DOCS_VERSION } from './worker/text-build-core.js';
import type { TextBuildCoreResult } from './worker/text-build-core.js';
import { readGenerationFileCheckedAsync, readTextDictionaryImageAsync } from './gen-codec.js';

import type {
  ValueCodec,
  ValueCodecName,
  OpenOptions,
  RestoreOptions,
  SetOptions,
  BatchInputOp,
  DocRecord,
  ScanEntry,
  QueryOptions,
} from './types.js';
// ClusterDb (the multi-process sharding layer) lives at the './cluster'
// subpath export to keep this module free of import cycles.

export class MiniDb<V = unknown> {
  dir!: string;
  walPath!: string;
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ indexPath!: string;
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ compoundIndexPath!: string;
  store!: Store;
  wal!: WAL;
  valueReader?: ValueReader;
  valueMode: ValueMode = 'memory';
  readonly indexes = new IndexManager();
  readonly dt = new DtIndex();
  readonly compound = new CompoundIndexManager();
  /** Text-index registry state lives in the TextRegistry facet (declared
   *  below, after stats); these views keep the generation / compaction /
   *  write paths' call sites unchanged. */
  private get text(): Map<string, TextIndex> {
    return this.textRegistry.text;
  }
  private get textDefs(): TextIndexDef[] {
    return this.textRegistry.textDefs;
  }
  private get textDrops(): Set<string> {
    return this.textRegistry.textDrops;
  }

  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ codec!: ValueCodec<V>;
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ codecName: ValueCodecName = 'buffer';
  fsyncPolicy: FsyncPolicy = 'everysec';
  syncIntervalMs = 1000;
  /** Lifecycle state machine. 'closing' is a real state (not just a flag on
   *  the way down): a cleanup failure leaves the instance there so a later
   *  close() call can retry the remaining cleanup, and ensureOpen rejects
   *  'closing' and 'closed' alike. */
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ state: 'open' | 'closing' | 'closed' = 'open';
  /** The in-flight close() cleanup pass, shared by concurrent close() calls. */
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ closePromise: Promise<void> | null = null;
  recoveryInfo: RecoveryInfo | null = null;
  /** Continuation watermark for catchUpFromWal: the WAL inode + applied
   *  offset as advanced by the last successful catch-up (recoveryInfo's scan
   *  endpoint anchors the first call). */
  private walTail: { dev: number; ino: number; size: number } | null = null;
  readOnly = false;
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ lock: LockFile | null = null;

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
  /** The LRU access set lives in the MemoryGuard facet (declared below, after
   *  stats); this view keeps the class's delete-only call sites unchanged. */
  private get access(): Set<string> {
    return this.memoryGuard.access;
  }
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
  /** The WAL group-commit + in-place recovery gating facet (wal-group.ts):
   *  owns pendingGroups/lastGroup and the recovery chain state
   *  (walRecoveryChain/walRecoveryIdle/walRecoveryCovers); these views keep
   *  the close / catch-up / backup call sites unchanged. */
  private readonly walGroups = new WalGroupTracker({
    restoreGroupKey: (pk, prev) => this.restoreGroupKey(pk, prev),
    writeDisabled: () => this.writeDisabled,
    recoverWalInPlace: (wal) => this.recoverWalInPlace(wal),
  });
  private get walRecoveryChain(): Promise<void> {
    return this.walGroups.walRecoveryChain;
  }
  private get walRecoveryIdle(): boolean {
    return this.walGroups.walRecoveryIdle;
  }
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
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ indexGenerationsEnabled = true;
  /** Stage 6: the unified maintenance scheduler (compaction + generation
   *  builds: one heavy task at a time, backpressure, preflight, cancellation,
   *  drain on close). Created in open() once the directory is known. */
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ maintenance!: MaintenanceScheduler;
  /** Stage 6: workerized text generation build enabled (rollback switch). */
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ textBuildWorkerEnabled = true;
  /** Sticky fallback: a worker that failed to produce ANY result once (spawn
   *  failure) disables the worker path for the rest of this instance — the
   *  next build uses the in-thread staged path. */
  private textWorkerDisabled = false;
  /** Stage 6: worker aggregation memory budget. */
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ textBuildMemoryBytes = 128 * 1024 * 1024;
  /** Stage 6: maintenance I/O concurrency (snapshot grouped reads). */
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ maintenanceIoConcurrency = 8;
  /** Defer the open-time full text rebuild (no-generation fallback) to a background
   *  bounded build (OpenOptions.deferOpenTextBuilds, default true). */
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ deferTextBuildsEnabled = true;
  /** A read-only deferred build's private scratch dir (outside the db dir);
   *  created on first use, dropped on close (lifecycle.ts closeResources). */
  /* Non-private (package-internal): lifecycle.ts reads/writes this through its LifecycleHost view. */ roScratchDir: string | null = null;
  /** Runtime generation-build trigger (see maybeAutoGenerationBuild):
   *  throttles — minimum interval between kicks, and the longer backoff
   *  after a build failed/aborted (public test knobs, same pattern as the
   *  search service's). */
  genBuildKickMinIntervalMs = 60_000;
  genBuildKickFailureBackoffMs = 300_000;
  private lastGenBuildKickAt = 0;
  private lastGenBuildFailureAt = 0;
  /** Abort handle / mutation queue / single-flight guard / status of the
   *  generation build all live in the GenerationBuilder facet (declared
   *  below); these views keep the open / write / close paths' call sites
   *  unchanged (the write path feeds the SHARED genBuild object by
   *  reference). */
  private get genBuildAbort(): AbortController | null {
    return this.generationBuilder.genBuildAbort;
  }
  private get genBuild(): { queue: GenBuildOp[]; bytes: number; wal: WAL; aborted: boolean } | null {
    return this.generationBuilder.genBuild;
  }
  private get genBuildPromise(): Promise<void> | null {
    return this.generationBuilder.genBuildPromise;
  }
  private get generationInfo(): { id: string; createdAt: number; walCheckpoint: number; records: number } | null {
    return this.generationBuilder.generationInfo;
  }
  /** Set when in-place WAL recovery's truncate fails (persistent I/O error):
   *  from then on every write op throws a WAL_WRITE_DISABLED error
   *  immediately; reads and close() keep working. The value is the truncate
   *  error (the cause). DESIGNED CONSEQUENCE: the WAL stays poisoned, so
   *  close() skips its final flush and the un-acked tail is LEFT in db.wal —
   *  a later reopen replays it and the rejected writes resurface. That is
   *  exactly why every commit-point failure is marked `ambiguous: true`: in
   *  this state the caller cannot assume a rejected write had no effect. */
  writeDisabled: unknown = null;
  readonly stats = createMiniDbStats();

  /** The text-index registry facet (text-registry.ts): owns the live TextIndex
   *  map, the persisted definition list, and the staged-drop marks (declared
   *  after stats because the injected deps reference it; everything else is
   *  read lazily through the getters). */
  private readonly textRegistry = new TextRegistry<V>({
    dir: () => this.dir,
    readOnly: () => this.readOnly,
    codecName: () => this.codecName,
    store: () => this.store,
    ensureOpen: () => this.ensureOpen(),
    ensureWritable: () => this.ensureWritable(),
    decode: (b) => this.decode(b),
    readValueAsync: (kstr) => this.readValueAsync(kstr),
    textRecords: () => this.textRecords(),
    persistTextIndexDefinitions: (defs) => this.persistTextIndexDefinitions(defs),
    boundedTextBuild: (name, ti, def, checkpoint) => this.boundedTextBuild(name, ti, def, checkpoint),
  });

  /** The maxMemory guard facet: owns the LRU access set and the
   *  projected-bytes enforce pass (declared after stats because the injected
   *  deps reference it; store/config are read lazily through the getters). */
  private readonly memoryGuard = new MemoryGuard<V>({
    store: () => this.store,
    valueMode: () => this.valueMode,
    maxMemoryBytes: () => this.maxMemoryBytes,
    maxMemoryPolicy: () => this.maxMemoryPolicy,
    stats: this.stats,
    evictKey: (pk) => this.evictKey(pk),
  });

  /** The backup flow's injected deps (backup.ts); the callbacks read the
   *  live fields at call time, so the facet never holds stale references. */
  private readonly backupDeps: BackupDeps = {
    dir: () => this.dir,
    stats: this.stats,
    ensureOpen: () => this.ensureOpen(),
    compacting: () => this.compacting,
    compactDone: () => this._compactDone,
    readOnly: () => this.readOnly,
    compact: () => this.compact(),
    pauseWrites: () => this.writeOps.pause(),
    resumeWrites: () => this.writeOps.resume(),
    serializeBackups: (fn) => this.serializeBackups(fn),
    walRecoveryChain: () => this.walRecoveryChain,
    flushWal: () => this.wal.flush(),
  };

  /** The unified query engine facet (query-engine.ts): read-only; the index
   *  managers and the text map are stable references, store/codecName are
   *  read lazily through the getters. */
  private readonly queryEngine = new QueryEngine<V>({
    store: () => this.store,
    indexes: this.indexes,
    dt: this.dt,
    text: this.text,
    codecName: () => this.codecName,
    stats: this.stats,
    decode: (b) => this.decode(b),
    readValueAsync: (kstr) => this.readValueAsync(kstr),
    ensureOpen: () => this.ensureOpen(),
  });

  /** The generation machinery facet (generation-builder.ts): the load/build
   *  paths and the genBuild state (declared after queryEngine; every dep is
   *  either a stable reference or a lazy getter/callback). */
  private readonly generationBuilder = new GenerationBuilder<V>({
    dir: () => this.dir,
    walPath: () => this.walPath,
    codecName: () => this.codecName,
    valueMode: () => this.valueMode,
    readOnly: () => this.readOnly,
    state: () => this.state,
    indexGenerationsEnabled: () => this.indexGenerationsEnabled,
    store: () => this.store,
    wal: () => this.wal,
    getValueReader: () => this.valueReader,
    setValueReader: (reader) => {
      this.valueReader = reader;
    },
    setRecoveryInfo: (info) => {
      this.recoveryInfo = info;
    },
    maintenance: () => this.maintenance,
    maintenanceTaskCtx: () => this.maintenanceTaskCtx,
    textBuildWorkerEnabled: () => this.textBuildWorkerEnabled,
    textWorkerDisabled: () => this.textWorkerDisabled,
    disableTextWorker: () => {
      this.textWorkerDisabled = true;
    },
    textBuildMemoryBytes: () => this.textBuildMemoryBytes,
    dt: this.dt,
    indexes: this.indexes,
    compound: this.compound,
    textRegistry: this.textRegistry,
    stats: this.stats,
    decode: (b) => this.decode(b),
    indexable: (v): v is Record<string, unknown> => this.indexable(v),
    liveRecords: () => this.liveRecords(),
    liveRecordsRaw: () => this._liveRecordsRaw(),
    textRecords: () => this.textRecords(),
    seedAccessFromStore: () => this.seedAccessFromStore(),
    applyRecoveredOp: (op) => this.applyRecoveredOp(op),
    ensureOpen: () => this.ensureOpen(),
    ensureWritable: () => this.ensureWritable(),
    boundedTextBuild: (name, ti, def, checkpoint) => this.boundedTextBuild(name, ti, def, checkpoint),
    noteBuildFailure: () => {
      this.lastGenBuildFailureAt = Date.now();
    },
  });

  /** The write path facet (write-path.ts): set/del/batch/expire and their
   *  whole commit machinery (declared last — it wires the other facets as
   *  collaborators; the wal-group / memory-guard / generation-builder
   *  callbacks that point back here are lazy, so init order is safe). */
  private readonly writePath = new WritePath<V>({
    store: () => this.store,
    wal: () => this.wal,
    valueMode: () => this.valueMode,
    codecName: () => this.codecName,
    rotateLock: () => this._rotateLock,
    dt: this.dt,
    indexes: this.indexes,
    compound: this.compound,
    textRegistry: this.textRegistry,
    walGroups: this.walGroups,
    memoryGuard: this.memoryGuard,
    generationBuilder: this.generationBuilder,
    writeOps: this.writeOps,
    serializeUniqueWrites: (fn) => this.serializeUniqueWrites(fn),
    stats: this.stats,
    encode: (v) => this.encode(v),
    decode: (b) => this.decode(b),
    indexable: (v): v is Record<string, unknown> => this.indexable(v),
    ensureOpen: () => this.ensureOpen(),
    ensureWritable: () => this.ensureWritable(),
    maybeAutoCompact: () => this.maybeAutoCompact(),
  });

  /** The secondary + compound index admin facet (index-admin.ts). The
   *  persist seams below stay on MiniDb (tests stub them on the instance);
   *  the facet drives them through the injected callbacks. */
  private readonly indexAdmin = new IndexAdmin<V>({
    indexes: this.indexes,
    compound: this.compound,
    dt: this.dt,
    textRegistry: this.textRegistry,
    store: () => this.store,
    codecName: () => this.codecName,
    ensureOpen: () => this.ensureOpen(),
    ensureWritable: () => this.ensureWritable(),
    decode: (b) => this.decode(b),
    indexable: (v): v is Record<string, unknown> => this.indexable(v),
    stats: this.stats,
    liveRecords: () => this.liveRecords(),
    liveRecordsRaw: () => this._liveRecordsRaw(),
    secondaryDefChain: (fn) => this.secondaryDefChain(fn),
    compoundDefChain: (fn) => this.compoundDefChain(fn),
    persistIndexDefinitions: (defs) => this.persistIndexDefinitions(defs),
    persistCompoundIndexDefinitions: (defs) => this.persistCompoundIndexDefinitions(defs),
  });

  /** The read path facet (read-path.ts): KV reads, scans, dt reads, and the
   *  live-record generators every (re)build feed goes through. */
  private readonly readPath = new ReadPath<V>({
    store: () => this.store,
    getValueReader: () => this.valueReader,
    dt: this.dt,
    memoryGuard: this.memoryGuard,
    decode: (b) => this.decode(b),
    indexable: (v): v is Record<string, unknown> => this.indexable(v),
    ensureOpen: () => this.ensureOpen(),
  });

  /** The private methods the lifecycle functions (lifecycle.ts) call back
   *  into; the fields they touch are read/written through the LifecycleHost
   *  view directly (see the non-private markers above). */
  private readonly lifecycleHooks: LifecycleHooks = {
    onStoreExpire: (k, rec) => this.onStoreExpire(k, rec),
    loadIndexDefinitions: () => this.loadIndexDefinitions(),
    loadCompoundIndexDefinitions: () => this.loadCompoundIndexDefinitions(),
    loadTextIndexDefinitions: () => this.loadTextIndexDefinitions(),
    tryLoadGeneration: (mode) => this.tryLoadGeneration(mode),
    rebuildAllIndexes: () => this.rebuildAllIndexes(),
    submitCompaction: () => this.submitCompaction(),
    buildGeneration: (trigger) => this.buildGeneration(trigger),
    seedAccessFromStore: () => this.seedAccessFromStore(),
    closeAllTextIndexes: () => {
      for (const ti of this.text.values()) ti.close();
    },
    generationInfo: () => this.generationInfo,
    generationStale: () => this.generationStale(),
    genBuildAbort: () => this.genBuildAbort,
    genBuildPromise: () => this.genBuildPromise,
    walRecoveryIdle: () => this.walRecoveryIdle,
    walRecoveryChain: () => this.walRecoveryChain,
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

  /** The scheduler context of the in-flight maintenance task: compaction's
   *  rotation reports its publishing phase through it (stage 6). */
  private maintenanceTaskCtx: MaintenanceContext | null = null;

  /** CompactionTarget hook: the rotation critical section is the
   *  compaction's publishing phase — a shutdown must wait it out instead of
   *  cancelling mid-rotation (stage 6). The scheduler's markPublishing is
   *  one-way, so 'running' needs no handling. */
  onMaintenancePhase = (phase: 'running' | 'publishing'): void => {
    if (phase === 'publishing') this.maintenanceTaskCtx?.markPublishing();
  };

  /** Queue a compaction on the maintenance scheduler (stage 6): one heavy
   *  task per database at a time; a duplicate submission dedupes onto the
   *  in-flight/queued one. */
  private submitCompaction(): Promise<void> {
    return this.maintenance.submit('compact', async (ctx) => {
      this.maintenanceTaskCtx = ctx;
      try {
        await compact(this);
      } finally {
        this.maintenanceTaskCtx = null;
      }
    });
  }

  static async open<V = unknown>(opts: OpenOptions): Promise<MiniDb<V>> {
    const db = new MiniDb<V>();
    await openMiniDb(db, opts, db.lifecycleHooks);
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
    return openOrRebuildMiniDb(opts, hooks, (o) => MiniDb.open<V>(o));
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
    yield* this.readPath.liveRecords();
  }

  /** Live indexable records with canonical keys, for (re)building text indexes. */
  private *textRecords(): Generator<{ key: string; value: unknown }> {
    yield* this.readPath.textRecords();
  }

  /** On-disk postings file path for a text index (root location — the legacy
   *  pre-generation home; the name sanitization lives in generation.ts). */
  private textPostingsPath(name: string): string {
    return this.textRegistry.textPostingsPath(name);
  }

  /** LEGACY postings maintenance (indexGenerations: false): rebuild every
   *  dirty text index's on-disk postings from the live Store (see
   *  TextRegistry.rebuildTextPostings). */
  private async rebuildTextPostings(): Promise<void> {
    return this.textRegistry.rebuildTextPostings();
  }

  private async rebuildAllIndexes(): Promise<void> {
    // Decide per text index whether its base build DEFERS to the bounded
    // background engine (deferOpenTextBuilds) or stays on the staged inline
    // walk below. Deferred indexes get neither a staged builder nor feeding
    // during the walk; open() returns with them "building" instead of
    // awaiting a corpus-scale rebuild on the caller's event loop. The gates
    // mirror boundedTextBuild's eligibility; a read-only (memory-base) index
    // IS deferrable — its build is redirected to the private scratch dir.
    const deferred = new Set<string>();
    if (this.deferTextBuildsEnabled) {
      for (const [name, ti] of this.text) {
        if (ti.hasCustomTokenizer) continue;
        if (!this.textBuildWorkerEnabled || this.textWorkerDisabled) continue;
        if (this.store.size < TEXT_BUILD_WORKER_MIN_DOCS) continue;
        deferred.add(name);
      }
    }
    await this.indexAdmin.rebuildAllIndexes({ skipTextIndex: (name) => deferred.has(name) });
    if (deferred.size > 0) this.deferOpenTextBuilds([...deferred]);
  }

  /** Arm the rebase queue on each deferred text index NOW and build its base
   *  in a background maintenance task with the bounded engine, pinned at the
   *  recovery checkpoint. The fallback full recovery feeds only the Store,
   *  so the write
   *  buffers are empty at this point and arming here (before open() returns —
   *  no write or catch-up can interleave) captures exactly the
   *  post-checkpoint ops. Until a build commits, searches on the index raise
   *  TextIndexBuildingError instead of silently serving partial results. A
   *  read-only opener builds into a private scratch dir OUTSIDE the live
   *  writer's db dir and adopts the disk base there (commitRebase's
   *  memBase→disk flip). */
  private deferOpenTextBuilds(names: readonly string[]): void {
    const rec = this.recoveryInfo;
    if (rec === null) return;
    const armed: { name: string; ti: TextIndex; def: TextIndexDef }[] = [];
    for (const name of names) {
      const ti = this.text.get(name);
      const def = this.textDefs.find((d) => d.name === name);
      if (ti === undefined || def === undefined) continue;
      // Mark the base unavailable from this exact point: the index has no
      // base at all until the deferred build commits (the fallback recovery
      // fed only the Store), so searches raise the typed building signal.
      ti.basePending = true;
      ti.beginRebase();
      armed.push({ name, ti, def });
    }
    if (armed.length === 0) return;
    // The checkpoint the build covers: the recovery scan endpoint (see the
    // header — the queue captures every op after it).
    const pin = (): TextBuildCheckpoint => ({
      walOffset: rec.walScanEnd,
      walDev: rec.walDev,
      walIno: rec.walIno,
      snapshotDev: rec.snapshotDev,
      snapshotIno: rec.snapshotIno,
    });
    // Re-pinning after a failed attempt (a live writer's compaction can
    // rotate the WAL under a read-only build, invalidating the anchors):
    // clear the write buffer, re-read the anchors, and re-arm the queue —
    // one synchronous segment, so no op slips between the pin and the
    // capture. Ops the buffer held are all below the fresh checkpoint, hence
    // covered by the retried build.
    const repin = (ti: TextIndex): TextBuildCheckpoint => {
      ti.resetWriteBuffer();
      ti.abortRebase();
      const walAnchor = fsSync.statSync(this.walPath);
      let snapshotDev = 0;
      let snapshotIno = 0;
      try {
        const snapAnchor = fsSync.statSync(path.join(this.dir, SNAPSHOT_FILE));
        snapshotDev = snapAnchor.dev;
        snapshotIno = snapAnchor.ino;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const checkpoint: TextBuildCheckpoint = {
        walOffset: walAnchor.size,
        walDev: walAnchor.dev,
        walIno: walAnchor.ino,
        snapshotDev,
        snapshotIno,
      };
      ti.beginRebase();
      return checkpoint;
    };
    const scratchDir = this.readOnly
      ? (this.roScratchDir ??= path.join(
          this.dir,
          '..',
          `${path.basename(this.dir)}.ro-scratch`,
          `${process.pid}-${randomUUID().slice(0, 8)}`,
        ))
      : null;
    void this.maintenance
      .submit('text-build', async (ctx) => {
        for (const { name, ti, def } of armed) {
          const output = scratchDir !== null ? { dir: scratchDir, postingsPath: path.join(scratchDir, rootPostingsFile(name)) } : null;
          let checkpoint = pin();
          let committed = false;
          for (let attempt = 1; attempt <= 3 && !committed; attempt++) {
            if (attempt > 1) checkpoint = repin(ti);
            try {
              const hosted = await this.boundedTextBuild(name, ti, def, checkpoint, output, ctx.signal);
              // Ineligible after all (e.g. the sticky worker-disable landed
              // mid-task): no build will come — stop retrying.
              if (hosted === null) break;
              committed = true;
            } catch {
              // Shutdown cancels the task: leave close() to finish teardown.
              if (ctx.signal.aborted) return;
            }
          }
          if (committed) {
            this.stats.textDeferredBuilds++;
          } else {
            // Every attempt failed: disarm and mark the base pending —
            // searches keep the typed building signal instead of silently
            // degrading to delta-only. A later generation build (its text
            // commits swap live bases) or the next open attaches a base.
            ti.abortRebase();
            ti.basePending = true;
            this.stats.textDeferredBuildErrors++;
          }
        }
      })
      .catch(() => {
        // Task-level failure (preflight ENOSPC, backpressure, cancellation):
        // mark every still-armed index pending (see above).
        for (const { ti } of armed) {
          if (ti.rebasing) {
            ti.abortRebase();
            ti.basePending = true;
            this.stats.textDeferredBuildErrors++;
          }
        }
      });
  }

  /** Whether a text index's base is currently unavailable — a deferred
   *  open-time build is in flight or finally failed — so searches on it
   *  raise TextIndexBuildingError instead of serving partial results. */
  textIndexBuilding(name: string): boolean {
    const ti = this.text.get(name);
    return ti !== undefined && ti.basePending;
  }

  private *_liveRecordsRaw(): Generator<{ key: Buffer; value: unknown }> {
    yield* this.readPath.liveRecordsRaw();
  }


  // ---- persistent index generations (stage 5) ------------------------------
  //
  // The generation machinery (load path, build path, genBuild state) lives in
  // the GenerationBuilder facet (generation-builder.ts); MiniDb keeps the
  // private views and delegates below so the open / compaction / write / close
  // paths' call sites stay unchanged.

  private async tryLoadGeneration(mode: RecoveryMode): Promise<boolean> {
    return this.generationBuilder.tryLoadGeneration(mode);
  }

  private async buildGeneration(trigger: 'open' | 'compact' | 'manual' | 'wal-growth' | 'close'): Promise<void> {
    return this.generationBuilder.buildGeneration(trigger);
  }

  /** Explicit maintenance (stage 5): build + publish a fresh index generation
   *  now. Writer only. The load path is automatic; this exists for operators
   *  who want to force a checkpoint after a large burst of writes instead of
   *  waiting for the next compaction. */
  async rebuildGeneration(): Promise<void> {
    return this.generationBuilder.rebuildGeneration();
  }

  /** Build ONE text index's base with the bounded engine (byte-budget
   *  aggregation + segmented external merge — hosted in a worker thread when
   *  its entry file exists, the same core inline on the main thread
   *  otherwise) and swap it in through the rebase machinery. This is the
   *  memory-bounded alternative to `ti.build(...)`'s staged O(corpus)
   *  aggregation for the two full-corpus build entries: createTextIndex and
   *  the open-time generation-loader rebuild. Returns 'worker' | 'inline'
   *  when the build ran; null when the index is ineligible and the caller
   *  must use the staged path (tiny corpus, custom tokenizer, a memory-base
   *  index without an external `output`, or the explicit rollback switches).
   *  On throw the rebase is aborted and the live index is untouched — the
   *  caller decides whether a staged fallback is safe to attempt.
   *
   *  `output` redirects the build's artifacts to a caller-owned directory
   *  OUTSIDE the db dir and skips the rename into the db root — the shape a
   *  read-only opener needs: it must not write into the live writer's
   *  directory, so its base postings are built into a private scratch dir
   *  and adopted there (commitRebase flips memBase→disk, same as a
   *  generation attach). The postings file at `output.postingsPath` stays
   *  live after the commit and is owned by the caller from then on. */
  private async boundedTextBuild(
    name: string,
    ti: TextIndex,
    def: TextIndexDef,
    checkpoint: TextBuildCheckpoint | null,
    output: { dir: string; postingsPath: string } | null = null,
    signal?: AbortSignal,
  ): Promise<'worker' | 'inline' | null> {
    if (
      !this.textBuildWorkerEnabled ||
      this.textWorkerDisabled ||
      this.state !== 'open' ||
      // A memory-base index (read-only open) must not write into the live
      // writer's db dir: it is only eligible when the build's artifacts are
      // redirected to a caller-owned scratch location.
      (ti.memBase !== null && output === null) ||
      ti.hasCustomTokenizer ||
      this.store.size < TEXT_BUILD_WORKER_MIN_DOCS
    ) {
      return null;
    }
    // Pin the checkpoint. createTextIndex (checkpoint === null) gets a seal
    // identical to the generation build's: beginRebase starts the mutation
    // capture and the appendOffset read is one synchronous segment with it,
    // so the build covers every frame below the offset and the rebase queue
    // every op after it. A caller-pinned checkpoint (the generation loader's
    // manifest anchors, already verified against the live WAL) skips the
    // seal — the queue stays empty because writes cannot interleave with the
    // open-time load.
    let sealedOffset: number;
    let walDev: number;
    let walIno: number;
    let snapDev = 0;
    let snapIno = 0;
    const sizeAtCheckpoint = this.store.size;
    // The seal needs the live WAL's appendOffset; a memory-base index is a
    // read-only open whose WAL was never opened, so its caller MUST pin the
    // checkpoint (recoveryInfo anchors) instead.
    if (checkpoint === null && ti.memBase !== null) {
      throw new Error('bounded text build on a memory-base index requires a pinned checkpoint');
    }
    // A caller may have pre-armed the capture (the deferred open-time build
    // arms at the recovery checkpoint, so ops queue from that exact point
    // while the build waits on the maintenance queue); arm only otherwise.
    if (!ti.rebasing) ti.beginRebase();
    try {
      if (checkpoint === null) {
        sealedOffset = this.wal.appendOffset;
        await this.wal.flush();
        const walAnchor = fsSync.statSync(this.walPath);
        walDev = walAnchor.dev;
        walIno = walAnchor.ino;
        try {
          const snapAnchor = fsSync.statSync(path.join(this.dir, SNAPSHOT_FILE));
          snapDev = snapAnchor.dev;
          snapIno = snapAnchor.ino;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      } else {
        sealedOffset = checkpoint.walOffset;
        walDev = checkpoint.walDev;
        walIno = checkpoint.walIno;
        snapDev = checkpoint.snapshotDev;
        snapIno = checkpoint.snapshotIno;
      }
    } catch (e) {
      ti.abortRebase();
      throw e;
    }

    // In-place builds land artifacts in a per-index tmp dir inside the db
    // dir (fixed name, removed before use and in the finally — a crashed
    // attempt is cleaned by the next one), and the postings file is renamed
    // to its final root location only after verification, so a crash never
    // strands a partial file at the live path. An `output`-redirected build
    // (read-only scratch) writes straight into the caller's dir: crash
    // residue there is harmless — the next attempt overwrites it and the
    // whole dir is dropped on close.
    const tmpDir = output === null ? path.join(this.dir, `${rootPostingsFile(name)}.tmpbuild`) : null;
    let slotRelease: (() => void) | null = null;
    try {
      const artifactsDir = tmpDir ?? output!.dir;
      if (tmpDir !== null) await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.mkdir(artifactsDir, { recursive: true });
      const postingsPath = tmpDir !== null ? path.join(tmpDir, rootPostingsFile(name)) : output!.postingsPath;
      const dictionaryPath = path.join(artifactsDir, textDictionaryFile(name));
      const baseDocsPath = path.join(artifactsDir, `${textDocsFile(name)}.base`);
      // Worker thread when its entry file exists; the inline bounded core
      // otherwise (slot pressure or a single-file deployment) — never the
      // unbounded staged aggregation.
      const workerAvailable = textBuildWorkerAvailable();
      slotRelease = workerAvailable ? defaultWorkerSlots.tryAcquire() : null;
      const inline = slotRelease === null;
      const handle = startWorkerTextBuild(
        {
          snapshotPath: snapIno !== 0 ? path.join(this.dir, SNAPSHOT_FILE) : null,
          walPath: this.walPath,
          walOffset: sealedOffset,
          walDev,
          walIno,
          snapshotDev: snapDev,
          snapshotIno: snapIno,
          indexes: [
            {
              name,
              fields: def.fields,
              tokenizer: def.tokenizer === 'ngram' ? ('ngram' as const) : ('default' as const),
              postingsPath,
              dictionaryPath,
              baseDocsPath,
            },
          ],
          memoryBudgetBytes: this.textBuildMemoryBytes,
        },
        {
          shouldAbort: () => this.state !== 'open' || signal?.aborted === true,
          inline,
          inlineReason: workerAvailable ? 'slot-pressure' : 'runtime-unavailable',
          signal,
          onFallback: (reason) => {
            this.stats.textWorkerFallbacks++;
            this.stats.lastTextWorkerFallback = reason;
          },
        },
      );
      let result: TextBuildCoreResult;
      try {
        result = await handle.promise;
      } catch (error) {
        if (!handle.inline && !(error instanceof WorkerTextBuildError && error.aborted)) {
          this.stats.textWorkerErrors++;
        }
        throw error;
      }
      if (result.scannedLiveKeys > sizeAtCheckpoint) {
        throw new Error(
          `text build scanned ${result.scannedLiveKeys} live keys > checkpoint store ${sizeAtCheckpoint} (pinning protocol violation)`,
        );
      }
      // Verify before trusting (the worker's output is discardable evidence):
      // streaming crc on the raw postings file, envelope+crc on the images.
      const r = result.indexes[0]!;
      await verifyFileCrcAsync(postingsPath, r.postingsInfo);
      const dictPayload = await readGenerationFileCheckedAsync(dictionaryPath, 'MDTD', 1, r.dictionaryInfo);
      const dictEntries = (await readTextDictionaryImageAsync(dictPayload)).map(
        (e) => [e.term, { off: e.off, len: e.len, df: e.df }] as [string, PostingEntry],
      );
      const baseDocsPayload = await readGenerationFileCheckedAsync(baseDocsPath, BASE_DOCS_MAGIC, BASE_DOCS_VERSION, r.baseDocsInfo);
      const baseDocs = await readBaseDocsImageAsync(baseDocsPayload);
      const containers = await TextIndex.prepareRebaseContainers(dictEntries, baseDocs.keys, baseDocs.docLens);
      const finalPostingsPath = tmpDir !== null ? this.textPostingsPath(name) : postingsPath;
      if (tmpDir !== null) await fs.rename(postingsPath, finalPostingsPath);
      ti.commitRebase({
        postingsPath: finalPostingsPath,
        containers,
        liveCount: r.liveCount,
        postingsFileInfo: r.postingsInfo,
      });
      if (!handle.inline) this.stats.textWorkerBuilds++;
      return handle.inline ? 'inline' : 'worker';
    } catch (e) {
      ti.abortRebase();
      throw e;
    } finally {
      slotRelease?.();
      if (tmpDir !== null) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      } else {
        // Scratch artifacts: the dictionary/base-docs images were commit-time
        // evidence only — the committed base is the postings file alone,
        // which stays live and is dropped with the whole scratch dir on
        // close. (A failed build's partial postings file is overwritten by
        // the next attempt and removed with the dir as well.)
        await fs.rm(path.join(output!.dir, textDictionaryFile(name)), { force: true }).catch(() => {});
        await fs.rm(path.join(output!.dir, `${textDocsFile(name)}.base`), { force: true }).catch(() => {});
      }
    }
  }

  /** Stable generation status: the generation this instance loaded at open or
   *  last published (null when running on the legacy recovery path). */
  getIndexGeneration(): { id: string; createdAt: number; walCheckpoint: number; records: number } | null {
    return this.generationBuilder.getIndexGeneration();
  }

  private async loadIndexDefinitions(): Promise<void> {
    return this.indexAdmin.loadIndexDefinitions(this.indexPath);
  }
  /** Persist the given secondary-index definition list. The CONTENT is the
   *  caller's transaction decision (live list ± the mutation), never an
   *  implicit snapshot of the registry — a create persists live+staged BEFORE
   *  publishing, a drop persists live-minus BEFORE removing. */
  private async persistIndexDefinitions(defs: IndexInfo[]): Promise<void> {
    await writeFileAtomic(this.indexPath, JSON.stringify(defs), { stats: this.stats });
  }
  private async loadTextIndexDefinitions(): Promise<void> {
    return this.textRegistry.loadTextIndexDefinitions();
  }
  /** Persist the given text-index definition list (same transaction-content
   *  rule as persistIndexDefinitions). This is the registry's persistence
   *  SEAM (injected into TextRegistry): kept on MiniDb so tests can stub it
   *  on the instance. */
  private async persistTextIndexDefinitions(defs: TextIndexDef[]): Promise<void> {
    await writeFileAtomic(path.join(this.dir, TEXT_INDEXES_FILE), JSON.stringify(defs), { stats: this.stats });
  }
  private async loadCompoundIndexDefinitions(): Promise<void> {
    return this.indexAdmin.loadCompoundIndexDefinitions(this.compoundIndexPath);
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
    if (this.autoCompact && !this.compacting && shouldCompact(this)) this.submitCompaction().catch(() => {});
    this.maybeAutoGenerationBuild();
  }

  /** The staleness rule shared by the runtime wal-growth trigger and the
   *  close-time best-effort publish: no valid current generation while there
   *  is data worth checkpointing (a writer that started from an empty db and
   *  grew its WAL past the threshold without ever reaching the compaction
   *  threshold — the window the open-time kick cannot cover), or the WAL
   *  grew/rotated past the threshold since the current generation's
   *  checkpoint (a rotated-away anchor reads as a negative drift). */
  private generationStale(): boolean {
    if (this.readOnly || !this.indexGenerationsEnabled || this.state !== 'open') return false;
    const gen = this.generationInfo;
    const walOffset = this.wal.appendOffset;
    return gen === null
      ? this.store.size > 0 && walOffset >= GEN_BUILD_WAL_DELTA_BYTES
      : walOffset - gen.walCheckpoint >= GEN_BUILD_WAL_DELTA_BYTES || walOffset < gen.walCheckpoint;
  }

  /** Runtime generation-availability trigger, riding the per-write
   *  maintenance hook (maybeAutoCompact): kick a background generation build
   *  when the current generation is missing/stale. Throttled per instance,
   *  with a longer backoff after a failed/aborted build so a hopelessly
   *  churning writer is not re-kicked every interval; the scheduler's
   *  same-kind dedupe makes a redundant kick cheap. */
  private maybeAutoGenerationBuild(): void {
    const now = Date.now();
    if (now - this.lastGenBuildKickAt < this.genBuildKickMinIntervalMs) return;
    if (now - this.lastGenBuildFailureAt < this.genBuildKickFailureBackoffMs) return;
    if (!this.generationStale()) return;
    this.lastGenBuildKickAt = now;
    void this.buildGeneration('wal-growth').catch(() => {});
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

  private writeDisabledError(): Error {
    return this.walGroups.writeDisabledError();
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
    this.memoryGuard.touchAccess(pk);
  }

  private seedAccessFromStore(): void {
    this.memoryGuard.seedAccessFromStore();
  }

  private async evictKey(pk: string): Promise<void> {
    return this.writePath.evictKey(pk);
  }

  // ---- KV API -------------------------------------------------------------

  get(key: string | Buffer): V | undefined {
    return this.readPath.get(key);
  }

  /** Async value resolution for a canonical key (see ReadPath.readValueAsync). */
  private async readValueAsync(kstr: string): Promise<Buffer | undefined> {
    return this.readPath.readValueAsync(kstr);
  }

  /** Async twin of get() (stage 6, additive): identical result; only the
   *  disk-mode value read moves off the event loop. */
  async getAsync(key: string | Buffer): Promise<V | undefined> {
    return this.readPath.getAsync(key);
  }

  getRecord(key: string | Buffer): DocRecord<V> | undefined {
    return this.readPath.getRecord(key);
  }

  async set(key: string | Buffer, value: V, { ttl, dt }: SetOptions = {}): Promise<void> {
    return this.writePath.set(key, value, { ttl, dt });
  }

  async del(key: string | Buffer): Promise<boolean> {
    return this.writePath.del(key);
  }

  /** Atomically apply a batch of operations (all-or-nothing). */
  async batch(ops: readonly BatchInputOp<V>[]): Promise<void> {
    return this.writePath.batch(ops);
  }

  /** The unguarded restore core behind restoreKey and the flush-group
   *  rollback: put the key back to `prev` across the store and every derived
   *  index (TTL/access/dt/secondary/compound/text). */
  private restoreGroupKey(pk: string, prev: StoreRecord | undefined): void {
    this.writePath.restoreGroupKey(pk, prev);
  }

  /** Apply one recovered WAL frame during catchUpFromWal: the same ops
   *  open-time recovery derives from it (frameToOps), plus the incremental
   *  derived-index maintenance applyOp performs on the write path — minus
   *  unique checks: the writer already validated, and intermediate frame
   *  states must apply literally (LWW). */
  private applyRecoveredFrame(f: FrameRef, fd: number): void {
    this.writePath.applyRecoveredFrame(f, fd);
  }

  private applyRecoveredOp(op: RecoveredOp): void {
    this.writePath.applyRecoveredOp(op);
  }

  has(key: string | Buffer): boolean {
    return this.readPath.has(key);
  }
  get size(): number {
    return this.store.size;
  }
  async mset(entries: readonly (readonly [string, V])[]): Promise<void> {
    if (!entries.length) return;
    await this.batch(entries.map(([key, value]) => ({ op: 'set' as const, key, value })));
  }
  mget(keys: readonly string[]): (V | undefined)[] {
    return this.readPath.mget(keys);
  }

  async expire(key: string | Buffer, ttlMs: number): Promise<boolean> {
    return this.writePath.expire(key, ttlMs);
  }

  ttl(key: string | Buffer): number {
    return this.readPath.ttl(key);
  }

  // ---- key-ordered scans --------------------------------------------------

  scan(opts: RangeOptions<string> = {}): ScanEntry<V>[] {
    return this.readPath.scan(opts);
  }

  prefix(p: string, limit = Infinity): ScanEntry<V>[] {
    return this.readPath.prefix(p, limit);
  }

  // ---- dt column queries --------------------------------------------------

  dtColumns(): string[] {
    return this.readPath.dtColumns();
  }

  dtRange(col: string, opts: RangeOptions<number> & { limit?: number } = {}): (ScanEntry<V> & { dtValue: number })[] {
    return this.readPath.dtRange(col, opts);
  }

  // ---- value secondary indexes -------------------------------------------

  async createIndex(name: string, opts: IndexDef): Promise<void> {
    return this.indexAdmin.createIndex(name, opts);
  }
  async dropIndex(name: string): Promise<boolean> {
    return this.indexAdmin.dropIndex(name);
  }
  listIndexes(): IndexInfo[] {
    return this.indexAdmin.listIndexes();
  }
  findEq(name: string, value: unknown): { key: string; value: V | undefined }[] {
    return this.indexAdmin.findEq(name, value);
  }
  findRange(name: string, opts: Parameters<IndexManager['findRange']>[1]): { key: string; value: V | undefined; field: number }[] {
    return this.indexAdmin.findRange(name, opts);
  }

  // ---- compound indexes (groupBy + orderBy) -------------------------------

  async createCompoundIndex(name: string, def: CompoundIndexDef): Promise<void> {
    return this.indexAdmin.createCompoundIndex(name, def);
  }

  async dropCompoundIndex(name: string): Promise<boolean> {
    return this.indexAdmin.dropCompoundIndex(name);
  }

  listCompoundIndexes(): CompoundIndexInfo[] {
    return this.indexAdmin.listCompoundIndexes();
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
    return this.indexAdmin.compoundRange(name, groupValue, opts);
  }

  // ---- full-text search ---------------------------------------------------

  async createTextIndex(
    name: string,
    { fields, tokenizer }: { fields?: readonly string[]; tokenizer?: TextIndexTokenizerName } = {},
  ): Promise<void> {
    return this.textRegistry.createTextIndex(name, { fields, tokenizer });
  }
  async dropTextIndex(name: string): Promise<boolean> {
    return this.textRegistry.dropTextIndex(name);
  }

  search(name: string, q: string, opts: { op?: 'AND' | 'OR'; limit?: number; maxVisits?: number } = {}): { key: string; value: V | undefined; score: number }[] {
    return this.textRegistry.search(name, q, opts);
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
    return this.textRegistry.searchBounded(name, q, opts);
  }

  /** Async twin of searchBounded (stage 6, additive): identical hits and
   *  budget accounting; the postings reads and the disk-mode value reads run
   *  off the event loop. The server's search path prefers this variant. */
  async searchBoundedAsync(
    name: string,
    q: string,
    opts: { op?: 'AND' | 'OR'; limit?: number; maxVisits?: number } = {},
  ): Promise<{ hits: { key: string; value: V; score: number }[]; visits: number; truncated: boolean }> {
    return this.textRegistry.searchBoundedAsync(name, q, opts);
  }

  /** Async convenience: the async counterpart of search(). */
  async searchAsync(
    name: string,
    q: string,
    opts: { op?: 'AND' | 'OR'; limit?: number; maxVisits?: number } = {},
  ): Promise<{ key: string; value: V | undefined; score: number }[]> {
    return this.textRegistry.searchAsync(name, q, opts);
  }

  // ---- unified query ------------------------------------------------------

  query(q: QueryOptions = {}): ScanEntry<V>[] {
    return this.queryEngine.query(q);
  }

  /** Async twin of query() (stage 6, additive): identical results and
   *  ordering; the disk-mode value reads (and the text branch's postings
   *  reads) run off the event loop. The candidate-collection logic mirrors
   *  query() exactly — keep both in sync when the query planner changes. */
  async queryAsync(q: QueryOptions = {}): Promise<ScanEntry<V>[]> {
    return this.queryEngine.queryAsync(q);
  }

  /** The rejection a write op gets while a backup holds the write gate: the
   *  fence is short (file copies) and retryable, so callers can simply
   *  re-issue the write afterwards. */
  private backupInProgressError(): Error {
    return newBackupInProgressError();
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
    return runBackup(this.backupDeps, destDir, opts);
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
    return renewMiniDbLock(this);
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
    await this.submitCompaction();
  }

  /** Stage 6: observable maintenance state (queued/running/publishing plus
   *  the recent failed/complete history). The public read model of the
   *  internal scheduler — callers never see workers or file details. */
  maintenanceStatus(): MaintenanceTaskInfo[] {
    return this.maintenance.status();
  }

  async close(): Promise<void> {
    return closeMiniDb(this, this.lifecycleHooks);
  }

  private ensureOpen(): void {
    if (this.state !== 'open') throw new Error('MiniDb is closed');
  }
  private ensureWritable(): void {
    if (this.readOnly) throw new Error('MiniDb is open in read-only mode');
    if (this.writeDisabled) throw this.writeDisabledError();
  }
}
