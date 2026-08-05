// src/generation-builder.ts
//
// MiniDb's persistent-index-generation machinery (stage 5/6) as a facet: the
// generation load path (tryLoadGeneration and its image loaders), the build
// path (buildGeneration/runGenerationBuild), and the genBuild state the live
// write paths feed.
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
//
// Everything the machinery needs from MiniDb (dir/WAL/store/codec config, the
// live index managers, the text registry, the maintenance scheduler, the
// write-path replay callback, lifecycle gates) is injected through
// GenerationBuilderDeps, so this module never imports the MiniDb class
// itself. The genBuild state object is shared BY REFERENCE with the owner's
// write paths (they push applied ops and set `aborted` through MiniDb's
// private views).

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  SNAPSHOT_FILE,
  GENERATION_FORMAT_VERSION,
  STORE_IMAGE_FILE,
  DT_INDEX_FILE,
  SECONDARY_INDEX_FILE,
  COMPOUND_INDEX_FILE,
  GEN_SNAPSHOT_FILE,
  generationId,
  indexDefHash,
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
  writeManifest,
} from './generation-files.js';
import {
  readGenerationFileCheckedAsync,
  readTextDictionaryImageAsync,
  writeStoreImage,
  writeDtIndexImage,
  writeSecondaryIndexImage,
  writeCompoundIndexImage,
  writeTextDictionaryImage,
  writeTextDocsImage,
} from './gen-codec.js';
import type { StoreImageRecord, TextDocsImage } from './gen-codec.js';
import { IndexManager } from './index-manager.js';
import { DtIndex } from './dt-index.js';
import { CompoundIndexManager } from './compound-index.js';
import { TextIndex } from './text-index/index.js';
import type { TextIndexBuild } from './text-index/index.js';
import type { PostingEntry } from './text-postings.js';
import { TextRegistry } from './text-registry.js';
import type { TextIndexDef } from './text-registry.js';
import { ValueReader } from './value-reader.js';
import type { RecoveryMode, RecoveryInfo, ValueMode, RecoveredOp } from './recovery.js';
import { fsyncDir } from './compaction.js';
import { defaultWorkerSlots } from './maintenance.js';
import type { MaintenanceContext, MaintenanceScheduler } from './maintenance.js';
import { startWorkerTextBuild, textBuildWorkerAvailable, verifyFileCrcAsync, WorkerTextBuildError } from './worker/text-build.js';
import type { WorkerTextBuildHandle, TextBuildCheckpoint } from './worker/text-build.js';
import { readBaseDocsImageAsync, BASE_DOCS_MAGIC, BASE_DOCS_VERSION } from './worker/text-build-core.js';
import type { TextBuildCoreResult } from './worker/text-build-core.js';
import { TYPE_SET } from './codec.js';
import { GenerationLoader } from './generation-loader.js';
import { yieldToLoop } from './text-index/tokenize.js';
import type { Store } from './store.js';
import type { ValueRef } from './store.js';
import type { WAL } from './wal.js';
import type { ValueCodecName } from './types.js';

/** The open-time index rebuild yields to the event loop every this many
 *  records, so a huge Store walk never hard-blocks the host (mirrors the
 *  BUILD_YIELD_DOCS watermark in text-index/builder.ts — 512 records bounds a
 *  slice at ~20ms even when the walk feeds staged n-gram text builds, the
 *  stage-6 per-slice CPU budget). Shared with the generation build's store
 *  walk. */
export const REBUILD_YIELD_DOCS = 512;

/** One write op captured by an in-flight generation build (stage 5). The
 *  build walks the live store and then drains this queue onto its detached
 *  states, so the image equals replaying snapshot + WAL up to the sealed
 *  checkpoint exactly. `storeOnly` marks expire()'s TTL-only rewrite: the
 *  value is unchanged, so value-derived index states need no re-feed. */
