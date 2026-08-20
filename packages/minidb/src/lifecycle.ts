// src/lifecycle.ts
//
// MiniDb's lifecycle as injected-dependency free functions: the open() flow
// (config → resolveValueMode → maintenance scheduler → lock → stale-temp
// sweep → store/WAL → definition loads → generation load or legacy recovery
// → background kicks, with the full failure cleanup) and the close() pass
// (concurrent-close sharing + the dependency-ordered resource teardown), plus
// renewLock. The functions operate on the LifecycleHost view of a MiniDb
// instance (the fields are non-private for exactly this — see MiniDb), and
// every private method the flow calls is injected through LifecycleHooks, so
// this module never imports the MiniDb class itself.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SNAPSHOT_FILE,
  WAL_FILE,
  SECONDARY_INDEXES_FILE,
  COMPOUND_INDEXES_FILE,
  SIDECAR_FILES,
  STALE_TMP_FILES,
  STALE_POSTINGS_TMP_PATTERN,
  isStaleTmpFile,
} from './generation.js';
import { readManifest, sweepGenerationTemps } from './generation-files.js';
import { MaintenanceScheduler } from './maintenance.js';
import { LockFile, LockError } from './lockfile.js';
import type { LifecycleTracker } from './lifecycle-status.js';
import { ValueReader } from './value-reader.js';
import { Store } from './store.js';
import type { StoreRecord } from './store.js';
import { WAL } from './wal.js';
import { recover } from './recovery.js';
import type { RecoveryMode, RecoveryInfo, ValueMode } from './recovery.js';
import { shouldCompact } from './compaction.js';
import type { CompactionTarget } from './compaction.js';
import { CODECS, fileSize, resolveValueMode } from './value-codec.js';
import { GEN_BUILD_WAL_DELTA_OPS, GEN_BUILD_WAL_DELTA_BYTES } from './generation-builder.js';
import type { FsyncPolicy, WalStats } from './wal.js';
import type { ValueCodec, ValueCodecName, ValueModeSetting, OpenOptions } from './types.js';

/** The private methods the lifecycle flow calls, bound by the owner. */
export interface LifecycleHooks {
  onStoreExpire: (k: string, rec: StoreRecord) => void;
  loadIndexDefinitions: () => Promise<void>;
  loadCompoundIndexDefinitions: () => Promise<void>;
  loadTextIndexDefinitions: () => Promise<void>;
  tryLoadGeneration: (mode: RecoveryMode) => Promise<boolean>;
  rebuildAllIndexes: () => Promise<void>;
  submitCompaction: () => Promise<void>;
  buildGeneration: (trigger: 'open' | 'compact' | 'manual' | 'wal-growth' | 'close') => Promise<void>;
  seedAccessFromStore: () => void;
  /** Close every live text index (open failure cleanup + the close pass). */
  closeAllTextIndexes: () => void;
  generationInfo: () => { id: string; createdAt: number; walCheckpoint: number; records: number } | null;
  /** Whether the current generation is missing or stale past the runtime
   *  staleness threshold (the wal-growth trigger's dirty rule). Drives the
   *  close-time best-effort publish. */
  generationStale: () => boolean;
  genBuildAbort: () => AbortController | null;
  genBuildPromise: () => Promise<void> | null;
  walRecoveryIdle: () => boolean;
  walRecoveryChain: () => Promise<void>;
}

/** The MiniDb field surface the lifecycle functions read/write (see the
 *  header). */
export interface LifecycleHost<V> {
  dir: string;
  walPath: string;
  indexPath: string;
  compoundIndexPath: string;
  fsyncPolicy: FsyncPolicy;
  syncIntervalMs: number;
  codecName: ValueCodecName;
  codec: ValueCodec<V>;
  valueMode: ValueMode;
  compactThresholdBytes: number;
  autoCompact: boolean;
  maxMemoryBytes: number | null;
  maxMemoryPolicy: 'reject' | 'evict-lru';
  indexGenerationsEnabled: boolean;
  textBuildWorkerEnabled: boolean;
  textBuildMemoryBytes: number;
  deferTextBuildsEnabled: boolean;
  /** Read-only deferred text builds' private scratch dir (outside the db
   *  dir), dropped on close; null when no read-only deferral ever ran. */
  roScratchDir: string | null;
  maintenanceIoConcurrency: number;
  readOnly: boolean;
  maintenance: MaintenanceScheduler;
  lock: LockFile | null;
  store: Store;
  wal: WAL;
  valueReader?: ValueReader;
  /** Per-open lifecycle telemetry (state machine + phase timings), driven by
   *  this flow and the generation loader; read via MiniDb.lifecycleStatus(). */
  lifecycle: LifecycleTracker;
  recoveryInfo: RecoveryInfo | null;
  stats: WalStats &
    CompactionTarget['stats'] & {
      recoveryDurationMs: number;
      recoveryBytes: number;
      recoveryFrames: number;
    };
  state: 'open' | 'closing' | 'closed';
  closePromise: Promise<void> | null;
  compacting: boolean;
  _compactDone: Promise<void> | null;
  _rotateLock: Promise<void> | null;
  lastCompactError: unknown;
  readonly size: number;
}

