// src/write-path.ts
//
// MiniDb's write path as a facet: the public write ops (set/del/batch/expire)
// and their whole commit machinery — prepare (validate/encode/canonical/
// tokenize), apply (store + derived indexes), the WAL commit bodies with
// flush-group rollback, eviction, the WAL-pointer publish, and the recovered
// op/frame apply used by open-time recovery, catch-up, and the generation
// load's WAL-delta replay.
//
// The collaborators are injected, never the MiniDb class itself: the Store /
// WAL and index managers (lazy getters or stable references), the
// WalGroupTracker / MemoryGuard / TextRegistry / GenerationBuilder facets
// (the genBuild mutation queue is fed through the shared object the builder
// publishes), the write-op gate, the unique-write serializer, and the
// owner's lifecycle/compaction callbacks.

import { backupInProgressError } from './backup.js';
import { encodeFrame, encodeBatchOps, scanBatchOpRefs, HEADER_SIZE, TYPE_SET, TYPE_DEL, TYPE_BATCH } from './codec.js';
import type { BatchOp as EncodedBatchOp, FrameRef } from './codec.js';
import { frameToOps } from './recovery.js';
import type { ValueMode, RecoveredOp } from './recovery.js';
import { toBuf, toKStr, normDt, MAX_KEY_LEN } from './value-codec.js';
import type { Store, StoreRecord, ValueLoc } from './store.js';
import type { WAL } from './wal.js';
import type { IndexManager } from './index-manager.js';
import type { DtIndex } from './dt-index.js';
import type { CompoundIndexManager } from './compound-index.js';
import type { OpTracker } from './op-tracker.js';
import type { WalGroupTracker } from './wal-group.js';
import type { MemoryGuard } from './memory-guard.js';
import type { TextRegistry } from './text-registry.js';
import type { GenerationBuilder } from './generation-builder.js';
import type { TextIndex } from './text-index/index.js';
import type { SetOptions, BatchInputOp, PreparedOp, ValueCodecName } from './types.js';

/** The stats counters the write path touches (a structural view of MiniDb's
 *  stats object). */
export interface WritePathStats {
  evictions: number;
  compactionRotationPauseMs: number;
}

/** The owner-injected surface the write path needs (see the header). */
export interface WritePathDeps<V> {
  store: () => Store;
  wal: () => WAL;
  valueMode: () => ValueMode;
  codecName: () => ValueCodecName;
  /** The compaction rotation critical section (null outside it). */
  rotateLock: () => Promise<void> | null;
  dt: DtIndex;
  indexes: IndexManager;
  compound: CompoundIndexManager;
  textRegistry: TextRegistry<V>;
  walGroups: WalGroupTracker;
  memoryGuard: MemoryGuard<V>;
  generationBuilder: GenerationBuilder<V>;
  writeOps: OpTracker;
  serializeUniqueWrites: <T>(fn: () => Promise<T>) => Promise<T>;
  stats: WritePathStats;
  encode: (v: V) => Buffer;
  decode: (b: Buffer | undefined) => V | undefined;
  indexable: (v: unknown) => v is Record<string, unknown>;
  ensureOpen: () => void;
  ensureWritable: () => void;
  maybeAutoCompact: () => void;
}

export class WritePath<V> {
  /** Scratch out-param for applyOp's pre-state capture. Live only within the
   *  synchronous apply section of a commit body (shared safely because
   *  nothing awaits while it is read); callers lift the reference into a
   *  local before any await. Avoids one small allocation per write op. */
  private readonly applyBox: { prev: StoreRecord | undefined } = { prev: undefined };

  constructor(private readonly deps: WritePathDeps<V>) {}

  /** Park a write op while a compaction rotation is in flight, accounting the
   *  wait so compactionRotationPauseMs reflects the writer-visible pause
   *  (as opposed to compactionRotationDurationMs, the rotation's wall time). */
  private async awaitRotation(): Promise<void> {
    const rl = this.deps.rotateLock();
    if (!rl) return;
    const t0 = performance.now();
    await rl;
    this.deps.stats.compactionRotationPauseMs += performance.now() - t0;
  }

