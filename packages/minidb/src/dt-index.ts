// src/dt-index.ts
//
// Ordered indexes over declared datetime columns (dt1..dtN). Each column is a
// SkipList ordered by epoch-ms (numeric) with the record key as tie-break, giving
// O(log N) range / rank on every dt column. Derived state: restored from the
// published index generation on open (stage 5) or rebuilt from the store as
// the fallback.

import { SkipList, cmpNumber, cmpString } from './skiplist.js';
import type { RangeEntry } from './skiplist.js';
import type { DtImageColumn } from './gen-codec.js';

interface DtColumn {
  list: SkipList<number, string>;
  byKey: Map<string, number>;
}

export interface DtRangeEntry {
  key: string;
  value: number;
}

export class DtIndex {
  private cols = new Map<string, DtColumn>(); // col -> column
  private byKey = new Map<string, Record<string, number>>(); // key -> { col: ms }

  private col(name: string): DtColumn {
    let c = this.cols.get(name);
    if (!c) {
      c = { list: new SkipList<number, string>({ compareKey: cmpNumber, compareVal: cmpString }), byKey: new Map() };
      this.cols.set(name, c);
    }
    return c;
  }

  /** Set/replace the dt columns for a key. dt = { col: ms } or null. */
  set(key: string, dt: Record<string, number> | null): void {
    const old = this.byKey.get(key) ?? {};
    const next = dt ?? {};

    for (const col of Object.keys(old)) {
      if (!(col in next) || old[col] !== next[col]) {
        const c = this.cols.get(col);
        if (c) {
          c.list.delete(old[col]!, key);
          c.byKey.delete(key);
          if (c.byKey.size === 0) this.cols.delete(col);
        }
      }
    }
    for (const col of Object.keys(next)) {
      const ms = next[col]!;
      if (typeof ms !== 'number' || !Number.isFinite(ms)) continue;
      if (old[col] === ms) continue;
      const c = this.col(col);
      c.list.insert(ms, key);
      c.byKey.set(key, ms);
    }

    if (Object.keys(next).length) this.byKey.set(key, { ...next });
    else this.byKey.delete(key);
  }

  del(key: string): void {
    const old = this.byKey.get(key);
    if (!old) return;
    for (const col of Object.keys(old)) {
      const c = this.cols.get(col);
      if (c) {
        c.list.delete(old[col]!, key);
        c.byKey.delete(key);
        if (c.byKey.size === 0) this.cols.delete(col);
      }
    }
    this.byKey.delete(key);
  }

  /** Range over a dt column. */
  range(col: string, opts: Parameters<SkipList<number, string>['range']>[0] = {}): DtRangeEntry[] {
    const c = this.cols.get(col);
    if (!c) return [];
    return c.list.range(opts).map((n: RangeEntry<number, string>) => ({ key: n.val, value: n.key }));
  }

  /** Lazy range over a dt column; yields { key: recordKey, value: ts } like
   *  range() but lets the caller stop early without materializing everything. */
  *iterate(
    col: string,
    opts: Parameters<SkipList<number, string>['iterate']>[0] = {},
  ): Generator<DtRangeEntry> {
    const c = this.cols.get(col);
    if (!c) return;
    for (const n of c.list.iterate(opts)) yield { key: n.val, value: n.key };
  }

  columns(): string[] {
    return [...this.cols.keys()];
  }

  /** Rebuild from an iterator of { key, dt }. */
  rebuild(entries: Iterable<{ key: string; dt: Record<string, number> | null | undefined }>): void {
    const b = this.beginRebuild();
    for (const { key, dt } of entries) b.add(key, dt);
    b.commit();
  }

  /** Stage-5 generation: export the whole index as columns with entries in
   *  ascending (ms, key) order — the image serialization order. */
  exportImage(): DtImageColumn[] {
    return [...this.cols.entries()].map(([name, c]) => ({
      name,
      entries: c.list.toArray().map((n: RangeEntry<number, string>) => ({ ms: n.key, key: n.val })),
    }));
  }

  /** Replace the whole index from a loaded generation image: the columns are
   *  bulk-built (O(N)) and the byKey reverse map is derived from them. */
  loadImage(cols: DtImageColumn[]): void {
    const nextCols = new Map<string, DtColumn>();
    const nextByKey = new Map<string, Record<string, number>>();
    for (const { name, entries } of cols) {
      const list = SkipList.bulkLoad<number, string>(
        entries.map((e) => ({ key: e.ms, val: e.key })),
        { compareKey: cmpNumber, compareVal: cmpString },
      );
      const byKey = new Map<string, number>();
      for (const e of entries) {
        byKey.set(e.key, e.ms);
        const rec = nextByKey.get(e.key) ?? {};
        rec[name] = e.ms;
        nextByKey.set(e.key, rec);
      }
      nextCols.set(name, { list, byKey });
    }
    this.cols = nextCols;
    this.byKey = nextByKey;
  }

  /** Stage a rebuild in fresh state and swap it in on commit(), so a rebuild
   *  that fails midway leaves the previous index fully intact. Rebuild keys
   *  are unique (one store record each), so add() is a pure insert — the
   *  diff-based set() logic is not needed here. */
  beginRebuild(): { add(key: string, dt: Record<string, number> | null | undefined): void; commit(): void } {
    const cols = new Map<string, DtColumn>();
    const byKey = new Map<string, Record<string, number>>();
    return {
      add: (key, dt) => {
        if (!dt) return;
        const rec: Record<string, number> = {};
        for (const [name, ms] of Object.entries(dt)) {
          if (typeof ms !== 'number' || !Number.isFinite(ms)) continue;
          let c = cols.get(name);
          if (!c) {
            c = { list: new SkipList<number, string>({ compareKey: cmpNumber, compareVal: cmpString }), byKey: new Map() };
            cols.set(name, c);
          }
          c.list.insert(ms, key);
          c.byKey.set(key, ms);
          rec[name] = ms;
        }
        if (Object.keys(rec).length) byKey.set(key, rec);
      },
      commit: () => {
        this.cols = cols;
        this.byKey = byKey;
      },
    };
  }
}