export interface GenBuildOp {
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
export class GenerationBuildAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationBuildAborted';
  }
}

/** Soft caps on the generation build's mutation queue: a write storm outrun-
 *  ning the build's drain aborts the build instead of buffering unboundedly —
 *  bounded both by op count and by accumulated value bytes (each queued op
 *  pins its value buffer). */
export const GEN_BUILD_QUEUE_CAP = 1_000_000;
export const GEN_BUILD_QUEUE_BYTES_CAP = 512 * 1024 * 1024;

/** Trigger-(b) thresholds for the open-time background build: a generation
 *  whose WAL delta replay exceeded either is refreshed in the background so
 *  the next open is cheap (the per-op replay path is for small deltas only). */
export const GEN_BUILD_WAL_DELTA_OPS = 4096;
export const GEN_BUILD_WAL_DELTA_BYTES = 4 * 1024 * 1024;

/** Below this live-doc count the stage-6 worker spawn is not worth it: the
 *  in-thread staged build finishes in milliseconds, so the corpus threshold
 *  keeps small databases on the zero-overhead path. */
export const TEXT_BUILD_WORKER_MIN_DOCS = 4096;

/** The stats counters the generation paths touch (a structural view of
 *  MiniDb's stats object). */
export interface GenerationStats {
  generationBuilds: number;
  generationBuildErrors: number;
  generationBuildAborts: number;
  generationBuildDurationMs: number;
  generationLoads: number;
  generationLoadFallbacks: number;
  lastGenerationFallback: string | null;
  generationLoadDurationMs: number;
  generationIndexRebuilds: number;
  textRebuildDurationMs: number;
  textWorkerBuilds: number;
  textWorkerFallbacks: number;
  lastTextWorkerFallback: string | null;
  textWorkerErrors: number;
  dirFsyncUnsupported: boolean;
}

/** The owner-injected surface the generation machinery needs (see the
 *  header). Index managers and the text registry are stable references;
 *  everything reassigned during open/recovery is read lazily through getters. */
export interface GenerationBuilderDeps<V> {
  dir: () => string;
  walPath: () => string;
  codecName: () => ValueCodecName;
  valueMode: () => ValueMode;
  readOnly: () => boolean;
  state: () => 'open' | 'closing' | 'closed';
  indexGenerationsEnabled: () => boolean;
  store: () => Store;
  wal: () => WAL;
  getValueReader: () => ValueReader | undefined;
  setValueReader: (reader: ValueReader | undefined) => void;
  setRecoveryInfo: (info: RecoveryInfo) => void;
  maintenance: () => MaintenanceScheduler;
  maintenanceTaskCtx: () => MaintenanceContext | null;
  textBuildWorkerEnabled: () => boolean;
  textWorkerDisabled: () => boolean;
  /** Sticky fallback: a worker that failed to produce ANY result once
   *  disables the worker path for the rest of the instance. */
  disableTextWorker: () => void;
  textBuildMemoryBytes: () => number;
  dt: DtIndex;
  indexes: IndexManager;
  compound: CompoundIndexManager;
  textRegistry: TextRegistry<V>;
  stats: GenerationStats;
  decode: (b: Buffer | undefined) => V | undefined;
  indexable: (v: unknown) => v is Record<string, unknown>;
  /** Live records (decoded values), for per-index rebuilds. */
  liveRecords: () => Generator<{ key: Buffer; value: V | undefined; dt: Record<string, number> | null }>;
  /** Live records with untyped decoded values, for secondary-index rebuilds. */
  liveRecordsRaw: () => Generator<{ key: Buffer; value: unknown }>;
  /** Live indexable records with canonical keys, for text-index rebuilds. */
  textRecords: () => Generator<{ key: string; value: unknown }>;
  /** Re-seed the memory guard's access set after a store swap. */
  seedAccessFromStore: () => void;
  /** Apply one recovered WAL op onto the loaded store + every derived index. */
  applyRecoveredOp: (op: RecoveredOp) => void;
  ensureOpen: () => void;
  ensureWritable: () => void;
  /** The owner's bounded full-corpus build (worker/inline + rebase — see
   *  MiniDb.boundedTextBuild); the loader calls it with the candidate
   *  generation's manifest checkpoint, createTextIndex with a fresh seal. */
  boundedTextBuild: (name: string, ti: TextIndex, def: TextIndexDef, checkpoint: TextBuildCheckpoint | null) => Promise<'worker' | 'inline' | null>;
  /** Called when a build fails for ANY reason (abort included), so the
   *  owner's runtime WAL-growth trigger can back off instead of re-kicking
   *  a build every interval on a hopelessly churning writer. */
  noteBuildFailure?: () => void;
}

