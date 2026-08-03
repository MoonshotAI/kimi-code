// src/index-manager.ts
//
// Secondary indexes over JSON documents. Indexes are derived state (the
// WAL/store is the source of truth): on open they are restored from the
// published index generation (stage 5) or, as the fallback, rebuilt from the
// store wholesale; individual indexes are rebuilt on definition changes.

import { SkipList, cmpNumber, cmpString } from './skiplist.js';
import type { RangeOptions } from './skiplist.js';
import type { SecondaryImageIndex } from './gen-codec.js';

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

/** A live-index holder of a batch-claimed value must be the claimant itself
 *  or a key the batch vacates (deletes, or overwrites with a doc that no
 *  longer carries the value); anything else is a final-state conflict. The
 *  "touched and still claims it" sub-case never reaches a verdict here: it is
 *  detected by the batch-local claim map when the holder's own final claims
 *  are checked, so a 'set' final op is always treated as vacated at this
 *  point. */
function assertVacated(
  idx: AnyIndex,
  holder: string,
  claimant: string,
  value: unknown,
  lastOp: ReadonlyMap<string, { op: 'set' | 'del'; doc: unknown }>,
): void {
  if (holder === claimant) return;
  const fin = lastOp.get(holder);
  if (!fin) throw new UniqueViolationError(idx.name, value);
  // fin.op === 'del': vacated. fin.op === 'set': either it still claims the
  // value (the batch-local claim map throws on the holder's own entry) or it
  // moved away — vacated either way for this claimant.
}

/** Insert one doc into an index's given state (shared by the incremental
 *  write path and staged rebuilds). */
function insertDoc(idx: AnyIndex, pk: string, doc: unknown): void {
  const value = getField(doc, idx.field);
  if (value === undefined && idx.sparse) return;
  if (idx.type === 'range') {
    // Index each distinct numeric element once. Without the de-dupe, an
    // array like [10, 10, 10] would insert three (10, pk) nodes and the
    // same key would be reported three times by findRange.
    const vals = [...new Set(flatten(value).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)))];
    if (vals.length === 0) return;
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

/** Remove one key from an index's given state (the per-index body of
 *  IndexManager.remove). */
