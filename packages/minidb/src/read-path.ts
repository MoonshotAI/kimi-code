// src/read-path.ts
//
// MiniDb's read side as a facet: the KV read API (get/getAsync/getRecord/has/
// mget/ttl), the key-ordered scans (scan/prefix), the dt-column reads
// (dtColumns/dtRange), the async value resolution behind the disk mode, and
// the live-record generators every (re)build path feeds from. Read-only —
// the store / value reader / dt index / memory guard (LRU touch) are
// injected, never the MiniDb class itself.

import { canonRange, fromKStr, toKStr } from './value-codec.js';
import type { Store } from './store.js';
import type { ValueReader } from './value-reader.js';
import type { DtIndex, DtRangeEntry } from './dt-index.js';
import type { MemoryGuard } from './memory-guard.js';
import type { RangeOptions } from './skiplist.js';
import type { DocRecord, ScanEntry } from './types.js';

/** The owner-injected surface the read path needs (see the header). */
export interface ReadPathDeps<V> {
  store: () => Store;
  getValueReader: () => ValueReader | undefined;
  dt: DtIndex;
  memoryGuard: MemoryGuard<V>;
  decode: (b: Buffer | undefined) => V | undefined;
  indexable: (v: unknown) => v is Record<string, unknown>;
  ensureOpen: () => void;
}

export class ReadPath<V> {
  constructor(private readonly deps: ReadPathDeps<V>) {}

  *liveRecords(): Generator<{ key: Buffer; value: V | undefined; dt: Record<string, number> | null }> {
    for (const { key, value, dt } of this.deps.store().entries()) {
      yield { key, value: this.deps.decode(value), dt };
    }
  }

  *liveRecordsRaw(): Generator<{ key: Buffer; value: unknown }> {
    for (const { key, value } of this.deps.store().entries()) {
      yield { key, value: this.deps.decode(value) };
    }
  }

  /** Live indexable records with canonical keys, for (re)building text indexes. */
  *textRecords(): Generator<{ key: string; value: unknown }> {
    for (const { key, value } of this.liveRecords()) {
      if (this.deps.indexable(value)) yield { key: toKStr(key), value };
    }
  }

  get(key: string | Buffer): V | undefined {
    this.deps.ensureOpen();
    const k = toKStr(key);
    const v = this.deps.store().get(k);
    if (v !== undefined) this.deps.memoryGuard.touchAccess(k);
    return this.deps.decode(v);
  }

  /** Async value resolution for a canonical key (stage 6): a memory ref is
   *  served inline; a disk ref is read through the async positioned reader
   *  instead of blocking the event loop on readSync. The lazy-expiry
   *  semantics match store.get exactly. */
  async readValueAsync(kstr: string): Promise<Buffer | undefined> {
    const rec = this.deps.store().getRecord(kstr);
    if (!rec) return undefined;
    if (rec.ref.kind === 'memory') return rec.ref.value;
    const valueReader = this.deps.getValueReader();
    if (!valueReader) throw new Error('ValueReader is not open');
    return valueReader.readAsync(rec.ref.loc);
  }

  /** Async twin of get() (stage 6, additive): identical result; only the
   *  disk-mode value read moves off the event loop. */
  async getAsync(key: string | Buffer): Promise<V | undefined> {
    this.deps.ensureOpen();
    const k = toKStr(key);
    const buf = await this.readValueAsync(k);
    if (buf !== undefined) this.deps.memoryGuard.touchAccess(k);
    return this.deps.decode(buf);
  }

  getRecord(key: string | Buffer): DocRecord<V> | undefined {
    this.deps.ensureOpen();
    const k = toKStr(key);
    const value = this.deps.store().get(k);
    if (value === undefined) return undefined;
    const r = this.deps.store().map.get(k);
    this.deps.memoryGuard.touchAccess(k);
    return { key: fromKStr(toKStr(key)), value: this.deps.decode(value)!, dt: r?.dt ?? undefined };
  }

  has(key: string | Buffer): boolean {
    this.deps.ensureOpen();
    return this.deps.store().has(toKStr(key));
  }

  mget(keys: readonly string[]): (V | undefined)[] {
    return keys.map((k) => this.get(k));
  }

  ttl(key: string | Buffer): number {
    this.deps.ensureOpen();
    const r = this.deps.store().map.get(toKStr(key));
    if (!r) return -2;
    if (!r.expireAt) return -1;
    const left = r.expireAt - Date.now();
    return left > 0 ? left : -2;
  }

  scan(opts: RangeOptions<string> = {}): ScanEntry<V>[] {
    this.deps.ensureOpen();
    const count = (opts as { limit?: number }).limit ?? Infinity;
    const out: ScanEntry<V>[] = [];
    for (const r of this.deps.store().scan({ ...canonRange(opts), count })) {
      out.push({ key: r.key.toString(), value: this.deps.decode(r.value)!, dt: r.dt ?? undefined });
    }
    return out;
  }

  prefix(p: string, limit = Infinity): ScanEntry<V>[] {
    this.deps.ensureOpen();
    const out: ScanEntry<V>[] = [];
    for (const r of this.deps.store().prefix(toKStr(p), limit)) {
      out.push({ key: r.key.toString(), value: this.deps.decode(r.value)!, dt: r.dt ?? undefined });
    }
    return out;
  }

  dtColumns(): string[] {
    return this.deps.dt.columns();
  }

  dtRange(col: string, opts: RangeOptions<number> & { limit?: number } = {}): (ScanEntry<V> & { dtValue: number })[] {
    this.deps.ensureOpen();
    const rows = this.deps.dt.range(col, { ...opts, count: opts.limit ?? opts.count });
    const out: (ScanEntry<V> & { dtValue: number })[] = [];
    for (const { key, value: dtValue } of rows as DtRangeEntry[]) {
      const value = this.deps.store().get(key);
      if (value === undefined) continue;
      const r = this.deps.store().map.get(key);
      out.push({ key: fromKStr(key), value: this.deps.decode(value)!, dt: r?.dt ?? undefined, dtValue });
    }
    return out;
  }
}