export class GenerationBuilder<V> {
  /** Abort handle for the in-flight generation build's worker (stage 6):
   *  close() and the maintenance scheduler cancel through it. Non-private
   *  (package-internal by convention): MiniDb's close path reads it through
   *  a private view. */
  genBuildAbort: AbortController | null = null;
  /** The in-flight generation build's mutation queue registration (stage 5):
   *  while non-null, applyOp (and expire()'s TTL rewrite) push every applied
   *  op here so the build's detached states converge on the exact checkpoint.
   *  `wal` pins the WAL identity the build measured — a compaction rotation
   *  replaces it and aborts the build (its disk refs would point into rotated
   *  files). `aborted` is set by the rollback path (restoreGroupKey), which
   *  mutates the store outside applyOp and therefore outside the queue.
   *  Non-private: the owner's write paths feed it through a shared reference. */
  genBuild: { queue: GenBuildOp[]; bytes: number; wal: WAL; aborted: boolean } | null = null;
  /** Single-flight guard for generation builds (open-time background builds
   *  dedupe onto it; a compaction-triggered build awaits an in-flight one —
   *  which the rotation just aborted — before starting fresh). close() drains
   *  it before releasing resources. Non-private (see genBuildAbort). */
  genBuildPromise: Promise<void> | null = null;
  /** The generation this instance loaded at open or last published (null when
   *  running on the legacy recovery path). Stable status surface — see
   *  getIndexGeneration(). Non-private (see genBuildAbort). */
  generationInfo: { id: string; createdAt: number; walCheckpoint: number; records: number } | null = null;

  private readonly loader: GenerationLoader<V>;

  constructor(private readonly deps: GenerationBuilderDeps<V>) {
    this.loader = new GenerationLoader<V>(deps, (info) => {
      this.generationInfo = info;
    });
  }

  /** The generation-load entry point from open() (see
   *  GenerationLoader.tryLoadGeneration). */
  async tryLoadGeneration(mode: RecoveryMode): Promise<boolean> {
    return this.loader.tryLoadGeneration(mode);
  }

  /** Single-flight generation build entry point. 'open' — and the
   *  opportunistic 'wal-growth'/'close' kicks — dedupe onto an in-flight
   *  build; 'compact'/'manual' await the in-flight one (a rotation or their
   *  own trigger just made it abort) and then build fresh. The build itself
   *  runs as a maintenance-scheduler task (stage 6): mutual exclusion with
   *  compaction, disk preflight, and shutdown cancellation. */
  async buildGeneration(trigger: 'open' | 'compact' | 'manual' | 'wal-growth' | 'close'): Promise<void> {
    if (this.deps.readOnly() || !this.deps.indexGenerationsEnabled()) return;
    if (this.deps.state() !== 'open') return;
    if (this.genBuildPromise) {
      if (trigger === 'open' || trigger === 'wal-growth' || trigger === 'close') return this.genBuildPromise;
      if (this.deps.maintenanceTaskCtx() !== null && this.deps.maintenance().hasQueued('generation-build')) {
        // Inside the compaction task (onCompacted): a QUEUED build waits for
        // exactly this task, so awaiting it here would self-deadlock the
        // one-at-a-time scheduler. It runs right after this task over the
        // post-rotation state — the hook's requirement is already satisfied.
        return;
      }
      // A RUNNING in-flight build is being aborted by the rotation this
      // trigger accompanies; wait for it to die, then build fresh.
      await this.genBuildPromise.catch(() => {});
    }
    const run = this.deps.maintenance().submit('generation-build', (ctx) => this.runGenerationBuild(ctx));
    this.genBuildPromise = run;
    try {
      await run;
    } finally {
      if (this.genBuildPromise === run) this.genBuildPromise = null;
    }
  }

