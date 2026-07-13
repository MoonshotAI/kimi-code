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
import { ValueReader } from './value-reader.js';
import { recover } from './recovery.js';
import { compact, shouldCompact } from './compaction.js';
import { IndexManager, UniqueViolationError } from './index-manager.js';
import { DtIndex } from './dt-index.js';
import { TextIndex } from './text-index.js';
import { CompoundIndexManager } from './compound-index.js';
import { getPath, match, project } from './query.js';
import { LockFile, LockError } from './lockfile.js';
import { encodeFrame, encodeBatchOps, scanBatchOpRefs, HEADER_SIZE, TYPE_SET, TYPE_DEL, TYPE_BATCH } from './codec.js';
import type { BatchOp as EncodedBatchOp } from './codec.js';
import type { FsyncPolicy } from './wal.js';
import type { RecoveryMode, RecoveryInfo, ValueMode } from './recovery.js';
import type { IndexDef, IndexInfo } from './index-manager.js';
import type { CompoundIndexDef, CompoundIndexInfo } from './compound-index.js';
import type { DtRangeEntry } from './dt-index.js';
import type { RangeOptions } from './skiplist.js';

export { UniqueViolationError } from './index-manager.js';
export { LockError } from './lockfile.js';
export type { RecoveryInfo } from './recovery.js';
export type { IndexDef, IndexInfo, IndexType } from './index-manager.js';
export type { CompoundIndexDef, CompoundIndexInfo } from './compound-index.js';

