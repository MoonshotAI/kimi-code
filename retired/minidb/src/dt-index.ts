// src/dt-index.ts
//
// Ordered indexes over declared datetime columns (dt1..dtN). Each column is a
// SkipList ordered by epoch-ms (numeric) with the record key as tie-break, giving
// O(log N) range / rank on every dt column. Pure in-memory derived state; rebuilt
// from the store on startup.

import { SkipList, cmpNumber, cmpString } from './skiplist.js';
import type { RangeEntry } from './skiplist.js';

interface DtColumn {
  list: SkipList<number, string>;
  byKey: Map<string, number>;
}

export interface DtRangeEntry {
  key: string;
  value: number;
}

export class DtIndex {
  private readonly cols = new Map<string, DtColumn>(); // col -> column
  private readonly byKey = new Map<string, Record<string, number>>(); // key -> { col: ms }

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
    this.cols.clear();
    this.byKey.clear();
    for (const { key, dt } of entries) {
      if (dt) this.set(key, dt);
    }
  }
}
