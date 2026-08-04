// src/generation-loader.ts
//
// The load half of MiniDb's persistent-index-generation machinery (see
// generation-builder.ts for the build half and the shared design notes):
// tryLoadGeneration and everything it drives — one candidate's manifest
// validation, store/index image loads with per-index rebuild fallback, the
// WAL-delta replay, and the failed-candidate reset. The deps are the same
// owner-injected surface GenerationBuilder receives (a structural subset);
// the loaded generation's status is handed back through the
// setGenerationInfo callback (the builder owns generationInfo).

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  SNAPSHOT_FILE,
  STORE_IMAGE_FILE,
  DT_INDEX_FILE,
  SECONDARY_INDEX_FILE,
  COMPOUND_INDEX_FILE,
  indexDefHash,
  textDictionaryFile,
  textPostingsFile,
  textDocsFile,
} from './generation.js';
import type { GenerationManifest } from './generation.js';
import { generationDir, listGenerations, readCurrent, readManifest } from './generation-files.js';
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
} from './gen-codec.js';
import type { StoreImageRecord } from './gen-codec.js';
import { IndexManager } from './index-manager.js';
import type { IndexInfo } from './index-manager.js';
import { CompoundIndexManager } from './compound-index.js';
import type { CompoundIndexInfo } from './compound-index.js';
import { TextRegistry } from './text-registry.js';
import type { TextIndexDef } from './text-registry.js';
import type { TextIndex } from './text-index/index.js';
import type { TextBuildCheckpoint } from './worker/text-build.js';
import { ValueReader } from './value-reader.js';
import { frameToOps } from './recovery.js';
import type { RecoveryMode, RecoveryInfo, ValueMode, RecoveredOp } from './recovery.js';
import { scanFrameRefsFdAsync } from './codec.js';
import { toKStr } from './value-codec.js';
import type { Store } from './store.js';
import type { WAL } from './wal.js';
import type { DtIndex } from './dt-index.js';
import type { ValueCodecName } from './types.js';
import type { GenerationStats } from './generation-builder.js';

/** The owner-injected surface the load path needs (a structural subset of
 *  GenerationBuilderDeps — the builder passes its own deps through). */
export interface GenerationLoaderDeps<V> {
  dir: () => string;
  walPath: () => string;
  codecName: () => ValueCodecName;
  valueMode: () => ValueMode;
  readOnly: () => boolean;
  store: () => Store;
  wal: () => WAL;
  getValueReader: () => ValueReader | undefined;
  setValueReader: (reader: ValueReader | undefined) => void;
  setRecoveryInfo: (info: RecoveryInfo) => void;
  dt: DtIndex;
  indexes: IndexManager;
  compound: CompoundIndexManager;
  textRegistry: TextRegistry<V>;
  stats: GenerationStats;
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
  /** The owner's bounded full-corpus build (worker/inline + rebase — see
   *  MiniDb.boundedTextBuild); called with the candidate generation's manifest
   *  checkpoint. Returns null when the index is ineligible for the bounded
   *  path (the caller falls back to the staged rebuild). */
  boundedTextBuild: (name: string, ti: TextIndex, def: TextIndexDef, checkpoint: TextBuildCheckpoint | null) => Promise<'worker' | 'inline' | null>;
}

export class GenerationLoader<V> {
  constructor(
    private readonly deps: GenerationLoaderDeps<V>,
    /** The loaded generation's status record (the builder owns the field). */
    private readonly setGenerationInfo: (info: { id: string; createdAt: number; walCheckpoint: number; records: number }) => void,
  ) {}