  /** The build itself: detached-state walk + mutation queue + seal + file
   *  writes + atomic publish, then retention cleanup. See the section header.
   *
   *  Stage 6: for BUILT-IN-tokenizer text indexes on a large-enough corpus
   *  the postings artifacts (tokenization, aggregation, segmented external
   *  merge, dictionary + base-docs images) are produced by a worker thread
   *  against the pinned checkpoint (worker/text-build-core.ts); the main
   *  thread verifies the worker's output (sanity + streaming crc) and swaps
   *  the live base in via commitRebase, and the stage-5 atomic publish stays
   *  the safety boundary — the worker only ever writes inside the tmp
   *  generation directory. Custom-tokenizer indexes, small corpora, worker
   *  slot pressure, and deployments without the worker file stay on the
   *  in-thread staged build. */
  private async runGenerationBuild(ctx: MaintenanceContext): Promise<void> {
    const t0 = performance.now();
    const gens = generationsDir(this.deps.dir());
    const prevCurrent = await readCurrent(this.deps.dir());
    const existing = await listGenerations(this.deps.dir());
    const nextN = Math.max(prevCurrent ? (existing.find((g) => g.id === prevCurrent)?.n ?? 0) : 0, existing[0]?.n ?? 0) + 1;
    const id = generationId(nextN);
    const tmpName = `${id}.tmp-${process.pid}`;
    const tmpDir = path.join(gens, tmpName);

    const gb = { queue: [] as GenBuildOp[], bytes: 0, wal: this.deps.wal(), aborted: false };
    // Detached derived states (never touched by the live write paths).
    const dtB = new DtIndex();
    const secB = new IndexManager();
    for (const d of this.deps.indexes.list()) secB.create(d.name, d);
    const cmpB = new CompoundIndexManager();
    for (const d of this.deps.compound.list()) cmpB.create(d.name, { groupBy: d.groupBy, orderBy: d.orderBy, orderType: d.orderType });
    const imageRecords = new Map<string, { ref: ValueRef; expireAt: number; dt: Record<string, number> | null }>();
    const textBuilds = new Map<string, { ti: TextIndex; b: TextIndexBuild }>();
    /** Dirty text indexes assigned to the stage-6 worker build (their live
     *  rebase capture starts at the seal; the base arrives from the worker). */
    const workerTargets = new Map<string, { ti: TextIndex; def: TextIndexDef | undefined }>();
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
            if (this.deps.indexable(op.canonical)) secB.add(op.pk, op.canonical);
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
      if (this.deps.wal() !== gb.wal) throw new GenerationBuildAborted('compaction rotation replaced the WAL');
      if (this.deps.state() !== 'open') throw new GenerationBuildAborted('instance is closing');
      if (gb.queue.length > GEN_BUILD_QUEUE_CAP || gb.bytes > GEN_BUILD_QUEUE_BYTES_CAP) {
        throw new GenerationBuildAborted('write storm outran the build');
      }
    };

