// src/query-engine.ts
//
// MiniDb's unified query engine as a facet: index-assisted candidate
// collection, the dt-ordered fast path, and the sync/async query pipelines.
// The engine is read-only — everything it needs from MiniDb (store, the dt /
// secondary / text indexes, value decode + async read, lifecycle gate, stats
// sink) is injected through QueryEngineDeps, so this module never imports the
// MiniDb class itself.

import { getPath, match, project } from './query.js';
import { canonRange, fromKStr, toKStr } from './value-codec.js';
import type { Store } from './store.js';
import type { IndexManager } from './index-manager.js';
import type { DtIndex } from './dt-index.js';
import type { TextIndex } from './text-index/index.js';
import type { RangeOptions } from './skiplist.js';
import type { QueryOptions, ScanEntry, ValueCodecName } from './types.js';

/** The owner-injected surface the query engine needs (see the header). The
 *  index managers and the text map are stable references owned by MiniDb;
 *  store/codecName are read lazily through getters. */
export interface QueryEngineDeps<V> {
  store: () => Store;
  indexes: IndexManager;
  dt: DtIndex;
  text: Map<string, TextIndex>;
  codecName: () => ValueCodecName;
  /** The owner's stats object (query work counters). */
  stats: {
    queryIndexHits: number;
    queryCandidates: number;
    queryDecoded: number;
    querySortedRows: number;
  };
  decode: (b: Buffer | undefined) => V | undefined;
  readValueAsync: (kstr: string) => Promise<Buffer | undefined>;
  ensureOpen: () => void;
}

/** Lazy one-shot candidate filter — keeps query pipelines streaming so a
 *  bounded query stops after `skip + limit` matches instead of materializing
 *  every candidate. */
function* filterKeys(keys: Iterable<string>, pred: (k: string) => boolean): Generator<string> {
  for (const k of keys) if (pred(k)) yield k;
}

export class QueryEngine<V> {
  constructor(private readonly deps: QueryEngineDeps<V>) {}

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
    const indexes = this.deps.indexes;
    if (this.deps.codecName() !== 'json' || !indexes.indexes.size) return null;
    const fieldIndexes = indexes.list().filter((i) => i.field === field);
    if (!fieldIndexes.length) return null;

    const isOpObj = cond !== null && typeof cond === 'object' && !(cond instanceof RegExp);
    const ops = isOpObj ? (cond as Record<string, unknown>) : null;

    const eqIndex = fieldIndexes.find((i) => i.type === 'equality');
    if (eqIndex) {
      if (!isOpObj) return new Set(indexes.findEq(eqIndex.name, cond));
      if (ops && Object.keys(ops).length === 1 && '$eq' in ops) {
        return new Set(indexes.findEq(eqIndex.name, ops['$eq']));
      }
      if (ops && Array.isArray(ops['$in'])) {
        const set = new Set<string>();
        for (const v of ops['$in']) for (const pk of indexes.findEq(eqIndex.name, v)) set.add(pk);
        return set;
      }
    }

