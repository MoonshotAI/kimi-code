// src/store.ts
//
// In-memory primary index with TTL and an ordered key index. Values may be held
// either inline in memory or as a pointer into the on-disk snapshot/WAL; in the
// latter case the caller injects a synchronous positioned reader.

import { SkipList, cmpString } from './skiplist.js';
import type { RangeEntry, RangeOptions } from './skiplist.js';

export interface ValueLoc {
  file: 'snapshot' | 'wal';
  off: number;
  len: number;
}

export type ValueRef = { kind: 'memory'; value: Buffer } | { kind: 'disk'; loc: ValueLoc };

export interface StoreRecord {
  ref: ValueRef;
  expireAt: number;
  seq: number;
  dt: Record<string, number> | null;
}

export interface StoreEntry {
  key: Buffer;
  value: Buffer;
  expireAt: number;
  dt: Record<string, number> | null;
}

export type ValueReader = (loc: ValueLoc) => Buffer;

const toKStr = (key: string | Buffer): string =>
  typeof key === 'string' ? key : Buffer.from(key).toString('binary');
const fromKStr = (kstr: string): Buffer => Buffer.from(kstr, 'binary');
const DISK_REF_BYTES = 64;

interface HeapEntry {
  t: number;
  k: string;
  seq: number;
}

class MinHeap {
  private a: HeapEntry[] = [];
  get size(): number {
    return this.a.length;
  }
  clear(): void {
    this.a = [];
  }
  peek(): HeapEntry | undefined {
    return this.a[0];
  }
  push(item: HeapEntry): void {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.t <= a[i]!.t) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): HeapEntry | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length && last !== undefined) {
      a[0] = last;
      let i = 0;
      while (true) {
        let s = i;
        const l = 2 * i + 1;
        const r = l + 1;
        if (l < a.length && a[l]!.t < a[s]!.t) s = l;
        if (r < a.length && a[r]!.t < a[s]!.t) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i]!, a[s]!];
        i = s;
      }
    }
    return top;
  }
}

export interface StoreOptions {
  activeExpireIntervalMs?: number;
  activeExpireMaxPerTick?: number;
  /** Read a value back from disk for disk-backed records. Required whenever a
   *  StoreRecord may hold a disk ref. */
  readValue?: ValueReader;
  /** Called after a key is removed due to TTL expiration (lazy or active),
   *  so the owner can drop derived state (secondary/dt/text indexes). Not
   *  called for explicit del(), which the owner handles itself. */
  onExpire?: (key: string, record: StoreRecord) => void;
}

export class Store {
  readonly map = new Map<string, StoreRecord>(); // kstr -> record
  private readonly order = new SkipList<string, string>({ compareKey: cmpString }); // kstr ordered
  private readonly heap = new MinHeap();
  private seq = 0;
  /** Approximate bytes held by live + expired-not-yet-reaped records. In
   *  valueMode:'disk' this counts keys/metadata/refs, not the value bulk. */
  bytes = 0;
  private readonly maxPerTick: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onExpire?: (key: string, record: StoreRecord) => void;
  private readonly readValue?: ValueReader;

  constructor(opts: StoreOptions = {}) {
    this.maxPerTick = opts.activeExpireMaxPerTick ?? 100;
    this.onExpire = opts.onExpire;
    this.readValue = opts.readValue;
    const interval = opts.activeExpireIntervalMs ?? 100;
    this.timer = interval > 0 ? setInterval(() => this.activeExpire(), interval) : null;
    this.timer?.unref?.();
  }

  get size(): number {
    // Count only logically-live keys: expired-but-not-yet-reaped entries stay
    // in the map until lazy/active expiration removes them, so map.size would
    // otherwise over-report.
    let n = 0;
    const now = Date.now();
    for (const [, r] of this.map) if (!r.expireAt || r.expireAt > now) n++;
    return n;
  }

  private metaBytes(dt: Record<string, number> | null): number {
    return dt ? Buffer.byteLength(JSON.stringify({ dt }), 'utf8') : 0;
  }

  private refBytes(ref: ValueRef): number {
    return ref.kind === 'memory' ? ref.value.length : DISK_REF_BYTES;
  }

  private cloneRef(ref: ValueRef): ValueRef {
    return ref.kind === 'memory' ? { kind: 'memory', value: Buffer.from(ref.value) } : { kind: 'disk', loc: { ...ref.loc } };
  }

  private materialize(ref: ValueRef): Buffer {
    if (ref.kind === 'memory') return ref.value;
    if (!this.readValue) throw new Error('Store cannot read disk-backed value without a ValueReader');
    return this.readValue(ref.loc);
  }

  /** Approximate bytes used by one record, matching the bytes tracked on set(). */
  recordBytes(k: string): number {
    const r = this.map.get(k);
    return r ? Buffer.byteLength(k, 'binary') + this.refBytes(r.ref) + this.metaBytes(r.dt) : 0;
  }

  /** Approximate bytes a SET would store for this key/value/dt. Pass
   *  countValue:false for valueMode:'disk', where only key/metadata/ref bytes
   *  stay in RAM and the value bulk lives in the snapshot/WAL. */
  estimateSetBytes(
    key: string | Buffer,
    value: Buffer,
    dt: Record<string, number> | null,
    opts: { countValue?: boolean } = {},
  ): number {
    const k = toKStr(key);
    const countValue = opts.countValue ?? true;
    return Buffer.byteLength(k, 'binary') + (countValue ? value.length : DISK_REF_BYTES) + this.metaBytes(dt);
  }