  private hasUniqueIndexes(): boolean {
    // Staged included: while a unique create is in its persist window the
    // staged index is fully built and writes must already be checked against
    // it (and serialized via serializeUniqueWrites) — see IndexManager.staged.
    return this.deps.indexes.hasUnique();
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
        this.deps.rotateLock() !== null && e instanceof Error && e.message === 'WAL is closed';
      if (!sealed && !closedMidRotation) throw e;
      await this.awaitRotation();
      await commit();
    }
  }

  async evictKey(pk: string): Promise<void> {
    const bytes = this.deps.store().recordBytes(pk);
    if (!bytes) return;
    const op = this.prepareDel(Buffer.from(pk, 'binary'));
    // Committed through retryOnWalSeal like any other write: an evict that
    // passed the writer gate just before a compaction rotation can land its
    // DEL on the freshly-sealed (or just-closed, soon-to-be-replaced) old WAL,
    // and the user write that triggered the eviction must never see that race.
    // A failed attempt restores the victim via restoreKey, so re-running the
    // idempotent DEL body against the post-rotation WAL is safe.
    const commit = async (): Promise<void> => {
      const recoveryGate = this.deps.walGroups.walRecoveryGate();
      if (recoveryGate) await recoveryGate;
      const wal = this.deps.wal();
      const appended = wal.appendLoc(encodeFrame({ type: TYPE_DEL, key: op.key }));
      const group = this.deps.walGroups.groupFor(wal, appended.batchId);
      const applied = this.applyBox;
      let prev: StoreRecord | undefined;
      let seq: number | undefined;
      try {
        this.applyOp(op, applied);
        prev = applied.prev;
        seq = this.deps.store().map.get(op.pk)?.seq;
      } catch (err) {
        // See set() for this defensive path (applyOp's must-not-throw contract).
        void appended.done.catch(() => {}); // this op throws here; swallow the frame's rejection
        if (group) {
          wal.poisonPending(err);
          this.deps.walGroups.groupNoteKey(group, op.pk, applied.prev);
          this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
          this.deps.walGroups.kickWalRecovery(wal);
        } else {
          this.restoreGroupKey(op.pk, applied.prev);
        }
        throw this.deps.walGroups.markAmbiguous(err);
      }
      this.deps.walGroups.groupNoteKey(group, op.pk, prev);
      try {
        await appended.done;
        this.deps.stats.evictions++;
      } catch (e) {
        if (group) this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
        else this.restoreKey(op.pk, prev, seq);
        this.deps.walGroups.kickWalRecovery(wal);
        throw this.deps.walGroups.markAmbiguous(e);
      }
      this.deps.walGroups.settleGroup(group, wal, appended.batchId);
    };
    await this.retryOnWalSeal(commit);
  }

  private checkKey(key: string | Buffer): void {
    const len = typeof key === 'string' ? key.length : Buffer.from(key).length;
    if (len > MAX_KEY_LEN) throw new RangeError(`key too long (>${MAX_KEY_LEN})`);
    if ((typeof key === 'string' && key.length === 0) || (Buffer.isBuffer(key) && key.length === 0)) {
      throw new RangeError('key must be non-empty');
    }
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
    if (this.deps.wal() !== wal || seq === undefined) return;
    const cur = this.deps.store().map.get(pk);
    if (!cur || cur.seq !== seq) return;
    this.deps.store().setRef(pk, { kind: 'disk', loc }, expireAt, dt);
  }

  async set(key: string | Buffer, value: V, { ttl, dt }: SetOptions = {}): Promise<void> {
    this.deps.ensureOpen();
    this.deps.ensureWritable();
    this.checkKey(key);
    if (!this.deps.writeOps.enter()) throw backupInProgressError();
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
        if (this.deps.indexes.size && this.deps.indexable(op.canonical)) this.deps.indexes.checkUnique(op.pk, op.canonical);
        await this.deps.memoryGuard.ensureMemoryFor([op]);
        await this.retryOnWalSeal(() => this.commitSetOp(op));
      };
      if (this.hasUniqueIndexes()) await this.deps.serializeUniqueWrites(run);
      else await run();
    } finally {
      this.deps.writeOps.leave();
    }
  }

  /** The set() commit body: append the frame and apply the prepared op,
   *  rolling back (per-op or group) when the WAL write fails. */
  private async commitSetOp(op: PreparedOp<V>): Promise<void> {
      // Queue behind any in-place WAL recovery: a write issued after a
      // failure waits for the truncate + poison-clear instead of hitting the
      // still-poisoned WAL. Null (and zero-cost) when no recovery is running.
      const recoveryGate = this.deps.walGroups.walRecoveryGate();
      if (recoveryGate) await recoveryGate;
      const frame = encodeFrame({ type: TYPE_SET, key: op.key, value: op.value, meta: op.meta, expireAt: op.expireAt });
      const wal = this.deps.wal();
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
      const group = this.deps.walGroups.groupFor(wal, appended.batchId);
      const applied = this.applyBox;
      let prev: StoreRecord | undefined;
      let seq: number | undefined;
      try {
        this.applyOp(op, applied);
        // Lift the pre-state reference out of the shared scratch before any
        // await lets a later op overwrite it.
        prev = applied.prev;
        seq = this.deps.store().map.get(op.pk)?.seq;
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
          this.deps.walGroups.groupNoteKey(group, op.pk, applied.prev);
          this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
          this.deps.walGroups.kickWalRecovery(wal);
        } else {
          this.restoreGroupKey(op.pk, applied.prev);
        }
        throw this.deps.walGroups.markAmbiguous(err);
      }
      this.deps.walGroups.groupNoteKey(group, op.pk, prev);
      try {
        await appended.done;
      } catch (e) {
        if (group) this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
        else this.restoreKey(op.pk, prev, seq);
        this.deps.walGroups.kickWalRecovery(wal);
        throw this.deps.walGroups.markAmbiguous(e);
      }
      this.deps.walGroups.settleGroup(group, wal, appended.batchId);
      if (this.deps.valueMode() === 'disk') {
        this.publishWalRef(
          op.pk,
          wal,
          seq,
          { file: 'wal', off: appended.offset + HEADER_SIZE + op.key.length, len: op.value!.length },
          op.expireAt,
          op.dtNorm,
        );
      }
      this.deps.maybeAutoCompact();
  }

  async del(key: string | Buffer): Promise<boolean> {
    this.deps.ensureOpen();
    this.deps.ensureWritable();
    if (!this.deps.writeOps.enter()) throw backupInProgressError();
    try {
      await this.awaitRotation();
      const existed = this.deps.store().has(toKStr(key));
      if (!existed) return false;
      const op = this.prepareDel(key);
      await this.deps.memoryGuard.ensureMemoryFor([op]);
      const commit = async (): Promise<void> => {
        const recoveryGate = this.deps.walGroups.walRecoveryGate();
        if (recoveryGate) await recoveryGate;
        const wal = this.deps.wal();
        const appended = wal.appendLoc(encodeFrame({ type: TYPE_DEL, key: op.key }));
        const group = this.deps.walGroups.groupFor(wal, appended.batchId);
        const applied = this.applyBox;
        let prev: StoreRecord | undefined;
        let seq: number | undefined;
        try {
          this.applyOp(op, applied);
          prev = applied.prev;
          seq = this.deps.store().map.get(op.pk)?.seq;
        } catch (err) {
          // See set() for this defensive path (applyOp's must-not-throw contract).
          void appended.done.catch(() => {}); // this op throws here; swallow the frame's rejection
          if (group) {
            wal.poisonPending(err);
            this.deps.walGroups.groupNoteKey(group, op.pk, applied.prev);
            this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
            this.deps.walGroups.kickWalRecovery(wal);
          } else {
            this.restoreGroupKey(op.pk, applied.prev);
          }
          throw this.deps.walGroups.markAmbiguous(err);
        }
        this.deps.walGroups.groupNoteKey(group, op.pk, prev);
        try {
          await appended.done;
        } catch (e) {
          if (group) this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
          else this.restoreKey(op.pk, prev, seq);
          this.deps.walGroups.kickWalRecovery(wal);
          throw this.deps.walGroups.markAmbiguous(e);
        }
        this.deps.walGroups.settleGroup(group, wal, appended.batchId);
        this.deps.maybeAutoCompact();
      };
      await this.retryOnWalSeal(commit);
      return true;
    } finally {
      this.deps.writeOps.leave();
    }
  }

  /** Atomically apply a batch of operations (all-or-nothing). */
  async batch(ops: readonly BatchInputOp<V>[]): Promise<void> {
    this.deps.ensureOpen();
    this.deps.ensureWritable();
    if (!this.deps.writeOps.enter()) throw backupInProgressError();
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
        if (this.deps.indexes.size) {
          this.deps.indexes.checkUniqueBatch(
            prepared.map((o) => ({
              pk: o.pk,
              op: o.type === TYPE_DEL ? ('del' as const) : ('set' as const),
              doc: o.canonical,
            })),
          );
        }
        await this.deps.memoryGuard.ensureMemoryFor(prepared);
        await this.retryOnWalSeal(() => this.commitBatchOps(prepared));
      };
      if (this.hasUniqueIndexes()) await this.deps.serializeUniqueWrites(run);
      else await run();
    } finally {
      this.deps.writeOps.leave();
    }
  }

  /** The batch() commit body: append one BATCH frame and apply every prepared
   *  op, rolling the whole batch back when the WAL write fails. */
  private async commitBatchOps(prepared: readonly PreparedOp<V>[]): Promise<void> {
      const recoveryGate = this.deps.walGroups.walRecoveryGate();
      if (recoveryGate) await recoveryGate;
      const body = encodeBatchOps(
        prepared.map<EncodedBatchOp>((op) => ({ type: op.type, key: op.key, value: op.value, meta: op.meta, expireAt: op.expireAt })),
      );
      const frame = encodeFrame({ type: TYPE_BATCH, key: Buffer.alloc(0), value: body });
      const wal = this.deps.wal();
      const appended = wal.appendLoc(frame);
      const group = this.deps.walGroups.groupFor(wal, appended.batchId);
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
          for (const [pk, p] of prevs) this.deps.walGroups.groupNoteKey(group, pk, p);
          this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
          this.deps.walGroups.kickWalRecovery(wal);
        } else {
          for (const [pk, p] of prevs) this.restoreGroupKey(pk, p);
        }
        throw this.deps.walGroups.markAmbiguous(err);
      }
      for (const [pk, p] of prevs) this.deps.walGroups.groupNoteKey(group, pk, p);
      // Seq identity of each record as this batch left it (undefined where the
      // batch's last op deleted the key): guards both the per-op rollback
      // (frames that never entered a group, e.g. a seal race) and the WAL
      // pointer publish against interleaved same-key commits.
      const seqs = new Map<string, number | undefined>();
      for (const pk of prevs.keys()) seqs.set(pk, this.deps.store().map.get(pk)?.seq);
      // In valueMode 'disk' the applied records hold in-memory refs for now
      // (see set()); their WAL pointers are published after `done` resolves.
      // Only the LAST set per key may publish — an earlier op's frame range
      // holds a superseded value.
      const lastSet = new Map<string, { op: PreparedOp<V>; loc: ValueLoc; seq: number | undefined }>();
      if (this.deps.valueMode() === 'disk') {
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
        if (group) this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
        else for (const [pk, prev] of prevs) this.restoreKey(pk, prev, seqs.get(pk));
        this.deps.walGroups.kickWalRecovery(wal);
        throw this.deps.walGroups.markAmbiguous(e);
      }
      this.deps.walGroups.settleGroup(group, wal, appended.batchId);
      for (const [pk, { op, loc, seq }] of lastSet) {
        this.publishWalRef(pk, wal, seq, loc, op.expireAt, op.dtNorm);
      }
      this.deps.maybeAutoCompact();
  }

  private prepareOp(o: BatchInputOp<V>): PreparedOp<V> {
    if (o.op === 'set') return this.prepareSet(o.key, o.value, { ttl: o.ttl, dt: o.dt });
    if (o.op === 'del') return this.prepareDel(o.key);
    throw new TypeError(`unknown batch op: ${(o as { op: string }).op}`);
  }

  private prepareSet(key: string | Buffer, value: V, { ttl, dt }: SetOptions = {}): PreparedOp<V> {
    this.checkKey(key);
    const pk = toKStr(key);
    const dtNorm = normDt(dt);
    // A TTL is encoded as an int64 in the frame, so it must be a finite integer
    // of milliseconds. A fractional TTL is floored; a non-finite one
    // (NaN / ±Infinity) is rejected up front instead of exploding inside the
    // frame encoder with an opaque "cannot convert to BigInt" error. ttl 0 (or
    // omitted) keeps the existing "no expiry" semantics.
    if (ttl !== undefined && !Number.isFinite(ttl)) throw new RangeError('ttl must be a finite number of milliseconds');
    const expireAt = ttl ? Date.now() + Math.floor(ttl) : 0;
    const vbuf = this.deps.encode(value);
    // Canonical value (stage 11): the json codec re-parses the encoded bytes
    // ONCE, so every downstream consumer sees exactly the persisted value
    // (review #5). The decode is infallible here — it re-parses what
    // JSON.stringify just produced. Buffer/string codecs have no canonical
    // concept and keep the value as passed (their paths never feed indexes).
    const canonical = this.deps.codecName() === 'json' ? (this.deps.decode(vbuf) as V) : value;
    // Tokenize at the prepare boundary (stage 11): a throwing custom
    // tokenizer — or one producing an overlong term — rejects the write here,
    // before the store/delta/buildQueue can be polluted (reviews #24/#27).
    let textTokens: Map<TextIndex, readonly string[] | null> | null = null;
    if (this.deps.textRegistry.text.size) {
      textTokens = new Map();
      for (const ti of this.deps.textRegistry.text.values()) {
        textTokens.set(ti, this.deps.indexable(canonical) ? ti.prepareAdd(canonical) : null);
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
      pk: toKStr(key),
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
    const oldBuf = this.deps.store().get(op.pk);
    out.prev = oldBuf !== undefined ? this.deps.store().map.get(op.pk) : undefined;
    const oldDoc = oldBuf !== undefined ? this.deps.decode(oldBuf) : undefined;
    if (op.type === TYPE_SET) {
      // Always applied as an in-memory ref; in valueMode 'disk' the caller
      // swaps in the WAL pointer via publishWalRef() once the frame's bytes
      // are durably in db.wal.
      this.deps.store().set(op.key, op.value!, op.expireAt, op.dtNorm);
      this.deps.dt.set(op.pk, op.dtNorm);
      this.deps.compound.add(op.pk, op.canonical, op.dtNorm);
      if (this.deps.indexes.size) {
        if (this.deps.indexable(oldDoc)) this.deps.indexes.remove(op.pk, oldDoc);
        if (this.deps.indexable(op.canonical)) this.deps.indexes.add(op.pk, op.canonical);
      }
      for (const ti of this.deps.textRegistry.text.values()) {
        const tokens = op.textTokens?.get(ti);
        if (tokens !== undefined) {
          // Pre-tokenized and validated at the prepare boundary (null = the
          // canonical doc is not indexable → drop the key from this index).
          if (tokens === null) ti.remove(op.pk);
          else ti.addPrepared(op.pk, tokens);
        } else if (this.deps.indexable(op.canonical)) {
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
      const existed = this.deps.store().del(op.key);
      if (existed) {
        this.deps.memoryGuard.access.delete(op.pk);
        this.deps.dt.del(op.pk);
        this.deps.compound.remove(op.pk);
        if (this.deps.indexes.size && this.deps.indexable(oldDoc)) this.deps.indexes.remove(op.pk, oldDoc);
        for (const ti of this.deps.textRegistry.text.values()) ti.remove(op.pk);
      }
    }
    // Stage 5: feed the in-flight generation build (if any) so its detached
    // states converge on the exact sealed checkpoint — see genBuild. Infallible
    // (a bare array push + counter), preserving this method's must-not-throw
    // contract.
    const gb = this.deps.generationBuilder.genBuild;
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
    if (op.type === TYPE_SET) this.deps.memoryGuard.touchAccess(op.pk);
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
    const cur = this.deps.store().map.get(pk);
    if (appliedSeq === undefined ? cur !== undefined : cur?.seq !== appliedSeq) return;
    this.restoreGroupKey(pk, prev);
  }

  /** The unguarded restore core behind restoreKey and the flush-group
   *  rollback: put the key back to `prev` across the store and every derived
   *  index (TTL/access/dt/secondary/compound/text). */
  restoreGroupKey(pk: string, prev: StoreRecord | undefined): void {
    // A rollback rewinds the store OUTSIDE applyOp's op stream, so an
    // in-flight generation build can no longer prove its image equals the
    // checkpoint replay: abort it (expected churn, never an error).
    const gb = this.deps.generationBuilder.genBuild;
    if (gb) gb.aborted = true;
    if (this.deps.indexes.size) this.deps.indexes.remove(pk, undefined);
    for (const ti of this.deps.textRegistry.text.values()) ti.remove(pk);
    this.deps.dt.del(pk);
    this.deps.compound.remove(pk);
    if (prev === undefined) {
      this.deps.store().del(pk);
      this.deps.memoryGuard.access.delete(pk);
      return;
    }
    this.deps.store().setRef(pk, prev.ref, prev.expireAt, prev.dt);
    this.deps.memoryGuard.touchAccess(pk);
    const doc = this.deps.decode(this.deps.store().get(pk));
    this.deps.dt.set(pk, prev.dt);
    this.deps.compound.add(pk, doc, prev.dt);
    if (this.deps.indexable(doc)) this.deps.indexes.add(pk, doc);
    for (const ti of this.deps.textRegistry.text.values()) {
      if (this.deps.indexable(doc)) ti.add(pk, doc);
    }
  }

  /** Apply one recovered WAL frame during catchUpFromWal: the same ops
   *  open-time recovery derives from it (frameToOps), plus the incremental
   *  derived-index maintenance applyOp performs on the write path — minus
   *  unique checks: the writer already validated, and intermediate frame
   *  states must apply literally (LWW). */
  applyRecoveredFrame(f: FrameRef, fd: number): void {
    for (const op of frameToOps(f, 'wal', fd, this.deps.valueMode())) this.applyRecoveredOp(op);
  }

  applyRecoveredOp(op: RecoveredOp): void {
    const pk = toKStr(op.key);
    // Old doc for derived-index removal; decoded before the overwrite, like
    // applyOp. This get also lazy-reaps an expired old record, whose onExpire
    // hook then removes its derived entries for us.
    const oldDoc = this.deps.indexes.size ? this.deps.decode(this.deps.store().get(pk)) : undefined;
    if (op.type === TYPE_DEL) {
      if (!this.deps.store().del(pk)) return;
      this.deps.memoryGuard.access.delete(pk);
      this.deps.dt.del(pk);
      this.deps.compound.remove(pk);
      if (this.deps.indexes.size && this.deps.indexable(oldDoc)) this.deps.indexes.remove(pk, oldDoc);
      for (const ti of this.deps.textRegistry.text.values()) ti.remove(pk);
      return;
    }
    this.deps.store().setRef(op.key, op.ref!, op.expireAt, op.dt);
    // Re-read through the store: a TTL too short to survive the few
    // microseconds since the replay-time expiry check was already reaped
    // here, with onExpire dropping derived state — exactly what a fresh
    // reopen leaves for the key. Otherwise dt/compound/secondary/text indexes
    // would be resurrected for a key the store no longer holds.
    const buf = this.deps.store().get(pk);
    if (buf === undefined) return;
    this.deps.dt.set(pk, op.dt);
    // Values are only decoded when a value-derived index exists (all of them
    // require the json codec): with none, recovery never copies them either.
    if (this.deps.indexes.size || this.deps.textRegistry.text.size || this.deps.compound.size) {
      const doc = this.deps.decode(buf)!;
      this.deps.compound.add(pk, doc, op.dt);
      if (this.deps.indexes.size) {
        if (this.deps.indexable(oldDoc)) this.deps.indexes.remove(pk, oldDoc);
        if (this.deps.indexable(doc)) this.deps.indexes.add(pk, doc);
      }
      for (const ti of this.deps.textRegistry.text.values()) {
        if (this.deps.indexable(doc)) ti.add(pk, doc);
        else ti.remove(pk);
      }
    }
    this.deps.memoryGuard.touchAccess(pk);
  }

  async expire(key: string | Buffer, ttlMs: number): Promise<boolean> {
    this.deps.ensureOpen();
    this.deps.ensureWritable();
    if (!this.deps.writeOps.enter()) throw backupInProgressError();
    try {
      await this.awaitRotation();
      const k = toKStr(key);
      const cur = this.deps.store().getRecord(k);
      if (cur === undefined) return false;
      // Same validation as set(): the TTL is stored as an int64, so it must be a
      // finite integer of milliseconds (fractional values are floored).
      if (!Number.isFinite(ttlMs)) throw new RangeError('ttl must be a finite number of milliseconds');
      const expireAt = Date.now() + Math.floor(ttlMs);
      const curValue = this.deps.store().get(k);
      if (curValue === undefined) return false;
      const meta = cur.dt ? Buffer.from(JSON.stringify({ dt: cur.dt })) : null;
      const keyBuf = toBuf(key);
      const frame = encodeFrame({ type: TYPE_SET, key: keyBuf, value: curValue, meta, expireAt });
      const commit = async (): Promise<void> => {
        const recoveryGate = this.deps.walGroups.walRecoveryGate();
        if (recoveryGate) await recoveryGate;
        const wal = this.deps.wal();
        const appended = wal.appendLoc(frame);
        const group = this.deps.walGroups.groupFor(wal, appended.batchId);
        // In-memory ref first (see set()); the disk pointer is published once the
        // frame's bytes are durably in db.wal. prev/seq are captured per attempt
        // (as in set()): a rotation retry can find a different record in place,
        // and restoreKey's seq guard then leaves that newer durable state alone.
        const prev = this.deps.store().map.get(k);
        let seq: number | undefined;
        try {
          this.deps.store().set(k, curValue, expireAt, cur.dt);
          // Stage 5: expire() rewrites the TTL without going through applyOp,
          // so the generation build's queue needs this store-only entry — the
          // value is unchanged and value-derived indexes need no re-feed.
          const gb = this.deps.generationBuilder.genBuild;
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
          seq = this.deps.store().map.get(k)?.seq;
        } catch (err) {
          // The in-memory mutation failed: an enqueued frame poisons the WAL
          // exactly like a write failure and rolls the group back; a
          // never-enqueued one only needs the per-op undo (see set()).
          void appended.done.catch(() => {}); // this op throws here; swallow the frame's rejection
          if (group) {
            wal.poisonPending(err);
            this.deps.walGroups.groupNoteKey(group, k, prev);
            this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
            this.deps.walGroups.kickWalRecovery(wal);
          } else {
            this.restoreGroupKey(k, prev);
          }
          throw this.deps.walGroups.markAmbiguous(err);
        }
        this.deps.walGroups.groupNoteKey(group, k, prev);
        try {
          await appended.done;
        } catch (e) {
          if (group) this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
          else this.restoreKey(k, prev, seq);
          this.deps.walGroups.kickWalRecovery(wal);
          throw this.deps.walGroups.markAmbiguous(e);
        }
        this.deps.walGroups.settleGroup(group, wal, appended.batchId);
        if (this.deps.valueMode() === 'disk') {
          this.publishWalRef(
            k,
            wal,
            seq,
            { file: 'wal', off: appended.offset + HEADER_SIZE + keyBuf.length, len: curValue.length },
            expireAt,
            cur.dt,
          );
        }
        this.deps.maybeAutoCompact();
      };
      await this.retryOnWalSeal(commit);
      return true;
    } finally {
      this.deps.writeOps.leave();
    }
  }
}