    const rangeIndex = fieldIndexes.find((i) => i.type === 'range');
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
        return new Set(indexes.findRange(rangeIndex.name, opts).map((r) => r.pk));
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
    this.deps.stats.queryIndexHits++;
    return [...candidates];
  }

  // Extract simple equality predicates (top-level or inside $and) that are
  // backed by an equality index, for use as a cheap per-candidate pre-filter.
  // Only direct equality and {$eq: x} qualify; $in / range / non-indexed fields
  // are left to the full match() after decode.
  private cheapEqChecks(filter?: Record<string, unknown>): { name: string; value: unknown }[] {
    const out: { name: string; value: unknown }[] = [];
    const indexes = this.deps.indexes;
    if (!filter || typeof filter !== 'object' || !indexes.indexes.size) return out;
    for (const { field, cond } of this.indexPredicates(filter)) {
      const idx = indexes.list().find((i) => i.field === field && i.type === 'equality');
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
    // A dt condition carrying its own offset/count has slice semantics this
    // fast path cannot reproduce exactly (it honors range bounds only) — the
    // general path handles it.
    if (cond.offset !== undefined || cond.count !== undefined) return null;

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
    const iterOpts: RangeOptions<number> = { reverse };
    if (cond.gte !== undefined) iterOpts.gte = cond.gte;
    if (cond.gt !== undefined) iterOpts.gt = cond.gt;
    if (cond.lte !== undefined) iterOpts.lte = cond.lte;
    if (cond.lt !== undefined) iterOpts.lt = cond.lt;

    // Cheap key-level pre-filter (no decode, no full-set materialization) for
    // simple equality predicates that have an equality index.
    const eqChecks = this.cheapEqChecks(q.filter);

    const stats = this.deps.stats;
    const out: { key: string; value: V; dt: Record<string, number> | undefined }[] = [];
    let skipped = 0;
    for (const { key: kstr } of this.deps.dt.iterate(col, iterOpts)) {
      stats.queryCandidates++;
      let rejected = false;
      for (const c of eqChecks) {
        if (!this.deps.indexes.hasEq(c.name, c.value, kstr)) {
          rejected = true;
          break;
        }
      }
      if (rejected) continue;
      const buf = this.deps.store().get(kstr);
      if (buf === undefined) continue;
      const r = this.deps.store().map.get(kstr);
      stats.queryDecoded++;
      const value = this.deps.decode(buf)!;
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

  query(q: QueryOptions = {}): ScanEntry<V>[] {
    this.deps.ensureOpen();
    const fast = this.tryDtOrderedLimit(q);
    if (fast !== null) return fast;

    // Candidate collection never decodes values and stays lazy (a one-shot
    // iterable) wherever possible: key scans walk the ordered index directly,
    // and intersections filter as they go. A bounded query below then decodes
    // only the rows it returns instead of materializing the whole candidate
    // set first.
    let keys: Iterable<string> | null = null;
    if (typeof q.key === 'string') {
      keys = [toKStr(q.key)];
    } else if (q.key && typeof q.key === 'object') {
      if ((q.key as { prefix?: string }).prefix) {
        const p = toKStr((q.key as { prefix: string }).prefix);
        keys = this.deps.store().rawKeys({ gte: p, lt: p + '￿' });
      } else {
        const opts: RangeOptions<string> = {};
        for (const b of ['gte', 'gt', 'lte', 'lt'] as const)
          if ((q.key as Record<string, unknown>)[b] !== undefined) opts[b] = (q.key as Record<string, unknown>)[b] as string;
        keys = this.deps.store().rawKeys(canonRange(opts));
      }
    }

    if (q.dt) {
      for (const [col, cond] of Object.entries(q.dt)) {
        const set = new Set(this.deps.dt.range(col, cond).map((r) => r.key));
        keys = keys === null ? set : filterKeys(keys, (k) => set.has(k));
      }
    }

    let textOrder: { key: string; score: number }[] | null = null;
    if (q.text) {
      const ti = this.deps.text.get(q.text.index);
      if (!ti) throw new Error(`no such text index: ${q.text.index}`);
      const hits = ti.search(q.text.q, { op: q.text.op, limit: q.text.limit ?? 1_000_000 });
      textOrder = hits;
      const set = new Set(hits.map((h) => h.key));
      keys = keys === null ? hits.map((h) => h.key) : filterKeys(keys, (k) => set.has(k));
    }

    const indexed = this.indexedCandidateKeys(q.filter);
    if (indexed) {
      const set = new Set(indexed);
      keys = keys === null ? indexed : filterKeys(keys, (k) => set.has(k));
    }

    if (keys === null) keys = this.deps.store().rawKeys({});

    const stats = this.deps.stats;
    const skip = q.skip ?? 0;
    const limit = q.limit === undefined ? Infinity : q.limit;
    // Without an explicit sort or text ranking, result order is the candidate
    // iteration order, so skip/limit can be applied while iterating: a bounded
    // query decodes only the rows it returns instead of the whole candidate
    // set (an indexed equality query with limit previously decoded every
    // candidate and sliced at the end).
    const early = !q.sort && !textOrder;
    const docs: ScanEntry<V>[] = [];
    let seen = 0;
    for (const k of keys) {
      stats.queryCandidates++;
      const buf = this.deps.store().get(k);
      if (buf === undefined) continue;
      const r = this.deps.store().map.get(k);
      stats.queryDecoded++;
      const value = this.deps.decode(buf)!;
      if (q.filter && !match(value, q.filter)) continue;
      if (early) {
        if (seen++ < skip) continue;
        docs.push({ key: k, value, dt: r?.dt ?? undefined });
        if (docs.length >= limit) break;
      } else {
        docs.push({ key: k, value, dt: r?.dt ?? undefined });
      }
    }

    if (textOrder && !q.sort) {
      stats.querySortedRows += docs.length;
      const rank = new Map(textOrder.map((h, i) => [h.key, i]));
      docs.sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
    }

    if (q.sort) {
      stats.querySortedRows += docs.length;
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

    const sliced = early ? docs : skip || limit !== Infinity ? docs.slice(skip, skip + limit) : docs;

    if (q.project) {
      return sliced.map((d) => ({ key: fromKStr(d.key), value: project(d.value, q.project) as V, dt: d.dt }));
    }
    return sliced.map((d) => ({ ...d, key: fromKStr(d.key) }));
  }

  /** Async twin of query() (stage 6, additive): identical results and
   *  ordering; the disk-mode value reads (and the text branch's postings
   *  reads) run off the event loop. The candidate-collection logic mirrors
   *  query() exactly — keep both in sync when the query planner changes. */
  async queryAsync(q: QueryOptions = {}): Promise<ScanEntry<V>[]> {
    this.deps.ensureOpen();
    const fast = await this.tryDtOrderedLimitAsync(q);
    if (fast !== null) return fast;

    let keys: Iterable<string> | null = null;
    if (typeof q.key === 'string') {
      keys = [toKStr(q.key)];
    } else if (q.key && typeof q.key === 'object') {
      if ((q.key as { prefix?: string }).prefix) {
        const p = toKStr((q.key as { prefix: string }).prefix);
        keys = this.deps.store().rawKeys({ gte: p, lt: p + '￿' });
      } else {
        const opts: RangeOptions<string> = {};
        for (const b of ['gte', 'gt', 'lte', 'lt'] as const)
          if ((q.key as Record<string, unknown>)[b] !== undefined) opts[b] = (q.key as Record<string, unknown>)[b] as string;
        keys = this.deps.store().rawKeys(canonRange(opts));
      }
    }

    if (q.dt) {
      for (const [col, cond] of Object.entries(q.dt)) {
        const set = new Set(this.deps.dt.range(col, cond).map((r) => r.key));
        keys = keys === null ? set : filterKeys(keys, (k) => set.has(k));
      }
    }

    let textOrder: { key: string; score: number }[] | null = null;
    if (q.text) {
      const ti = this.deps.text.get(q.text.index);
      if (!ti) throw new Error(`no such text index: ${q.text.index}`);
      const hits = await ti.searchAsync(q.text.q, { op: q.text.op, limit: q.text.limit ?? 1_000_000 });
      textOrder = hits;
      const set = new Set(hits.map((h) => h.key));
      keys = keys === null ? hits.map((h) => h.key) : filterKeys(keys, (k) => set.has(k));
    }

    const indexed = this.indexedCandidateKeys(q.filter);
    if (indexed) {
      const set = new Set(indexed);
      keys = keys === null ? indexed : filterKeys(keys, (k) => set.has(k));
    }

    if (keys === null) keys = this.deps.store().rawKeys({});

    const stats = this.deps.stats;
    const skip = q.skip ?? 0;
    const limit = q.limit === undefined ? Infinity : q.limit;
    const early = !q.sort && !textOrder;
    const docs: ScanEntry<V>[] = [];
    let seen = 0;
    for (const k of keys) {
      stats.queryCandidates++;
      const buf = await this.deps.readValueAsync(k);
      if (buf === undefined) continue;
      const r = this.deps.store().map.get(k);
      stats.queryDecoded++;
      const value = this.deps.decode(buf)!;
      if (q.filter && !match(value, q.filter)) continue;
      if (early) {
        if (seen++ < skip) continue;
        docs.push({ key: k, value, dt: r?.dt ?? undefined });
        if (docs.length >= limit) break;
      } else {
        docs.push({ key: k, value, dt: r?.dt ?? undefined });
      }
    }

    if (textOrder && !q.sort) {
      stats.querySortedRows += docs.length;
      const rank = new Map(textOrder.map((h, i) => [h.key, i]));
      docs.sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
    }

    if (q.sort) {
      stats.querySortedRows += docs.length;
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

    const sliced = early ? docs : skip || limit !== Infinity ? docs.slice(skip, skip + limit) : docs;

    if (q.project) {
      return sliced.map((d) => ({ key: fromKStr(d.key), value: project(d.value, q.project) as V, dt: d.dt }));
    }
    return sliced.map((d) => ({ ...d, key: fromKStr(d.key) }));
  }

  /** Async twin of the dt-ordered fast path (see tryDtOrderedLimit): the
   *  same eligibility rules and output, with async value reads. */
  private async tryDtOrderedLimitAsync(q: QueryOptions): Promise<ScanEntry<V>[] | null> {
    if (q.text) return null;
    if (q.key !== undefined) return null;
    if (q.limit === undefined) return null;
    if (!q.dt) return null;
    const dtCols = Object.keys(q.dt);
    if (dtCols.length !== 1) return null;
    const col = dtCols[0]!;
    const cond = q.dt[col]!;
    if (cond.offset !== undefined || cond.count !== undefined) return null;

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
    const iterOpts: RangeOptions<number> = { reverse };
    if (cond.gte !== undefined) iterOpts.gte = cond.gte;
    if (cond.gt !== undefined) iterOpts.gt = cond.gt;
    if (cond.lte !== undefined) iterOpts.lte = cond.lte;
    if (cond.lt !== undefined) iterOpts.lt = cond.lt;

    const eqChecks = this.cheapEqChecks(q.filter);

    const stats = this.deps.stats;
    const out: { key: string; value: V; dt: Record<string, number> | undefined }[] = [];
    let skipped = 0;
    for (const { key: kstr } of this.deps.dt.iterate(col, iterOpts)) {
      stats.queryCandidates++;
      let rejected = false;
      for (const c of eqChecks) {
        if (!this.deps.indexes.hasEq(c.name, c.value, kstr)) {
          rejected = true;
          break;
        }
      }
      if (rejected) continue;
      const buf = await this.deps.readValueAsync(kstr);
      if (buf === undefined) continue;
      const r = this.deps.store().map.get(kstr);
      stats.queryDecoded++;
      const value = this.deps.decode(buf)!;
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
}