/** The open() flow: configure, acquire, recover, and kick background
 *  maintenance. On success the host instance is fully open; on failure every
 *  acquired resource is released before the error rethrows. */
export async function openMiniDb<V>(db: LifecycleHost<V>, opts: OpenOptions, hooks: LifecycleHooks): Promise<void> {
  const openT0 = performance.now();
  if (!opts || !opts.dir) throw new TypeError('MiniDb.open: opts.dir is required');
  db.dir = opts.dir;
  db.walPath = path.join(db.dir, WAL_FILE);
  db.indexPath = path.join(db.dir, SECONDARY_INDEXES_FILE);
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
  db.textBuildWorkerEnabled = opts.textBuildWorker ?? true;
  db.deferTextBuildsEnabled = opts.deferOpenTextBuilds ?? true;
  db.textBuildMemoryBytes = opts.textBuildMemoryBytes ?? db.textBuildMemoryBytes;
  db.maintenanceIoConcurrency = Math.max(1, opts.maintenanceIoConcurrency ?? db.maintenanceIoConcurrency);
  if (db.textBuildMemoryBytes <= 0 || !Number.isFinite(db.textBuildMemoryBytes)) {
    throw new RangeError('textBuildMemoryBytes must be a positive finite number');
  }
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

  // Stage 6: the maintenance scheduler (one heavy task at a time, queue
  // backpressure, disk preflight, cancellation, shutdown drain). The
  // free-space preflight estimates a task's footprint from the live file
  // sizes; a statfs failure skips the check inside the scheduler.
  db.maintenance = new MaintenanceScheduler({
    dir: db.dir,
    estimateBytes: async (kind) => {
      const dataBytes = (await fileSize(path.join(db.dir, SNAPSHOT_FILE))) + (db.wal?.size ?? 0);
      if (kind === 'compact') return dataBytes;
      // text-build: the postings output is a fraction of the data footprint —
      // estimate at the full footprint (safe upper bound; a read-only
      // instance's scratch dir shares the db's filesystem).
      if (kind === 'text-build') return dataBytes;
      // generation-build: the new generation carries derived artifacts on
      // top of the data footprint — estimate with the previous
      // generation's size when known.
      let derived = 0;
      const gen = hooks.generationInfo();
      if (gen) {
        try {
          const m = await readManifest(db.dir, gen.id);
          derived = Object.values(m.files).reduce((a, f) => a + f.bytes, 0);
        } catch {
          derived = 0;
        }
      }
      return dataBytes + derived;
    },
  });

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
    } else {
      // Report the held token BEFORE the heavy recovery work below: a
      // supervisor (another thread orchestrating this open) learns the lock
      // identity immediately and can reap the lock if this opener dies
      // mid-recovery. The callback is purely observational — a throwing
      // supervisor must not fail this open with the lock already held.
      const heldToken = db.lock.heldToken;
      if (heldToken !== undefined) {
        try {
          opts.onLockAcquired?.({ token: heldToken });
        } catch {
          // Intentionally swallowed — see above.
        }
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
    onExpire: (k, rec) => hooks.onStoreExpire(k, rec),
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
    await hooks.loadIndexDefinitions();
    await hooks.loadCompoundIndexDefinitions();
    await hooks.loadTextIndexDefinitions();

    // Stage 5: a published generation serves the open (store image +
    // derived-index images + WAL delta replay) and skips the full rebuild
    // below. Any validation failure falls back to the legacy full recovery
    // inside tryLoadGeneration — never a deletion of authoritative data.
    let generationLoaded = false;
    if (db.indexGenerationsEnabled) generationLoaded = await hooks.tryLoadGeneration(opts.recovery ?? 'resync');

    if (!generationLoaded) {
      // The loader already recorded a 'generation-load' attempt when it tried
      // candidates; none at all leaves the state at 'no-generation'. Either
      // way the legacy full recovery now runs.
      db.lifecycle.transition('full-rebuild');
      const recT0 = performance.now();
      const scanApply = { walScanMs: 0, walApplyMs: 0 };
      db.recoveryInfo = await recover({
        dir: db.dir,
        store: db.store,
        mode: opts.recovery ?? 'resync',
        truncate: !db.readOnly,
        valueMode: db.valueMode,
        timings: scanApply,
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
      db.lifecycle.time('walScanMs', scanApply.walScanMs);
      db.lifecycle.time('walApplyMs', scanApply.walApplyMs);
      db.stats.recoveryBytes += db.recoveryInfo.snapshotBytes + db.recoveryInfo.walBytes;
      db.stats.recoveryFrames += db.recoveryInfo.snapshotFrames + db.recoveryInfo.walFrames;
      // Recovery may have truncated a torn WAL tail behind the WAL's back;
      // re-sync its size bookkeeping so later appends (and their disk-mode
      // value pointers) are computed against the real, truncated file size.
      if (db.recoveryInfo.truncatedWal) await db.wal.refreshSize();
      hooks.seedAccessFromStore();
      await hooks.rebuildAllIndexes();
      db.lifecycle.time('fullRecoveryMs', performance.now() - recT0);
    }

    // A read-only instance never compacts: rotation would rename the live
    // writer's snapshot/WAL out from under it and lose its acknowledged data.
    // The writer's open-time compaction is fire-and-forget (same as
    // maybeAutoCompact): recovery already applied the full WAL, so the db is
    // complete and consistent the moment open() returns. Awaiting the
    // compaction here blocked open() on the whole snapshot rewrite + text
    // postings rebuild — tens of seconds of stalled startup on a large db.
    if (!db.readOnly && db.autoCompact && shouldCompact(db)) hooks.submitCompaction().catch(() => {});
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
        void hooks.buildGeneration('open').catch(() => {});
      }
    }
    // open() is about to return: 'ready', or 'degraded' while a deferred
    // text-index base build is still pending in the background.
    db.lifecycle.time('openMs', performance.now() - openT0);
    db.lifecycle.finishOpen();
  } catch (err) {
    // A background open-time compaction may still be in flight: settle it
    // before tearing down the WAL/store/handles it touches.
    if (db.compacting && db._compactDone) await db._compactDone.catch(() => {});
    // Release every resource acquired so far: an open that fails after the
    // WAL/store are set up must not leak a file handle or keep the everysec /
    // active-expire timers running. Text indexes are closed too: a
    // generation load may have attached postings handles before a later
    // step failed (rebuildAllIndexes' builds likewise).
    hooks.closeAllTextIndexes();
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
}

/** close(): concurrent close() calls share the one in-flight cleanup pass;
 *  after a failed pass a later call retries the remaining cleanup (the state
 *  stays 'closing' until a pass completes without errors). */
export async function closeMiniDb<V>(db: LifecycleHost<V>, hooks: LifecycleHooks): Promise<void> {
  if (db.state === 'closed') return;
  if (db.closePromise) return db.closePromise;
  const run = (async () => {
    // Best-effort generation publish BEFORE the state flip (the build guards
    // on state === 'open'): a writer closing with a missing/stale generation
    // leaves a valid checkpoint behind, so the next opener takes the cheap
    // attach path instead of the full-recovery fallback. Gated by the runtime
    // staleness rule, so a clean/small db's close pays nothing. Writes
    // landing during the build are captured by its mutation queue.
    if (hooks.generationStale()) await hooks.buildGeneration('close').catch(() => {});
    db.state = 'closing';
    await closeResources(db, hooks);
  })();
  db.closePromise = run;
  try {
    await run;
    db.state = 'closed';
  } finally {
    if (db.closePromise === run) db.closePromise = null;
  }
}

/** One cleanup pass over every held resource in dependency order (text
 *  indexes → store → valueReader → WAL → lock). Each resource's close is
 *  independently fallible and idempotent: an error is collected and the
 *  rest still run — a failed WAL close must not skip the lock release —
 *  then every collected error is rethrown as one AggregateError. The WAL
 *  failure semantics themselves are unchanged (the error propagates); only
 *  the lock release is no longer skipped because of it. */
async function closeResources<V>(db: LifecycleHost<V>, hooks: LifecycleHooks): Promise<void> {
  // Stage 6: cancel the in-flight generation build's worker FIRST (its
  // liveness check would abort it at the next checkpoint anyway, but the
  // prompt cancel reclaims the worker thread immediately), then drain the
  // maintenance scheduler: a task inside its publishing critical section
  // (compaction rotation, generation publish rename) is awaited; queued
  // and running-not-yet-publishing tasks are cancelled (plan 12's drain /
  // cancel consumed through the scheduler's OpTracker).
  hooks.genBuildAbort()?.abort();
  await db.maintenance.close();
  // Wait out an in-flight compaction, but never propagate its failure: it is
  // already accounted in lastCompactError/stats.compactErrors, and letting
  // it escape here would skip the whole cleanup pass (the caller would have
  // to close() twice to actually release the lock).
  if (db.compacting) await db._compactDone?.catch(() => {});
  // Settle an in-flight generation build (its liveness check aborts it once
  // the state flips to 'closing') before its file handles/posts are torn
  // down. Failures are already accounted in the generation stats.
  const genBuildPromise = hooks.genBuildPromise();
  if (genBuildPromise) await genBuildPromise.catch(() => {});
  // Let in-flight WAL failures and their kicked recoveries settle before
  // and after closing the WAL: a poisoned/failing close would otherwise
  // leave an un-acked tail in db.wal that a reopen replays as ghost writes.
  // Kicks arrive in op rejection microtasks that can be scheduled behind
  // this close (and the WAL's own final flush can drive a queued failing
  // batch, kicking one more recovery), so wait for the chain to be IDLE in
  // a loop instead of awaiting one snapshot of it.
  while (!hooks.walRecoveryIdle()) await hooks.walRecoveryChain();
  const errors: unknown[] = [];
  try {
    hooks.closeAllTextIndexes();
  } catch (e) {
    errors.push(e);
  }
  // Drop a read-only deferred build's private scratch dir. The postings
  // handles are closed above (fd-before-rm for Windows); the dir is outside
  // the db dir and this instance is its only owner.
  if (db.roScratchDir !== null) {
    try {
      await fs.rm(db.roScratchDir, { recursive: true, force: true });
      db.roScratchDir = null;
    } catch (e) {
      errors.push(e);
    }
  }
  try {
    db.store.close();
  } catch (e) {
    errors.push(e);
  }
  try {
    db.valueReader?.close();
  } catch (e) {
    errors.push(e);
  }
  try {
    await db.wal.close();
  } catch (e) {
    errors.push(e);
  }
  while (!hooks.walRecoveryIdle()) await hooks.walRecoveryChain();
  try {
    if (db.lock) {
      await db.lock.release();
      db.lock = null;
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

/** Refresh the write lock's timestamp (see {@link LockFile.renew}). No-op
 *  for a read-only instance. */
export async function renewMiniDbLock<V>(db: LifecycleHost<V>): Promise<void> {
  await db.lock?.renew();
}

/** Open a database, and if opening fails due to corruption (not due to a live
 *  lock), delete the directory and open a fresh empty database. Recommended for
 *  a rebuildable cache. A live lock is rethrown. `open` is the owner's factory
 *  injection (MiniDb.open).
 *
 *  The destructive rebuild only ever runs for an open that could OWN the
 *  directory: an error tagged `readOnlyOpen` (opts.readOnly, or a lock that
 *  degraded via onLockFail:'readonly') is rethrown untouched — rebuilding
 *  means deleting files, and a read-only bystander must never mutate a live
 *  writer's directory (lock-review repro: the readonly fallback deleted the
 *  writer's sidecar, and in the strict-recovery shape the whole directory).
 */
export async function openOrRebuildMiniDb<T>(
  opts: OpenOptions,
  hooks: { onRebuild?: (err: unknown) => void },
  open: (opts: OpenOptions) => Promise<T>,
): Promise<T> {
  try {
    return await open(opts);
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
        return await open(opts);
      } catch {
        /* fall through to a full rebuild */
      }
    }
    await fs.rm(opts.dir, { recursive: true, force: true });
    return open(opts);
  }
}