  /** Read the store image / index images of one published generation and
   *  replay the WAL past its checkpoint. Throws GenerationCorruptError for
   *  every validation/consistency failure (the caller falls back); genuine
   *  system errors propagate. On success the instance is fully recovered —
   *  store, every derived index, recoveryInfo, value reader. */
  async loadOneGeneration(id: string, mode: RecoveryMode): Promise<void> {
    const genDir = generationDir(this.deps.dir(), id);
    const manifest = await readManifest(this.deps.dir(), id);
    if (manifest.valueCodec !== this.deps.codecName()) {
      throw new GenerationCorruptError(`codec mismatch (${manifest.valueCodec} != ${this.deps.codecName()})`);
    }
    if (manifest.valueMode !== this.deps.valueMode()) {
      throw new GenerationCorruptError(`value mode mismatch (${manifest.valueMode} != ${this.deps.valueMode()})`);
    }
    const cp = manifest.checkpoint;
    // WAL anchor: the checkpoint offset only has meaning on the exact inode
    // the build measured, and the file must still reach it.
    const walSt = await fs.stat(this.deps.walPath()).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (!walSt || walSt.dev !== cp.walDev || walSt.ino !== cp.walIno || walSt.size < cp.walOffset) {
      throw new GenerationCorruptError('WAL anchor mismatch (rotated or truncated since the build)');
    }
    // Disk mode: image refs point into the generation's snapshot, which the
    // live db.snapshot still aliases (hard link) — verify the identity.
    if (this.deps.valueMode() === 'disk' && cp.snapshotIno !== 0) {
      if (!cp.snapshotLinked) throw new GenerationCorruptError('snapshot not hard-linked; disk refs unservable');
      const snapSt = await fs.stat(path.join(this.deps.dir(), SNAPSHOT_FILE)).catch((e: NodeJS.ErrnoException) => {
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
    if (this.deps.valueMode() === 'disk') {
      const reader = new ValueReader(this.deps.dir());
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
      this.deps.setValueReader(reader);
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
      if (this.deps.valueMode() === 'memory' && rec.ref.kind !== 'memory') {
        throw new GenerationCorruptError('store image carries disk refs for a memory-mode open');
      }
      records.push(rec);
    }
    this.deps.store().bulkLoadRefs(records);
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
      this.deps.dt.del(k);
      this.deps.indexes.remove(k, undefined);
      this.deps.compound.remove(k);
      for (const ti of this.deps.textRegistry.text.values()) ti.remove(k);
    }

    // Replay the WAL delta past the checkpoint with the exact same per-frame
    // interpretation the legacy recovery uses (frameToOps), maintaining every
    // derived index incrementally (applyRecoveredOp).
    const replay = await this.replayWalDelta(cp.walOffset, mode);
    // A rotation racing the load invalidates the coordinate system the
    // recoveryInfo below is anchored to (and, in disk mode, the value reader
    // attached above) — reject the candidate.
    const walAfter = await fs.stat(this.deps.walPath()).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (!walAfter || walAfter.dev !== cp.walDev || walAfter.ino !== cp.walIno) {
      throw new GenerationCorruptError('WAL rotated during generation load');
    }

    this.deps.setRecoveryInfo({
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
    });
    this.setGenerationInfo({ id, createdAt: manifest.createdAt, walCheckpoint: cp.walOffset, records: records.length });
    this.deps.seedAccessFromStore();
  }

  /** Undo any partial state a failed generation-load candidate left behind,
   *  so the next candidate (or the legacy full recovery) starts clean: the
   *  store must be empty (recovery replays into it), the value reader
   *  detached, and any postings handles the candidate attached closed (the
   *  next path re-attaches or rebuilds as needed). */
  resetAfterFailedGenerationLoad(): void {
    for (const k of this.deps.store().map.keys()) this.deps.store().del(k);
    this.deps.getValueReader()?.close();
    this.deps.setValueReader(undefined);
    for (const ti of this.deps.textRegistry.text.values()) ti.close();
  }

  /** The generation-load entry point from open(): try CURRENT's generation
   *  first, then the previous ones (their WAL anchor survives whenever no
   *  compaction intervened). Corruption-class failures try the next
   *  candidate; genuine system errors propagate. Returns false when no
   *  candidate loaded (the caller runs the legacy full recovery). */
  async tryLoadGeneration(mode: RecoveryMode): Promise<boolean> {
    const t0 = performance.now();
    const candidates: string[] = [];
    try {
      const current = await readCurrent(this.deps.dir());
      if (current) candidates.push(current);
      for (const g of await listGenerations(this.deps.dir())) {
        if (!g.tmp && g.id !== current && candidates.length < 3) candidates.push(g.id);
      }
    } catch (e) {
      this.deps.stats.generationLoadFallbacks++;
      this.deps.stats.lastGenerationFallback = `list: ${(e as Error).message}`;
      return false;
    }
    for (const id of candidates) {
      try {
        await this.loadOneGeneration(id, mode);
        this.deps.stats.generationLoads++;
        this.deps.stats.generationLoadDurationMs += performance.now() - t0;
        return true;
      } catch (e) {
        if (!(e instanceof GenerationCorruptError) && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        this.deps.stats.generationLoadFallbacks++;
        this.deps.stats.lastGenerationFallback = `${id}: ${(e as Error).message}`;
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
        this.deps.dt.loadImage(readDtIndexImage(payload));
        return;
      } catch (e) {
        if (!(e instanceof GenerationCorruptError)) throw e;
      }
    }
    this.deps.stats.generationIndexRebuilds++;
    const store = this.deps.store();
    this.deps.dt.rebuild(
      (function* (): Generator<{ key: string; dt: Record<string, number> | null }> {
        for (const rec of store.rawRecords()) yield { key: rec.kstr, dt: rec.dt };
      })(),
    );
  }

  /** Load secondary-index images for definitions whose hash still matches;
   *  rebuild exactly the affected indexes otherwise (plan: only the affected
   *  index is rebuilt, never the whole registry). */
  private async loadSecondaryImages(genDir: string, manifest: GenerationManifest): Promise<void> {
    const live = this.deps.indexes.list();
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
          this.deps.indexes.loadImage(image);
          continue;
        } catch {
          /* shape mismatch: rebuild below */
        }
      }
      this.deps.stats.generationIndexRebuilds++;
      this.rebuildOneSecondaryIndex(def);
    }
  }