function removeFromIndex(idx: AnyIndex, pk: string): void {
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

/** Throw a UniqueViolationError if adding `doc` for `pk` would violate this
 *  one index (the per-index body of IndexManager.checkUnique). */
function checkUniqueOnIndex(idx: AnyIndex, pk: string, doc: unknown): void {
  if (!idx.unique) return;
  const value = getField(doc, idx.field);
  if (value === undefined && idx.sparse) return;
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

/** Validate one unique index for a batch of ops against the index state AFTER
 *  the whole batch (the per-index body of IndexManager.checkUniqueBatch;
 *  `lastOp` is the batch's last op per key). */
function checkUniqueBatchOnIndex(idx: AnyIndex, lastOp: ReadonlyMap<string, { op: 'set' | 'del'; doc: unknown }>): void {
  if (!idx.unique) return;
  // Batch-local claims: value -> claiming pk. Two different keys finally
  // claiming the same value is a conflict regardless of the live index.
  // This also covers the "holder is touched and still claims the value"
  // case: the holder's own final claims pass through this same map.
  const claimed = new Map<string | number, string>();
  for (const [pk, o] of lastOp) {
    if (o.op === 'del') continue;
    const value = getField(o.doc, idx.field);
    if (value === undefined && idx.sparse) continue;
    for (const v of flatten(value)) {
      if (idx.type === 'range') {
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const prev = claimed.get(v);
        if (prev !== undefined && prev !== pk) throw new UniqueViolationError(idx.name, v);
        claimed.set(v, pk);
        // Current holder in the live index, if any: a conflict unless it
        // is the claimant itself or a key the batch vacates.
        const hit = idx.list.range({ gte: v, lte: v, count: 1 });
        if (hit.length) assertVacated(idx, hit[0]!.val, pk, v, lastOp);
      } else {
        const sk = scalarKey(v);
        const prev = claimed.get(sk);
        if (prev !== undefined && prev !== pk) throw new UniqueViolationError(idx.name, v);
        claimed.set(sk, pk);
        const set = idx.map.get(sk);
        if (set) for (const h of set) assertVacated(idx, h, pk, v, lastOp);
      }
    }
  }
}

export class IndexManager {
  readonly indexes = new Map<string, AnyIndex>();
  /** Definitions of in-flight createIndex transactions (plan 10's staged →
   *  persist → publish): an index under construction lives ONLY here until
   *  the definition sidecar is durably persisted and publish() moves it into
   *  the live map. It is invisible to every QUERY path (get/list/find*), but
   *  the write-maintenance paths (add/remove/checkUnique) feed it exactly like
   *  a live index: the staged rebuild covered the store as of stage time and
   *  every later write transitions it, so publish() is a bare map move and a
   *  staged unique index already constrains writes during its persist window.
   *  A failed create discards the staged entry, so the live registry never
   *  carries a phantom. */
  private readonly staged = new Map<string, AnyIndex>();

  /** Live + staged count. The write paths guard their secondary-index
   *  maintenance with this (a staged index must be fed exactly like a live
   *  one); query paths keep using `indexes` directly. */
  get size(): number {
    return this.indexes.size + this.staged.size;
  }

  /** Any unique index, live or staged. While a unique create is in its
   *  persist window the staged index is fully built and must already
   *  constrain/check writes (and route them through the unique-write
   *  serializer), or a concurrent write could violate the constraint the
   *  publish is about to enforce. */
  hasUnique(): boolean {
    for (const idx of this.indexes.values()) if (idx.unique) return true;
    for (const idx of this.staged.values()) if (idx.unique) return true;
    return false;
  }

  /** Validate the definition and construct the (empty) index state. */
  private static build(name: string, { field, type = 'equality', unique = false, sparse = true }: IndexDef): AnyIndex {
    if (!field) throw new TypeError('index requires a field');
    return type === 'range'
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
  }

  create(name: string, def: IndexDef = {} as IndexDef): AnyIndex {
    // Build first: the field validation precedes the name collision check,
    // exactly as it did before the constructor was factored out.
    const idx = IndexManager.build(name, def);
    if (this.indexes.has(name)) throw new Error(`index "${name}" already exists`);
    this.indexes.set(name, idx);
    return idx;
  }

  /** Stage a new index definition off to the side (see `staged`). The field
   *  validation runs before the name collision check, matching create()'s
   *  error precedence. */
  stage(name: string, def: IndexDef): void {
    const idx = IndexManager.build(name, def);
    if (this.indexes.has(name) || this.staged.has(name)) throw new Error(`index "${name}" already exists`);
    this.staged.set(name, idx);
  }

  /** Rebuild ONE staged index from an iterator of { key, value } (value =
   *  decoded doc). Unlike rebuild() this touches nothing live: a failure
   *  midway leaves every published index fully intact. */
  rebuildStaged(name: string, entries: Iterable<{ key: string | Buffer; value: unknown }>): void {
    const idx = this.staged.get(name);
    if (!idx) throw new Error(`no staged index: ${name}`);
    for (const { key, value } of entries) {
      if (!value || typeof value !== 'object') continue;
      const pk = typeof key === 'string' ? key : Buffer.from(key).toString('binary');
      insertDoc(idx, pk, value);
    }
  }

  /** The staged definition in its persisted (IndexInfo) shape — the content a
   *  create transaction adds to the sidecar BEFORE publishing. */
  stagedInfo(name: string): IndexInfo {
    const idx = this.staged.get(name);
    if (!idx) throw new Error(`no staged index: ${name}`);
    const { name: n, field, type, unique, sparse } = idx;
    return { name: n, field, type, unique, sparse };
  }

  /** Move a staged index into the live registry. Pure in-memory switch — the
   *  sidecar persist already succeeded when this runs. */
  publish(name: string): void {
    const idx = this.staged.get(name);
    if (!idx) throw new Error(`no staged index: ${name}`);
    this.staged.delete(name);
    this.indexes.set(name, idx);
  }

  /** Drop a staged index without publishing it (the create failed). */
  discardStaged(name: string): void {
    this.staged.delete(name);
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

  /** Throw a UniqueViolationError if adding `doc` for `pk` would violate a unique index.
   *  `doc` must be the CANONICAL (persisted-view) value — what the json codec
   *  actually stored — so the constraint view always matches what a reopen
   *  rebuilds (stage 11). */
  checkUnique(pk: string, doc: unknown): void {
    for (const idx of this.indexes.values()) checkUniqueOnIndex(idx, pk, doc);
    // A staged unique index already constrains writes (see `staged`).
    for (const idx of this.staged.values()) checkUniqueOnIndex(idx, pk, doc);
  }

  /**
   * Validate unique constraints for a batch of ops against the index state
   * AFTER the whole batch. The check is order-independent, so valid
   * transformations like swapping a unique value between two keys, or deleting
   * one key and reusing its value in another, are accepted (their final state
   * is still unique).
   *
   * `ops` is the full op list (set AND del); the last op per key wins. Every
   * `doc` must be the CANONICAL (persisted-view) value, the same contract as
   * checkUnique (stage 11).
   *
   * Incremental: for every value claimed by the batch it probes only that
   * value's current posting (O(1) equality / O(log N) range per value) and a
   * batch-local claim map — it never copies the full per-index owner state,
   * so a small batch stays cheap on a large index.
   */
  checkUniqueBatch(ops: readonly { pk: string; op: 'set' | 'del'; doc: unknown }[]): void {
    const lastOp = new Map<string, { op: 'set' | 'del'; doc: unknown }>();
    for (const o of ops) lastOp.set(o.pk, o);

    for (const idx of this.indexes.values()) checkUniqueBatchOnIndex(idx, lastOp);
    // A staged unique index already constrains writes (see `staged`).
    for (const idx of this.staged.values()) checkUniqueBatchOnIndex(idx, lastOp);
  }

  /**
   * Verify that an already-built unique index contains no duplicate values.
   * Used when creating a unique index over pre-existing data: if the data
   * already violates the constraint, the index must not be created. A
   * createIndex transaction validates its STAGED index (not yet reachable via
   * get()), so the staged map is consulted first.
   */
  assertUniqueValid(name: string): void {
    const idx = this.staged.get(name) ?? this.get(name);
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
    for (const idx of this.indexes.values()) insertDoc(idx, pk, doc);
    // A staged index is kept exactly as current as the live ones (see `staged`).
    for (const idx of this.staged.values()) insertDoc(idx, pk, doc);
  }

  remove(pk: string, _doc: unknown): void {
    for (const idx of this.indexes.values()) removeFromIndex(idx, pk);
    for (const idx of this.staged.values()) removeFromIndex(idx, pk);
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
    const b = this.beginRebuild();
    for (const { key, value } of entries) {
      const pk = typeof key === 'string' ? key : Buffer.from(key).toString('binary');
      b.add(pk, value);
    }
    b.commit();
  }

  /** Stage a rebuild in fresh per-index state and swap it in on commit(), so
   *  a rebuild that fails midway leaves the previous indexes fully intact. */
  beginRebuild(): { add(pk: string, doc: unknown): void; commit(): void } {
    const staged: { idx: AnyIndex; next: AnyIndex }[] = [];
    for (const idx of this.indexes.values()) {
      const next: AnyIndex =
        idx.type === 'range'
          ? { ...idx, list: new SkipList<number, string>({ compareKey: cmpNumber, compareVal: cmpString }), byPk: new Map() }
          : { ...idx, map: new Map(), byPk: new Map() };
      staged.push({ idx, next });
    }
    return {
      add: (pk, doc) => {
        if (!doc || typeof doc !== 'object') return;
        for (const { next } of staged) insertDoc(next, pk, doc);
      },
      commit: () => {
        for (const { idx, next } of staged) {
          if (idx.type === 'range' && next.type === 'range') idx.list = next.list;
          else if (idx.type === 'equality' && next.type === 'equality') idx.map = next.map;
          idx.byPk = next.byPk;
        }
      },
    };
  }

  /** Stage-5 generation: export every LIVE index's full state (equality maps
   *  and range lists in ascending order) for image serialization. */
  exportImage(): SecondaryImageIndex[] {
    const out: SecondaryImageIndex[] = [];
    for (const idx of this.indexes.values()) {
      if (idx.type === 'range') {
        out.push({
          name: idx.name,
          field: idx.field,
          type: 'range',
          unique: idx.unique,
          sparse: idx.sparse,
          equality: null,
          range: idx.list.toArray().map((n) => ({ value: n.key, pk: n.val })),
        });
      } else {
        out.push({
          name: idx.name,
          field: idx.field,
          type: 'equality',
          unique: idx.unique,
          sparse: idx.sparse,
          equality: [...idx.map.entries()].map(([scalarKey, set]) => ({ scalarKey, pks: [...set] })),
          range: null,
        });
      }
    }
    return out;
  }

  /** Replace ONE live index's state from a loaded generation image (the
   *  caller already matched the definition hash). Range lists are bulk-built
   *  in O(N); byPk reverse maps are derived from the forward state. */
  loadImage(image: SecondaryImageIndex): void {
    const idx = this.indexes.get(image.name);
    if (!idx) throw new Error(`no such index: ${image.name}`);
    if (idx.type !== image.type) throw new Error(`index "${image.name}" image type mismatch`);
    if (idx.type === 'range' && image.range) {
      idx.list = SkipList.bulkLoad<number, string>(
        image.range.map((e) => ({ key: e.value, val: e.pk })),
        { compareKey: cmpNumber, compareVal: cmpString },
      );
      const byPk = new Map<string, number[]>();
      for (const e of image.range) {
        const arr = byPk.get(e.pk);
        if (arr) arr.push(e.value);
        else byPk.set(e.pk, [e.value]);
      }
      idx.byPk = byPk;
    } else if (idx.type === 'equality' && image.equality) {
      const map = new Map<string, Set<string>>();
      const byPk = new Map<string, string[]>();
      for (const v of image.equality) {
        map.set(v.scalarKey, new Set(v.pks));
        for (const pk of v.pks) {
          const arr = byPk.get(pk);
          if (arr) arr.push(v.scalarKey);
          else byPk.set(pk, [v.scalarKey]);
        }
      }
      idx.map = map;
      idx.byPk = byPk;
    } else {
      throw new Error(`index "${image.name}" image payload missing`);
    }
  }
}