export type ValueCodecName = 'buffer' | 'string' | 'json';

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
  private textDefs: { name: string; fields: readonly string[] | null }[] = [];

  private codec!: ValueCodec<V>;
  private codecName: ValueCodecName = 'buffer';
  fsyncPolicy: FsyncPolicy = 'everysec';
  private closed = false;
  recoveryInfo: RecoveryInfo | null = null;
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
  private access = new Map<string, number>(); // pk -> last access seq, for LRU eviction
  private accessSeq = 0;
  private uniqueWriteLock: Promise<void> = Promise.resolve();
  readonly stats = {
    compactions: 0,
    walBytesWritten: 0,
    walFsyncs: 0,
    snapshotBytesWritten: 0,
    evictions: 0,
    maxMemoryRejections: 0,
    queryIndexHits: 0,
  };

  /** Hook called by compaction after the store snapshot + WAL are rotated, so
   *  derived on-disk state (text postings) can be rewritten against the new
   *  live set. Structural part of the CompactionTarget interface. */
  onCompacted = (): void => {
    this.rebuildTextPostings();
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

    db.store = new Store({
      activeExpireIntervalMs: opts.activeExpireIntervalMs ?? 100,
      onExpire: (k, rec) => db.onStoreExpire(k, rec),
      readValue: (loc) => {
        if (!db.valueReader) throw new Error('ValueReader is not open');
        return db.valueReader.read(loc);
      },
    });
    try {
      db.wal = new WAL(db.walPath, { fsyncPolicy: db.fsyncPolicy, stats: db.stats });
      await db.wal.open();

      db.recoveryInfo = await recover({
        dir: db.dir,
        store: db.store,
        mode: opts.recovery ?? 'resync',
        truncate: !db.readOnly,
        valueMode: db.valueMode,
      });
      db.valueReader = new ValueReader(db.dir);
      db.valueReader.open();
      db.seedAccessFromStore();

      await db.loadIndexDefinitions();
      await db.loadCompoundIndexDefinitions();
      await db.loadTextIndexDefinitions();
      db.rebuildAllIndexes();

      if (db.autoCompact && shouldCompact(db)) await compact(db);
    } catch (err) {
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

  /** Rebuild every text index's on-disk postings from the live Store. Drops
   *  the in-memory delta + tombstones and reclaims orphaned postings records.
   *  Invoked after compaction (postings are pure derived state, so this is
   *  only for space/latency, never for correctness). */
  private rebuildTextPostings(): void {
    for (const ti of this.text.values()) ti.build(this.textRecords());
  }

  private rebuildAllIndexes(): void {
    this.indexes.rebuild(this._liveRecordsRaw());
    this.dt.rebuild([...this.liveRecords()].map(({ key, dt }) => ({ key: this.pk(key), dt })));
    this.compound.rebuild(this.liveRecords());
    for (const [, ti] of this.text) ti.build(this.textRecords());
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
    await fs.writeFile(this.indexPath, JSON.stringify(this.indexes.list()), 'utf8');
  }
  private async loadTextIndexDefinitions(): Promise<void> {
    try {
      const raw = await fs.readFile(this.textIndexPath, 'utf8');
      this.textDefs = JSON.parse(raw) as { name: string; fields: readonly string[] | null }[];
      for (const d of this.textDefs) {
        this.text.set(
          d.name,
          new TextIndex({
            fields: d.fields,
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
    await fs.writeFile(this.textIndexPath, JSON.stringify(this.textDefs), 'utf8');
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
    await fs.writeFile(this.compoundIndexPath, JSON.stringify(this.compound.list()), 'utf8');
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

  private touchAccess(pk: string): void {
    this.access.set(pk, ++this.accessSeq);
  }

  private seedAccessFromStore(): void {
    this.access.clear();
    for (const [k] of this.store.map) this.touchAccess(k);
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

  private pickEvictionVictim(skip: Set<string>): string | undefined {
    let best: string | undefined;
    let bestSeq = Infinity;
    for (const [k, seq] of this.access) {
      if (skip.has(k) || !this.store.map.has(k)) continue;
      if (seq < bestSeq) {
        best = k;
        bestSeq = seq;
      }
    }
    if (best) return best;
    for (const [k] of this.store.map) if (!skip.has(k)) return k;
    return undefined;
  }

  private async evictKey(pk: string): Promise<void> {
    const bytes = this.store.recordBytes(pk);
    if (!bytes) return;
    const op = this.prepareDel(Buffer.from(pk, 'binary'));
    const appended = this.wal.append(encodeFrame({ type: TYPE_DEL, key: op.key }));
    const prev = this.applyOp(op);
    try {
      await appended;
      this.stats.evictions++;
    } catch (e) {
      this.restoreKey(op.pk, prev);
      throw e;
    }
  }

  private async ensureMemoryFor(ops: readonly PreparedOp<V>[]): Promise<void> {
    if (this.maxMemoryBytes === null) return;
    this.store.reapExpired();
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
    if (this._rotateLock) await this._rotateLock;
    const op = this.prepareSet(key, value, { ttl, dt });
    await this.ensureMemoryFor([op]);

    const commit = async (): Promise<void> => {
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
      // WAL write ultimately fails, roll the store + derived indexes back to
      // the pre-op record so in-memory state never diverges from what is
      // durable.
      const prev = this.applyOp(op);
      const seq = this.store.map.get(op.pk)?.seq;
      try {
        await appended.done;
      } catch (e) {
        this.restoreKey(op.pk, prev);
        throw e;
      }
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

    if (this.hasUniqueIndexes()) await this.withUniqueWriteLock(commit);
    else await commit();
  }

  async del(key: string | Buffer): Promise<boolean> {
    this.ensureOpen();
    this.ensureWritable();
    if (this._rotateLock) await this._rotateLock;
    const existed = this.store.get(toKStr(key)) !== undefined;
    if (!existed) return false;
    const op = this.prepareDel(key);
    await this.ensureMemoryFor([op]);
    const appended = this.wal.append(encodeFrame({ type: TYPE_DEL, key: op.key }));
    const prev = this.applyOp(op);
    try {
      await appended;
    } catch (e) {
      this.restoreKey(op.pk, prev);
      throw e;
    }
    this.maybeAutoCompact();
    return true;
  }

  /** Atomically apply a batch of operations (all-or-nothing). */
  async batch(ops: readonly BatchInputOp<V>[]): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    if (this._rotateLock) await this._rotateLock;
    if (!ops || ops.length === 0) return;
    const prepared = ops.map((o) => this.prepareOp(o));
    await this.ensureMemoryFor(prepared);

    const commit = async (): Promise<void> => {
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
      // Capture each key's pre-batch record (first applyOp per key) so the whole
      // batch can be rolled back if the WAL write fails, preserving atomicity.
      const prevs = new Map<string, StoreRecord | undefined>();
      for (const op of prepared) {
        const prev = this.applyOp(op);
        if (!prevs.has(op.pk)) prevs.set(op.pk, prev);
      }
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
            lastSet.set(op.pk, { op, loc: { file: 'wal', off: bodyOff + ref.valueOff, len: ref.valLen }, seq: undefined });
          }
        }
        for (const [pk, e] of lastSet) e.seq = this.store.map.get(pk)?.seq;
      }
      try {
        await appended.done;
      } catch (e) {
        for (const [pk, prev] of prevs) this.restoreKey(pk, prev);
        throw e;
      }
      for (const [pk, { op, loc, seq }] of lastSet) {
        this.publishWalRef(pk, wal, seq, loc, op.expireAt, op.dtNorm);
      }
      this.maybeAutoCompact();
    };

    if (this.hasUniqueIndexes()) await this.withUniqueWriteLock(commit);
    else await commit();
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

  /** Apply a prepared op to the store + derived indexes. Returns the key's
   *  pre-op logical record so the caller can roll back on WAL failure. */
  private applyOp(op: PreparedOp<V>): StoreRecord | undefined {
    const oldBuf = this.store.get(op.pk);
    const prev = oldBuf !== undefined ? this.store.map.get(op.pk) : undefined;
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
    return prev;
  }

  /** Roll a key back to its pre-op record across the store and every derived
   *  index. Used when a WAL write fails after applyOp already mutated state. */
  private restoreKey(pk: string, prev: StoreRecord | undefined): void {
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
    if (this._rotateLock) await this._rotateLock;
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
    const wal = this.wal;
    const appended = wal.appendLoc(frame);
    // In-memory ref first (see set()); the disk pointer is published once the
    // frame's bytes are durably in db.wal.
    this.store.set(k, curValue, expireAt, cur.dt);
    const seq = this.store.map.get(k)?.seq;
    try {
      await appended.done;
    } catch (e) {
      // Value/dt are unchanged (only the TTL moved), so restoring the store
      // record is enough; derived indexes were never touched.
      this.store.setRef(k, cur.ref, cur.expireAt, cur.dt);
      throw e;
    }
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

  async createTextIndex(name: string, { fields }: { fields?: readonly string[] } = {}): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    if (this.codecName !== 'json') throw new Error('text indexes require valueCodec: "json"');
    if (this.text.has(name)) throw new Error(`text index "${name}" already exists`);
    const ti = new TextIndex({ fields, postingsPath: this.textPostingsPath(name) });
    this.text.set(name, ti);
    const def = { name, fields: fields ?? null };
    this.textDefs.push(def);
    ti.build(this.textRecords());
    await this.persistTextIndexDefinitions();
  }
  async dropTextIndex(name: string): Promise<boolean> {
    this.ensureOpen();
    this.ensureWritable();
    const ti = this.text.get(name);
    const ok = this.text.delete(name);
    if (ti) {
      ti.close();
      await fs.rm(this.textPostingsPath(name), { force: true }).catch(() => {});
    }
    this.textDefs = this.textDefs.filter((d) => d.name !== name);
    await this.persistTextIndexDefinitions();
    return ok;
  }

  search(name: string, q: string, opts: { op?: 'AND' | 'OR'; limit?: number } = {}): { key: string; value: V | undefined; score: number }[] {
    this.ensureOpen();
    const ti = this.text.get(name);
    if (!ti) throw new Error(`no such text index: ${name}`);
    return ti
      .search(q, opts)
      .map(({ key, score }) => ({ key: fromKStr(key), value: this.decode(this.store.get(key)), score }))
      .filter((r): r is { key: string; value: V; score: number } => r.value !== undefined);
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
    // Only the range bounds are honored here; ignore any stray count/offset a
    // caller put on the dt cond so they cannot truncate the walk prematurely.
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

    let keys: string[] | null = null;
    if (typeof q.key === 'string') {
      keys = [toKStr(q.key)];
    } else if (q.key && typeof q.key === 'object') {
      if ((q.key as { prefix?: string }).prefix) keys = this.prefix((q.key as { prefix: string }).prefix).map((r) => toKStr(r.key));
      else {
        const opts: RangeOptions<string> = {};
        for (const b of ['gte', 'gt', 'lte', 'lt'] as const)
          if ((q.key as Record<string, unknown>)[b] !== undefined) opts[b] = (q.key as Record<string, unknown>)[b] as string;
        keys = this.scan(opts).map((r) => toKStr(r.key));
      }
    }

    if (q.dt) {
      for (const [col, cond] of Object.entries(q.dt)) {
        const set = new Set(this.dt.range(col, cond).map((r) => r.key));
        keys = keys === null ? [...set] : keys.filter((k) => set.has(k));
      }
    }

    let textOrder: { key: string; score: number }[] | null = null;
    if (q.text) {
      const ti = this.text.get(q.text.index);
      if (!ti) throw new Error(`no such text index: ${q.text.index}`);
      const hits = ti.search(q.text.q, { op: q.text.op, limit: q.text.limit ?? 1_000_000 });
      textOrder = hits;
      const set = new Set(hits.map((h) => h.key));
      keys = keys === null ? hits.map((h) => h.key) : keys.filter((k) => set.has(k));
    }

    const indexed = this.indexedCandidateKeys(q.filter);
    if (indexed) {
      const set = new Set(indexed);
      keys = keys === null ? indexed : keys.filter((k) => set.has(k));
    }

    if (keys === null) keys = this.scan().map((r) => toKStr(r.key));

    const docs: ScanEntry<V>[] = [];
    for (const k of keys) {
      const buf = this.store.get(k);
      if (buf === undefined) continue;
      const r = this.store.map.get(k);
      const value = this.decode(buf)!;
      if (q.filter && !match(value, q.filter)) continue;
      docs.push({ key: k, value, dt: r?.dt ?? undefined });
    }

    if (textOrder && !q.sort) {
      const rank = new Map(textOrder.map((h, i) => [h.key, i]));
      docs.sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
    }

    if (q.sort) {
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

    const skip = q.skip ?? 0;
    const limit = q.limit === undefined ? Infinity : q.limit;
    const sliced = skip || limit !== Infinity ? docs.slice(skip, skip + limit) : docs;

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

  async compact(): Promise<void> {
    this.ensureOpen();
    this.ensureWritable();
    await compact(this);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.compacting) await this._compactDone;
    this.closed = true;
    for (const ti of this.text.values()) ti.close();
    this.store.close();
    this.valueReader?.close();
    await this.wal.close();
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
  }
}
