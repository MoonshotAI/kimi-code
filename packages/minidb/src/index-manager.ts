// src/index-manager.ts
//
// Secondary indexes over JSON documents. Indexes are pure in-memory derived
// state (the WAL/store is the source of truth); they are rebuilt from the store
// on startup.

import { SkipList, cmpNumber, cmpString } from './skiplist.js';
import type { RangeOptions } from './skiplist.js';

export type IndexType = 'equality' | 'range';

export interface IndexDef {
  field: string;
  type?: IndexType;
  unique?: boolean;
  sparse?: boolean;
}

export interface IndexInfo {
  name: string;
  field: string;
  type: IndexType;
  unique: boolean;
  sparse: boolean;
}

interface EqIndex {
  name: string;
  field: string;
  type: 'equality';
  unique: boolean;
  sparse: boolean;
  map: Map<string, Set<string>>;
  byPk: Map<string, string[]>;
}

interface RangeIndex {
  name: string;
  field: string;
  type: 'range';
  unique: boolean;
  sparse: boolean;
  list: SkipList<number, string>;
  byPk: Map<string, number[]>; // array fields index every element
}

type AnyIndex = EqIndex | RangeIndex;

export class UniqueViolationError extends Error {
  constructor(index: string, value: unknown) {
    super(`unique index "${index}" violation on value ${JSON.stringify(value)}`);
    this.name = 'UniqueViolationError';
  }
}

function getField(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o === null || o === undefined ? undefined : (o as Record<string, unknown>)[k]), doc);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

function scalarKey(v: unknown): string {
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return `${t}:${String(v)}`;
  // Canonicalize property order so {a:1,b:2} and {b:2,a:1} hash to the same
  // key; JSON.stringify alone preserves insertion order and would split them.
  return `json:${stableStringify(v)}`;
}