    // Stage 6: the worker build's owner-side abort. The maintenance
    // scheduler's cancellation (shutdown) feeds it; close() aborts it
    // directly. The worker is cancellable/discardable at any point — its
    // output only exists inside the tmp generation directory.
    const aborter = new AbortController();
    this.genBuildAbort = aborter;
    const onCtxAbort = (): void => aborter.abort();
    ctx.signal.addEventListener('abort', onCtxAbort, { once: true });
    let workerHandle: WorkerTextBuildHandle | null = null;
    let workerSlotRelease: (() => void) | null = null;
    /** Integrity records of the worker-produced artifacts, per index name
     *  (the manifest records THESE, the files already verified). */
    const workerResults = new Map<string, TextBuildCoreResult['indexes'][number]>();

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
      // re-published by link below. Bounded-build-eligible indexes skip the
      // staging here — their capture (beginRebase) starts at the seal, and the
      // build runs on the bounded engine (worker thread, or the inline core
      // when the worker entry file is absent — e.g. a single-file deployment;
      // the unbounded staged aggregation keeps only tiny corpora, custom
      // tokenizers, and the explicit rollback switches).
      const workerOk = this.deps.textBuildWorkerEnabled() && !this.deps.textWorkerDisabled();
      for (const [name, ti] of this.deps.textRegistry.text) {
        try {
          if (!ti.needsRebuild()) {
            textClean.set(name, ti);
            continue;
          }
          if (workerOk && !ti.hasCustomTokenizer && this.deps.store().size >= TEXT_BUILD_WORKER_MIN_DOCS) {
            workerTargets.set(name, { ti, def: this.deps.textRegistry.textDefs.find((d) => d.name === name) });
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
      for (const kstr of this.deps.store().rawKeys()) {
        const rec = this.deps.store().map.get(kstr);
        if (!rec) continue;
        imageRecords.set(kstr, { ref: rec.ref, expireAt: rec.expireAt, dt: rec.dt });
        dtB.set(kstr, rec.dt);
        if (needValues) {
          const buf = rec.ref.kind === 'memory' ? rec.ref.value : this.deps.getValueReader()!.read(rec.ref.loc);
          const doc = this.deps.decode(buf);
          if (this.deps.indexable(doc)) {
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
      // WAL watermark read form ONE synchronous segment — no op can
      // interleave, so the image equals replaying every frame below the
      // checkpoint exactly. With worker targets the same segment also starts
      // their rebase capture (every op after the watermark is queued for the
      // swap-time replay). The WAL flush is UNCONDITIONAL: it settles every
      // frame below the checkpoint (chaining onto an in-flight batch, writing
      // out a queued one), so a later flush-group failure can never roll back
      // a write the published image already contains; for worker targets it
      // also lands those frames durably before the worker reads them (frames
      // at/after the watermark are covered by the rebase queue, never by the
      // worker).
      drainQueue();
      checkAlive();
      this.genBuild = null;
      sealedOffset = gb.wal.appendOffset;
      if (workerTargets.size > 0) {
        for (const [, { ti }] of workerTargets) ti.beginRebase();
      }
      await gb.wal.flush();
      checkAlive();

      // Phase 2: commit the staged text builds — each writes its postings file
      // into the tmp dir, swaps the LIVE base onto it (the compaction-time
      // rebase that replaces rebuildTextPostings), and replays its queue.
      const textStates = new Map<string, ReturnType<TextIndex['exportImageState']>>();
      for (const [name, tb] of textBuilds) {
        await tb.b.commit();
        textStates.set(name, await tb.ti.exportImageStateAsync());
        checkAlive();
      }

      // Stage 6: launch the worker build for its targets NOW (it runs in
      // parallel with the main thread's image writes below). The checkpoint
      // is pinned by the seal above; the spec's anchors pin the exact inodes.
      if (workerTargets.size > 0) {
        const snapPath = path.join(this.deps.dir(), SNAPSHOT_FILE);
        const walAnchor = fsSync.statSync(this.deps.walPath());
        let snapAnchor: fsSync.Stats | null = null;
        try {
          snapAnchor = fsSync.statSync(snapPath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        // Host the bounded build in a worker thread when its entry file
        // exists; otherwise run the SAME bounded core inline on the main
        // thread (worker-slot pressure, or a bundled single-file deployment
        // without the worker file). Inline is still memory-bounded — the
        // unbounded staged aggregation is NOT the fallback here.
        const workerAvailable = textBuildWorkerAvailable();
        workerSlotRelease = workerAvailable ? defaultWorkerSlots.tryAcquire() : null;
        const inline = workerSlotRelease === null;
        workerHandle = startWorkerTextBuild(
          {
            snapshotPath: snapAnchor ? snapPath : null,
            walPath: this.deps.walPath(),
            walOffset: sealedOffset,
            walDev: walAnchor.dev,
            walIno: walAnchor.ino,
            snapshotDev: snapAnchor?.dev ?? 0,
            snapshotIno: snapAnchor?.ino ?? 0,
            indexes: [...workerTargets].map(([name, { def }]) => ({
              name,
              fields: def?.fields ?? null,
              tokenizer: def?.tokenizer === 'ngram' ? ('ngram' as const) : ('default' as const),
              postingsPath: path.join(tmpDir, textPostingsFile(name)),
              dictionaryPath: path.join(tmpDir, textDictionaryFile(name)),
              baseDocsPath: path.join(tmpDir, `${textDocsFile(name)}.base`),
            })),
            memoryBudgetBytes: this.deps.textBuildMemoryBytes(),
          },
          {
            signal: aborter.signal,
            shouldAbort: () => gb.aborted || this.deps.wal() !== gb.wal || this.deps.state() !== 'open',
            inline,
            inlineReason: workerAvailable ? 'slot-pressure' : 'runtime-unavailable',
            onFallback: (reason) => {
              this.deps.stats.textWorkerFallbacks++;
              this.deps.stats.lastTextWorkerFallback = reason;
            },
          },
        );
        // The worker can reject (owner abort / cancel / crash) while the main
        // thread is still in the image-write phase below — the rejection is
        // only consumed at the await after that phase. Attach a no-op handler
        // NOW so the gap is never flagged as an unhandled rejection.
        workerHandle.promise.catch(() => {});
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
          textStates.set(name, await ti.exportImageStateAsync());
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

      // Stage 6: collect the worker build. Verification before anything is
      // trusted (design rule 3: worker output is verifiable): (a) the
      // worker's reconstructed live-key count must not exceed the checkpoint
      // image (a worker that saw MORE than the main thread means the pinning
      // protocol broke); (b) every produced file is re-verified by streaming
      // crc against the worker's report. Only then does commitRebase swap
      // the live base and replay the capture queue.
      if (workerHandle) {
        let result: TextBuildCoreResult;
        try {
          result = await workerHandle.promise;
        } catch (e) {
          if (e instanceof WorkerTextBuildError && e.aborted) {
            throw new GenerationBuildAborted(`worker build cancelled: ${e.message}`);
          }
          if (!workerHandle.inline) this.deps.stats.textWorkerErrors++;
          throw e;
        }
        checkAlive();
        if (result.scannedLiveKeys > imageRecords.size) {
          throw new Error(
            `worker build scanned ${result.scannedLiveKeys} live keys > checkpoint image ${imageRecords.size} (pinning protocol violation)`,
          );
        }
        for (const r of result.indexes) {
          const target = workerTargets.get(r.name);
          if (!target) continue;
          const postingsPath = path.join(tmpDir, textPostingsFile(r.name));
          const dictionaryPath = path.join(tmpDir, textDictionaryFile(r.name));
          const baseDocsPath = path.join(tmpDir, `${textDocsFile(r.name)}.base`);
          // The postings file is a RAW artifact (whole-file crc): verify it
          // by streaming re-hash. The dictionary/baseDocs images are
          // gen-codec envelopes — the checked reads below verify their crc
          // AND cross-check the worker's report, in slices.
          await verifyFileCrcAsync(postingsPath, r.postingsInfo);
          const dictPayload = await readGenerationFileCheckedAsync(dictionaryPath, 'MDTD', 1, r.dictionaryInfo);
          const dictEntries = (await readTextDictionaryImageAsync(dictPayload)).map(
            (e) => [e.term, { off: e.off, len: e.len, df: e.df }] as [string, PostingEntry],
          );
          const baseDocsPayload = await readGenerationFileCheckedAsync(baseDocsPath, BASE_DOCS_MAGIC, BASE_DOCS_VERSION, r.baseDocsInfo);
          const baseDocs = await readBaseDocsImageAsync(baseDocsPayload);
          const containers = await TextIndex.prepareRebaseContainers(dictEntries, baseDocs.keys, baseDocs.docLens);
          target.ti.commitRebase({
            postingsPath,
            containers,
            liveCount: r.liveCount,
            postingsFileInfo: r.postingsInfo,
          });
          textStates.set(r.name, await target.ti.exportImageStateAsync());
          workerResults.set(r.name, r);
          checkAlive();
        }
        if (!workerHandle.inline) this.deps.stats.textWorkerBuilds++;
      }

      for (const [name, state] of textStates) {
        const workerResult = workerResults.get(name);
        if (workerResult) {
          // The worker already wrote this dictionary image (verified above):
          // record its integrity info instead of rewriting the same payload.
          files[textDictionaryFile(name)] = workerResult.dictionaryInfo;
        } else {
          files[textDictionaryFile(name)] = await writeTextDictionaryImage(
            path.join(tmpDir, textDictionaryFile(name)),
            (function* (): Generator<{ term: string; off: number; len: number; df: number }> {
              for (const [term, e] of state.dict) yield { term, off: e.off, len: e.len, df: e.df };
            })(),
          );
        }
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
        } else if (workerResult) {
          // The worker wrote the postings file into the tmp dir (verified):
          // record its integrity info.
          files[textPostingsFile(name)] = workerResult.postingsInfo;
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
      const snapSrc = path.join(this.deps.dir(), SNAPSHOT_FILE);
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
      const walSt = await fs.stat(this.deps.walPath());

      // The manifest hashes exactly the indexes this image carries (a
      // definition created/dropped mid-build is simply absent — the loader
      // rebuilds or ignores it).
      const manifest: GenerationManifest = {
        format: GENERATION_FORMAT_VERSION,
        id,
        createdAt: Date.now(),
        valueCodec: this.deps.codecName(),
        valueMode: this.deps.valueMode(),
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
              const def = this.deps.textRegistry.textDefs.find((d) => d.name === name);
              return [name, def ? indexDefHash(TextRegistry.canonicalTextDef(def)) : ''];
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
      await fsyncDir(tmpDir, { strict: true, stats: this.deps.stats });
      // The publish rename is the generation build's publishing critical
      // section (stage 6): a shutdown waits for it instead of cancelling a
      // half-published generation. Everything before this line is discardable.
      ctx.markPublishing();
      // Windows cannot rename a directory with open files inside: the
      // committed bases' live handles sit in the tmp dir, so close them first
      // (repointPostings reopens at the final path below). POSIX keeps the
      // handles valid across the rename — no close needed there.
      if (process.platform === 'win32') {
        for (const [, tb] of textBuilds) tb.ti.close();
        for (const [, { ti }] of workerTargets) ti.close();
      }
      await publishGeneration(this.deps.dir(), tmpName, id, { stats: this.deps.stats });
      // Repoint EVERY live base this build (re)published into the CURRENT
      // generation: staged commits still read the (now renamed) tmp path, and
      // clean re-publishes still read their OLD location (the root file — or
      // a previous generation's — both about to be reclaimed below). Without
      // this the next clean fast path links from a deleted path and fails
      // ENOENT forever. The invariant after publish: every live text base
      // reads from inside the CURRENT generation. POSIX: same inode (the
      // hard link), just update the path string; win32: close + reopen there.
      for (const [name, tb] of textBuilds) {
        tb.ti.repointPostings(path.join(generationDir(this.deps.dir(), id), textPostingsFile(name)));
      }
      for (const [name, { ti }] of workerTargets) {
        ti.repointPostings(path.join(generationDir(this.deps.dir(), id), textPostingsFile(name)));
      }
      for (const [name, ti] of textClean) {
        if (cleanPostings.has(name)) ti.repointPostings(path.join(generationDir(this.deps.dir(), id), textPostingsFile(name)));
      }

      this.generationInfo = { id, createdAt: manifest.createdAt, walCheckpoint: sealedOffset, records: imageRecords.size };
      this.deps.stats.generationBuilds++;
      this.deps.stats.generationBuildDurationMs += performance.now() - t0;

      // Retention: keep the new and the previously-published generation; sweep
      // everything else (stray tmp dirs included). Best-effort, async.
      const keep = new Set(prevCurrent ? [id, prevCurrent] : [id]);
      void cleanupGenerations(this.deps.dir(), keep).catch(() => {});
      // The live text bases now live inside the new generation: the legacy
      // root postings files are superseded derived state — reclaim them.
      for (const name of textStates.keys()) {
        await fs.rm(this.deps.textRegistry.textPostingsPath(name), { force: true }).catch(() => {});
      }
      // The worker's base-docs sidecars served their purpose at commitRebase
      // (the final docs images were written by the main thread): reclaim them
      // from the published generation.
      for (const name of workerResults.keys()) {
        await fs.rm(path.join(generationDir(this.deps.dir(), id), `${textDocsFile(name)}.base`), { force: true }).catch(() => {});
      }
    } catch (e) {
      if (this.genBuild === gb) this.genBuild = null;
      // Uncommitted staged builds only disarm their queues (the live indexes
      // stay authoritative); committed ones keep their new base — its
      // postings file stays readable through the open fd even though the
      // stranded tmp dir is swept at the next open (POSIX; on Windows the
      // sweep fails best-effort until the handle closes).
      for (const [, tb] of textBuilds) tb.b.abort();
      // Worker targets' rebase captures disarm identically; the worker
      // itself is cancelled/discarded (its output only exists in the tmp
      // dir, never in the live generation).
      for (const [, { ti }] of workerTargets) ti.abortRebase();
      if (workerHandle) await workerHandle.cancel();
      if (e instanceof GenerationBuildAborted) {
        this.deps.stats.generationBuildAborts++;
        this.deps.noteBuildFailure?.();
        return;
      }
      this.deps.stats.generationBuildErrors++;
      this.deps.noteBuildFailure?.();
      throw e;
    } finally {
      if (this.genBuild === gb) this.genBuild = null;
      workerSlotRelease?.();
      ctx.signal.removeEventListener('abort', onCtxAbort);
      if (this.genBuildAbort === aborter) this.genBuildAbort = null;
      void sealedOffset;
    }
  }

  /** Explicit maintenance (stage 5): build + publish a fresh index generation
   *  now. Writer only. The load path is automatic; this exists for operators
   *  who want to force a checkpoint after a large burst of writes instead of
   *  waiting for the next compaction. */
  async rebuildGeneration(): Promise<void> {
    this.deps.ensureOpen();
    this.deps.ensureWritable();
    if (!this.deps.indexGenerationsEnabled()) throw new Error('index generations are disabled (OpenOptions.indexGenerations: false)');
    await this.buildGeneration('manual');
  }

  /** Stable generation status: the generation this instance loaded at open or
   *  last published (null when running on the legacy recovery path). */
  getIndexGeneration(): { id: string; createdAt: number; walCheckpoint: number; records: number } | null {
    return this.generationInfo ? { ...this.generationInfo } : null;
  }
}