  private rebuildOneSecondaryIndex(def: IndexInfo): void {
    const fresh = new IndexManager();
    fresh.create(def.name, def);
    for (const { key, value } of this.deps.liveRecordsRaw()) {
      if (this.deps.indexable(value)) fresh.add(toKStr(key), value);
    }
    this.deps.indexes.indexes.set(def.name, fresh.indexes.get(def.name)!);
  }

  /** Load compound-index images (same per-index discipline as secondary). */
  private async loadCompoundImages(genDir: string, manifest: GenerationManifest): Promise<void> {
    const live = this.deps.compound.list();
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
          this.deps.compound.loadImage(image);
          continue;
        } catch {
          /* shape mismatch: rebuild below */
        }
      }
      this.deps.stats.generationIndexRebuilds++;
      this.rebuildOneCompoundIndex(def);
    }
  }

  private rebuildOneCompoundIndex(def: CompoundIndexInfo): void {
    const fresh = new CompoundIndexManager();
    fresh.create(def.name, { groupBy: def.groupBy, orderBy: def.orderBy, orderType: def.orderType });
    for (const { key, value, dt } of this.deps.liveRecords()) {
      fresh.add(toKStr(key), value, dt);
    }
    this.deps.compound.indexes.set(def.name, fresh.indexes.get(def.name)!);
  }

  /** Load text-index images (dictionary + docs + postings attachment) for
   *  definitions whose hash still matches; rebuild exactly the affected
   *  indexes otherwise — a rebuild is the full corpus tokenization for that
   *  one index, the cost stage 5 exists to avoid on the happy path. */
  private async loadTextImages(genDir: string, manifest: GenerationManifest): Promise<void> {
    const registry = this.deps.textRegistry;
    for (const def of registry.textDefs) {
      const ti = registry.text.get(def.name);
      if (!ti) continue;
      const dictInfo = manifest.files[textDictionaryFile(def.name)];
      const docsInfo = manifest.files[textDocsFile(def.name)];
      const postingsInfo = manifest.files[textPostingsFile(def.name)];
      let attached = false;
      if (dictInfo && docsInfo && postingsInfo && manifest.indexDefs.text[def.name] === indexDefHash(TextRegistry.canonicalTextDef(def))) {
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
        this.deps.stats.generationIndexRebuilds++;
        // Large corpora take the memory-bounded build (worker/inline core +
        // rebase) pinned at the manifest's checkpoint — the staged ti.build
        // aggregates the whole term->postings map in RAM and OOMs at scale.
        // The bounded build is discardable: on ANY failure the staged
        // rebuild below is the fallback (it reads the already-loaded store,
        // so opens always complete).
        let hosted: 'worker' | 'inline' | null = null;
        try {
          hosted = await this.deps.boundedTextBuild(def.name, ti, def, manifest.checkpoint);
        } catch {
          /* fall through to the staged rebuild */
        }
        if (hosted === null) await ti.build(this.deps.textRecords());
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
    const fd = fsSync.openSync(this.deps.walPath(), 'r');
    try {
      const st = fsSync.fstatSync(fd);
      const r = await scanFrameRefsFdAsync(fd, { onCorrupt: mode, startOffset });
      let corruptBatches = 0;
      let appliedOps = 0;
      for (const f of r.frames) {
        for (const op of frameToOps(f, 'wal', fd, this.deps.valueMode(), () => corruptBatches++)) {
          this.deps.applyRecoveredOp(op);
          appliedOps++;
        }
      }
      let truncatedWal = false;
      const last = r.corruptRanges[r.corruptRanges.length - 1];
      if (last && last[1] === st.size && !this.deps.readOnly()) {
        await fs.truncate(this.deps.walPath(), last[0]);
        truncatedWal = true;
        await this.deps.wal().refreshSize();
      }
      return { walFrames: r.frames.length, walScanEnd: r.eofOffset, corruptRanges: r.corruptRanges, truncatedWal, corruptBatches, appliedOps };
    } finally {
      fsSync.closeSync(fd);
    }
  }
}