  private remove(k: string): boolean {
    const r = this.map.get(k);
    const ok = this.map.delete(k);
    if (ok) {
      if (r) this.bytes -= Buffer.byteLength(k, 'binary') + this.refBytes(r.ref) + this.metaBytes(r.dt);
      this.order.delete(k, k);
    }
    return ok;
  }

  /** Remove a key that has expired and notify the owner so derived indexes
   *  stay in sync. */
  private expireKey(k: string, rec: StoreRecord): void {
    if (this.remove(k)) this.onExpire?.(k, rec);
  }

  set(key: string | Buffer, value: Buffer, expireAt = 0, dt: Record<string, number> | null = null): void {
    this.setRef(key, { kind: 'memory', value: Buffer.from(value) }, expireAt, dt);
  }

  setRef(key: string | Buffer, ref: ValueRef, expireAt = 0, dt: Record<string, number> | null = null): void {
    const k = toKStr(key);
    const existed = this.map.has(k);
    if (existed) this.bytes -= this.recordBytes(k);
    const seq = ++this.seq;
    const stored = this.cloneRef(ref);
    this.map.set(k, { ref: stored, expireAt: expireAt || 0, seq, dt });
    this.bytes += Buffer.byteLength(k, 'binary') + this.refBytes(stored) + this.metaBytes(dt);
    if (!existed) this.order.insert(k, k);
    if (expireAt) {
      this.heap.push({ t: expireAt, k, seq });
      // Overwriting a TTL key leaves a stale heap entry that is only reaped
      // when its (possibly far-future) timestamp passes, so the heap can grow
      // without bound under frequent TTL updates. Rebuild it once stale entries
      // clearly dominate the live set, bounding memory at ~2x live TTL keys.
      if (this.heap.size > this.map.size * 2 + 64) this.rebuildHeap();
    }
  }

  private rebuildHeap(): void {
    this.heap.clear();
    for (const [k, r] of this.map) {
      if (r.expireAt) this.heap.push({ t: r.expireAt, k, seq: r.seq });
    }
  }

  get(key: string | Buffer): Buffer | undefined {
    const k = toKStr(key);
    const r = this.map.get(k);
    if (!r) return undefined;
    if (r.expireAt && r.expireAt <= Date.now()) {
      this.expireKey(k, r); // lazy expiration
      return undefined;
    }
    return this.materialize(r.ref);
  }

  /** Read the full raw record. Like get(), an expired record is lazily reaped
   *  here (notifying the owner so derived indexes stay in sync) rather than
   *  being left behind as a ghost that read paths such as scan/query/dtRange
   *  would otherwise skip-but-not-clean. The returned record is raw: its ref may
   *  point at disk rather than holding a Buffer. */
  getRecord(key: string | Buffer): StoreRecord | undefined {
    const k = toKStr(key);
    const r = this.map.get(k);
    if (!r) return undefined;
    if (r.expireAt && r.expireAt <= Date.now()) {
      this.expireKey(k, r); // lazy expiration (same as get)
      return undefined;
    }
    return r;
  }

  del(key: string | Buffer): boolean {
    return this.remove(toKStr(key));
  }

  has(key: string | Buffer): boolean {
    return this.get(key) !== undefined;
  }

  *entries(): Generator<StoreEntry> {
    const now = Date.now();
    for (const [k, r] of this.map) {
      if (r.expireAt && r.expireAt <= now) continue;
      yield { key: fromKStr(k), value: this.materialize(r.ref), expireAt: r.expireAt, dt: r.dt };
    }
  }

  /** Ordered scan over keys. */
  *scan(opts: RangeOptions<string> = {}): Generator<StoreEntry> {
    for (const n of this.order.range(opts) as Iterable<RangeEntry<string, string>>) {
      const r = this.getRecord(n.key);
      if (!r) continue;
      yield { key: fromKStr(n.key), value: this.materialize(r.ref), expireAt: r.expireAt, dt: r.dt };
    }
  }

  /** Prefix scan over keys. */
  *prefix(p: string, limit = Infinity): Generator<StoreEntry> {
    const pk = toKStr(p);
    yield* this.scan({ gte: pk, lt: pk + '\uffff', count: limit });
  }

  /** Rewrite disk-backed value locations after compaction rotates the
   *  snapshot/WAL files. Memory refs are left untouched. */
  remapLocs(remap: (k: string, loc: ValueLoc, rec: StoreRecord) => ValueLoc | undefined): void {
    for (const [k, r] of this.map) {
      if (r.ref.kind !== 'disk') continue;
      const next = remap(k, r.ref.loc, r);
      if (next) r.ref = { kind: 'disk', loc: { ...next } };
    }
  }

  private activeExpire(): void {
    const now = Date.now();
    let n = 0;
    while (n++ < this.maxPerTick && this.heap.size && this.heap.peek()!.t <= now) {
      const e = this.heap.pop()!;
      const r = this.map.get(e.k);
      if (r && r.seq === e.seq && r.expireAt && r.expireAt <= now) {
        this.expireKey(e.k, r);
      }
    }
  }

  /** Synchronously reap every expired record. Returns the number removed. */
  reapExpired(): number {
    const now = Date.now();
    let n = 0;
    for (const [k, r] of this.map) {
      if (r.expireAt && r.expireAt <= now) {
        this.expireKey(k, r);
        n++;
      }
    }
    return n;
  }

  /** Stop the active-expiration timer. */
  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