function flatten(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

export class IndexManager {
  readonly indexes = new Map<string, AnyIndex>();

  create(name: string, { field, type = 'equality', unique = false, sparse = true }: IndexDef = {} as IndexDef): AnyIndex {
    if (!field) throw new TypeError('index requires a field');
    if (this.indexes.has(name)) throw new Error(`index "${name}" already exists`);
    const idx: AnyIndex =
      type === 'range'
        ? {
            name,
            field,
            type,
            unique,
            sparse,
            list: new SkipList<number, string>({ compareKey: cmpNumber, compareVal: cmpString }),
            byPk: new Map(),
          }
        : { name, field, type, unique, sparse, map: new Map(), byPk: new Map() };
    this.indexes.set(name, idx);
    return idx;
  }

  drop(name: string): boolean {
    return this.indexes.delete(name);
  }

  get(name: string): AnyIndex {
    const idx = this.indexes.get(name);
    if (!idx) throw new Error(`no such index: ${name}`);
    return idx;
  }

  list(): IndexInfo[] {
    return [...this.indexes.values()].map(({ name, field, type, unique, sparse }) => ({
      name,
      field,
      type,
      unique,
      sparse,
    }));
  }

  /** Throw a UniqueViolationError if adding `doc` for `pk` would violate a unique index. */
  checkUnique(pk: string, doc: unknown): void {
    for (const idx of this.indexes.values()) {
      if (!idx.unique) continue;
      const value = getField(doc, idx.field);
      if (value === undefined && idx.sparse) continue;
      for (const v of flatten(value)) {
        if (idx.type === 'range') {
          if (typeof v !== 'number' || !Number.isFinite(v)) continue;
          const hit = idx.list.range({ gte: v, lte: v, count: 1 });
          if (hit.length && hit[0]!.val !== pk) throw new UniqueViolationError(idx.name, v);
        } else {
          const set = idx.map.get(scalarKey(v));
          if (set && (set.size > 1 || (set.size === 1 && !set.has(pk)))) {
            throw new UniqueViolationError(idx.name, v);
          }
        }
      }
    }
  }

  /**
   * Validate unique constraints for a batch of ops by computing the index state
   * AFTER the whole batch and checking it for collisions. The check is
   * order-independent, so valid transformations like swapping a unique value
   * between two keys, or deleting one key and reusing its value in another,
   * are accepted (their final state is still unique).
   *
   * `ops` is the full op list (set AND del); the last op per key wins.
   */
  checkUniqueBatch(ops: readonly { pk: string; op: 'set' | 'del'; doc: unknown }[]): void {
    const lastOp = new Map<string, { op: 'set' | 'del'; doc: unknown }>();
    for (const o of ops) lastOp.set(o.pk, o);
    const touched = new Set(lastOp.keys());

    for (const idx of this.indexes.values()) {
      if (!idx.unique) continue;
      if (idx.type === 'range') {
        const owner = new Map<number, string>();
        for (const [pk, vals] of idx.byPk) {
          if (touched.has(pk)) continue;
          for (const v of vals) owner.set(v, pk);
        }
        for (const [pk, o] of lastOp) {
          if (o.op === 'del') continue;
          for (const v of flatten(getField(o.doc, idx.field))) {
            if (typeof v !== 'number' || !Number.isFinite(v)) continue;
            const prev = owner.get(v);
            if (prev !== undefined && prev !== pk) throw new UniqueViolationError(idx.name, v);
            owner.set(v, pk);
          }
        }
      } else {
        const owner = new Map<string, string>();
        for (const [sk, set] of idx.map) {
          for (const pk of set) if (!touched.has(pk)) owner.set(sk, pk);
        }
        for (const [pk, o] of lastOp) {
          if (o.op === 'del') continue;
          const value = getField(o.doc, idx.field);
          if (value === undefined && idx.sparse) continue;
          for (const v of flatten(value)) {
            const sk = scalarKey(v);
            const prev = owner.get(sk);
            if (prev !== undefined && prev !== pk) throw new UniqueViolationError(idx.name, v);
            owner.set(sk, pk);
          }
        }
      }
    }
  }

  /**
   * Verify that an already-built unique index contains no duplicate values.
   * Used when creating a unique index over pre-existing data: if the data
   * already violates the constraint, the index must not be created.
   */
  assertUniqueValid(name: string): void {
    const idx = this.get(name);
    if (!idx.unique) return;
    if (idx.type === 'range') {
      const owner = new Map<number, string>();
      for (const [pk, vals] of idx.byPk) {
        for (const v of vals) {
          const prev = owner.get(v);
          if (prev !== undefined && prev !== pk) throw new UniqueViolationError(idx.name, v);
          owner.set(v, pk);
        }
      }
    } else {
      for (const [, set] of idx.map) {
        if (set.size > 1) {
          const sample = [...set][0];
          throw new UniqueViolationError(idx.name, `${set.size} keys (e.g. ${sample})`);
        }
      }
    }
  }

  add(pk: string, doc: unknown): void {
    for (const idx of this.indexes.values()) {
      const value = getField(doc, idx.field);
      if (value === undefined && idx.sparse) continue;
      if (idx.type === 'range') {
        // Index each distinct numeric element once. Without the de-dupe, an
        // array like [10, 10, 10] would insert three (10, pk) nodes and the
        // same key would be reported three times by findRange.
        const vals = [...new Set(flatten(value).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)))];
        if (vals.length === 0) continue;
        for (const v of vals) idx.list.insert(v, pk);
        idx.byPk.set(pk, vals);
      } else {
        const keys: string[] = [];
        for (const v of flatten(value)) {
          const sk = scalarKey(v);
          let set = idx.map.get(sk);
          if (!set) idx.map.set(sk, (set = new Set()));
          set.add(pk);
          keys.push(sk);
        }
        idx.byPk.set(pk, keys);
      }
    }
  }

  remove(pk: string, _doc: unknown): void {
    for (const idx of this.indexes.values()) {
      if (idx.type === 'range') {
        const old = idx.byPk.get(pk);
        if (old) {
          for (const v of old) idx.list.delete(v, pk);
          idx.byPk.delete(pk);
        }
      } else {
        const keys = idx.byPk.get(pk);
        if (keys) {
          for (const sk of keys) {
            const set = idx.map.get(sk);
            if (set) {
              set.delete(pk);
              if (set.size === 0) idx.map.delete(sk);
            }
          }
          idx.byPk.delete(pk);
        }
      }
    }
  }

  findEq(name: string, value: unknown): string[] {
    const idx = this.get(name);
    if (idx.type !== 'equality') throw new Error(`index "${name}" is not an equality index`);
    const set = idx.map.get(scalarKey(value));
    return set ? [...set] : [];
  }

  /** O(1) membership test: is `pk` indexed under `value` on this equality
   *  index? Avoids materializing the full posting list like findEq does. */
  hasEq(name: string, value: unknown, pk: string): boolean {
    const idx = this.get(name);
    if (idx.type !== 'equality') throw new Error(`index "${name}" is not an equality index`);
    const set = idx.map.get(scalarKey(value));
    return !!set && set.has(pk);
  }

  findRange(
    name: string,
    opts: { min?: number; max?: number; minExclusive?: boolean; maxExclusive?: boolean; offset?: number; count?: number; reverse?: boolean } = {},
  ): { pk: string; value: number }[] {
    const idx = this.get(name);
    if (idx.type !== 'range') throw new Error(`index "${name}" is not a range index`);
    const r: RangeOptions<number> = {};
    if (opts.min !== undefined) {
      if (opts.minExclusive) r.gt = opts.min;
      else r.gte = opts.min;
    }
    if (opts.max !== undefined) {
      if (opts.maxExclusive) r.lt = opts.max;
      else r.lte = opts.max;
    }
    if (opts.offset) r.offset = opts.offset;
    if (opts.count !== undefined) r.count = opts.count;
    if (opts.reverse) r.reverse = true;
    return idx.list.range(r).map((n) => ({ pk: n.val, value: n.key }));
  }

  /** Rebuild all indexes from an iterator of { key, value } (value = decoded doc). */
  rebuild(entries: Iterable<{ key: string | Buffer; value: unknown }>): void {
    for (const idx of this.indexes.values()) {
      if (idx.type === 'range') {
        idx.list = new SkipList<number, string>({ compareKey: cmpNumber, compareVal: cmpString });
        idx.byPk.clear();
      } else {
        idx.map.clear();
        idx.byPk.clear();
      }
    }
    for (const { key, value } of entries) {
      const pk = typeof key === 'string' ? key : Buffer.from(key).toString('binary');
      if (value && typeof value === 'object') this.add(pk, value);
    }
  }
}
